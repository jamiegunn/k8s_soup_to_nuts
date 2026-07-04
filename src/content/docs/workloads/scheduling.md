---
title: Scheduling — Affinity, Taints, and Spread
description: How the scheduler actually places your pods — nodeSelector, affinity, taints, topology spread, and priority, from the tenant seat.
sidebar:
  order: 18
---

You don't own the nodes. The platform team decides what hardware exists, how pools are labeled and tainted, and when nodes get drained. What *you* own is the set of constraints in your pod spec that tells the scheduler where your pods may, may not, and would prefer to land. This article is the complete mechanics of those constraints. If you only care about spreading replicas for availability, [High Availability](/workloads/high-availability/) has the opinionated recipe; this is the reference for everything underneath it.

## How the scheduler decides: filter, then score

Every unscheduled pod goes through two phases:

1. **Filtering** — the scheduler eliminates every node the pod *cannot* run on: not enough unreserved CPU/memory for the pod's **requests**, missing labels demanded by `nodeSelector` or required affinity, taints the pod doesn't tolerate, volume topology conflicts, port conflicts for `hostPort`. What survives is the *feasible* set.
2. **Scoring** — the feasible nodes are ranked: preferred affinity weights, spread constraint skew, image locality, least-allocated bin-packing (or most-allocated, depending on cluster config). Highest score wins; ties break randomly.

If the feasible set is empty, the pod stays `Pending` and the scheduler emits a `FailedScheduling` event that is a *tally of filter failures*:

```console
$ kubectl describe pod api-7d4b9c6f8-xk2lp
...
Events:
  Type     Reason            Message
  ----     ------            -------
  Warning  FailedScheduling  0/12 nodes are available: 3 node(s) had untolerated taint
                             {workload: batch}, 4 Insufficient cpu, 5 node(s) didn't match
                             pod anti-affinity rules. preemption: 0/12 nodes are available:
                             12 No preemption victims found for incoming pod.
```

Read it as: 12 nodes existed, and here's which filter killed each one. 3+4+5 = 12, so nothing was feasible. Once you can decode that message, every scheduling problem becomes a question of *which constraint to loosen or which capacity to request*. Full triage flow in [Pod Pending](/troubleshooting/pod-pending/).

:::note
Scheduling is based on **requests**, not limits and not actual usage. A node "full" to the scheduler can be 90% idle in reality — it's the sum of requests that matters. If your pods won't schedule, your first look is at requests, covered in [Resources and QoS](/workloads/resources-and-qos/).
:::

## nodeSelector: the blunt instrument

`nodeSelector` is required-match on node labels — simple AND of exact key=value pairs. Start by seeing what labels exist (if your RBAC allows node reads; many tenant setups do, read-only):

```bash
kubectl get nodes --show-labels
# More readable for one dimension:
kubectl get nodes -L topology.kubernetes.io/zone,node.kubernetes.io/instance-type,kubernetes.io/arch
```

```console
NAME              STATUS   ZONE         INSTANCE-TYPE   ARCH
node-a1           Ready    us-east-1a   m6i.2xlarge     amd64
node-b1           Ready    us-east-1b   m6i.2xlarge     amd64
node-c1           Ready    us-east-1c   c7g.2xlarge     arm64
```

Well-known labels you can almost always target:

| Label | Meaning |
|---|---|
| `kubernetes.io/arch` | `amd64`, `arm64` |
| `kubernetes.io/os` | `linux`, `windows` |
| `topology.kubernetes.io/zone` | availability zone |
| `topology.kubernetes.io/region` | cloud region |
| `node.kubernetes.io/instance-type` | e.g. `m6i.2xlarge` |

Plus whatever pool labels your platform team applies (`nodepool=general`, `workload=batch`, `team=payments` — ask, or read them off the nodes). Usage:

```yaml
spec:
  nodeSelector:
    kubernetes.io/arch: amd64
    nodepool: general
```

If *no* node matches, your pod is Pending forever — nodeSelector has no "preferred" mode. That's what affinity is for.

## Node affinity: required vs preferred

