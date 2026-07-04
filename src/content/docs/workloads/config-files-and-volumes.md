---
title: Config as Files (Volumes)
description: How ConfigMap and Secret volumes actually land on disk — atomic symlink swaps, items and modes, subPath traps, projected volumes, permissions, and debugging FailedMount.
sidebar:
  order: 12
---

Mounting config as files is the mechanism behind hot-reloadable settings, TLS material, nginx snippets, and every "just drop a YAML file in the container" request you'll ever get. It's also where the sneakiest config bugs live: files that silently never update, files your app can't read, and mounts that make the rest of a directory vanish. This article is the deep dive on the volume machinery itself. For the env-vs-volume overview see [Configuration](/workloads/configuration/); for making apps actually pick up changes, see [ConfigMap and Secret rotation](/operations/configmap-secret-rotation/).

:::tip[War story]
The subPath trap has a Field Note: [The subPath Mount That Never Updated](/blog/the-subpath-mount-that-never-updated/) — per-pod config skew that took days to notice.
:::

## The mechanics: `..data` and the atomic swap

Everything else in this article rests on one implementation detail. A ConfigMap or Secret volume is not a bunch of plain files — it's a tree of symlinks. Exec into any pod with a mounted ConfigMap and look:

```bash
kubectl exec -it payments-7d9f6b5c4-x2lqp -- ls -la /etc/payments
```

```console
total 12
drwxrwxrwt 3 root root  120 Jul  3 09:14 .
drwxr-xr-x 1 root root 4096 Jul  3 09:14 ..
drwxr-xr-x 2 root root   80 Jul  3 09:14 ..2026_07_03_09_14_02.1834529103
lrwxrwxrwx 1 root root   32 Jul  3 09:14 ..data -> ..2026_07_03_09_14_02.1834529103
lrwxrwxrwx 1 root root   23 Jul  3 09:14 application.yaml -> ..data/application.yaml
lrwxrwxrwx 1 root root   16 Jul  3 09:14 logging.conf -> ..data/logging.conf
```

The visible filenames are symlinks into `..data`, which is itself a symlink to a timestamped directory holding the real files. When the ConfigMap changes, the kubelet writes a *new* timestamped directory, then retargets the single `..data` symlink. A symlink swap is atomic at the filesystem level, so your app sees either the complete old config or the complete new config — never a half-written file, and never `application.yaml` from version A next to `logging.conf` from version B. Updates are all-or-nothing across every key in the volume.

Timing expectations: the kubelet syncs volumes on a periodic loop (default every ~1 minute) and consults a cache in front of the API (default up to another minute with the watch-based strategy, longer with TTL caches). Budget "up to about two minutes, cluster-dependent" for a change to reach disk. If you need faster or deterministic propagation, roll the pods — that's the rotation article's territory.

:::caution[Two things opt you out of updates entirely]
`immutable: true` on the ConfigMap/Secret (no updates, ever, by design) and `subPath` mounts (covered below). If files "never update," check those two first.
:::

## Full control of the volume spec

The default mount dumps every key as a file named after the key. You almost always want more control:

```yaml
volumes:
  - name: app-config
    configMap:
      name: payments-config
      optional: true            # pod starts even if the ConfigMap is missing (empty dir)
      defaultMode: 0444         # octal — see the gotcha below
      items:
        - key: application.yaml
          path: config/application.yaml   # nest into a subdirectory
        - key: logging.conf
          path: log4j2.properties         # rename on the way in
          mode: 0400                      # per-item override
```

Notes that bite people:

- **`items` is an allowlist.** Once you specify it, keys not listed don't appear. Listing a key that doesn't exist in the ConfigMap fails the mount (unless `optional: true`).
- **The octal gotcha.** YAML understands `0444`, but if you write `444` you get decimal 444 = `0674`, which is nonsense permissions. `kubectl get` shows modes in decimal (`defaultMode: 420` is `0644`, `256` is `0400`). Write octal literals with the leading zero, and don't panic when the API echoes decimal back.
- **These mounts are read-only. Always.** Since Kubernetes 1.9-ish, ConfigMap/Secret/downwardAPI/projected volumes are mounted read-only regardless of `readOnly:` in the mount spec. An app that tries to write gets `EROFS`: `open /etc/payments/application.yaml: read-only file system`. If your app insists on writing to its config dir (some do, for lock files or rewrites), copy the config into an `emptyDir` first — see the init-container pattern below.

## subPath: the trap disguised as a convenience

`subPath` mounts a single key as a single file, leaving the rest of the target directory intact:

```yaml
volumeMounts:
  - name: nginx-extra
    mountPath: /etc/nginx/conf.d/upstream.conf
    subPath: upstream.conf     # only this file; conf.d keeps its other contents
```

That's the legitimate use case: dropping one file into a directory the image already populates. But the costs are steep:

