---
title: "Storage: PV, PVC, and StorageClass"
description: The Kubernetes storage model for application teams — access modes, dynamic provisioning, expansion, reclaim policies, and what to ask your platform team.
sidebar:
  order: 3
---

Kubernetes storage is a three-layer indirection, and every layer exists to separate your concern (I need 50Gi of fast disk) from the platform's concern (that means a Ceph RBD volume on the SSD pool).

- **PersistentVolume (PV)** — a piece of actual storage. Cluster-scoped; you generally can't create or even list them without extra RBAC.
- **PersistentVolumeClaim (PVC)** — your namespaced request: "50Gi, ReadWriteOnce, class `fast-ssd`". This is the object *you* own.
- **StorageClass** — the menu. Each class maps to a provisioner (a [CSI driver](/controllers/csi-drivers/)) plus parameters. Cluster-scoped, platform-managed.

With **dynamic provisioning** — the norm on any modern cluster — you create a PVC, the CSI driver creates a matching PV on the fly, and they bind. You never touch PVs directly.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pgdata
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: fast-ssd
  resources:
    requests:
      storage: 50Gi
```

```console
$ kubectl get pvc pgdata
NAME     STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   AGE
pgdata   Bound    pvc-3f8a12cd-9b0e-4a3c-8f7d-1c2e9a04b511   50Gi       RWO            fast-ssd       12s
```

`Pending` instead of `Bound`? Either the class uses `WaitForFirstConsumer` (see below — this is normal until a pod uses it), or provisioning failed — `kubectl describe pvc pgdata` and read the events:

```console
$ kubectl describe pvc pgdata
...
Events:
  Type     Reason              Age   From                         Message
  ----     ------              ----  ----                         -------
  Warning  ProvisioningFailed  8s    csi.trident.netapp.io_...    failed to provision volume:
           rpc error: code = ResourceExhausted desc = aggregate is over capacity
```

Provisioning errors like quota exhaustion, a nonexistent `storageClassName` (typo — the PVC waits forever, silently), or backend capacity are all diagnosed from that event stream. Backend errors go to the platform team verbatim.

## Access modes: what they really mean

Access modes describe how many **nodes** (not pods) can mount the volume:

| Mode | Meaning | Reality check |
|---|---|---|
| `RWO` ReadWriteOnce | One node, read-write | The default for block storage (EBS, Azure Disk, Ceph RBD, most SANs). Multiple pods on the *same* node can share it — a detail that hides bugs until a reschedule. |
| `RWOP` ReadWriteOncePod | One **pod**, read-write | The strict version; use it for databases when your CSI driver supports it. |
| `RWX` ReadWriteMany | Many nodes, read-write | Requires a shared filesystem (NFS, CephFS, Azure Files). Slower, and terrible for databases — never put Postgres on NFS-backed RWX without a very good reason. |
| `ROX` ReadOnlyMany | Many nodes, read-only | Niche: shared reference data. |

### The RWO consequence everyone hits

An RWO volume can attach to one node at a time. Now consider a Deployment with default `RollingUpdate`: the new pod starts *before* the old one stops. If they land on different nodes, the new pod hangs in `ContainerCreating`:

```console
$ kubectl describe pod myapp-6c9d7f5b8-k2xwm
  Warning  FailedAttachVolume  2m  attachdetach-controller
  Multi-Attach error for volume "pvc-3f8a..." Volume is already used by pod(s) myapp-5b8c6d4a7-p9qrt
