---
title: "PostgreSQL: Production Reference Architecture"
description: A complete, copy-paste-deployable HA PostgreSQL build on CloudNativePG — three instances, quorum sync, PgBouncer, S3 backups, alerts, and drills.
sidebar:
  order: 3
---

This is the build. The argument for *why* an operator, and why CloudNativePG (CNPG) specifically, lives in [PostgreSQL on Kubernetes](/stateful/postgresql/) — read that first if you're not sold. Here we deploy the whole thing: a 3-instance cluster with quorum synchronous replication, PgBouncer in front, continuous backup to S3, network policy, alerts, and the drills that prove it actually fails over.

:::note[Tuning the numbers]
The resource blocks and probe timings in this build are starting points. Derive your own from measurements with [Requests & Limits Knobs](/tuning/requests-limits-knobs/) and [Health Check Knobs](/tuning/health-check-knobs/); the method is the [Sizing Walkthrough](/tuning/sizing-walkthrough/).
:::

## Architecture

```text
                         ┌─────────────────────────────────────────────┐
  external clients ────▶ │ LoadBalancer VIP (optional, MetalLB)        │
                         └──────────────────┬──────────────────────────┘
                                            │
  in-cluster apps ──────────────────────────┤
                                            ▼
                              ┌──────────────────────────┐
                              │  Pooler: appdb-pooler-rw │  PgBouncer x2
                              │  (transaction mode)      │
                              └────────────┬─────────────┘
                                           │ follows the primary
              appdb-ro (reads) ────┐       ▼ appdb-rw (writes)
                                   │  ┌─────────┐
                              ┌────┴──│ appdb-1 │ primary ── WAL archive ──▶ S3
                              ▼       └────┬────┘                        (continuous)
                        ┌─────────┐        │ streaming replication
                        │ appdb-2 │◀───────┤ (quorum sync: ANY 1)
                        └─────────┘        ▼
                         zone-b       ┌─────────┐
                                      │ appdb-3 │  zone-c
                                      └─────────┘
```

The choices, and why:

- **3 instances, spread across zones and nodes.** One primary, two streaming replicas. Two instances can't survive losing a node *and* keep quorum-sync writes flowing; four buys little over three for most workloads.
- **Quorum synchronous replication, `ANY 1`.** The trade-off stated plainly: fully **async** means a primary that dies mid-write loses committed transactions (RPO > 0 on failover). Requiring **both** replicas sync means one slow or dead replica stalls every commit. `ANY 1` — a commit waits for *either* replica to acknowledge — is the sweet spot: zero data loss on single-node failure, and one replica can vanish without freezing writes. You pay one intra-cluster network round-trip per commit (typically sub-millisecond on a LAN). Take that deal.
- **PgBouncer in front, transaction mode.** Postgres connections are expensive processes; app connection churn kills it. The pooler absorbs thousands of client connections into ~20 server connections, and it follows the primary across failovers so apps reconnect to a stable name.
- **Continuous backup to S3-compatible object storage.** Base backups nightly, WAL archived continuously — your RPO for full-cluster disasters is roughly the WAL archive interval (≤ 5 minutes), and you get point-in-time recovery.
- **Optional external VIP** via a LoadBalancer Service from [MetalLB](/controllers/metallb/), because Postgres is raw TCP — HTTP Ingress doesn't apply; see [TCP ingress](/networking/tcp-ingress/).

## Prerequisites: what to ask the platform team for

Everything below is namespaced and yours. Three things aren't — file the [platform team request](/operations/working-with-platform-team/) early:

1. **CNPG operator installed.** CRDs are cluster-scoped and the operator needs broad RBAC; this is exactly the split described in [operators for stateful workloads](/stateful/operators-for-state/). Ask for CNPG ≥ 1.25 and note which namespace it runs in (usually `cnpg-system`) — you'll need that for NetworkPolicy.
2. **A database-suitable StorageClass.** Ask two questions: *what's the fsync latency?* (Postgres commits are gated on it; you want low-single-digit ms, ideally local NVMe or fast SAN) and *does the storage layer replicate?* The double-replication question, answered honestly: Postgres is already keeping three copies via streaming replication. Storage that replicates each volume 3× again gives you nine copies and every write paying two replication taxes. **Prefer a non-replicated (or replica-count-1) StorageClass for CNPG volumes** — the operator rebuilds a lost replica from the primary or from backup, so per-volume durability is redundant. If the platform only offers replicated storage, accept the cost knowingly. Details in [storage controllers](/controllers/storage-controllers/).
3. **An S3-compatible bucket + credentials** (MinIO, Ceph RGW, actual S3 — anything Barman Cloud speaks). Optionally, **a MetalLB IP** if external clients exist.

