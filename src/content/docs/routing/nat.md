---
title: "SNAT and DNAT: Every Address Rewrite, and How to Avoid Them"
description: A census of every source and destination rewrite in the corporate ingress and egress path — why each exists, what it costs, and the realistic options for eliminating or working around each one.
keywords:
  - lost client source IP
  - externalTrafficPolicy Local
  - PROXY protocol
  - X-Forwarded-For trusted proxy
  - MASQUERADE pod egress node IP
  - conntrack table full dropping packet
  - port exhaustion EADDRNOTAVAIL insert_failed
  - NetworkPolicy ipBlock never matches
  - egress gateway stable IP
  - headless Service internalTrafficPolicy
  - hairpin pod own service
  - DSR direct server return
sidebar:
  order: 4
---

[Life of a Request](/routing/life-of-a-request/) traces one packet and shows each rewrite as it happens. [kube-proxy and the Dataplane](/routing/kube-proxy-and-the-dataplane/) shows the iptables machinery that performs the in-cluster ones. This article is the third leg: NAT as a *subject*. Every address rewrite in the corporate stack, cataloged — where it happens, why it exists, what it costs you, and, for each, whether you can avoid it and what avoidance costs instead.

## Two rewrites, one memory

There are exactly two kinds of NAT, and they are not morally equivalent.

