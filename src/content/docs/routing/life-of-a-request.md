---
title: Life of a Request
description: One HTTPS request traced hop by hop from a corporate laptop to a pod and back — every component named, every rewrite shown, with the evidence command at each step.
keywords:
  - packet trace hop by hop
  - F5 NetScaler appliance VIP
  - MetalLB DNAT SNAT
  - conntrack asymmetric return
  - X-Forwarded-For client IP
  - ingress-nginx upstream pod IP
  - veth pair pod netns
  - request arrives but response doesn't
  - corporate DNS CNAME chain
  - kube-proxy PREROUTING DNAT
  - east-west pod to pod trace
  - trace-anything checklist
sidebar:
  order: 2
---

This is the flagship trace of the section. One request — `GET https://orders.corp.example.com/api/v1/orders` from a corporate laptop — followed to a pod and, just as carefully, **back**. Every hop numbers the step, names the exact component doing the work, and gives the command that proves the packet got there.

The topology is the standard corporate one from [The Front Door](/architectures/front-door/):

```text
laptop → corporate DNS → F5/NetScaler VIP → MetalLB IP on a node
       → kube-proxy DNAT → ingress-nginx pod → upstream pod (your app)
```

Keep two addresses in your head throughout. The **destination** is rewritten three times before your app sees the packet. The **source** is rewritten up to twice. Neither the client nor your app ever sees the other's real address, and every mystery in this path is one of those rewrites misbehaving.

## The forward path

### Step 1 — Client DNS: whose zone is it anyway?

**Component:** the laptop's stub resolver → corporate recursive DNS servers.

The laptop asks corporate DNS for `orders.corp.example.com`. Nothing in the cluster is involved. The answer is typically a CNAME chain maintained by the network team that terminates at the appliance VIP:

```console
$ dig +noall +answer orders.corp.example.com
orders.corp.example.com.  300  IN  CNAME  orders-prod.gtm.corp.example.com.
orders-prod.gtm.corp.example.com. 30 IN A  10.20.30.40
```

`10.20.30.40` is the **F5/NetScaler VIP** — not a cluster address. Zone ownership matters when this breaks:

:::note[Two DNS worlds, zero overlap]
`*.corp.example.com` and `*.cluster.local` are resolved by entirely different infrastructures that don't know about each other. The laptop can never resolve `orders.myteam.svc.cluster.local`; a pod resolves `orders.corp.example.com` only because CoreDNS *forwards* it to corporate DNS. When the same hostname behaves differently inside vs. outside the cluster, you're looking at split-horizon between these worlds — the full wiring is in [DNS Integration](/routing/dns-integration/).
:::

- `corp.example.com` — corporate DNS team (the CNAME).
- The GTM/GSLB record — the load-balancer team (may flip between datacenters based on health).
- Nothing here is CoreDNS. Cluster DNS only exists *inside* pods — see [DNS Integration](/routing/dns-integration/) for how these zones get wired together, and [CoreDNS Deep Dive](/routing/coredns-deep-dive/) for the in-cluster resolver.

**Evidence command:** `dig +trace orders.corp.example.com` from the laptop (or any corporate host). If the A record is wrong or missing, stop — no later hop matters.

### Step 2 — TCP + TLS to the corporate VIP

**Component:** the F5/NetScaler appliance (platform/network-team territory).

The laptop opens `laptop:52144 → 10.20.30.40:443`. The appliance completes the TCP handshake *itself* — it is a full proxy, not a router. Three pieces of appliance state now govern this connection:

1. **Connection table entry** — the appliance tracks the client-side flow and will create a separate server-side flow toward the cluster.
2. **SNAT decision** — the server-side flow's source is rewritten to a **SNAT pool address** (e.g. `10.20.30.200`), so the cluster sees the appliance, not the laptop. This is rewrite number one of the source address, and it's why "log the client IP" requires `X-Forwarded-For` from the appliance onward.
3. **Monitor state** — the appliance only forwards to backends its health monitor marks up. A monitor probing the wrong port shows as "VIP resets connections" while everything in the cluster is green.

