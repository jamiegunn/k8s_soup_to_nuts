---
title: "Stuck Terminating"
description: Symptom-first playbook for pods, PVCs, and namespaces that won't die — grace periods vs finalizers vs dead nodes, the force-delete decision table, and when to wake platform.
keywords:
  - pod stuck terminating
  - namespace won't delete
  - PVC stuck terminating
  - finalizers not removed
  - force delete pod grace-period 0
  - deletionTimestamp
  - terminationGracePeriodSeconds
  - node NotReady terminating
  - pvc-protection finalizer
  - ignoring SIGTERM exit 137
  - FailedKillPod
  - namespace terminating forever
  - shell form PID 1 signal
sidebar:
  order: 10
---

**Symptom:** `kubectl get pods` shows `Terminating`, and it showed `Terminating` five minutes ago, and it will show `Terminating` five minutes from now. Maybe it's blocking a rollout. Maybe it's a PVC that won't release, or a whole namespace your pipeline deleted twenty minutes ago that's still sitting there. Something in the cluster has been told to die and is refusing. It's 2am, and the internet's advice is a `--force` flag and a shrug.

Don't reach for the flag yet. `Terminating` is not an error state — it's a *contract in progress*, and the whole diagnosis is finding out which party hasn't signed. Force-deleting skips the signatures, and two of them exist specifically to protect your data.

## What Terminating actually means

When you (or a Deployment rollout, or a drain) delete a pod, the API server does **not** remove the object. It sets `metadata.deletionTimestamp` and starts a countdown. The pod object then lingers, visible as `Terminating`, until **two independent conditions** are both met:

1. **The kubelet confirms the processes are dead.** preStop hook, SIGTERM, grace period, SIGKILL if needed — the full sequence is [Graceful Shutdown](/workloads/graceful-shutdown/). Only when the containers are actually gone does the kubelet tell the API server "confirmed dead."
2. **`metadata.finalizers` is empty.** A finalizer is a string meaning "some controller must do cleanup before this object may vanish" — detach the volume, deregister from the mesh, release the external resource. Each finalizer is removed by the controller that owns it, when its cleanup is done. Deletion-with-finalizers just sets the timestamp and waits; the semantics live in [Reconciliation](/controllers/reconciliation/).

So "stuck Terminating" always decodes to exactly one of: *the countdown is still legitimately running*, *a finalizer's owner hasn't signed off*, or *the kubelet can't report* (because its node is gone). Every cause below is one of those three in costume — and the same mechanics govern stuck PVCs and stuck namespaces, which is why they're on this page too.

## The confirm step: how long is "stuck," actually?

`kubectl get pods` shows you the state but buries the two numbers that matter:

```console
$ kubectl -n myteam get pods
NAME                       READY   STATUS        RESTARTS   AGE
api-84c5d9f6b-x8vjd        1/1     Running       0          8m
api-7d4b9c6f8-2xkqp        1/1     Terminating   0          3d
```

`AGE 3d` is when the pod was *created*, not when deletion started — useless for this diagnosis. Get facts instead of vibes: how long has it actually been terminating, what grace period is it entitled to, and does it have finalizers:

```bash
kubectl -n myteam get pod api-7d4b9c6f8-2xkqp \
  -o jsonpath='deleted at: {.metadata.deletionTimestamp}{"\n"}grace: {.spec.terminationGracePeriodSeconds}s{"\n"}finalizers: {.metadata.finalizers}{"\n"}node: {.spec.nodeName}{"\n"}'
```

```console
deleted at: 2026-07-03T02:14:07Z
grace: 300s
finalizers: []
node: worker-07
```

Read it against the clock:

- **Elapsed < grace period** → not stuck. The pod is *allowed* to be terminating right now. A pod 90 seconds into a 300-second grace period is a pod draining, and interrupting it drops whatever it's draining. Go check *why* the grace is that long (cause 1), but don't touch it yet.
- **Elapsed > grace + ~30s, finalizers empty** → genuinely wedged. The kubelet should have SIGKILLed and reported by now. Suspect the node (cause 3) or a container runtime that can't kill the process (cause 4).
- **Finalizers non-empty** → the countdown may even be *over*; the object is waiting on a controller's signature (cause 2).

