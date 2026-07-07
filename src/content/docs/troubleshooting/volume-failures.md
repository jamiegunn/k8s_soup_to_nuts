---
title: Volume and Storage Failures
description: Symptom-first playbook for PVCs stuck Pending, Multi-Attach errors, FailedMount timeouts, full volumes, permission failures, and the data-loss traps around StatefulSets.
keywords:
  - volume won't mount
  - Multi-Attach error for volume
  - FailedMount timeout
  - FailedAttachVolume
  - PVC stuck pending
  - no space left on device
  - permission denied on mount
  - fsGroup
  - read-only file system
  - storageClassName not found
  - allowVolumeExpansion resize pvc
  - reclaimPolicy Delete data loss
  - NFS root-squash
  - volume node affinity conflict statefulset
sidebar:
  order: 11
---

Storage failures look scary because the words are scary — `FailedAttachVolume`, `Lost`, `read-only file system`. Most of them are routine and fixable from your namespace. This page is the triage playbook: symptom, confirm, causes ranked by likelihood, fix per cause. The mechanics of PVs, PVCs, and binding live in [Storage: PV and PVC](/stateful/storage-pv-pvc/); how CSI drivers actually attach and mount lives in [CSI Drivers](/controllers/csi-drivers/). Here we just fix things.

## The 60-second storage triage

Three commands tell you which section of this page you're in:

```bash
kubectl get pod <pod> -o wide          # status + which node it landed on
kubectl describe pod <pod>             # Events at the bottom — the money section
kubectl get pvc                        # Pending / Bound / Lost
kubectl get events --sort-by=.lastTimestamp | grep -i -E 'volume|attach|mount|provision'
```

Decision tree:

- **PVC is `Pending`** → provisioning problem. Go to [PVC stuck Pending](#pvc-stuck-pending).
- **PVC is `Bound` but pod stuck `ContainerCreating`** → attach/mount problem. Go to [Pod stuck ContainerCreating](#pod-stuck-containercreating-on-volumes).
- **Pod `Running` but app throws I/O errors** → full volume, permissions, or read-only remount. Go to those sections.
- **PVC is `Lost`** → the bound PV was deleted underneath it. Stop, take screenshots, escalate — see [the escalation package](#the-escalation-package-for-storage).

Events age out (typically after an hour), so capture them early. More on reading events efficiently in [Events](/observability/events/).

## PVC stuck Pending

**Confirm:**

```bash
kubectl describe pvc <name>
```

The `Events:` section names the cause almost verbatim. Ranked by how often I've seen each:

### 1. WaitForFirstConsumer — not a bug

```text
Normal  WaitForFirstConsumer  12s (x14 over 3m)  persistentvolume-controller
        waiting for first consumer to be created before binding
```

The StorageClass uses `volumeBindingMode: WaitForFirstConsumer`, so the volume won't be provisioned until a pod that uses the PVC is scheduled — this lets the provisioner pick the right zone. **A Pending PVC with this event and no pod referencing it is working as designed.** Create the pod; the PVC binds. If the pod exists and is itself Pending, the problem is scheduling, not storage — see [Pod Pending](/troubleshooting/pod-pending/).

### 2. No default StorageClass

```text
Normal  FailedBinding  8s (x6 over 74s)  persistentvolume-controller
        no persistent volumes available for this claim and no storage class is set
```

Your PVC omitted `storageClassName` and the cluster has no default class. Check:

```bash
kubectl get storageclass
# NAME            PROVISIONER          ...   AGE
# fast-ssd        ebs.csi.aws.com      ...   200d
# standard (default)  ebs.csi.aws.com  ...   200d
```

No `(default)` annotation anywhere? Set `storageClassName` explicitly in the PVC. You can't mark a class default yourself — that's cluster-scoped — but you can always name one.

### 3. Typo'd storageClassName

```text
Warning  ProvisioningFailed  15s  persistentvolume-controller
         storageclass.storage.k8s.io "fast-sdd" not found
```

Compare against `kubectl get storageclass` output. Painful detail: `storageClassName` is **immutable** on a PVC. Fix means delete and recreate the PVC (safe while Pending — nothing was provisioned yet).

### 4. Storage quota exceeded

```text
Warning  FailedCreate  ...  exceeded quota: team-quota,
         requested: requests.storage=50Gi, used: requests.storage=480Gi, limited: requests.storage=500Gi
```

```bash
kubectl describe resourcequota
```

Delete unused PVCs (see the danger notes below first) or ask the platform team for more quota — bring the numbers from `describe resourcequota` when you do.

### 5. Provisioner down (platform territory)

```text
Warning  ProvisioningFailed  2m (x9 over 20m)  ebs.csi.aws.com_csi-controller-...
         failed to provision volume with StorageClass "standard": rpc error: code = DeadlineExceeded
```

Or simply no provisioning events at all after minutes. If the class and quota check out and other PVCs in the namespace also hang, the CSI controller is unhealthy — that's the platform team's pager. Escalate with the PVC name, StorageClass, and the exact event text; see [Working with the Platform Team](/operations/working-with-platform-team/).

**Prevention:** always set `storageClassName` explicitly (no default-class roulette), and put a PVC smoke test in your environment-promotion checklist.

## Pod stuck ContainerCreating on volumes

PVC is `Bound`, pod isn't starting. `kubectl describe pod` events, ranked:

### 1. Multi-Attach error on RWO — the #1 by a mile

```text
Warning  FailedAttachVolume  40s  attachdetach-controller
         Multi-Attach error for volume "pvc-3f9c..." Volume is already used by pod(s) api-7d4f9-x2k1j
```

An `RWO` (ReadWriteOnce) block volume can attach to **one node** at a time. This fires during rescheduling: the new pod landed on node B while node A still holds the attachment — because the old pod hasn't fully terminated, or node A went `NotReady` and can't confirm the detach.

If the old pod is still `Terminating` normally: **wait**. Detach happens after the old pod's containers stop; the whole cycle typically resolves in 1–6 minutes. Only if the old pod's node is genuinely dead does this stick — check `kubectl get nodes` and see [Node Problems](/troubleshooting/node-problems/).

:::danger
Resist `kubectl delete pod --force --grace-period=0`. Force-delete removes the pod **from the API server only** — it does not stop the process or unmount the volume on a node that's alive-but-unreachable. If that node comes back with the process still writing while the volume attaches elsewhere, you get two writers on one block device: filesystem corruption. On a dead node, the safe unstick is deleting the `VolumeAttachment` — which is cluster-scoped, i.e. a platform-team action. Give them the volume name and node from the event and let them verify the node is truly gone first.
:::

### 2. FailedMount timeout

```text
Warning  FailedMount  2m  kubelet  Unable to attach or mount volumes:
         unmounted volumes=[data], unattached volumes=[data kube-api-access-x7z]:
         timed out waiting for the condition
```

The generic "something in the attach/mount chain stalled" message. Look above it for a more specific event. Common specifics:

- **NFS server unreachable:** `mount failed: ... Connection timed out` naming an NFS endpoint. Verify the server/export from another pod (`nc -zv <nfs-server> 2049` via an ephemeral container). Fix is on the NFS side or a NetworkPolicy blocking it.
- **Bad mount options:** `mount failed: exit status 32 ... invalid option` — a StorageClass or PV `mountOptions` typo. If it's your PV spec, fix it; if it's the class, platform.
- **CSI node plugin missing on that node:** `driver name ebs.csi.aws.com not found in the list of registered CSI drivers` — the driver DaemonSet pod on that node is broken. You can *see* this without node access:

```bash
kubectl get pods -n kube-system -o wide | grep -i csi | grep <node-name>
```

  If it's CrashLooping or absent, that plus your pod's events is a complete platform escalation. Background on the controller/node plugin split: [CSI Drivers](/controllers/csi-drivers/).

### 3. fsck / corruption messages

```text
Warning  FailedMount  kubelet  MountVolume.MountDevice failed ...
         'fsck' found errors on device /dev/xvdba: ... UNEXPECTED INCONSISTENCY; RUN fsck MANUALLY
```

The kubelet fscks ext4 volumes before mounting and refuses on unfixable errors. This usually follows a hard node failure or a force-delete-while-attached (see above — this is what that buys you). **Do not delete the PVC to "reset" it.** The data may be recoverable; repairing requires mounting the device on a node, which is platform work. Escalate immediately with the PV name and event text.

**Prevention:** for anything that must survive rescheduling gracefully, know whether your access mode is honest — RWO plus a `Recreate`-less Deployment strategy guarantees Multi-Attach windows on every rollout. Use `strategy: Recreate` for single-replica RWO workloads, or a StatefulSet.

## Volume full: "no space left on device"

Two very different diseases share this symptom. Diagnose before treating:

```bash
kubectl exec <pod> -- df -h
# Filesystem      Size  Used Avail Use% Mounted on
# overlay          80G   76G  4.0G  95% /            ← node ephemeral / container layer
# /dev/nvme2n1     20G   20G  8.0K 100% /data        ← your PVC
```

(If the image has no shell — distroless — there's no `df` to exec; inject one with `kubectl debug --image=busybox` and run it from there, per [The BusyBox Toolkit](/troubleshooting/busybox/).)

**If the PVC mount is full** → clean up or expand (below).
**If `/` (overlay) is full** → that's node ephemeral storage: your app is writing logs/tmp/cache outside the PVC. The fix is an `emptyDir` with a `sizeLimit`, an `ephemeral-storage` resource limit, or pointing the writes at the PVC — expanding the PVC does nothing. Left unfixed, the kubelet will evict you (`The node was low on resource: ephemeral-storage`).

If your cluster exposes kubelet metrics, `kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes` gives you PVC fullness in Prometheus — alert at 80%, not 100%.

### Expanding a PVC live

Works only if the StorageClass has `allowVolumeExpansion: true`:

```bash
kubectl get storageclass standard -o jsonpath='{.allowVolumeExpansion}'   # true
kubectl patch pvc data-api-0 -p '{"spec":{"resources":{"requests":{"storage":"40Gi"}}}}'
kubectl get pvc data-api-0 -w
```

Watch `status.conditions`. Two phases: the backend resize (`Resizing`), then the filesystem grow. Most modern CSI drivers do the filesystem step online — capacity in `df` grows with no restart. Older/offline-resize drivers stop at:

```text
Conditions:
  Type                      Status
  FileSystemResizePending   True    Waiting for user to (re-)start a pod to finish
                                    file system resize of volume on node.
```

That means: delete the pod (normally, not force), let it reschedule, resize completes on mount. Note you can grow but **never shrink** a PVC.

:::tip
Cleaning up beats expanding when the growth is garbage: rotated logs never deleted, tmp files, old heap dumps. `kubectl exec <pod> -- du -xh --max-depth=2 /data | sort -rh | head` before you buy more disk. Expansion is one-way.
:::

## Permission failures on volumes

Symptom: pod runs, app dies or logs `Permission denied` writing to the mount.

```bash
kubectl exec <pod> -- ls -ld /data
# drwxr-xr-x 3 root root 4096 Jul  3 09:12 /data     ← owned by root, you run as 1000
kubectl exec <pod> -- id
# uid=1000 gid=1000 groups=1000
```

Ranked causes:

1. **No `fsGroup` set.** Add to the pod spec:

   ```yaml
   securityContext:
     fsGroup: 1000
   ```

   The kubelet chowns/chmods the volume to that group on mount. This is the fix 80% of the time when you run `runAsNonRoot` with a block-backed PVC.

2. **fsGroup set but ignored.** Whether fsGroup is applied is the driver's call via `fsGroupPolicy` (`csidriver` object: `kubectl get csidriver <name> -o yaml`). Shared-FS drivers (NFS, some CephFS) commonly declare `None` — ownership comes from the server, and no amount of pod YAML changes it.

3. **NFS root-squash.** The classic surprise: everything works in the root-running dev image, then the hardened non-root image can't write — or worse, a *root* process gets squashed to `nobody` and can't write either. Fix on the export side (ask whoever owns the NFS server for `no_root_squash` or export-owned-by-your-GID), or run your process with a UID/GID the export actually grants.

4. **An initContainer chown as last resort:** an init container running as root doing `chown -R 1000:1000 /data` works, but it needs root (fights your PodSecurity level) and `-R` on a big volume is slow every start. Prefer fsGroup.

## Read-only filesystem, suddenly

`Read-only file system` errors from a previously-writable mount. Three distinct causes — check in this order:

1. **You configured it.** `readOnlyRootFilesystem: true` in the securityContext (affects `/`, not the PVC) or `readOnly: true` on the volumeMount. Thirty seconds with `kubectl get pod <pod> -o yaml | grep -B2 -A2 -i readonly` rules this out. Don't skip this step; it's embarrassing to escalate it.

2. **RWO volume mounted ro because of a second consumer.** Some drivers, when a second pod sneaks a reference to an RWO volume, mount it read-only rather than fail. Check whether another pod (a Job, a debug copy you forgot) mounts the same PVC.

3. **The kernel remounted it ro after I/O errors.** ext4's default `errors=remount-ro` behavior: the underlying disk threw errors, the kernel protected the data by going read-only. Evidence from inside the pod:

   ```bash
   kubectl exec <pod> -- sh -c 'dmesg 2>/dev/null | tail -20 || cat /proc/mounts | grep data'
   # /dev/nvme2n1 /data ext4 ro,relatime 0 0        ← mounted rw in spec, now ro
   ```

   This is a node or storage-layer fault, full stop. Don't restart-loop the pod hoping it clears; capture the timestamp, node, and PV name and escalate — the platform team needs to check the node's kernel log and the storage backend. See [Node Problems](/troubleshooting/node-problems/) for the node-side picture.

## StatefulSet-specific storage failures

StatefulSets bind identity to storage: `data-api-2` belongs to pod `api-2`, forever. That buys durability and a few sharp edges — fundamentals in [StatefulSets](/stateful/statefulsets-fundamentals/).

**The zonal trap.** The PVC pins the pod to wherever the volume lives. If `api-2`'s volume was provisioned in `us-east-1c` and that zone (or its last schedulable node) is gone, `api-2` is Pending with `1 node(s) had volume node affinity conflict` — and no amount of cluster capacity elsewhere helps. Confirm with `kubectl get pv <pv> -o yaml` (look at `nodeAffinity`). Prevention: topology-aware StorageClass + `WaitForFirstConsumer` + topology spread constraints, decided *before* you have data.

**PVC stuck Terminating.** You deleted a PVC and it hangs:

```bash
kubectl get pvc data-api-0
# NAME         STATUS        VOLUME    ...
# data-api-0   Terminating   pvc-3f9c...
```

That's the `kubernetes.io/pvc-protection` finalizer doing its job: a PVC won't actually delete while any pod still uses it. This is a feature. If you meant it, delete the consuming pod and the PVC follows. **Never patch the finalizer off** to hurry it — that's how in-use volumes get destroyed.

**The recreate-with-same-name recovery.** Because StatefulSet PVC names are deterministic (`<claim>-<sts>-<ordinal>`), you can rebuild a broken PVC deliberately: if the PV's `reclaimPolicy` is `Retain`, delete the pod and PVC, the PV goes `Released`, then create a new PVC with the **same name** pre-bound via `volumeName:` to that PV (platform may need to clear the PV's old `claimRef`). Pod `api-0` restarts and finds its data. This is the standard escape from a corrupted binding without losing the disk.

## Data-loss adjacent moments

:::danger
**`reclaimPolicy: Delete` + PVC deletion = disk gone.** Check before deleting any PVC: `kubectl get pv <pv> -o jsonpath='{.spec.persistentVolumeReclaimPolicy}'`. `Delete` means the backend volume — and every byte on it — is destroyed when the PVC goes. There is no undelete. For anything stateful, ask platform for `Retain` on the PV first.
:::

:::danger
**Force-deleting a pod with an attached RWO volume** can produce a double-writer and silent corruption, as covered above. The failure isn't immediate — it surfaces days later as fsck errors or garbage reads. If you're tempted to force-delete to unstick a Multi-Attach, escalate instead.
:::

:::caution
**StatefulSet scale-down does not delete PVCs** by default — scale 5→3 and `data-api-3`/`data-api-4` sit Bound, billing you, until scale-up silently reuses their **stale data**. Audit with `kubectl get pvc | grep -v Bound` lies to you here (they *are* Bound); compare PVC ordinals against current replicas instead. Kubernetes 1.27+ lets you opt in to cleanup with `persistentVolumeClaimRetentionPolicy: {whenDeleted: Delete, whenScaled: Delete}` — set it consciously either way.
:::

## The escalation package for storage

Storage escalations bounce when they arrive as "volumes are broken." They get worked immediately when they arrive with the chain of custody. Collect:

```bash
kubectl get pvc <pvc> -o yaml > pvc.yaml
kubectl get pv $(kubectl get pvc <pvc> -o jsonpath='{.spec.volumeName}') -o yaml > pv.yaml
kubectl get pod <pod> -o wide                          # node name — critical
kubectl describe pod <pod> | sed -n '/Events:/,$p'     # exact event text
kubectl get volumeattachment | grep <pv-name>          # readable even from a namespace seat, usually
kubectl get events --sort-by=.lastTimestamp | grep -i -E 'volume|attach|mount' > events.txt
```

Send: **PV name, PVC name, pod, node, the VolumeAttachment line, timestamps (with timezone), and verbatim events** — plus what you already ruled out from this page. That maps your namespace-level symptom onto the node and driver objects the platform team actually operates. Template and etiquette in [Working with the Platform Team](/operations/working-with-platform-team/).

## Quick reference

| Symptom | First command | Likely cause |
|---|---|---|
| PVC Pending, no pod | `kubectl describe pvc` | WaitForFirstConsumer — create the pod |
| PVC Pending, `not found` event | `kubectl get storageclass` | typo'd / missing StorageClass |
| Pod ContainerCreating, Multi-Attach | `kubectl get pods -o wide` (old pod?) | RWO still attached to old node — wait |
| Pod ContainerCreating, FailedMount timeout | events above the timeout | node plugin / NFS / mount options |
| `no space left on device` | `kubectl exec <pod> -- df -h` | PVC full **or** node ephemeral full |
| `Permission denied` on mount | `kubectl exec <pod> -- ls -ld <mount>; id` | missing fsGroup / root-squash |
| Suddenly read-only | `cat /proc/mounts` in pod | I/O errors → remount-ro → escalate |
| STS pod Pending, affinity conflict | `kubectl get pv -o yaml` | volume pinned to a dead zone |
