---
title: "Storage Controllers: Longhorn, Ceph, Harvester & Friends"
description: What's actually behind your StorageClass — Longhorn, Rook-Ceph, Harvester, OpenEBS, NFS — and how each backend changes the way slow, degraded, and stuck volumes behave.
sidebar:
  order: 9
---

"My PVC is slow" means five completely different investigations depending on what's serving it. On Longhorn it's probably a replica rebuild. On Ceph it might be the whole cluster backfilling and every namespace is suffering with you. On an NFS provisioner it might be lock contention from a workload that should never have been there. On a local-path volume it isn't slow at all — but your pod can never move again.

Kubernetes hides all of this behind one uniform surface: StorageClass → PVC → volume in your pod. That uniformity is a feature right up until something degrades, because **replication factor, failure behavior, RWX support, and the performance ceiling are properties of the backend, not of Kubernetes**. This article is the field guide to the backends you're most likely to find behind a `kubectl get storageclass` in an on-prem or bare-metal shop.

Scope check: how CSI itself works (provision/attach/mount, and which stage ate your pod) is in [CSI Drivers](/controllers/csi-drivers/). The PV/PVC binding model, access modes, and expansion mechanics are in [Storage: PV and PVC](/stateful/storage-pv-pvc/). The symptom-first playbook for stuck and failing volumes is in [Volume Failures](/troubleshooting/volume-failures/). Here we answer one question: *what am I actually on, and what does that mean for me?*

## First: identify what you're on

One command, read the provisioner column:

```console
$ kubectl get storageclass
NAME                   PROVISIONER                    RECLAIMPOLICY   VOLUMEBINDINGMODE      ALLOWVOLUMEEXPANSION   AGE
longhorn (default)     driver.longhorn.io             Delete          Immediate              true                   612d
longhorn-strict        driver.longhorn.io             Delete          Immediate              true                   340d
ceph-block             rook-ceph.rbd.csi.ceph.com     Delete          Immediate              true                   612d
ceph-fs                rook-ceph.cephfs.csi.ceph.com  Delete          Immediate              true                   612d
harvester              driver.harvesterhci.io         Delete          Immediate              true                   201d
local-path             openebs.io/local               Delete          WaitForFirstConsumer   false                  612d
nfs-shared             nfs.csi.k8s.io                 Retain          Immediate              false                  455d
```

Decoder ring for provisioners you'll meet in the wild:

| Provisioner | Backend | What that implies |
|---|---|---|
| `driver.longhorn.io` | Longhorn distributed block | Replicated over the network, RWO (RWX via NFS shim), rebuilds on failure |
| `rook-ceph.rbd.csi.ceph.com` | Ceph RBD block | Shared cluster, RWO block, cluster-wide health affects you |
| `rook-ceph.cephfs.csi.ceph.com` | CephFS | Real RWX POSIX filesystem, metadata servers in the path |
| `driver.harvesterhci.io` | Harvester (guest cluster) | You're in a VM; your PVC is a Longhorn volume one layer down |
| `openebs.io/local`, `local.csi.openebs.io` | OpenEBS LocalPV | Node-local disk: fast, unreplicated, pod is pinned |
| `io.openebs.csi-mayastor` | OpenEBS Mayastor | NVMe-oF replicated block |
| `nfs.csi.k8s.io`, `cluster.local/nfs-subdir-...` | NFS provisioner | Cheap RWX, decorative capacity, NFS semantics |
| `ebs.csi.aws.com` / `pd.csi.storage.gke.io` / `disk.csi.azure.com` | Cloud block | Zonal RWO, native snapshots |

Then read the parameters — they're the fingerprint:

```console
$ kubectl get storageclass longhorn-strict -o jsonpath='{.parameters}' | jq
{
  "numberOfReplicas": "3",
  "staleReplicaTimeout": "30",
  "dataLocality": "strict-local"
}
$ kubectl get storageclass ceph-block -o jsonpath='{.parameters}' | jq '{clusterID, pool}'
{
  "clusterID": "rook-ceph",
  "pool": "replicapool"
}
```

`numberOfReplicas` means Longhorn. `clusterID`/`pool` means Ceph. `server`/`share` means NFS. Now you know which of the sections below is your reality.

