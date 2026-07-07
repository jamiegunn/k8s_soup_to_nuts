---
title: "Floating VIPs: VRRP, keepalived, and How Failover Actually Happens"
description: The mechanism under every HA virtual IP — VRRP advertisements, the virtual MAC, gratuitous ARP on failover, split-brain, and how keepalived, kube-vip, and MetalLB are all the same pattern wearing different clothes.
sidebar:
  order: 7
---

[Network Layers and VIPs](/networking/layers-and-vips/) defined a VIP as *a promise, not an interface*: "the address is permanent, the answerer is fungible." It listed three VIPs in the corporate path — appliance VIP, MetalLB IP, ClusterIP — and gave the failover mechanism for each a single line. This article is that single line, opened up. **How does the answerer actually change?** When the box holding a VIP dies, what makes the *next* box start answering for it, and how fast, and what goes wrong.

Every answer in the enterprise is a variation on one 25-year-old protocol.

## The one pattern

Strip away the vendors and every floating VIP is the same four moving parts:

1. **A set of candidates** that could hold the address (two F5s, three keepalived hosts, every MetalLB speaker node).
2. **A heartbeat** so candidates know who else is alive.
3. **An election** that picks exactly one holder — the *master* — deterministically.
4. **An announcement** the instant the holder changes, so the rest of the L2 segment stops sending frames to the old holder's MAC.

That fourth step is the one everyone forgets and every incident lives in. A VIP is an IP, but frames are delivered to *MAC addresses* ([the L2 section of Layers and VIPs](/networking/layers-and-vips/)). When the holder changes, the IP-to-MAC mapping cached all over the segment — on switches, routers, the appliance, peer nodes — is now a lie, and traffic keeps flowing to a dead interface until each cache is corrected or expires. The announcement is a **gratuitous ARP** (L2) or a **BGP re-advertisement** (L3), and getting it heard is the whole game.

> **The failover is not "the VIP moves." The failover is "everyone on the segment updates their ARP cache."** The IP reassignment is instant and local; the cache update is a broadcast others may miss. Almost every "VIP dark for four minutes after maintenance" incident is step 4 not landing, not steps 1–3 failing.

## VRRP: the protocol under the appliance VIP

The corporate F5/NetScaler HA pair floats VIP #1 with **VRRP** — the Virtual Router Redundancy Protocol ([RFC 5798](https://datatracker.ietf.org/doc/html/rfc5798)). keepalived on Linux is the same protocol; kube-vip's ARP mode is a re-implementation of the same idea. Learn it once and all three read the same.

The moving parts, named:

- **Virtual Router ID (VRID)** — a number 1–255 identifying *this* floating address's cluster. Every candidate for the same VIP shares a VRID; two different VIPs on the same segment must use different VRIDs.
- **Priority** — 1–254; highest wins the election. The intended master is configured higher (say 150) than the backup (100).
- **Advertisements** — the heartbeat. The master multicasts a small VRRP packet to `224.0.0.18`, **IP protocol 112** (not TCP, not UDP — its own protocol number), once per `advert_int` (default 1 s). Backups listen. Miss ~3 in a row and a backup promotes itself.
- **The virtual MAC** — the piece that makes VRRP elegant. The VIP is paired with a *derived* MAC address `00:00:5e:00:01:{VRID}`. Whoever is master answers ARP for the VIP with **that** MAC, not their NIC's burned-in MAC. So when failover happens, the IP *and* its MAC move together — and a switch that already learned the virtual MAC only needs to relearn which **port** it lives on, a faster and more reliable update than changing the IP-to-MAC binding itself.

You can watch the heartbeat directly if you can capture on the segment (a platform/network-team vantage — VRRP is not visible from inside a pod):

```console
$ tcpdump -ni eth0 'vrrp' -v -c 2
14:22:01.001 IP 10.40.8.11 > 224.0.0.18: VRRPv2, Advertisement, vrid 20, prio 150,
                 authtype none, intvl 1s, length 20
14:22:02.002 IP 10.40.8.11 > 224.0.0.18: VRRPv2, Advertisement, vrid 20, prio 150, ...
```

