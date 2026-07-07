---
title: Stateful Workloads Overview
description: Should you run databases and queues on Kubernetes at all? An honest decision framework, and a map of this section.
sidebar:
  order: 1
---

Stateless services are what Kubernetes was built for. Kill a pod, another one comes up, nobody notices. State breaks that model: a database pod that dies takes its data's availability with it, and "just reschedule it" now involves volume attachment, replication, failover, and the question of whether the new pod even has the same identity as the old one.

You *can* run state on Kubernetes well. Plenty of teams do. But the honest first question isn't "how" — it's "should we".

:::note[Who this section is for]
Application teams with namespace-scoped access on a platform-managed cluster. That constraint shapes every recommendation here: StorageClasses, operators, snapshot infrastructure, and Velero are all things you *use* but the platform team *installs*. Each article flags those handoff points explicitly.
:::

Running state for the first time? The ["Running state" track on Learning Paths](/learning-paths/) sequences this section with the reference architectures and backup drills.

## The decision framework

Work down this list. Stop at the first option you can actually use.

### 1. Managed service (RDS, Cloud SQL, ElastiCache, cloud MQ...)

If your organization has a managed database offering — cloud or an internal DBA-run platform — use it and connect from your pods. You get backups, patching, failover, and someone else on the pager. Kubernetes-side, your "database" is a `Secret` with a connection string and maybe an `ExternalName` Service (see [Oracle](/stateful/oracle/) for off-cluster connection patterns — they apply to any external database).

Choose this when: the service exists, latency to it is acceptable, and cost isn't prohibitive. This is the right answer more often than Kubernetes enthusiasts want to admit.

### 2. Operator-managed on Kubernetes

A good operator (CloudNativePG for Postgres, Strimzi for Kafka, the RabbitMQ cluster operator) encodes the operational knowledge — failover orchestration, backup scheduling, safe upgrades — that you would otherwise have to script yourself at 3 a.m. You declare a CR like `Cluster` with `instances: 3`; the operator does the rest.

Choose this when: no managed service fits, the technology has a mature operator, and your platform team will install its [CRDs](/controllers/crds-explained/). That last part matters — the CRDs and usually the operator itself are cluster-scoped installs, which in the environment this guide assumes means **a platform team request**, not a `helm install` you run yourself. See [Operators for State](/stateful/operators-for-state/) for how to evaluate one and how the install conversation goes.

### 3. Raw StatefulSet

You write the StatefulSet, the headless Service, the PodDisruptionBudget, the backup CronJob, and — critically — you own failover. For a single-instance Valkey cache or a dev-tier Postgres this is fine. For an HA production database it's a trap: streaming replication plus automated failover is exactly the domain logic operators exist to encode, and hand-rolling it is how you get split-brain.

Choose this when: single instance is acceptable, the data is rebuildable or backed up externally, or the technology genuinely has no decent operator.

:::tip[The one-line heuristic]
If losing five minutes of this data would page an executive, don't run it as a raw StatefulSet. Managed service or a battle-tested operator.
:::

### A worked example

Say your team needs Postgres for a new order-management service, plus a cache. Walking the framework:

- **Postgres**: your company has RDS. Latency from the cluster is 1.5 ms, cost is approved. → Managed service. Done; on-cluster you have a `Secret` and a connection pooler.
- **Cache**: ElastiCache exists but the approval process takes six weeks and this is a rebuildable read cache. → On-cluster, and since losing it costs only warm-up time, not data, it doesn't even need a StatefulSet — a Valkey **Deployment** with no persistence. [Valkey and Redis](/stateful/valkey-and-redis/) walks through exactly this call.
- Six months later you need Kafka, there's no managed offering, and Strimzi is a mature operator. → Option 2: file the platform-team request for the operator, own the `Kafka` CR yourself.

Different answers for different datasets, all in one system. That's normal. Resist the urge to standardize on one option for everything.

Two forces worth naming because they quietly bias the decision:

- **Data gravity.** Compute is easy to move; 2TB of data is not. Whatever you choose, you'll live with for years. Spend the extra week deciding.
- **Latency.** An on-cluster cache answers in microseconds over the pod network; a managed service in another VPC might be 2 ms away. For a cache hit path, that difference can *be* the argument for on-cluster.

## What Kubernetes gives you for state — and what it doesn't

Worth being precise, because both lists surprise people.

**You get:**

- Scheduling and restart: a crashed database process comes back without a human.
- Persistent volumes that follow the pod across node failures (on network-attached storage).
- Declarative config in git, same pipeline as your apps — a database defined in 40 reviewable lines.
- Disruption coordination: PodDisruptionBudgets make node drains respect your quorum.
- A uniform observability plane — the same metrics/logs/alerts stack as everything else.

**You do not get:**

- Failover. Kubernetes restarts *processes*; it does not know a Postgres replica must be promoted, or that two queue-manager pods with the same identity is a catastrophe.
- Backups. Nothing in core Kubernetes backs up anything, ever.
- Data-aware upgrades. A rolling update will happily roll a database in an order that loses quorum.
- Protection from deletion. `kubectl delete ns` does not ask whether the PVCs held prod data.

Everything in the second list is either an operator's job or your job. Most of this section is about making sure it's the former.

## What "state on k8s" actually costs you

Be clear-eyed about the ongoing work, whichever on-cluster option you pick:

- **Storage literacy.** You need to understand PV/PVC binding, access modes, and what your cluster's StorageClasses actually give you (local NVMe? replicated SAN? NFS?). Performance and failure characteristics differ wildly.
- **Backups you have tested.** Not backups you have configured — backups you have *restored*. See [Backup and DR](/stateful/backup-and-dr/).
- **Upgrade discipline.** Database version upgrades on Kubernetes are deliberate operations, not `latest` tags.
- **Disruption awareness.** Node drains happen without warning to you. PodDisruptionBudgets and graceful shutdown are not optional for quorum-based systems.
- **A pager reality.** Someone on *your* team now gets the "replication lag" and "disk 85% full" alerts. If nobody on the team wants that page, that's the framework telling you to pick option 1.

## What's in this section

| Article | What it covers |
|---|---|
| [StatefulSets Fundamentals](/stateful/statefulsets-fundamentals/) | Stable identity, ordered rollout, volumeClaimTemplates, and the classic gotchas (immutable volume claims, stuck rollouts). |
| [Storage: PV, PVC, StorageClass](/stateful/storage-pv-pvc/) | The storage model, access modes and what they mean for HA, expansion, reclaim policies, and what to ask your platform team for. |
| [Valkey and Redis](/stateful/valkey-and-redis/) | Cache vs store, persistence tradeoffs, Sentinel and Cluster topologies, memory limits vs `maxmemory`. |
| [PostgreSQL](/stateful/postgresql/) | Run it with CloudNativePG. Cluster CRs, backups to object storage, pooling, and why DIY Postgres HA fails. |
| [Oracle](/stateful/oracle/) | The licensing minefield, OraOperator, and why "keep it off-cluster and connect" is usually right. |
| [Message Queues](/stateful/message-queues/) | IBM MQ, RabbitMQ, Artemis, Kafka — quorum safety, identity, and client reconnect behavior. |
| [Operators for State](/stateful/operators-for-state/) | Why databases need operators, how to evaluate one, and installing in clusters where you're not admin. |
| [Backup and DR](/stateful/backup-and-dr/) | Dump-based backups, VolumeSnapshots, Velero, and why an untested backup is a hope, not a backup. |

## Signs you chose the wrong option

Revisit the framework when you see these:

- **You're writing failover logic in shell scripts, initContainers, or "sync sidecars".** That's option 3 pretending to be option 2. Move to an operator before the script gets its first production test.
- **The operator fights you weekly** — CRs stuck, upgrades scary, docs thin. You may have picked an immature operator; run the evaluation checklist in [Operators for State](/stateful/operators-for-state/) against alternatives, or reconsider the managed service.
- **Your team spends more time operating the database than building the product.** The managed service's cost premium suddenly looks cheap. Data-driven way to see it: count stateful-workload pages and toil hours per sprint.
- **Nobody can answer "when did we last restore a backup?"** Not strictly a wrong *option*, but the strongest predictor of a future very bad day. Fix per [Backup and DR](/stateful/backup-and-dr/) regardless of which option you chose.

Migrating between options is easier than it sounds in one direction — dump from the StatefulSet, restore into the operator-managed cluster or the managed service — and that migration path is itself a restore drill. Downgrading from managed to self-run is the move to be suspicious of; it's usually a cost argument that hasn't priced in the pager.

## Pre-flight checklist before your first stateful workload

Ten minutes of `kubectl` and one platform-team message, before you write any manifests:

```console
$ kubectl get storageclass
NAME                 PROVISIONER             RECLAIMPOLICY   VOLUMEBINDINGMODE      ALLOWVOLUMEEXPANSION
fast-ssd (default)   csi.trident.netapp.io   Delete          WaitForFirstConsumer   true
nfs-shared           csi.trident.netapp.io   Delete          Immediate              true

$ kubectl describe quota -n myapp
Name:              myapp-quota
Resource           Used   Hard
--------           ----   ----
persistentvolumeclaims  2   20
requests.storage        60Gi  500Gi

$ kubectl get volumesnapshotclass
No resources found        # ← snapshots not plumbed; add to the platform ask
```

Then confirm with the platform team:

1. Which StorageClass is intended for databases, and what physically backs it?
2. What's the reclaim policy — if we delete a PVC, is the data gone?
3. Are VolumeSnapshots available? Velero?
4. Which stateful operators are already installed (`kubectl get crd | grep -i -e postgres -e rabbit -e kafka` gives you a preview)?
5. How much notice do we get before node drains and cluster upgrades?

The answers change your design more than any tuning parameter will.

One more artifact worth creating on day one: a one-page inventory of every stateful thing your team runs — technology, option chosen (managed/operator/StatefulSet), RPO/RTO, backup mechanism, last restore drill date. It takes an hour to write and it's the first thing everyone needs in an incident.

## Prerequisites from elsewhere in this guide

Stateful workloads lean hard on concepts covered in other sections. Make sure you're solid on [resource requests, limits, and QoS](/workloads/resources-and-qos/) — databases are exactly the workloads you never want OOM-killed — and on [health checks](/workloads/health-checks/), because a wrong liveness probe on a database that's replaying WAL will restart-loop it into oblivion. If you're new to operating without cluster admin, read [Working Without Admin](/start/working-without-admin/) first; almost every article here has a "this part needs the platform team" moment.

:::note[A word on the platform team]
Running state well on a shared cluster is a partnership. You'll need them for StorageClasses, VolumeSnapshotClasses, operator installs, and sometimes dedicated node pools. Bring them a concrete request ("we need the CloudNativePG operator v1.24+, here's the CRD list") rather than a vague one, and the conversation goes ten times faster.
:::