:::note[The default class is a decision someone made for you]
The `(default)` marker is what every PVC without an explicit `storageClassName` gets. If your cluster offers `longhorn` and `longhorn-strict` and `local-path`, the platform team encoded real trade-offs into those names — and taking the default for a database because it's the default is how you end up on the wrong side of one. Always set `storageClassName` explicitly in anything that outlives a demo.
:::

## Longhorn: a distributed block store, one volume at a time

Longhorn (a CNCF project, originated at Rancher/SUSE) is the most common answer to "we have bare metal and no SAN." The model is unusually legible: **every volume gets its own tiny storage system** — an *engine* (controller) on the node where your pod runs, and N *replicas* on different nodes' disks, connected over the network via iSCSI (or ublk on newer v2 data-path setups). Writes go to all replicas synchronously; reads come from any.

That model is why Longhorn's failure behavior is so tenant-friendly to reason about: your volume's blast radius is your volume. It's also why the performance ceiling is what it is — every write crosses the network N times and isn't acknowledged until the slowest replica confirms it.

### Reading a Longhorn StorageClass

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn
provisioner: driver.longhorn.io
allowVolumeExpansion: true
parameters:
  numberOfReplicas: "3"          # copies on distinct nodes; 3 survives one node loss with margin
  staleReplicaTimeout: "30"      # minutes before a dead replica is written off and rebuilt elsewhere
  dataLocality: "best-effort"    # try to keep one replica on the pod's node (reads stay local)
```

- **`numberOfReplicas`** is your durability. `3` is the sane default; `2` survives exactly one failure with zero margin during the rebuild window; `1` is "local disk with extra steps" and should scare you on anything you can't regenerate.
- **`dataLocality: best-effort`** migrates a replica to the pod's node when possible — a real win for read-heavy workloads because reads skip the network. `strict-local` forces engine and (single) replica onto one node: fast, unreplicated, pinned.
- **`staleReplicaTimeout`** governs how long Longhorn waits for a wayward replica to come back before rebuilding from scratch.

### Volume states: degraded is not down

The thing every Longhorn tenant must internalize:

- **Healthy** — all replicas in sync.
- **Degraded** — one or more replicas lost; the volume **keeps serving I/O** from the survivors while Longhorn rebuilds the missing replica in the background. Rebuild means reading the whole volume from a healthy replica and streaming it to a new node.
- **Faulted** — all replicas gone. Now it's down, and it's a restore conversation.

Degraded is the state behind the classic ticket: *"nothing changed, but my database has been slow for the last 40 minutes."* A node rebooted (patching, drain, crash), a replica went stale, and the rebuild I/O is competing with your workload on the same disks and NICs. Check before blaming your app:

```console
$ kubectl get volumes.longhorn.io -n longhorn-system \
    -o custom-columns=NAME:.metadata.name,STATE:.status.state,ROBUSTNESS:.status.robustness | grep -v healthy
