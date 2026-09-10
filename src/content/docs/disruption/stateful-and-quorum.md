---
title: "Draining Stateful and Quorum Workloads"
description: A stateful pod evicted is a role moving, not a pod replaced — what one eviction costs Valkey, PostgreSQL, Kafka, and RabbitMQ; the one-member-at-a-time rule and its two shapes; which operators already own the PDB (and the 500 you get if you add another); and why the drain takes forty minutes.
keywords:
  - pdb for statefulset
  - maxunavailable 1 quorum kafka rabbitmq
  - does cloudnativepg create a pdb
  - strimzi poddisruptionbudget
  - valkey primary evicted during node drain
  - drain takes too long statefulset
  - quorum lost during cluster upgrade
  - two pdbs on the same pods operator
  - readiness probe resync quorum eviction
sidebar:
  order: 7
---

You are here if: you run a Valkey, PostgreSQL, Kafka, or RabbitMQ cluster inside Kubernetes and a maintenance window is coming; or one of them lost quorum during the last one; or the platform team asked why draining *your* node takes forty minutes; or you're about to write a PDB for a StatefulSet and want to know whether one already exists.

A stateless pod evicted is a pod replaced. A stateful pod evicted is a **role moving** — a primary demoting, a replica resyncing, a broker handing off partition leadership — and the drain's speed and safety are decided by how that move is orchestrated, not by the budget alone. This page is the shared reasoning; the builds themselves live in the reference architectures and are linked, not repeated.

## Quorum, in one paragraph

A quorum system stays correct as long as a majority of its members agree. Three members tolerate one loss; five tolerate two. Lose more than that and the survivors *refuse to serve* rather than risk serving lies — which is the right behavior, and which means the only disruption a quorum permits is **one member at a time, and wait until it's back before taking the next**. "Back" means fully caught up, not merely Running. Everything on this page follows from that sentence.