TLS may terminate here (appliance holds the cert) or pass through to ingress-nginx (SNI-based). Which one changes what the appliance can see and inject — covered in [External Load Balancing](/networking/external-load-balancing/).

The addressing after this hop, assuming SNAT:

```text
client side:  laptop:52144        → 10.20.30.40:443   (flow 1, appliance terminates)
server side:  10.20.30.200:31022  → <backend>:443     (flow 2, appliance originates)
```

Two independent TCP connections, stitched together in appliance memory. This is rewrite territory nobody in the cluster can see — which is why "the appliance says the backend reset the connection" and "the cluster never saw a packet" can both be reported honestly during the same incident, and only the appliance's connection table resolves the contradiction.

**Evidence:** from the laptop, `openssl s_client -connect 10.20.30.40:443 -servername orders.corp.example.com` — a completed handshake proves the VIP and monitor are alive. The connection table itself (`show sys connection` on F5) is a platform ask.

### Step 3 — Appliance → MetalLB IP: which node answers?

**Component:** the appliance's routing table, then a MetalLB **speaker** pod answering ARP.

The appliance's backend for this VIP is the cluster-side address — a Service of `type: LoadBalancer` whose external IP was allocated by [MetalLB](/controllers/metallb/), say `10.50.8.15`. In L2 mode, that IP belongs to no interface anywhere. Instead, **one elected node's speaker pod answers ARP** for it:

```console
$ arp -n 10.50.8.15        # from a host on the same L2 segment
10.50.8.15  ether  52:54:00:ab:12:34  # <- MAC of node worker-07's NIC
```

So the packet `10.20.30.200:31022 → 10.50.8.15:443` lands on **one specific node** (`worker-07`), chosen by leader election, not load balancing. All traffic for this Service enters the cluster through that node until failover, when MetalLB sends gratuitous ARP and a different node takes over — the seconds of blackhole during that transition are a known signature.

:::caution[The "which node" question is not academic]
Everything in step 4 — conntrack entries, kube-proxy rule state, interface counters — is **per-node**. Evidence gathered on the wrong node proves nothing, and MetalLB may re-elect between your incident and your investigation. Pin down the announcing node *for the time window of the failure* (the events below carry timestamps) before asking the platform team to look anywhere.
:::

**Evidence:** `kubectl get svc -n ingress-nginx ingress-nginx-controller -o wide` shows the EXTERNAL-IP; announcement events name the winning node:

```console
$ kubectl get events -n ingress-nginx --field-selector reason=nodeAssigned
LAST SEEN  TYPE    REASON        OBJECT                             MESSAGE
12m        Normal  nodeAssigned  service/ingress-nginx-controller   announcing from node "worker-07" with protocol "layer2"
```

(Events are ephemeral — capture them during the incident; see [Events](/observability/events/).)

### Step 4 — Node ingress: netfilter rewrites the destination

**Component:** the Linux kernel's netfilter hooks executing rules programmed by kube-proxy. **No Kubernetes process touches this packet.**

The packet enters `worker-07`'s NIC addressed to `10.50.8.15:443` — an IP the node doesn't own either. In the **PREROUTING** hook, the packet walks kube-proxy's chains (`KUBE-SERVICES` → the Service's chain → a `KUBE-SEP-*` endpoint chain) and is **DNAT'd** to a real ingress-nginx pod IP:

```text
10.20.30.200:31022 → 10.50.8.15:443      (arrives)
10.20.30.200:31022 → 10.244.3.17:443     (after DNAT to ingress-nginx pod)
```

The kernel records the rewrite in a **conntrack** entry so every subsequent packet of the flow — and the reply — is translated the same way without re-walking the rules:

```console
# on worker-07 (platform access required)
$ conntrack -L -d 10.50.8.15
tcp 6 86392 ESTABLISHED src=10.20.30.200 sport=31022 dst=10.50.8.15 dport=443 \
    src=10.244.3.17 sport=443 dst=10.20.30.200 dport=31022 [ASSURED] mark=0 use=1
```

Read that carefully: the first tuple is the packet as it arrived, the second is the *reply* the kernel expects — already pointing at the pod IP. That entry **is** the load-balancing decision, frozen for the life of the connection. The full chain walk, probability math, and conntrack lifecycle are dissected in [kube-proxy and the Dataplane](/routing/kube-proxy-and-the-dataplane/).