Node affinity is nodeSelector with expressions, OR-logic, and soft preferences:

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: kubernetes.io/arch
                operator: In
                values: ["amd64"]
              - key: node-role.example.com/spot
                operator: DoesNotExist
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 80
          preference:
            matchExpressions:
              - key: topology.kubernetes.io/zone
                operator: In
                values: ["us-east-1a"]
        - weight: 20
          preference:
            matchExpressions:
              - key: node.kubernetes.io/instance-type
                operator: In
                values: ["m6i.2xlarge", "m6i.4xlarge"]
```

Decoding the vocabulary:

- **`requiredDuringScheduling...`** is a filter: no matching node, no placement, pod stays Pending.
- **`preferredDuringScheduling...`** is a score: each matching preference adds its `weight` (1–100) to a node's score. It's a tiebreaker, not a guarantee — under pressure the scheduler will cheerfully ignore all of it.
- **`...IgnoredDuringExecution`** means: evaluated *only at scheduling time*. If the platform team relabels a node after your pod lands, your running pod is **not evicted**. Every affinity type today ends in this suffix; the eviction-on-violation variant never shipped for affinity (taints with `NoExecute` are the mechanism that actually evicts — see below).

Operators: `In`, `NotIn`, `Exists`, `DoesNotExist`, `Gt`, `Lt` (the last two do integer comparison on the label value — occasionally useful against custom labels like `cpu-generation: 4`).

:::caution
**The classic AND/OR confusion.** Inside `requiredDuringScheduling...`, multiple `nodeSelectorTerms` entries are **OR**ed — a node satisfying *any one term* passes. Multiple `matchExpressions` *within* one term are **AND**ed — all must match. If you wanted "amd64 AND not-spot" but wrote them as two separate terms, you just asked for "amd64 OR not-spot" and your JVM image will eventually land on an arm64 node and die with `exec format error`.
:::

Realistic uses from the tenant seat: pinning arch when your image isn't multi-arch (required, `kubernetes.io/arch In [amd64]`); preferring a zone where a dependency lives (preferred, weight); keeping stateful or long-running pods off spot/preemptible pools (required `DoesNotExist` on the spot label — or better, rely on the platform's taint, next section).

## Pod affinity and anti-affinity: placing pods relative to pods

Node affinity matches node labels. Pod (anti-)affinity matches **pod labels** — "put me near pods matching X" / "keep me away from pods matching X". The selector selects *pods*; the `topologyKey` defines what "near" means.

**`topologyKey`** is a node label whose *value* partitions the cluster into domains. `kubernetes.io/hostname` → each node is a domain (co-locate on / spread across nodes). `topology.kubernetes.io/zone` → each zone is a domain. Affinity means "land in a domain that already contains a matching pod"; anti-affinity means "avoid domains containing a matching pod".

Co-locating an app with its cache (affinity):

```yaml
spec:
  affinity:
    podAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchLabels:
                app: redis-cache
            topologyKey: kubernetes.io/hostname
```

Spreading your own replicas (anti-affinity — but see the spread-constraints section, which is usually better):

```yaml
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: api
          topologyKey: kubernetes.io/hostname
```

Same required/preferred split as node affinity, same `IgnoredDuringExecution` meaning. Two sharp edges:

:::caution
**Required anti-affinity caps your replicas at the number of domains.** `required` + `hostname` + 6 replicas + 5 feasible nodes = one pod Pending forever, including mid-rollout when the surge pod needs a sixth node. Use `preferred`, or use `topologySpreadConstraints`.
:::

:::caution
**Pod affinity is expensive.** Evaluating it means cross-referencing every candidate node's domain against existing pods across namespaces — measurably slow scheduling on clusters of hundreds of nodes. Kubernetes docs flag it outright; some platform teams restrict it. Don't sprinkle it on everything.
:::

## Taints and tolerations: repel, don't attract

The mental model people reliably get backwards: **a taint on a node repels pods; a toleration on a pod grants permission to ignore that repulsion.** A toleration does **not** attract your pod to tainted nodes — a pod tolerating `gpu=true:NoSchedule` is merely *allowed* on GPU nodes and will still happily schedule onto any untainted node. To actually *land* on a dedicated pool you need the pair: **toleration (may go there) + node affinity or nodeSelector (must go there)**.

Reading taints (`describe`, or a one-liner over all nodes):

```bash
kubectl describe node node-g1 | grep -A2 Taints
kubectl get nodes -o custom-columns='NAME:.metadata.name,TAINTS:.spec.taints[*].key'
```

```console
Taints:  workload=batch:NoSchedule
```

Three effects:

- **`NoSchedule`** — hard filter; non-tolerating pods never scheduled here. Existing pods untouched.
- **`PreferNoSchedule`** — soft; scheduler avoids the node but will use it as a last resort.
- **`NoExecute`** — filter **plus eviction** of already-running non-tolerating pods. A toleration can carry `tolerationSeconds` to say "I'll stay N seconds after this taint appears, then evict me".

The `NoExecute` variety is how node problems reach you: when a node goes `NotReady`, the control plane taints it `node.kubernetes.io/not-ready:NoExecute` and `node.kubernetes.io/unreachable:NoExecute`. Every pod gets a default toleration of 300s for these — which is why pods on a dead node linger five minutes before rescheduling. You can shorten it for latency-sensitive services:

```yaml
spec:
  tolerations:
    - key: node.kubernetes.io/unreachable
      operator: Exists
      effect: NoExecute
      tolerationSeconds: 30
