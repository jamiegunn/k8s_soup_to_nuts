---
title: Service CIDR & ClusterIP Allocation
description: Where ClusterIPs come from — the service CIDR the platform sets, how each Service draws one IP, and what to do when the pool runs dry and Services stop getting IPs.
keywords:
  - range is full
  - failed to allocate a serviceIP
  - provided IP is already allocated
  - service cluster ip range
  - out of cluster IPs
  - helm install fails at service
  - servicecidr ipaddress object
  - MultiCIDRServiceAllocator
  - too many services
  - clusterIP none no IP
  - kubernetes service default ClusterIP
sidebar:
  order: 2
---

A [ClusterIP](/networking/services-deep-dive/) is not a real IP — it's a virtual address made of packet-rewriting rules on every node, and nothing ever ARPs for it. That page is about the *rules*. This page is about the *IP itself*: which pool it's drawn from, how one gets handed to your Service, and what happens the day the pool is empty and `kubectl apply` starts refusing to give your Service an address.

## The service CIDR: a pool you don't own

Every ClusterIP comes out of one cluster-wide range — the **service CIDR** — set once by the platform team on the API server:

```text
kube-apiserver --service-cluster-ip-range=10.96.0.0/12
```

You can't read that flag (it's control-plane config you don't have access to), but you don't need to. You can **infer where the range starts** from a Service that every cluster has: the `kubernetes` Service in the `default` namespace, which always holds the *first usable IP* of the range.

```bash
kubectl get svc kubernetes -n default
```

```console
NAME         TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)   AGE
kubernetes   ClusterIP   10.96.0.1    <none>        443/TCP   287d
```

`10.96.0.1` is the bottom of the pool, so the range starts at `10.96.0.0`. What the first IP *can't* tell you is the mask — `10.96.0.0/12`, `/16`, and `/24` all begin with the same address — so the pool's size is platform config: ask, or on 1.31+ run `kubectl get servicecidr` (shown below). This cluster's range is `10.96.0.0/12` (roughly `10.96.0.0`–`10.111.255.255`). Write that number in your team runbook next to the pod CIDR and node range — it turns every "why won't this Service come up" conversation from guesswork into arithmetic. (Same trick, other ranges, in the [networking model](/networking/networking-model/) orientation commands.)

## How a Service gets its IP

Every Service of `type: ClusterIP`, `NodePort`, or `LoadBalancer` draws **exactly one** IP from that pool. Two ways it happens:

**Dynamic (the normal case)** — omit `clusterIP` and the API server picks a free one:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: orders
spec:
  selector:
    app: orders
  ports:
    - port: 80
      targetPort: http
  # no clusterIP field → allocated automatically
```

**Static** — pin a specific address:

```yaml
spec:
  clusterIP: 10.96.0.10   # must be in-range AND currently free
```

A static IP has to be inside the service CIDR *and* not already taken. Ask for one that's out of range or already allocated and the create is rejected outright — see the errors below. Pinning ClusterIPs is rarely worth it; the classic legitimate case is the cluster DNS Service (often `10.96.0.10`), which needs a fixed address because it's baked into every pod's `/etc/resolv.conf`.

**Headless Services consume no IP.** Set `clusterIP: None` and there's no virtual IP at all — DNS returns pod IPs directly. If you don't actually need a VIP (StatefulSets, client-side load balancing, peer discovery), going headless costs the pool nothing. Details in [Services Deep Dive](/networking/services-deep-dive/).

:::note[NodePort and LoadBalancer still spend a ClusterIP]
A `type: NodePort` or `type: LoadBalancer` Service is a ClusterIP *plus* extra reachability. It still allocates one IP from the service CIDR. The node port and the external VIP come from other pools — they don't spare you the ClusterIP.
:::

## How the platform tracks allocation

Historically this was an **in-memory bitmap** inside the API server — invisible, no objects to query. You only found out the pool was full when a create failed.

Newer clusters expose allocation as real API objects through the **MultiCIDRServiceAllocator** feature. When it's on, the service CIDR and every allocated address become things you may be able to `kubectl get`:

```bash
kubectl get servicecidr
```

```console
NAME      CIDRS           AGE
kubernetes  10.96.0.0/12  287d
```

```bash
kubectl get ipaddress
```

```console
NAME         AGE
10.96.0.1    287d
10.96.0.10   287d
10.96.44.7   14d
```

Each `IPAddress` object is one taken ClusterIP; the `ServiceCIDR` object is the pool. This makes exhaustion diagnosable instead of mysterious.

:::note[Version facts — check your cluster's version]
`MultiCIDRServiceAllocator` was **alpha in v1.27**, went **beta and on-by-default in v1.31**, and reached **GA in v1.33**. On clusters older than that (or with the feature disabled) `kubectl get servicecidr` / `kubectl get ipaddress` will return "the server doesn't have a resource type" — that just means your cluster still uses the in-memory allocator. Confirm with `kubectl version` and, if in doubt, ask the platform team.
:::

## Exhaustion: the incident

The pool is finite. When it fills up, new Services can't get an IP, and the failure is loud but easy to misread as an app bug.

The two error shapes you'll see:

```console
Error from server (InternalError): Internal error occurred:
  failed to allocate a serviceIP: range is full