:::note[kube-proxy is not on this path]
Nothing in step 4 involves a running Kubernetes process. kube-proxy *programmed* these rules earlier; at packet time the work is pure kernel. "Is kube-proxy healthy?" and "are the rules on this node current?" are different questions — the second one is the one that matters here.
:::

**The possible second hop.** If the chosen ingress-nginx pod lives on a *different* node and the Service uses `externalTrafficPolicy: Cluster`, `worker-07` forwards the packet there — and must also **SNAT** the source to its own node IP, or the return packet would bypass it and arrive at the appliance from an address the appliance never talked to (asymmetric return — see the return path below). This SNAT is why ingress-nginx logs show a node IP as `$remote_addr` under `Cluster` policy. `Local` policy removes both the extra hop and the SNAT at the cost of only-nodes-with-pods accepting traffic — trade-offs in [Services Deep Dive](/networking/services-deep-dive/).

**Evidence:** `conntrack -L -d <lb-ip>` on the node (platform ask); from your side, `kubectl get endpointslices -n ingress-nginx` proves which pod IPs were DNAT candidates.

### Step 5 — Into the pod netns: the veth pair

**Component:** a **veth pair** — one end in the node's root network namespace (`vethXXXX`, plugged into the CNI bridge or routed directly), the other end appearing as `eth0` inside the ingress-nginx pod's namespace.

The DNAT'd packet is routed to `10.244.3.17`, crosses the veth, and lands in the pod netns, where an **nginx worker process** `accept()`s it off the listen socket. This is the first time since the laptop that a userspace process has touched the connection.

**Evidence:** inside the ingress controller pod (or any pod, for its own traffic):

```console
$ kubectl exec -n ingress-nginx deploy/ingress-nginx-controller -- \
    ss -tn 'sport = :443' | head -3
State  Recv-Q Send-Q Local Address:Port   Peer Address:Port
ESTAB  0      0      10.244.3.17:443      10.20.30.200:31022
```

Note the peer: the appliance's SNAT address (or the node IP, since `Cluster` policy masquerades **all** external traffic to the ingress node — cross-node or not). Never the laptop.

### Step 6 — ingress-nginx routes: host/path → a pod IP, not the Service

**Component:** nginx's virtual-server config, generated by the ingress-nginx controller from your Ingress objects.

nginx terminates TLS (if not already terminated at the appliance), reads `Host: orders.corp.example.com` and the path, and selects an upstream. The critical mechanism-level fact: **ingress-nginx does not proxy to your Service's ClusterIP.** It watches EndpointSlices and load-balances across **pod IPs directly** (Lua-managed upstreams), skipping kube-proxy for this hop entirely. Consequences — why nginx reload isn't needed on scale events, why `sessionAffinity` on your Service does nothing for Ingress traffic — are in [ingress-nginx](/networking/ingress-nginx/).

nginx opens (or reuses) an **upstream keepalive connection** from its pool:

```text
10.244.3.17:48812 → 10.244.7.42:8080     (nginx pod → your app pod, plain TCP)
```

Because of keepalive, one downstream request may ride a *pre-existing* upstream connection that is minutes old — which is why upstream connection errors can implicate a pod that was deleted long after the connection was opened. See [Long-Lived Connections](/networking/long-lived-connections/).

**Evidence:** the ingress-nginx access log names the exact pod IP chosen, per request:

```console
$ kubectl logs -n ingress-nginx deploy/ingress-nginx-controller | grep /api/v1/orders | tail -1
10.20.30.200 - - [03/Jul/2026:14:22:07 +0000] "GET /api/v1/orders HTTP/2.0" 200 1834 \
  "-" "Mozilla/5.0" 412 0.043 [myteam-orders-8080] [] 10.244.7.42:8080 1834 0.042 200 7f3a...
```

Read right to left: `10.244.7.42:8080` is the upstream pod, `0.042` its response time, `0.043` the total — the difference is nginx overhead. Cross-check the pod IP against `kubectl get pods -o wide -n myteam`; if it names a pod that no longer exists, you've caught the keepalive-to-a-dead-pod race in the act.

