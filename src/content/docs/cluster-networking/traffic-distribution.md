---
title: "Zone-Aware Traffic: Topology & trafficDistribution"
description: Keep Service traffic in the client's own zone to cut cross-AZ latency and data-transfer cost, using Topology Aware Routing or spec.trafficDistribution.
keywords:
  - cross-AZ data transfer cost
  - cross-zone latency
  - keep traffic in same zone
  - Topology Aware Routing
  - topology aware hints
  - PreferClose
  - service.kubernetes.io/topology-mode
  - internalTrafficPolicy Local
  - EndpointSlice hints forZones
  - zone-local traffic
  - p99 latency multi-AZ
sidebar:
  order: 3
---

By default, a Service is zone-blind. When your pod connects to a ClusterIP, kube-proxy picks *any* Ready endpoint in the cluster — with equal probability, no matter which zone it lives in. That sounds fair, and it is. It's also expensive.

Picture a cluster spread across three availability zones with your backend running one replica per zone. A client in zone A has a two-in-three chance of being sent to a pod in zone B or C. Every one of those requests crosses a zone boundary — adding a few milliseconds of latency *and*, on every major cloud, a per-gigabyte **cross-AZ data-transfer charge** in each direction. Multiply by millions of requests a day and it's a real line item.

The insidious part: none of this shows up on a Service dashboard. Endpoints are healthy, error rate is zero, throughput is fine. You find out from the p99 latency graph or, more painfully, from the monthly bill. This page is about telling the Service to prefer *local* endpoints so most traffic never leaves the zone it started in.

## The modern fix: spec.trafficDistribution

Newer clusters have a first-class field for this. Set it right on the Service:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: orders
spec:
  selector:
    app: orders
  trafficDistribution: PreferClose   # keep traffic in the client's zone when possible
  ports:
    - port: 80
      targetPort: http
```

Semantics of `PreferClose`: the endpoint-routing machinery (kube-proxy, or your CNI's dataplane) **prefers endpoints in the same zone as the client**. If the client's zone has no Ready endpoints, it falls back to the full cluster-wide set. It is a *preference*, not a hard pin — traffic is never dropped just because the local zone is empty. It quietly spills over instead.

Version facts (confirm against your own cluster version — `kubectl version`):

| Kubernetes version | Status of `trafficDistribution` |
|---|---|
| v1.30 | Alpha (behind a feature gate) |
| v1.31 | Beta, on by default |
| v1.33 | GA, with `PreferClose` |

If your cluster is v1.31 or newer, this is almost certainly available. On anything older, you fall back to the annotation below.

## The older mechanism: Topology Aware Routing

Before the field existed, the same idea shipped as **Topology Aware Routing** (originally "Topology Aware Hints"). You opt in with an annotation instead of a spec field:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: orders
  annotations:
    service.kubernetes.io/topology-mode: Auto
spec:
  selector:
    app: orders
  ports:
    - port: 80
      targetPort: http
```

Under the hood, the EndpointSlice controller computes per-endpoint **hints** — `hints.forZones` — that tell kube-proxy which zones each endpoint should serve. kube-proxy then honours those hints when it picks a backend. You can see the hints on the slice itself:

```bash
kubectl get endpointslice -l kubernetes.io/service-name=orders -o yaml
```

```yaml
endpoints:
  - addresses: ["10.244.1.5"]
    conditions:
      ready: true
    zone: us-east-1a
    hints:
      forZones:
        - name: us-east-1a      # this endpoint is hinted to serve zone us-east-1a
```

:::caution[Auto often does nothing — silently]
`topology-mode: Auto` is conservative by design. It only activates when there are **enough endpoints spread across enough zones** to balance load safely. If you have three replicas but they all landed in one zone, or you only have a couple of endpoints, the controller populates *no* hints and traffic stays cluster-wide. There's no error and no event — it just doesn't engage. If you set the annotation and see no `hints:` on the slice, that's why: spread your replicas across zones first.
:::