## The manifests

Apply in this order. All in namespace `payments` — substitute yours consistently.

### 1. Secrets

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: appdb-app-user
  namespace: payments
type: kubernetes.io/basic-auth        # CNPG requires basic-auth type for user secrets
stringData:
  username: app
  password: "REPLACE-with-generated-password"   # or omit this Secret entirely and
---                                             # CNPG generates one named appdb-app
apiVersion: v1
kind: Secret
metadata:
  name: appdb-backup-creds
  namespace: payments
type: Opaque
stringData:
  ACCESS_KEY_ID: "REPLACE"
  SECRET_ACCESS_KEY: "REPLACE"
```

Letting CNPG generate the app credential (`appdb-app`) is fine; a pre-created Secret is easier when CI/CD or external-secrets already owns credential lifecycle. Pick one, don't do both.

### 2. The Cluster CR

This is the heart of the build — every field annotated.

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: appdb
  namespace: payments
spec:
  instances: 3                                  # 1 primary + 2 replicas
  imageName: ghcr.io/cloudnative-pg/postgresql:16.6   # PIN the minor. Never :16 —
                                                # rolling updates must be YOUR decision
  primaryUpdateStrategy: supervised             # prod: operator prepares the update but
                                                # waits for you to trigger the primary
                                                # switchover (kubectl cnpg promote).
                                                # 'unsupervised' is fine for staging;
                                                # in prod you want the brief write blip
                                                # to happen in a window you chose.
  bootstrap:
    initdb:
      database: app
      owner: app
      secret:
        name: appdb-app-user                    # omit to let CNPG generate

  storage:
    size: 100Gi
    storageClass: fast-ssd                      # the non-replicated one you asked for
  walStorage:                                   # WAL on its OWN volume:
    size: 20Gi                                  # - sequential WAL writes don't contend
    storageClass: fast-ssd                      #   with random data-file I/O
                                                # - a WAL-flood (broken archiving) fills
                                                #   THIS volume, not the data volume

  resources:                                    # requests == limits => Guaranteed QoS:
    requests: { cpu: "2", memory: 8Gi }         # the database is last in line for
    limits:   { cpu: "2", memory: 8Gi }         # eviction. Non-negotiable for prod.
                                                # See /workloads/resources-and-qos/

  postgresql:
    synchronous:                                # quorum sync: commit waits for ANY 1
      method: any                               # of the 2 replicas to ack. Zero data
      number: 1                                 # loss on single failure; one replica
                                                # can die without stalling writes.
                                                # (Legacy fields minSyncReplicas/
                                                # maxSyncReplicas: 1/1 do the same on
                                                # older CNPG.)
    parameters:
      max_connections: "120"                    # LOW on purpose — PgBouncer multiplexes
                                                # in front. High max_connections + pooler
                                                # is paying for the pooler twice.
      shared_buffers: 2GB                       # ~25% of the 8Gi memory limit
      effective_cache_size: 6GB                 # ~75%: planner hint, not an allocation
      work_mem: 16MB                            # per sort/hash PER NODE — keep modest
      maintenance_work_mem: 512MB               # vacuum/index builds
      max_wal_size: 4GB                         # fits comfortably in the 20Gi WAL volume
      checkpoint_completion_target: "0.9"
      random_page_cost: "1.1"                   # SSD; default 4.0 assumes spinning rust
      # Do NOT set wal_level, archive_command, hot_standby, etc. —
      # CNPG manages them (wal_level=logical, archiving via Barman).

  affinity:
    podAntiAffinityType: required               # hard rule: never two instances on one
    topologyKey: kubernetes.io/hostname         # node. 'preferred' lets the scheduler
                                                # cheat under pressure — don't.
  topologySpreadConstraints:
    - maxSkew: 1                                # and spread across zones, so a zone
      topologyKey: topology.kubernetes.io/zone  # outage takes at most one instance
      whenUnsatisfiable: ScheduleAnyway         # (soft: single-zone clusters still work)
      labelSelector:
        matchLabels:
          cnpg.io/cluster: appdb

  monitoring:
    enablePodMonitor: true                      # CNPG creates the PodMonitor; metrics
                                                # on :9187 flow to Prometheus

  backup:
    retentionPolicy: "30d"                      # CNPG prunes base backups + WAL beyond
    barmanObjectStore:                          # a 30-day PITR window
      destinationPath: s3://db-backups/appdb/
      endpointURL: https://s3.internal.example.com   # your S3-compatible endpoint
      s3Credentials:
        accessKeyId:
          name: appdb-backup-creds
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: appdb-backup-creds
          key: SECRET_ACCESS_KEY
      wal:
        compression: gzip
        maxParallel: 4                          # parallel WAL upload keeps archiving
      data:                                     # ahead of WAL production under load
        compression: gzip
        jobs: 2
```