### Step 7 — The CNI hop: pod-to-pod across nodes

**Component:** the CNI plugin's dataplane — either an encapsulating device (VXLAN/Geneve: the packet is wrapped in a node-to-node UDP packet) or native routing (the pod CIDR is routed; the packet travels unwrapped).

`10.244.3.17 → 10.244.7.42` crosses from `worker-07` to `worker-12`. Under the flat pod-network contract ([The Networking Model](/networking/networking-model/)), no NAT happens on this hop — source and destination pod IPs survive intact, which is exactly what [NetworkPolicies](/networking/network-policies/) match against. What differs by CNI is the packaging on the wire:

```text
routed (e.g. Calico BGP):     [ IP 10.244.3.17 → 10.244.7.42 | TCP | payload ]
                              travels as-is; datacenter fabric routes pod CIDRs

encapsulated (VXLAN):         [ IP worker-07 → worker-12 | UDP 8472 |
                                VXLAN | IP 10.244.3.17 → 10.244.7.42 | TCP | payload ]
```

The encapsulating UDP port depends on the CNI (8472 for Flannel and Cilium; the IANA-standard 4789 for Calico's VXLAN). Encap steals ~50 bytes of MTU — the classic cause of "small requests fine, large POSTs hang" when something on the path drops the resulting fragmentation signals. It also changes what a node-level `tcpdump` shows (UDP between nodes, unless you decode the VXLAN) — worth knowing before you read a platform-provided capture. None of this changes the addresses your pods see.

**Evidence:** `kubectl exec` a debug pod on each node and `ping`/`curl` the pod IP directly; MTU suspicion → `tracepath <pod-ip>` from inside a pod.

### Step 8 — Your app: the SYN arrives

**Component:** your app pod's kernel (SYN queue, accept queue), then your application's `accept()`.

The packet crosses `worker-12`'s veth into your pod's netns. The kernel completes the handshake and queues the connection; your app (or its web server thread pool) accepts and reads the request. What your app observes:

- **Destination:** its own pod IP and `targetPort` — never the ClusterIP, never the LB IP, never the VIP.
- **Source:** the ingress-nginx **pod IP**. The real client exists only in `X-Forwarded-For`.
- **Protocol:** plain HTTP/1.1 (typically), even though the client spoke HTTP/2 over TLS — nginx re-originates the request on its own terms.

**Evidence:** both halves of the handoff, from inside your own pod:

```console
$ kubectl exec deploy/orders -- ss -ltn 'sport = :8080'
State   Recv-Q  Send-Q  Local Address:Port  Peer Address:Port
LISTEN  0       1024    0.0.0.0:8080        0.0.0.0:*

$ kubectl exec deploy/orders -- ss -tn 'sport = :8080' | head -3
State   Recv-Q  Send-Q  Local Address:Port  Peer Address:Port
ESTAB   0       0       10.244.7.42:8080    10.244.3.17:48812
```

The listener's `Recv-Q` (against `Send-Q`, the backlog limit) is the accept queue: if it's piling up, the kernel is answering SYNs faster than your app calls `accept()` — an app problem wearing a network costume, and where thread-pool sizing meets everything above it ([JVM/Kubernetes coupling](/java/jvm-kubernetes-coupling/)).

## The return path — traced with equal care

Responses don't "just go back." Every rewrite from the forward path must be **reversed, in reverse order, by the same state that created it**. This is where asymmetric-routing bugs live.

**Step 8′ — app → nginx.** Your app writes the response on the accepted socket: `10.244.7.42:8080 → 10.244.3.17:48812`. Pod-to-pod, no NAT to reverse; the CNI carries it back across nodes (step 7 in reverse). This is the one return hop that is symmetric by construction — the app's kernel answers on the exact five-tuple it accepted.

**Step 5′/4′ — un-DNAT at the conntrack boundary.** nginx writes the client-facing response on its downstream socket: `10.244.3.17:443 → 10.20.30.200:31022`. As this packet leaves through `worker-07`'s netfilter (and first un-SNATs on the intermediate node, if there was a cross-node hop), conntrack matches the reply tuple from step 4 and **rewrites the source back**: the appliance receives `10.50.8.15:443 → 10.20.30.200:31022` — from the LB IP it originally targeted.

This reversal is the whole reason the conntrack entry exists, and it is why **asymmetric return breaks everything**: if the reply leaves via a node that never saw the SYN, that node has no conntrack entry, cannot un-DNAT, and emits a packet from a raw pod IP (`10.244.3.17`). The appliance, which is itself a stateful full proxy, has no connection from that address and answers with RST or silence. App-visible symptom: **connection established, request sent, response never arrives, then timeout**. Classic triggers: a second default route on a node, `Local`→`Cluster` policy changes mid-flight, or MetalLB failover mid-connection. This is the signature to check in [Service Unreachable](/troubleshooting/service-unreachable/) before blaming the app.

**Step 2′ — back through the appliance.** The response **must** re-traverse the F5/NetScaler — the appliance is a full proxy holding both flows, and the SNAT in step 2 guaranteed the cluster would send replies to it. It relays the response onto the client-side flow: `10.20.30.40:443 → laptop:52144`. Appliance idle timeouts on *this* table are why long-polling connections die at suspiciously round numbers (300s) — see [Long-Lived Connections](/networking/long-lived-connections/).

**Step 1′ — none.** DNS has no return path; the client cached the answer. But when the record's TTL expires mid-session and GTM has flipped datacenters, the *next* connection goes somewhere else entirely — "it works, then fails, then works" across exactly TTL-sized windows.

:::tip[The return-path debugging rule]
When "the request arrives but the response doesn't," stop looking at forward-path components. List every stateful reversal point — intermediate-node un-SNAT, ingress-node un-DNAT (conntrack), appliance flow-stitching — and ask of each: *does the state still exist, and did the packet actually pass through the box holding it?* Ninety percent of these incidents are one of: conntrack entry expired or flushed, reply routed out a different node, or an appliance idle timeout firing between request and (slow) response.
:::

## The east–west variant: app → app inside the cluster

Same discipline, far fewer layers. Pod `checkout` calls `http://orders.myteam:8080`:

1. **Resolver:** the app's libc/JVM resolver reads `/etc/resolv.conf`, expands `orders.myteam` via the search domains, and queries **CoreDNS** at the cluster DNS ClusterIP:

   ```console
   $ kubectl exec deploy/checkout -- sh -c \
       'nslookup orders.myteam 2>&1 | tail -2'
   Name:    orders.myteam.svc.cluster.local
   Address: 10.96.44.7
   ```

   That answer is the Service ClusterIP, served from CoreDNS's watch of the API — no zone file, no corporate DNS ([DNS Inside the Cluster](/networking/dns/) for the pod-side knobs; [CoreDNS Deep Dive](/routing/coredns-deep-dive/) for the plugin chain that produced it). Note the recursion: the DNS query is itself UDP to a ClusterIP, so it undergoes its *own* conntrack DNAT to a CoreDNS pod — DNS is a request inside your request, and it can fail in all the same ways.
2. **Connect to the VIP:** `10.244.9.5:41230 → 10.96.44.7:8080`. On the **client's own node**, at the OUTPUT netfilter hook this time, kube-proxy's rules DNAT to a backend pod: `→ 10.244.7.42:8080`. Conntrack entry created; decision frozen per-connection.
3. **CNI hop** to the backend's node, unchanged addresses.
4. **Reply** un-DNATs against the same conntrack entry on the client's node; the app believes it spoke to `10.96.44.7` throughout.

No appliance, no MetalLB, no ingress — which is why east–west failures are almost always DNS, endpoints, NetworkPolicy, or conntrack, in that order of likelihood.

## The mesh variant, in one paragraph

With a sidecar mesh, steps 6–8 change shape: an iptables rule inside *each pod's own netns* (installed by the mesh's init/CNI) redirects outbound and inbound traffic through the sidecar proxy, so the "pod-to-pod" connection is actually app→local-sidecar→remote-sidecar (mTLS)→app, and the sidecar — not nginx, not kube-proxy — makes the endpoint choice from its own EndpointSlice-derived view. Your app's `ss` output shows connections to/from `127.0.0.1`-ish sidecar ports, and every evidence command in this article gains one extra layer of indirection. Details in [Service Mesh](/networking/service-mesh/).