pvc-8f3a91d2-6b1e-4c5a-9d7f-2e8b4a1c6f30   attached   degraded
```

You can usually read `volumes.longhorn.io` even as a namespace-limited tenant if the platform team granted it; if not, this is a one-line question to them. Degraded + your PVC's volume name = wait it out or ask how long the rebuild has left. Don't restart your pod hoping it helps — it doesn't, and detach/reattach during a rebuild just adds drama.

### Snapshots vs backups — not the same thing

Longhorn **snapshots** live inside the cluster, on the same replicas as the volume. They protect you from *yourself* (bad migration, fat-fingered delete), not from the cluster. Longhorn **backups** are full/incremental copies shipped to an external target — NFS or S3 — configured cluster-wide by the platform team. If the backup target isn't configured, "Longhorn has backups" is false in your cluster no matter what the docs say. Where snapshots and backups fit in an actual recovery strategy — including why application-level backups still matter — is in [Backup and DR](/stateful/backup-and-dr/).

### RWX: there's an NFS server hiding in your namespace's future

Longhorn supports `ReadWriteMany`, but not natively at the block layer. It spins up a **share-manager pod** — an NFS server exporting the Longhorn volume — and every attaching pod NFS-mounts it. Two consequences:

1. Your "distributed block storage" RWX volume has NFS semantics and NFS performance.
2. When the share-manager pod restarts (node drain, upgrade, OOM), **every attacher stalls** for the seconds-to-a-minute it takes to reschedule. Apps that panic on a hung mount will panic together.

:::caution[Node drains and your replicas]
When platform drains a node, Longhorn's default behavior (`node-drain-policy`) decides whether the drain blocks until your volumes have healthy replicas elsewhere or just proceeds. On a well-configured cluster a rolling OS patch means a rolling wave of degraded→rebuilding volumes — expect elevated latency during maintenance windows, and expect it to be *normal*.
:::

### The honest performance envelope

Network-replicated block storage has a floor on write latency: your fsync cannot complete faster than a round trip to the slowest replica. On a typical 10GbE cluster with SSDs, expect single-digit-millisecond fsync latencies — fine for most apps, noticeable for fsync-heavy databases doing synchronous commits. If your Postgres commit latency graphs look like your network graphs, that's not a coincidence; tuning options and what to expect are covered in [PostgreSQL on Kubernetes](/stateful/postgresql/). For read-heavy workloads, ask for a `dataLocality: best-effort` class — local reads are the cheapest optimization available.

**Ask your platform team:** What's the replica count policy per class? Is a backup target configured, and what's the schedule? Are Longhorn replicas on dedicated disks or sharing with the OS and container images? (Shared disks = your database competes with image pulls.)

## Harvester: Longhorn, one layer down

Harvester is SUSE's hyper-converged infrastructure platform — a Kubernetes distro that turns bare metal into a virtualization platform: KubeVirt runs VMs, Longhorn provides their storage, Multus handles the networking. As an application tenant, you meet it two ways.

**(a) Your cluster runs *on* Harvester.** The common pattern: Rancher provisions RKE2/K3s guest clusters as Harvester VMs. Your PVCs use the `driver.harvesterhci.io` provisioner, and each guest-cluster PVC becomes a Longhorn volume in the Harvester layer below. Everything in the Longhorn section applies — one layer down, where you can't see it:

- **Double-layer failure domains.** Your "node" is a VM. The VM can fail (Harvester restarts it, possibly on another host) independently of any volume failing. A guest-node NotReady might be a live migration, a host reboot, or an actual crash — three different durations, one symptom.
- **Live migration moves the VM, not your pod.** During migration your node blips but pods keep running; volume I/O stalls briefly. Don't confuse it with an eviction.
- **RWX, volume-size, and rebuild behavior are inherited** from the underlying Longhorn. If Harvester's Longhorn is rebuilding replicas after a host failure, every guest cluster on that pool feels it.
- **Snapshots exist at two layers**: VM snapshots (Harvester) and volume snapshots (via the CSI driver). Know which one your restore procedure actually uses *before* you need it.

**(b) VMs alongside your containers.** The migration-era pattern: the platform lifts legacy VMs onto Harvester next to Kubernetes workloads, and both draw from the same Longhorn pool. Your noisy neighbor might be a Windows VM doing a backup.

**Ask your platform team:** Which layer takes the backup — VM image, Longhorn volume, or in-guest? What IOPS should a guest-cluster PVC realistically expect? Are guest-cluster VMs anti-affine across Harvester hosts (or can one host failure take out half my "nodes")?

## Rook-Ceph: the shared ocean

Rook is the operator that runs Ceph on Kubernetes — a textbook example of the [operator pattern](/controllers/operators/): CRDs describe the desired Ceph cluster; Rook reconciles mons, OSDs, and gateways into existence. Ceph itself is the 20-year-old distributed storage veteran, and unlike Longhorn's per-volume islands, Ceph is **one shared pool of storage** serving everyone.

Three faces, usually three StorageClasses:

- **RBD block** (`rook-ceph.rbd.csi.ceph.com`) — RWO block devices carved from a pool. The workhorse: databases, general PVCs.
- **CephFS** (`rook-ceph.cephfs.csi.ceph.com`) — a real POSIX RWX filesystem with metadata servers (MDS) in the data path.
- **RGW object** — an S3-compatible API. Not a PVC at all; you get endpoint + credentials.

StorageClass parameters tell you what you're on: `pool: replicapool` means replicated (typically 3×, like Longhorn but pool-wide); an erasure-coded data pool means better capacity efficiency and higher small-write latency — fine for bulk data, worse for databases.

### The tenant-visible behaviors

The defining property: **Ceph health is cluster-wide.** When Ceph is `HEALTH_WARN` with degraded placement groups — after an OSD dies, during a rebalance, when a pool runs near-full — recovery traffic and throttling affect *every client of the pool*. This is the noisy-neighbor problem, storage edition, and it produces the signature symptom worth memorizing:

> Latency spikes across **unrelated namespaces and unrelated apps at the same time** = suspect Ceph, not your code. Ask platform for `ceph status`.

Other signatures worth knowing:

- **Mon quorum loss**: I/O freezes cluster-wide — everything hangs rather than erroring — until quorum returns. Pods stack up in D-state I/O wait.
- **CephFS vs RBD hiccups differ**: CephFS adds MDS to the path, so *metadata* operations (listing directories, opening many small files, renames) stall while raw read/write throughput looks fine. RBD problems look like block latency across the board.
- **Near-full pools throttle writes long before they hit 100%.** If writes crawl and `ceph status` (via platform) shows `nearfull`, no amount of app tuning helps.

**Ask your platform team:** Replicated or EC pool behind my class? What's the current utilization and the `nearfull` threshold? Is there a dashboard or read-only `ceph status` I can see, so I can self-serve the "is it Ceph?" question at 2 a.m.?

## OpenEBS: two products in a trench coat

OpenEBS has a split personality, and the split matters more than the brand:

**LocalPV** (`openebs.io/local` and friends — hostpath or raw device) is a provisioner for node-local disks. Fastest storage in the survey — NVMe latency, no network hop — and completely unreplicated. The trap is **node pinning**: once bound, the PV carries node affinity, and your pod can *only ever* run on that node. Node down = pod Pending forever, data inaccessible until the node returns. That failure mode and its cousins (zonal affinity, `WaitForFirstConsumer` surprises) are dissected in the volume-failures playbook linked above.

You can spot the pinning after the fact:

```console
$ kubectl get pv pvc-1f9c... -o jsonpath='{.spec.nodeAffinity}' | jq -c
{"required":{"nodeSelectorTerms":[{"matchExpressions":[{"key":"kubernetes.io/hostname","operator":"In","values":["worker-07"]}]}]}}
```

That PV will only ever schedule pods onto `worker-07`. If that surprises you, you picked the wrong class.

Who should use LocalPV: workloads that **replicate at the application layer** — Kafka, Valkey/Redis Cluster, Elasticsearch, anything running as a multi-replica [StatefulSet](/stateful/statefulsets-fundamentals/) where losing one member's disk means a re-replication, not data loss. For those, backend replication is redundant overhead; local NVMe is exactly right. For a single-instance database, LocalPV is a bet that the node never dies.

**Mayastor** (`io.openebs.csi-mayastor`) is the other personality: NVMe-oF-based replicated block storage, competing in Longhorn's space with a performance-first design. If you're on it, the Longhorn mental model (synchronous replicas, rebuilds, degraded states) transfers reasonably well; the terminology and tooling don't.

## NFS provisioners: cheap RWX, eyes open

`nfs-subdir-external-provisioner` (provisioner name like `cluster.local/nfs-subdir-external-provisioner`) and `csi-driver-nfs` (`nfs.csi.k8s.io`) both carve directories out of an existing NFS export and hand them to PVCs. For what they're for, they're great. Know the caveats:

- **Capacity is decorative.** Your PVC says `10Gi`; nothing enforces it. Every PVC on the export shares the real free space, and one team's runaway log file fills the volume for everyone.
- **Permission surprises.** `root_squash` on the export means your container's root user becomes `nobody` on the wire — the classic "works locally, `EACCES` in the cluster" mystery. Check your pod's `fsGroup`/`runAsUser` against the export's squash settings.
- **Locking is where hope goes to die.** NFS lock semantics are not what SQLite, database WAL files, or anything using `flock` for correctness expects. Corruption is rare but real; don't put transactional data here, full stop.
- **Latency**: every metadata operation is a network round trip. Workloads that stat thousands of small files (looking at you, PHP apps and node_modules) feel it hard.

When it's exactly right: shared read-mostly assets, upload directories, legacy apps architected around a shared filesystem, CI caches. Real RWX with zero ceremony.

## Cloud CSI, in one paragraph

If your provisioner is `ebs.csi.aws.com`, `pd.csi.storage.gke.io`, or `disk.csi.azure.com`, you're on cloud block storage: RWO, snapshot support is native and good, expansion works, and the durability problem is the provider's. The one trap worth restating: these volumes are **zonal** — the PV carries node affinity to its availability zone, and a pod that can't schedule in that zone can't have its volume. The binding-mode and topology mechanics are covered in the PV/PVC article linked at the top; the stuck-pod symptoms in the volume-failures playbook apply verbatim.

## Measure it: fio from inside the cluster

Stop guessing which class is "fast." Run the workload profile that matters — small random writes with fsync, i.e., the database commit path — from inside the cluster, against the actual StorageClass:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: fio-bench
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: fio
          image: ghcr.io/nixery.dev/shell/fio:latest   # or your registry's fio image
          command: ["/bin/sh", "-c"]
          args:
            - |
              fio --name=randwrite --filename=/data/fio.test --size=2G \
                  --rw=randwrite --bs=4k --ioengine=libaio --iodepth=16 \
                  --direct=1 --runtime=60 --time_based --group_reporting
              echo "---- fsync latency profile ----"
              fio --name=fsynctest --filename=/data/fio.fsync --size=512M \
                  --rw=write --bs=8k --fdatasync=1 \
                  --runtime=60 --time_based --group_reporting
          resources:
            requests: { cpu: "1", memory: 512Mi }
            limits:   { cpu: "2", memory: 1Gi }
          volumeMounts:
            - { name: bench, mountPath: /data }
      volumes:
        - name: bench
          persistentVolumeClaim:
            claimName: fio-bench-pvc
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: fio-bench-pvc
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: longhorn        # ← the class under test
  resources:
    requests:
      storage: 10Gi
```

