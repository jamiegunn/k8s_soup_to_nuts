---
title: "Field Notes: The subPath Mount That Never Updated"
description: We updated a ConfigMap, verified it in-cluster, and then watched the app ignore it for days — on some pods. The culprit was one line of volume config and a propagation rule nobody had read.
date: 2026-02-25
authors: editor
tags:
  - configmaps
  - volumes
  - configuration
  - rollouts
excerpt: >-
  The config change was merged, the ConfigMap in the cluster was verifiably correct, and the app kept running the old behavior — except on two pods, where it didn't. It took us days to accept the diagnosis, because it sounds made up: some of our pods were reading a file that no longer existed anywhere but inside their own mount.
---

This incident had no page, no error rate, no red dashboard. It had something worse: a feature flag that "didn't work," an A/B test producing impossible numbers, and a config system that everyone *verified* was correct while it quietly wasn't — on most pods.

## Monday: a one-line config change

The change was as boring as changes get. Our `checkout-web` service reads feature flags from a YAML file, and we flipped one:

```yaml
# ConfigMap app-config, key features.yaml
features:
  newPricingBanner: true    # was false
```

Merged, deployed through the pipeline, ConfigMap updated. Someone even checked, because we're diligent like that:

```console
$ kubectl get configmap app-config -o yaml | grep -A1 newPricingBanner
    newPricingBanner: true
```

Cluster says `true`. Ticket closed. Feature "live."

## Thursday: the impossible A/B numbers

Three days later a PM asked why the banner experiment showed only ~20% of sessions seeing the banner when it was configured for 100%. First theory: CDN caching. Second: the frontend. Third: sticky sessions pinning users to... something. It took embarrassingly long to run the one command that mattered — asking the *pods themselves* what config they were holding:

```console
$ for p in $(kubectl get pods -l app=checkout-web -o name); do
    echo -n "$p: "
    kubectl exec ${p#pod/} -- grep newPricingBanner /app/config/features.yaml
  done
pod/checkout-web-6f7d4c5b8-2plxv: newPricingBanner: false
pod/checkout-web-6f7d4c5b8-8trwm: newPricingBanner: false
pod/checkout-web-6f7d4c5b8-dq4hz: newPricingBanner: true
pod/checkout-web-6f7d4c5b8-jw9k2: newPricingBanner: false
pod/checkout-web-6f7d4c5b8-vc6mn: newPricingBanner: true
```

Same Deployment. Same ReplicaSet. Same image. Same ConfigMap. **Different config.** Two pods on the new value, three on the old — and the ConfigMap in the API said `true` for everyone. This is the moment the incident channel filled with variations of "that's not possible."

The tell was pod age. The two `true` pods were young — one from a node the platform team had drained Wednesday, one from an HPA scale-up. The three `false` pods were eleven days old, born before the change. **Pods created after the ConfigMap update had new config; pods created before it were frozen in the past.** Roughly 40% of pods, hence roughly the PM's numbers.

## The one line that did it

Here's the volume config, which had been in the repo for a year and reviewed by everyone:

```yaml
containers:
  - name: checkout-web
    volumeMounts:
      - name: app-config
        mountPath: /app/config/features.yaml
        subPath: features.yaml          # <- this line
volumes:
  - name: app-config
    configMap:
      name: app-config
```

We used `subPath` for a sensible-sounding reason: `/app/config/` already contained other files baked into the image, and mounting the whole ConfigMap as a directory would have shadowed them. `subPath` let us project just one file into an existing directory. Tidy.

What we didn't know: **a `subPath` mount never receives ConfigMap updates. Ever.** This isn't a bug or a race; it's documented behavior. A normal ConfigMap volume mount stays fresh because the kubelet writes the keys into a timestamped directory and points a symlink at it — you can see the machinery from inside any pod with a directory mount:

```console
$ kubectl exec checkout-web-6f7d4c5b8-dq4hz -- ls -la /app/config/flags/
lrwxrwxrwx  ..data -> ..2026_02_23_14_07_09.318486372
drwxr-xr-x  ..2026_02_23_14_07_09.318486372
lrwxrwxrwx  features.yaml -> ..data/features.yaml
```