```

```console
The Service "orders" is invalid: spec.clusterIP:
  Invalid value: "10.96.0.10": provided IP is already allocated
```

The first means the whole range is exhausted. The second means the specific static IP you requested is taken (or out of range) — a narrower problem, but the same family.

**Symptoms as they show up in the wild:**

- New Services get created but sit with **no ClusterIP assigned**, or `kubectl apply` errors immediately.
- A **Helm install or upgrade fails partway**, at the point it tries to create a Service — leaving a half-installed release.
- It's cluster-wide: it's not *your* Service that's broken, it's that the shared pool is dry, so everyone's new Services fail at once.

**What actually causes it:**

| Cause | What it looks like |
|---|---|
| Service CIDR too small | A `/24` gives ~254 IPs; a busy cluster blows past that. Sizing was set at install and never revisited. |
| Leaked / orphaned Services | Deleted apps whose Services were never cleaned up; failed Helm releases leaving Services behind. |
| A namespace churning Services | CI creating a Service per build, per-PR preview environments, or an operator that makes ephemeral Services and doesn't reap them. |

## What you own vs what the platform owns

This is the part that decides whether you fix it in ten minutes or file a ticket.

**You can, right now, without anyone's help:**

- **Delete Services you don't need.** Find your own footprint and prune the dead ones:
  ```bash
  kubectl get svc -A --sort-by=.metadata.creationTimestamp
  kubectl delete svc <old-thing> -n <your-namespace>
  ```
- **Prefer headless** (`clusterIP: None`) anywhere you don't need a virtual IP — it draws nothing from the pool.
- **Stop creating a Service per ephemeral thing.** Per-PR previews and per-build Services are the number-one self-inflicted cause. Reuse one Service, or tear them down in the same pipeline that creates them.

**You cannot** resize the service CIDR — that's not in your RBAC and never will be. But how big a lift it is for the platform depends on the cluster:

- **MultiCIDR clusters (v1.31+ with the feature on):** the platform can **add a new `ServiceCIDR` object live**, extending the pool with no API-server restart. Relatively cheap.
- **Older clusters:** widening `--service-cluster-ip-range` is a **control-plane change** — an API-server flag edit and restart, sometimes a rebuild. That's a real platform-team ticket with a maintenance window, not a same-day fix.

Either way, **hand them evidence, not a vibe.** Attach:

```bash
# 1. The exact failing error (copy it verbatim)
# 2. How many Services already exist cluster-wide:
kubectl get svc -A | wc -l
# 3. The inferred pool size — read the range off the kubernetes Service:
kubectl get svc kubernetes -n default
```

A ticket that says "`range is full`, we have 4,000 Services, and the pool is a `/20` (~4,094 IPs)" gets sized and scheduled. "Services are broken" gets a week of back-and-forth.

## Quick reference

| Service type | Consumes a ClusterIP from the pool? |
|---|---|
| `ClusterIP` | Yes — one IP |
| Headless (`clusterIP: None`) | No — DNS returns pod IPs |
| `NodePort` | Yes — ClusterIP plus a node port |
| `LoadBalancer` | Yes — ClusterIP plus an external VIP |

The rule to remember: **anything with a virtual IP spends one address; headless is free.** When the pool gets tight, that distinction is your cheapest lever.

See the [Cluster Networking overview](/cluster-networking/overview/) for how the service CIDR sits alongside the pod CIDR and node network, and [Services Deep Dive](/networking/services-deep-dive/) for what those allocated IPs actually *do* once you have one.
