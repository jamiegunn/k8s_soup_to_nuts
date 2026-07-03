---
title: PostgreSQL on Kubernetes
description: Run Postgres with an operator — CloudNativePG as the modern default — plus pooling, tuning, upgrades, and the day-2 items that actually page you.
sidebar:
  order: 5
---

The short version: **run PostgreSQL on Kubernetes with an operator, period.** Not a Helm chart wrapping a StatefulSet, not hand-rolled manifests. If you remember one thing from this page, that's it. The rest is which operator and how.

:::tip[Complete build available]
For the full copy-paste build — 3-instance CloudNativePG cluster, PgBouncer, S3 backups, restore drill — see the [PostgreSQL reference architecture](/architectures/postgresql-ha/).
:::

## Why raw StatefulSet Postgres HA is a trap

A single-instance Postgres in a StatefulSet with a PVC is fine for dev. The trap is the next step: "let's add a replica for HA." Now you need:

- Streaming replication configured, with replication slots so a slow replica doesn't lose its place (and monitoring so an *abandoned* slot doesn't bloat WAL — see day-2 below).
- **Failover orchestration**: detect that the primary is actually dead (not just slow, not just partitioned from *you*), pick the most-advanced replica, promote it, repoint every other replica, repoint clients — and guarantee the old primary can never come back as a second writer.
- Fencing. That last clause is the hard one. Get it wrong and you have split-brain: two primaries accepting writes, and no clean way to merge them. That's not an outage, that's data loss with extra steps.

Kubernetes gives you none of this. A StatefulSet will happily restart the old primary as `postgres-0`, still thinking it's primary. Distributed-consensus failover for a database is precisely the domain knowledge that [operators exist to encode](/stateful/operators-for-state/). People have built careers on Patroni doing this correctly; don't rebuild it in Bash.

## CloudNativePG: the modern default

