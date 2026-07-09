---
title: Cluster Networking
description: The internal fabric of a Kubernetes cluster — the pod network, the Service/ClusterIP network, and cluster DNS — what each one is, who owns it, and where to read next.
keywords:
  - pod network CIDR
  - service CIDR
  - ClusterIP allocation
  - cluster internal networking
  - kubernetes service IP range
  - cross-AZ traffic cost
  - zone aware routing
  - 5 second DNS timeout
  - NodeLocal DNSCache
  - what is the pod network
  - platform team vs app team
sidebar:
  order: 1
---

The [Networking & Routing](/networking/overview/) section is organized around one journey: how a request gets *from the outside world to your pod*. This section is about the layer underneath all of that — the **internal fabric** the cluster runs on before any ingress controller enters the picture. Every pod-to-pod call, every Service lookup, every `svc.cluster.local` name your app resolves depends on it.

You don't build this fabric — the platform team does. But you live in it, you debug through it, and a surprising number of "the app is slow" and "every Nth request stalls" incidents come from *how it's configured*, not from your code. This section is the map.

## What "cluster networking" means here

Three internal networks make a Kubernetes cluster work. They're distinct systems with distinct owners, and confusing them is the root of most internal-networking confusion:

```text
 [ Cluster DNS ]      names → IPs        (CoreDNS answers *.cluster.local)
       │
 [ Service network ]  stable virtual IPs  (ClusterIPs, from the service CIDR)
       │
 [ Pod network ]      every pod an IP     (the pod CIDR, wired by the CNI)
```

- The **pod network** gives every pod its own routable IP with flat, NAT-free connectivity to every other pod. This is the base contract.
- The **Service network** overlays stable *virtual* IPs (ClusterIPs) on top, so you can address a shifting set of pods by one durable IP and name.
- **Cluster DNS** turns Service and pod names into those IPs.

None of this is the app-facing edge. Ingress, Gateways, external load balancers, TLS termination — those are the *outside-in* concerns covered in [Networking & Routing](/networking/overview/). Cluster networking is the *inside* fabric those layers sit on top of.

:::note[Why split this out?]
The edge layers are things you write manifests for — an Ingress, a `type: LoadBalancer` Service. The internal fabric is mostly *given to you*: the pod CIDR, the service CIDR, and the DNS setup are chosen when the cluster is built. This section is about understanding what you were handed, spotting when its limits are biting you, and knowing which limits are a manifest change versus a platform ticket.
:::

## The three internal networks

| Network | What it is | Who owns it | Read |
|---|---|---|---|
| **Pod network** | A CIDR block; every pod gets one IP, flat routing, no NAT between pods. Wired by the CNI. | Platform team (CNI, IPAM, MTU); **you** own what your container binds to | [The Kubernetes Networking Model](/networking/networking-model/) |
| **Service network** | A separate CIDR; ClusterIPs are carved from it. Virtual — rules only, no interface. | Platform team (service CIDR, kube-proxy); **you** own the Service specs | [Services Deep Dive](/networking/services-deep-dive/) |
| **Cluster DNS** | CoreDNS answering `*.cluster.local` and forwarding the rest. Reached via a Service IP in `/etc/resolv.conf`. | Platform team (CoreDNS, Corefile); **you** own per-pod `dnsPolicy`/`dnsConfig` | [DNS](/networking/dns/) |

The recurring pattern from the rest of this field guide holds here too: **you own the declarative resources in your namespace; the platform team owns the machinery that makes them real.** You write a Service; the service CIDR it draws from and the kube-proxy that programs it are theirs.

## Reading order: the fabric, layer by layer

If you're new to how the internal fabric fits together, read these in order. They already exist elsewhere in the guide — this is the stitched path through them:

1. **Pod network & CNI** — how every pod gets an IP and why pod-to-pod is flat. [The Kubernetes Networking Model](/networking/networking-model/).
2. **Service virtual IPs** — ClusterIP, EndpointSlices, headless Services, and why you can't ping a ClusterIP. [Services Deep Dive](/networking/services-deep-dive/).
3. **The dataplane that makes ClusterIP real** — the iptables/IPVS/eBPF rules kube-proxy programs on every node to turn a virtual IP into a real pod. [kube-proxy and the Dataplane](/routing/kube-proxy-and-the-dataplane/).
4. **Cluster DNS** — the practical view in [DNS](/networking/dns/), and the machinery in [CoreDNS Deep Dive](/routing/coredns-deep-dive/).

Those four give you the mental model. The next three pages are where this section earns its keep.

## The three operational topics in this section

Each of these is a real thing that bites app teams, and each has its own page:

- **[Service CIDR & ClusterIP Allocation](/cluster-networking/service-cidr-and-clusterip-allocation/)** — where ClusterIPs actually come from, how to read the range your cluster was built with, and the failure mode nobody warns you about: what happens when the service CIDR *runs out* of addresses (spoiler: new Services fail to get an IP, and it looks like a bug in your manifest).
- **[Zone-Aware Traffic: Topology & trafficDistribution](/cluster-networking/traffic-distribution/)** — by default a ClusterIP load-balances across *every* Ready pod, including ones in other availability zones. That's latency you didn't ask for and cross-AZ data-transfer charges you *definitely* didn't. How to keep Service traffic in-zone with `trafficDistribution` and topology hints, and when not to.
- **[NodeLocal DNSCache](/cluster-networking/nodelocal-dnscache/)** — the platform add-on that puts a DNS cache on every node and, in doing so, kills the notorious 5-second DNS timeout. Why the stall happens, how to tell if your cluster runs the cache, and what to ask for if it doesn't.

## How to orient in a new cluster

Three commands reveal the shape of the internal fabric without any special access. You don't need to memorize the ranges — you need to know how to *find* them:

```bash
# The service CIDR's FIRST IP — the default kubernetes Service always holds it.
# Commonly 10.96.0.1; whatever it is, the service CIDR starts there.
kubectl get svc kubernetes -n default

# Pod CIDR hints — the IPs your pods actually got, one range per node.
kubectl get pods -o wide

# The DNS service IP your pods resolve against (and the ndots/search config).
cat /etc/resolv.conf   # run inside a pod, e.g. via kubectl exec or a debug container
```

That first one is worth internalizing: the `kubernetes` Service in the `default` namespace is **always assigned the first usable IP of the service CIDR**. See `10.96.0.1` and you know the service range *starts* at `10.96.0.0` — though not how big it is; the mask is platform config (ask, or on 1.31+ run `kubectl get servicecidr`). It's still the cheapest possible way to orient on the service range of a cluster you've never seen.

:::caution[A ClusterIP is not a real interface]
Nothing in the cluster owns a ClusterIP as an address on a NIC. It exists only as packet-rewriting rules on every node. You generally can't ping one, `arp` won't find it, and that's all completely normal — it's the point of [Services Deep Dive](/networking/services-deep-dive/). Keep this straight before you go chasing the service CIDR.
:::

For the full packet-level walk of how a pod gets its IP, don't duplicate it in your head from here — [The Kubernetes Networking Model](/networking/networking-model/) does it properly and is the shortest article that covers it.

## Where to go next

Start with [Service CIDR & ClusterIP Allocation](/cluster-networking/service-cidr-and-clusterip-allocation/) — it's the piece of the internal fabric most app teams have never looked at, and the one most likely to produce a baffling incident. Then the zone-aware and DNS-cache pages, both of which turn "the app feels slow" into a specific, ticketable finding.
