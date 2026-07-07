---
title: "Field Notes: The VIP That Two Nodes Claimed"
description: Intermittent connection resets on a MetalLB LoadBalancer IP that worked from half the clients and failed from the other half — and the arping capture that revealed two nodes answering for the same virtual IP.
keywords:
  - MetalLB L2 mode split-brain
  - memberlist port 7946 blocked
  - gratuitous ARP two owners
  - ip neigh two MACs one IP
  - arping -D duplicate address probe
  - connection reset RST half of clients
  - LoadBalancer VIP flaky after maintenance
  - firewall between node subnets
date: 2026-07-06
authors: editor
tags:
  - networking
  - metallb
  - vip
  - debugging
excerpt: Our LoadBalancer VIP started resetting about half of all new connections — and which half depended on where the client was sitting. The address was fine. The problem was that two nodes both thought they owned it.
---

The ticket said "the service is flaky." The ticket is always wrong about *how*.

Our `orders-tcp` service is a plain `type: LoadBalancer` fronted by MetalLB in L2 mode — a raw TCP protocol, not HTTP, so no ingress controller in the path, just the [MetalLB](/controllers/metallb/) VIP `10.40.8.200` and the Service dataplane behind it. It had been boring for a year. Then, an hour after a Tuesday-night network maintenance, it started resetting connections. Not all of them. Roughly half.

The word "half" is a clue, and we almost missed it. A service that's *down* fails everyone; a service that's *slow* fails everyone a little. A service that fails a clean ~50% of new connections, with established ones surviving, is a service where **two things disagree about the answer** — and the coin flip decides which one you get.

## Half is a function of *where you stand*

The first real signal came from testing the VIP from two different client subnets at the same time:

```console
# from a jumpbox on the same L2 segment as the nodes
$ for i in $(seq 1 10); do nc -w2 -z 10.40.8.200 5432 && echo ok || echo FAIL; done
ok
ok
ok
...  # 10/10 ok

# from an app pod whose node is on a different segment
$ kubectl exec deploy/reporting -- sh -c \
    'for i in $(seq 1 10); do nc -w2 -z 10.40.8.200 5432 && echo ok || echo FAIL; done'
FAIL
ok
FAIL
FAIL
ok
...  # ~5/10 FAIL, and which ones flipped run to run
```

So it wasn't "half of connections" globally — it was "reliable from here, a coin-flip from there." Two vantage points, two different truths about the same IP. That is the signature of a Layer-2 identity problem: somebody's ARP cache is pointing the VIP at a different place than somebody else's.

## Watching the neighbor cache lie

[Network Layers and VIPs](/networking/layers-and-vips/) drills one reflex: when a VIP misbehaves after maintenance, look at the IP-to-MAC binding before anything else. We checked it from the flaky client's segment — twice, a few seconds apart:

```console
$ ip neigh show 10.40.8.200
10.40.8.200 dev eth0 lladdr 52:54:00:9d:2f:b1 REACHABLE
$ ip neigh show 10.40.8.200
10.40.8.200 dev eth0 lladdr 52:54:00:a1:77:e0 REACHABLE   ← different MAC, no failover
```