On update, the kubelet writes a *new* timestamped directory and atomically swaps the `..data` symlink; anything reading through the mount path follows it to the fresh content. A `subPath` mount, though, is a bind mount of *the resolved file* — one specific inode inside one specific timestamped directory — wired up once, when the container starts. When the kubelet swaps the symlink later, the bind mount keeps pointing at the old snapshot. The pod isn't reading stale config from the API; it's reading a file that, from the API's point of view, no longer exists.

So every pod's config was determined not by the ConfigMap, but by *when the pod happened to be created*. Deploys, evictions, node drains, HPA churn — each one silently "deployed" the config change to a few more pods, days apart. That's the maddening part: the system converges toward correctness, one restart at a time, which makes the symptom look like anything except what it is. The full propagation matrix — env vars (never, until restart), `subPath` (never, period), directory mounts (eventually, kubelet sync + cache delay) — is laid out in [config files and volumes](/workloads/config-files-and-volumes/).

:::note
`kubectl get configmap` verifies the API object. It verifies nothing about what any container can see. When behavior and config disagree, `kubectl exec ... cat` the file *inside the pod* — that's the only ground truth a process has.
:::

## The fix: propagation you chose, not propagation you inherited

Two changes, and the second one matters more than the first.

**First**, we stopped fighting the directory. Config moved to its own path so the whole ConfigMap mounts as a directory — no `subPath`, no shadowing problem, updates propagate the way the kubelet intends:

```diff
     volumeMounts:
       - name: app-config
-        mountPath: /app/config/features.yaml
-        subPath: features.yaml
+        mountPath: /app/config/flags      # dedicated dir, whole-CM mount
```

(The app's search path gained one entry. That was the entire cost of the "tidy" `subPath` workaround we'd been paying interest on for a year.)

**Second** — and this is the real lesson — we stopped *relying* on propagation at all. Even a directory mount only updates the file; our app reads `features.yaml` once at startup, like most apps do. Fresh file, stale process. So config changes now force a rollout, via the standard checksum-annotation trick in the pod template:

```yaml
# Deployment pod template (Helm)
metadata:
  annotations:
    checksum/app-config: '{{ include (print $.Template.BasePath "/app-config.yaml") . | sha256sum }}'
```

Any change to the ConfigMap changes the hash, which changes the pod template, which triggers a normal rolling update — surge, readiness gates, rollback-able, visible in `kubectl rollout history`. Config changes ride the same machinery as code changes, with the same guarantees, as they should ([rollouts and rollbacks](/workloads/rollouts-and-rollbacks/) covers why that machinery is worth routing everything through). Live-reload — an app that watches the file and re-reads it — is the alternative, but it's something you *engineer* (watcher, atomic re-parse, a metric proving which config generation is loaded), not something you assume.

## What we changed

- **Every ConfigMap/Secret consumer in the repo now has a declared propagation mode**, in a comment next to the mount: `restart-required` (env vars, `subPath`, boot-time file reads) or `live-reload` (directory mount *plus* an app watcher *plus* a config-generation metric). "I don't know" stopped being an option in review. The decision guide lives in [configuration](/workloads/configuration/).
- **Checksum annotations on every Deployment that consumes config.** A config merge now *is* a rollout. Nobody gets to wonder which pods have which config, because the answer is always "whatever the current ReplicaSet has."
- **`subPath` for ConfigMaps requires a review justification.** There are legitimate uses, but each one is a mount that will lie to you forever, and the manifest now has to say that out loud.
- **The A/B analysis runbook gained a first step: confirm the config *in the pods*, per pod, not in the API.** The `kubectl exec ... grep` loop above is pasted verbatim. Impossible experiment numbers are a config-skew symptom until proven otherwise.
- **Config changes get verified like deploys:** after merge, we check `kubectl rollout status` and the config-generation metric, not `kubectl get configmap`. Verifying the API object is verifying the *order*, not the delivery.

The summary we wrote at the top of the postmortem: config has a supply chain — API object, volume, file, process memory — and "updated" at one stage guarantees nothing about the next. Our ConfigMap was correct within seconds. Our pods disagreed with it for eleven days, one inode apart, and every tool we normally trust said everything was fine.
