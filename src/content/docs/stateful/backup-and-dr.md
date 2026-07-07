---
title: Backup and Disaster Recovery
description: Backup layers for stateful workloads on Kubernetes — app-native dumps, VolumeSnapshots, Velero — and why an unrestored backup is a hope, not a backup.
sidebar:
  order: 9
---

Kubernetes gives your data exactly zero durability guarantees beyond what the storage layer provides. A PVC on `Delete` reclaim policy is one namespace prune away from oblivion; a PVC on replicated storage still won't save you from `DROP TABLE`, ransomware, or a fat-fingered migration. Backups protect against *logical* destruction, and no amount of replication substitutes for them — replication faithfully replicates your mistakes.

Three levels of backup exist on Kubernetes. Most production stateful workloads want two of them.

## Level 1: app-native dumps via CronJobs

The database's own dump tooling, run on a schedule, shipped to object storage. Lowest-tech, most portable, and the only level that gives you a **restore-anywhere** artifact — a `pg_dump` restores onto RDS, a laptop, or a different cluster without any CSI compatibility questions.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: pgdump-appdb
spec:
  schedule: "15 2 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      activeDeadlineSeconds: 3600
      backoffLimit: 1
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: dump
              image: postgres:16
              command: ["/bin/sh", "-c"]
              args:
                - |
                  set -euo pipefail
                  TS=$(date +%Y%m%d-%H%M%S)
                  pg_dump "$DATABASE_URL" -Fc -f /tmp/appdb-$TS.dump
                  aws s3 cp /tmp/appdb-$TS.dump s3://backups/appdb/ --only-show-errors
                  echo "backup appdb-$TS.dump complete: $(stat -c%s /tmp/appdb-$TS.dump) bytes"
              envFrom:
                - secretRef: { name: backup-creds }
              resources:
                requests: { cpu: 250m, memory: 512Mi }
                limits:   { memory: 1Gi }
```

(In practice you'd bake a small image with both `pg_dump` and the S3 CLI.) The same pattern covers `mysqldump`, MQ's `dmpmqcfg` for queue-manager config, Valkey `--rdb` fetches, and so on. CronJob semantics — missed schedules, concurrency, history limits — are covered in [Jobs and CronJobs](/workloads/jobs-and-cronjobs/).

Two rules that separate working setups from theater: **alert on absence, not just failure** (a suspended CronJob or a wedged schedule emits no failure event — monitor "newest object in the bucket is older than 26h" from the outside), and remember dumps are **app-consistent but slow**: for a 500Gi database, level 1 is your logical-corruption escape hatch, not your primary RTO plan.

If you run an operator, prefer its native continuous backup over hand-rolled dumps as the primary mechanism — CloudNativePG's WAL archiving gives you point-in-time recovery, which a nightly dump never will ([PostgreSQL](/stateful/postgresql/)). Keep a periodic dump *as well*: it survives operator bugs and restores anywhere.

## Level 2: VolumeSnapshots (CSI)

Storage-layer point-in-time copies, created through the Kubernetes API:

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: pgdata-pre-migration
spec:
  volumeSnapshotClassName: csi-snapclass    # ask platform what exists
  source:
    persistentVolumeClaimName: pgdata
```

Restore = create a new PVC with `dataSource` pointing at the snapshot:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pgdata-restored
spec:
  dataSource:
    name: pgdata-pre-migration
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes: ["ReadWriteOnce"]
  storageClassName: fast-ssd
  resources:
    requests:
      storage: 100Gi          # must be >= the snapshot's source size
