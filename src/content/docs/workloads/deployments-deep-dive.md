---
title: Deployments Deep Dive
description: Deployment spec anatomy — the selector/labels contract, ReplicaSets and pod-template-hash, revision history, and the timing fields that control rollout health.
keywords:
  - selector field is immutable
  - orphaned pods
  - pod-template-hash
  - replicaset naming
  - progressdeadlineexceeded
  - rollout stuck up-to-date
  - minreadyseconds soak time
  - revisionhistorylimit
  - kubectl rollout status non-zero
  - overlapping selectors two deployments
  - which version is this pod
sidebar:
  order: 2
---

A Deployment is a small object with outsized consequences. Most of the grief people have with them traces back to three or four fields that everyone copy-pastes without reading. Let's read them.

## A complete, honest example

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments
  namespace: team-checkout
  labels:
    app: payments            # labels on the Deployment object itself — cosmetic
spec:
  replicas: 3
  revisionHistoryLimit: 10
  minReadySeconds: 10
  progressDeadlineSeconds: 600
  selector:
    matchLabels:
      app: payments           # THE CONTRACT — see below
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: payments         # must satisfy the selector, or the API rejects it
    spec:
      containers:
        - name: payments
          image: registry.example.com/checkout/payments:1.42.0
          ports:
            - containerPort: 8080
          resources:
            requests: { cpu: 250m, memory: 512Mi }
            limits: { memory: 512Mi }
          readinessProbe:
            httpGet: { path: /healthz/ready, port: 8080 }
            periodSeconds: 5
```

## The selector/labels contract

`spec.selector` tells the Deployment (and its ReplicaSets) which pods it owns. `spec.template.metadata.labels` are the labels stamped onto every pod it creates. The template labels must match the selector — the API server enforces this at create time.

Three things you must know:

1. **The selector is immutable.** Once created, you cannot change `spec.selector` on a Deployment. `kubectl apply` with a different selector fails with `field is immutable`. The only way to "change" it is delete-and-recreate, which means downtime unless you orchestrate it carefully.
2. **You can freely add labels to the template** (e.g., `version: 1.42.0` for dashboards) as long as the selector labels stay present. Changing template labels triggers a rollout like any other template change.
3. **Keep selectors minimal.** Select on `app: payments` (and maybe a component label), not on version or build labels. A selector that includes a version means every release orphans the old pods instead of rolling them.

:::danger[Orphaned pods are the classic selector wound]
If you delete a Deployment with `--cascade=orphan` (or fight the immutability by deleting and recreating with a different selector), the old pods keep running with nobody managing them. They still match your Service selector, so traffic hits stale code while you stare at a "healthy" new Deployment. If pod counts ever look impossibly high, check for pods whose `ownerReferences` point at a ReplicaSet that no longer exists.
:::

Also beware **overlapping selectors across Deployments**. Two Deployments in the same namespace whose selectors both match some pods will fight over them, and the controllers make no attempt to referee. This is a real hazard when doing [two-Deployment canaries](/workloads/rollouts-and-rollbacks/) — the shared labels should be on the *Service* selector, not the Deployments' selectors.

## ReplicaSets and pod-template-hash

Every time the pod **template** changes (image, env, resources, labels, anything under `spec.template`), the Deployment controller:

1. Hashes the new template.
2. Creates a ReplicaSet named `<deployment>-<hash>` if one doesn't exist for that hash.
3. Adds `pod-template-hash: <hash>` to that ReplicaSet's selector and pod labels — this is how two ReplicaSets under one Deployment avoid claiming each other's pods.
4. Scales the new ReplicaSet up and the old one down, per the strategy.

Scaling `replicas` alone does **not** create a new ReplicaSet — replica count lives on the Deployment, not in the template. The full catalog of what does and doesn't trip this mechanism — including the config-change gap — is in [what triggers a rollout](/workloads/rollout-triggers/).

You can watch the relationship:

```console
$ kubectl get rs -l app=payments
NAME                  DESIRED   CURRENT   READY   AGE
payments-7d9f8b6c4d   3         3         3       2d      # current template
payments-6b5c7f9d8e   0         0         0       9d      # previous revision
payments-59c8d7f6b5   0         0         0       23d     # older revision