Two more ten-second reads. First, is the node even alive:

```bash
kubectl get node worker-07
```

Second, the termination timeline from [events](/observability/events/):

```bash
kubectl -n myteam get events --sort-by=.lastTimestamp | grep 2xkqp
```

```console
02:14:07   Normal    Killing            pod/api-7d4b9c6f8-2xkqp   Stopping container api
02:19:12   Warning   FailedKillPod      pod/api-7d4b9c6f8-2xkqp   error killing pod: ...
```

`Killing` marks when the kubelet started; a `FailedKillPod` after it means the runtime literally cannot kill the process — usually node trouble. `FailedPreStopHook` means your drain hook is broken and silently ate the grace budget. No events at all after `Killing`, for longer than the grace period, on a `Ready` node — that's the cause-4 signature. The wider tool belt for this kind of forensics is the [Debugging Toolbox](/troubleshooting/debugging-toolbox/).

## Cause 1: the grace period is just long — slow drain, or a broken one in hiding

The most common "stuck" pod isn't stuck at all: someone set `terminationGracePeriodSeconds: 600` and the pod uses all of it, every time, on every deploy.

**Confirm:** the jsonpath read above, plus the pod's own logs during termination. There are two very different stories that look identical from `kubectl get pods`:

**Story A — legitimately draining.** Logs show work finishing:

```console
02:14:07.201  INFO  Received SIGTERM, closing listener
02:14:07.204  INFO  Draining 214 in-flight requests...
02:15:31.887  INFO  Drain complete, closing pools
```

The long grace is doing its job. Your problem is impatience, not Kubernetes. Let it finish.

**Story B — the giant grace hiding a broken drain.** Logs go *silent* right after the `Killing` event:

```console
02:14:06.998  INFO  GET /api/orders 200 41ms      ← normal traffic
02:14:07.031  INFO  GET /api/orders 200 39ms
                                                   ← ...then nothing, for 600 seconds
```

The pod sits there doing *nothing* until the SIGKILL. This is the sneaky one — the app never got or never handled SIGTERM (see cause 4), and the huge grace period converts a 30-second bug into a 10-minute-per-pod rollout tax that everyone has learned to shrug at. The tell is in the exit code of the *previous* termination:

```bash
kubectl -n myteam describe pod api-84c5d9f6b-x8vjd | grep -A3 "Last State"
```

Exit code **137** (SIGKILL at the deadline) every single time = nobody is handling SIGTERM. A pod that drains correctly exits **0** before the deadline, every time.

**Fix:** for the legitimate case, decide whether a 10-minute synchronous drain should exist, and tune the budget deliberately — grace period, preStop, and rollout pacing are one coupled knob set, covered in [Rollout and Shutdown Knobs](/tuning/rollout-shutdown-knobs/). For the hidden-breakage case, fix the SIGTERM handling ([Graceful Shutdown](/workloads/graceful-shutdown/) has the per-stack wiring) and then *shrink the grace period* back to honest — a grace period is a promise about how long shutdown takes, not a superstition margin.

## Cause 2: finalizers — someone hasn't signed the death certificate

Grace period long over, containers long dead, object still there. Look at the metadata:

```bash
kubectl -n myteam get pod api-7d4b9c6f8-2xkqp -o yaml | grep -B1 -A4 finalizers:
```

```yaml
metadata:
  finalizers:
  - example.io/mesh-deregistration
```

The object cannot leave the API until every string in that list is removed by its owning controller — the API server doesn't know or care what the strings mean; it only enforces the wait. The diagnosis is always the same two questions: **who owns this finalizer, and what is it waiting for?** The worked PVC example — deleted claim, `Terminating` for hours, one `jsonpath` showing `kubernetes.io/pvc-protection` — is the canonical version:

```console
$ kubectl -n myteam get pvc data-reports -o jsonpath='{.metadata.finalizers}'
["kubernetes.io/pvc-protection"]
$ kubectl -n myteam get pods -o json | jq -r '.items[] | select(.spec.volumes[]?.persistentVolumeClaim.claimName=="data-reports") | .metadata.name'
reports-cron-29104821-x7zw2       ← a forgotten CronJob pod still mounts it
```