```

The fix for a single-replica stateful Deployment is `strategy: type: Recreate` — old pod fully stops, volume detaches, new pod attaches. You trade a few seconds of downtime for a rollout that actually completes. Multiple replicas each needing their own RWO volume is what StatefulSets' `volumeClaimTemplates` are for — see [StatefulSets Fundamentals](/stateful/statefulsets-fundamentals/).

## volumeBindingMode: WaitForFirstConsumer

StorageClasses have a `volumeBindingMode`. `Immediate` provisions the volume as soon as the PVC is created — potentially in the wrong availability zone, because the scheduler hasn't decided where the pod goes yet. `WaitForFirstConsumer` delays provisioning until a pod actually references the PVC, so the volume is created in the zone the pod scheduled to.

Practical implications for you:

- A `Pending` PVC with event `waiting for first consumer to be created before binding` is **healthy**. Don't file a ticket.
- Once bound, a zonal volume pins your pod to that zone forever. If your pod is `Pending` with `1 node(s) had volume node affinity conflict`, that's the volume dictating scheduling — see [Pod Pending](/troubleshooting/pod-pending/).

## Expansion: growing a volume

If the StorageClass has `allowVolumeExpansion: true`, growing is a PVC edit:

```bash
kubectl patch pvc pgdata -p '{"spec":{"resources":{"requests":{"storage":"100Gi"}}}}'
```

The block device grows online for most CSI drivers; the **filesystem** resize typically happens automatically once, and only when, a pod is using the volume. Watch progress:

```console
$ kubectl get pvc pgdata -o jsonpath='{.status.conditions}'
[{"type":"FileSystemResizePending","status":"True",...}]
```

If it sticks in `FileSystemResizePending`, restarting the pod usually kicks the node-side resize. Two hard rules: **you can never shrink**, and if this PVC came from a StatefulSet's `volumeClaimTemplates`, remember the template itself is immutable — patch each PVC, and fix the template via the orphan-delete dance described in [StatefulSets Fundamentals](/stateful/statefulsets-fundamentals/).

## Reclaim policy: the "data gone" horror

Every PV has a `persistentVolumeReclaimPolicy`, inherited from the StorageClass at provisioning time:

- **`Delete`** — when the PVC is deleted, the PV *and the underlying disk* are destroyed. This is the default for most dynamically provisioned classes.
- **`Retain`** — the PV survives PVC deletion (status `Released`); data is recoverable by an admin.

The horror story writes itself: someone runs `kubectl delete ns staging-old`, or a Helm uninstall, or an Argo CD prune, and every PVC in the namespace goes — and with `Delete` reclaim policy, so does every byte of data, unrecoverably, in seconds.

:::danger[Assume Delete until proven otherwise]
Check what you're actually running on: `kubectl get pvc pgdata -o jsonpath='{.spec.volumeName}'` then ask your platform team (you likely can't `kubectl get pv`) what the reclaim policy is. For irreplaceable data: ask platform to flip the specific PV to `Retain`, protect the namespace from automated pruning, and above all have real backups — [Backup and DR](/stateful/backup-and-dr/). PVC protection finalizers stop *in-use* PVCs from vanishing mid-flight, but nothing stops a deliberate delete of an idle one.
:::

## Ephemeral storage vs PVC

Not everything needs a PVC:

- **`emptyDir`** — scratch space, lifetime of the pod. Fine for temp files, sort spill, local caches. Counts against the node's ephemeral storage (set `sizeLimit`!) unless you use `medium: Memory`, which counts against your memory limit.
- **Generic ephemeral volumes** — a PVC created and deleted with the pod; real CSI storage, ephemeral lifecycle. Good for "I need 200Gi of scratch that doesn't fit on the node disk":

  ```yaml
  volumes:
    - name: scratch
      ephemeral:
        volumeClaimTemplate:
          spec:
            accessModes: ["ReadWriteOnce"]
            storageClassName: fast-ssd
            resources:
              requests:
                storage: 200Gi
  ```

- **PVC** — data that must outlive the pod.

Writing large data to the container filesystem itself is the worst option: it's slow on some runtimes, invisible to quotas until eviction (`The node was low on resource: ephemeral-storage`), and gone on restart.

## What to ask your platform team

You can discover some of this yourself — `kubectl get storageclass` is usually readable even for namespace-scoped users:

```console
$ kubectl get storageclass
NAME                 PROVISIONER             RECLAIMPOLICY   VOLUMEBINDINGMODE      ALLOWVOLUMEEXPANSION   AGE
fast-ssd (default)   csi.trident.netapp.io   Delete          WaitForFirstConsumer   true                   400d
nfs-shared           csi.trident.netapp.io   Delete          Immediate              true                   400d
```

Then ask the humans:

1. **Which class for databases?** What's the backing storage (local NVMe, SAN, replicated?) and its IOPS/latency characteristics? Is the data replicated at the storage layer, or is a disk failure data loss?
2. **Snapshots:** is there a `VolumeSnapshotClass`? Can we create `VolumeSnapshot` objects in our namespace?
3. **Reclaim and quotas:** what's the reclaim policy, and what's our namespace storage quota (`kubectl describe quota` will show it if set)?
4. **RWX:** if we need shared filesystems, which class, and what are its consistency/performance caveats?

The plumbing behind all of this — attach, mount, snapshot — is a CSI driver the platform team operates; [CSI Drivers](/controllers/csi-drivers/) covers how that machinery works and how to read its failure events.