1. **subPath mounts NEVER receive updates.** The kubelet bind-mounts the resolved file at pod start; when `..data` swaps, your bind mount still points at the old timestamped directory. The ConfigMap can change a hundred times; that file is frozen until the pod is recreated.
2. **You lose atomicity** even at pod start — you've bypassed the symlink indirection entirely.
3. **The restart trap.** If the *container* restarts (crash, OOM, liveness kill) the kubelet re-resolves the subPath — so after a restart the file suddenly *is* the new version. Now two pods from the same ReplicaSet, or even two containers in one pod, can be running different config. This is a genuinely nasty class of "works on one replica" incident.

The better pattern when a directory must keep its image-provided contents: mount the whole ConfigMap somewhere neutral and symlink or include it.

```yaml
volumeMounts:
  - name: nginx-extra
    mountPath: /etc/nginx/extra.d      # whole volume, atomic updates intact
```

Then reference `/etc/nginx/extra.d/upstream.conf` from the main config (`include /etc/nginx/extra.d/*.conf;`), or have an init container symlink it into place. You keep atomic updates and live propagation.

:::danger[subPath rule of thumb]
Use `subPath` only for config that is genuinely immutable for the pod's lifetime, and force a rollout on every change (checksum annotation — see [rotation](/operations/configmap-secret-rotation/)). If you expect the file to ever update in place, subPath is the wrong tool.
:::

## Projected volumes: one directory, many sources

`projected` merges ConfigMaps, Secrets, the downward API, and service account tokens into a single tree — with per-source `items`:

```yaml
volumes:
  - name: runtime
    projected:
      defaultMode: 0440
      sources:
        - configMap:
            name: payments-config
            items:
              - key: application.yaml
                path: config/application.yaml
        - secret:
            name: payments-tls
            items:
              - key: tls.crt
                path: tls/tls.crt
              - key: tls.key
                path: tls/tls.key
        - downwardAPI:
            items:
              - path: pod/labels
                fieldRef:
                  fieldPath: metadata.labels
        - serviceAccountToken:
            path: tokens/vault-token
            audience: vault
            expirationSeconds: 3600
```

One mount, one coherent directory, atomic swaps across all of it. The `serviceAccountToken` source deserves its own note: this is the modern, *bound* SA token — audience-scoped, time-limited (`expirationSeconds`, minimum 600), and bound to the pod's lifetime so it's useless if exfiltrated after the pod dies. The kubelet refreshes it on disk automatically (starting around 80% of its lifetime), which means **your app must re-read the token file before each use**, not cache it at startup. Most modern SDKs (Vault agent, cloud provider SDKs, client-go) do this; hand-rolled HTTP clients usually don't. Token handling and secret hygiene generally live in [Secrets](/workloads/secrets/).

## Downward API as files: the one that updates live

Pod labels and annotations exposed via `downwardAPI` volumes **do update in place** when the metadata changes — unlike `fieldRef` environment variables, which are resolved once at container start and frozen forever. If you need a feature-flag-ish signal you can flip with `kubectl label pod`, a downward API file is the only built-in mechanism that propagates without a restart. Comparison of the env-side behavior lives in [Environment variables](/workloads/environment-variables/).

```yaml
- downwardAPI:
    items:
      - path: labels
        fieldRef:
          fieldPath: metadata.labels
```

The file contains `key="value"` lines, one per label, and follows the same `..data` atomic-swap machinery.

## Patterns you'll reach for constantly

**Mount shadows the whole directory.** Mounting a ConfigMap at `/etc/nginx/conf.d` replaces *everything* at that path — the image's `default.conf` is gone, along with anything else the image shipped there. This is the number-one "my other files vanished" surprise. Fixes, in order of preference: mount at a fresh path and include/symlink; use `items` + a whole-dir mount at a sibling path; `subPath` as a last resort (with the caveats above).

