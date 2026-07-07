---
title: Routing & DNS Deep Dive
description: End-to-end packet traces and the machinery underneath — how a request actually moves from a corporate laptop through DNS, the edge, the node dataplane, and into a pod.
keywords:
  - packet trace end to end
  - request times out debugging
  - conntrack ARP stale NAT tuple
  - corporate laptop to pod
  - kube-proxy node dataplane
  - CoreDNS resolution
  - MetalLB VIP edge
  - platform team ticket evidence
  - trace first then zoom methodology
  - sporadic 504 errors
  - source IP address rewrites
  - which article for which question
sidebar:
  order: 1
---

The [Networking & Routing](/networking/networking-model/) section answers *per-topic* questions: how Services work, how Ingress routes, how DNS resolves, how to debug when one of them misbehaves. Each article stands alone, and if you haven't read that section, start there — this one assumes it.

This section answers a different question: **what actually happens, in order, to one packet.**

When a request from a corporate laptop times out, "the Service is probably fine" and "DNS is probably fine" and "the Ingress is probably fine" can all be true simultaneously while the request still fails — because the failure lives *between* the topics, in a conntrack entry, an ARP announcement, or a stale NAT tuple that no per-topic guide has a home for. Deep-dive articles exist to give those mechanisms a home, and to teach you the trace discipline that finds them.

## How this section relates to Networking & Routing

| | Networking & Routing | Routing & DNS Deep Dive |
|---|---|---|
| Unit of explanation | One topic (Services, DNS, Ingress...) | One request, end to end |
| Altitude | The API objects and their behavior | The kernel/userspace machinery executing them |
| Typical question | "How do I expose TCP?" | "Which component rewrote this packet, and where's the evidence?" |
| When to read | Building and configuring | Debugging the unexplainable, or building a real mental model |

Nothing here re-teaches the practical guides. When a trace passes through territory that [Services Deep Dive](/networking/services-deep-dive/) or [ingress-nginx](/networking/ingress-nginx/) already covers, we link it and go *beneath* it — to the iptables chain, the conntrack tuple, the veth pair.

A concrete example of the altitude difference. The practical guide tells you:

> A ClusterIP is a virtual IP; kube-proxy programs DNAT rules so connections to it reach a backend pod.

This section tells you:

> The first SYN to the ClusterIP matches a `KUBE-SVC-*` chain in the nat table at the OUTPUT hook, falls through a cascade of `statistic --mode random` rules to one `KUBE-SEP-*` chain, which DNATs it; the kernel stores both tuples in a conntrack entry, and every later packet — and the reply — is translated by that entry without touching the rules again.

The first version is enough to *use* Services. The second is what you need the day one connection in fifty starts timing out and nobody can say why.

## What you'll be able to do after this section

- Recite, from memory, every hop between a corporate browser and your container — and name the component at each one.
- Say precisely which address rewrites happen where, and therefore why your app sees the source IPs it sees.
- Turn a vague symptom ("sometimes slow", "resets during deploys", "works from pod A but not pod B") into a specific dataplane hypothesis with a named counter or table to check.
- Write platform tickets that name the node, the mechanism, and the exact command whose output will confirm or kill your theory.

## The layered map

Every request into this platform's clusters crosses four layers, in this order, and back out in reverse:

```text
┌────────────────────────────────────────────────────────────────┐
│ 1. NAME RESOLUTION   laptop stub resolver → corporate DNS      │
│                      → CNAME chain → appliance VIP             │
│                      (in-cluster: /etc/resolv.conf → CoreDNS)  │
├────────────────────────────────────────────────────────────────┤
│ 2. EDGE              F5/NetScaler VIP → MetalLB-announced IP   │
│                      appliance conn table, SNAT, health state  │
├────────────────────────────────────────────────────────────────┤
│ 3. NODE DATAPLANE    netfilter hooks, kube-proxy rules,        │
│                      DNAT/SNAT, conntrack — the invisible NAT  │
├────────────────────────────────────────────────────────────────┤
│ 4. POD               veth pair → pod netns → ingress-nginx     │
│                      → CNI hop → your app's accept() queue     │
└────────────────────────────────────────────────────────────────┘
```

Layer 1 decides *where* the packet goes. Layers 2–3 rewrite *who it appears to be from and to* — twice each direction. Layer 4 is the only part your application ever sees. Most confusing production incidents are a mismatch between what the app sees (layer 4) and what actually happened (layers 1–3).

Two properties of this stack drive everything in the section:

- **Each layer keeps its own state about your connection** — DNS caches, the appliance connection table, node conntrack, proxy keepalive pools — and each state store has its own lifetime and its own failure mode when it goes stale.
- **The return path must reverse every rewrite through the same state that created it.** A response that takes a different path back than the request took in doesn't arrive "slightly wrong" — it doesn't arrive at all.

The full corporate topology — external VIP → in-cluster [MetalLB](/controllers/metallb/) IP → Service → pods — is diagrammed in [The Front Door](/architectures/front-door/); this section traces packets through it rather than re-describing it.

## Which article for which question

**[Life of a Request](/routing/life-of-a-request/)** — the flagship. One HTTPS request from a corporate laptop to a pod and *back*, hop by hop, with the component and the evidence command named at every step. Read it once end to end; return to it as a map when debugging. It answers:

- "Where could this request possibly be dying?"
- "Why does my app see the node's IP instead of the client's?"
- "The response never arrived but the request did — how?"