Delete (or let finish) the consuming pod and the PVC clears in seconds. The common owners:

| Finalizer | Owner | It's waiting for |
|---|---|---|
| `kubernetes.io/pvc-protection` (on PVCs) | PVC protection controller | **Every pod using the PVC to be gone.** The classic stuck-PVC: you deleted the claim while a pod still mounts it — delete the pod, the PVC follows within seconds. Full walkthrough in [Volume Failures](/troubleshooting/volume-failures/) |
| `kubernetes.io/pv-protection` (on PVs) | PV protection controller | The bound PVC to be deleted first |
| `external-attacher/...`, CSI driver names | The storage driver | The volume to actually detach from the node — slow or stuck when the node is unhealthy |
| Mesh/operator-specific (`istio-finalizer...`, vendor [CRD](/controllers/crds-explained/) finalizers) | That operator's controller | Its cleanup loop to run — stuck forever if the operator was uninstalled while its objects still existed |

**Fix:** resolve *what the finalizer is waiting for* — delete the consuming pod, fix the unhealthy operator, let the detach finish. The finalizer then disappears on its own, usually within one reconcile loop.

:::danger[Patching the finalizer off: measure twice]
`kubectl patch ... -p '{"metadata":{"finalizers":null}}'` makes the object vanish instantly — *and skips the cleanup the finalizer existed to guarantee.* On a PVC that can destroy a volume a running pod is still writing to; on an operator's CR it can leak the external thing it managed (a database, an LB config) permanently, with no object left pointing at it. There is exactly one situation where patching is the right call: **the owning controller is confirmed gone forever** (operator uninstalled, CRD orphaned) so the signature can never arrive. "It's been stuck for a while and I'm tired" is not that situation. When in doubt, it's a [platform team](/operations/working-with-platform-team/) decision — they can see whether the controller is dead or just slow.
:::

## Cause 3: the node is unreachable — nobody left to confirm the death

Condition 1 of the contract — *kubelet confirms the processes are dead* — requires a kubelet. If the node is `NotReady`, powered off, or partitioned, that confirmation can never arrive, and the pod shows `Terminating` **forever**: past the grace period, past the heat death of your patience, until the node comes back or someone force-deletes.

**Confirm:**

```bash
kubectl get node worker-07
```

```console
NAME        STATUS     ROLES    AGE    VERSION
worker-07   NotReady   <none>   212d   v1.31.4
```

`NotReady` — and if every stuck-Terminating pod in your namespace shares that `NODE` column, the diagnosis is complete. Pods on a dead node get marked and eventually replaced by their controllers, but the *old pod objects* linger in `Terminating` because nothing can vouch for the processes being dead. And that phrasing is precise: **the process may genuinely still be running** on the partitioned node — serving traffic, writing to disks — with the control plane simply unable to see it. Everything about diagnosing the node itself is [Node Problems](/troubleshooting/node-problems/).