```

Snapshots are fast (seconds, copy-on-write) and size-independent, which makes them perfect for the **pre-change safety net**: snapshot before every schema migration or major upgrade. The rollback path is then "point a pod (or a fresh CNPG cluster) at `pgdata-restored`" instead of an hours-long dump restore.

The prerequisites are platform territory: a CSI driver with snapshot support, the external-snapshotter controller, and a `VolumeSnapshotClass` — plus RBAC for you to create `VolumeSnapshot` objects. `kubectl get volumesnapshotclass` tells you if it's plumbed; if not, that's the ask ([CSI Drivers](/controllers/csi-drivers/) explains the machinery).

:::caution[Crash-consistent vs app-consistent]
A raw volume snapshot captures the disk *mid-flight* — like yanking the power cord. That's **crash-consistent**: a journaling database (Postgres, MQ) will recover from it the way it recovers from a power failure, usually fine but with recovery time and, for multi-volume setups, no cross-volume consistency. **App-consistent** means the application was quiesced or checkpoint-aware at capture time (a dump, WAL-archiving-based backup, or a fsfreeze/backup-mode hook around the snapshot). Know which one each of your backup layers gives you, and never snapshot only *one* volume of a database that stripes across several.
:::

Snapshots usually live in the same storage system as the volumes. A storage-array failure takes both. Snapshots are a recovery accelerator, not an off-site backup — pair with level 1 or replicated object storage.

## Level 3: Velero — namespace-level backup

Velero backs up Kubernetes **objects** (all the YAML in a namespace) plus, optionally, volume data (via CSI snapshots or file-level copy with Kopia) to object storage. It answers a question levels 1–2 don't: *"restore my whole namespace — Deployments, Services, PVCs, Secrets, CRs — onto this or another cluster."*

Velero is a cluster-scoped install (its own [CRDs](/controllers/crds-explained/), controllers, node agents): **platform team owns it**. Your interaction, depending on the RBAC they grant, is creating `Schedule`/`Backup` CRs or simply requesting "nightly namespace backup for `myapp`, 30-day retention":

```console
$ velero backup get -n velero
NAME                    STATUS      CREATED                         EXPIRES   STORAGE LOCATION
myapp-daily-20260702    Completed   2026-07-02 02:00:14 +0000 UTC   29d       default
```

Where it shines: cluster rebuilds/migrations, whole-namespace disaster recovery, and capturing the *pairing* of manifests and volumes. Where it doesn't: database consistency — a Velero volume backup of a running Postgres is crash-consistent at best. For databases, Velero complements, never replaces, the database-aware backup. (And if your manifests live in git with a clean [GitOps pipeline](/operations/drift-and-cicd/), the object half of Velero matters less — the volumes and Secrets are the part git doesn't have.)

## THE RULE: a backup you haven't restored is a hope

Every veteran has the same scar: backups ran green for months, and the restore failed when it mattered — wrong flags on the dump, missing WAL segment, expired credentials on the bucket, a restore that takes 14 hours against a 1-hour RTO promise, or backups of the *replica's* empty config all along.

Run **restore drills** on a schedule (quarterly at minimum, and after any change to the backup pipeline):

1. Restore the latest production backup into a scratch namespace — as a new CNPG `Cluster` with a `bootstrap.recovery` stanza, a new PVC from snapshot, or `pg_restore` into a fresh pod.
2. Validate *data*, not just process exit codes: row counts, latest timestamps, an app smoke test against the restored copy.
3. **Time it.** The stopwatch number is your real RTO, and it grows with your data.
4. Write down what you had to look up. That document is your DR runbook — keep it where you can reach it when the cluster is down (not only in the cluster). Slot it into your [emergency playbooks](/operations/emergency-playbooks/).

A restore drill that's cheap enough gets done; that's the hidden virtue of operators with first-class restore-into-new-cluster support.

:::tip[Make the drill a pipeline]
The best drill is one nobody has to remember: a scheduled pipeline (or CronJob) that restores last night's backup into a scratch namespace, runs validation queries, posts the timing to your team channel, and tears it down. Green message every Monday = tested backups. The first time it goes red, it will have caught a real problem months before an incident would have.
:::

## Choosing: RPO/RTO framing

Two numbers per dataset, agreed with the business, not assumed:

- **RPO** (recovery point objective): how much data loss is tolerable? Maps to backup *frequency and mechanism* — nightly dump = up to 24h RPO; continuous WAL archiving = minutes; sync replication + backups = near zero.
- **RTO** (recovery time objective): how long may restore take? Maps to *mechanism and drills* — snapshot restore is minutes regardless of size; `pg_restore` of 500Gi is hours; "we've never tried" is unbounded.

| Dataset | Sane starting point |
|---|---|
| Rebuildable cache | No backup. Document the rebuild. |
| Internal tool DB | Nightly dump to object storage (RPO 24h) |
| Production OLTP | Operator continuous backup + PITR, plus periodic dumps; snapshot before changes |
| Message queues | Usually low-RPO *config* backup + client retry/redelivery design; persisted-message backup only if messages are irreplaceable |

## DR across clusters

Cluster-level disasters (region outage, cluster corrosion, catastrophic upgrade) need recovery **somewhere else**. In ascending cost: backups in region-replicated object storage + manifests in git + a drilled restore procedure (fine for RTO in hours); a warm standby — e.g. a CNPG replica cluster in the second cluster streaming from the primary's WAL archive (RTO in minutes, but now you operate two); active-active only if the application layer genuinely supports it — that's an architecture, not a backup setting.

Whatever tier you pick, the failure domains must not overlap: backups in a bucket in the same blast radius as the cluster is DR theater. And the drill rule applies double — a cross-cluster failover you've never rehearsed will fail in ways the runbook doesn't mention. Your platform team owns half of this story (the second cluster, Velero replication, DNS cutover); get the joint runbook written before you need it.