The MAC for our VIP was *changing on its own*, with no node drain, no failover, no MetalLB event. A VIP's MAC changing while nothing failed over is not failover — it's [two owners fighting over the address](/routing/floating-vips/#split-brain-when-two-boxes-claim-the-vip). We confirmed it the blunt way, with arping's duplicate-address probe from the segment (a platform engineer ran this — we don't have node-segment access):

```console
$ arping -D -I eth0 10.40.8.200 -c 4
ARPING 10.40.8.200
Unicast reply from 10.40.8.200 [52:54:00:9d:2f:b1]  0.71ms
Unicast reply from 10.40.8.200 [52:54:00:a1:77:e0]  0.83ms
Unicast reply from 10.40.8.200 [52:54:00:9d:2f:b1]  0.68ms
Unicast reply from 10.40.8.200 [52:54:00:a1:77:e0]  0.79ms
```

**Two MACs answering for one IP.** Textbook split-brain. And mapping those MACs to nodes told the rest of the story:

```console
$ kubectl get nodes -o custom-columns=NAME:.metadata.name,IP:.status.addresses[0].address
worker-3   10.40.8.13   # NIC MAC 52:54:00:9d:2f:b1
worker-7   10.40.9.7    # NIC MAC 52:54:00:a1:77:e0   ← different subnet!
```

`worker-3` and `worker-7` were on *different subnets* — and both were announcing our VIP. A client's success depended entirely on which node's gratuitous ARP its switch had heard most recently. Whichever node it wasn't currently pointing at, the SYN went to a node that had the VIP on an interface but whose flow state didn't match — and it answered with an `RST`.

## Why two nodes both became leader

MetalLB L2 mode is supposed to make this impossible: its speakers gossip over [memberlist](/controllers/metallb/) and elect exactly *one* node to answer ARP for each VIP. One leader, by design. Two leaders means the election itself broke — and an election breaks when the candidates can't hear each other, which is exactly the class of failure [floating VIPs](/routing/floating-vips/#split-brain-when-two-boxes-claim-the-vip) warns about, whether the heartbeat is VRRP multicast or memberlist gossip. The speaker logs named it:

```console
$ kubectl -n metallb-system logs ds/speaker --since=2h | grep -iE 'memberlist|leader|lost'
worker-3 speaker: memberlist: suspect worker-7 has failed, no acks received
worker-7 speaker: memberlist: suspect worker-3 has failed, no acks received
worker-3 speaker: {"event":"serviceAnnounced","ip":"10.40.8.200","node":"worker-3"}
worker-7 speaker: {"event":"serviceAnnounced","ip":"10.40.8.200","node":"worker-7"}
```

Each speaker had declared the *other* dead and elected itself. They were both alive and both serving — they simply couldn't hear one another. MetalLB's memberlist runs on **port 7946 (TCP and UDP)** between nodes, and Tuesday's maintenance had added a firewall rule between the `10.40.8.0/24` and `10.40.9.0/24` node subnets that dropped it. The gossip couldn't cross the subnet boundary; each side of the partition ran its own election; both winners grabbed the VIP. A partitioned heartbeat is the purest form of split-brain — everyone's healthy, nobody's talking.

## The fix, and the guardrail

**Immediate (platform team, that night):** reopen 7946/TCP+UDP between the node subnets. Within seconds memberlist re-converged, one speaker yielded the VIP, it sent a gratuitous ARP, and `arping -D` went back to a single MAC. The resets stopped.

```console
$ arping -D -I eth0 10.40.8.200 -c 3
Unicast reply from 10.40.8.200 [52:54:00:9d:2f:b1]  0.70ms
Unicast reply from 10.40.8.200 [52:54:00:9d:2f:b1]  0.69ms
Unicast reply from 10.40.8.200 [52:54:00:9d:2f:b1]  0.71ms   # one owner again
```

**Durable:** the maintenance change had a firewall rule with a source/destination scoped to "node subnets" but a port list that never contemplated cluster-internal control traffic. The platform team added MetalLB's memberlist port — and, while they were at it, the rest of the intra-cluster ports — to a permanent allow-list documented as *"never firewall between nodes."*

## What we changed on our side

We don't own MetalLB and we didn't fix the firewall. But this incident was ours to *localize*, and we came out with reflexes:

- **"Which half?" is the first question when a service fails ~50%.** If success depends on the client's vantage point rather than the request, it's an L2 identity problem — stale or split ARP — not the app. We now test every "flaky" networking ticket from two segments before touching anything.
- **`ip neigh show <vip>`, run twice, is a five-second split-brain test.** A VIP MAC that changes with no failover event is two owners until proven otherwise. It went into the runbook above the app logs, not below them.
- **We package the escalation with the capture.** "The service is flaky" gets a shrug; "`arping -D` shows two MACs answering for 10.40.8.200 — worker-3 and worker-7, on different subnets — memberlist is partitioned" gets a firewall change in ten minutes. [Working with the platform team](/operations/working-with-platform-team/) is mostly about handing them the sentence that names the fix.
- **Our TCP client already reconnected on reset — and that's why this was a degradation, not an outage.** Every VIP failover and every split-brain is a reconnect event ([long-lived connections](/networking/long-lived-connections/)); an app that treats a reset as fatal turns a 50% blip into a 100% page. Ours retried, so users saw slowness, not errors, and we had the room to debug calmly.

The address was never down. Two nodes just both believed it was theirs, and every client on the segment was quietly picking sides. One firewall port, opened, and the VIP remembered it could only belong to one node at a time.