:::caution[WAL archiving is your RPO]
The primary archives each 16 MB WAL segment as it fills, and force-switches at `archive_timeout` (CNPG default 5 min). A **whole-cluster** disaster loses at most that window. If archiving breaks, WAL piles up on the `walStorage` volume until it fills and Postgres stops accepting writes — that's why the archiver alert below is non-optional. Newer CNPG deprecates in-tree `barmanObjectStore` in favor of the Barman Cloud *plugin*; the in-tree form above still works and is the widely-deployed shape — check your operator version's docs before copying blindly.
:::

### 3. ScheduledBackup — nightly base backup

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: appdb-nightly
  namespace: payments
spec:
  schedule: "0 0 2 * * *"       # SIX fields (seconds first) — CNPG cron, not crontab.
  cluster:                      # 02:00 every night
    name: appdb
  backupOwnerReference: self
  immediate: true               # take one backup right now — you are not protected
                                # until the first base backup exists
```

**Point-in-time recovery in one paragraph:** the nightly base backup is a starting snapshot; the continuously-archived WAL is every change since. Restore = pick the newest base backup before your target time, replay WAL to the exact second (say, right before the bad `DELETE`). CNPG does this declaratively via `bootstrap.recovery` with a `targetTime` — shown in the verification drill below. Retention of "30d" means any moment in the last 30 days is recoverable.

### 4. Pooler — PgBouncer in front

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata:
  name: appdb-pooler-rw
  namespace: payments
spec:
  cluster:
    name: appdb
  instances: 2                  # two PgBouncers: pooler outage ≠ database outage
  type: rw                      # follows the primary across failovers
  pgbouncer:
    poolMode: transaction       # server connection held only per-transaction —
    parameters:                 # maximum multiplexing
      max_client_conn: "1000"   # app-side connections absorbed
      default_pool_size: "20"   # server connections per user/db pair — this is why
                                # max_connections=120 is plenty
```

:::note[When transaction mode bites]
Transaction pooling breaks anything that assumes a *session*: `LISTEN/NOTIFY`, advisory locks held across transactions, `SET` without `LOCAL`, and — historically — named prepared statements. Modern PgBouncer (≥ 1.21, which CNPG ships) supports protocol-level prepared statements in transaction mode via `max_prepared_statements`, so most ORMs are fine. If your app genuinely needs sessions, deploy a second Pooler with `poolMode: session` for that traffic and keep everything else on transaction mode.
:::

### 5. Services — who connects to what

You wrote zero Service manifests; CNPG creates three per cluster:

| Service | Points at | Use for |
|---|---|---|
| `appdb-rw` | the current primary, always | writes (apps not using the pooler) |
| `appdb-ro` | replicas only | read scaling |
| `appdb-r` | any instance | rarely — diagnostics |