One master (`prio 150`) advertising VRID 20 once a second from `10.40.8.11`. That is a healthy floating VIP at rest. The absence of these packets — or **two** sources sending them for the same VRID — is the entire diagnostic surface, and both show up below.

### keepalived: VRRP you can read

On a Linux box (a self-managed ingress node, a legacy HA proxy pair, a NAT gateway), the same protocol is configured in `/etc/keepalived/keepalived.conf`:

```text
vrrp_instance FRONT_DOOR {
    state MASTER            # intended role; the election overrides this
    interface eth0
    virtual_router_id 20    # the VRID — must match on both peers, unique per VIP
    priority 150            # backup runs 100
    advert_int 1            # heartbeat interval, seconds
    authentication {
        auth_type PASS
        auth_pass s3cr3t    # must match, or peers ignore each other → split-brain
    }
    virtual_ipaddress {
        10.40.8.200/24      # the floating VIP
    }
}
```

When this host is master, `10.40.8.200` is an *extra* address on `eth0`; when it loses the election, keepalived deletes the address. You can watch the VIP appear and vanish — the most direct proof that a VIP is not an interface but a role:

```console
# on the master — the VIP is present as a secondary address
$ ip -br addr show eth0
eth0  UP  10.40.8.11/24 10.40.8.200/24

# on the backup — same VIP, absent
$ ip -br addr show eth0
eth0  UP  10.40.8.12/24
```

`ip monitor address` on the backup during a failover prints the exact instant the address is added — a live view of step 1.

### The failover sequence, and the gratuitous ARP that matters

Master dies at t=0. Here is every step, with the timing that bites:

```text
t=0.0s   master (10.40.8.11) loses power / crashes / is drained
t=0.0s   its advertisements stop
t≈3.3s   backup has missed 3 × advert_int → declares itself master
         (this delay is master_down_interval ≈ 3×advert_int + skew — the
          floor on VRRP failover; you cannot fail over faster than the
          heartbeat lets a backup notice silence)
t≈3.3s   backup adds 10.40.8.200 to its interface  ← the VIP "moves"
t≈3.3s   backup sends GRATUITOUS ARP: "10.40.8.200 is at <virtual MAC>,
         and it's on MY port now" — broadcast to the whole segment  ← step 4
t≈3.3s+  every switch/router/peer that HEARS the GARP updates its cache
         instantly; every device that MISSES it keeps sending to the old
         port until its ARP entry ages out (minutes)
```

