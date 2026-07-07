---
title: ConfigMap and Secret Rotation
description: Updating configuration and secrets in running workloads — what propagates live, what needs a restart, and the subPath trap that catches everyone.
keywords:
  - subpath not updating
  - env var not refreshing
  - checksum/config annotation
  - reloader stakater
  - kubectl rollout restart
  - two-phase database password
  - external secrets operator
  - sealed secrets
  - sops
  - immutable configmap
  - sighup reload
  - secrets store csi driver
sidebar:
  order: 4
---

"Just change the ConfigMap" is one of the most misunderstood operations in Kubernetes. Depending on *how* the config reaches the pod, updating a ConfigMap does one of three things: propagates within a minute, does nothing until a restart, or — in one infamous case — does nothing **ever**. Get this model straight before you rotate anything in production.

## The three propagation behaviors

| How the pod consumes it | Effect of updating the ConfigMap/Secret |
|---|---|
| `env` / `envFrom` | **Nothing.** Env vars are resolved once, at container start. Frozen until restart. |
| Volume mount (whole ConfigMap) | File contents update in place, ~seconds to ~1 minute (kubelet sync period + cache) |
| Volume mount with `subPath` | **Never updates.** Not on sync, not ever, until the pod is recreated. |

### Environment variables: frozen at start

```yaml
env:
  - name: PAYMENTS_TIMEOUT_MS
    valueFrom:
      configMapKeyRef:
        name: payments-config
        key: timeout-ms
```

The kubelet reads the ConfigMap when it starts the container and bakes the value into the process environment. Editing the ConfigMap afterward changes nothing for running pods — there is no mechanism by which a Unix process's environment gets rewritten. If your config is env-based, **every config change is a restart**. That's not necessarily bad (it's predictable, and every pod is guaranteed consistent), but you must plan the rollout.

### Volume mounts: live-ish updates

```yaml
volumeMounts:
  - name: config
    mountPath: /etc/payments
volumes:
  - name: config
    configMap:
      name: payments-config
```

The kubelet projects the ConfigMap's keys as files and refreshes them periodically. Update the ConfigMap and the files under `/etc/payments` change — typically within a minute (kubelet sync loop plus a TTL-based cache; budget up to ~2 minutes and don't write scripts that assume instant propagation). The update is atomic per-volume: kubelet writes a new dot-directory and flips a symlink, so readers never see a half-written file.

Verify from inside the pod:

```bash
kubectl exec deploy/payments -- cat /etc/payments/timeout-ms
2000
kubectl patch configmap payments-config --type merge -p '{"data":{"timeout-ms":"5000"}}'
# ...wait ~60s...
kubectl exec deploy/payments -- cat /etc/payments/timeout-ms
5000
```

### The subPath trap

```yaml
volumeMounts:
  - name: config
    mountPath: /app/application.yaml
    subPath: application.yaml     # ← this mount will NEVER update
```

`subPath` mounts a specific file by binding to the resolved path at pod start — it bypasses the symlink-flip machinery entirely. Updates to the ConfigMap **never reach a subPath mount**. This is the classic: a team "rotates" config, verifies the ConfigMap object is updated, sees no behavior change, and burns hours before finding `subPath` in the manifest.

:::danger[Check for subPath first]
Before any live config rotation, run
`kubectl get deploy payments -o yaml | grep -B4 subPath`.
If your config file is subPath-mounted, the only rotation mechanism is a pod restart. Consider restructuring: mount the whole ConfigMap at a directory (`/etc/payments/`) and point the app at it, keeping `subPath` only for cases where you must overlay a single file into a non-empty image directory.
:::

## The file updated — did the app notice?

Kubelet updating the file is half the job. Most applications read config **once at startup** and never look again. A live-updated file under a process that doesn't re-read it is exactly as effective as no update.

Ways applications actually pick up changes:

- **File watching**: the app watches the config path (inotify or polling). Note: watch the *directory*, not the file — the symlink flip means the file is replaced, and naive single-file inotify watches silently detach. Envoy, Prometheus (rule files), and most Go config libraries handle this correctly.
- **Spring Boot / Spring Cloud Kubernetes**: `spring-cloud-starter-kubernetes-client-config` can watch ConfigMaps and refresh `@ConfigurationProperties` beans (`spring.cloud.kubernetes.reload.enabled=true`). Test which of your beans are actually refreshable — anything wired once at startup (connection pools, thread pools) usually isn't. More in [Java observability](/java/java-observability/).
- **SIGHUP convention**: many daemons (nginx, HAProxy, fluent-bit) reload on SIGHUP. You can deliver it without a restart:

```bash
kubectl exec deploy/payments-proxy -- sh -c 'kill -HUP 1'
```

- **A reload endpoint**: e.g. `curl -X POST localhost:9090/-/reload` for Prometheus-style apps, via `kubectl exec`.

If your app has none of these, don't fake it — do a clean [rollout restart](/operations/restarts-without-redeploy/) and let every pod re-read config at startup.

## Forcing the restart through the pipeline: the checksum annotation

