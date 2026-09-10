---
title: "When Nobody Asked: Node Shutdown, Pressure, Taints, Preemption"
description: The disruptions that never consult your PDB — kubelet graceful node shutdown, node-pressure eviction, NoExecute taints, node death, preemption, hypervisor events — what each does to your pod, what you can see afterward, and which of your settings still matter. Plus the Job podFailurePolicy that stops drains from burning retries.
keywords:
  - pod was terminated in response to imminent node shutdown
  - pod status terminated reason node shutdown
  - terminationbykubelet disruptiontarget
  - shutdowngraceperiod kubelet what happens to my pod
  - job failed backofflimitexceeded during node drain
  - podfailurepolicy disruptiontarget ignore
  - which disruptions ignore pod disruption budget
  - node pressure eviction vs drain
  - pods deleted after node notready 5 minutes
sidebar:
  order: 8
---

You are here if: pods died and no drain was announced; or a pod shows `Terminated` with a message about node shutdown; or your nightly Job failed with `BackoffLimitExceeded` on the night the platform patched kernels; or you want the complete list of things a PDB does nothing about.

Everything before this page assumed someone asked. This page is the list of things that don't — what each one does to your pod, what you can see afterward, and which of your settings still matter when the budget doesn't. It serves the section's first question from the other side: *who decides* when the answer is "nobody you can negotiate with."

The pod's death is, as everywhere in this section, [Graceful Shutdown's](/workloads/graceful-shutdown/) — with one twist that's genuinely new here: some of these disruptions run your shutdown code against a *shorter clock than the one you configured*.

## The ask-wait-come-back matrix