Read the results (`kubectl logs job/fio-bench`) for two numbers: **randwrite IOPS** and, from the second run, the **fdatasync latency percentiles** (`sync percentiles` in the output — p99 is the one your database feels). Rough calibration for the 4k-randwrite/fsync-p99 pair:

- **Local NVMe (LocalPV):** tens of thousands of IOPS, fsync p99 well under 1 ms. The ceiling.
- **Longhorn / Mayastor / Ceph RBD, 3 replicas on 10GbE + SSD:** a few thousand IOPS, fsync p99 in the 2–10 ms range. Healthy. p99 over ~20 ms means degraded state, network trouble, or overloaded disks — worth a ticket.
- **NFS:** throughput can look fine; fsync and small-file latency will not. That's expected, not broken.
- **Cloud block:** whatever you paid for — check the volume type's published IOPS.

Delete the Job *and the PVC* when done.

:::caution[Benchmark etiquette]
On Longhorn and especially Ceph, your fio Job hammers *shared* infrastructure — a 60-second `iodepth=16` random-write run is indistinguishable from an incident to whoever's watching the storage dashboards. Coordinate before benchmarking anything beyond a quick smoke test, and never benchmark during someone else's maintenance window. How to have that conversation productively: [Working with the Platform Team](/operations/working-with-platform-team/).
:::

