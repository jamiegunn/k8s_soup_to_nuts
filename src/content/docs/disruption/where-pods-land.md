---
title: "The Other Half of a Drain: Where Your Pods Land"
description: An eviction the budget permits is only half a drain — the replacement must schedule with a node missing, under your own anti-affinity, spread, volume, and quota rules. The N-1 check, the six landing traps, and the FailedScheduling decoder.
keywords:
  - pods pending after node drain
  - 1 node(s) were unschedulable insufficient memory
  - didn't match pod anti-affinity rules during upgrade
  - didn't match pod topology spread constraints cordoned node
  - volume node affinity conflict after drain
  - exceeded quota replacement pod eviction
  - can my pods survive losing one node
  - n-1 capacity check kubernetes
  - drain blocks itself pending replacement
sidebar:
  order: 6
---

You are here if: your pods went `Pending` during the last maintenance window and stayed there; or the platform team's drain is blocked on a replacement that won't schedule; or you want to know, *before* the window, whether your namespace can actually lose a node.

This page serves the section's third question — **where does it land?** An eviction your budget permits ([the previous page](/disruption/pod-disruption-budgets/)) only removes a pod. The drain isn't done until a replacement is Ready somewhere else, and "somewhere else" is a scheduler looking for room on the nodes that are *left* — under rules you wrote for a cluster that had one more node than it has right now, while four other teams' replacements compete for the same headroom in the same minute.

The replacement is a brand-new pod. Your ReplicaSet creates it the instant the old one starts terminating; the scheduler then runs every filter you configured — node selectors, affinity, spread, taints, volume topology, quota — against a cluster with one node cordoned. Each of those filters is a place the drain can stall, and the stall looks identical from the platform's seat: `will retry after 5s`, forever. This page is the list.

## The N-1 check

