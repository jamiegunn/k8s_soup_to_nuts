---
title: kube-proxy and the Dataplane
description: The machinery that makes a ClusterIP real — the iptables chain walk, IPVS tables, eBPF replacements, and conntrack as the hidden state machine behind every Service connection.
sidebar:
  order: 3
---

[Services Deep Dive](/networking/services-deep-dive/) established the contract: a ClusterIP is a virtual address made real by packet-rewriting rules on every node. This article opens the hood on those rules — what they literally look like, how the kernel walks them, and the conntrack state machine that quietly holds every Service connection together. When [Life of a Request](/routing/life-of-a-request/) says "step 4: netfilter DNATs the packet," this is the zoom-in.

## 1. What kube-proxy actually is

The name is a lie, and it causes the #1 misconception in Kubernetes networking: **kube-proxy is not a proxy.** In iptables and IPVS modes, **no packet ever traverses the kube-proxy process.** It is a *rule programmer* — a control-plane agent (DaemonSet, one per node, platform-managed) that:

1. Watches Services and EndpointSlices via the API server.
2. Translates them into kernel configuration: iptables rules, IPVS virtual servers, or (in replacements) eBPF maps.
3. Resyncs when they change.

At packet time, the work is done entirely by the **kernel's netfilter/IPVS machinery**. Consequences worth internalizing:

- **Restarting kube-proxy does not drop connections.** The rules stay in the kernel; existing conntrack state keeps flowing. (Conversely: a *wedged* kube-proxy means rules go **stale** silently — traffic keeps flowing to yesterday's endpoints.)
- **kube-proxy being "up" proves nothing** about the dataplane. The interesting question is always "do the rules on node X match the current EndpointSlices?"
- **CPU/latency of Service routing is kernel time**, not visible as any pod's CPU usage.

There is a per-node **kube-proxy lag window**: EndpointSlices update, but each node applies rules on its own schedule. During a fast rollout, node A may route to the new pod while node B still routes to the terminated one. Debugging that requires knowing which node the *client* was on — a distinctly deep-dive fact.

:::note[Where the name came from]
The name is historical: the original `userspace` mode really did proxy — kube-proxy opened a listening port per Service and copied bytes between sockets. It was slow (two extra context switches per packet) and was retired years ago, but the binary kept the name. Every "restart kube-proxy to fix connections" ritual you'll encounter is cargo-culted from that era.
:::

You can verify the control-plane/data-plane split yourself on any cluster you can read:

```console
$ kubectl -n kube-system get ds kube-proxy -o wide
NAME         DESIRED  CURRENT  READY  ...  CONTAINERS   IMAGES
kube-proxy   12       12       12     ...  kube-proxy   registry.k8s.io/kube-proxy:v1.31.4
```

A DaemonSet like any other — and if the platform runs an eBPF replacement (§4), this DaemonSet simply won't exist, which is itself a useful early discovery.

## 2. iptables mode, dissected

The default mode on most platforms. kube-proxy writes rules into the `nat` table; the kernel evaluates them at the **PREROUTING** hook (traffic arriving on the node — external, or from pods with bridged CNIs) and the **OUTPUT** hook (traffic originating on the node, including host-network pods). Rule syntax reference: [iptables(8)](https://man7.org/linux/man-pages/man8/iptables.8.html).

Here is the actual chain walk for a Service `orders` (ClusterIP `10.96.44.7:80`) with three ready endpoints, as an annotated `iptables-save -t nat` excerpt:

```text
# Hook chains hand all traffic to kube-proxy's dispatcher:
-A PREROUTING -m comment --comment "kubernetes service portals" -j KUBE-SERVICES
-A OUTPUT     -m comment --comment "kubernetes service portals" -j KUBE-SERVICES

# KUBE-SERVICES: one match line per Service port in the cluster.
# Match = destination is the ClusterIP AND the port. Jump to the Service chain.
-A KUBE-SERVICES -d 10.96.44.7/32 -p tcp -m tcp --dport 80 \
    -m comment --comment "myteam/orders:http cluster IP" -j KUBE-SVC-FQ2RZLQ5EQ4Q22TA

# KUBE-SVC-*: the load balancer. First, mark off-cluster clients for masquerade:
-A KUBE-SVC-FQ2RZLQ5EQ4Q22TA ! -s 10.244.0.0/16 -d 10.96.44.7/32 -p tcp --dport 80 \
    -j KUBE-MARK-MASQ
# Then the statistical branch — one rule per endpoint:
-A KUBE-SVC-FQ2RZLQ5EQ4Q22TA -m statistic --mode random --probability 0.33333333349 \
    -j KUBE-SEP-2XZJVPRC2AWJCCJU       # endpoint 1: hit 1/3 of the time
-A KUBE-SVC-FQ2RZLQ5EQ4Q22TA -m statistic --mode random --probability 0.50000000000 \
    -j KUBE-SEP-6XC2VLKGQKU37Y5R       # endpoint 2: 1/2 of the REMAINING 2/3 = 1/3
-A KUBE-SVC-FQ2RZLQ5EQ4Q22TA \
    -j KUBE-SEP-XU5FZGGK7MCKBTGE       # endpoint 3: everything left = 1/3

# KUBE-SEP-*: one chain per endpoint. THE actual rewrite:
-A KUBE-SEP-XU5FZGGK7MCKBTGE -p tcp -m tcp \
    -j DNAT --to-destination 10.244.7.42:8080
# (plus a hairpin rule: if the SOURCE is this same pod, mark for masquerade,
#  so a pod reaching itself via the Service sees a reply it can accept)
```

Things to notice:

- **The probabilities cascade.** Each `statistic` rule's probability applies only to traffic that *fell past* the previous rules. For three endpoints:

  ```text
  P(endpoint 1) = 1/3                          = 0.333...
  P(endpoint 2) = (1 - 1/3) × 1/2              = 0.333...
  P(endpoint 3) = (1 - 1/3) × (1 - 1/2) × 1    = 0.333...
  ```

  For *n* endpoints the rules carry `1/n`, `1/(n-1)`, ..., `1/2`, then an unconditional fallthrough — every endpoint nets exactly `1/n`. But the draw is **random per connection**: statistically even over thousands of connections, lumpy over ten. Ten connections landing 6/3/1 across three pods is the binomial distribution working as designed, not a bug — and with keepalive pools holding few, long-lived connections, that lumpiness *persists*.
- **The decision happens once per connection**, on the first packet; then conntrack takes over (§5). No per-packet rebalancing, and no rebalancing of long-lived connections at all — see [Long-Lived Connections](/networking/long-lived-connections/).
- **Evaluation is linear.** `KUBE-SERVICES` is scanned top to bottom on the first packet of every new connection. At ~5,000 Services and tens of thousands of rules, rule *evaluation* cost is measurable and — worse — **rule sync** cost explodes: `iptables-restore` rewrites the whole table, and sync latency on churn-heavy clusters stretches from milliseconds to tens of seconds. That sync latency *is* the kube-proxy lag window from §1. This scaling wall is the main reason IPVS and eBPF modes exist.
- **Chain names are stable hashes.** `KUBE-SVC-FQ2RZLQ5EQ4Q22TA` is derived from `namespace/name:port` — the same Service gets the same chain name on every node, so a platform engineer can grep one node's ruleset and know it generalizes.

:::note[nftables under the hood — and as a mode]
On modern distros the `iptables` binary is actually `iptables-nft`, translating the same rule model onto the kernel's nftables backend — everything above still reads the same. Separately, kube-proxy has a native `nftables` *mode* (stable in recent Kubernetes) with faster incremental sync that eases the scaling wall. Which one your platform runs changes the dump command (`nft list ruleset`), not the concepts.
:::

## 3. IPVS mode

IPVS (IP Virtual Server) is a purpose-built L4 load balancer inside the kernel, and kube-proxy can program it instead of NAT-table branches. Every ClusterIP becomes a *virtual server* with a *real server* set — a hash-table lookup, O(1) regardless of Service count:

```console
# on a node (platform access)
$ ipvsadm -Ln
IP Virtual Server version 1.2.1 (size=4096)
Prot LocalAddress:Port Scheduler Flags
  -> RemoteAddress:Port      Forward Weight ActiveConn InActConn
TCP  10.96.44.7:80 rr
  -> 10.244.3.11:8080        Masq    1      14         2
  -> 10.244.7.42:8080        Masq    1      13         1
  -> 10.244.9.8:8080         Masq    1      15         3
```

That table is refreshingly honest compared to iptables: virtual server, scheduler (`rr` = round robin), each backend with live connection counts (`ActiveConn` = ESTABLISHED, `InActConn` = everything else conntrack still remembers). Two structural differences from iptables mode:

- **The ClusterIP becomes semi-real.** IPVS mode binds every Service IP to a local dummy interface (`kube-ipvs0`) so the kernel treats it as a local destination and hands it to IPVS. Side effect: ClusterIPs *answer pings* from nodes on IPVS clusters — a fun way to detect the mode, and a trap if you've internalized "ClusterIPs never ping" from [Services Deep Dive](/networking/services-deep-dive/).
- **Endpoint changes are surgical.** Adding one backend is one `ip_vs` API call, not an `iptables-restore` of the world — endpoint churn stays cheap at any Service count.

Schedulers include `rr`, `wrr` (weighted), `lc`/`wlc` (least-connection), and source-hash variants; kube-proxy defaults to `rr`, and the choice is a per-node platform flag, not per-Service — you cannot request `lc` for just your Service.

Platforms choose IPVS for: **many Services** (lookup is a hash, sync is incremental), **deterministic round-robin** instead of statistical spread, and least-connection scheduling for uneven request costs. IPVS still relies on iptables for the auxiliary bits (masquerade marking, filtering) and on **conntrack for everything in §5** — switching modes changes the *selection* machinery, not the NAT bookkeeping.

## 4. eBPF dataplanes: when there's no kube-proxy at all

Cilium (and other eBPF CNIs) can replace kube-proxy outright. Service resolution moves into eBPF programs attached at two levels:

- **Socket-level LB**: a cgroup eBPF hook rewrites the destination *inside the `connect()` syscall* — the packet leaves the client pod **already addressed to the pod IP**. The ClusterIP never appears on any wire, in any capture, at any hop.
- **XDP/tc-level LB** for traffic entering from outside the node (NodePort/LoadBalancer), translated at or near the NIC.

The endpoint set lives in BPF maps (hash tables updated by the Cilium agent), so "rule sync" becomes a map write — the iptables scaling wall simply doesn't exist. Even the observable *timing* changes: with socket-level LB the backend choice happens at connect time in the client's own kernel, so a `strace` of your app shows `connect()` returning with the pod IP already in place.

Honest guidance for app teams: this is **platform territory, and your old evidence trail vanishes.** There are no `KUBE-SVC-*` chains to read (`iptables-save` comes back nearly empty), often no conntrack entries for Service flows (Cilium keeps its own BPF connection-tracking maps), and a node `tcpdump` never shows the ClusterIP. The introspection tools are `bpftool map dump`, `cilium bpf lb list`, and `cilium monitor` — all requiring node/agent access. What you keep: everything pod-side (`ss`, app logs, `/etc/resolv.conf`) still works, and the *symptoms* table in §8 still maps. Just know which dataplane your platform runs before requesting evidence, or you'll ask for iptables output that cannot exist.

## 5. conntrack: the hidden state machine

Everything above decides where the **first packet** of a connection goes. Every packet after that is handled by **connection tracking** — netfilter's flow table — and most "intermittent network weirdness" on Kubernetes is conntrack behaving exactly as documented. Tunables reference: [nf_conntrack-sysctl](https://docs.kernel.org/networking/nf_conntrack-sysctl.html).

### Entry lifecycle for a Service connection

First SYN to `10.96.44.7:80` → chain walk (or IPVS lookup) picks `10.244.7.42:8080` → a conntrack entry is created recording *both* tuples — the original and the NAT'd reply:

```console
$ conntrack -L -d 10.96.44.7
tcp  6 108 SYN_SENT src=10.244.9.5 sport=41230 dst=10.96.44.7 dport=80 \
     [UNREPLIED] src=10.244.7.42 sport=8080 dst=10.244.9.5 dport=41230 mark=0 use=1
# ...handshake completes...
tcp  6 86400 ESTABLISHED src=10.244.9.5 sport=41230 dst=10.96.44.7 dport=80 \
     src=10.244.7.42 sport=8080 dst=10.244.9.5 dport=41230 [ASSURED] use=1
```

The DNAT decision is *stored in the tuple pair*: forward packets matching tuple 1 get rewritten toward `10.244.7.42`; replies matching tuple 2 get un-rewritten to look like they came from the ClusterIP. The lifecycle in full:

```text
first SYN ──▶ NEW (rule walk runs, DNAT chosen, entry created)
                │  SYN/ACK returns
                ▼
          ESTABLISHED [ASSURED]      idle timeout: 432000 s (5 days)
                │  FIN exchange                    (nf_conntrack_tcp_timeout_established)
                ▼
          TIME_WAIT ──▶ entry expires ──▶ tuple reusable
```

Two numbers in that diagram bite people. The **5-day established timeout** means a silent-but-alive connection stays translated essentially forever — but any *middlebox on the path* (the appliance, typically) times out far sooner, which is the mismatch behind [Long-Lived Connections](/networking/long-lived-connections/). And the number in column 3 of `conntrack -L` output is the entry's **remaining TTL in seconds**, counting down and reset by traffic — a live diagnostic in itself.

### Table exhaustion: the intermittent-failure signature

The table is finite (`nf_conntrack_max`). When full, the kernel **cannot create the entry for a new connection — so it drops the packet**. The client sees a SYN timeout and retries; if the retry wins a slot, it works. The result is the classic pathology: **a fraction of new connections hang for 1–3 s or fail outright, while established connections are perfectly healthy** — because established flows already own entries.

```console
# node-side evidence (platform ask):
$ conntrack -S | head -4
cpu=0  found=81243 invalid=12 insert=190232 insert_failed=1421 drop=1421 ...
$ dmesg | grep conntrack
nf_conntrack: nf_conntrack: table full, dropping packet
```

`insert_failed`/`drop` climbing is the smoking gun. Causes worth naming:

- **Genuinely high connection rates without keepalive** — every request a fresh conntrack entry, each lingering in TIME_WAIT for its timeout after the connection closes. Pooling your connections is the app-side fix that actually shrinks the table.
- **SNAT port churn** — heavy masqueraded traffic (`Cluster`-policy external flows, egress NAT) burns entries and ephemeral ports together.
- **A chatty neighbor** — the table is **per-node and shared** by every pod on it. Your app can be the victim of another team's connection storm, which is why "it only fails on nodes where X also runs" is a legitimate observation to bring to the platform team.

Sizing (`nf_conntrack_max`, hashsize, per-protocol timeouts — all documented in the [nf_conntrack sysctl reference](https://docs.kernel.org/networking/nf_conntrack-sysctl.html)) is node-level platform configuration; your lever is emitting fewer, longer-lived connections.

### UDP conntrack and DNS: the 5-second classic

DNS is UDP to a ClusterIP, so *every DNS query* takes this same DNAT path — with UDP's stateless conntrack (30 s/stream timeouts) and a known kernel race: two UDP packets from the same socket racing to *insert* a conntrack entry (A and AAAA queries, sent in parallel by glibc) can collide; one insert fails and its packet is dropped. The resolver waits its full timeout — **exactly 5 seconds by default** — then retries and succeeds. The symptom is unforgettable: sporadic requests slower by *precisely* 5.000 s. Mitigations (single-request options, NodeLocal DNSCache, TCP DNS) live in [DNS Inside the Cluster](/networking/dns/); the point here is that it's a *conntrack* bug signature, not a CoreDNS one.

### Stale entries after endpoint churn

Conntrack outlives correctness. When a pod dies, entries that DNAT to it don't vanish with it. The rollout timeline makes the race visible:

```text
t=0.0s  Deployment rolls; pod 10.244.7.42 enters Terminating
t=0.1s  EndpointSlice updated: endpoint removed
t=0.1s+ each node's kube-proxy syncs rules on its own schedule (ms..s)
        └── NEW connections stop selecting 10.244.7.42... eventually, per node
t=0.1s+ conntrack entries pointing at 10.244.7.42 REMAIN
        └── established flows keep flowing to the dying pod (correct! —
            this is what graceful drain is)
t=Xs    pod's grace period ends; process killed; netns torn down
        └── every surviving flow through those entries now targets a void
```

What happens to those surviving flows splits by protocol:

- **TCP:** the next packet reaches a dead IP; either an RST comes back (fast failure — the "reset storm" during rollouts when hundreds of pooled connections all discover their backend died) or nothing does (timeout). Modern kube-proxy deletes conntrack entries for removed TCP endpoints, but the race window is real — and *pooled* connections that already exchanged FINs cleanly still point at the old pod at the application layer. See [Long-Lived Connections](/networking/long-lived-connections/).
- **UDP** is worse: no RST, no FIN, entries expire only by idle timeout. A client hammering DNS through a stale entry can black-hole for up to 30 s. kube-proxy explicitly flushes UDP conntrack entries on endpoint deletion for exactly this reason — when it's healthy and prompt.

## 6. sessionAffinity mechanics

`sessionAffinity: ClientIP` has to be implemented by the same machinery, and each mode does it differently.

**iptables mode** uses the `recent` match — a small in-kernel list of recently seen source IPs per endpoint:

```text
# In KUBE-SVC-*, BEFORE the probability cascade — remembered clients short-circuit:
-A KUBE-SVC-FQ2RZLQ5EQ4Q22TA -m recent --name KUBE-SEP-XU5FZGGK7MCKBTGE \
    --rcheck --seconds 10800 --reap -j KUBE-SEP-XU5FZGGK7MCKBTGE
# ...probability rules follow for unremembered clients...

# In KUBE-SEP-*, the client is recorded as it's DNAT'd:
-A KUBE-SEP-XU5FZGGK7MCKBTGE -m recent --name KUBE-SEP-XU5FZGGK7MCKBTGE --set \
    -p tcp -j DNAT --to-destination 10.244.7.42:8080
```

`10800` is your Service's `timeoutSeconds`. Note the granularity: affinity is per *source IP*, per *node's* recent-list. Clients behind one SNAT (the entire office, via the appliance pool) all stick to one backend together, and a client whose traffic enters via a different node next time rolls the dice again — "sticky sessions" that are neither as sticky nor as per-client as the name implies.

**IPVS mode** sets the persistence flag on the virtual server (`ipvsadm -Ln` shows `persistent 10800`) — a purpose-built connection-template table, same per-source-IP semantics.

Remember from [ingress-nginx](/networking/ingress-nginx/): Ingress traffic bypasses the Service dataplane for the upstream hop, so Service affinity does nothing there — use the controller's cookie-based affinity instead.

## 7. externalTrafficPolicy and internalTrafficPolicy, at the rule level

[Services Deep Dive](/networking/services-deep-dive/) covers the *behavior*; here is what `Local` literally changes in the rules for NodePort/LoadBalancer traffic. Under `Cluster` (the default), external traffic walks:

```text
KUBE-EXT-FQ2RZLQ5EQ4Q22TA          # external entry point for the Service
  → KUBE-MARK-MASQ                 # mark for SNAT to the node IP
  → KUBE-SVC-FQ2RZLQ5EQ4Q22TA      # the FULL endpoint cascade — any node's pods
```

Under `Local`, the same chain becomes:

```text
KUBE-EXT-FQ2RZLQ5EQ4Q22TA
  → KUBE-SVL-FQ2RZLQ5EQ4Q22TA      # LOCAL-only cascade; no masquerade mark
```

Two deletions, two behaviors:

1. **The foreign-endpoint branches disappear.** `KUBE-SVL-*` contains `KUBE-SEP-*` entries **only for endpoints on this node**, with the probability cascade rebuilt over that subset. No local endpoints → the chain drops traffic — which is precisely why only pod-hosting nodes pass the external LB's health check, and why `Local` + a badly spread Deployment concentrates all traffic on two pods.
2. **The masquerade rule disappears.** Under `Cluster`, the SNAT to the node IP exists so that a *forwarded-to* node's reply returns via the ingress node — the asymmetric-return insurance explained in [Life of a Request](/routing/life-of-a-request/). Under `Local` there is no cross-node forward, so no SNAT is needed, and the pod sees the true client source IP. Source-IP preservation isn't a feature that was *added* — it's a rewrite that was *removed*.

`internalTrafficPolicy: Local` applies the same local-subset trick to ClusterIP traffic from in-cluster clients (`KUBE-SVI-*` chains) — useful for node-local daemons, and a quiet foot-gun otherwise: a client on a pod-less node gets nothing.

## 8. What you can actually see (and the symptom table)

Honesty check: on a platform-managed cluster, nearly every command above — `iptables-save`, `ipvsadm -Ln`, `conntrack -L`, `conntrack -S` — runs in the **node's** namespaces and needs privileges you don't have. Your windows:

- **`/proc/net/nf_conntrack` from your pod — usually absent or empty**, and that absence is itself information (conntrack accounting isn't namespaced your way; don't burn time there).
- **Per-pod `ss`** shows your connections *post-NAT as your pod sees them*, with kernel-level counters that reveal dataplane trouble without any node access:

  ```console
  $ kubectl exec deploy/checkout -- ss -tnie dst 10.96.44.7
  ESTAB 0 0  10.244.9.5:41230  10.96.44.7:80
      ... rtt:1.2/0.4 retrans:0/7 bytes_sent:48211 bytes_acked:48211 ...
  ```

  Note the destination still reads as the ClusterIP — your netns never sees the DNAT. But `retrans:0/7` (7 lifetime retransmits) on a datacenter-internal connection is loud: packets are being dropped *somewhere* the kernel can't see, and that plus a symptom row below is a hypothesis.
- **Behavioral probes**: repeated `curl -w '%{time_connect}\n'` against a ClusterIP from a debug pod turns dataplane pathologies into measurable distributions — a bimodal connect-time histogram (fast, or exactly 1s/3s SYN-retry spikes) is conntrack exhaustion wearing numbers ([Debugging Network Issues](/networking/debugging-network/)).
- **A precise platform ask.** The entire value of this article compressed: *"Please run `conntrack -S` on nodes X,Y and check `insert_failed`, and confirm kube-proxy sync latency isn't elevated"* is actionable in minutes.

Map what you *can* see to what's actually wrong:

| App-visible symptom | Likely dataplane cause | Evidence to gather / request |
|---|---|---|
| Small % of new connections hang 1–3 s, established fine | conntrack table full | `ss` shows SYN retransmits; platform: `conntrack -S` `insert_failed` |
| Sporadic calls slower by exactly 5.000 s | UDP conntrack race on DNS A/AAAA | app latency histogram spike at +5 s; see [DNS](/networking/dns/) |
| Burst of connection resets during every rollout | stale entries + pooled conns to dying pods | correlate resets with pod-delete [events](/observability/events/); [Long-Lived Connections](/networking/long-lived-connections/) |
| One replica gets 2–3× the traffic | statistical iptables spread + few long-lived conns | per-pod request counts; expected with keepalive pools |
| Works from some client pods, not others | per-node rule staleness (kube-proxy lag/wedge) | note client *node* for failures; platform: rule sync check |
| External clients: source IP is a node IP | `Cluster` policy masquerade (§7) | `kubectl get svc -o yaml` → `externalTrafficPolicy` |
| VIP works, one node blackholes NodePort | `Local` policy, no local endpoint | `kubectl get endpointslices -o wide` vs. node list |

Two of these deserve the full treatment elsewhere: the escalation path when a Service is flatly unreachable is [Service Unreachable](/troubleshooting/service-unreachable/), and the interplay between conntrack behavior and JVM connection pools — where a default `keepalive` setting decides whether you feel endpoint churn at all — is in [JVM/Kubernetes coupling](/java/jvm-kubernetes-coupling/).

The one-sentence summary to carry out of this article: **kube-proxy writes the rules, netfilter executes them, and conntrack remembers them — and each of the three fails differently.** Stale rules misroute new connections; a full conntrack table rejects them; stale conntrack entries strand old ones. Name which of the three your symptom implicates, and you're most of the way to the fix.