**Fix:** if the node recovers, the kubelet reports and the pod clears on its own. If the node is confirmed dead-dead (platform says it's deprovisioned, powered off, never coming back), force-delete is legitimate — this is the case the flag was built for. But check the decision table below first, because "confirmed dead" is doing heavy lifting in that sentence, and for a StatefulSet pod with an RWO volume the stakes are a **Multi-Attach error at best, split-brain at worst**: force-deleting tells the API "this identity is free" while a partitioned node may still be running the old instance against the same disk.

## Cause 4: something in the pod is ignoring SIGTERM

Grace period running, node healthy, but the logs show no shutdown activity — and every termination ends in SIGKILL at the deadline (exit 137). The signal is being sent; nobody's listening.

**The shell-form PID 1 classic.** This Dockerfile line is the single most common root cause:

```dockerfile
CMD java -jar app.jar          # shell form: PID 1 is /bin/sh, not java
```

Shell form wraps your command in `sh -c`, making `sh` PID 1. SIGTERM goes to PID 1; `sh` doesn't forward signals to its children; your app never hears a thing and sits there until the SIGKILL. Confirm in five seconds:

```bash
kubectl -n myteam exec api-7d4b9c6f8-2xkqp -- cat /proc/1/comm
```

```console
sh          ← should say "java". That's the whole bug.
```

Fix: exec-form CMD (`CMD ["java", "-jar", "app.jar"]`), or `exec java ...` as the last line of the wrapper script so the app *replaces* the shell as PID 1. [Graceful Shutdown](/workloads/graceful-shutdown/) covers the PID 1 signal reality per stack.

**Sidecar ordering.** A multi-container pod terminates when *all* containers stop — so a sidecar with no SIGTERM handling holds the pod at `Terminating` for the full grace period even after your app exited in two seconds. Find which container is still alive:

```bash
kubectl -n myteam get pod api-7d4b9c6f8-2xkqp \
  -o jsonpath='{range .status.containerStatuses[*]}{.name}: {.state}{"\n"}{end}'
```

```console
api: {"terminated":{"exitCode":0,...}}       ← your app drained and exited cleanly
log-shipper: {"running":{...}}               ← the sidecar is the holdout
```

Native sidecars (restartable init containers, `restartPolicy: Always`) fix the worst of this by design: they're terminated *after* the main container exits, in reverse start order, so the app drains with its proxy still alive and the sidecars die last. The mechanics are [Init and Sidecar Containers](/workloads/init-and-sidecar-containers/) and the full ordering contract is [Sidecar Lifecycle and Ordering](/sidecars/lifecycle-and-ordering/). Old-style sidecar containers get SIGTERM *simultaneously* with your app — which is both how "the proxy died before the app finished draining" becomes its own incident, and how a signal-deaf sidecar becomes yours.

## Cause 5: the namespace that won't die

Your pipeline deleted the ephemeral namespace and it's been `Terminating` for an hour. Same contract, bigger blast radius: **a namespace cannot finish deleting until every object inside it is gone** — so one stuck finalizer on one CR inside holds the entire namespace hostage. There are two failure modes, and the namespace's own status tells you which:

```bash
kubectl get namespace ci-run-4187 \
  -o jsonpath='{range .status.conditions[*]}{.type}: {.message}{"\n"}{end}'
```

```console
NamespaceDeletionDiscoveryFailure: Discovery failed for some groups, 1 failing:
  unable to retrieve the complete list of server APIs: metrics.example.io/v1beta1:
  the server is currently unable to handle the request
NamespaceContentRemaining: Some resources are remaining: widgets.example.io has 2 resource instances
NamespaceFinalizersRemaining: Some content in the namespace has finalizers remaining:
  example.io/widget-cleanup in 2 resource instances
```

Read them as a decision, top to bottom:

- **`NamespaceDeletionDiscoveryFailure`** — the deletion controller must ask *every* registered API group "do you have objects in this namespace?" before it can declare the namespace empty. If an **aggregated API server** is unreachable — a metrics adapter that's down, or an uninstalled operator's leftover `APIService` registration pointing at a Service that no longer exists — that question can never be answered, and *every* namespace deletion in the cluster wedges. Yours is just the one you noticed. Confirm the dead registration:

  ```bash
  kubectl get apiservices | grep False
  ```

  ```console
  v1beta1.metrics.example.io   ci-tools/metrics-adapter   False (ServiceNotFound)   211d
  ```

  Cluster-scoped, and not yours to fix — this goes straight into an escalation.

- **`NamespaceContentRemaining` / `NamespaceFinalizersRemaining`** — better news: the message *names the resources still inside*. Go look at them (`kubectl get widgets.example.io -n ci-run-4187 -o yaml`): it's almost always a CR whose operator is gone — cause 2's patch-decision applies, per-resource, with the same data-loss caveats — or a PVC sitting in protection. Fix the inner object; the namespace follows on the next reconcile.

:::caution[About the internet's favorite fix]
Every search result for "namespace stuck terminating" offers the same move: strip `spec.finalizers` via a raw call to the `/finalize` subresource. Understand what that does — it tells Kubernetes "stop verifying this namespace is empty" and the namespace vanishes *around* whatever is still in it: orphaned CRs invisible to `kubectl`, leaked external resources, an aggregated-API problem left in place to wedge the *next* namespace. In a shared corporate cluster this is a platform-team call, full stop — they can fix the actual cause (the dead `APIService`) instead of amputating the symptom. Bring them the two condition messages above and you've done your half; the escalation etiquette is [Working with the Platform Team](/operations/working-with-platform-team/).
:::

## The force-delete decision table

```bash
kubectl -n myteam delete pod api-7d4b9c6f8-2xkqp --grace-period=0 --force
```

Know exactly what this does before typing it: it **removes the pod object from the API without waiting for confirmation that the process died.** No preStop, no SIGTERM window, no kubelet ack. If the node is reachable, the kubelet SIGKILLs in the background; if it isn't, *the process may keep running* with the cluster now blind to it. Force-delete answers "is the object gone?" — it says nothing about the workload.

| Situation | Force-delete? | Why |
|---|---|---|
| Stateless Deployment pod, node confirmed gone | **Yes** | Nothing to lose; replacement is already running; you're just cleaning up a ghost object |
| Stateless pod, node healthy, just slow to terminate | **No — fix the cause** | It'll clear on its own; forcing just hides the drain bug (cause 1/4) that will bite the next rollout |
| StatefulSet pod, node unreachable | **Only after platform confirms the node is dead** | The API frees the identity (`api-0`) and the replacement mounts the volume — if the old instance still runs, two pods own one identity: **Multi-Attach errors** on RWO volumes if you're lucky, split-brain writes if you're not |
| Any pod holding an RWO PVC, node state unknown | **No** | Same Multi-Attach story without the identity part; wait for node verdict or platform detach |
| Object stuck on a **finalizer** | **Force-delete does nothing** | `--force` doesn't touch finalizers — the object stays. This flag is not the finalizer fix; cause 2 is |
| Namespace | **Not yours to force** | See cause 5 — platform call |

One more honesty note: after a force-delete of a StatefulSet pod, watch the replacement's events for `Multi-Attach error for volume` — if it appears, the old node hasn't released the disk and you're in [Volume Failures](/troubleshooting/volume-failures/) territory, with the detach timeline in platform's hands.

## Prevention

- **Set drain-time budgets on purpose.** `terminationGracePeriodSeconds` should be *measured drain time + margin*, not a folk number. If drain takes 20s, grace of 45s is honest; grace of 600s is a rollout tax and a bug-hider. The coupled knobs are in [Rollout and Shutdown Knobs](/tuning/rollout-shutdown-knobs/).
- **Prove your SIGTERM handling once**, in a lab: `kubectl delete pod` a canary and check it exits **0** before the deadline, not 137 at it. The exit code is the whole test.
- **Finalizer hygiene:** before uninstalling any operator, delete its CRs *first* and let it clean up — an operator removed while its objects still exist is the #1 factory for permanently-stuck resources. Audit with `kubectl get <crd> -A` before the uninstall.
- **Don't delete PVCs while pods still mount them** — that's the pvc-protection wait, by design. Pod first, claim second.
- **Alert on the termination [events](/observability/events/) that predict wedging:** `FailedKillPod` (runtime can't kill — node trouble brewing), `FailedPreStopHook` (your drain hook is broken and eating the grace budget), and any pod with `deletionTimestamp` older than `2 × grace` — that last one is exactly this page's confirm step, automated.
- **Keep a "known finalizers" note in your runbook** — the table above plus whatever your operators add. At 2am, "I know who owns this string" is the difference between a fix and a gamble.

## Which page next

| You're seeing | Go to |
|---|---|
| The pod terminates fine but deploys drop requests | [Graceful Shutdown](/workloads/graceful-shutdown/) — the endpoint-propagation race |
| Terminating pods only on one node | [Node Problems](/troubleshooting/node-problems/) |
| PVC or volume stuck, Multi-Attach errors | [Volume Failures](/troubleshooting/volume-failures/) |
| You want the finalizer/ownership mental model | [Reconciliation](/controllers/reconciliation/) |
| You need to escalate the namespace or a dead APIService | [Working with the Platform Team](/operations/working-with-platform-team/) |

`Terminating` is Kubernetes refusing to lie to you: it won't report something dead until it's dead, and it won't skip cleanup someone declared mandatory. The fix is almost never to overrule that honesty — it's to find which signature is missing and go get it.
