---
title: Rollouts and Rollbacks
description: Tuning RollingUpdate surge and unavailability, driving kubectl rollout safely, and building canary and blue/green releases with plain Deployments and Services.
sidebar:
  order: 3
---

Every deploy is a controlled failure drill: you're deliberately killing healthy pods and betting the replacements are better. The strategy fields decide how much of your capacity you gamble at once, and `kubectl rollout` is how you watch, pause, and reverse the bet. (This article is about the roll itself — if your question is why a rollout did or didn't *start*, that's [what triggers a rollout](/workloads/rollout-triggers/).)

## RollingUpdate vs Recreate

```yaml
spec:
  strategy:
    type: RollingUpdate        # default
    rollingUpdate:
      maxSurge: 25%            # extra pods allowed above desired count
      maxUnavailable: 25%      # pods allowed below desired count
```

**RollingUpdate** scales the new ReplicaSet up and the old one down in interleaved steps, never violating either bound. **Recreate** scales the old ReplicaSet to zero, waits for every pod to die, then brings up the new one — guaranteed downtime, by design.

Use Recreate only when old and new genuinely cannot coexist: a single-writer app, incompatible schema access, or a ReadWriteOnce PVC that only one pod can mount (common with [stateful workloads](/stateful/storage-pv-pvc/) that snuck into a Deployment).

## Tuning maxSurge and maxUnavailable

Both accept absolute numbers or percentages (percentages are computed against desired replicas; surge rounds up, unavailable rounds down). They can't both be zero.

Concrete scenarios for `replicas: 4`:

| Setting | Behavior | When |
|---|---|---|
| `maxSurge: 1, maxUnavailable: 0` | Add 1 new pod, wait until it's available, then kill 1 old. Never below 4 serving. Slowest, safest. | Latency-sensitive prod services. My default. |
| `maxSurge: 25%, maxUnavailable: 25%` | Defaults: up to 5 pods total, as few as 3 available mid-roll. | Fine for most things, but you *are* losing 25% capacity during deploys. |
| `maxSurge: 100%, maxUnavailable: 0` | Double the fleet, then tear down old. Fastest zero-dip rollout. | When node capacity allows and you want deploys over fast. |
| `maxSurge: 0, maxUnavailable: 1` | No extra pods ever; replace strictly one-for-one, dipping to 3. | Quota-constrained namespaces where you can't afford a single surge pod. |

:::caution[Surge counts against your quota]
`maxSurge` pods need real scheduling headroom. If your namespace ResourceQuota (see [resources and QoS](/workloads/resources-and-qos/)) is sized for exactly N replicas, the surge pod goes Pending, the rollout stalls, and eventually `progressDeadlineSeconds` trips. Either budget quota for N + surge, or run `maxSurge: 0, maxUnavailable: 1`.
:::

And remember: `maxUnavailable` reasons about pods that pass their readiness probe. If your [readiness probes](/workloads/health-checks/) lie, "zero unavailable" is a comforting fiction.

## Driving a rollout with kubectl

```console
$ kubectl rollout status deploy/payments
Waiting for deployment "payments" rollout to finish: 2 out of 3 new replicas have been updated...
deployment "payments" successfully rolled out
```

`rollout status` blocks until success or `progressDeadlineSeconds`, and exits non-zero on failure — put it in your pipeline right after the apply. A deploy step that doesn't wait for rollout status isn't a deploy step, it's a hope step.

```console
$ kubectl rollout history deploy/payments
deployment.apps/payments
REVISION  CHANGE-CAUSE
5         <none>
6         release 1.41.2 (build 8841)
7         release 1.42.0 (build 8907)

$ kubectl rollout history deploy/payments --revision=6
# full pod template for that revision — verify the image before you undo to it
```

`CHANGE-CAUSE` comes from the `kubernetes.io/change-cause` annotation. Nobody remembers to set it by hand; make CI do it:

```bash
kubectl annotate deploy/payments \
  kubernetes.io/change-cause="release ${VERSION} (build ${BUILD_ID})" --overwrite
```

**Pause/resume** lets you batch several edits into one rollout, or freeze a rollout mid-flight while you investigate:

```console
$ kubectl rollout pause deploy/payments
$ kubectl set image deploy/payments payments=registry.example.com/checkout/payments:1.42.1
$ kubectl set resources deploy/payments -c payments --requests=cpu=500m
$ kubectl rollout resume deploy/payments
```

