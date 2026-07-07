---
title: "Field Notes: The PDB That Blocked the Drain"
description: Our PodDisruptionBudget was supposed to protect availability. Instead it held a node hostage for six hours and taught us that HA config is a negotiation, not armor.
keywords:
  - maxUnavailable 0
  - eviction violates disruption budget
  - kubectl drain stuck
  - volume node affinity conflict
  - ReadWriteOnce zone-pinned volume
  - status.disruptionsAllowed 0
  - minAvailable percentage rounding
  - kernel patching node drain window
date: 2026-05-20
authors: editor
tags:
  - availability
  - operations
  - pdb
excerpt: >-
  The platform team's routine kernel patching stalled for six hours — on us.
  Our maxUnavailable: 0 PDB plus a volume that pinned a pod to the draining
  node had turned "protect our users" into "nobody can maintain this cluster."
---

The message from the platform team arrived at 15:20, politeness stretched thin:

> "Node pool patching has been blocked for 6 hours. The drain on node-w14 cannot complete. Both blocking pods are in your namespace. Can someone look?"

My first reaction — and I want to record it because it's the whole disease — was pride. *Our disruption budget is doing its job.* We'd configured PodDisruptionBudgets on everything the previous quarter after an unrelated incident, and here was the cluster respecting them. Working as intended.

It took the rest of the afternoon to understand that "working as intended" and "intended correctly" are different sentences.

## What the drain saw

From the platform team's side (they shared the output; we can't see nodes):

```console
$ kubectl drain node-w14 --ignore-daemonsets --delete-emptydir-data
evicting pod reporting/report-builder-0
evicting pod reporting/summary-api-59f7d9b6c-hx4wp
error when evicting pods/"summary-api-59f7d9b6c-hx4wp" -n "reporting":
Cannot evict pod as it would violate the pod's disruption budget.
```

Retrying every five seconds. For six hours. Two separate jams, compounding:

**Jam one: the PDB that permits nothing.** Someone (fine: me, in a PR that got a rubber-stamp +1) had written this:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: summary-api
spec:
  maxUnavailable: 0        # ← "never let anything take us down"
  selector:
    matchLabels:
      app: summary-api
```

`maxUnavailable: 0` doesn't mean "be careful with my pods." It means **no voluntary disruption is ever permitted**. Not one pod, not for one second, no matter how many healthy replicas exist. The eviction API returns 429 for every attempt, forever. And `summary-api` ran *two* replicas — so even a sane-looking `minAvailable: 2` would have been the same trap wearing a different name. A PDB can only offer headroom if `replicas` exceeds the floor it sets; ours had none to give. (This interaction — replicas, PDBs, and topology spread — is exactly what the [high availability guide](/workloads/high-availability/) walks through.)

**Jam two: the pod that couldn't land anywhere else.** `report-builder-0` had no PDB problem — it was evicted promptly. Then it sat `Pending`:

```console
$ kubectl get events --field-selector involvedObject.name=report-builder-0
LAST SEEN   TYPE      REASON             MESSAGE
4m          Warning   FailedScheduling   0/31 nodes are available: 1 node(s)
                      were unschedulable, 30 node(s) had volume node
                      affinity conflict.
