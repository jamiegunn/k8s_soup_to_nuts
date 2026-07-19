---
title: Services Deep Dive
description: How ClusterIP, NodePort, LoadBalancer, and headless Services actually work — kube-proxy, EndpointSlices, externalTrafficPolicy, and the debugging chain. (The full machinery — the iptables chain walk, IPVS, eBPF, conntrack — lives in [kube-proxy and the Dataplane](/routing/kube-proxy-and-the-dataplane/).)
keywords:
  - service has no endpoints
  - connection refused from a service
  - ClusterIP can't ping
  - Endpoints none
  - targetPort mismatch
  - selector typo
  - EXTERNAL-IP pending
  - externalTrafficPolicy client IP
  - headless service
  - readiness removes pod from service
  - kube-proxy iptables IPVS
  - session affinity stickiness
sidebar:
  order: 4
---

Pod IPs are ephemeral. Services are the answer: a stable virtual IP and DNS name in front of a shifting set of pods. Simple to use, but the mechanics underneath are where debugging happens — and the number one thing to understand is this:

**A ClusterIP is not a real IP.** No interface owns it. Nothing ARPs for it. It exists only as packet-rewriting rules programmed on every node. You cannot ping it (usually), and "the Service is down" is almost never the Service — it's the rules, or more often, the backends behind them.

## ClusterIP: a virtual IP made of rules

```yaml
apiVersion: v1
kind: Service
metadata:
  name: orders
spec:
  selector:
    app: orders
  ports:
    - name: http
      port: 80          # the Service's port (on the ClusterIP)
      targetPort: http  # the container port to send to (name or number)
```