**Restart** — recreate every pod with the *same* template (new ReplicaSet, rolling replacement, honors surge/unavailable). The correct way to bounce an app, covered further in [restarts without redeploy](/operations/restarts-without-redeploy/):

```console
$ kubectl rollout restart deploy/payments
```

## Rollback — and why `undo` fights your CI/CD

```console
$ kubectl rollout undo deploy/payments                # back to previous revision
$ kubectl rollout undo deploy/payments --to-revision=5
```

Mechanically this copies an old ReplicaSet's template back onto the Deployment and rolls to it. It works, it's fast, and at 3 a.m. it's often the right call.

But understand what you just did: **the cluster no longer matches git.** Your manifest still says 1.42.0; the cluster runs 1.41.2. The next pipeline run — or your GitOps controller within minutes — will happily re-deploy the broken version. I've watched a 3 a.m. rollback get reverted by a 6 a.m. cron-triggered sync, causing the same outage twice.

The durable fix is always: revert in git, let the pipeline roll forward. Use `rollout undo` as a tourniquet, then immediately make git agree. Full treatment in [drift and CI/CD](/operations/drift-and-cicd/) — and designing the pipeline so roll-forward is fast enough to be the default (git revert as the rollback path, last-known-good tags) is covered in [CI/CD pipeline design](/operations/cicd-pipeline-design/).

:::danger
If ArgoCD/Flux manages this Deployment with auto-sync, `rollout undo` may be reverted within minutes. Know your sync policy *before* the incident.
:::

## Canary-ish with two Deployments and label games

You don't get traffic-percentage canaries from a bare Deployment — real weighted routing needs a mesh or a capable ingress ([talk to your platform team](/operations/working-with-platform-team/)). But you can get pod-ratio canaries with nothing but labels, because a Service selects pods from *any* Deployment that matches.

The trick: the **Service selector** uses only the shared label; each **Deployment selector** adds a distinguishing label so they don't fight over pods (see [the selector contract](/workloads/deployments-deep-dive/)).

```yaml
apiVersion: v1
kind: Service
metadata:
  name: payments
spec:
  selector:
    app: payments            # matches BOTH deployments' pods
  ports:
    - port: 80
      targetPort: 8080
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-stable
spec:
  replicas: 9
  selector:
    matchLabels: { app: payments, track: stable }
  template:
    metadata:
      labels: { app: payments, track: stable }
    spec:
      containers:
        - name: payments
          image: registry.example.com/checkout/payments:1.41.2
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-canary
spec:
  replicas: 1
  selector:
    matchLabels: { app: payments, track: canary }
  template:
    metadata:
      labels: { app: payments, track: canary }
    spec:
      containers:
        - name: payments
          image: registry.example.com/checkout/payments:1.42.0
```

Roughly 10% of connections (1 pod of 10) hit the canary — approximate, since kube-proxy balances per-connection, not per-request. Watch the canary's error rate and latency in your [metrics](/observability/metrics/), filtered by the `track` label. Promote by updating stable's image and scaling the canary to 0; abort by scaling the canary to 0. Either way it's one `kubectl scale` from safety, and the whole state lives in declarative manifests your pipeline can own.

## Blue/green with a Service selector switch

Canary mixes versions; blue/green switches *all* traffic atomically. Run two full-size Deployments with a `slot` label; the Service points at exactly one:

```yaml
# Service — the only thing that changes at cutover
spec:
  selector:
    app: payments
    slot: green            # was: blue
```

Procedure:

1. Deploy `payments-green` alongside the live `payments-blue`; wait for `kubectl rollout status`.
2. Smoke-test green directly — via a second Service pinned to `slot: green`, or `kubectl port-forward deploy/payments-green 8080:8080`.
3. Patch the main Service selector to `slot: green`. Endpoint updates propagate in seconds; existing connections to blue drain naturally.
4. Keep blue running (scaled down if you like) as your instant rollback: flip the selector back.

```console
$ kubectl patch svc payments -p '{"spec":{"selector":{"app":"payments","slot":"green"}}}'
```

Costs: double capacity during the window, and any in-flight sticky state on blue is lost at cutover. But the rollback is a one-line patch that takes effect in seconds — for risky releases, that trade is often worth it. Just make sure the selector flip lands back in git, or you've built drift into your release process.