The first question isn't about rules; it's arithmetic. **Can everything on the drained node fit on the others?** The cluster-level version is [the capacity invariant's](/autoscaling/capacity-and-governance/) failover reserve — the platform team's job. Your half is smaller and you can check it yourself: the requests your pods on that node reserve must fit in the headroom the other nodes have left, at the moment of the drain, alongside everyone else's replacements.

What your namespace reserves, without needing to read nodes:

```bash
# seat: tenant — Used vs Hard for the namespace, no arithmetic needed
kubectl describe resourcequota -n payments
```

```console
Name:            payments-quota
Namespace:       payments
Resource         Used    Hard
--------         ----    ----
requests.cpu     5200m   8
requests.memory  9Gi     16Gi
```

Two facts hide in that block. First, `Used` is what a drain has to re-place *across the cluster* if every pod on the drained node is yours; realistically it's the slice on that node — `kubectl get pods -n payments -o wide --field-selector spec.nodeName=node-w07` lists exactly which pods, and their requests are in the pod specs. Second, **the quota must fit one extra pod's requests during every eviction.** The ReplicaSet creates the replacement while the old pod is still Terminating (still counted by the quota for up to `G` seconds), so a namespace whose `Used` equals `Hard` can't create the replacement until the old pod is fully gone — the same `(replicas + 1) × requests` headroom a surge rollout needs ([the surge caution](/tuning/rollout-shutdown-knobs/#the-rollout-knobs)). The drain still proceeds, just `G` seconds slower per pod, with your fleet one pod short in the meantime.

The other side of the inequality — headroom on the surviving nodes — needs node access:

```bash
# seat: cluster-read — nodes; ask if denied
kubectl describe node node-w06 | grep -A7 "Allocated resources"
```

```console
Allocated resources:
  (Total limits may be over 100 percent, i.e., overcommitted.)
  Resource           Requests      Limits
  --------           --------      ------
  cpu                14200m (89%)  31600m (197%)
  memory             52Gi (83%)    96Gi (153%)
```

`89%` of CPU already reserved on the survivor means eleven percent of a node — about 1.75 cores here — is what's left for *everyone's* replacements from node-w07. Your `payments-api` pod requests `250m`, so seven of them would fit on this node and no more, and that's before any other tenant's replacements land. Multiply across the surviving nodes, subtract what the other tenants on node-w07 need, and you have the honest answer to "can we lose a node?" — which is why the [capacity page](/autoscaling/capacity-and-governance/) keeps that reserve in the ledger, and why [padded requests](/autoscaling/overview/#the-citizenship-contract) hurt twice: they inflate your own claim *and* shrink the room your neighbors' replacements need during your shared maintenance window.

If you can't read nodes, [the contract page](/disruption/platform-contract/#the-one-time-rbac-ask) has the ask; until then, the question "does our namespace fit with one node down?" is a question for the platform team, and asking it *before* the window is the whole point.

## The traps

Six ways a replacement fails to land even when there's room. Each: why it happens, the exact text you'll see, how to check, the fix, and the trade.

### 1. Required anti-affinity

`requiredDuringSchedulingIgnoredDuringExecution` on `kubernetes.io/hostname` with three replicas means three *schedulable* nodes with room — during a drain, that's three nodes not counting the cordoned one. On a small or full cluster, that node was the third.

```console
Warning  FailedScheduling  12s  default-scheduler  0/12 nodes are available: 1 node(s) were unschedulable, 3 node(s) didn't match pod anti-affinity rules, 8 Insufficient memory. preemption: 0/12 nodes are available: 12 No preemption victims found for incoming pod.
```

Check: `kubectl get deployment payments-api -n payments -o jsonpath='{.spec.template.spec.affinity.podAntiAffinity}'` — look for `required`. Fix: `preferredDuringScheduling…` with weight 100, which spreads when it can and co-locates when it must ([Scheduling](/workloads/scheduling/#pod-affinity-and-anti-affinity-placing-pods-relative-to-pods)). The trade: you give up the guarantee of never sharing a node, and gain a replacement that lands. For anything short of "two of these on one node is a data-loss event," that's the right trade — and if it *is* that, you're a [quorum workload](/disruption/stateful-and-quorum/) and want three nodes of headroom by contract.

### 2. Hard topology spread still counts the cordoned node

`topologySpreadConstraints` with `whenUnsatisfiable: DoNotSchedule` and `maxSkew: 1` across `kubernetes.io/hostname` has a surprise: **by default, a cordoned node still counts as a domain.** Picture three nodes with your pods at 1/1/0, where the 0 is the node being drained. The replacement can't go on the cordoned node, and placing it on either survivor makes the spread 2/1/0 — skew 2, over the limit. Pending, with the drain waiting on it.

```console
Warning  FailedScheduling  8s  default-scheduler  0/3 nodes are available: 1 node(s) were unschedulable, 2 node(s) didn't match pod topology spread constraints. preemption: 0/3 nodes are available: 3 No preemption victims found for incoming pod.
```

Fix, in order of preference: `whenUnsatisfiable: ScheduleAnyway` (spread is a preference again — the right default for stateless services); or keep `DoNotSchedule` and add `nodeTaintsPolicy: Honor` to the constraint, which drops nodes whose taints the pod doesn't tolerate — the cordon taint included — from the skew calculation. The trade for `ScheduleAnyway`: a rollout under pressure may briefly stack pods on one node; the trade for `Honor`: a hard rule that still stalls if the *survivors* are full. [Scheduling](/workloads/scheduling/#topologyspreadconstraints-the-modern-spread-tool) has the full field reference.

### 3. A volume that won't follow

A `ReadWriteOnce` PersistentVolume on node-local or zone-local storage carries a node affinity of its own. The scheduler honors it above everything else: the pod can only run where its disk is, and its disk is on the node being drained.

```console
Warning  FailedScheduling  4m  default-scheduler  0/31 nodes are available: 1 node(s) were unschedulable, 30 node(s) had volume node affinity conflict.
```

This is [the Field Note's](/blog/the-pdb-that-blocked-the-drain/) `report-builder-0` — a StatefulSet pod orbiting a cordoned node forever. Check which of your volumes are pinned:

```bash
# seat: cluster-read — persistentvolumes; ask if denied
kubectl get pv -o json | jq -r '.items[]
  | select(.spec.claimRef.namespace=="payments")
  | select(.spec.nodeAffinity != null)
  | "\(.spec.claimRef.name)\t\(.spec.storageClassName)\t\(.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0])"'
```

```console
data-report-builder-0    local-path    node-w07
```

`local-path` and `hostPath`-backed classes pin; a replicated block store like Longhorn does not — its volume can attach on any node that has a replica ([the Longhorn deep dive](/architectures/valkey-longhorn-deep-dive/) explains how). Fix: the right StorageClass for anything that must survive its node, or a workload that tolerates delete-and-recreate (documented in its [emergency playbook](/operations/emergency-playbooks/)). The trade of replicated storage is write latency and the disk it costs; the trade of pinned storage is that the node is now a pet, and pets don't drain.

### 4. Quota with no headroom

Covered under [the N-1 check](#the-n-1-check): the replacement is created while the old pod still counts. The text lives on the *ReplicaSet*, not the pod, because the pod was never admitted:

```bash
# seat: tenant
kubectl get events -n payments --field-selector reason=FailedCreate
```

```console
LAST SEEN   TYPE      REASON         OBJECT                              MESSAGE
31s         Warning   FailedCreate   replicaset/payments-api-7c9d4f6b8   Error creating: pods "payments-api-7c9d4f6b8-x2m9q" is forbidden: exceeded quota: payments-quota, requested: requests.cpu=250m, used: requests.cpu=8, limited: requests.cpu=8
```

Fix: quota sized for `(replicas + 1) × requests` — the same ask as for surge, made once ([the capacity page](/autoscaling/capacity-and-governance/) has the wording). Until then this only *delays* each eviction by your grace period; it doesn't block the drain.

### 5. Preemption: your pods as the victims

During a window, everyone's replacements are landing at once, and the scheduler may make room for a higher-priority one by **preempting yours** — the pod gets a `DisruptionTarget` with `reason: PreemptionByScheduler` ([the decoder](/disruption/anatomy-of-a-drain/#the-decoder-who-killed-my-pod)). Preemption tries to respect your PDB but only as a preference: if the only victims that make room are budget-protected, it takes them anyway. Your defenses are the usual ones — replicas and spread — plus an honest `priorityClassName` so you're not the cheapest thing on the node when it matters ([Scheduling](/workloads/scheduling/#priority-and-preemption)).

:::tip[Good citizen]
The tempting fix is to self-promote to the highest PriorityClass "so we're never the victim." Preemption cuts both ways: your replacement landing by evicting a neighbor's pod during *their* drain is exactly the outage you're trying to avoid, wearing someone else's namespace. Use the class your tier deserves and ask the platform team what the tiers mean.
:::

### 6. StatefulSets: at most one, so never overlapped

A Deployment's replacement is created while the old pod drains, and the two overlap. A StatefulSet's replacement has the *same name* as the pod it replaces and cannot exist until the old one is completely gone — so the gap per pod is the full grace period plus the startup time, never hidden by a surge. Multiply by the members a drain evicts one at a time, add resync time for the ones that carry data, and you have why a drain of a node hosting quorum members takes forty minutes. [Draining Stateful and Quorum Workloads](/disruption/stateful-and-quorum/) works the numbers.

## The FailedScheduling decoder

`kubectl describe pod` on the Pending replacement, then the last line of its events against this table:

```bash
# seat: tenant
kubectl describe pod payments-api-7c9d4f6b8-x2m9q -n payments | tail -4
```

```console
Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  9s    default-scheduler  0/12 nodes are available: 1 node(s) were unschedulable, 11 Insufficient memory. preemption: 0/12 nodes are available: 12 No preemption victims found for incoming pod.
```

| Phrase in the message | Meaning | What to do |
|---|---|---|
| `N node(s) were unschedulable` | Cordoned — the drain itself. Expected, not a problem by itself | Nothing; read the *other* phrases |
| `N Insufficient cpu` / `Insufficient memory` | The survivors are full: [the N-1 check](#the-n-1-check) failed | The capacity conversation, now — and honest requests |
| `didn't match pod anti-affinity rules` / `didn't satisfy existing pods anti-affinity rules` | [Trap 1](#1-required-anti-affinity) | `required` → `preferred` |
| `didn't match pod topology spread constraints` | [Trap 2](#2-hard-topology-spread-still-counts-the-cordoned-node) | `ScheduleAnyway`, or `nodeTaintsPolicy: Honor` |
| `had volume node affinity conflict` | [Trap 3](#3-a-volume-that-wont-follow) | Storage that follows the pod |
| `had untolerated taint` | A taint on the survivors your pod doesn't tolerate — a dedicated pool, or a health taint mid-incident | [Scheduling § taints](/workloads/scheduling/#taints-and-tolerations-repel-dont-attract); if it's `not-ready`/`unreachable`, that's a *second* sick node ([Node Problems](/troubleshooting/node-problems/)) |
| `didn't match Pod's node affinity/selector` | Your `nodeSelector`/node affinity names a pool that now has no room — or named the drained node | Widen the selector, or ask for pool headroom |
| `exceeded quota` (on the ReplicaSet, reason `FailedCreate`) | [Trap 4](#4-quota-with-no-headroom) | Quota for N+1 |
| `No preemption victims found` | Preemption couldn't help either — nothing lower-priority to remove | Same as the phrase before it |

The full Pending runbook — the cases that aren't drain-related — is [Pod Pending](/troubleshooting/pod-pending/).

## The landing drill without node access

You can answer most of "could we lose node X?" from your namespace. Start with where things are:

```bash
# seat: tenant
kubectl get pods -n payments -o wide
```

```console
NAME                               READY   STATUS    RESTARTS   AGE   IP            NODE       NOMINATED NODE   READINESS GATES
payments-api-7c9d4f6b8-k2xvn       1/1     Running   0          3d    10.42.7.14    node-w07   <none>           <none>
payments-api-7c9d4f6b8-r8pqz       1/1     Running   0          3d    10.42.7.19    node-w07   <none>           <none>
dispatch-worker-5b6c8d9f7-t4mwc    1/1     Running   0          3d    10.42.7.22    node-w07   <none>           <none>
catalog-web-6f7d8c9b5-a1b2c        1/1     Running   0          5d    10.42.3.41    node-w03   <none>           <none>
valkey-primary-0                   1/1     Running   0          19d   10.42.7.8     node-w07   <none>           <none>
valkey-replica-0                   1/1     Running   0          19d   10.42.9.30    node-w09   <none>           <none>
```

Read the `NODE` column the way a drain will: both `payments-api` pods are on node-w07 — the HPA scaled up onto whatever had room, and nothing asked for spread. When node-w07 drains, `maxUnavailable: 1` serializes them correctly, but *both* have to land elsewhere, one after the other, and for the first pod's replacement time the service is on one pod. That's fine at 3 a.m. and not at 12:30. The fix is [soft spread](/workloads/high-availability/#spreading-pods-anti-affinity-and-topologyspreadconstraints); the check is this command, run before every window.

Then the thought experiment, one row per workload with pods on the node in question — it takes five minutes and finds trap 3 every time:

| Workload | Pods on node-w07 | Rules that constrain the replacement | Volume follows? | Room elsewhere? (N-1 check) | Verdict |
|---|---|---|---|---|---|
| `payments-api` | 2 | soft anti-affinity; `maxUnavailable: 1` | n/a | quota has 1 pod of headroom ✔ | lands, one at a time |
| `dispatch-worker` | 1 | none | n/a | ✔ | lands |
| `valkey-primary-0` | 1 | STS at-most-one; PVC `data-valkey-primary-0` | Longhorn ✔ | ✔ | lands after `G` + start + resync — [stateful page](/disruption/stateful-and-quorum/) |
| `report-builder-0` | 1 | STS; PVC on `local-path` | **No — pinned to node-w07** | — | **does not land** — fix before the window |

If your platform's tooling supports a server-side dry run of the drain, ask for its report; if not, this table *is* the dry run, and it belongs in the [window runbook](/disruption/platform-contract/#the-maintenance-window-runbook).

## There is nowhere to land

The limiting case explains every stalled drain you'll ever see. When the survivors are full — or when there's only one node — each eviction the budget permits produces a replacement that can't schedule. `currentHealthy` drops by one and never recovers, `disruptionsAllowed` reads 0, and the drain's *next* eviction gets a 429 — forever. **The drain blocked itself:** the budget is waiting for a replacement that has nowhere to land, and the drain is what removed the room.

```console
node/node-w07 cordoned
evicting pod payments/payments-api-7c9d4f6b8-k2xvn
evicting pod payments/payments-api-7c9d4f6b8-r8pqz
pod/payments-api-7c9d4f6b8-k2xvn evicted
error when evicting pods/"payments-api-7c9d4f6b8-r8pqz" -n "payments" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.
```

with, in your namespace:

```console
NAME                               READY   STATUS    NODE
payments-api-7c9d4f6b8-r8pqz       1/1     Running   node-w07
payments-api-7c9d4f6b8-x2m9q       0/1     Pending   <none>
```

Nothing on the PDB fixes this, and a bigger `maxUnavailable` only lets the drain evict its way to zero. The fixes are all on this page: headroom, honest requests, storage that follows, rules that bend. [Lab 11](/labs/lab-11-survive-the-drain/) reproduces the stalemate on purpose, on a single node, so you can watch the budget wait for room that isn't coming — and then watch it resolve the instant the node is uncordoned. On a production cluster, "uncordon" is spelled "capacity."

## Who owns what

| Concern | PLATFORM team | YOU |
|---|---|---|
| Allocatable per node; the cluster-level failover reserve | ✔ | ask whether the ledger has it |
| Node pools, taints, PriorityClass tiers | ✔ | tolerate and select honestly |
| StorageClasses that follow the pod | ✔ provides | choose them for anything that must survive its node |
| RBAC to read nodes and PVs | ✔ grants | [the one-time ask](/disruption/platform-contract/#the-one-time-rbac-ask) |
| Your `Σ requests`, and quota with one pod of headroom | | ✔ measured, not padded |
| Anti-affinity and spread as preferences, not requirements | | ✔ |
| The pods-per-node check and the landing table, before each window | | ✔ |

## Where next

- **Next in the journey:** [Draining Stateful and Quorum Workloads](/disruption/stateful-and-quorum/) — trap 6 in full: what one eviction costs a database, a cache, or a broker, and who already wrote its PDB.
- **The lateral jump:** if the phrase in your event was `Insufficient cpu` or `Insufficient memory`, the conversation you need is [Capacity, Quotas, and Rolling Autoscaling Out to Teams](/autoscaling/capacity-and-governance/) — the failover reserve is a line in the ledger.