Two properties of StatefulSets shape how that plays out under a drain ([StatefulSets Fundamentals](/stateful/statefulsets-fundamentals/#what-a-statefulset-guarantees)):

- **At most one.** The replacement for `valkey-primary-0` *is* `valkey-primary-0` — same name, same PVC — and it cannot be created until the old one is completely gone. There is no surge. The gap per member is the full grace period plus startup plus whatever catching-up the role requires.
- **The volume decides where it lands.** A replicated block store (Longhorn) follows the pod to any node with a replica; a node-local class pins it to the drained node forever ([trap 3](/disruption/where-pods-land/#3-a-volume-that-wont-follow), and [the Field Note](/blog/the-pdb-that-blocked-the-drain/)).

## The rule and its two shapes

For three or more members, one budget shape is always right:

```yaml
spec:
  maxUnavailable: 1          # one member at a time, whatever the member count becomes
```

`minAvailable: 2` says the same thing for exactly three members — and the wrong thing the day someone scales to five (it would permit three to leave at once). Prefer the ceiling on the missing; it survives the scale.

For **role-based** topologies — a primary and its replicas, as separate StatefulSets — decide what "one at a time" has to mean, because the two ways to write it behave differently. **One PDB spanning both roles** with `maxUnavailable: 1` counts the whole set: `expectedPods` is primary + replicas, `desiredHealthy` is that minus one, and a drain may take *any* one member — the replica stays pinned while the primary is out, and vice versa. **One PDB per role** gives each role its own budget, spent independently: with a single primary and a single replica, each budget has `desiredHealthy 0` and permits its one eviction, so the two *can* be evicted concurrently. The per-role pair is what [the shared-VIP build](/architectures/valkey-shared-vip/#3g-poddisruptionbudgets) ships and [the Helm deep dive](/architectures/valkey-helm-deep-dive/#8-probes-pdb-and-data-protection--as-chart-values) templates — deliberately, as [honest singletons](/disruption/pod-disruption-budgets/#the-one-replica-honesty) that document the outage rather than block it, and because the roles want different policies (a replica mid-resync should keep the default `IfHealthyBudget`; a singleton primary needs `AlwaysAllow`). The trade: per-role budgets are honest about what they protect and let each role carry its own policy; a spanning budget is the one that actually serializes the set. If losing both roles in one window is a data-loss event, span them.

| | `maxUnavailable: 1` | `minAvailable: N−1` |
|---|---|---|
| **What you gain** | Holds after any scale; reads as the quorum rule | Reads as "keep the quorum" for today's N |
| **What you pay** | Nothing for quorum sets | Silently wrong after a scale-up; a floor colliding with the count on scale-down |

The singleton case — one Valkey, one replica of anything — gets the [honest singleton budget](/disruption/pod-disruption-budgets/#the-one-replica-honesty): `maxUnavailable: 1` **with `unhealthyPodEvictionPolicy: AlwaysAllow`**, which documents the outage instead of blocking maintenance — and, without the policy line, would still block it the day the singleton is crashlooping. [Lab 9](/labs/lab-9-valkey/) ships the shape; add the policy.

## Who owns the PDB

Before you write one, find out whether one exists. Operators increasingly manage disruption budgets themselves, and your hand-written PDB on top of theirs doesn't add safety — it produces the [overlap 500](/disruption/pod-disruption-budgets/#selectors-guard-exactly-one-thing) on every eviction, on every node, forever:

```console
Error from server: This pod has more than one PodDisruptionBudget, which the eviction subresource does not support.
```

```bash
# seat: tenant — what already exists, and who owns it
kubectl get pdb -n payments -o custom-columns=NAME:.metadata.name,OWNER:.metadata.ownerReferences[0].kind,SELECTOR:.spec.selector.matchLabels,MAX:.spec.maxUnavailable,MIN:.spec.minAvailable,ALLOWED:.status.disruptionsAllowed
```

```console
NAME               OWNER     SELECTOR                                              MAX      MIN      ALLOWED
kafka-kafka        Kafka     map[strimzi.io/cluster:kafka strimzi.io/name:kafka-kafka]   1        <none>   1
appdb-primary      Cluster   map[cnpg.io/cluster:appdb cnpg.io/instanceRole:primary]     <none>   1        0
appdb              Cluster   map[cnpg.io/cluster:appdb cnpg.io/instanceRole:replica]     <none>   1        1
valkey-primary     <none>    map[app.kubernetes.io/name:valkey role:primary]            1        <none>   1
valkey-replica     <none>    map[app.kubernetes.io/name:valkey role:replica]            1        <none>   1
```

An `OWNER` column that names a CR kind means the operator wrote it and will rewrite it if you edit it. Read `appdb-primary`'s `ALLOWED 0` correctly: that budget permits nothing **by design** — CloudNativePG keeps the primary un-evictable and moves it itself with a switchover when its node drains — so it must be exempted from the "every budget permits ≥ 1" [alert and audit](/disruption/platform-contract/#alerts-and-dashboards), not "fixed". The table for this site's builds:

| System | Who writes the PDB | Where to set it | Notes |
|---|---|---|---|
| **Kafka (Strimzi)** | The operator, from the CR | `spec.kafka.template.podDisruptionBudget.maxUnavailable` — [the Kafka CR](/architectures/kafka-strimzi/#2-the-kafka-cr) pins it to `1` | Strimzi's default is already `1`; the build pins it so nobody "simplifies" it |
| **PostgreSQL (CloudNativePG)** | The operator — one for the primary, one for the replicas | Cluster CR; `enablePDB` toggles it | The operator also performs a **switchover** when the primary's node is drained — the eviction becomes a planned promotion ([the drill](/architectures/postgresql-ha/#verification-prove-it-dont-assume-it)) |
| **RabbitMQ (cluster operator)** | **You** — the operator does not create one | Apply it yourself: [§4 of the build](/architectures/rabbitmq/#4-poddisruptionbudget) | `maxUnavailable: 1`, *not* `minAvailable: 1` — the latter permits evicting two of three, which is quorum loss for every quorum queue |
| **Valkey (this site's builds)** | You, via the chart — one per role | [Shared-VIP §3g](/architectures/valkey-shared-vip/#3g-poddisruptionbudgets); [the Helm deep dive](/architectures/valkey-helm-deep-dive/) | A Valkey operator or a Sentinel chart may manage its own — check `OWNER` first |
| **IBM MQ, Oracle, the external Redis** | Not in the cluster — nothing to evict | — | Your *consumers* get evicted; the broker requeues ([the messaging page](/autoscaling/messaging-consumers/)) |

Whoever owns it, the one thing you do own is `unhealthyPodEvictionPolicy` on budgets you wrote — and here it's the one place on this site where the default is the right answer, below.

## What one eviction costs

The budget says *whether*. The system decides *how much*. Per member, what a granted eviction actually does — and what "back" means before the budget should permit the next one. A few terms from the builds, in one sentence each: a Valkey replica's **`master_link_status`** is its own report of whether it's connected to and caught up with its primary; the **AOF** is Valkey's on-disk log, replayed on start; a PostgreSQL replica is **streaming** when it's applying the primary's write-ahead log with near-zero lag, and the **pooler** is the PgBouncer in front of it; Kafka's **ISR** is the set of in-sync replicas for a partition, and **`minISR`** how many of them a write must reach.

| System · role | What happens on eviction | The gap users feel | "Back" means | Where the build works it |
|---|---|---|---|---|
| **Valkey primary** (StatefulSet, async replica, [manual failover](/architectures/valkey-shared-vip/)) | `valkey-primary-0` terminates; the StatefulSet recreates it on another node on the same Longhorn volume | **Writes down** for `G` + start + AOF load — a minute or so; reads continue on the replica | Pod Ready *and* the replica reports `master_link_status:up` again | [Shared-VIP §6](/architectures/valkey-shared-vip/#6-operations-notes) |
| **Valkey primary** (Sentinel or an operator) | Sentinel promotes a replica in seconds; the evicted pod comes back as a replica | A reconnect for clients that follow Sentinel | New primary elected, old one resynced as replica | [Valkey and Redis](/stateful/valkey-and-redis/) |
| **Valkey replica** | Recreated; full resync from the primary | Read capacity down by one replica; primary spends bandwidth on the resync | `master_link_status:up` — the role-aware readiness probe is the load-bearing line | [Shared-VIP §3d](/architectures/valkey-shared-vip/#3d-statefulset-valkey-replica) |
| **PostgreSQL primary** (CNPG) | The operator switches over *before* the eviction proceeds | A 5–15 s write blip while clients re-point via the pooler | New primary `READY`, old one back as a streaming replica | [The drills](/architectures/postgresql-ha/#verification-prove-it-dont-assume-it) |
| **PostgreSQL replica** (CNPG) | Recreated; re-attaches to its volume or rebuilds from backup | None for writes; one fewer read replica | Streaming, lag near zero | same |
| **Kafka broker** (Strimzi) | Partition leadership moves to in-sync replicas; the broker restarts and catches up | Producers/consumers rebalance once; latency blip | Broker rejoined **every** ISR it belongs to — `minISR` satisfiable again | [Kafka failure modes](/architectures/kafka-strimzi/#failure-modes) |
| **RabbitMQ node** | Quorum queues elect new leaders for the queues this node led | A reconnect storm if clients don't back off; message flow pauses per queue for the election | Node rejoined; all quorum queues have a full member set | [RabbitMQ failure modes](/architectures/rabbitmq/#failure-modes) |

Two things to take from the table. First, **the SLO thread's quorum rung**: a replica lost is *degraded capacity*; a primary lost is a *write outage of failover-time seconds* — the latency SLO decides whether a minute of manual failover is acceptable ([Valkey shared-VIP is honest that it is only sometimes](/architectures/valkey-shared-vip/)) or whether you need the operator with automatic promotion. Second, **"back" is a data condition, not a pod condition** — which is the whole next section.

## Readiness is the whole game

The budget counts Ready pods. If a member reports Ready *before* it has caught up — before the replica's `master_link_status` is `up`, before the broker has rejoined its ISRs, before the standby is streaming — the budget sees a full set, permits the next eviction, and the drain takes a second member while the first is still empty. Quorum lost, with perfect paperwork.

So for stateful sets the readiness probe is not a health check; it is the budget's *only* source of truth about whether the previous move finished. The [zero-downtime page's](/architectures/zero-downtime/) line — "lying readiness breaks the PDB too" — has teeth here:

- Valkey replica: readiness on `master_link_status:up` (with the promotion-aware OR clause the [shared-VIP build](/architectures/valkey-shared-vip/#3d-statefulset-valkey-replica) explains at length).
- Kafka: Strimzi's readiness already waits for the broker to rejoin — don't loosen it to "make drains faster."
- PostgreSQL: CNPG's readiness reflects streaming state — same.
- RabbitMQ: the operator's probes are tuned for cluster membership ([§3 of the build](/architectures/rabbitmq/#3-probes-what-the-operator-sets-and-what-to-tune)).

:::caution[AlwaysAllow and quorum members]
On stateless workloads this site recommends `unhealthyPodEvictionPolicy: AlwaysAllow`. On a quorum set, think twice: a member that is Running-but-not-Ready is often a member **mid-resync** — holding data the others may still need to catch up from, and one eviction away from a second simultaneous loss. Prefer the default `IfHealthyBudget` on budgets you write for quorum sets, and leave operator-managed budgets alone. The trade: a genuinely broken member can block a drain until you fix it — which, for a database, is the correct escalation.
:::

## Why the drain takes forty minutes

Sequential by construction. For each member on the node, in series: the grace period (a database's `G` is rightly long — a clean checkpoint or handoff), then startup, then the catch-up until readiness *honestly* says back, then the budget permits the next. With the cast's Valkey — `G` 60 s, ~30 s to load a 4 GiB AOF, a replica resync that saturates for two minutes — three members on one node is `3 × (60 + 30 + 120) ≈ 10 minutes`, before the drain even reaches the stateless pods. A 20 GiB dataset and a Kafka broker with a large log make forty minutes ordinary.

The dishonest fix is a bigger `maxUnavailable`, which converts a slow drain into a quorum loss. The honest ones:

- **Readiness that reflects real catch-up** — so the budget doesn't *wait longer than it must* (a probe that waits an extra minute "to be safe" is a minute per member per drain).
- **Smaller members** — more, smaller partitions; shorter resyncs.
- **A `G` sized to the real handoff**, not to a fear ([the drain-side dual](/disruption/anatomy-of-a-drain/#5-the-drain-waits-for-each-pod-to-be-gone)).
- **The calendar** — tell the platform team which nodes host quorum members and how long each takes; a drain they *expect* to take twenty minutes doesn't page anyone. [The contract page](/disruption/platform-contract/) has the wording.

:::tip[Good citizen]
Your quorum set's drain time is a number the platform team waits out, one member at a time, on every window. Write it down (from the last drain's timestamps — the `Killing` events are the record), give it to them, and keep it honest. "It takes as long as it takes" is not a number.
:::

## The storage question, revisited

Everything above assumes the member's volume follows it to the next node. If it doesn't — `local-path`, `hostPath`, a zone-pinned disk on a cluster where the zone is the node — the eviction produces a pod that orbits the drained node forever with `volume node affinity conflict` ([trap 3](/disruption/where-pods-land/#3-a-volume-that-wont-follow)). For a quorum member that's worse than a stalled drain: the set is one-down until a human intervenes, and the budget correctly refuses every other eviction meanwhile. Audit before the window; [the Longhorn deep dive](/architectures/valkey-longhorn-deep-dive/) is how a replicated volume actually follows a Valkey pod, and why the replica count there is a *drain* setting as much as a durability one.

## Who owns what

| Concern | PLATFORM team | YOU |
|---|---|---|
| Storage classes that follow the pod | ✔ provides | ✔ choose them for every member |
| Drain timeout long enough for a quorum set's serial moves | ✔ sets | ✔ tell them the measured number |
| Which nodes host quorum members (for their planning) | | ✔ tell them; spread across nodes/zones |
| The PDB — or knowing the operator owns it | | ✔ per role; never overlapping |
| Readiness that means "caught up" | | ✔ |
| `unhealthyPodEvictionPolicy` left at the default on quorum budgets | | ✔ |

## Where next

- **Next in the journey:** [When Nobody Asked](/disruption/involuntary-disruptions/) — the node that dies without draining is the case a quorum exists for, and StatefulSets recover from it differently.
- **The lateral jump:** the build you actually run — [Valkey shared-VIP](/architectures/valkey-shared-vip/), [PostgreSQL HA](/architectures/postgresql-ha/), [Kafka on Strimzi](/architectures/kafka-strimzi/), [RabbitMQ](/architectures/rabbitmq/) — each carries its PDB with the reasoning above applied.
