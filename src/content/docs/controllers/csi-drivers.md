---
title: CSI Drivers
description: How the Container Storage Interface provisions, attaches, and mounts your volumes — and where each stage fails when a PVC or pod gets stuck.
keywords:
  - container storage interface
  - pvc stuck pending
  - pod stuck containercreating
  - multi-attach error for volume
  - failedattachvolume
  - failedmount unable to attach or mount volumes
  - volumeattachment object
  - waitforfirstconsumer
  - filesystemresizepending volume expansion
  - fsgroup permission denied volume
  - volumesnapshot from pvc
sidebar:
  order: 7
---

Every PersistentVolume in a modern cluster is served by a **CSI driver** — the Container Storage Interface, the extension point that let storage vendors move their code out of the Kubernetes core. When your PVC binds, when a volume follows your pod to a new node, when a mount shows up inside your container: that's a CSI driver doing three distinct jobs, and knowing which job failed is the difference between a five-minute fix and a day of guessing.

The architecture in one diagram:

```text
 your PVC ──▶ [controller plugin]  runs as a Deployment/StatefulSet somewhere
              • provision: create the actual disk (Provision/Delete)
              • attach:    connect disk to a node (VolumeAttachment)
 your pod ──▶ [node plugin]        runs as a DaemonSet on every node
              • mount:     format if needed, mount into the pod (via kubelet)
```

Both halves are platform-installed. You interact with them through PVCs, StorageClasses, and the events they emit. Fundamentals of PV/PVC binding live in [Storage: PV and PVC](/stateful/storage-pv-pvc/); this article is about the machinery behind it and its failure signatures.

## Discovering what storage your cluster has

This article covers the CSI *machinery* — the plumbing every driver shares. The *backends* behind the drivers (Longhorn, Rook-Ceph, Harvester, OpenEBS, NFS) each behave differently under failure and load; [Storage Controllers](/controllers/storage-controllers/) profiles them one by one, and [Longhorn Under Valkey](/architectures/valkey-longhorn-deep-dive/) follows one backend's CSI plugin and sidecars all the way to the block device.

Three read-only commands map the territory:

```console
$ kubectl get csidrivers
NAME                     ATTACHREQUIRED   PODINFOONMOUNT   STORAGECAPACITY   MODES        AGE
csi.vsphere.vmware.com   true             false            false             Persistent   412d
nfs.csi.k8s.io           false            false            false             Persistent   201d
```

`ATTACHREQUIRED=true` means the driver has an attach step (block storage: vSphere, cloud disks, SANs); `false` means network filesystems (NFS, some CephFS) that skip straight to mount — one whole failure stage you don't have to consider.

```console
$ kubectl get storageclasses
NAME                 PROVISIONER              RECLAIMPOLICY   VOLUMEBINDINGMODE      ALLOWVOLUMEEXPANSION
fast (default)       csi.vsphere.vmware.com   Delete          WaitForFirstConsumer   true
shared-nfs           nfs.csi.k8s.io           Delete          Immediate              false
```

The `PROVISIONER` column is the join key: a StorageClass is a named recipe (parameters + policy) pointing at exactly one driver. Your PVC names a class; the class names a driver; the driver does the work. Also note `ALLOWVOLUMEEXPANSION` and `VOLUMEBINDINGMODE` here — both come up below.

`kubectl get csinodes` (readable in most clusters) shows which drivers are actually registered on each node and their per-node attach limits — relevant when pods won't schedule because a node maxed out its attachable volumes.

### Features are per-driver, not per-cluster

Never assume a storage feature exists; check the driver:

| Feature | Gated by | How to check |
|---|---|---|
| Volume expansion | driver + `allowVolumeExpansion` on the class | `kubectl get sc` |
| Snapshots | driver + external-snapshotter + a VolumeSnapshotClass | `kubectl get volumesnapshotclasses` |
| Clone (new PVC from existing PVC) | driver capability | driver docs / ask platform |
| RWX (ReadWriteMany) | driver semantics — file-based drivers mostly yes, block drivers mostly no | try it; PVC events tell you fast |

Requesting RWX from a block-only driver fails at provision time with an explicit event — one of the friendlier errors in this space.

### Snapshots: the one feature worth a recipe

If `volumesnapshotclasses` exist, you can take crash-consistent point-in-time copies of a PVC from inside your namespace — invaluable before risky migrations:

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: db-pre-migration
spec:
  volumeSnapshotClassName: fast-snapclass
  source:
    persistentVolumeClaimName: data-db-0