```

You'll also see `node.kubernetes.io/memory-pressure`, `disk-pressure`, and `unschedulable` (cordoned) taints during node trouble — details in [Node Problems](/troubleshooting/node-problems/).

**The dedicated-pool recipe.** This is the standard contract with your platform team, and worth asking for by name when you need isolated capacity (GPU jobs, noisy batch, compliance workloads):

- **Platform side:** taint the pool (`team=payments:NoSchedule`) *and* label it (`nodepool=payments`). The taint keeps everyone else out; the label gives you something to target.
- **Your side:** toleration for the taint *and* required node affinity (or nodeSelector) on the label. Toleration alone leaks your pods onto shared nodes; affinity alone leaves them Pending against the taint.

```yaml
spec:
  tolerations:
    - key: team
      operator: Equal
      value: payments
      effect: NoSchedule
  nodeSelector:
    nodepool: payments
```

How to phrase that request — and what else to put in it — is in [Working with the Platform Team](/operations/working-with-platform-team/).

## topologySpreadConstraints: the modern spread tool

For "distribute my replicas evenly", spread constraints beat anti-affinity: they control *skew* rather than issuing a binary keep-away, so they keep working past one-pod-per-domain.

```yaml
spec:
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      minDomains: 3
      labelSelector:
        matchLabels:
          app: api
      matchLabelKeys:
        - pod-template-hash
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          app: api
      matchLabelKeys:
        - pod-template-hash