**DNAT rewrites the destination.** A packet aimed at `10.20.30.40:443` leaves the NAT box aimed at `10.244.3.17:8443` instead. DNAT is how virtual addresses work *at all*: a VIP is, by definition, an address nothing listens on, so something must rewrite the destination toward a real backend or the packet dies. Every layer of VIP in [Layers and VIPs](/networking/layers-and-vips/) implies a DNAT (or a full proxy, which is DNAT's more expensive cousin).

**SNAT rewrites the source.** A packet from `10.244.3.17` leaves claiming to be from `10.100.0.5`. SNAT exists for two reasons: to force replies back through the box that did the rewriting (return-path insurance), and to let unroutable private addresses cross a boundary where nobody has a route back to them. **MASQUERADE** is SNAT's dynamic form — "SNAT to whatever IP this outgoing interface has" — see the `SNAT` and `MASQUERADE` targets in [iptables-extensions(8)](https://man7.org/linux/man-pages/man8/iptables-extensions.8.html).

Both are reversed on the return path by **conntrack**, the kernel's per-connection memory: the first packet of a flow records both the original and the rewritten tuples, and every subsequent packet — in either direction — is translated by table lookup, not by re-evaluating rules. That's one paragraph because the full state machine, the `KUBE-SERVICES` chain walk, and the `--ctstate DNAT` reply logic live in [kube-proxy and the Dataplane](/routing/kube-proxy-and-the-dataplane/); the tunables live in the kernel's [nf_conntrack sysctl documentation](https://docs.kernel.org/networking/nf_conntrack-sysctl.html).

The asymmetry that drives this entire article:

> **DNAT is usually necessary. SNAT is usually a compromise.** You cannot have a VIP without a destination rewrite — that's the abstraction. But nearly every SNAT in the stack is return-path insurance bought at a fixed price: the receiver never learns who really sent the packet. When people say "NAT problems," they almost always mean SNAT problems.

## The NAT census

The corporate chain, end to end. Six rewrites, each with the same four questions answered: where, why, cost, avoidable?

```text
laptop ──(a) DNAT──(b) SNAT──▶ appliance ──▶ MetalLB IP on node
        ──(c) DNAT: Service VIP → pod IP  (kube-proxy)
        ──(d) SNAT: cross-node hop        (kube-proxy, policy Cluster)
        ──▶ pod ──(e) SNAT: pod → node IP on egress──▶ outside world
        (f) hairpin SNAT: pod → own Service VIP → itself
```

### (a) Appliance DNAT — VIP to pool member

- **Where:** the F5/NetScaler, rewriting `VIP:443` to a pool member — in our topology, a MetalLB `LoadBalancer` IP (see [MetalLB](/controllers/metallb/) and [The Front Door](/architectures/front-door/)).
- **Why:** inherent. The VIP is the published address; nothing binds it. No rewrite, no service.
- **Cost:** essentially none beyond a connection-table entry on the appliance. This is NAT doing its job.
- **Avoidable?** No — short of publishing backend IPs directly, which defeats the point. Don't spend effort here.

### (b) Appliance SNAT — client IP to appliance self-IP

- **Where:** the same appliance, on the server-side flow: `laptop_ip` becomes a SNAT-pool address like `10.20.30.200`.
- **Why:** return-path insurance. Backend nodes may not route back through the appliance (their default gateway is a router, not the F5). SNAT guarantees the reply lands on the appliance regardless of routing, because the reply is *addressed* to the appliance. Network teams enable it by default because it makes the appliance drop-in anywhere.
- **Cost:** **the cluster never sees the real client IP.** Every log line, allow-list, and rate-limiter downstream sees `10.20.30.200`. This is the single most expensive rewrite in the chain.
- **Avoidable?** Yes, four ways, all with teeth — see [the avoidance menu](#the-avoidance-menu).

### (c) kube-proxy DNAT — Service VIP to pod IP

- **Where:** the `nat` table on the receiving node; `KUBE-SERVICES` → `KUBE-SVC-*` → `KUBE-SEP-*` → `DNAT --to-destination pod:port`.
- **Why:** inherent — this *is* the Service abstraction. A ClusterIP is a VIP; the DNAT plus conntrack's per-flow stickiness is the entire load balancer ([Services Deep Dive](/networking/services-deep-dive/)).
- **Cost:** one conntrack entry per connection, a random-endpoint choice with no feedback loop, and a layer of address indirection in every tcpdump.
- **Avoidable?** Only by not using the VIP: headless Services or `internalTrafficPolicy: Local` (see below). For most east-west traffic, keep it — it's cheap and it's the contract.

### (d) kube-proxy SNAT — the cross-node triangle

- **Where:** node A, when external traffic arrives there but the chosen endpoint lives on node B and the Service has `externalTrafficPolicy: Cluster` (the default).
- **Why:** the return-path triangle. Without it:

```text
        client ── SYN ──▶ node A (LB IP/NodePort)
                              │ DNAT → pod on node B
                              ▼
                           node B ── pod replies…
                              │
        client ◀── src=pod-B ─┘   ✗ client expects src=node A → RST
```

The client sent a SYN to node A and would get a SYN-ACK from an address it never contacted. So node A MASQUERADEs the source to its own IP; the pod on B replies to node A; node A's conntrack un-SNATs and un-DNATs; the client sees a coherent conversation. The reversal itself is traced in [Life of a Request](/routing/life-of-a-request/).

The rule that does it is visible in the census evidence (the full chain walk is the [kube-proxy article's](/routing/kube-proxy-and-the-dataplane/) job):

```console
$ iptables-save -t nat | grep KUBE-MARK-MASQ | head -2
-A KUBE-NODEPORTS -p tcp -m tcp --dport 31443 -j KUBE-MARK-MASQ
-A KUBE-POSTROUTING -m mark --mark 0x4000/0x4000 -j MASQUERADE --random-fully
```

External-facing traffic gets marked for masquerade *before* the endpoint choice, precisely because the endpoint might be remote.

- **Cost:** the pod sees `node A's IP` as the client — real client identity is destroyed *again*, even if the appliance didn't SNAT. Plus an extra node hop and two nodes' worth of conntrack state.
- **Avoidable?** Yes, cleanly: `externalTrafficPolicy: Local`. This is the most avoidable rewrite in the census.

:::note[IPVS and nftables modes don't opt out]
Clusters running kube-proxy in IPVS mode still perform every rewrite in this census — IPVS does the DNAT, and the same masquerade rules cover (d) and (f). The same holds for kube-proxy's **nftables mode**, now GA in recent Kubernetes: identical NAT semantics, but the rules no longer live where `iptables-save` looks — on an nftables-mode node it shows nothing, and `nft list ruleset` is the new window. Before trusting any `iptables-save` evidence in this article, check which mode your cluster runs — it's in the kube-proxy ConfigMap (`kubectl -n kube-system get cm kube-proxy -o yaml | grep mode:`), or ask the platform team. The NAT census is mode-independent; only the mechanism differs.
:::

### (e) Pod-egress masquerade — pod IP to node IP

- **Where:** the node where the pod runs, as the packet leaves the cluster boundary — typically a CNI- or kube-proxy-installed `MASQUERADE` rule matching "destination outside the pod/Service CIDRs."
- **Why:** the outside world has no route to `10.244.0.0/16`. A packet arriving at the corporate database with `src=10.244.3.17` would get a reply routed to nowhere. Masquerading to the node IP makes the reply routable.
- **Cost:** the database, the firewall, and the security team see *node IPs* — which change as pods reschedule, so "allow the app's IP" becomes "allow every node in the cluster."
- **Avoidable?** CNI-dependent. Fabrics that route pod CIDRs natively (Calico with BGP-advertised pod ranges, or cloud CNIs where pod IPs are VPC-native) don't need it — the [no-NAT networking model](/networking/networking-model/) can extend beyond the cluster edge if the network team carries the routes. This rewrite is the whole subject of [Egress](/networking/egress/), which covers the three identities your traffic can leave as and how to make a firewall rule survive a scale-up.

### (f) Hairpin SNAT — a pod calling its own Service

- **Where:** the pod's own node, when a pod connects to a Service VIP and the DNAT selects *that same pod* as the endpoint.
- **Why:** without SNAT the pod would receive a packet from its own IP and reply to itself directly, bypassing the un-DNAT — the connection wedges. So hairpin traffic is masqueraded (kube-proxy's `KUBE-MARK-MASQ` on `src == dst` after DNAT, or kubelet's hairpin mode, depending on plumbing).
- **Cost:** negligible in practice; occasionally the source of a "my pod can't reach its own Service, but every other pod can" mystery when hairpin mode is misconfigured.
- **Avoidable?** Not worth it. Know it exists; move on.

### What does NOT get NATed

- **Pod-to-pod, anywhere in the cluster.** The Kubernetes networking model's founding rule: every pod reaches every pod on its real IP, no NAT ([The Networking Model](/networking/networking-model/)). If you tcpdump a pod-to-pod flow and the addresses don't match on both ends, your CNI is broken, not the model.
- **ClusterIP with `internalTrafficPolicy: Local`** does the DNAT but never the cross-node SNAT — the endpoint is by definition on the same node.
- **Direct pod-IP connections** (headless Services, StatefulSet peer addresses): no VIP, no DNAT, no conntrack NAT entry at all.

## Why you care: the failure catalog

Each rewrite has a signature failure. Learn the signatures and half your network tickets diagnose themselves.

**Client IP loss.** The flagship. Your access logs show `10.20.30.200` for every request on earth; your rate limiter throttles "one client" that is actually the whole company; and this policy never matches a single packet:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-partner       # looks right, matches nothing
spec:
  podSelector:
    matchLabels: {app: orders}
  ingress:
    - from:
        - ipBlock:
            cidr: 203.0.113.0/24   # partner's real CIDR…
      # …but the packet arrives with src=10.20.30.200 (appliance)
      # or src=<node IP> (cross-node SNAT). Never 203.0.113.x.
```

[Network Policies](/networking/network-policies/) evaluate the addresses on the wire *at the pod* — post-NAT. `ipBlock` rules against external CIDRs are only meaningful on paths where no SNAT fires before the pod. The security team asks for source-IP audit logging and you have a meeting instead of a config change.

**Conntrack pressure.** Every NATed flow is a table entry on every box that rewrote it. The table is finite (`nf_conntrack_max` — sizing and defaults in the [kernel sysctl docs](https://docs.kernel.org/networking/nf_conntrack-sysctl.html)); when it fills, new connections are *dropped at SYN* with the infamous `nf_conntrack: table full, dropping packet` in `dmesg`. Watch the ratio on any node doing heavy NAT duty:

```console
$ cat /proc/sys/net/netfilter/nf_conntrack_count /proc/sys/net/netfilter/nf_conntrack_max
247891
262144
```

At 95% you are one traffic spike from silent drops. NAT-heavy nodes — busy ingress nodes, egress choke points — hit this first, which is why "one node in the pool is flaky" is a classic conntrack-exhaustion presentation.

**Port exhaustion under heavy SNAT.** Every flow needs a unique 5-tuple, and there are two distinct ways to run out of source ports — with different observables, routinely confused:

*Locally-originated sockets* — a process on the node itself, or a `hostNetwork` pod, calling out. The kernel allocates the source port at `connect()` time from the local ephemeral range:

```console
$ cat /proc/sys/net/ipv4/ip_local_port_range
32768	60999
```

≈ 28,000 ports — less in practice, because `TIME_WAIT` entries hold ports for tens of seconds after close. A connection-churning workload doing 1,000 short connections/second to one database VIP burns the entire range in under 30 seconds of `TIME_WAIT` lifetime. Exhaustion here is loud: `connect()` fails with `EADDRNOTAVAIL`, right in the application's error log.

*Forwarded, masqueraded traffic* — the common pod-egress case — is a different phenomenon. The pod already chose its own source port; it's conntrack, while applying `MASQUERADE`, that must pick a source port making the node's rewritten tuple unique per `{protocol, dst_ip, dst_port}`. When many pods on one node funnel to the same external `dst_ip:dst_port` through the node's single masquerade IP, that per-destination port pool runs dry *silently*: the NAT allocation fails, the packet is dropped at conntrack insertion, and the application never sees `EADDRNOTAVAIL` — just a SYN with no answer, then a retry. The observable lives on the node:

```console
$ conntrack -S | grep -v 'insert_failed=0'
cpu=3  found=88213 invalid=12 insert=0 insert_failed=1274 drop=1274 early_drop=0 ...
```

A climbing `insert_failed` — only on the busiest node, only toward the hottest destination — is the signature. (The `--random-fully` on the masquerade rule in the census evidence exists precisely to spread port selection and soften these collisions.)

**Timeout stacking.** Every NAT hop has its own idle timer — appliance connection table, node conntrack (`nf_conntrack_tcp_timeout_established`), sometimes an egress firewall. The *shortest* timer in the chain silently kills idle long-lived connections, and each layer's un-NAT memory dies with it, so the eventual application packet is un-translatable garbage. The full pathology and keepalive arithmetic are in [Long-Lived Connections](/networking/long-lived-connections/).

**Protocols that embed addresses.** NAT rewrites headers, not payloads. Anything that writes an IP *into the application data* — classic FTP `PORT` commands, SIP/SDP — advertises a pre-NAT address the peer can't reach. The kernel ships conntrack helpers for the famous cases, but modern clusters mostly don't load them. If you're stuck with such a protocol, route it around the NATs, don't tunnel it through.

**Debugging fog.** Every rewrite is a place where tcpdump on one side and tcpdump on the other show *different packets for the same flow*. Six rewrites means up to six vantage points where "the source IP" is a different answer. This is why [Life of a Request](/routing/life-of-a-request/) insists on capturing at both ends of every hop.

## The avoidance menu

Now the part you actually came for: per rewrite, the realistic options — what you gain, what it costs, who must act.

### Kill (d): `externalTrafficPolicy: Local`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: orders-ingress
spec:
  type: LoadBalancer
  externalTrafficPolicy: Local   # no cross-node SNAT
  selector:
    app: ingress-nginx
  ports:
    - port: 443
      targetPort: 8443
```

- **Gain:** the cross-node MASQUERADE never fires; the pod sees whatever source arrived at the node (the real client, if the appliance also isn't SNATing). Also removes the extra hop.
- **Cost:** only nodes with a *local* endpoint may receive traffic, and two different mechanisms are supposed to enforce that. MetalLB handles its half itself: speakers watch EndpointSlices directly and simply stop announcing the LB IP from nodes with no local endpoint. External balancers (a cloud LB, the F5) can't see EndpointSlices — for them Kubernetes allocates a `healthCheckNodePort` they must be configured to probe, so endpoint-less nodes fail the health check and get steered around. If the upstream health checks aren't wired to it, you black-hole a fraction of traffic. Verify both halves:

```console
$ kubectl -n myteam get svc orders-ingress \
    -o jsonpath='{.spec.externalTrafficPolicy} {.spec.healthCheckNodePort}{"\n"}'
Local 32617
$ curl -s http://<node-with-endpoint>:32617/healthz
{"service":{"namespace":"myteam","name":"orders-ingress"},"localEndpoints":1,...}
```

`localEndpoints: 0` on a node means a correctly configured balancer skips it — and an incorrectly configured one sends traffic into a black hole. Load also spreads per-*node*, not per-pod, so two pods on one node share what one pod elsewhere gets alone. MetalLB in L2 mode announces from one node anyway, and IP sharing across Services has extra restrictions under `Local` ([MetalLB](/controllers/metallb/), [Services Deep Dive](/networking/services-deep-dive/)).
- **Who acts:** you (the Service spec) plus the platform team (health-check wiring). This is the standard choice for ingress controllers — the reference build in [The Front Door](/architectures/front-door/) uses it.

### Smuggle through (b): PROXY protocol

PROXY protocol does **not** remove the appliance SNAT — it accepts the rewrite and prepends a small header to the TCP stream carrying the original source address, before any application bytes:

```text
PROXY TCP4 192.168.14.55 10.20.30.40 52144 443\r\n
GET /api/v1/orders HTTP/1.1
...
```

(That's v1; v2 is a binary equivalent. Either way: first bytes on the wire, once per connection.)

- **Gain:** real client IP over any TCP protocol, TLS-passthrough included, with SNAT's return-path convenience intact.
- **Cost:** *both* ends must agree. The appliance must send it; the receiver (ingress-nginx `use-proxy-protocol: "true"`, or your TCP service) must parse it. Mismatched config has a loud signature: a sender-only mismatch shows binary garbage (`PROXY TCP4 ...`) as the first bytes of your protocol; a receiver-only mismatch times out waiting for a header that never comes. Nothing in between can be PROXY-unaware. Details for TCP paths in [TCP Ingress](/networking/tcp-ingress/) and the appliance side in [External Load Balancing](/networking/external-load-balancing/).
- **Who acts:** network team (appliance) and you/platform (receiver), *in lockstep*.

### Smuggle through (b), HTTP edition: `X-Forwarded-For`

The L7 answer: each proxy appends the source it saw. Only works where something is parsing HTTP, and only trustworthy if configured as a chain: ingress-nginx must be told which upstream addresses are trusted proxies (`proxy-real-ip-cidr`, `use-forwarded-headers`) so it takes the client IP from the header rather than the socket ([ingress-nginx](/networking/ingress-nginx/)).

- **Gain:** zero network-team involvement if the appliance already injects XFF (most do when terminating TLS); works through any number of SNATs.
- **Cost:** HTTP(S) only — TLS passthrough blinds the appliance and it can't inject. And it's spoofable: if the *edge* doesn't strip or overwrite inbound `X-Forwarded-For`, any client can claim any IP. Never rate-limit or authorize on an XFF value your own edge didn't set.

### Remove (b): transparent mode + return-path engineering

The appliance *can* forward with the client source intact — but then replies from the pod are addressed to the real client and will follow the node's default route, bypassing the appliance, which resets the half-open flows it still owns. Making no-SNAT work means engineering the return path: nodes (or the MetalLB IP's next hop) must default-route through the appliance, or policy routing must steer reply traffic back to it.

- **Gain:** the honest fix — real client IP at L3/L4, every protocol, no headers.
- **Cost:** the network team owns a routing topology where the appliance is in-path both directions, forever, including during failovers. Many shops look at that operational surface and rationally choose to keep SNAT + PROXY protocol instead. Raise it as a design conversation, not a ticket — [Working with the Platform Team](/operations/working-with-platform-team/).
- **Who acts:** network team, entirely.

### Remove (b) differently: DSR — the honest section

Direct Server Return, in its common L2 form, has the appliance rewrite only the destination **MAC** — the IP header is untouched — and the backend replies *directly to the client*, bypassing the appliance on the way out. No SNAT, no DNAT, near-zero appliance load on the return half.

The sharp edges are why you rarely see it in Kubernetes paths: every backend must hold the VIP on a loopback interface (with ARP suppressed) so it accepts packets addressed to it — awkward when the "backend" is a rotating set of pods behind kube-proxy, which wants to DNAT the very destination DSR requires intact. Health checks lie (the appliance probes a path replies don't take), asymmetric flows confuse stateful firewalls and conntrack in the middle, and tunnel-based L3 DSR variants add MTU overhead. DSR shines for massive-fanout stateless UDP at the edge; for the corporate F5-to-MetalLB path, it's the answer to a question almost nobody is asking.

### Remove (e): routed pod networks — or aim it with an egress gateway

If the network fabric routes pod CIDRs, egress masquerade can be turned off — in Calico, per-pool:

```console
$ calicoctl patch ippool default-ipv4-ippool -p '{"spec":{"natOutgoing": false}}'
```

with the pod ranges advertised to the datacenter via BGP. Pods then reach on-prem destinations with their own IPs: real source identity in the database's logs, no port-exhaustion funnel through node IPs ([The Networking Model](/networking/networking-model/)).

- **Gain:** true end-to-end source identity for egress; no port-range funnel; `ipBlock` egress policies on the far side that actually mean something.
- **Cost:** the pod CIDR becomes corporate routing table inventory — sized, advertised, firewalled, and never overlapping with anything, forever. And it only helps toward destinations that *have* the routes; internet egress still masquerades somewhere.

But pause before demanding it, because there's a middle option that's often *better than no NAT*: an **egress gateway** — a fixed, known SNAT identity. All egress from a namespace exits via a dedicated gateway pod or node with a stable IP. Sometimes you *want* NAT, just a predictable one: the "give the DB team one IP to allow" pattern. A firewall rule for `10.20.50.9/32` that never changes beats either "allow every node" or "allow the pod CIDR and re-advertise routes when it grows." [Egress](/networking/egress/#the-three-egress-identities) is the full treatment, and [The Allow-List That Kept Half-Working](/blog/the-allowlist-that-kept-half-working/) is what the "allow every node" version looks like when the cluster outgrows the rule.

:::tip[A stable SNAT is a feature]
The census frames SNAT as a compromise, and it is — for *identity*. For *authorization*, an egress gateway inverts the trade: the rewrite is the product. You're not losing the pod's address; you're issuing the workload a fixed network passport that survives rescheduling, autoscaling, and cluster growth.
:::

- **Who acts:** platform team (CNI config, gateway deployment) plus network team (BGP peering or firewall rules). App teams request; they don't implement.

### Skip (c) east-west: `internalTrafficPolicy: Local` and headless Services

For in-cluster callers you can decline the VIP entirely. `internalTrafficPolicy: Local` keeps the DNAT but pins it to same-node endpoints — good for per-node agents (log shippers, node-local caches), and it never triggers SNAT. Headless Services (`clusterIP: None`) go further: DNS returns pod IPs, the client connects directly, and there is no NAT of any kind — at the price of client-side balancing: the client re-resolves, spreads load, and handles endpoint churn itself, which most HTTP client libraries do lazily or badly. Right for stateful peer protocols and gRPC clients with real load-balancing support; wrong as a default ([Services Deep Dive](/networking/services-deep-dive/)).

## The decision table

| I need the real client IP for… | Reach for | Notes |
|---|---|---|
| HTTP(S) behind ingress | `X-Forwarded-For` + trusted-proxy config | Cheapest; edge must own the header |
| Raw TCP through the appliance | PROXY protocol, or transparent mode + `Local` | Both-ends config vs. network-team routing project |
| East-west, pod to pod | Nothing — you already have it | No NAT pod-to-pod is the contract |
| Egress allow-listing at a firewall | Egress gateway's stable IP | A *known* SNAT beats no NAT here |

And the honest default, worth writing into your service's README: **inside the cluster, trust L7 headers and stop fighting; at the edge, decide once per protocol — XFF for HTTP, PROXY protocol for TCP — and document which one this path uses.** The expensive failure mode isn't SNAT; it's three teams each assuming a different layer preserved the client IP.

## Verification kit: watching NAT happen

### Two vantage points, one flow

The definitive NAT test is the same connection captured on both sides of the suspected rewrite. Client side:

```console
$ tcpdump -ni any 'tcp port 443 and host 10.20.30.40' -c 2
14:02:11.301 IP 192.168.14.55.52144 > 10.20.30.40.443: Flags [S], seq 3820...
```

Inside the pod (via `kubectl debug` or a sidecar):

```console
$ tcpdump -ni eth0 'tcp port 8443' -c 2
14:02:11.304 IP 10.20.30.200.31044 > 10.244.3.17.8443: Flags [S], seq 3820...
```

Same SYN (matching sequence number), all four address fields different: destination rewritten twice — (a) then (c) — and source once — (b). Each field that changed is one census entry confirmed. `ss -tnp` inside the pod shows the same post-NAT peer, which is why your app's logs can never do better without a header.

### Reading a conntrack entry

On node A — the node doing rewrites (c) and (d), whose own IP here is `10.20.40.11` (requires node access — usually a platform-team ask):

```console
$ conntrack -L -d 10.96.44.10 -p tcp
tcp  6 86392 ESTABLISHED src=10.20.30.200 dst=10.96.44.10 sport=31044 dport=443 \
                         src=10.244.3.17  dst=10.20.40.11 sport=8443 dport=42117 [ASSURED] use=1
```

Anatomy: the **first tuple** is the original packet as it arrived (client-as-seen → Service VIP). The **second tuple** is the *expected reply* — and both NAT verdicts are written into it. The reply's *source*, `10.244.3.17:8443`, is the **DNAT** element: it reveals the real endpoint the VIP was rewritten to. The reply's *destination*, `10.20.40.11:42117`, is the **SNAT** element: node A's own IP plus a masquerade-allocated port (the `--random-fully` in the census evidence is why it isn't `31044`), because rewrite (d) masqueraded the source before forwarding to the remote pod — exactly the triangle in the census diagram. The pod answers *the node*, not the client; node A's conntrack matches this entry, un-SNATs and un-DNATs, and only then does `10.20.30.200` see a packet from `10.96.44.10:443`. If the second tuple's `dst` were still `10.20.30.200`, no SNAT fired — the path was `externalTrafficPolicy: Local`, or in-cluster traffic that never got marked. `86392` is the remaining `nf_conntrack_tcp_timeout_established` seconds; `[ASSURED]` means the entry survives table pressure — both defined in the [conntrack sysctl docs](https://docs.kernel.org/networking/nf_conntrack-sysctl.html). The rules that created this entry are readable via `iptables-save -t nat` — syntax in [iptables(8)](https://man7.org/linux/man-pages/man8/iptables.8.html).

### "Which SNAT hit me?"

When a pod (or an external destination) logs an unexpected source IP, the address itself names the guilty layer:

```text
observed source is…
├── the appliance SNAT-pool IP (10.20.30.200)  → rewrite (b): appliance
│      fix lane: PROXY protocol / XFF / transparent mode  → network team
├── a NODE IP of the cluster                   → rewrite (d) or (e): kube-proxy/CNI
│      inbound? → externalTrafficPolicy: Local          → you + platform
│      outbound? → natOutgoing / egress gateway         → platform team
├── the egress-gateway IP                      → working as designed; update the allow-list
└── a pod IP                                   → no SNAT fired; the model is working
```

That tree is also the escalation map: header and Service-spec fixes are yours; conntrack limits, CNI masquerade rules, and egress gateways belong to the platform team; appliance SNAT and return-path routing belong to the network team. Bring the two-vantage capture and the conntrack line to the handoff — [Working with the Platform Team](/operations/working-with-platform-team/) covers how to package it, and [Service Unreachable](/troubleshooting/service-unreachable/) covers the adjacent case where NAT isn't the problem at all.

:::tip[The one-sentence version]
DNAT is the price of admission for VIPs — pay it without complaint. Every SNAT is a question: *do we need the real source here?* Answer it once per path, per protocol, write the answer down, and the whole subject stops being mysterious.
:::