Every disruption on the cluster answers three questions: does it **ask** (consult the PDB)? does it **wait** (honor your grace period — and whose number caps it)? and does the pod **come back** (who recreates it, and does the replacement have somewhere to go)? The full matrix, one row per source. The `DisruptionTarget` column is what you read off the pod to tell them apart ([the decoder](/disruption/anatomy-of-a-drain/#the-decoder-who-killed-my-pod)).

| Source | Asks the PDB? | Waits for your drain? | Comes back via | What you see | Your lever |
|---|---|---|---|---|---|
| **Node drain** (platform) | **Yes** | Yes — your `G`, unless `--grace-period` caps it | ReplicaSet/StatefulSet, on another node | `EvictionByEvictionAPI`; `Killing` event | PDB shape; [landing](/disruption/where-pods-land/) |
| **Descheduler, VPA updater** (platform tools) | **Yes** | Yes | Controller | `EvictionByEvictionAPI` | PDB shape |
| **Rollout** (you) | No — its own `maxUnavailable` | Yes | The new ReplicaSet | no condition | [Rollout knobs](/tuning/rollout-shutdown-knobs/) |
| **`kubectl delete pod`** (you) | No | Yes | Controller | no condition | Don't |
| **HPA / KEDA scale-in** | No | Yes | Nobody — that was the point | no condition | `behavior.scaleDown`; [termination choreography](/architectures/zero-downtime/#hpa--the-scale-down-note) |
| **Kubelet graceful node shutdown** | No | Yes, **capped by the kubelet's shutdown window** | Controller, on another node — the node is going away | pod `Failed`, `reason: Terminated`, "Pod was terminated in response to imminent node shutdown"; `TerminationByKubelet` | `D` sized to fit their window; replicas + spread |
| **Node-pressure eviction** (kubelet) | No | **No** for hard thresholds; capped by `evictionMaxPodGracePeriod` for soft ones | Controller | pod `Failed`, `reason: Evicted`; `TerminationByKubelet` | Requests, limits, ephemeral-storage, QoS — [Node Problems](/troubleshooting/node-problems/#node-conditions-and-eviction--why-your-pod-got-killed) |
| **`NoExecute` taint** (node NotReady/unreachable) | No | Yes | Controller | `DeletionByTaintManager`, after `tolerationSeconds` (default 300 s) | `tolerationSeconds`; never blanket-tolerate — [Node Problems](/troubleshooting/node-problems/#taints-appearing-on-nodes) |
| **Node death / partition** | No | Nothing to wait for | Controller — Deployments after the taint fires; StatefulSets only after the platform declares the node out of service | pods `Unknown` then stuck `Terminating`; later `DeletionByPodGC` | Replicas + spread; [Stuck Terminating](/troubleshooting/stuck-terminating/#cause-3-the-node-is-unreachable--nobody-left-to-confirm-the-death) |
| **Scheduler preemption** | Best effort | Yes | Controller, wherever it fits | `PreemptionByScheduler` | Honest `priorityClassName`; spread |
| **Hypervisor-level events** (VM stun, host maintenance) | No | No — Kubernetes never learns it happened | The pod never died; it *paused* | Probe failures, a clock jump, a keepalive reset; no condition, no event | Probe thresholds that tolerate a few seconds; [Time](/foundations/time/) |

Read the matrix once as a whole: only the first two rows read your PDB. Most rows honor your grace period on your terms (the drain too, unless `--grace-period` caps it); node shutdown caps it with a number you don't own; node pressure ignores it for hard thresholds and caps it for soft ones; node death and hypervisor stuns never wait for anything. And in every row but scale-in, *something* recreates the pod — which is why the second half of this section, [where it lands](/disruption/where-pods-land/), matters for involuntary disruptions exactly as much as for drains.

## Kubelet graceful node shutdown

When a node is shut down or rebooted *through the OS* — a `systemctl reboot` after a kernel patch, a hypervisor-initiated guest shutdown — the kubelet can hold the shutdown open long enough to terminate your pods gracefully. It does this with a systemd inhibitor lock, and it does it **without the Eviction API**: no PDB check, no 429, no retry. The pods on that node are all terminated, in priority order, inside a window the platform configures. (Beta since 1.21 and on by default on systemd nodes — but *inert* until configured: both window settings below default to `0`, which means no graceful window at all. A platform that never set them gives your pods no grace on a reboot, and "our pods just died with no grace" has a boring answer. The kubelet also needs the systemd inhibitor lock, and the docs carry a caution that Debian's `unattended-upgrades` package in its default configuration takes that lock first — both PLATFORM notes, and the first thing to ask.)

The two kubelet settings, and the worked example from the docs:

```text
shutdownGracePeriod: 30s              # total time the node delays shutdown for pods
shutdownGracePeriodCriticalPods: 10s  # reserved at the END for system-critical pods
                                      # → your pods get the first 20 seconds, no matter what G says
```

So your `terminationGracePeriodSeconds: 40` is aspirational on a node shutting down with that config. The [budget inequality](/workloads/graceful-shutdown/#the-budget-inequality) gains a term you don't own:

```text
min( G , the kubelet's window for your priority tier )  >  S + D + margin
```

With a priority-based configuration (also beta, on by default), the window is per tier — the docs' example gives `100000 → 10 s, 10000 → 180 s, 1000 → 120 s, 0 → 60 s` — which is the first place `priorityClassName` buys you *time* rather than placement. Either way, the number is a PLATFORM fact, and [the contract page](/disruption/platform-contract/#what-to-ask) asks for it.

What you see afterward. The pod isn't deleted — it's marked failed, with a message written for exactly this moment:

```bash
# seat: tenant
kubectl get pods -n payments
```

```console
NAME                               READY   STATUS       RESTARTS   AGE
payments-api-7c9d4f6b8-k2xvn       0/1     Terminated   0          3d
payments-api-7c9d4f6b8-x2m9q       1/1     Running      0          71s
```

```bash
# seat: tenant
kubectl get pod payments-api-7c9d4f6b8-k2xvn -n payments -o jsonpath='{.status.phase}{"  "}{.status.reason}{"  "}{.status.message}{"\n"}{.status.conditions[?(@.type=="DisruptionTarget")].reason}{"\n"}'
```

```console
Failed  Terminated  Pod was terminated in response to imminent node shutdown.
TerminationByKubelet
```

The ReplicaSet has already created the replacement (`x2m9q`, 71 s old — the node rebooted about a minute ago); the `Failed` pod lingers as evidence until garbage collection removes it. **Define → observe → decide:** `reason: Terminated` with that message → the node was rebooted through the OS, not drained → check whether your drain finished inside *their* window: `lastState` isn't available on a Failed pod, so look at the container's `exitCode` in `.status.containerStatuses[0].state.terminated` — `0` means your shutdown fit; `137` means the window was shorter than `S + D`, and the fix is a shorter `D` or a longer window, negotiated.

## Node-pressure eviction

The kubelet's own defense of its node: when memory, disk, or PIDs cross a threshold, it evicts pods — by QoS class, lowest first — with **no PDB check and, for hard thresholds, no grace at all**. Soft thresholds get a grace capped by the kubelet's `evictionMaxPodGracePeriod`, again a number you don't own. The pod ends `Failed` with `reason: Evicted` and a message naming the resource; the ReplicaSet replaces it. Everything about avoiding this is on your side of the boundary — requests you actually measured, a memory limit, an ephemeral-storage request for anything that writes to disk — and it's already written: [Node Problems](/troubleshooting/node-problems/#node-conditions-and-eviction--why-your-pod-got-killed) and [Resources & QoS](/workloads/resources-and-qos/). The one thing this page adds: a node under pressure *during a window* is a node whose survivors are fuller than the ledger says, and [the N-1 check](/disruption/where-pods-land/#the-n-1-check) just failed for everyone.

## NoExecute taints

When a node goes `NotReady` or `Unreachable`, the node lifecycle controller taints it `node.kubernetes.io/not-ready:NoExecute` or `unreachable:NoExecute`. Every pod carries a default toleration of those taints for **300 seconds** — which is the answer to "why did my pods sit on a dead node for exactly five minutes." After that, the taint manager deletes them (`DeletionByTaintManager`), your grace period is honored (against a node that may not be listening), and the controller recreates them elsewhere. You can shorten the wait per workload with an explicit `tolerationSeconds`; you must never blanket-tolerate health taints, which keeps your pods *on* dying nodes. The mechanics and the YAML are in [Node Problems](/troubleshooting/node-problems/#taints-appearing-on-nodes); the taint model itself is in [Scheduling](/workloads/scheduling/#taints-and-tolerations-repel-dont-attract).

## Node death and partitions

A node that stops talking to the API server — kernel panic, power, a switch — takes its pods into `Unknown`. Deployments recover through the taint above: 300 s later the pods are deleted and recreated elsewhere. StatefulSets don't: the at-most-one guarantee means the controller will not create `valkey-primary-0` again until it's *sure* the old one is dead, and a partitioned node can't confirm it. The pod sits `Terminating` until a human with cluster-admin either brings the node back, deletes the Node object, or taints it `node.kubernetes.io/out-of-service` — the platform's declaration that the node is gone, which force-deletes the pods and detaches their volumes so the StatefulSet can proceed. That's [Stuck Terminating, cause 3](/troubleshooting/stuck-terminating/#cause-3-the-node-is-unreachable--nobody-left-to-confirm-the-death), and the cleanup afterward shows up as `DeletionByPodGC`. Your only lever is the usual one: replicas, spread across nodes (and zones, if the cluster has them), and for quorum workloads a member count that survives one silent node — [the stateful page](/disruption/stateful-and-quorum/).

## Preemption

The scheduler may remove your pod to make room for a higher-priority one. It prefers victims whose PDBs allow it, but only as a preference: if the only way to place the incoming pod is through your budget, it goes through your budget. The pod gets `PreemptionByScheduler`, your grace period is honored, your controller recreates it wherever there's room — which, during a maintenance window, may be nowhere ([where it lands](/disruption/where-pods-land/#5-preemption-your-pods-as-the-victims)). The lever is honesty about `priorityClassName`, in both directions.

## The disruptions that leave no trace

A hypervisor can pause a VM — a vMotion stun, a host under memory pressure, a snapshot — for seconds, and Kubernetes never learns it happened. Nothing is deleted; nothing is evicted; there is no condition, no event, no exit code. What you see is downstream: a liveness probe that timed out once, a keepalive that reset, a clock that jumped and made a token expire early ([Time](/foundations/time/)). The defenses are the ones you already have for a flaky network — probe thresholds that tolerate a couple of seconds ([Health Check Knobs](/tuning/health-check-knobs/)), clients that reconnect ([Long-Lived Connections](/networking/long-lived-connections/)). The platform team's host-maintenance calendar is the only warning you'll get; [ask for it](/disruption/platform-contract/#what-to-ask).

## What still protects you when nothing asks

Strip out the PDB and this is what's left — and it's most of what matters:

- **Replicas and spread** are the only defense against a node's death. Two replicas on one node is one replica ([High Availability](/workloads/high-availability/)).
- **Honest readiness** so the replacement takes traffic exactly when it can; **fast startup** so the gap is short — `R` is the number every involuntary disruption charges you.
- **State outside the node**: PVCs on storage that follows the pod, sessions in Valkey, queues in the broker — anything on node-local disk dies with the node.
- **Shutdown code that fits the shortest clock you'll be given**: `min(G, their window) > S + D + margin`. Node shutdown does honor your SIGTERM handler; it just doesn't honor your `G`.
- **Idempotent, checkpointed work** for anything that's mid-flight when the node goes — which brings us to Jobs.

## Jobs: stop burning retries on drains

A Job's pod evicted by a drain, or terminated by a node shutdown, fails — and by default that failure counts against `backoffLimit` exactly as if your code had crashed. A drain that touches three nodes in a night can exhaust a `backoffLimit: 2` without your code ever misbehaving. The fix uses the `DisruptionTarget` condition directly: a `podFailurePolicy` that *ignores* failures caused by disruption (stable since 1.31, alongside the condition).

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: payments-recon-20260910
  namespace: payments
spec:
  backoffLimit: 2                     # retries for REAL failures — bugs, bad data
  podFailurePolicy:
    rules:
      - action: Ignore                # this failure doesn't count against backoffLimit;
        onPodConditions:              # the Job just runs a fresh pod
          - type: DisruptionTarget    # set by eviction, preemption, taint deletion, kubelet termination
  template:
    spec:
      restartPolicy: Never            # required for podFailurePolicy to apply
      terminationGracePeriodSeconds: 60   # checkpoint-and-exit time, measured
      containers:
        - name: recon
          image: registry.internal/payments/recon:2.4.1
          # on SIGTERM: persist progress, exit non-zero; the retry resumes from the checkpoint
```

Prove it the way the lab does — two Jobs, one with the rule and one without, evict both:

```bash
# seat: tenant — needs create on pods/eviction
kubectl create --raw /api/v1/namespaces/payments/pods/payments-recon-20260910-29p5p/eviction -f eviction.json
kubectl create --raw /api/v1/namespaces/payments/pods/payments-recon-legacy-jbdm6/eviction -f eviction.json
```

```console
{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Success","code":201}
{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Success","code":201}
```

```bash
# seat: tenant
kubectl get jobs -n payments
```

```console
NAME                       STATUS    COMPLETIONS   DURATION   AGE
payments-recon-20260910    Running   0/1           25s        25s
payments-recon-legacy      Failed    0/1           25s        25s
```

The Job with the rule is `Running` on a fresh pod with `.status.failed` still empty; the one without is `Failed` with `reason: BackoffLimitExceeded` — it had `backoffLimit: 0`, and the eviction spent it. Pair the policy with the *other* half of Job resilience, which is the pod's: on SIGTERM, checkpoint and exit so the retry resumes instead of restarting from zero ([Graceful Shutdown § Jobs](/workloads/graceful-shutdown/#shutdown--everything-else), [Jobs and CronJobs](/workloads/jobs-and-cronjobs/)). A six-hour batch with neither is six hours of compute converted to heat on every patch night.

:::note[Jobs don't get PDBs]
A PDB on Job pods is legal but pointless: a Job that must finish tonight either finishes before the window or survives eviction through the policy above. Blocking a drain so your batch can run is [the citizenship contract](/disruption/overview/#the-citizenship-contract) violated for the least defensible reason. Schedule around the calendar instead — [the contract page](/disruption/platform-contract/) is where you get it.
:::

## Who owns what

| Concern | PLATFORM team | YOU |
|---|---|---|
| kubelet `shutdownGracePeriod` / critical-pods reserve / per-priority windows | ✔ | ask; fit `D` inside |
| Node-pressure thresholds and `evictionMaxPodGracePeriod` | ✔ | requests, limits, ephemeral-storage |
| Health-taint policy; the out-of-service declaration for dead nodes | ✔ | `tolerationSeconds`; never blanket-tolerate |
| PriorityClass tiers and what they mean | ✔ defines | use honestly |
| Host-maintenance calendar (hypervisor) | ✔ | ask; probe thresholds that survive a stun |
| Replicas, spread, state outside the node | | ✔ |
| Shutdown that fits the shortest clock | | ✔ |
| `podFailurePolicy` + checkpointing on every Job | | ✔ |

## Where next

- **Next in the journey:** [The Maintenance Contract With Your Platform Team](/disruption/platform-contract/) — every number in the matrix you don't own has a question on that page, pre-written.
- **The lateral jump:** if a pod is stuck `Terminating` right now, leave the section: [Stuck Terminating](/troubleshooting/stuck-terminating/) is the runbook.
