---
title: "Reconciliation: The Control Loop"
description: How Kubernetes controllers converge actual state toward desired state, why level-triggered design matters, and how to work with reconciliation instead of fighting it.
keywords:
  - level-triggered vs edge-triggered
  - control loop observe diff act
  - finalizers stuck terminating
  - pvc-protection finalizer
  - namespace stuck terminating
  - observedGeneration lag
  - hpa fighting gitops replicas
  - informers work queue resync
  - cascading delete ownerreferences
  - reconcile backoff retry
sidebar:
  order: 2
---

Every controller in Kubernetes runs the same three-step loop:

1. **Observe** — watch the API server for objects it cares about.
2. **Diff** — compare desired state (`spec`) against actual state (what exists in the cluster, reported in `status` and in the child objects).
3. **Act** — do the smallest thing that moves actual toward desired. Then go back to step 1.

That's it. There's no workflow engine, no saga, no "deployment script" running somewhere. Just dozens of small loops, each nudging one kind of object toward its declared state, forever.

## Level-triggered, not edge-triggered

This is the design decision that makes Kubernetes robust, and it's worth thirty seconds of your attention.

- **Edge-triggered**: react to *events*. "Pod deleted → create a new one." If you miss the event (controller was restarting, network blipped, event queue overflowed), the system stays broken.
- **Level-triggered**: react to *state*. "ReplicaSet says 3, I count 2 → create one." It doesn't matter *how* you got to 2, or whether the controller saw it happen. Next time it looks, it fixes it.

Kubernetes controllers are level-triggered. Events (via watches) are just an optimization to wake the loop up quickly — the correctness comes from re-comparing full state. This is why:

- A controller that crashes and restarts picks up exactly where reality is, with no replay of missed events.
- You can `kubectl delete` half your pods during an incident and everything self-heals.
- Fixes are *convergent*: the system keeps trying until desired == actual, rather than failing once and giving up.

Under the hood, controllers use **informers**: a watch on the API server feeding a local cache, plus a periodic full resync as a safety net. When anything changes — or on resync — the affected object's key goes on a work queue and the reconcile function runs. You'll never operate this machinery yourself, but "there's a cache and a queue" explains why controller reactions are usually sub-second but occasionally take a resync interval to catch drift nobody sent an event for.

## Tour of the built-in controllers

These all live in `kube-controller-manager` on the control plane. You can't see their logs — you see their *effects*: child objects and Events.

| Controller | Watches | Creates/manages | The loop in one line |
|---|---|---|---|
| Deployment | Deployments | ReplicaSets | "Is there a ReplicaSet matching the current pod template, scaled correctly, with old ones scaled down per rollout strategy?" |
| ReplicaSet | ReplicaSets | Pods | "Do `replicas` matching pods exist? Create or delete the difference." |
| StatefulSet | StatefulSets | Pods + PVCs | Same, but ordered, with stable names (`db-0`, `db-1`) and per-pod storage |
| Job | Jobs | Pods | "Have `completions` pods succeeded? If not (and under `backoffLimit`), run more." |
| EndpointSlice | Services + Pods | EndpointSlices | "Which ready pod IPs match this Service's selector right now?" — this is why unready pods drop out of load balancing |
| HPA | HPAs + metrics | scale subresource | "Is current metric over target? Adjust `replicas` on the target." |
| Garbage collector | everything | deletions | "Does this object's owner still exist? If not, delete it." |

Notice the chain: you never create a ReplicaSet or a rollout "process." You change one field on a Deployment, and three controllers cooperate to make it real. Details in [Deployments Deep Dive](/workloads/deployments-deep-dive/).

### ownerReferences: how the chain holds together

Every child object points at its parent:

```console
$ kubectl get pod web-7d4b9c8f6d-x2klp -o jsonpath='{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}'
ReplicaSet/web-7d4b9c8f6d
```

Two consequences you'll actually use:

1. **Cascading delete.** Delete the Deployment, the GC controller deletes its ReplicaSets, which cascades to Pods. `kubectl delete deploy web --cascade=orphan` breaks the chain and leaves children running — occasionally useful in an emergency, usually a footgun.
2. **Debugging lineage.** A pod with a weird name? Walk `ownerReferences` up until you find the object a human (or pipeline) actually created.

## spec vs. status

Every serious API object has both, and they have opposite owners:

- **`spec`** — desired state. Written by you (or your pipeline). Controllers read it, never write it.
- **`status`** — observed state. Written by controllers. You read it, never write it (writes to status via `kubectl apply` are ignored — it's a separate subresource).

```console
$ kubectl get deploy web -o jsonpath='{.metadata.generation} {.status.observedGeneration}'
7 7
```

`metadata.generation` increments on every spec change; `status.observedGeneration` records the last generation the controller processed. If they match, the controller has *seen* your change (whether or not it has finished acting on it — read `status.conditions` for that). If they don't match for more than a few seconds, the controller isn't running or is wedged: platform ticket territory.

## Finalizers, and the stuck-in-Terminating classic

A finalizer is a string in `metadata.finalizers` meaning "someone needs to do cleanup before this object can actually be deleted." Deletion with finalizers present just sets `deletionTimestamp`; the object hangs around until every finalizer is removed by whatever controller owns it.

Which produces the single most famous stuck state in Kubernetes:

```console
$ kubectl get pvc data-db-0
NAME        STATUS        VOLUME     CAPACITY   AGE
data-db-0   Terminating   pvc-9f31   20Gi       3d
```

```console
$ kubectl get pvc data-db-0 -o jsonpath='{.metadata.finalizers}'
["kubernetes.io/pvc-protection"]
```

The object isn't "broken" — a controller (here: PVC protection, waiting for a pod that still mounts the volume) hasn't signed off yet. The fix is almost always to find and resolve *what the finalizer is waiting for*, not to remove the finalizer.

:::danger[Don't strip finalizers to "unstick" things]
`kubectl patch ... -p '{"metadata":{"finalizers":null}}'` makes the object vanish immediately — and skips the cleanup the finalizer existed to guarantee. On a PVC that can orphan a real disk; on an operator CR it can leave external systems (databases, load balancer configs, cloud resources) permanently leaked. Do it only when you've confirmed the owning controller is gone for good, and preferably let the platform team make that call.
:::

The same mechanic explains namespaces stuck in `Terminating`: one resource inside still has a pending finalizer, and the namespace can't finish until it does.

## Why `kubectl delete pod` gets you a new pod

Now the punchline. You delete a pod; seconds later an identical one appears:

```console
$ kubectl delete pod web-7d4b9c8f6d-x2klp
pod "web-7d4b9c8f6d-x2klp" deleted
$ kubectl get pods -l app=web
NAME                   READY   STATUS    RESTARTS   AGE
web-7d4b9c8f6d-fq8zn   1/1     Running   0          4s
web-7d4b9c8f6d-jw2mp   1/1     Running   0          2d
web-7d4b9c8f6d-tr9vx   1/1     Running   0          2d
```

You didn't fight anything — the ReplicaSet controller observed 2 < 3 and acted. Deleting a pod is a perfectly legitimate operation *precisely because* of reconciliation: it's the standard way to get a fresh container without touching the spec (see [Restarts Without Redeploy](/operations/restarts-without-redeploy/)).

But the same loop bites you when you try to *change* things at the wrong level:

- `kubectl edit pod` to bump memory → reverted (or blocked); pods are owned by the ReplicaSet, which is owned by the Deployment. Edit the **Deployment**.
- `kubectl edit rs` to change the image → the Deployment controller stomps it on the next sync.
- Hand-edit a Deployment that your GitOps pipeline owns → your change lives until the next sync, then silently disappears. That's just reconciliation one level up — the pipeline is a controller too.

## When two controllers want different things

Reconciliation assumes one owner per field. Break that assumption and you get a tug-of-war — always with the same signature: a value that flips back and forth on its own.

The classic is **HPA vs. your pipeline**. The HPA controller writes `spec.replicas` on your Deployment; your GitOps repo also declares `replicas: 3`. Every pipeline sync scales you back to 3; every HPA evaluation scales you back up. The pods churn, and each side's logs look perfectly correct. The fix is ownership, not tuning: once an HPA targets a workload, *delete* `replicas` from the manifest in Git and let the HPA own that field (see [Autoscaling](/workloads/autoscaling/)).

Same shape, different actors:

- An operator and your Helm chart both templating the same ConfigMap.
- Two Deployments' pod selectors overlapping, so both ReplicaSets claim the same pods (guard rail: keep selectors unique and immutable).
- You and a mutating admission webhook both setting the same field — the webhook wins on every write, and your diff never converges.

When you see a field oscillating, don't ask "what's wrong with the value" — ask "who are the two writers," then remove one.

### Retries and backoff

A reconcile that fails doesn't give up; it requeues with exponential backoff. That's why a misconfigured object generates a steady drip of identical warning Events (visible in `kubectl describe`) rather than one error — and why, after you fix the cause, the recovery isn't always instant: the controller may be sitting out a backoff interval measured in minutes. If you've fixed the root cause and want to skip the wait, a no-op touch of the object (add an annotation) usually triggers an immediate re-reconcile.

## Working with the loop, not against it

The general rules, learned the hard way:

1. **Always edit the topmost object** a human/pipeline created. Changes to owned children are wasted keystrokes.
2. **Deleting owned objects is safe and useful; editing them is not.** Delete forces recreation from spec; edit creates drift that gets reverted at an unpredictable moment.
3. **Read `status` and Events before assuming a controller is ignoring you.** `kubectl describe` shows both. Most "the controller isn't doing anything" reports are actually "the controller is reporting exactly why it can't act, in a condition nobody read."
4. **If desired state is wrong, fix it at the source of truth** — which in a CI/CD shop is Git, not the cluster. The interaction between live edits and pipeline reconciliation is its own topic: [Drift and CI/CD](/operations/drift-and-cicd/).

:::tip[Reframe every incident]
"The system is in state X and should be in state Y — which controller owns that transition, and what is it reporting?" is a faster path to root cause than any amount of log spelunking. Usually the answer is sitting in `kubectl describe` output under `Conditions:` and `Events:`.
:::

Everything else in this section — [CRDs](/controllers/crds-explained/), [operators](/controllers/operators/), MetalLB, CIS, CSI — is this exact loop applied to new object types. Learn it once, recognize it everywhere.