## Choosing: workload → what to look for → typical fit

| Workload | Look for in the StorageClass | Typical fit |
|---|---|---|
| Transactional DB (single instance) | RWO, backend replication, low fsync p99, expansion | Longhorn (3 replicas), Ceph RBD, cloud block |
| Analytics / bulk scans | RWO, throughput over latency, capacity efficiency | Ceph RBD (EC pool fine), cloud block |
| Shared files / uploads / legacy shared dir | Real RWX, POSIX semantics | CephFS; NFS provisioner if honest about caveats |
| Scratch / cache / rebuildable | Speed, don't care about durability | LocalPV, `emptyDir`, `dataLocality: strict-local` |
| Queue/DB replicated at app layer (Kafka, Valkey cluster) | RWO, locality, no redundant backend replication | LocalPV, Longhorn with 1 replica + strict-local |

And the checklist to run against **any** StorageClass before you trust it with data — every question here is a property of the backend, invisible in the YAML:

1. **Replication** — how many copies, at which layer (backend, app, both, neither)?
2. **Failure domain** — node? disk? zone? Harvester host under my VM?
3. **Snapshots** — supported? At which layer? Who can trigger and restore them?
4. **Backup** — is an external target actually configured, and has a restore been tested?
5. **Expansion** — `allowVolumeExpansion: true`, and does it work online?
6. **Performance envelope** — expected IOPS/fsync latency, and any per-volume limits or QoS?

Five minutes with the platform team answers all six. Debugging a faulted volume with no backup target answers them too — just much, much later.
