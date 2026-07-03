---
title: StatefulSets Fundamentals
description: How StatefulSets differ from Deployments — stable identity, ordered rollout, volumeClaimTemplates — and the gotchas that bite in production.
sidebar:
  order: 2
---

A Deployment treats pods as cattle: interchangeable, randomly named (`api-7d9f8b6c5-x2kqp`), replaced without ceremony. A StatefulSet treats them as pets with name tags: `postgres-0`, `postgres-1`, `postgres-2` — each with its own persistent volume and its own DNS name, created and destroyed in order.

If you're coming from Deployments, read [Deployments Deep Dive](/workloads/deployments-deep-dive/) first; this article covers what changes when identity matters.

## What a StatefulSet guarantees

1. **Stable, ordinal pod names.** Pods are named `<statefulset-name>-0` through `-N`. Pod `valkey-1` that dies is replaced by a new pod *also named* `valkey-1`, attached to the same PVC.
2. **Stable per-pod DNS**, via a headless Service (`clusterIP: None`):

   ```text
   valkey-0.valkey-headless.myapp.svc.cluster.local
   valkey-1.valkey-headless.myapp.svc.cluster.local
   ```

   This is how replication topologies are wired: "replica connects to `valkey-0.valkey-headless`" survives pod rescheduling. The regular Service gives you a load-balanced VIP; the headless Service gives you addressable individuals. Stateful apps usually need both.
3. **Ordered operations.** By default, pods are created 0→N (each waiting for the previous to be Running and Ready), deleted N→0, and rolled N→0 during updates.
4. **PVC per pod**, via `volumeClaimTemplates`.

## A complete minimal example

```yaml
apiVersion: v1
kind: Service
metadata:
  name: valkey-headless
spec:
  clusterIP: None          # headless — gives each pod a DNS record
  selector:
    app: valkey
  ports:
    - port: 6379
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: valkey
spec:
  serviceName: valkey-headless   # must reference the headless Service
  replicas: 3
  selector:
    matchLabels:
      app: valkey
  template:
    metadata:
      labels:
        app: valkey
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: valkey
          image: valkey/valkey:8.0
          ports:
            - containerPort: 6379
          volumeMounts:
            - name: data
              mountPath: /data
          resources:
            requests: { cpu: 250m, memory: 512Mi }
            limits:   { memory: 768Mi }
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd     # ask platform what exists
        resources:
          requests:
            storage: 10Gi
```

Each replica gets its own PVC, named `<template>-<pod>`: `data-valkey-0`, `data-valkey-1`, `data-valkey-2`.

## PVC lifecycle: the part everyone gets wrong

PVCs created from `volumeClaimTemplates` are **not** garbage-collected with the pod, and historically not even with the StatefulSet:

- Delete pod `valkey-1` → PVC `data-valkey-1` stays. The replacement pod reattaches to it. This is the whole point.
- Scale from 3 to 2 → pod `valkey-2` is deleted, PVC `data-valkey-2` **remains**. Scale back up and the data is still there (which can surprise you: a stale replica rejoins with old data).
- Delete the whole StatefulSet → PVCs remain, by default.

Since Kubernetes 1.27 (stable in 1.32) you can opt into cleanup with `persistentVolumeClaimRetentionPolicy`:

```yaml
spec:
  persistentVolumeClaimRetentionPolicy:
    whenDeleted: Retain    # or Delete
    whenScaled: Retain     # or Delete
```

Leave both as `Retain` for anything holding real data. `Retain` here still only protects the PVC — whether the underlying volume survives PVC deletion is the StorageClass's `reclaimPolicy`. See [Storage: PV, PVC, StorageClass](/stateful/storage-pv-pvc/).

## Rolling updates and the partition canary

Default `updateStrategy` is `RollingUpdate`: pods are replaced one at a time, highest ordinal first (`-2`, then `-1`, then `-0`), each waiting for readiness. `partition` lets you canary:

```yaml
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 2    # only pods with ordinal >= 2 get the new revision
```

Push the new image, and only `valkey-2` updates. Watch it, then lower `partition` to 1, then 0 to complete the rollout. This is the StatefulSet equivalent of a canary deployment and it's underused. General rollout mechanics are covered in [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/).