$ kubectl get pods -l app=payments --show-labels
NAME                        READY   STATUS    ...   LABELS
payments-7d9f8b6c4d-x2kfp   1/1     Running   ...   app=payments,pod-template-hash=7d9f8b6c4d
```

The pod name is `<deployment>-<pod-template-hash>-<random>`. When you're debugging "which version is this pod?", the hash in the name maps directly to a ReplicaSet, and `kubectl get rs payments-7d9f8b6c4d -o jsonpath='{.spec.template.spec.containers[0].image}'` tells you the image.

:::tip
An interesting property: if you roll back to a template Kubernetes has seen before, the controller *reuses* the old ReplicaSet (same hash) rather than creating a new one. Revision numbers move to the reused ReplicaSet.
:::

## replicas

Desired pod count. Defaults to 1 if omitted — which interacts badly with CI/CD when an HPA is also scaling the Deployment: every `kubectl apply` that includes `replicas` stomps whatever the HPA set. If you use an HPA, **omit `replicas` from your manifest entirely**. Details in [autoscaling](/workloads/autoscaling/).

## revisionHistoryLimit

How many old (scaled-to-zero) ReplicaSets to keep. Default is 10. Each retained ReplicaSet is a rollback target for `kubectl rollout undo`. Setting it to 0 disables rollback entirely — don't, unless your CI/CD is genuinely your only rollback path and you've accepted that. 3–10 is sane. The old ReplicaSets cost nothing but a few kilobytes in etcd.

## strategy

- `RollingUpdate` (default): replace pods gradually, governed by `maxSurge` and `maxUnavailable`.
- `Recreate`: kill all old pods, then start new ones. Guaranteed downtime; occasionally correct (single-writer apps, RWO volumes).

Tuning these properly deserves its own article: [rollouts and rollbacks](/workloads/rollouts-and-rollbacks/).

## minReadySeconds

A newly Ready pod is not counted as **available** until it has stayed Ready for `minReadySeconds` (default 0). During a rollout, the controller waits for availability before proceeding to the next batch, so this is your "soak time per pod" knob.

Why it matters: plenty of apps pass their readiness probe once, then crash 15 seconds later (bad config discovered on first real request, JVM dying during warmup). With `minReadySeconds: 0`, the rollout barrels ahead and you replace your whole fleet with a crasher. With `minReadySeconds: 30`, the first bad pod flaps back to NotReady inside the window and the rollout stalls with most old pods still serving. A stalled rollout is an incident you can fix calmly; a completed bad rollout is an outage.

## progressDeadlineSeconds

If a rollout makes no progress (no pod becoming available) for this many seconds — default 600 — the Deployment sets condition `Progressing=False, reason=ProgressDeadlineExceeded`.

Two things people get wrong:

- **Nothing is rolled back automatically.** The condition is informational. `kubectl rollout status` exits non-zero (which is how your pipeline should catch failed deploys), but the cluster just sits there with a wedged rollout until a human or pipeline acts.
- **The deadline resets on every progress event**, so a slow-but-moving rollout won't trip it.

```console
$ kubectl rollout status deploy/payments --timeout=10m
Waiting for deployment "payments" rollout to finish: 1 out of 3 new replicas have been updated...
error: deployment "payments" exceeded its progress deadline

$ kubectl get deploy payments -o jsonpath='{.status.conditions[?(@.type=="Progressing")].reason}'
ProgressDeadlineExceeded
```

Set `progressDeadlineSeconds` a bit above your worst honest startup time × failureThreshold math, and make CI/CD gate on `rollout status`. If probes are why pods never become Ready, that's a [health checks](/workloads/health-checks/) problem.

## Reading status like the controller does

```console
$ kubectl get deploy payments
NAME       READY   UP-TO-DATE   AVAILABLE   AGE
payments   2/3     1            2           42d
```

- **READY 2/3** — 2 pods Ready out of 3 desired.
- **UP-TO-DATE 1** — only 1 pod runs the *current* template; a rollout is in flight (or stuck).
- **AVAILABLE 2** — Ready pods that have also survived `minReadySeconds`.

`UP-TO-DATE` less than desired for a long time plus `READY` stuck = your new pods aren't coming up. Go look at the new ReplicaSet's pods, not the Deployment:

```console
$ kubectl get pods -l app=payments,pod-template-hash=<new-hash>
$ kubectl describe pod <one-of-them>    # read the Events
```

Nine times out of ten the answer is in those Events: image pull failure, unschedulable resources, or a failing probe — the [triage methodology](/troubleshooting/triage-methodology/) covers the full decision tree.
