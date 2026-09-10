---
title: Disruption on One Page (+ FAQ)
description: The section condensed — which disruptions ask your PDB, the shape decision table, the arithmetic, the status-field glossary, the who-killed-my-pod decoder, the top PromQL, the window runbook in six lines, the cast's budgets — plus the FAQ in the words people actually search.
keywords:
  - why is allowed disruptions 0
  - minavailable or maxunavailable
  - does a pdb protect against kubectl delete
  - can i have a pdb with one replica
  - what is unhealthypodevictionpolicy
  - why did my pod die at 3am
  - how do i find out who killed my pod
  - can i test a drain without node access
  - do i need a pdb for a cronjob
  - do pdbs work on statefulsets
  - pdb cheat sheet
sidebar:
  order: 10
---

Every table in the section, compressed. Each cell links to the page that earns it; the bottom half is the FAQ.

## Who asks, who waits, who brings it back

| Source | Asks the PDB? | Waits for your drain? | Pod comes back via | `DisruptionTarget` reason | Page |
|---|---|---|---|---|---|
| Node drain, descheduler, VPA updater | **Yes** | Yes (unless `--grace-period` caps it) | Controller, another node | `EvictionByEvictionAPI` | [Anatomy](/disruption/anatomy-of-a-drain/) |
| Rollout | No | Yes | New ReplicaSet | *(none)* | [Knobs](/tuning/rollout-shutdown-knobs/) |
| `kubectl delete pod` | No | Yes | Controller | *(none)* | — |
| HPA / KEDA scale-in | No | Yes | Nobody | *(none)* | [Scale-down note](/architectures/zero-downtime/#hpa--the-scale-down-note) |
| kubelet graceful node shutdown | No | Yes, **capped by their window** | Controller | `TerminationByKubelet` | [Involuntary](/disruption/involuntary-disruptions/#kubelet-graceful-node-shutdown) |
| Node-pressure eviction | No | No (hard) / capped (soft) | Controller | `TerminationByKubelet` | [Node Problems](/troubleshooting/node-problems/) |
| `NoExecute` taint (NotReady 300 s) | No | Yes | Controller | `DeletionByTaintManager` | [Node Problems](/troubleshooting/node-problems/#taints-appearing-on-nodes) |
| Node death | No | — | Controller (STS: after out-of-service) | `DeletionByPodGC` | [Stuck Terminating](/troubleshooting/stuck-terminating/) |
| Scheduler preemption | Best effort | Yes | Controller | `PreemptionByScheduler` | [Involuntary](/disruption/involuntary-disruptions/#preemption) |
| Hypervisor stun | No | No — never noticed | Never died | *(none)* | [Involuntary](/disruption/involuntary-disruptions/#the-disruptions-that-leave-no-trace) |

## Which shape

| Workload | Shape | Policy | Why |
|---|---|---|---|
| Deployment under an HPA | `maxUnavailable: 1` (integer) | `AlwaysAllow` | Holds at the floor *and* the ceiling; a `minAvailable` floor equal to `minReplicas` permits 0 at 3 a.m. |
| Deployment, fixed count | `maxUnavailable: 1` | `AlwaysAllow` | `minAvailable: N−1` is equivalent today and wrong after the next scale |
| Quorum set (≥ 3 members) | `maxUnavailable: 1` | `IfHealthyBudget` (default) | One member at a time; a not-Ready member is probably mid-resync |
| Primary/replica roles | one PDB *spanning* the set to serialize it; per-role PDBs only as honest singletons | per role | Per-role budgets are spent independently — two singletons can be evicted at once |
| Bare pods (no controller) | integer `minAvailable` only | — | The only shape whose status computes |
| Singleton that can't be two | `maxUnavailable: 1` | `AlwaysAllow` (required) | Documents the outage instead of blocking maintenance; without the policy a crashlooping singleton still blocks |
| Jobs / CronJobs | **no PDB** | — | `podFailurePolicy` on `DisruptionTarget` instead |
| Operator-managed (Strimzi, CNPG) | **don't write one** | — | Two PDBs on a pod = HTTP 500 on every eviction |

Full reasoning: [the two shapes](/disruption/pod-disruption-budgets/#the-two-shapes), [the decision tree](/disruption/pod-disruption-budgets/#which-shape), [stateful](/disruption/stateful-and-quorum/).

## The arithmetic

```text
expectedPods       = Σ controller .spec.replicas behind the selector   (follows the HPA)
desiredHealthy     = minAvailable | ceil(minAvailable% × expected)          ← rounds UP, against you
                   = expected − maxUnavailable | expected − ceil(maxUnavailable% × expected)   ← rounds UP, for you
currentHealthy     = selected pods that are Ready and not Terminating
disruptionsAllowed = max(0, currentHealthy − desiredHealthy)      ← the only number the Eviction API reads
```

| | at 2 replicas | at 4 | at 16 |
|---|---|---|---|
| `minAvailable: 2` | **0** | 2 | 14 |
| `minAvailable: 80%` | **0** | **0** | 3 |
| `maxUnavailable: 1` | 1 | 1 | 1 |
| `maxUnavailable: 25%` | 1 | 1 | **4 at once** |

Pending, Succeeded, Failed, and already-Terminating pods are evicted without a budget check. Granted evictions are held in `disruptedPods` for up to two minutes so a burst can't double-spend. [The arithmetic](/disruption/pod-disruption-budgets/#the-arithmetic).

## Status-field glossary

| Field | Plain meaning | If it surprises you |
|---|---|---|
| `expectedPods` | The controller's desired count, via the scale subresource | `0` → the selector matches nothing |
| `desiredHealthy` | What the shape requires at this count | Recomputed whenever the HPA moves |
| `currentHealthy` | Ready pods, excluding Terminating ones | A Pending replacement isn't here yet |
| `disruptionsAllowed` | `currentHealthy − desiredHealthy`, floored at 0 — `ALLOWED DISRUPTIONS` | `0` with all pods Ready → fix the shape; `0` with pods down → fix the pods |
| `disruptedPods` | Granted-but-not-yet-observed evictions, ≤ 2 min | Usually empty when you look |
| `conditions[DisruptionAllowed]` | `SufficientPods` / `InsufficientPods` / `SyncFailed` | `SyncFailed` → selector spans mixed or missing controllers |

[Field by field](/disruption/pod-disruption-budgets/#the-status-block-field-by-field).

## The three answers of the Eviction API

| Code | Text | Meaning | Drain does |
|---|---|---|---|
| `201` | `{"status":"Success","code":201}` | Granted — deletionTimestamp set, `DisruptionTarget` stamped | Waits for the pod to be gone (your `G`) |
| `429` | `Cannot evict pod as it would violate the pod's disruption budget.` — cause: `The disruption budget X needs N healthy pods and has M currently` | Budget is 0 right now | Retries every 5 s until the tool's timeout |
| `500` | `This pod has more than one PodDisruptionBudget, which the eviction subresource does not support.` | Overlapping selectors | Fails that pod immediately (kubectl only retries 429s); the platform's next pass fails the same way |

[The three answers](/disruption/anatomy-of-a-drain/#3-the-three-answers).

## Who killed my pod

```bash
# seat: tenant — read it while the pod is still Terminating
kubectl get pod <pod> -n payments -o jsonpath='{.status.conditions[?(@.type=="DisruptionTarget")].reason}{"\n"}'
```

`EvictionByEvictionAPI` → a drain or an evicting tool · `PreemptionByScheduler` → a higher-priority pod · `DeletionByTaintManager` → node NotReady past `tolerationSeconds` · `DeletionByPodGC` → the node is gone · `TerminationByKubelet` → node shutdown or pressure · *nothing* → you, a rollout, or the HPA. [The decoder](/disruption/anatomy-of-a-drain/#the-decoder-who-killed-my-pod).

## Where it lands: the FailedScheduling phrases

`were unschedulable` → the cordon, expected · `Insufficient cpu/memory` → survivors full, [N-1](/disruption/where-pods-land/#the-n-1-check) · `didn't match pod anti-affinity rules` → `required` → `preferred` · `didn't match pod topology spread constraints` → `ScheduleAnyway` or `nodeTaintsPolicy: Honor` · `volume node affinity conflict` → storage that follows · `exceeded quota` (on the ReplicaSet) → quota for N+1. [The decoder](/disruption/where-pods-land/#the-failedscheduling-decoder).

## The cast's budgets

| Workload | SLO shape | Floor → ceiling | PDB |
|---|---|---|---|
| `payments-api` | latency (no zero) | 2 → 16 | `maxUnavailable: 1` |
| `dispatch-worker`, `notify-worker`, `catalog-indexer` | freshness (a stated zero for R is fine) | 1 → 8 / 6 / 6 | `maxUnavailable: 1` |
| `catalog-web` | latency | 2 → 12 | `maxUnavailable: 1` |
| `valkey-primary`, `valkey-replica` | role | 1 each | `maxUnavailable: 1` per role |

Derivations, with the floor and ceiling rows: [the canonical PDB table](/disruption/pod-disruption-budgets/#the-canonical-pdb-table).

## Top PromQL

```promql
# Budget permits nothing (for: 30m)
kube_poddisruptionbudget_status_pod_disruptions_allowed{namespace="payments"} == 0
```

```promql
# Budget guards nothing — selector drift (for: 15m)
kube_poddisruptionbudget_status_expected_pods{namespace="payments"} == 0
```

```promql
# The gap a drain is waiting on, per PDB
kube_poddisruptionbudget_status_current_healthy{namespace="payments"} - kube_poddisruptionbudget_status_desired_healthy{namespace="payments"}
```

```promql
# Pods the kubelet ended (node pressure, node shutdown, lost node) — experimental metric.
# The DisruptionTarget condition reasons are NOT exported by kube-state-metrics; capture those in the watch loop.
sum by (reason) (kube_pod_status_reason{namespace="payments", reason=~"Evicted|Shutdown|NodeLost"})
```

```promql
# Terminating too long (experimental metric)
(time() - kube_pod_deletion_timestamp{namespace="payments"}) > 120
```

The `PrometheusRule`: [Alerts and dashboards](/disruption/platform-contract/#alerts-and-dashboards).

## The window, in six lines

1. Before: `kubectl get pdb -n payments` — no `ALLOWED DISRUPTIONS 0`; no rollout in progress; spread checked; pinned volumes audited.
2. Before: quorum drain times sent to the platform team; deploys frozen.
3. During: three terminals — `get pdb -w`, `get events -w --field-selector reason=Killing`, `get pods -o wide -w`.
4. After: everything Running, nothing Pending, spread restored.
5. After: one "graceful shutdown complete" log line per `Killing` event; no `Failed` pods; `DisruptionTarget` reasons match expectations.
6. After: error budget unchanged; any bypass explained and fixed by a date.

The copyable version: [the maintenance-window runbook](/disruption/platform-contract/#the-maintenance-window-runbook).

## The six asks

Drain timeout and what happens at expiry · `--grace-period` passed? · kubelet `shutdownGracePeriod` and the critical-pods reserve · the calendar, the channel, cordon lead time · which tools evict outside windows · are bypasses logged and announced. [What to ask](/disruption/platform-contract/#what-to-ask).

## FAQ

### Why is ALLOWED DISRUPTIONS 0?

One of three things: every pod is Ready and your *shape* permits nothing at this replica count (a floor equal to the count, or a percentage that rounded against you); a pod isn't Ready and the budget is correctly refusing to make it worse; or `expectedPods` is `0` and the selector matches nothing. `kubectl get pdb -o yaml` tells you which in one look. [The status block](/disruption/pod-disruption-budgets/#the-status-block-field-by-field).

### minAvailable or maxUnavailable?

`maxUnavailable`, as an integer, for anything with a Deployment or StatefulSet behind it. It scales with the replica count, so it holds at the HPA floor and ceiling; a `minAvailable` floor equal to `minReplicas` permits zero at 3 a.m. `minAvailable` is for bare pods, where it's the only legal shape. [The two shapes](/disruption/pod-disruption-budgets/#the-two-shapes).

### Does a PDB protect against kubectl delete? A rollout? HPA scale-in?

No, no, and no. Only the Eviction API reads it — drains and evicting tools. Rollouts have their own `maxUnavailable`; scale-in is paced by the HPA's `behavior`; `kubectl delete` is you. [What a PDB is not](/disruption/pod-disruption-budgets/#what-a-pdb-is-not).

### Can I have a PDB with one replica?

Yes — `maxUnavailable: 1` **plus** `unhealthyPodEvictionPolicy: AlwaysAllow`. It protects nothing and documents the outage, which is the honest thing for a singleton; the policy line is required because with one replica the default rule that lets broken pods go never engages, so a crashlooping singleton would still block the drain. `minAvailable: 1` on one replica blocks every drain forever and ends with someone overriding you. [The one-replica honesty](/disruption/pod-disruption-budgets/#the-one-replica-honesty).

### What is unhealthyPodEvictionPolicy, and should I set it?

It decides whether a Running-but-not-Ready pod can be evicted while your budget is unmet. The default (`IfHealthyBudget`) says no — which lets a crashlooping pod block a drain for hours. `AlwaysAllow` lets broken pods go while still protecting the healthy ones. Set it on everything stateless; leave the default on quorum members. Stable since 1.31. [The policy](/disruption/pod-disruption-budgets/#unhealthypodevictionpolicy-letting-the-broken-ones-go).

### Why did my pod die at 3 a.m. when nobody deployed?

Most likely a drain — the platform patches on its calendar, not yours — and if your HPA had scaled you to the floor, a `minAvailable` budget may have blocked it until the timeout and a human. Read the `DisruptionTarget` reason if the pod is still around; otherwise the `Killing` events and the platform's calendar. [The 3 a.m. problem](/disruption/pod-disruption-budgets/#pdb-and-hpa-the-3-am-problem).

### How do I find out who killed my pod?

The `DisruptionTarget` condition, while it's Terminating. Its `reason` names the actor; its absence means you, a rollout, or the HPA. [The decoder](/disruption/anatomy-of-a-drain/#the-decoder-who-killed-my-pod).

### Can I test a drain without node access?

Yes. POST an Eviction against your own pod — it's the same API call a drain makes, and it needs only `create` on `pods/eviction`, which the built-in `edit` role includes. Watch the budget dip and recover. [The self-eviction drill](/disruption/quick-start/#the-self-eviction-drill); the full set of drills is [Lab 11](/labs/lab-11-survive-the-drain/).

### How long should terminationGracePeriodSeconds be for a drain?

The same as for everything else: `S + D + margin`, measured — [the inequality](/workloads/graceful-shutdown/#the-budget-inequality). The drain-side twist is that it's also how long you make *them* wait, per pod, on every window; and that node shutdown caps it with the kubelet's window, which you should ask for. [The drain waits](/disruption/anatomy-of-a-drain/#5-the-drain-waits-for-each-pod-to-be-gone).

### Do I need a PDB for a CronJob?

No. A Job that must finish either runs outside the window or survives eviction with a `podFailurePolicy` that ignores `DisruptionTarget` failures. Blocking a drain for a batch is the citizenship contract broken for the least defensible reason. [Jobs](/disruption/involuntary-disruptions/#jobs-stop-burning-retries-on-drains).

### Do PDBs work on StatefulSets?

Yes, and they matter most there — one member at a time, per role, with readiness that means "caught up." Check whether the operator already wrote one before you add yours. [Stateful and quorum](/disruption/stateful-and-quorum/).

### What does "This pod has more than one PodDisruptionBudget" mean?

Two PDBs select the same pod, and the Eviction API refuses to evaluate at all — every drain of every node hosting that pod stalls with a 500 until you delete one. Usually an old hand-written budget plus a chart-templated one, or yours plus an operator's. [Selectors](/disruption/pod-disruption-budgets/#selectors-guard-exactly-one-thing).

### The platform says they'll force-delete us — what happens?

They run the drain with `--disable-eviction` (or delete the pod directly): no budget check, no 429, no `DisruptionTarget`. Your pod gets a deletionTimestamp and terminates normally — the grace period is still honored — and the ReplicaSet replaces it. From your seat it's indistinguishable from `kubectl delete`. The contract page's [emergency clause](/disruption/platform-contract/#what-to-promise-back) is how you make that a fifteen-minute decision with a name on it instead of a surprise.

## Where next

- **The journey:** [Disruption, Explained From Zero](/disruption/overview/) is where the section starts; this page is where it ends.
- **The lateral jump:** hands on — [Lab 11: Survive the Drain](/labs/lab-11-survive-the-drain/).
