---
title: "Network Layers and VIPs"
description: The four network layers that matter in Kubernetes, what operates at each one in your stack, and why every stable address you use is a virtual IP.
sidebar:
  order: 2
---

This site says "MetalLB L2 mode", "L4 passthrough on the appliance", and "L7 routing at the ingress" on nearly every page. This is the page where those phrases stop being jargon. Read it once and every other networking article gets easier.

You don't need the OSI model. You need four layers, because:

- **Every failure lives at exactly one layer.** A `502` and a `connection refused` are different layers, different components, different owners.
- **Every Kubernetes component operates at specific layers.** kube-proxy is L4. ingress-nginx is L7. MetalLB in L2 mode is, well, L2. Knowing the layer tells you what a component *can* and *cannot* do.
- **"Which layer?" is the first triage question.** Answer it and you've cut the suspect list by three quarters before running a single command.

## The four layers

Skip L1 (cables — someone else's problem) and L5/L6 (real in textbooks, useless in triage). For each layer that matters, the same four questions: what's addressed, who operates there in *your* stack, what it can and can't see, and what its failures smell like.

### Layer 2 — frames, MAC addresses, ARP

**What's addressed:** MAC addresses. L2 delivers *frames* between interfaces on the same subnet/broadcast domain. No routing — either the destination MAC is reachable on this segment or the frame goes nowhere.

The glue is ARP: "who has IP 10.40.8.15?" shouted to everyone, answered with a MAC. Every host keeps a cache of answers:

```bash
ip neigh show
```

```text
10.40.8.1 dev eth0 lladdr 00:1c:73:aa:0e:41 REACHABLE
10.40.8.15 dev eth0 lladdr 52:54:00:9d:2f:b1 STALE
10.40.8.200 dev eth0 FAILED
```

`REACHABLE` is a fresh answer, `STALE` is a cached one pending re-verification, and `FAILED` means nobody answered — that IP is unreachable at L2 no matter what the upper layers want. (The full state machine is in [arp(7)](https://man7.org/linux/man-pages/man7/arp.7.html).)

**Who operates here in your stack:** node NICs, the veth pairs that connect each pod to its node, and — critically — **MetalLB in L2 mode**. In L2 mode, one node answers ARP for the LoadBalancer VIP. On failover, the new node sends a *gratuitous ARP* — an unsolicited "I have this IP now" — to update every cache on the segment. That single broadcast *is* the failover mechanism. See [MetalLB](/controllers/metallb/).

**What L2 cannot see:** anything beyond the local subnet. It doesn't know what an IP route is, let alone a TCP port or an HTTP request.

**Failure smell:** everything works pod-to-pod, but the MetalLB VIP goes dark after a node drain or failover — and recovers "by itself" a few minutes later. That's a stale ARP cache upstream (often on the appliance or router) still pointing the VIP at the old node's MAC. Check it from a client on the same segment:

```bash
# Which MAC does this client think owns the VIP?
ip neigh show 10.40.8.200
```

```text
10.40.8.200 dev eth0 lladdr 52:54:00:9d:2f:b1 REACHABLE
```

If `52:54:00:9d:2f:b1` is the NIC of the node you just drained, you've found the incident. Flush it (`ip neigh flush to 10.40.8.200` — or wait out the cache timer) and the VIP comes back. When the stale cache lives on the corporate appliance, "flush it" becomes a ticket to the network team, which is exactly the kind of escalation this page is trying to make precise.

### Layer 3 — packets, IP addresses, routing

**What's addressed:** IP addresses. L3 moves *packets* between subnets via routers consulting routing tables — each hop asks "which interface gets this packet closer?"

```bash
ip route get 10.244.3.17
```

```text
10.244.3.17 via 10.40.8.13 dev eth0 src 10.40.8.11 uid 1000
    cache
```

That's a node saying: to reach that pod IP, forward via node `10.40.8.13`. Routed CNIs are literally this — routing table entries for pod CIDRs.

**Who operates here in your stack:** routers, the CNI plugin, and the pod network itself. The [Kubernetes networking model](/networking/networking-model/) is an L3 contract: every pod gets a real, routable IP, and any pod can reach any pod without NAT. Also here: **MetalLB in BGP mode**, which announces the VIP as a *route* to upstream routers instead of answering ARP — L3, not L2, which is why BGP-mode failover doesn't depend on anyone's ARP cache.

**What L3 cannot see:** ports, connections, or protocols. A router forwards a packet toward `10.40.8.200` with no idea whether it's TCP 443 or a ping.

**Failure smells:** `no route to host`, asymmetric paths, and the sneakiest one — MTU blackholes, where small packets (health checks, SYN handshakes) pass but full-size packets vanish. "Connects fine, hangs on the first real response" is an MTU smell, covered in [the networking model](/networking/networking-model/).

### Layer 4 — connections, TCP/UDP, ports

**What's addressed:** the 5-tuple: `(protocol, source IP, source port, destination IP, destination port)`. That tuple identifies a *connection*, and L4 is where connections exist. `10.40.8.200:443/TCP` is an L4 address. You can see the tuples directly:

```bash
ss -tn state established '( dport = :443 )'
```

```text
Recv-Q Send-Q  Local Address:Port    Peer Address:Port
0      0       10.244.3.17:53622     10.96.14.7:443
0      0       10.244.3.17:53640     10.96.14.7:443
```

Two connections to the same destination — distinguished only by source port. Everything L4 does (balancing, NAT, conntrack) is bookkeeping on these tuples.

**Who operates here in your stack:** most of Kubernetes, honestly.

- **kube-proxy and Services.** A ClusterIP is an L4 construct: iptables/IPVS rules DNAT *connections* aimed at `VIP:port` to a chosen `pod:port`. The choice is made once, at connection setup, and conntrack pins the rest of the connection to that pod. See [Services deep dive](/networking/services-deep-dive/) and [kube-proxy and the dataplane](/routing/kube-proxy-and-the-dataplane/).
- **The corporate appliance in TCP/passthrough mode.** "L4 passthrough" means the F5/NetScaler forwards the TCP stream without opening it — it balances connections, not requests, and never sees TLS plaintext.
- **NodePorts**, and everything in [TCP ingress](/networking/tcp-ingress/) — databases, message brokers, anything that isn't HTTP.

**What L4 cannot see — and this one sentence explains a lot of incidents:** L4 cannot see the requests *inside* a connection. It balances at connection setup, then it's blind. One gRPC channel carrying 50,000 requests per second is, to kube-proxy, exactly one unit of load — which is why HTTP/2 and gRPC traffic piles onto one pod behind a ClusterIP. That whole failure class lives in [long-lived connections](/networking/long-lived-connections/).

**Failure smells:** `connection refused` (something answered — with a rejection: nothing listening on that port), `connection reset` (mid-stream kill: crash, idle-timeout firewall, conntrack eviction), and `connection timed out` (SYN into the void — could be any lower layer, or a silent drop). Note what's *absent*: HTTP status codes. If you got a status code, you're past L4.

### Layer 7 — requests, HTTP and gRPC

**What's addressed:** requests. L7 components speak the application protocol, so they can route on `Host` headers, URL paths, gRPC methods, cookies — things no lower layer knows exist.

**Who operates here in your stack:** [ingress-nginx](/networking/ingress-nginx/) (the workhorse — one nginx routing many hostnames to many Services), Gateway API `HTTPRoute`s, [service mesh](/networking/service-mesh/) sidecars, and the corporate appliance when configured in L7/vhost mode instead of passthrough.

**What only L7 can do:** balance *per request* across pods even inside one long-lived connection (the mesh's fix for the gRPC problem above), retry a failed request against a different pod, set and read cookies for session affinity, inject headers (`X-Request-ID`, `X-Forwarded-For`), and decide where TLS terminates.

**Failure smells:** status codes — `404`, `502`, `503`, `504`. And here's the triage gift: **a status code proves you reached something alive at L7.** Look at what a `502` actually tells you:

```bash
curl -sv https://app.corp.example/api/health 2>&1 | tail -6
```

```text
< HTTP/2 502
< date: Fri, 03 Jul 2026 14:12:09 GMT
< content-type: text/html
<
<html><head><title>502 Bad Gateway</title></head>
<body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>
```

That `nginx` server banner is a signed confession: DNS resolved, the appliance forwarded, MetalLB delivered, the Service DNAT'd, and nginx answered — then *nginx* failed to get a good response from your backend. Layers 2–4 between you and nginx are exonerated in one command; the problem is behind the ingress. Rough decoder ring: `404` = the L7 router has no rule for this host/path; `502` = the backend answered garbage or refused; `503` = no ready backends (empty endpoints is the classic); `504` = the backend took too long. That fork in the road is the backbone of [troubleshooting an unreachable Service](/troubleshooting/service-unreachable/).

### The layers on one card

| Layer | Unit | Address | In your stack | Failure smell |
| --- | --- | --- | --- | --- |
| L2 | frame | MAC | NICs, veth pairs, MetalLB L2 mode | VIP dark after failover; stale ARP |
| L3 | packet | IP | pod network/CNI, MetalLB BGP mode | `no route to host`, MTU blackholes |
| L4 | connection | IP:port + protocol | kube-proxy/Services, appliance passthrough, NodePorts | refused / reset / timeout |
| L7 | request | host, path, headers | ingress-nginx, Gateway API, mesh sidecars, appliance vhost mode | `404` / `502` / `503` / `504` |

:::note[Where the clean picture blurs]
"L3 vs L4" isn't razor-sharp: kube-proxy's DNAT rewrites the destination IP (an L3 field) *and* tracks connections (an L4 concept) — which is why you'll see "L3/L4" used for Services and shouldn't lose sleep over it. L5 and L6 aren't worth an app team's time. TLS gets one sentence: it wraps L7 traffic, and it's terminated wherever you decide — appliance, ingress, or pod — a decision with real routing consequences covered in [ingress and routing](/networking/ingress-and-routing/).
:::

## The layer-triage table

First question in any networking incident: which layer is the symptom speaking?

| Symptom | Layer | First command | Go deeper |
| --- | --- | --- | --- |
| `connection refused` / `reset` | L4 | `kubectl get endpointslices <svc>` — anything backing the Service? | [Services deep dive](/networking/services-deep-dive/) |
| `connection timed out` | L4 symptom, often L2/L3 cause | `curl -v --connect-timeout 5` from another vantage point | [Service unreachable](/troubleshooting/service-unreachable/) |
| `no route to host` | L3 | `ip route get <dest-ip>` | [Networking model](/networking/networking-model/) |
| VIP dead after node maintenance/failover | L2 | `ip neigh show` upstream — is the MAC the old node's? | [MetalLB](/controllers/metallb/) |
| `502` / `503` / `504` | L7 (you reached the proxy — look *behind* it) | `kubectl logs -n ingress-nginx <pod>` | [ingress-nginx](/networking/ingress-nginx/) |
| Works by IP, fails by name | Not a layer — DNS | `kubectl exec <pod> -- nslookup <name>` | [DNS](/networking/dns/) |
| Connects, first big payload hangs | L3 (MTU) | `ping -M do -s 1472 <dest>` | [Networking model](/networking/networking-model/) |
| One pod gets all the traffic | L4 blindness | `kubectl top pods` — one hot replica? | [Long-lived connections](/networking/long-lived-connections/) |

## What is a VIP?

Now the second word this site uses constantly. A **Virtual IP** is an IP address that is a *promise*, not a network interface.

A "real" IP is bound to one NIC on one machine; when that machine dies, the address dies with it. A VIP belongs to a *role* — "the front door for this app", "this Service" — and whoever currently holds the role answers for the address. The address is permanent; the answerer is fungible. That's the entire trick, and Kubernetes networking is this trick applied recursively: VIPs stacked on VIPs, each answered by a different mechanism at a different layer.

You can watch a VIP fail to exist. Take any Service:

```bash
kubectl get svc orders -o wide
```

```text
NAME     TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)   AGE
orders   ClusterIP   10.96.14.7   <none>        443/TCP   211d
```

Now go looking for `10.96.14.7` on an actual interface — any node, any pod:

```bash
ip -br addr | grep 10.96.14.7   # nothing, on every node in the cluster
```

The address is assigned to nobody. It works anyway because every node carries iptables/IPVS rules that recognize `10.96.14.7:443/TCP` and rewrite it in flight. Connections to the VIP succeed; the VIP itself is never a destination anything actually listens on.

### The VIP zoo

| VIP | How it's virtual | Who actually answers | Failover semantics |
| --- | --- | --- | --- |
| **ClusterIP** | The purest VIP: exists *only* as dataplane rules on every node. No interface anywhere has this address — which is why you can't ping most ClusterIPs. | kube-proxy's iptables/IPVS rules DNAT each new connection to a ready pod. | Instant for new connections (endpoint list updates); established connections to a dead pod must break and redial. See [Services deep dive](/networking/services-deep-dive/). |
| **MetalLB LoadBalancer IP** | An address from a pool, announced by whichever node currently owns it. | L2 mode: one elected node answers ARP. BGP mode: nodes announce a route. Traffic then hits that node's Service rules. | Re-announcement: gratuitous ARP (seconds, plus upstream cache staleness) or BGP route withdrawal (typically faster, no ARP caveat). See [MetalLB](/controllers/metallb/). |
| **Corporate appliance VIP** | A floating address on an HA pair of F5/NetScaler appliances, VRRP-style. This is the address in corporate DNS and firewall rules. | The active appliance; it health-checks and forwards to the MetalLB IP behind it. | Sub-second float to the standby appliance; connections may or may not survive depending on state mirroring. See [external load balancing](/networking/external-load-balancing/). |
| **Honorable mentions** | The keepalived/VRRP pattern generally — two boxes, one floating IP, heartbeats — predates Kubernetes and underlies half of the above. | Whichever peer holds VRRP mastership. | Heartbeat-timeout driven, usually 1–3 s. kube-vip applies the same pattern to give the control plane itself a VIP — one sentence, and that's all an app team needs. |

:::tip[ClusterIP, the litmus test]
The fact that `ping <clusterip>` usually fails while `curl <clusterip>:80` works is the best one-command demonstration of VIP-ness: the address only "exists" for the specific protocol/port tuples the dataplane rules were written for. If pinging a ClusterIP fails, nothing is wrong.
:::

## Why VIPs matter

### Stable identity over ephemeral backends

Pods die constantly — deploys, evictions, node drains, OOM kills. So no durable name in the system is ever allowed to point at a pod. Every durable name points at a VIP: [DNS](/networking/dns/) resolves `orders.payments.svc` to a ClusterIP, and the dataplane maps that VIP to whatever pods are ready *right now*. Name → VIP → current backends, at every level of the stack. [Life of a request](/routing/life-of-a-request/) walks the full chain end to end.

### Failover without reconfiguration

When a backend dies, nothing that *refers* to it changes — no DNS update, no client config push, no firewall change. The address stays; the answerer changes. But each VIP type fails over at a different speed, and the differences are exactly the mechanisms above:

- **ClusterIP:** new connections re-steer as fast as the endpoint list updates — but conntrack keeps established flows pinned to the corpse until they error out.
- **MetalLB L2:** gratuitous ARP is fast, but any upstream device that ignores it serves stale MAC entries until its cache expires — the classic "VIP dead for four minutes after maintenance" incident.
- **Appliance HA pair:** typically the fastest and cleanest, because that's the one thing the box is for.

### Indirection is a policy point

Every VIP is a place where someone can stand between client and backend — which means it's where load balancing algorithms, TLS termination, health checks, allow-lists, rate limits, and monitoring get inserted. The corporate appliance VIP is the anchor for corporate DNS and firewall rules precisely because it's the one address that never changes; that's the whole [front door architecture](/architectures/front-door/), and the F5 CIS controller exists to program those appliance objects from Kubernetes resources — see [external load balancing](/networking/external-load-balancing/).

### The cost of indirection

Every VIP layer is also a place where:

- **Client IPs get rewritten.** SNAT at the appliance, SNAT at the node for `externalTrafficPolicy: Cluster` — by the time your pod logs a "client IP", it's often a node or appliance address. If your access logs show the same three IPs for every user on earth, count your VIPs.
- **Timeouts stack.** Appliance idle timeout (often 300 s), nginx `proxy_read_timeout` (60 s default), conntrack timeouts, your app's own client timeout — the *shortest* one in the chain wins, and it's rarely the one you configured. Mysterious disconnects at suspiciously round intervals are a hop's idle timer, not your code — the case files are in [long-lived connections](/networking/long-lived-connections/).
- **Health checks can lie.** Each hop health-checks only the *next* hop. The appliance can be green on the MetalLB IP while every pod behind the Service is on fire. "Monitoring says up, users say down" usually means you're monitoring the wrong end of the VIP chain.

The debugging corollary, worth internalizing as a reflex: **before debugging anything, enumerate the VIPs between client and pod.** In this site's corporate topology there are three — appliance VIP, MetalLB IP, ClusterIP — and each is a distinct place the request can die, get SNAT'd, or time out. Two of the three are visible from `kubectl` alone:

```bash
kubectl get svc -n ingress-nginx ingress-nginx-controller
```

```text
NAME                       TYPE           CLUSTER-IP    EXTERNAL-IP   PORT(S)
ingress-nginx-controller   LoadBalancer   10.96.201.4   10.40.8.200   80:31380/TCP,443:31443/TCP
```

`CLUSTER-IP` is VIP #3, `EXTERNAL-IP` is the MetalLB VIP #2. The appliance VIP #1 is what corporate DNS returns for your hostname (`dig app.corp.example`), and it lives outside the cluster entirely — programmed by the network team or by F5 CIS. Probing each VIP in turn, from a vantage point that can reach it, converts "it's down" into "it dies between VIP #1 and VIP #2", which is a solvable problem.

## The whole picture

The corporate request path, with the layer at every hop and every VIP labeled:

```text
 client
   │  DNS: app.corp.example → 203.0.113.40
   ▼
 ┌─────────────────────────────┐
 │ F5/NetScaler HA pair        │  VIP #1: 203.0.113.40 (VRRP float)
 │ L4 passthrough or L7 vhost  │  ← layer depends on appliance config
 └─────────────┬───────────────┘
               ▼
 ┌─────────────────────────────┐
 │ MetalLB LoadBalancer IP     │  VIP #2: 10.40.8.200
 │ L2 (ARP) or L3 (BGP)        │  ← one node answers for it
 └─────────────┬───────────────┘
               ▼
 ┌─────────────────────────────┐
 │ Service (ClusterIP)         │  VIP #3: 10.96.14.7
 │ L4 — kube-proxy DNAT        │  ← rules only, no interface
 └─────────────┬───────────────┘
               ▼
 ┌─────────────────────────────┐
 │ ingress-nginx pod           │  L7 — routes on Host/path,
 │                             │     then repeats VIP #3's trick
 └─────────────┬───────────────┘  toward the app's own ClusterIP
               ▼
 your pod (10.244.3.17:8080)      real IP, real socket, L7 app
```

Three VIPs, four layers, and each hop has exactly one mechanism that can fail and one team that owns it. Which is the rule of thumb this page exists to teach: **name the layer, name the VIP, and you've named the owner to escalate to.** "The appliance VIP times out but the MetalLB IP answers from inside the network" is a sentence that gets an incident routed correctly in one message. "The website is down" is not.

From here, [life of a request](/routing/life-of-a-request/) traces one HTTP call through every hop in that diagram, and [the networking model](/networking/networking-model/) covers the L3 substrate all of it stands on.