When a pod connects to `orders.myteam.svc.cluster.local:80` (resolving to, say, 10.96.44.7), the packet never travels *to* 10.96.44.7. On its way out of the client node, a rule rewrites the destination to a real pod IP and port — DNAT. The reply is un-rewritten on the way back. Load balancing is per-*connection*, chosen at DNAT time: random (iptables) or round-robin (IPVS's default `rr` scheduler).

**kube-proxy** is the agent (a DaemonSet run by the platform team) that watches Services and EndpointSlices and programs these rules on every node, in one of three modes:

- **iptables** — the classic default. Rules are a big chain; per-connection random pick.
- **nftables** — the modern successor (beta in 1.31, GA in 1.33); same model as iptables, far better scaling on large Services.
- **IPVS** — kernel load balancer; scales better with thousands of Services.
- **eBPF** — Cilium and modern dataplanes replace kube-proxy entirely.

You can't see or fix these rules without node access. What you *can* fully own is everything that feeds them: the Service spec and the endpoints.

:::caution[Long-lived connections don't rebalance]
DNAT happens once per connection. A gRPC channel or JDBC pool opened to a ClusterIP sticks to one pod until it reconnects. If one replica takes all your traffic, this is why — fix it client-side (connection max-age, client-side LB) or with a headless Service, not by yelling at kube-proxy. The full story — gRPC, HTTP/2, WebSockets, and the fixes for each — is in [Long-lived connections](/networking/long-lived-connections/).
:::

## Endpoints and EndpointSlices: where readiness bites

The endpoints controller continuously evaluates: *which pods match this Service's selector, and which of those are Ready?* The result is written to **EndpointSlice** objects (the legacy `Endpoints` object — deprecated since 1.33 — still mirrors them for small Services).

```bash
kubectl get endpointslices -l kubernetes.io/service-name=orders
```

```console
NAME           ADDRESSTYPE   PORTS   ENDPOINTS                     AGE
orders-7x9k2   IPv4          8080    10.244.1.5,10.244.2.7         14d
```

The crucial rule: **a pod that fails its readiness probe is removed from the slice**, and kube-proxy stops sending it traffic within seconds. This is the load-shedding mechanism of Kubernetes — and also the classic total-outage mechanism: a bad config push makes *every* replica unready, the slice empties, and every connection to the Service is refused, even though all pods are Running. Readiness probes gate Service membership; get them right ([health checks](/workloads/health-checks/)).

## The selector→endpoints debugging chain

When "the service doesn't work," walk this chain in order. It finds the fault in under two minutes:

```bash
# 1. Does the Service exist, and what does it point at?
kubectl describe svc orders
# 2. Are there endpoints? (Empty = selector mismatch or no Ready pods)
kubectl get endpointslices -l kubernetes.io/service-name=orders
# 3. Do any pods actually carry the selector labels?
kubectl get pods -l app=orders -o wide
# 4. Are they Ready? (Running ≠ Ready)
kubectl get pods -l app=orders
# 5. Does the pod answer directly on the targetPort? (bypass the Service)
kubectl debug -it client-pod --image=nicolaka/netshoot -- curl -sv http://10.244.1.5:8080/healthz
```

| Symptom at each step | Meaning |
|---|---|
| `describe svc` shows `Endpoints: <none>` | Selector matches nothing, or nothing is Ready |
| Pods exist but not in slice | Readiness failing — check `kubectl describe pod` |
| Slice populated, direct pod curl works, Service curl fails | Wrong `port`/`targetPort` mapping, or NetworkPolicy |
| Direct pod curl fails too | Your app — not the network at all |

The single most common bug in this chain: `targetPort` doesn't match what the container listens on, or the selector has a typo (`app: order` vs `app: orders`). The Service accepts any selector silently; nothing validates it against real pods.

**Named ports** save you here. Declare the port name in the pod spec and reference it from the Service — then changing the container port number is a one-place edit:

```yaml
# In the pod template:
ports:
  - name: http
    containerPort: 8080
# In the Service:
targetPort: http
```

## NodePort

`type: NodePort` does everything ClusterIP does, *plus* opens a port (default range 30000–32767) on **every node's** IP. Traffic to `<anyNodeIP>:31234` gets DNATed to a backend pod — even if that pod runs on a different node (kube-proxy forwards it across, SNATing so replies return the same way).

You rarely use NodePort directly; it mostly exists as the substrate for the next type. Direct use cases: on-prem clusters where an external, manually-configured LB points at node ports, or quick demos. Beware: firewalls between clients and nodes must allow the port range, which is a platform team conversation.

## LoadBalancer

`type: LoadBalancer` = NodePort + "please provision an external load balancer pointing at those node ports." *Something* must act on that request — a cloud controller (AWS/Azure/GCP), [MetalLB](/controllers/metallb/), or F5 CIS on-prem. If nothing does, the Service sits at `EXTERNAL-IP: <pending>` forever — that's a platform ticket, not a manifest bug. Full treatment in [External load balancing](/networking/external-load-balancing/).

## Headless Services: when you need real pod IPs

Set `clusterIP: None` and there is no virtual IP and no proxying. DNS for the Service name returns **all Ready pod IPs directly**, and each pod gets its own DNS record.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: valkey
spec:
  clusterIP: None
  selector:
    app: valkey
  ports:
    - port: 6379
```

You need headless when:

- **StatefulSets** — stable per-pod DNS (`valkey-0.valkey.myteam.svc.cluster.local`) is how replicas find each other. See [StatefulSets fundamentals](/stateful/statefulsets-fundamentals/).
- **Client-side load balancing** — gRPC clients, Kafka clients, and database drivers that want to know every backend and pick their own.
- **Peer discovery** — clustering software (Hazelcast, Akka, Elasticsearch) that forms a mesh.

Trade-off: clients get IPs at resolution time and must re-resolve to notice pod churn. A client that caches DNS forever (looking at you, default JVM security settings) will merrily reconnect to a dead IP.

## sessionAffinity

```yaml
spec:
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 10800
```

Pins a client IP to one backend for the timeout window. It's crude — the "client IP" kube-proxy sees may be a SNATed node IP or an ingress controller pod, collapsing many users onto one backend. If you need stickiness for HTTP, do it at the [ingress layer](/networking/ingress-and-routing/) with cookies instead. If your app needs affinity to *work correctly*, that's a design smell — externalize the session state ([Valkey/Redis](/stateful/valkey-and-redis/)).

## externalTrafficPolicy: source IPs vs balance

Applies to NodePort/LoadBalancer traffic. The default, `Cluster`, lets any node accept traffic and forward to any pod — and it **masquerades that traffic to the node's IP, so your app sees a node IP instead of the client IP**. This happens for *all* external traffic under `Cluster`, whether or not the endpoint is on the node that received it — the masquerade is what lets a cross-node reply find its way back.

`externalTrafficPolicy: Local` only accepts traffic on nodes that host a Ready backend pod and never forwards across nodes — **preserving the real client source IP**, at a price:

- Nodes without your pods fail the LB's health checks (by design — that's how the LB learns where pods are, via the `healthCheckNodePort`).
- Load can be imbalanced: the external LB balances across *nodes*, so a node with one pod and a node with three pods each get 50%.
- During rollouts, a node can briefly have zero Ready pods → connection resets if the LB is slow to react.

Rule of thumb: use `Local` when you need client IPs (audit logs, geo, rate limiting) and run enough spread-out replicas to absorb imbalance; otherwise leave `Cluster`. Deeper dive in [External load balancing](/networking/external-load-balancing/).

## Quick reference

| Type | Reachable from | Real IP? | Use for |
|---|---|---|---|
| ClusterIP | Inside cluster | Virtual (rules only) | Default; everything internal |
| Headless (`clusterIP: None`) | Inside cluster | Pod IPs via DNS | StatefulSets, client-side LB, peer discovery |
| NodePort | Anything that reaches node IPs | Node IPs, high port | Substrate for LBs; rare direct use |
| LoadBalancer | External clients | External VIP | Public/enterprise entry points (needs a provisioner) |
| [ExternalName](/architectures/external-database/) | Inside cluster | None — a DNS CNAME | Aliasing an off-cluster host (DB, API) to a cluster name; mind the CNAME-lie/IP trap |

Next layer up: HTTP-aware routing with [Ingress](/networking/ingress-and-routing/). Next layer down: how names become these IPs at all — [DNS](/networking/dns/).
