---
title: "How MetalLB Chooses Which Node Answers for a VIP"
description: The mental model and the mechanism behind the "magic" — why one node (L2) or several nodes (BGP) start answering for a LoadBalancer IP that isn't bound to any interface, how the choice is made, and how to see which node is chosen right now.
sidebar:
  order: 5.5
---

You create a `type: LoadBalancer` Service, [MetalLB](/controllers/metallb/) stamps it with an IP, and somehow the physical network starts delivering that IP's traffic to *one* of your nodes — not all of them, not a random one each time, but a specific node that keeps answering until it can't. It feels like magic. It isn't. This article is the mental model for what actually happens, in both L2 and BGP modes, and the commands to watch it happen.

The question to hold onto the whole way through: **the IP is bound to no interface on any node** (confirm it — `ip addr | grep <vip>` comes back empty on every node). So "which node answers for it" is not "which node has the address configured." It's "which node has volunteered to *speak for* an address nobody owns" — and MetalLB's entire job is to make exactly the right set of nodes volunteer, and the rest stay quiet.

## Start here: nobody binds the VIP

A LoadBalancer IP is a [virtual IP](/networking/layers-and-vips/#what-is-a-vip) — a promise, not an interface. Recall the two-hop journey every external packet makes:

```text
   client ──▶ [Hop 1: which NODE?] ──▶ node NIC ──▶ [Hop 2: which POD?] ──▶ pod
              MetalLB owns this hop                  kube-proxy/CNI owns this hop
```

Hop 2 — node to pod — is the ordinary Service dataplane ([kube-proxy and the dataplane](/routing/kube-proxy-and-the-dataplane/)) and is the same on every cluster. **Hop 1 is the mystery, and it's the only thing MetalLB does at packet-adjacent level.** MetalLB never carries a packet; it just arranges the *lower network* — the switch or the router — to deliver the VIP to a node. How it arranges that is the one difference between the two modes, and it changes everything downstream.

The single sentence that separates the modes:

> **L2 mode makes ONE node claim the VIP (it's failover). BGP mode makes MANY nodes claim it (it's load balancing).** Everything else — failover speed, throughput ceiling, how you debug it — falls out of that one difference.

## L2 mode: one node volunteers to answer ARP

### The mental model: one receptionist per phone number

On a flat Layer-2 segment, a switch delivers frames to MAC addresses, and it learns "which MAC owns which IP" by broadcasting an ARP question — *"who has `10.40.8.112`? tell me your MAC."* ([the L2 layer](/networking/layers-and-vips/#the-four-layers)). Normally the host that *owns* an IP answers. But no host owns the VIP. So MetalLB elects **one speaker** to answer the ARP question on the VIP's behalf — replying with *its own node's* MAC address, as if to say "route `10.40.8.112` to me." The switch believes it, caches `VIP → that node's MAC`, and sends every packet for the VIP to that one node.

Think of it as one receptionist answering a shared phone number. The number rings a desk; whoever picked up the "who has this number?" call takes every call until they leave, at which point a colleague grabs the handset and announces the number is theirs now. The number never moved — the person answering did.

Two consequences are baked into this model and worth internalizing:

- **It is failover, not load balancing.** All VIP traffic lands on one node's NIC, then fans out to pods. Fine for most services; a hard ceiling at one node's throughput for a heavy one. More pods don't help hop 1 — only BGP does.
- **Exactly one node must answer.** If two answered ARP for one IP, the switch's cache would flap between two MACs and connections would reset at random — that's the [split-brain failure](/routing/floating-vips/#split-brain-when-two-boxes-claim-the-vip), and [a real incident](/blog/the-vip-that-two-nodes-claimed/). MetalLB's election exists precisely to guarantee "exactly one."

### The mechanism: memberlist gossip and a per-IP election

The speakers (a DaemonSet, one per node) form a **memberlist** gossip cluster — a peer-to-peer heartbeat over port 7946 so every speaker knows which other speakers are alive. For each Service IP, they run a **deterministic leader election**: given the current member list, a hash of the members plus the IP picks one winner, and — because they all run the same function over the same member list — they all independently agree on the same winner without a central coordinator. The winner's speaker starts answering ARP (IPv4) / NDP (IPv6) for that IP; every other speaker stays silent for it.

When the winning node dies, memberlist notices the missing heartbeats (~10 s with defaults), the surviving speakers re-run the election over the smaller member list, a new winner emerges, and it immediately broadcasts a **gratuitous ARP** — an unsolicited "`10.40.8.112` is at MY MAC now" — to update every cache on the segment. That gratuitous ARP *is* the failover; devices that miss it keep sending to the dead node until their ARP entry ages out, which is the "VIP dark for a few minutes after maintenance" blip. The full mechanism — shared with VRRP and keepalived — is [Floating VIPs](/routing/floating-vips/).

### Seeing which node answers, right now

MetalLB announces the winner in a Service event, so you rarely need node access to find it:

```console
$ kubectl describe svc web | grep -i announc
  Normal  nodeAssigned  32m  metallb-speaker  announcing from node "worker-07" (protocol "layer2")
```

`worker-07` is your receptionist. Confirm the wire agrees, from any client on the same segment — the VIP should resolve to worker-07's MAC:

```console
$ arping -c 2 10.40.8.112
Unicast reply from 10.40.8.112 [52:54:00:ab:3e:91]  0.70ms
$ ip neigh show 10.40.8.112          # or:  arp -n 10.40.8.112
10.40.8.112 dev eth0 lladdr 52:54:00:ab:3e:91 REACHABLE
```

Cross-check `52:54:00:ab:3e:91` against worker-07's NIC and the loop is closed: the event says worker-07, the segment agrees, hop 1 is healthy. **Two** MACs answering, or a MAC that isn't the announced node's, is the split-brain/stale-cache signature. (Every command here is in the [cross-platform command reference](/networking/networking-commands/), because you'll run it from a laptop or jump box, not a pod.)

## BGP mode: many nodes advertise a route

### The mental model: publish the same destination from many doors

BGP is how the internet's routers learn "to reach network X, send it my way." In BGP mode, **every** speaker (or a selected set) opens a BGP session to your upstream routers and *advertises the VIP as a `/32` host route* with its own node IP as the next hop — each node telling the router "I can reach `10.40.8.112`; route it through me." The router now has N equal-cost paths to the same `/32` and uses **ECMP (Equal-Cost Multi-Path)**: it hashes each connection's 5-tuple to pick one of the N nodes, spreading *different connections* across *different nodes*.

The receptionist analogy inverts: instead of one desk answering, the same number is published from many doors, and the building's router at the entrance sends each visitor through a different door based on who they are. No election, no single holder — genuine multi-node load balancing at router silicon speed.

### The mechanism, and its one sharp edge

Each speaker's BGP session carries its node as a live next-hop; the router installs all live next-hops as ECMP paths. When a node dies, its BGP session drops (fast, if [BFD](/controllers/metallb/) is on — a few hundred ms; otherwise BGP hold timers, tens of seconds), the router withdraws that path, and traffic redistributes over the survivors.

The edge that surprises people: **ECMP hashes flows, and changing the node set rehashes some of them.** Add, drain, or flap a node and the router recomputes which node each flow hashes to; a fraction of *existing* connections suddenly hash to a different node that has no [conntrack](/routing/kube-proxy-and-the-dataplane/) state for them and answers with `RST`. Long-lived connections (DB sessions, websockets, MQ consumers) feel node maintenance as "connections reset during the change window." It's inherent to ECMP, not a bug — mitigate with client retries, not tickets.

### Seeing the paths

This side mostly needs platform/network access, but the shape tells you what to ask for. On the router (or via `vtysh` in an FRR-mode speaker pod), the VIP shows multiple next-hops:

```console
$ vtysh -c 'show ip route 10.40.8.112'
B>* 10.40.8.112/32 [20/0] via 10.40.0.11 (worker-01), 00:14:22
  *                        via 10.40.0.13 (worker-03), 00:14:22
  *                        via 10.40.0.17 (worker-07), 00:14:22
```

Three next-hops = three nodes advertising = ECMP across three. A node missing from that list that *should* be there is the thing to escalate — "worker-03 isn't advertising `10.40.8.112`, but it's Ready and running a speaker." The [MetalLB troubleshooting section](/controllers/metallb/#troubleshooting-symptom-first) covers packaging that for the platform/network teams.

## The two modes, side by side

| | **L2 mode** | **BGP mode** |
|---|---|---|
| How the network learns the node | ARP/NDP reply from one speaker | BGP `/32` route from many speakers |
| Nodes answering for one VIP | **exactly one** (elected) | **many** (all advertising nodes) |
| Nature | failover | load balancing |
| Throughput ceiling | one node's NIC | sum of advertising nodes |
| Who picks the node | MetalLB's memberlist election | the router's ECMP hash |
| Failover trigger | memberlist loss → re-elect → gratuitous ARP | BGP/BFD session drop → route withdraw |
| Failover speed | ~10 s + ARP-cache tail | ms (BFD) to tens of s (hold timer) |
| Network-team involvement | none (works on a flat segment) | BGP peering config required |
| Sharp edge | single-node ceiling; split-brain if gossip partitions | ECMP rehash resets flows on node-set change |

## The knob that changes *which* nodes are eligible

Neither mode necessarily uses *all* nodes — two things narrow the candidate set, and both are worth knowing because they explain "why is only node X answering?" and "why did traffic stop reaching some pods?"

- **`externalTrafficPolicy`** ([Services deep dive](/networking/services-deep-dive/)) is the big one, and it changes announcement, not just forwarding:
  - **`Cluster`** (default): *every* node is a valid target. L2 elects from all nodes; in BGP *all* speakers advertise. The receiving node then forwards to any pod cluster-wide, SNATing the source (your app sees a node IP, not the client — see [SNAT and DNAT](/routing/nat/)).
  - **`Local`**: only nodes with a **Ready local pod** may answer. In L2, MetalLB elects the announcer *only from nodes hosting a pod*; in BGP, *only those nodes advertise the `/32`*. This preserves the client IP and skips a hop — but it couples announcement to readiness, so a rollout that moves all pods off a node yanks that node out of the answer set, and a badly-spread Deployment concentrates all traffic on one or two nodes. [External Load Balancing](/networking/external-load-balancing/#externaltrafficpolicy-the-trade-you-must-choose) covers the trade in full.
- **Node selectors** on the `L2Advertisement`/`BGPAdvertisement` CRs can restrict candidates to, say, only edge-tier nodes — a platform-set constraint you can *read* to explain an otherwise-surprising choice ([the CR family](/controllers/metallb/#the-crs-that-explain-your-services-behavior)).

So the honest, complete answer to "which node answers for my VIP?" is: **the node MetalLB elected (L2) or the nodes the router hashes to (BGP), drawn from the set of nodes that (a) run a healthy speaker, (b) satisfy the advertisement's node selector, and (c) — under `Local` — host a Ready pod.** Narrow that set to one and you've predicted the L2 winner; that's the whole model.

## The one-paragraph version

The VIP is bound to no interface, so "which node answers" means "which node volunteered to speak for it." In **L2 mode**, MetalLB elects exactly one speaker to answer ARP with its node's MAC — failover, one-node ceiling, `describe svc` names the winner. In **BGP mode**, many speakers advertise the VIP as a `/32` and the router's ECMP spreads connections across them — load balancing, multi-node throughput, `show ip route` names the paths. `externalTrafficPolicy: Local` and node selectors trim the eligible set. Once a packet lands on the chosen node, hop 2 (kube-proxy → pod) is the same everywhere. For the failover mechanism itself see [Floating VIPs](/routing/floating-vips/); for the CRs, pools, and the ticket-writing playbook see [MetalLB](/controllers/metallb/); and for the commands above on macOS, Linux, or Windows, see the [command reference](/networking/networking-commands/).