## Which one to use

Prefer the field on new-enough clusters; reach for the annotation only when you can't.

| | `trafficDistribution: PreferClose` | `service.kubernetes.io/topology-mode: Auto` |
|---|---|---|
| Mechanism | Spec field, routing prefers same zone | Annotation, EndpointSlice `hints.forZones` |
| Available since | Beta v1.31, GA v1.33 | Older (predates the field) |
| Granularity | Same-zone preference, simple | Controller decides hints, only engages when endpoints are well spread |
| Failure mode | Falls back cluster-wide | May silently do nothing |

If both are set, the field is the one to keep — treat the annotation as the legacy path you're migrating off of.

## The stricter cousin: internalTrafficPolicy: Local

It's easy to confuse zone-aware routing with `internalTrafficPolicy: Local`, but they are **not** the same, and mixing them up will bite you.

```yaml
spec:
  internalTrafficPolicy: Local   # same NODE only — drops if none
```

`internalTrafficPolicy: Local` routes cluster-internal Service traffic **only to pods on the same node as the client**. Not the same zone — the same *node*. If there's no Ready pod on that node, the traffic is **dropped**, not spilled over. It exists to avoid a network hop entirely, which is what you want for node-local agents and DaemonSets (a logging or metrics sidecar-style agent that every pod should talk to on its own node).

The contrast in one line:

- **`trafficDistribution: PreferClose`** — *soft* preference for the same **zone**, falls back cluster-wide.
- **`internalTrafficPolicy: Local`** — *hard* restriction to the same **node**, drops when there's nothing local.

The routing mechanics behind both — how kube-proxy actually rewrites and picks these packets, and where SNAT enters — live in [SNAT and DNAT](/routing/nat/) and [kube-proxy and the Dataplane](/routing/kube-proxy-and-the-dataplane/). No need to re-derive them here; just know that `Local` means node, not zone.

## Trade-offs and the hot-spot trap

Zone-aware routing assumes your replicas are reasonably spread. When they aren't, keeping traffic local can *create* imbalance instead of curing it.

The classic failure: a Service with heavy traffic in zone A but only **one** replica there. With `PreferClose`, nearly all of zone A's requests pile onto that single pod, which runs hot while replicas in quieter zones sit idle. You traded cross-AZ cost for a saturated pod.

The rules that keep this safe:

- **Enough replicas per zone.** Don't enable zone preference with one pod per zone and lopsided traffic. Give each zone enough capacity to serve its own load.
- **Pair it with topology spread constraints** so the scheduler actually distributes replicas across zones rather than clumping them.
- **Lean on the soft fallback.** Both `PreferClose` and the `Auto` annotation spill over to cluster-wide rather than dropping traffic — that's the safeguard. Only `internalTrafficPolicy: Local` drops, so reserve it for cases where a missing local pod genuinely means "don't send this anywhere else."

:::note[Watch for it engaging, not just being set]
After you turn this on, confirm it's actually doing something: check that your cross-zone traffic (or cloud data-transfer cost) drops, and — for the annotation path — that `hints:` appears on the EndpointSlice. Setting the field or annotation is necessary but not sufficient; the spread of your replicas is what makes it real.
:::

## What you own vs. the platform team

| You own | Platform / cloud reality |
|---|---|
| Setting `trafficDistribution: PreferClose` (or the annotation) on your Service | Cross-AZ data-transfer pricing |
| Spreading your replicas across zones (topology spread constraints) | The cluster's zone topology and node labels |
| Confirming the effect on latency and cost | Cluster version (whether the field exists) and kube-proxy/CNI dataplane |

Your levers are the Service spec and where your pods land. The zone map and the price per gigabyte are the environment you're optimizing *against* — you can't change them, but a two-word field can stop most of your traffic from paying them.

For the bigger picture of how traffic moves inside the cluster, see the [Cluster Networking overview](/cluster-networking/overview/).