```

That's the workhorse double spread: **hard** across zones, **soft** across hosts. Field by field:

- **`maxSkew`** — max allowed difference between the most- and least-populated domain. `1` = as even as arithmetic allows.
- **`whenUnsatisfiable`** — `DoNotSchedule` makes it a filter (pod goes Pending rather than violate); `ScheduleAnyway` makes it a scoring preference. Hard on zones is usually safe (zones are few and stable); hard on hostname bites you the same way required anti-affinity does when nodes are scarce.
- **`minDomains`** — with `DoNotSchedule`, treats fewer-than-N observed domains as skew violations, forcing the autoscaler to open new domains instead of packing two zones and calling it even.
- **`matchLabelKeys: [pod-template-hash]`** — the rolling-update fix. Without it, the constraint counts old-ReplicaSet and new-ReplicaSet pods together, so mid-rollout the "even" math is computed over pods that are about to disappear, and you end with the new pods lopsided. This scopes counting to pods sharing your template hash, i.e. per-ReplicaSet.

:::tip
Spread constraints only apply **at scheduling time**. Scale-downs and evictions un-balance you and nothing rebalances automatically (unless the platform runs the descheduler). Check reality occasionally — see the debugging section.
:::

**Which spread tool:**

| | `podAntiAffinity` | `topologySpreadConstraints` |
|---|---|---|
| Semantics | keep-away (binary) | limit imbalance (numeric skew) |
| More replicas than domains | required = Pending; preferred degrades unpredictably | keeps distributing evenly |
| Hard/soft | required / preferred | DoNotSchedule / ScheduleAnyway |
| Scheduler cost on big clusters | high | moderate |
| Rolling-update awareness | none | `matchLabelKeys` |
| Best for | "never two on one node", spread *relative to another app* | even distribution of your own replicas |

## Priority and preemption

`priorityClassName` sets who wins when nodes are full: if a high-priority pod has no feasible node, the scheduler may **preempt** — evict lower-priority pods to make room. Classes are cluster-scoped and platform-defined; see what exists:

```bash
kubectl get priorityclasses
```

```console
NAME                      VALUE        GLOBAL-DEFAULT
system-cluster-critical   2000000000   false
system-node-critical      2000001000   false
platform-critical         100000       false
production                10000        false
batch                     -100         false
```

Use it in the spec: `spec.priorityClassName: production`. Two tenant-relevant realities:

- **Your pods can be victims.** If a preempted pod vanished, the evidence is a `Preempted` event and often a message on the pod before it's deleted. `kubectl get events --field-selector reason=Preempted` (events expire after ~an hour, so look fast). Frequent preemption of your workload means your class is too low for its actual importance — a conversation, not a YAML change.
- **Etiquette:** never set `system-cluster-critical`/`system-node-critical` or grab the highest number you can find. Priority is a shared currency; if everyone is critical, nobody is. Ask the platform team which class your workload tier maps to.

## The PVC trap: volumes schedule pods

A bound PVC on a **zonal** disk (EBS, GCP PD, Azure Disk) carries node affinity of its own: the pod can only schedule into the volume's zone. This produces the classic mystery — a Deployment with a PVC that scheduled fine for months suddenly Pending after a node drain, with `1 node(s) had volume node affinity conflict` in the events, because the only remaining capacity is in the wrong zone. Your zone-spread constraints can even *fight* the volume: spread says "go to zone b", the disk says "you live in zone a".

The fix direction is `volumeBindingMode: WaitForFirstConsumer` on the StorageClass — it delays volume creation until the pod is scheduled, so the disk is provisioned in whatever zone the scheduler picked instead of the scheduler being hostage to a disk provisioned earlier. Most modern default StorageClasses do this; if yours doesn't, that's a platform-team ask. Full story in [Storage: PVs and PVCs](/stateful/storage-pv-pvc/).

## Debugging placement

**Pending pod:** `kubectl describe pod` and read the `FailedScheduling` tally — every count maps to one of the mechanisms above (taint → tolerations, `didn't match node selector/affinity` → labels, `Insufficient cpu/memory` → requests vs pool size, `volume node affinity conflict` → the PVC trap, `didn't match pod anti-affinity` / `didn't satisfy topology spread` → your own spread rules). Systematic walkthrough: [Pod Pending](/troubleshooting/pod-pending/).

**Where did things actually land:**

```bash
kubectl get pods -l app=api -o wide
```

Replicas per node, and per zone, in one shot each:

```bash
kubectl get pods -l app=api -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | sort | uniq -c

kubectl get pods -l app=api -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' \
  | sort -u | xargs -I{} kubectl get node {} \
      -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}{"\n"}' | sort | uniq -c
```

```console
   3 us-east-1a
   2 us-east-1b
   3 us-east-1c
```

If the counts surprise you, remember: constraints applied at scheduling time, drift accumulated since. (What the scheduler is and where it sits in the control plane: [How Kubernetes Works](/start/how-kubernetes-works/).)

## Which tool for which job

| You want | Use |
|---|---|
| "Only nodes with label X", simple and hard | `nodeSelector` |
| "Only nodes matching an expression" / "prefer nodes like Y" | node affinity (required / preferred) |
| Keep *everyone else* off a pool | taint (platform) — you add toleration |
| Actually land on that dedicated pool | toleration **+** nodeSelector/affinity |
| Run near another workload (cache, low-latency peer) | pod affinity, usually preferred |
| Never co-locate with a specific other workload | pod anti-affinity |
| Spread your replicas evenly across zones/nodes | `topologySpreadConstraints` |
| Survive node-full contention better than batch does | `priorityClassName` (platform-defined) |
| Leave a dying node faster than 5 minutes | `NoExecute` toleration with `tolerationSeconds` |

Most services need remarkably little of this: sane requests, the zone/host double spread, and — only when there's a real hardware or isolation reason — one required node constraint. Every rule you add shrinks the feasible set, and an empty feasible set is an outage that looks like a Pending pod at 3 a.m.
