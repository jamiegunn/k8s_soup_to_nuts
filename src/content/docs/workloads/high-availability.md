---
title: High Availability
description: PodDisruptionBudgets, anti-affinity, topology spread, priority, and graceful shutdown — surviving node drains and cluster upgrades without paging anyone.
keywords:
  - poddisruptionbudget
  - pdb blocking node drain
  - allowed disruptions zero
  - kubectl drain stuck
  - pod anti-affinity spread replicas
  - topologyspreadconstraints maxskew
  - all replicas on one node
  - priorityclassname preemption
  - cluster upgrade evicting pods
  - minavailable maxunavailable
sidebar:
  order: 5
---

Your platform team drains nodes constantly: kernel patches, cluster upgrades, autoscaler consolidation, spot reclaims. Each drain evicts your pods. Whether that's a non-event or an outage is decided entirely by things *you* control in your manifests. This article is the checklist.

:::note[The mechanics have dedicated pages]
This article is the HA checklist. The termination lifecycle — the SIGTERM/endpoint-removal race, per-stack drain wiring, the budget inequality — lives in [Graceful Shutdown](/workloads/graceful-shutdown/), with the dials in [Rollout & Shutdown Knobs](/tuning/rollout-shutdown-knobs/). The drain itself from your seat — what `kubectl drain` does step by step, PDB arithmetic and the 3 a.m. collision with the HPA floor, where evicted pods land, and the contract with the platform team — is the [Disruption & Drain Playbook](/disruption/overview/); if the platform team is waiting on your namespace right now, start at [the ten-minute unjam](/disruption/pod-disruption-budgets/#unjamming-a-blocked-drain-right-now).
:::

:::tip[War story]
The PDB section has a Field Note: [The PDB That Blocked the Drain](/blog/the-pdb-that-blocked-the-drain/) — maxUnavailable: 0 holding a node hostage for six hours.
:::

## Replicas > 1 is table stakes, not HA

One replica means every voluntary drain, every OOMKill, every image pull hiccup is a full outage for your service. Two replicas on the *same node* is barely better — one drain still takes both. Real availability is three layers:

1. **Multiple replicas** — so losing one pod loses capacity, not the service.
2. **Spread across failure domains** — so one node (or zone) can't take them all.
3. **Disruption budgets and graceful shutdown** — so planned maintenance replaces pods without dropping requests.

Run at least 2 replicas for anything anyone depends on, 3+ for anything with an SLO. If the app can't run with 2 replicas because it has state or a single-writer constraint, that's a [stateful workload](/stateful/overview/) and needs different machinery.

## PodDisruptionBudgets

A PDB tells the eviction API how much *voluntary* disruption your app tolerates. Node drains use the eviction API; the drain **blocks** until evicting a pod wouldn't violate your PDB. The shape that's right for almost everything:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payments
spec:
  maxUnavailable: 1                         # a ceiling on the MISSING — holds at every replica count,
                                            # including the HPA's 3 a.m. floor (minAvailable doesn't)
  unhealthyPodEvictionPolicy: AlwaysAllow   # a crashlooping pod can't hold the drain hostage
  selector:
    matchLabels:
      app: payments
```

With 3 replicas and `maxUnavailable: 1`, a drain evicts one pod, waits for its replacement to become Ready elsewhere, then the next eviction can proceed. Rolling cluster upgrades become invisible to your users — provided each eviction is *clean*, which is graceful shutdown's job, not the budget's.

PDBs guard **voluntary** disruptions only: drains, eviction API calls, descheduler. They do nothing against node crashes, OOMKills, HPA scale-in, or your own rolling updates (those are governed by `maxUnavailable` in the [Deployment strategy](/workloads/rollouts-and-rollbacks/)).

:::danger[A bad PDB is how you end up on the platform team's blocklist]
`minAvailable` equal to the replica count (including `minAvailable: 1` on one replica), `maxUnavailable: 0`, or a percentage that rounds up to everything (`minAvailable: 80%` of 4 = 4) permit **zero** disruptions, and the platform team's upgrade automation stalls on your namespace until a human pages you or force-deletes your pods. Rule of thumb: **never ship a PDB that allows zero disruptions** — if you have 1 replica, the fix is 2 replicas. The proof:

```console
$ kubectl get pdb payments
NAME       MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
payments   N/A             1                 1                     12d
```

`ALLOWED DISRUPTIONS: 0` on a healthy day means you've built a drain-blocker. The arithmetic behind that column, the `minAvailable`-meets-HPA-floor trap, selector overlap, and the ten-minute unjam are all in [PodDisruptionBudgets, All the Way Down](/disruption/pod-disruption-budgets/).
:::

## Spreading pods: anti-affinity and topologySpreadConstraints

The scheduler will happily put all 3 of your replicas on one node if that's where the space is. You have to ask for spread. This section covers the two tools from the HA angle; the complete mechanics — affinity, taints and tolerations, topology spread in full — live in [Scheduling](/workloads/scheduling/).

**Pod anti-affinity** — "don't put me next to my own kind":

```yaml
spec:
  template:
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: payments
                topologyKey: kubernetes.io/hostname
```

- `preferredDuringScheduling...` — best effort. Scheduler spreads when it can, co-locates when it must. **Use this by default.**
- `requiredDuringScheduling...` — hard rule. With 3 replicas and required hostname anti-affinity, you need 3 schedulable nodes with room, *including during rollout surge and drains*. On a small or busy cluster this manifests as [Pending pods](/troubleshooting/pod-pending/) at the worst possible time. Reserve `required` for the cases where co-location is genuinely catastrophic.

**topologySpreadConstraints** — the newer, more expressive tool, and better at "spread evenly" (anti-affinity only expresses "not together"):

```yaml
spec:
  template:
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway     # soft
          labelSelector:
            matchLabels:
              app: payments
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: payments
```

This says: keep the pod-count difference between zones ≤ 1 and between nodes ≤ 1, but schedule anyway if impossible. `whenUnsatisfiable: DoNotSchedule` is the hard variant, with the same Pending-pod risks as required anti-affinity.

:::tip
Zone spread only helps if the cluster actually spans zones — `kubectl get nodes -L topology.kubernetes.io/zone` will tell you (node listing is usually readable even with namespace-scoped access; if not, ask your platform team what the topology looks like).
:::

## priorityClassName

PriorityClasses are cluster-scoped — the platform team defines them; you reference one:

```yaml
spec:
  template:
    spec:
      priorityClassName: business-critical
```

Priority matters in two moments: when the scheduler must **preempt** lower-priority pods to place yours, and when the kubelet chooses **eviction victims** under node pressure (alongside [QoS](/workloads/resources-and-qos/)). Find out what classes exist (`kubectl get priorityclass` if you're allowed, otherwise ask) and use the one your service tier deserves. Don't self-promote to the highest class "just in case" — platform teams notice, and preemption cuts both ways.

## Graceful shutdown: why it belongs in the HA story

Every node drain, cluster upgrade, and voluntary disruption ends by delivering SIGTERM to your pods — so whether a drain is a non-event or a spike of 502s is decided by how cleanly they terminate. A PDB and good spread only get pods evicted *safely one at a time*; graceful shutdown is what makes each of those evictions dropless. The mirror-image HA caveat lives on the same dial: because drains and rollouts wait for a pod to actually die, an oversized `terminationGracePeriodSeconds` makes every drain and cluster upgrade crawl — sized honestly, it protects requests without slowing maintenance.

The full termination model — the SIGTERM/endpoint-removal race, the preStop pattern, the Path A/Path B timeline, and how to size the grace period — is the subject of its own article: **[Graceful Shutdown](/workloads/graceful-shutdown/)**. Read it before you sign off on any service's HA posture.

## The drain-survival checklist

Before you claim a service is HA, verify:

```console
$ kubectl get deploy payments -o jsonpath='{.spec.replicas}'          # ≥ 2
$ kubectl get pdb -l app=payments                                     # exists, ALLOWED DISRUPTIONS ≥ 1
$ kubectl get pods -l app=payments -o wide                            # not all on one node
```

- [ ] replicas ≥ 2 (3+ with an SLO)
- [ ] PDB exists and allows at least 1 disruption at all times
- [ ] Soft anti-affinity or topology spread across hostname (and zone if available)
- [ ] preStop sleep + real SIGTERM handling + honest grace period
- [ ] [Readiness probe](/workloads/health-checks/) that reflects actual serving ability
- [ ] Rollout strategy that doesn't dip below your capacity floor

Do all six and cluster upgrade night becomes somebody else's problem — which is exactly where you want it.