[CloudNativePG](https://cloudnative-pg.io/) (CNPG), a CNCF project originally from EDB, is the current best default. Notably it does *not* use a StatefulSet — it manages pods and PVCs directly for finer failover control — and it treats backup to object storage and replication as first-class.

The operator install is cluster-scoped (CRDs + a deployment with broad RBAC): **platform team request**. Once installed, everything you touch is a namespaced CR:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: appdb
spec:
  instances: 3                    # 1 primary + 2 streaming replicas
  imageName: ghcr.io/cloudnative-pg/postgresql:16.6

  storage:
    size: 100Gi
    storageClass: fast-ssd

  resources:
    requests: { cpu: "2", memory: 8Gi }
    limits:   { cpu: "4", memory: 8Gi }

  postgresql:
    parameters:
      shared_buffers: 2GB          # ~25% of the container limit
      effective_cache_size: 6GB
      max_connections: "200"

  backup:
    barmanObjectStore:
      destinationPath: s3://backups/appdb
      s3Credentials:
        accessKeyId:
          name: backup-creds
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: backup-creds
          key: SECRET_ACCESS_KEY
    retentionPolicy: 30d
```

What you get from those ~35 lines: automated failover with fencing, continuous WAL archiving + base backups to S3 (point-in-time recovery), and three Services out of the box — `appdb-rw` (always the primary), `appdb-ro` (replicas), `appdb-r` (any instance). Point your app's write path at `appdb-rw` and failover becomes invisible to it.

Scheduled base backups are a second tiny CR (WAL archiving is already continuous; this sets the recovery baseline):

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: appdb-nightly
spec:
  schedule: "0 15 2 * * *"      # note: 6 fields, seconds first
  cluster:
    name: appdb
  backupOwnerReference: self
```

Restore is a `bootstrap.recovery` stanza on a *new* Cluster CR — which means your [restore drill](/stateful/backup-and-dr/) is a five-line YAML change into a scratch namespace. Do it quarterly.

Day-to-day, the `kubectl cnpg` plugin (a client-side binary — no cluster install needed) is your dashboard:

```console
$ kubectl cnpg status appdb
Cluster Summary
Name:                appdb
Primary instance:    appdb-1
Instances:           3
Ready instances:     3

Instances status
Name     Current LSN  Replication role  Status  Node
appdb-1  0/6000060    Primary           OK      worker-3
appdb-2  0/6000060    Standby (sync)    OK      worker-7
appdb-3  0/6000060    Standby (async)   OK      worker-1
```

Planned failover (e.g. before you ask platform to drain a node) is a one-liner: `kubectl cnpg promote appdb appdb-2`.

### The other credible operators

- **Zalando postgres-operator** — the original Patroni-based operator, battle-tested at scale. Solid, but backup config (WAL-E/WAL-G via env vars) is clunkier and the project's momentum has shifted toward CNPG.
- **Crunchy PGO** — commercial backing, pgBackRest-based backups, popular in enterprises with support contracts.

If your platform team already operates one of these, use that one. Operator familiarity beats marginal feature differences.

## Connection pooling: PgBouncer is not optional

For clients outside the cluster, see [TCP and non-HTTP ingress](/networking/tcp-ingress/) — Postgres through an L4 load balancer has its own sharp edges (idle timeouts vs long-lived connections, client IPs).

Every Postgres connection is a backend process; `max_connections: 2000` is how you turn a database into a fork bomb. Kubernetes makes this worse: 30 app replicas × a 20-connection pool each = 600 connections doing nothing.

Put PgBouncer in front, in transaction pooling mode. CNPG ships it as a CR:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata:
  name: appdb-pooler
spec:
  cluster:
    name: appdb
  instances: 2
  type: rw
  pgbouncer:
    poolMode: transaction
    parameters:
      max_client_conn: "1000"
      default_pool_size: "20"
```

Apps connect to `appdb-pooler`; Postgres sees ~20 connections instead of 600. Caveat: transaction mode breaks session-level features (prepared statements need `SET`-up per transaction or driver support, advisory locks, `LISTEN/NOTIFY`). Most ORMs handle it with a config flag; check yours.

## Resource tuning

- **`shared_buffers` ≈ 25% of the container memory limit.** Not 25% of the node. The container's cgroup is Postgres's whole world.
- Leave the rest for the OS page cache *inside your limit* — Postgres depends on it heavily; `effective_cache_size` should reflect limit minus shared_buffers-ish.
- **Set memory request = limit** (Guaranteed QoS) so the database is last in line for eviction and never OOM-killed by a noisy neighbor's pressure. Rationale in [Resources and QoS](/workloads/resources-and-qos/).
- Watch `work_mem` × `max_connections` × parallel workers — that product is your real worst-case memory, and it's the usual cause of "Postgres OOMKilled under load."

## Upgrades

- **Minor versions** (16.5 → 16.6): binary swap, disk format unchanged. With CNPG, edit `imageName`; it rolls replicas first, then does a controlled switchover — seconds of write interruption.
- **Major versions** (15 → 16): disk format changes; this is a real migration. CNPG ≥1.26 supports declarative offline major upgrades (`pg_upgrade` under the hood, cluster down for the duration); the near-zero-downtime alternative is logical replication into a new cluster (blue/green) and a cutover. Either way: rehearse in staging with a production-sized restore, and read the release notes — extensions bite here.

## Day 2: what actually pages you

**WAL bloat / disk full.** WAL segments are retained until archived *and* until every replication slot has consumed them. A broken backup destination or an orphaned slot means WAL grows until the volume fills — and a Postgres that can't write WAL shuts down. Alert on volume usage (kubelet exposes PVC metrics — see [Metrics](/observability/metrics/)) and on `pg_replication_slots` where `active = false`. If the disk does fill: grow the PVC first ([expansion](/stateful/storage-pv-pvc/)), *then* fix the archiving; never delete WAL files by hand.

**Replication lag.** A lagging replica serves stale reads via `-ro` and, if it's your failover target, converts lag into data loss at promotion time. Monitor `pg_stat_replication` (CNPG exports `cnpg_pg_replication_lag` to Prometheus). Sustained lag usually means undersized replicas or a vacuum/long-query fight worth investigating.

**Backups you've never restored** are decoration. Schedule actual restore drills — the how and the RPO/RTO framing are in [Backup and DR](/stateful/backup-and-dr/).

:::caution[Liveness probes and databases]
Don't add aggressive liveness probes to Postgres pods the operator manages — CNPG configures its own probes correctly. A recovering primary replaying WAL can be unresponsive for minutes; a naive `pg_isready` liveness probe with a 30s window will kill it mid-recovery, forever. This is the canonical example of the [health-check foot-gun](/workloads/health-checks/).
:::