## The trace-anything checklist

One command per hop, in order. The first one that fails localizes the problem; everything after it is noise until it's fixed.

| # | Hop | Proves it works | Who runs it |
|---|-----|-----------------|-------------|
| 1 | Corporate DNS | `dig orders.corp.example.com` → expected VIP | you, laptop |
| 2 | Appliance VIP | `openssl s_client -connect VIP:443 -servername <host>` | you, laptop |
| 3 | MetalLB → node | `kubectl get svc -o wide` (IP assigned) + MetalLB `nodeAssigned` event | you |
| 4 | kube-proxy DNAT | `conntrack -L -d <lb-ip>` on the node | platform ask |
| 5 | nginx accepted | ingress-nginx access log line for your request ID | you |
| 6 | Upstream choice | `upstream_addr` in that log line = a live pod IP | you |
| 7 | CNI reachability | `kubectl exec <client-pod> -- curl -sv http://<pod-ip>:8080/healthz` | you |
| 8 | App accepting | `kubectl exec deploy/orders -- ss -ltn` (listener + sane Recv-Q) | you |
| ′ | Return path | symptom check: connect OK + response timeout ⇒ suspect 4′/asymmetry | you → platform |

Three habits that make the checklist fast in practice:

- **Bisect, don't iterate.** Start at row 5 (the ingress log): it's the cheapest check that splits the path in half. Present in the log → the edge and node dataplane are exonerated; absent → everything after nginx is exonerated.
- **Carry a request ID.** `curl -H 'X-Request-ID: trace-$(date +%s)'` gives you a string to grep for at every layer that logs — the difference between "a request like mine" and "*my* request."
- **Timestamp everything.** MetalLB failovers, kube-proxy resyncs, and rollouts are all point-in-time events; evidence without a time window can't be correlated with any of them.