Two numbers own this diagram. The **~3.3 s floor** is why VRRP failover is "a few seconds," never instant — and why sub-second appliance failover (from [Layers and VIPs](/networking/layers-and-vips/)) requires *connection-state mirroring* between the HA pair, a separate feature layered on top of VRRP, not VRRP itself. The **GARP miss** is the long tail: a device that ignores gratuitous ARP (some switches, some firewalls, misconfigured appliances) blackholes the VIP for its full ARP-cache lifetime. This is identical in shape to the MetalLB L2 failover blip documented in [MetalLB](/controllers/metallb/#l2-mode-one-node-answers-arp) — because it is the same mechanism.

:::note[Preemption: the failover that happens twice]
`preempt` (VRRP's default) means: when the *original* master recovers, its higher priority makes it seize the VIP back — a **second** failover, and a second GARP storm, often during business hours when the failed node gets fixed. Each seizure breaks every connection that isn't state-mirrored. Many shops set `nopreempt` so a recovered master stays *backup* until the next real failure — one failover per incident instead of two. If your appliance VIP "blips again an hour after we fixed the node," preemption is the suspect. This is a network-team knob, but naming it correctly gets it turned off.
:::

## Split-brain: when two boxes claim the VIP

The failure mode with teeth. VRRP's correctness depends on candidates *hearing each other's advertisements*. Break that hearing while both boxes are alive, and **both** promote to master. Now two interfaces answer ARP for the same VIP with — depending on config — the same virtual MAC from two switch ports, or two different MACs. The segment's caches flap between them. Symptoms are maddening because they're statistical:

- Roughly half of new connections work, half don't — depending on which MAC the client's ARP cache last latched.
- Intermittent `connection reset`: a client's flow lands on box A, a retransmit lands on box B, which has no state for it and sends `RST`.
- The VIP "works from some places, not others" on the same segment at the same instant.

The classic causes, all of which keep both boxes healthy while blinding them to each other:

| Cause | Why it splits the brain |
|---|---|
| **Multicast blocked** between the peers (switch IGMP snooping, a firewall on the heartbeat VLAN) | Advertisements to `224.0.0.18` never arrive; each peer hears silence and assumes it's alone. |
| **`auth_pass` mismatch** (keepalived) | Peers receive each other's adverts but *reject* them as unauthenticated — same as not hearing them. |
| **VRID collision** — two unrelated VIP pairs configured with the same `virtual_router_id` on one segment | Peers of pair A accept pair B's adverts as their own, corrupting both elections. |
| **Heartbeat-link partition** — the dedicated sync/heartbeat interface fails but the data interfaces stay up | Both boxes are up and serving; neither sees the other. The textbook split-brain. |

Detecting it from the segment is direct — capture VRRP and count the sources:

```console
$ tcpdump -ni eth0 'vrrp' -c 4
14:31:10.101 IP 10.40.8.11 > 224.0.0.18: VRRPv2, Advertisement, vrid 20, prio 150, ...
14:31:10.140 IP 10.40.8.12 > 224.0.0.18: VRRPv2, Advertisement, vrid 20, prio 100, ...
14:31:11.102 IP 10.40.8.11 > 224.0.0.18: VRRPv2, Advertisement, vrid 20, prio 150, ...
14:31:11.141 IP 10.40.8.12 > 224.0.0.18: VRRPv2, Advertisement, vrid 20, prio 100, ...
```

**Two** sources advertising the same VRID means both think they're master. (A healthy pair shows exactly one advertising source; the backup is silent until it promotes.) The other tell is a duplicate-address probe from any host on the segment:

```console
$ arping -D -I eth0 10.40.8.200 -c 3
ARPING 10.40.8.200
Unicast reply from 10.40.8.200 [00:00:5e:00:01:14]  0.700ms
Unicast reply from 10.40.8.200 [52:54:00:9d:2f:b1]  0.812ms   ← two different MACs!
```

Two MACs answering for one IP is split-brain caught red-handed. (`-D` is arping's duplicate-detection mode.) From a plain client, the flapping shows up in the neighbor cache:

```console
$ ip neigh show 10.40.8.200        # run twice, seconds apart
10.40.8.200 dev eth0 lladdr 00:00:5e:00:01:14 REACHABLE
$ ip neigh show 10.40.8.200
10.40.8.200 dev eth0 lladdr 52:54:00:9d:2f:b1 REACHABLE   ← MAC changed with no failover
```

A VIP MAC that changes while *nothing failed over* is split-brain until proven otherwise. The fix is always network-team territory — restore multicast, align the auth password, deconflict the VRID — but arriving with "two VRRP masters for VRID 20, here's the capture" turns a day of finger-pointing into a ten-minute config diff.

## kube-vip and MetalLB: the same pattern, Kubernetes-native

Two components bring floating VIPs *inside* the cluster, and both are the pattern above with the election moved into Kubernetes:

- **kube-vip** gives the **control plane** a VIP (so `kubectl` has one stable API-server address across three control-plane nodes) and can also fulfill `type: LoadBalancer` Services. In **ARP/L2 mode** it does leader election through the Kubernetes API (a Lease object) instead of VRRP multicast, then the leader answers ARP for the VIP and sends gratuitous ARP on failover — VRRP's step 4 without VRRP's step 2. In **BGP mode** it advertises the VIP as a route, skipping ARP entirely (L3). App teams rarely touch kube-vip directly; you meet it as "why does the API server have one IP when there are three control-plane nodes?"
- **MetalLB L2 mode** floats each LoadBalancer IP with the identical shape: memberlist gossip for the heartbeat, leader election per service, one node answering ARP, gratuitous ARP on failover. [MetalLB's own docs](/controllers/metallb/#l2-mode-one-node-answers-arp) already draw the equivalence — *"a floating IP claimed via ARP, one active holder, gratuitous ARP on failover"* — and its ~10 s memberlist failover is the same "how fast does a backup notice silence?" floor that VRRP's `master_down_interval` sets, just with a slower heartbeat.

The lesson from [Layers and VIPs](/networking/layers-and-vips/) — *Kubernetes networking is the VIP trick applied recursively* — is literally true here: the appliance VIP (VRRP), the MetalLB IP (memberlist), and kube-vip's control-plane VIP (Lease) are three instances of one 4-part pattern, stacked.

## Connections do not survive failover (unless someone paid for it)

A hard truth the pattern hides: floating the *address* does not float the *connections*. When VIP #1 moves from active F5 to standby, the standby has never seen any of the in-flight TCP flows. Every established connection is dead the instant the VIP lands, unless the HA pair runs **connection-state mirroring** — continuously replicating the conntrack/session table between peers so the standby can adopt live flows. That feature is expensive, is off by default on plenty of deployments, and doesn't exist at all for MetalLB L2 or kube-vip ARP mode.

So the honest failover expectation, by VIP type:

| VIP | Failover time | Do established connections survive? |
|---|---|---|
| Appliance VIP (VRRP + state mirroring) | sub-second | Yes — that's what the mirroring buys |
| Appliance VIP (VRRP, no mirroring) | ~1–3 s | No — clients must reconnect |
| MetalLB L2 (memberlist) | ~10 s + ARP-cache tail | No |
| kube-vip control-plane (Lease + ARP) | seconds | No — but `kubectl` just retries |

This is why [Long-Lived Connections](/networking/long-lived-connections/) insists that clients reconnect gracefully: on every VIP layer except a state-mirrored appliance, a failover is a mass reconnect event, and an app that treats a dropped connection as a fatal error will page you every time the network team patches an appliance. Design for the reconnect and failovers become invisible; assume connections are eternal and every maintenance window is an outage.

## The toolbox

Everything you'd reach for, and which side of the platform line it lives on (syntax for each across Linux, macOS, and Windows is in the [command reference](/networking/networking-commands/)):

| Tool | What it shows | Vantage |
|---|---|---|
| `tcpdump -ni <if> vrrp` | VRRP advertisements — count the sources (1 = healthy, 2 = split-brain) | segment / node (platform) |
| `arping -D -I <if> <vip>` | Duplicate-address detection — two MACs = split-brain | any host on the segment |
| `ip neigh show <vip>` | The current IP→MAC binding this host believes; flapping = trouble | any host, incl. debug pod on hostNetwork |
| `ip -br addr show <if>` | Whether *this* box currently holds the VIP as a secondary address | the candidate hosts (platform) |
| `ip monitor address` | Live add/delete of the VIP during a failover | the candidate hosts (platform) |
| `ip neigh flush to <vip>` | Force-clear a stale binding to end a "VIP dark after failover" blip | the host with the stale cache |
| keepalived logs (`journalctl -u keepalived`) | Election transitions: `Entering MASTER STATE` / `BACKUP STATE` | keepalived hosts (platform) |

What you can see from a pod is almost nothing — VRRP is L2 multicast on a segment your pod isn't on. The app-team move is to *characterize the blip from the client side* (a tight `curl` loop across a maintenance window, timestamping every failure) and hand the platform team a precise window: **"the VIP was unreachable from 14:22:01 to 14:22:11, ~10 s, during your node drain"** localizes it to a failover event and its GARP tail without any node access. [Working with the Platform Team](/operations/working-with-platform-team/) covers packaging that hand-off.

## The one-paragraph version

Every HA virtual IP — appliance, MetalLB, control plane — is one holder, a heartbeat, an election, and an announcement. The address reassignment is instant; the *announcement* (gratuitous ARP, or a BGP re-advertise) is what the rest of the segment may miss, and that miss is nearly every failover incident you'll ever see. Two masters for one VIP is split-brain — capture VRRP, count the sources. And unless someone paid for state mirroring, a failover drops every connection: design clients to reconnect and the whole subject turns into a non-event. From here, [Layers and VIPs](/networking/layers-and-vips/) is the map of *which* VIPs sit in your path, and [SNAT and DNAT](/routing/nat/) is what each of them does to your packets once traffic is flowing.