**[kube-proxy and the Dataplane](/routing/kube-proxy-and-the-dataplane/)** — the machinery that makes a ClusterIP real: the iptables chain walk, IPVS tables, eBPF replacements, and conntrack as the hidden state machine. It answers:

- "What physically happens when a packet is addressed to a ClusterIP?"
- "Why do 1-in-N connections fail intermittently?" (conntrack exhaustion has a signature)
- "Why did all my connections reset when a Deployment rolled?"

**[SNAT and DNAT](/routing/nat/)** — every address rewrite between the client and the pod: why each NAT exists, what it costs, and the menu of ways to avoid each one. It answers:

- "Which hop ate my client IPs — and how do I get them back?"
- "Why does my NetworkPolicy `ipBlock` never match?"
- "When is SNAT actually the right choice?" (egress gateways: sometimes you *want* one stable NAT)

**[Floating VIPs](/routing/floating-vips/)** — the mechanism under every HA virtual IP: VRRP advertisements, the virtual MAC, gratuitous ARP on failover, and how keepalived, kube-vip, and MetalLB are all the same pattern. It answers:

- "Why is the VIP dark for four minutes after node maintenance, then fine?"
- "How can two nodes both be answering for one VIP?" (split-brain)
- "Do my connections survive a failover?" (usually no — design for the reconnect)

**[CoreDNS Deep Dive](/routing/coredns-deep-dive/)** and **[DNS Integration](/routing/dns-integration/)** — the resolution layer from the inside: the plugin chain, the cluster-zone/corporate-zone split, and how a name in corporate DNS ends up pointing at a pod. ([DNS Inside the Cluster](/networking/dns/) remains the practical guide to `resolv.conf`, `ndots`, and pod-side knobs.)

## The methodology: trace first, then zoom

Every article here follows — and teaches — the same discipline:

1. **Trace first.** Lay out every hop the request takes, in order, before theorizing. A numbered hop list turns "networking is broken" into "the failure is at or after hop 4, because hop 3 has evidence."
2. **Bisect with evidence, not vibes.** At each hop there is exactly one command whose output proves the packet arrived (or didn't). Run it. `conntrack -L` doesn't have opinions.
3. **Then zoom.** Only once the failing hop is isolated do you open the deep-dive material for that hop's mechanism. Reading about IPVS scheduling while the actual problem is a CNAME pointing at a decommissioned VIP is how afternoons disappear.

This inverts how most people debug (start from the component they know best, expand outward). Trace-first is faster precisely because it doesn't require knowing which component is guilty in advance.

In practice a trace session looks like this:

```text
symptom:   external clients get sporadic 504s on /api/v1/orders

hop 1  DNS            → dig: correct VIP, TTL 30            [PASS]
hop 2  appliance      → s_client handshake: OK              [PASS]
hop 5  nginx accepted → access log: request logged, 504,
                        upstream_addr=10.244.7.42:8080,
                        upstream_response_time=timeout      [FAIL localized]
hop 7  CNI to pod     → curl pod IP from debug pod: 200 in 40ms
                        ...but only from pods on some nodes  [narrowed]
```

Four commands, and "sporadic 504s" has become "cross-node reachability to 10.244.7.42 fails from a subset of nodes" — a sentence a platform engineer can act on immediately. Note the hops we *skipped* (3, 4): once nginx logs the request, the packet provably made it through the edge and the dataplane; the trace lets you skip hops the evidence already vouches for.

:::tip[You won't have access to every hop]
On a platform-managed cluster you can't SSH to nodes or read the F5's connection table. That doesn't invalidate the trace — it tells you *which hops to verify yourself* (pod-side, DNS, Service endpoints) and *which evidence to request from the platform team, by name*. "Please check conntrack on node X for dport 443 insert_failed drops" gets a same-day answer; "networking seems broken" gets a ticket queue. Access boundaries per hop are covered in [Debugging Network Issues](/networking/debugging-network/).
:::

## Section conventions

- **Every trace step names the exact component doing the work** — not "Kubernetes routes the packet" but "the `KUBE-SEP-*` iptables rule, programmed by kube-proxy, executing in the kernel's netfilter PREROUTING hook, DNATs the destination." If we can't name the component, we say so; that's usually where the interesting bugs are.
- **Kernel vs. userspace is always explicit.** Half of the "aha" moments in this section are realizing which parts of Kubernetes networking involve *no Kubernetes process at all* at packet time.
- **Every claim carries an evidence command**, shown with realistic output, and marked when it requires node access you won't have (so you know what to ask the platform team for).
- **Authoritative sources over folklore.** Where a kernel behavior matters, we cite [docs.kernel.org](https://docs.kernel.org/) or [man7.org](https://man7.org/) rather than paraphrase blog posts.
- Cross-links go *down* to mechanisms in this section and *out* to the practical guides in Networking & Routing — never duplicated content in both.

## Reading order

Read [Life of a Request](/routing/life-of-a-request/) first, in one sitting — everything else in the section is a zoom-in on one of its hops. Then read [kube-proxy and the Dataplane](/routing/kube-proxy-and-the-dataplane/) before your next intermittent-connection-failure incident rather than during it. The DNS articles can wait until a resolution question drags you in — but they will.

And keep the practical guides open in the other tab. This section tells you a `KUBE-SEP-*` rule DNAT'd your packet; [Services Deep Dive](/networking/services-deep-dive/) tells you which Service field to change about it. Mechanism and remedy live in different sections on purpose — the trace finds the hop, the guide fixes it.