```

Its PersistentVolume was ReadWriteOnce on zone-local disk — the volume's node affinity bound it to, effectively, the very node being drained (the only schedulable node in that zone with capacity, and the disk can't leave the zone anyway). So the drain had evicted a pod that could only ever come back to the node it was evicted from. A StatefulSet pod pinned by its own storage, orbiting a cordoned node. ([Events](/observability/events/) told the whole story in one command; we just hadn't looked until asked.)

Result: a fully patched fleet minus one node, held open by one namespace. Ours.

## The uncomfortable conversation

The platform engineer who walked us through it was gracious, and one thing she said reframed the whole topic:

> "A PDB is you telling us how much disruption you can absorb. `maxUnavailable: 0` is you telling us you can absorb none, ever. If that's true, we can't patch kernels, upgrade kubelets, or rebalance — so it can't be true. When a PDB permits nothing, eventually someone with cluster-admin overrides it by hand, at a time you don't choose, and then it protected nothing."

That's the real semantics. A PDB isn't armor you bolt on; it's the disruption clause of a contract, and we'd written a clause no counterparty could sign. Worse, we'd written it *without* the matching obligations on our side: you can only promise "one pod may go down safely" if the remaining pods actually carry the load, start fast, and drain connections cleanly — none of which we'd verified. Blocking evictions had quietly become a substitute for being actually resilient.

The RWO pinning was the same lesson in storage form: our "durable" architecture assumed the node was permanent. Nodes are cattle *by design*; our disk had made one of them a pet without telling anyone.

Homework we assigned ourselves afterward: find every other trap like this in the namespace *before* the next drain window does. Both checks fit in a terminal:

```console
# PDBs that permit zero disruptions right now
$ kubectl get pdb -o custom-columns=\
NAME:.metadata.name,\
MIN:.spec.minAvailable,MAX:.spec.maxUnavailable,\
ALLOWED:.status.disruptionsAllowed
NAME           MIN      MAX   ALLOWED
summary-api    <none>   0     0        ← the smoking gun
report-cache   2        <none> 1
audit-writer   80%      <none> 0        ← surprise: 4 replicas, 80% = ceil 4
```

`status.disruptionsAllowed: 0` at steady state is the whole audit — the controller computes it for you continuously; you just have to look. `audit-writer` was a second live trap we didn't know we had: `minAvailable: 80%` of 4 replicas rounds up to 4, permitting nothing. Percentages round *against* you.

```console
# RWO volumes whose PVs are pinned to a topology
$ kubectl get pv -o json | jq -r '.items[]
    | select(.spec.claimRef.namespace=="reporting")
    | select(.spec.nodeAffinity != null)
    | "\(.spec.claimRef.name)\t\(.spec.nodeAffinity.required
        .nodeSelectorTerms[0].matchExpressions[0].values[0])"'
data-report-builder-0    us-east-1c
```

(Reading PVs needs a cluster-scoped list — our platform team granted read-only PV access after this incident precisely so tenants could self-audit.)

## Unjamming, then fixing

Same afternoon: we scaled `summary-api` to 3 replicas and patched the PDB to `maxUnavailable: 1`, and the drain completed in ninety seconds. For `report-builder`, we accepted downtime that day (it's a batch reporting service; nobody noticed), deleted the pod with the platform team un-cordoning long enough for it to reschedule home — and put "get this thing off zone-pinned RWO" on the roadmap. It has since moved to writing scratch output to object storage; the StatefulSet is now a Deployment.

The durable PDB pattern we standardized on:

```yaml
spec:
  maxUnavailable: 1          # always leaves the drain a move to make
  selector:
    matchLabels:
      app: summary-api
# paired with, in the Deployment:
#   replicas: 3   (minimum for anything claiming a PDB)
#   topologySpreadConstraints across zones
#   readiness gates that reflect real serving ability
```

And a rule: **`maxUnavailable: 0` and `minAvailable: 100%` require a written platform-team sign-off**, because they're requests for someone else to absorb your risk during every maintenance window.

## What we changed

- **Every PDB must leave at least one legal eviction at steady state** — CI renders the manifests and fails if `replicas - minAvailable < 1` (or `maxUnavailable < 1`). A PDB that permits zero disruptions is a drain-blocker with a safety-themed name.
- **No PDB without at least 3 replicas** and a load test showing N-1 replicas holding peak traffic. The budget is a promise; we now check we can keep it.
- **We audit for node-pinning storage.** Any RWO volume on zone/node-local disk gets flagged; either the workload can tolerate deletion-and-recreate (documented in its [emergency playbook](/operations/emergency-playbooks/)) or it needs different storage. "Where can this pod legally reschedule?" is a question we now answer *before* a drain asks it.
- **We meet the platform team's maintenance calendar halfway.** They announce drain windows; we watch our namespace's eviction events during them. Six hours of a stuck drain is six hours someone else spent staring at *our* config — that cost was invisible to us until they sent the bill.
- **Postmortem culture note: "the system did what we configured" is the start of the analysis, not the end.** Everything worked as intended. The intent was the bug.

High availability settings look like they're only about you — your replicas, your uptime, your users. They're not. Every PDB, affinity rule, and volume choice is a message to the people running the cluster about what they're allowed to do and when. Write messages someone can live with, or someone with more privileges than you will eventually stop reading them.