Apps should connect to **`appdb-pooler-rw:5432`** (the Pooler's Service) for read-write traffic, or to `appdb-rw` directly if connection counts are genuinely low. Read scaling via `appdb-ro` comes with an honesty clause: replicas are *eventually* consistent with the primary — normally milliseconds behind, but a replica rebuilding or lagging serves stale reads. Fine for dashboards and search; wrong for read-your-own-writes flows.

**Optional external exposure** — a LoadBalancer Service in front of the pooler:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: appdb-external
  namespace: payments
  annotations:
    metallb.io/loadBalancerIPs: 10.20.30.44   # from your MetalLB allocation
spec:
  type: LoadBalancer
  selector:
    cnpg.io/poolerName: appdb-pooler-rw       # PgBouncer pods, not Postgres pods
  ports:
    - name: postgres
      port: 5432
      targetPort: 5432
```

:::caution[Idle TCP connections through an L4 VIP]
Long-lived idle Postgres connections through any L4 path get silently dropped by conntrack/firewall idle timeouts, and the client finds out on its next query with a hung socket. Set client-side keepalives (`keepalives_idle=60` in the DSN) or PgBouncer's `server_check_delay`. The full story is in [TCP ingress](/networking/tcp-ingress/).
:::

### 6. NetworkPolicy — who may reach 5432

Default-deny is assumed (see [network policies](/networking/network-policies/)); this admits exactly the flows the architecture needs:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: appdb-ingress
  namespace: payments
spec:
  podSelector:
    matchLabels:
      cnpg.io/cluster: appdb
  policyTypes: [Ingress]
  ingress:
    - from:                                      # replication between instances
        - podSelector:
            matchLabels: { cnpg.io/cluster: appdb }
      ports: [{ port: 5432 }]
    - from:                                      # PgBouncer -> Postgres
        - podSelector:
            matchLabels: { cnpg.io/poolerName: appdb-pooler-rw }
      ports: [{ port: 5432 }]
    - from:                                      # apps that skip the pooler
        - podSelector:
            matchLabels: { app.kubernetes.io/part-of: payments-app }
      ports: [{ port: 5432 }]
    - from:                                      # operator -> instance manager API
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: cnpg-system }
      ports: [{ port: 8000 }]
    - from:                                      # Prometheus -> metrics
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: monitoring }
      ports: [{ port: 9187 }]
```

The operator port (8000) and instance-to-instance 5432 are the two rules people forget; missing either turns "apply NetworkPolicy" into "why is failover broken."

### 7. The five alerts that matter

`enablePodMonitor: true` already ships metrics. Wire these into your [alerting](/observability/alerting/) stack — PromQL sketches, tune thresholds to taste:

| Alert | PromQL sketch | Why |
|---|---|---|
| Replication lag | `max(cnpg_pg_replication_lag{cluster="appdb"}) > 30` | a lagging replica weakens quorum sync and serves stale `-ro` reads |
| WAL archiving failing | `cnpg_pg_stat_archiver_seconds_since_last_archival{cluster="appdb"} > 900` | broken archiving = growing RPO *and* a WAL volume filling toward outage |
| Backup too old | `time() - cnpg_collector_last_available_backup_timestamp{cluster="appdb"} > 129600` | a nightly backup older than 36 h means the schedule is silently broken |
| Connections near max | `sum(cnpg_backends_total{cluster="appdb"}) > 100` | 80%+ of `max_connections=120`: something is bypassing the pooler or leaking |
| Disk usage | `kubelet_volume_stats_used_bytes{namespace="payments", persistentvolumeclaim=~"appdb-.*"} / kubelet_volume_stats_capacity_bytes > 0.8` | Postgres out of disk stops writes; WAL volume filling is the archiver alert's late symptom |

## Verification: prove it, don't assume it

Install the plugin once: `kubectl krew install cnpg`.

**1. Cluster health.**

```console
$ kubectl get cluster -n payments appdb
NAME    AGE   INSTANCES   READY   STATUS                     PRIMARY
appdb   12m   3           3       Cluster in healthy state   appdb-1

$ kubectl cnpg status -n payments appdb
# Expect: "Continuous Backup status: Working", streaming replication
# section showing both replicas, one marked "quorum" sync state.
```

**2. Write/read split.** Write through the pooler, read from a replica:

```bash
kubectl run -n payments psql --rm -it --image=ghcr.io/cloudnative-pg/postgresql:16.6 -- bash
psql "host=appdb-pooler-rw user=app dbname=app" \
  -c "CREATE TABLE canary(ts timestamptz); INSERT INTO canary VALUES (now());"
psql "host=appdb-ro user=app dbname=app" -c "TABLE canary;"   # row appears ≈instantly
```

**3. Controlled switchover.** Time it — this is your planned-maintenance blip:

```console
$ kubectl cnpg promote appdb appdb-2 -n payments
# Watch: kubectl get cluster -n payments appdb -w
# Expect "Switchover in progress" -> healthy with PRIMARY appdb-2 in ~5-15 s.
# Apps on the pooler see a burst of connection resets, then normal service.
```

**4. Kill-the-primary drill.** Unattended failover, the thing you actually bought:

```bash
kubectl delete pod -n payments appdb-2 --grace-period=0 --force
```

Expect the operator to promote the most-advanced replica within roughly 10–30 seconds (failover detection + promotion). With `ANY 1` sync, **zero committed transactions lost**. Through the pooler, apps see in-flight queries fail and new connections stall for the failover window, then recover with no config change. Run this in staging until nobody flinches.

**5. Backup-and-RESTORE drill.** The rule from [backup and DR](/stateful/backup-and-dr/): *an untested backup is a rumor.* Restore into a scratch namespace via bootstrap recovery:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: appdb-restore
  namespace: restore-test
spec:
  instances: 1
  imageName: ghcr.io/cloudnative-pg/postgresql:16.6
  storage: { size: 100Gi, storageClass: fast-ssd }
  bootstrap:
    recovery:
      source: appdb-origin
      recoveryTarget:
        targetTime: "2026-07-03 04:00:00+00"   # optional: PITR to this instant;
  externalClusters:                            # omit for latest available
    - name: appdb-origin
      barmanObjectStore:
        destinationPath: s3://db-backups/appdb/
        endpointURL: https://s3.internal.example.com
        s3Credentials:
          accessKeyId: { name: appdb-backup-creds, key: ACCESS_KEY_ID }
          secretAccessKey: { name: appdb-backup-creds, key: SECRET_ACCESS_KEY }
```

Verify the canary row exists, note how long the restore took (that's your real RTO), delete the namespace. Do this quarterly, minimum.

**6. Drain test.** `kubectl drain <node-running-a-replica> --ignore-daemonsets --delete-emptydir-data` — the replica reschedules and re-attaches (or rebuilds) with the cluster staying `READY 3/3` writable throughout. Draining the primary's node should trigger the same clean switchover as drill 3, because CNPG registers a PodDisruptionBudget and handles the eviction.

## Failure modes

| Failure | What happens | Data loss? |
|---|---|---|
| Primary pod/node lost | Operator promotes the most-advanced replica in ~10–30 s; pooler and `-rw` re-point automatically | None with `ANY 1` sync; async-only clusters lose the un-replicated tail |
| One replica lost | Cluster stays writable (quorum still satisfiable via the other replica); operator rebuilds the replica from the primary or from backup, unattended | None |
| Storage full | Postgres stops accepting writes. Usual culprit: **broken WAL archiving** silently accumulating segments — check the archiver alert first. Recovery: fix archiving, then resize via the [PVC expansion path](/stateful/storage-pv-pvc/) | None if caught; a hard-stop is an outage, not corruption |
| Split-brain | Prevented by design: the operator is the single promoter, fences the old primary before promotion, and a returning old primary demotes itself (pg_rewind/re-clone) rather than resuming writes | N/A — this is *the* reason not to hand-roll HA |
| Operator down | Data plane unaffected: primary serves, replication continues, existing Services route. But **no failover and no new backups until it returns** — a platform-team page, not a DIY fix | None directly; you're running without a safety net |
| Pooler saturated | `max_client_conn` reached: new clients queue then error; DB itself is fine. Scale `instances`, raise `default_pool_size` only if `max_connections` headroom exists | None |

## Sizing quick reference

| | Small | Medium | Large |
|---|---|---|---|
| Instances | 2 (async) or 3 | 3 | 3 + replica cluster for DR |
| CPU / memory (each) | 1 / 4Gi | 2 / 8Gi (this build) | 8 / 32Gi |
| `shared_buffers` | 1GB | 2GB | 8GB |
| Storage (data + WAL) | 50Gi + 10Gi | 100Gi + 20Gi | 1Ti + 100Gi |
| Pooler | 1 instance | 2 instances | 3 instances, split rw/ro poolers |

Day-2 in brief: **minor version updates** are a one-line `imageName` bump — the operator rolls replicas first, then (under `supervised`) waits for you to trigger the primary switchover. **Major version upgrades** are not rolling: plan a logical dump/restore or a blue/green via logical replication into a new Cluster. Both, plus vacuum/bloat/slot hygiene, are covered in [PostgreSQL on Kubernetes](/stateful/postgresql/).