**Init-container templating.** When the app needs values substituted into its config (and can't read env vars itself), render at startup:

```yaml
initContainers:
  - name: render-config
    image: alpine:3.20
    command: ["sh", "-c", "apk add --no-cache gettext && envsubst < /tmpl/app.conf.tmpl > /rendered/app.conf"]
    env:
      - name: POD_IP
        valueFrom: { fieldRef: { fieldPath: status.podIP } }
    volumeMounts:
      - { name: config-template, mountPath: /tmpl }
      - { name: rendered, mountPath: /rendered }
containers:
  - name: app
    volumeMounts:
      - { name: rendered, mountPath: /etc/app }   # writable emptyDir, app can even rewrite it
volumes:
  - name: config-template
    configMap: { name: app-config-tmpl }
  - name: rendered
    emptyDir: {}
```

This also solves the read-only problem for apps that write to their config directory. Cost: the rendered file is frozen (it's an emptyDir snapshot), so treat it like subPath — rollout on change.

**Sidecar-watched config.** For apps that can't reload themselves, a sidecar (e.g. `configmap-reload`, or a tiny inotify script) watches the mount and POSTs to the app's reload endpoint or sends SIGHUP via a shared process namespace. Details and trade-offs in [rotation](/operations/configmap-secret-rotation/).

**Size limits.** ConfigMaps and Secrets cap at ~1 MiB (the whole object, keys included — enforced via etcd request limits). Don't fight it. Options: split across multiple ConfigMaps mounted as a projected volume; bake large static config into the image (GeoIP databases, ML model configs); or ship it on a PVC — see [Storage, PVs and PVCs](/stateful/storage-pv-pvc/). Also remember every mounted ConfigMap is watched/cached by the kubelet on every node running your pods; hundreds of large ConfigMaps have real cost.

**Non-UTF8 content** goes in `binaryData` (base64 in the manifest) and lands on disk as raw bytes — JKS keystores, `.p12` bundles, compiled dictionaries. `data` and `binaryData` keys share one namespace and one 1 MiB budget.

## File permissions in practice

The timestamped files are owned by `root:root` (Secret volumes default to `0644` file mode like ConfigMaps unless you set `defaultMode`; many people set Secrets to `0400`/`0600` for hygiene). Then they run the container as non-root and get:

```console
Error: open /etc/tls/tls.key: permission denied
```

A `0600 root:root` file is unreadable by UID 10001. The fix is group-based:

```yaml
securityContext:            # pod-level
  runAsUser: 10001
  runAsNonRoot: true
  fsGroup: 10001            # volume files get this group + group perms applied
volumes:
  - name: tls
    secret:
      secretName: payments-tls
      defaultMode: 0440     # owner root, group fsGroup can read
```

With `fsGroup` set, the kubelet chowns the volume's files to that group at mount time, so `0440` + `fsGroup: 10001` lets your non-root app read while keeping world-readable off. Two red herrings people chase instead: **umask** (irrelevant — these files are created by the kubelet with explicit modes, not by your process) and Docker `USER` directives (only sets the UID; it doesn't grant file access). If perms still look wrong, check whether a pod-level `securityContext` is being overridden at the container level.

## Debugging the mount

Work the layers in order.

**1. Did the pod even start?** Distinguish the two error classes:

- `CreateContainerConfigError` — the *env* layer failed: `configMapKeyRef`/`secretKeyRef` pointing at a missing object or key. The volume machinery isn't involved.
- `FailedMount` events / pod stuck in `ContainerCreating` — the *volume* layer failed:

```bash
kubectl describe pod payments-7d9f6b5c4-x2lqp | tail -8
```

```console
Events:
  Warning  FailedMount  2m (x8 over 4m)  kubelet  MountVolume.SetUp failed for volume "app-config" :
    configmap "payments-cofnig" not found
```

Read the message literally: `configmap "x" not found` is a typo'd name or wrong namespace (volumes can only reference objects in the pod's own namespace); `references non-existent config key` means your `items` list a key the object doesn't have; `secret "x" not found` plus a ServiceAccount-related message can also mean the object exists but *you* can't see it — `kubectl auth can-i get configmap/payments-config` settles whether it's RBAC or reality. `kubectl get cm --sort-by=.metadata.name` catches near-miss typos fast.

**2. Is the right content on disk?**

```bash
kubectl exec -it payments-7d9f6b5c4-x2lqp -- sh -c 'ls -laR /etc/payments && cat /etc/payments/..data/application.yaml'
```

`ls -laR` shows the symlink structure and the timestamped dir (its name tells you *when* the kubelet last wrote it). `cat` through `..data/` reads exactly what the atomic swap most recently published.

**3. Did an update actually propagate?** Compare cluster truth against disk:

```bash
kubectl get cm payments-config -o jsonpath='{.metadata.resourceVersion}'; echo
kubectl exec payments-7d9f6b5c4-x2lqp -- md5sum /etc/payments/..data/application.yaml
kubectl get cm payments-config -o jsonpath='{.data.application\.yaml}' | md5sum
```

Matching checksums but stale behavior means the files updated and **the app didn't reload** — an application problem, solved by the reload/rollout strategies in [rotation](/operations/configmap-secret-rotation/), not a volume problem. A pod restarting because config made it crash is a different article entirely: [CrashLoopBackOff](/troubleshooting/crashloopbackoff/). And if the ConfigMap in the cluster doesn't match what's in git, you have [drift](/operations/drift-and-cicd/), not a mount bug.

## Env vs file: the decision table

| Concern | Env vars | Files (volumes) |
|---|---|---|
| Update propagation | Never — frozen at container start | Live within ~1–2 min (except subPath / immutable) |
| Atomicity of multi-key updates | N/A (restart-only) | Atomic `..data` swap across all keys |
| Secrets hygiene | Leak via `kubectl describe`, crash dumps, child procs, `/proc/*/environ` | File perms + fsGroup; nothing in the API pod spec |
| Size | Fine for scalars; painful past a dozen values | Whole files; 1 MiB object cap, PVC/image beyond |
| Structured config (YAML/JSON/certs) | Awkward escaping | Native |
| App support needed | Universal | App must read files; reload logic for hot updates |
| Downward API | `fieldRef` frozen at start | Labels/annotations update live |

Default to env for a handful of scalar settings ([Environment variables](/workloads/environment-variables/)), files for anything structured, secret, large, or hot-reloadable ([Secrets](/workloads/secrets/)) — and whichever you choose, decide *up front* how updates reach the process, because "the file changed but nothing happened" is the most common config incident there is. Pair reload behavior with [health checks](/workloads/health-checks/) so a bad config file fails fast instead of serving garbage.
