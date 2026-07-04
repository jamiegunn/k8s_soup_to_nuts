---
title: Networking Overview
description: A layered mental model for Kubernetes networking — pod network, Services, Ingress, external load balancers — and who owns which layer.
sidebar:
  order: 1
---

Kubernetes networking has a reputation for being impenetrable. It isn't — it's just *layered*, and most confusion comes from debugging the wrong layer. A 502 from your ingress, a `Connection refused` from a ClusterIP, and a DNS timeout are three different layers with three different owners and three different fixes.

This section gives you the mental model, then works through each layer in depth.

## The four layers

Traffic to your application crosses four layers. Learn them in order, because packets do.

```text
 [4] External world      (corporate LB, cloud LB, DNS, firewalls)
      │
 [3] Ingress / Gateway   (HTTP routing, TLS termination, host/path rules)
      │
 [2] Service             (stable virtual IP, load balancing across pods)
      │
 [1] Pod network         (every pod gets an IP, flat connectivity)
```

**Layer 1 — the pod network.** Every pod gets its own IP address, and every pod can reach every other pod without NAT. This is the Kubernetes network contract, implemented by a CNI plugin (Calico, Cilium, Flannel, or a cloud provider's CNI). You don't choose or configure the CNI, but knowing which one your cluster runs matters enormously when things break.

**Layer 2 — Services.** Pod IPs are ephemeral — they change on every restart. A Service gives you a stable virtual IP (ClusterIP) and DNS name that load-balances across the pods matching its selector. The catch: a ClusterIP is not a real network interface anywhere. It exists only as packet-rewriting rules (iptables, IPVS, or eBPF) programmed on every node.

**Layer 3 — Ingress and Gateway API.** Services are L4 (TCP/UDP). For HTTP concerns — host-based routing, path routing, TLS termination — you write an Ingress resource (or an HTTPRoute if your cluster uses Gateway API), and a controller the platform team runs turns it into actual proxy configuration.

**Layer 4 — external entry.** How traffic gets from the outside world to layer 3: cloud load balancers provisioned by `type: LoadBalancer` Services, or on-prem solutions like MetalLB or F5 BIG-IP.

## Who owns what

This is the single most useful table in this section. When something breaks, it tells you whether to debug or to file a ticket.

| Layer | Component | Owner |
|---|---|---|
| Pod network | CNI plugin, node routing, MTU, IP address management | Platform team |
| Pod network | Your container ports, probes, what your app binds to | **You** |
| Service | Service manifests, selectors, ports, `externalTrafficPolicy` | **You** |
| Service | kube-proxy, iptables/IPVS/eBPF programming | Platform team |
| DNS | CoreDNS deployment, Corefile, upstream forwarders | Platform team |
| DNS | Per-pod `dnsPolicy` / `dnsConfig`, how your app resolves names | **You** |
| Ingress | Ingress / HTTPRoute resources in your namespace | **You** |
| Ingress | The ingress controller itself, IngressClasses, Gateways, wildcard certs | Platform team |
| NetworkPolicy | Policies selecting your pods | **You** (enforcement depends on the platform's CNI) |
| External LB | Cloud LB config, MetalLB address pools, F5 partitions, firewalls | Platform team |

The pattern: **you own the declarative resources in your namespace; the platform team owns the machinery that makes them real.** You write a Service; kube-proxy makes it work. You write an Ingress; their nginx pods route for it. You write a NetworkPolicy; their CNI enforces it — or silently doesn't (see [Network Policies](/networking/network-policies/)).

:::tip[The first question in any network incident]
"Which layer is failing?" Test each hop independently — pod-to-pod, pod-to-Service, pod-to-DNS, external-to-ingress — instead of testing end-to-end and guessing. The [debugging playbook](/networking/debugging-network/) makes this systematic.
:::

## Vocabulary you'll need

Ten terms this section uses constantly. If any are fuzzy, the linked articles fix that.

- **CNI (Container Network Interface)** — the plugin that wires pods into the network and assigns their IPs. Platform-chosen; behavior varies (Calico, Cilium, Flannel, cloud CNIs).
- **veth pair** — the virtual cable connecting a pod's `eth0` to the node. The lowest layer you'll ever reason about.
- **ClusterIP** — a Service's virtual IP. Exists only as packet-rewriting rules; you can't ping it, and that's normal.
- **kube-proxy** — the node agent that programs those rules (iptables/IPVS mode; eBPF dataplanes replace it entirely).
- **EndpointSlice** — the live list of Ready pod IPs behind a Service. The first thing to check in any Service incident.
- **Readiness** — the probe result that gates EndpointSlice membership. Unready pods get no traffic; all-unready means total outage even with every pod Running.
- **NodePort** — a high port (30000–32767) opened on every node, mostly as plumbing for external LBs.
- **Ingress controller** — the platform-run proxy (nginx, Traefik, HAProxy...) that turns your Ingress resources into actual routing.
- **CoreDNS** — the cluster DNS server; answers `*.cluster.local` and forwards the rest upstream.
- **SNAT/DNAT** — source/destination address rewriting. DNAT makes ClusterIPs work; SNAT is why external systems see node IPs instead of pod IPs, and why `externalTrafficPolicy` exists.

## Failure signatures, mapped to layers

You'll see these repeatedly. Each has a home article:

| Symptom | Layer to suspect | Start here |
|---|---|---|
| `Connection refused` from a Service | App/port mapping — the network delivered your packet | [Services deep dive](/networking/services-deep-dive/) |
| Timeout to a Service, pods are Ready | NetworkPolicy, then port mapping | [Network policies](/networking/network-policies/) |
| `EXTERNAL-IP: <pending>` forever | LB provisioning (platform) | [External load balancing](/networking/external-load-balancing/) |
| Every Nth request stalls ~5 seconds | DNS retry after a dropped UDP query | [DNS](/networking/dns/) |
| External lookups slow, internal instant | `ndots:5` search-domain walk | [DNS](/networking/dns/) |
| Small responses fine, large ones hang | MTU blackhole (platform, but you can prove it) | [Debugging the network](/networking/debugging-network/) |
| 502/504 from the ingress, in-cluster curl works | Ingress layer: probes, timeouts, TLS, policy | [Ingress and routing](/networking/ingress-and-routing/) |
| New pods can't reach the DB after a rollout | Egress policy vs changed labels | [Network policies](/networking/network-policies/) |

## What you can actually do without cluster access

You can't SSH to nodes, read kube-proxy logs, or tcpdump the CNI. That's fine. You have plenty:

- **Ephemeral debug containers.** `kubectl debug -it <pod> --image=nicolaka/netshoot --target=<container>` drops a full network toolkit (curl, dig, tcpdump, ss, traceroute) into your pod's network namespace without rebuilding the image.
- **EndpointSlices.** `kubectl get endpointslices -l kubernetes.io/service-name=<svc>` tells you instantly whether your Service has healthy backends — the answer to half of all "service is down" pages.
- **Events and controller status.** Ingress and LoadBalancer resources surface controller errors in `kubectl describe` output.
- **Symptom triangulation.** Even when the broken component is platform-owned, you can localize the fault ("external DNS lookups from pods take 5+ seconds, internal names are instant") so your ticket gets acted on instead of bounced back.

A worked example of the split. Your service intermittently times out calling another team's API. You can't see kube-proxy or the CNI — but from a debug container you establish: direct pod-IP connections always work, ClusterIP connections from *one specific node's* pods time out, DNS is instant. That's a kube-proxy programming problem on one node, and your ticket says exactly that, with node name and packet captures. Compare that to "the network is flaky" — which gets triaged last and bounced back with "works for me." Precision about layers is how namespace-scoped teams get platform problems fixed fast.

If the whole "work through constraints" posture is new to you, [working without admin](/start/working-without-admin/) sets up the general approach; this section applies it to the network specifically.

## One request, end to end

To see the layers compose, trace a single HTTPS request from a customer's browser to your `orders` pod:

1. **External DNS** resolves `orders.example.com` to the load balancer's public IP. (Corporate DNS team or cloud — outside the cluster entirely.)
2. **The external LB** (layer 4) accepts the TCP connection and forwards it to a node port backing the ingress controller's Service.
3. **kube-proxy's rules** on that node DNAT the packet to an ingress controller pod (layer 2 machinery working for layer 3's benefit).
4. **The ingress controller** (layer 3) terminates TLS, matches `host: orders.example.com, path: /api` against your Ingress resource, and picks a backend pod IP from your Service's EndpointSlice.
5. **The pod network** (layer 1) carries the proxied request from the controller pod to your pod — across nodes via the CNI's overlay or routing.
6. **Your container** answers on its `targetPort`. The response retraces the path.

Six hops, four owners, and at least five distinct failure modes — which is why "the site is down" is the start of the conversation, never the end. Every article in this section exists to let you name the hop.

## Article map

Read in order the first time; after that, jump to the layer that's on fire.

1. [Network layers and VIPs](/networking/layers-and-vips/) — the foundation: what L2/L3/L4/L7 mean in your stack, and why every durable address in Kubernetes is a VIP.
2. [The Kubernetes networking model](/networking/networking-model/) — the pod-IP contract, CNI plugins, packet walks, MTU gotchas.
3. [Services deep dive](/networking/services-deep-dive/) — ClusterIP internals, EndpointSlices, NodePort, headless Services, `externalTrafficPolicy`.
4. [DNS](/networking/dns/) — CoreDNS, `ndots:5` and its notorious latency tax, search domains, per-pod DNS overrides.
5. [Ingress and routing](/networking/ingress-and-routing/) — Ingress anatomy, TLS, cert-manager, the Gateway API role split, debugging 502/504.
6. [Network policies](/networking/network-policies/) — default-allow vs default-deny semantics, the forgotten DNS egress rule, testing.
7. [External load balancing](/networking/external-load-balancing/) — cloud LBs, MetalLB, F5 CIS, client IP preservation.
8. [Debugging the network](/networking/debugging-network/) — the hop-by-hop playbook with a printable checklist.
9. [Service mesh for app teams](/networking/service-mesh/) — living with a platform-run Istio/Linkerd: sidecars, mTLS, tenant CRs, and Envoy-flag debugging.
10. [gRPC, WebSockets, and long-lived connections](/networking/long-lived-connections/) — why connection-level load balancing breaks for HTTP/2 and hours-long connections, and the fixes.
11. [ingress-nginx in practice](/networking/ingress-nginx/) — the de facto controller: the annotation toolbox, TLS behavior, canaries, and a symptom→fix table.
12. [TCP and non-HTTP ingress](/networking/tcp-ingress/) — getting databases, queues, and other raw TCP/UDP traffic into the cluster when Ingress can't help.
13. [TLS and corporate CAs](/networking/tls-and-corporate-cas/) — serving certs via cert-manager, trusting the corporate CA from Java/.NET containers, and the x509 error zoo.
14. [Gateway API for app teams](/networking/gateway-api/) — the Ingress successor: HTTPRoute anatomy, weighted canaries without annotations, and the status conditions that tell the truth.

When these practical guides aren't deep enough, the [Routing & DNS Deep Dive](/routing/overview/) section traces a request end to end ([Life of a Request](/routing/life-of-a-request/)) and dissects the machinery ([kube-proxy and the dataplane](/routing/kube-proxy-and-the-dataplane/), [CoreDNS](/routing/coredns-deep-dive/), [DNS integration](/routing/dns-integration/)).

:::note
Networking failures often masquerade as application failures — "readiness probe failed" is frequently a NetworkPolicy or DNS problem, not your app. If you landed here mid-incident, [Service unreachable](/troubleshooting/service-unreachable/) in the troubleshooting section is the fastest entry point.
:::

## What this section deliberately skips

Scoping honesty, so you know where the edges are:

- **Service meshes** (Istio, Linkerd). If your cluster runs one, a sidecar or eBPF layer sits inside several of the hops above, with its own mTLS, retries, and routing. The layered model still holds — the mesh is an extra sublayer between Service and pod — but mesh debugging has its own tooling. Ask your platform team whether a mesh is injected into your namespace *before* debugging anything; an unnoticed sidecar has burned many hours.
- **CNI administration** — installing, upgrading, or tuning Calico/Cilium. We cover how they behave from a pod's perspective, not how to run them.
- **Cluster DNS operations** — the CoreDNS Corefile and scaling are platform work; we cover everything observable and configurable from your side in [DNS](/networking/dns/).
- **Multi-cluster networking** — federation, cross-cluster service discovery. Get the single-cluster model down first; the multi-cluster stuff is that model plus organizational pain.

## Before you go deeper

Two prerequisites make this section land better if they're fresh:

- Comfort with `kubectl describe`, `-o yaml`, `-o wide`, and label selectors — the [kubectl survival kit](/start/kubectl-survival-kit/) if you need a refresher.
- A working mental model of readiness probes, because readiness gates Service traffic everywhere in this section — [health checks](/workloads/health-checks/) covers it.

:::tip[One habit to build today]
Keep a `netshoot` one-liner in your team runbook: `kubectl debug -it <pod> --image=nicolaka/netshoot --target=<container>`. Every article in this section uses it, and having it memorized (or pasted at the top of your incident doc) shaves minutes off every network investigation you'll ever run.
:::

Start with [the networking model](/networking/networking-model/). It's the shortest article in the section and everything else stands on it.