The full pod-side toolbox for rows you own is in [Debugging Network Issues](/networking/debugging-network/); the escalation playbook is [Service Unreachable](/troubleshooting/service-unreachable/).

## The whole trace on one screen

```text
 laptop        corp DNS      F5/NetScaler     worker-07 (kernel)      ingress-nginx pod     worker-12      orders pod
   │               │              │                  │                       │                  │              │
   │─(1) A? ──────▶│              │                  │                       │                  │              │
   │◀─ CNAME→VIP ──│              │                  │                       │                  │              │
   │─(2) TCP+TLS ─────────────────▶ conn table       │                       │                  │              │
   │               │              │ SNAT src→pool    │                       │                  │              │
   │               │        (3)   │──── to MetalLB IP (ARP'd by worker-07) ──▶                  │              │
   │               │              │                  │ (4) PREROUTING:       │                  │              │
   │               │              │                  │ DNAT LB-IP→nginx-pod  │                  │              │
   │               │              │                  │ conntrack entry ✓     │                  │              │
   │               │              │                  │─(5) veth → netns ────▶│ accept()         │              │
   │               │              │                  │                       │ (6) host/path →  │              │
   │               │              │                  │                       │ upstream POD IP  │              │
   │               │              │                  │                       │─(7) CNI hop ────▶│─ veth ──────▶│ (8) accept()
   │               │              │                  │                       │                  │              │ handle request
   │               │              │                  │                       │◀──── response ───│◀─────────────│ (8′)
   │               │              │                  │◀─(5′) un-DNAT via ────│                  │              │
   │               │              │                  │  conntrack (4′)       │                  │              │
   │◀─(2′) relayed on client flow │◀── src=LB-IP ────│                       │                  │              │
   │               │              │                  │                       │                  │              │
   ▼ response rendered.  Rewrites: dst ×3 forward, src ×1–2 — all reversed by the same conntrack state.
```

If you internalize one thing: **the request's identity changes at every boundary, and each change is recorded in exactly one place** — appliance connection table, node conntrack, nginx upstream pool. Trace the state, and the packet can't hide.