The standing problem: you change a ConfigMap in git, the pipeline applies it, and **nothing restarts** — ConfigMap changes are not pod-template changes, so the Deployment doesn't roll. Pods keep running with stale env (or un-re-read files) until they happen to restart, at which point they pick up config nobody has validated in weeks. Delayed config activation is one of the sneakiest failure classes in Kubernetes.

The fix is to make the config change *become* a pod-template change. Put a hash of the config into a template annotation:

```yaml
# Helm chart:
spec:
  template:
    metadata:
      annotations:
        checksum/config: '{{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}'
```

Config changes → hash changes → template changes → normal rolling update with probes, `maxUnavailable`, and PDBs all honored. Kustomize achieves the same effect differently: `configMapGenerator` appends a content hash to the ConfigMap *name* and rewrites every reference, which also forces a roll. Plain-manifest pipelines can compute the hash in CI and `kubectl patch` the annotation. Reloader (Stakater) is the controller-shaped version of the same idea, if your platform team offers it.

## Immutable ConfigMaps and the rename-and-rollout workflow

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: payments-config-v42
immutable: true
data:
  timeout-ms: "5000"
```

`immutable: true` means the object can never be updated — only deleted and recreated. Why volunteer for that? Two reasons: it protects you from accidental in-place edits (including well-meaning live ones), and on large clusters it lets the kubelet stop watching the object (a platform-team-visible performance win).

The workflow becomes rename-and-rollout, which is really versioned config:

1. Create `payments-config-v43` with the new values.
2. Update the Deployment to reference `-v43` (a pod-template change → rolling update).
3. Garbage-collect `-v42` once nothing references it.

You get atomic, all-or-nothing config activation and a trivially easy rollback (point back at `-v42`). Kustomize's `configMapGenerator` automates exactly this lifecycle. The trade-off: no live-file-update behavior at all — every change is a roll. Many teams consider that a feature.

## Secret rotation

Secrets propagate exactly like ConfigMaps (env = frozen, volume = ~1min, subPath = never), plus one extra wrinkle: the *consumer on the other end* — a database, an API — has opinions about when the old credential stops working.

### Mounted secret rotation flow

For a volume-mounted secret where the app re-reads it (or retries auth on failure):

```bash
# 1. Update the secret
kubectl create secret generic payments-db-cred \
  --from-literal=username=payments --from-literal=password="$NEW_PW" \
  --dry-run=client -o yaml | kubectl apply -f -

# 2. Wait for kubelet propagation, then verify inside a pod
kubectl exec deploy/payments -- cat /var/run/secrets/db/password

# 3. If the app doesn't re-read: rolling restart
kubectl rollout restart deployment/payments
```

### Two-phase database password rotation

Never rotate a live database password in one step — there is always a window where running pods hold the old password and the DB only accepts the new one, which means auth-failure storms and, with lockout policies, a locked account. Do it in two phases with **dual-valid credentials**:

1. **Phase 1**: create a *second* valid credential (new password on a second user, or a DB that supports two active passwords — most managed databases and Vault database engines do). Update the Secret; roll the workload. Old and new both work throughout the roll.
2. **Phase 2**: once every pod is confirmed on the new credential, revoke the old one.

If your database genuinely supports only one password per user, schedule the rotation, make the roll fast, and expect a brief error window — pool reconnect behavior decides how brief. Test in staging first.

### External secret managers

If your platform offers **External Secrets Operator** (syncs from Vault/AWS/GCP/Azure into a normal Secret object) or the **Secrets Store CSI driver** (mounts directly from the manager, optionally auto-rotating the mounted files), use them — rotation then happens in the secret manager and flows to pods without you touching kubectl. The propagation rules above still apply at the pod boundary: env-consumed secrets still need a restart, and ESO users should pair rotation with a checksum annotation or Reloader. Whether these operators are installed is a platform-team question — see [Working with the platform team](/operations/working-with-platform-team/).

### Secrets in git: Sealed Secrets and SOPS

Plain Secrets are only base64-encoded — never commit them. Two mainstream patterns keep your git-as-source-of-truth story intact:

- **Sealed Secrets** (Bitnami): you commit a `SealedSecret` encrypted against the cluster controller's public key; the controller decrypts it into a real Secret in-cluster. Rotation = re-seal the new value, merge, let the pipeline apply.
- **SOPS** (+ age/KMS): encrypted values inside otherwise-normal YAML; decrypted at deploy time by Flux's SOPS integration, a Helm plugin, or a CI step.

Either way, secret rotation becomes an ordinary PR — which means it composes with everything in [Drift and CI/CD](/operations/drift-and-cicd/): a live `kubectl apply`'d secret that isn't reflected in the sealed/SOPS source is drift, and it will be clobbered like any other.

## Rotation quick reference

```bash
# How is the config consumed? (the question that decides everything)
kubectl get deploy NAME -o yaml | grep -E 'configMapKeyRef|envFrom|subPath' -B3

# Update + force clean rollout (works regardless of consumption style)
kubectl apply -f configmap.yaml
kubectl rollout restart deployment/NAME
kubectl rollout status deployment/NAME
```

When in doubt, restart. A rolling restart after a config change costs a few minutes and leaves zero ambiguity about which pods run which config — see [Restarts without redeploy](/operations/restarts-without-redeploy/) for how to do it safely.