```

Wait for `READYTOUSE=true` (`kubectl get volumesnapshot`), then restore by creating a new PVC with `spec.dataSource` pointing at the snapshot. Two caveats: a snapshot is crash-consistent, not application-consistent — quiesce or use the database's own tooling for real backups ([Backup and DR](/stateful/backup-and-dr/)); and snapshots typically live on the same storage backend as the original, so they are not disaster recovery.

## The volume lifecycle, and where each failure surfaces

A volume reaches your container in three stages, each owned by a different component, each reporting to a **different place**. Memorize the mapping — it's the whole troubleshooting method:

| Stage | Done by | Failure appears in |
|---|---|---|
| 1. Provision (create disk, bind PV) | controller plugin (external-provisioner) | **PVC events** |
| 2. Attach (disk ↔ node) | controller plugin (external-attacher) | **pod events** + `VolumeAttachment` objects |
| 3. Mount (into the pod) | node plugin via kubelet | **pod events** |

So: PVC stuck `Pending` → describe the **PVC**. Pod stuck `ContainerCreating` with a bound PVC → describe the **pod**. Wrong object, no evidence.

## The failure playbook

What follows is the mechanism-side view; the tenant-side, symptom-first version of the same material — PVC Pending, Multi-Attach, FailedMount, volume full, worked from the error message backwards — is [Volume failures](/troubleshooting/volume-failures/).

### PVC Pending

```console
$ kubectl describe pvc data-cache
...
Events:
  Type    Reason               Message
  ----    ------               -------
  Normal  WaitForFirstConsumer waiting for first consumer to be created before binding
```

Three distinct causes hide behind `Pending`:

1. **No StorageClass resolved.** PVC has no `storageClassName` and the cluster has no default class (`kubectl get sc` — look for `(default)`). The PVC waits forever, with little fanfare. Fix: name a class explicitly.
2. **`WaitForFirstConsumer` — not an error.** The class defers provisioning until a pod actually uses the PVC, so the disk lands in the right zone/host. A consumer-less PVC stays Pending *by design*. If a pod exists and it's still Pending, the pod itself is likely unschedulable — chase that instead ([Pod Pending](/troubleshooting/pod-pending/)).
3. **Provision actually failing.** Events show retries from the provisioner: quota exhausted, backing datastore full, invalid parameters, RWX on a block driver. This event text is exactly what the platform/storage team needs.

### Pod stuck ContainerCreating: the Multi-Attach classic

The single most common CSI incident in production, worth knowing cold. A node dies (or a pod gets rescheduled while the old one lingers), the replacement pod lands on another node, and:

```console
$ kubectl describe pod db-0
Events:
  Warning  FailedAttachVolume  Multi-Attach error for volume "pvc-9f31c2"
           Volume is already exclusively attached to one node and can't be attached to another
  Warning  FailedMount         Unable to attach or mount volumes: unmounted volumes=[data] ...
```

What's happening: the volume is RWO (one node at a time), and Kubernetes won't detach it from the old node until it's confident the old pod is truly gone — which, on a dead node that can't confirm anything, takes several minutes of forced detach timeout (typically ~6). Your options:

- **Node genuinely dead and pod stuck Terminating on it:** `kubectl delete pod <old> --grace-period=0 --force` releases the API-side claim; detach follows. Use only when the node is confirmed down — forcing while the old kubelet is alive risks two writers on one disk.
- **Old pod alive on a healthy node:** this is a rescheduling overlap; let the old pod terminate normally. Don't force.
- **Happens on every rollout:** your Deployment with an RWO volume uses `strategy: RollingUpdate` — the new pod needs the disk before the old one released it. Use `Recreate`, or a StatefulSet, for RWO-backed workloads.

You can watch the attach state directly — `VolumeAttachment` is cluster-scoped but commonly readable:

```console
$ kubectl get volumeattachments | grep pvc-9f31c2
csi-4c72...   csi.vsphere.vmware.com   pvc-9f31c2   worker-03   true
```

An attachment pinned to the dead `worker-03` while your pod waits on `worker-08` confirms the diagnosis in one line.

### Other mount-stage failures

- **`FailedMount ... fsck` / filesystem errors** — the disk survived but dirty; needs storage-team attention, don't retry-loop it into worse shape.
- **Mount succeeds, app gets `permission denied`** — ownership: set `spec.securityContext.fsGroup` so kubelet chowns the volume for your non-root user; note some drivers' `CSIDriver.fsGroupPolicy` disables this.
- **Orphaned attachments** — VolumeAttachments referencing deleted pods/nodes accumulate after messy node removals, and can exhaust per-node attach limits or block new attaches of the same volume. You can list them; cleaning them is platform work. Evidence: the `kubectl get volumeattachments` lines plus the missing node/pod names.

:::caution[Expansion is online-ish, not instant]
With `ALLOWVOLUMEEXPANSION=true`, editing `spec.resources.requests.storage` on the PVC grows the disk — but the *filesystem* resize often completes only when the driver gets a chance, sometimes requiring a pod restart. `kubectl describe pvc` shows `FileSystemResizePending` when that's the state. Shrinking is not supported, ever — size requests only go up.
:::

## What to bring to the platform team

CSI escalations are cross-team by nature (platform → storage/infra). The package that shortcuts triage:

> - PVC name, namespace, StorageClass, access mode; `kubectl describe pvc` events verbatim
> - Pod events (`FailedAttachVolume` / `FailedMount` lines, with timestamps)
> - Relevant `kubectl get volumeattachments` lines
> - What changed: node incident? rollout? resize?

That maps your problem directly onto their layer — controller-plugin logs, the storage backend, or the node's kubelet — instead of starting from "storage is broken."