`OnDelete` is the other strategy: nothing updates until you delete pods yourself. Some database operators use it to control update order precisely.

## podManagementPolicy

`OrderedReady` (default): strict one-at-a-time creation and scaling. `Parallel`: all pods launch/terminate at once — **updates are still ordered**, only create/delete during scaling is parallelized. Use `Parallel` when pods don't depend on each other at startup (many clustered systems that do their own discovery, e.g. Kafka under Strimzi). Keep `OrderedReady` when pod 0 must bootstrap first.

## The classic gotchas

### volumeClaimTemplates are immutable

You cannot edit `volumeClaimTemplates` on a live StatefulSet — not the size, not the storage class:

```console
$ kubectl apply -f valkey.yaml
The StatefulSet "valkey" is invalid: spec: Forbidden: updates to statefulset
spec for fields other than 'replicas', 'ordinals', 'template', 'updateStrategy',
'persistentVolumeClaimRetentionPolicy' and 'minReadySeconds' are forbidden
```

To grow volumes: if the StorageClass allows expansion, edit each **PVC** directly (`kubectl patch pvc data-valkey-0 ...`) — the pods keep running. To make the template match reality for future replicas, delete the StatefulSet *without* deleting its pods, then recreate it with the new template:

```bash
kubectl delete statefulset valkey --cascade=orphan
kubectl apply -f valkey-new-size.yaml   # adopts the running pods
```

`--cascade=orphan` is the safety net: pods and PVCs stay up while the controller object is swapped out.

### The stuck rollout: pod 0 never becomes Ready

Rolling updates go N→0, so a bad image or config often manifests as: `-2` and `-1` updated fine, `-0` is crash-looping, and the rollout is wedged. Worse — with `OrderedReady`, a StatefulSet **won't proceed with anything** while a pod is unready, so a wedged update also blocks scaling.

```console
$ kubectl rollout status statefulset/valkey
Waiting for 1 pods to be ready...
```

Recovery: fix the template (or `kubectl rollout undo statefulset/valkey`) and then, crucially, **delete the stuck pod** — the controller won't replace a crash-looping pod with the reverted spec on its own in all cases:

```bash
kubectl rollout undo statefulset/valkey
kubectl delete pod valkey-0
```

See [CrashLoopBackOff](/troubleshooting/crashloopbackoff/) for diagnosing the pod itself.

### Force-deleting StatefulSet pods

When a node goes dark, its pods sit in `Terminating` forever, and the StatefulSet will **not** create a replacement — it can't be sure the old pod isn't still running and writing to the volume. Two pods with the same identity writing to the same replicated store is how you corrupt data.

```console
$ kubectl get pods -l app=valkey
NAME       READY   STATUS        RESTARTS   AGE
valkey-0   1/1     Terminating   0          4d
```

The safe path: wait for the platform team to confirm the node is fenced (powered off or removed from the cluster). Only then:

```bash
kubectl delete pod valkey-0 --grace-period=0 --force
```

:::danger[Force delete only after fencing]
`--force` tells the API server to drop the pod record *without confirmation the process is dead*. If the node is merely partitioned — not dead — you now have two `valkey-0`s. For quorum systems this is a split-brain generator. Confirm node state with your platform team first; see [Node Problems](/troubleshooting/node-problems/).
:::

## Quick reference: StatefulSet vs Deployment

| | Deployment | StatefulSet |
|---|---|---|
| Pod names | Random hash | Ordinal, stable |
| Per-pod DNS | No | Yes (headless Service) |
| Per-pod storage | No (shared or none) | `volumeClaimTemplates` |
| Rollout order | Any, surge allowed | N→0, no surge |
| Replace pod on dead node | Immediately | Only after pod object removed |
| Use when | Interchangeable replicas | Identity or per-replica data matters |

If your workload doesn't need stable identity or per-pod volumes — a cache you can repopulate, for instance — use a Deployment and save yourself the operational weight. More on that call in [Valkey and Redis](/stateful/valkey-and-redis/).
