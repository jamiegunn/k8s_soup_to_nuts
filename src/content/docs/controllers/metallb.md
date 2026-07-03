---
title: MetalLB
description: How MetalLB gives type LoadBalancer Services real IPs on bare metal, L2 vs BGP modes, and the playbook for pending or unreachable external IPs.
sidebar:
  order: 5
---

On AWS or GKE, you set `type: LoadBalancer` on a Service and the cloud conjures a load balancer with a public IP. On bare metal there is no cloud to conjure anything — the Service sits there forever:

```console
$ kubectl get svc web
NAME   TYPE           CLUSTER-IP     EXTERNAL-IP   PORT(S)        AGE
web    LoadBalancer   10.96.41.203   <pending>     80:31547/TCP   6d
```

**MetalLB** is the controller that fills that gap. It watches Services of `type: LoadBalancer`, allocates an IP from a pool the platform team defined, writes it into `status.loadBalancer.ingress`, and then — the actually hard part — makes the surrounding network deliver traffic for that IP to cluster nodes. It does that in one of two modes, and which mode your cluster uses changes both the performance characteristics and how you debug it.

## L2 mode: one node answers ARP

In Layer 2 mode, MetalLB elects **one node** as the announcer for each Service IP. That node's `speaker` pod answers ARP requests (IPv4) or NDP (IPv6) for the IP, so the local network delivers all packets for that IP to that one node. From there, kube-proxy spreads traffic to the backing pods as usual.

What this means in practice:

- **It's failover, not load balancing.** All ingress traffic for one Service IP lands on a single node's NIC. Fine for most services; a real ceiling for heavy ones.
- **Failover takes seconds, not milliseconds.** If the announcing node dies, another speaker takes over and sends gratuitous ARP to update the neighbors — but clients and switches with stale ARP caches may keep sending to the dead node for a while.
- **The IP must be on the same L2 segment as the nodes.** Pool IPs come from the node subnet's spare range.

## BGP mode: real multipath

In BGP mode, every node's speaker peers with your datacenter routers and announces the Service IP with itself as next-hop. The router sees multiple equal paths and does **ECMP** — genuine load distribution across nodes, sub-second failover when a node's session drops.

Costs: the platform networking team must configure router peering, and ECMP rehashing on node changes can reset long-lived connections. BGP mode is the grown-up choice for serious traffic; L2 is the zero-network-cooperation default.

## The CRs that explain your Service's behavior

MetalLB is configured via CRs in its own namespace (typically `metallb-system`). They're platform-owned, but you can usually *read* them — and reading them answers 90% of "why did my Service get that IP / no IP":

```console
$ kubectl get ipaddresspools -n metallb-system
NAME           AUTO ASSIGN   ADDRESSES
prod-pool      true          ["10.40.8.100-10.40.8.150"]
partner-pool   false         ["10.40.9.16/28"]

$ kubectl get l2advertisements -n metallb-system
NAME       IPADDRESSPOOLS
l2-prod    ["prod-pool"]
```

- **IPAddressPool** — the ranges MetalLB may hand out. `autoAssign: false` means the pool is reserve-only: you get an IP from it only by asking for that pool explicitly.
- **L2Advertisement / BGPAdvertisement** — which pools are announced, in which mode, optionally restricted to specific nodes. A pool with *no* advertisement allocates IPs that nobody announces — the "allocated but unreachable" trap.
- **BGPPeer** (BGP mode) — the router peering sessions.

## Requesting a specific IP

Two mechanisms; prefer the annotations:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web
  annotations:
    metallb.io/address-pool: partner-pool     # allocate from this pool
    metallb.io/loadBalancerIPs: "10.40.9.20"  # this exact IP (comma-sep for dual-stack)
spec:
  type: LoadBalancer
  selector:
    app: web
  ports:
    - port: 443
      targetPort: 8443
```

The legacy `spec.loadBalancerIP` field still works in many clusters but is deprecated upstream and can't express dual-stack; new manifests should use the annotations. (Older MetalLB docs show `metallb.universe.tf/...` annotation prefixes — same annotations, old domain; current releases accept `metallb.io/`. Check which your cluster's version documents.)

If you request an IP outside any pool, or one already taken, allocation fails and the Service stays `<pending>` — with the reason in Events.

### Sharing one IP between Services

Pool IPs are scarce, and MetalLB lets multiple Services ride one IP if they opt in with a matching sharing key and don't collide on ports:

```yaml
metadata:
  annotations:
    metallb.io/allow-shared-ip: "team-a-web"   # same key on every sharing Service
```

Two Services with the same key, the same requested IP, and disjoint ports (say, `web` on 443 and `mqtt` on 8883) will be co-located on one external IP. Constraints worth knowing before you architect around it: all sharers must use the same `externalTrafficPolicy`, and with `Local` they should select the same pods — otherwise MetalLB refuses the share. It's the right answer to "we need five tiny TCP services externally but the pool has one free IP."

### Reading allocation state at a glance

```console
$ kubectl get svc -o custom-columns=\
NAME:.metadata.name,IP:.status.loadBalancer.ingress[0].ip,POOL:.metadata.annotations.metallb\.io/ip-allocated-from-pool
NAME    IP            POOL
web     10.40.8.112   prod-pool
mqtt    10.40.9.20    partner-pool
```

MetalLB stamps each Service with the pool it allocated from — the fastest way to confirm a Service landed in the pool you intended, and a nice column to keep in your incident runbooks.

## Troubleshooting

### Service stuck in `<pending>`

```console
$ kubectl describe svc web | grep -A5 Events
Events:
  Type     Reason            Message
  ----     ------            -------
  Warning  AllocationFailed  Failed to allocate IP for "team-a/web":
           no available IPs in pool "partner-pool"
```

Causes, in order of frequency: pool exhausted; requested IP/pool doesn't exist or doesn't match; pool has `autoAssign: false` and you didn't name it; MetalLB controller itself is down (no events at all appear — platform ticket). The event message names the cause almost every time; **always describe the Service before escalating.**

### IP allocated but unreachable (L2)

The IP is in `EXTERNAL-IP`, but connections time out. L2-mode checklist:

1. **Who's announcing?** MetalLB emits an event naming the node:
   ```console
   $ kubectl describe svc web | grep -i announc
   Normal  nodeAssigned  announcing from node "worker-07" (protocol "layer2")
   ```
2. **From a machine on the same subnet**, check ARP resolves to that node's MAC:
   ```console
   $ arp -n 10.40.8.112
   Address        HWtype  HWaddress           Iface
   10.40.8.112    ether   52:54:00:ab:3e:91   eth0
   ```
   No ARP answer → speaker not running on that node, or the node is on a different L2 segment than the client — platform territory either way.
3. **Stale ARP after failover** — if it broke right after a node incident, an intermediate switch may be caching the old MAC. It clears; the platform team can force it.
4. **Do endpoints exist at all?** `kubectl get endpointslices -l kubernetes.io/service-name=web` — an unreachable "LoadBalancer problem" is regularly just zero ready pods behind the Service (see [Service Unreachable](/troubleshooting/service-unreachable/)).

### externalTrafficPolicy interactions

`externalTrafficPolicy: Local` preserves client source IPs and skips the extra hop — but a node only serves traffic if it has a **local ready pod**. In L2 mode MetalLB will only announce from nodes with local endpoints; if your 2 replicas land on nodes A and B but drain to node C during a rollout, you can get momentary blackholes. With `Local`, keep enough replicas spread across nodes (topology spread constraints help — see [High Availability](/workloads/high-availability/)), and expect health-based announcement flapping to show up in Events.

`Cluster` (the default) is forgiving — any node forwards to any pod — at the cost of SNAT (you lose client IPs) and an extra hop.

:::caution[Don't burn IPs on things Ingress should carry]
Pool IPs are a finite, platform-rationed resource. HTTP(S) services generally belong behind the shared ingress ([Ingress and Routing](/networking/ingress-and-routing/)); reserve LoadBalancer IPs for non-HTTP protocols, TCP passthrough, and things with their own port semantics. Your pool requests will be received much more warmly.
:::

## Phrasing requests to the platform team

MetalLB pool/peering changes are cluster config. Requests that get actioned fast contain:

> - **What:** N additional IPs for LoadBalancer Services in namespace `team-a` (or: a dedicated pool `team-a-pool`, autoAssign=false)
> - **Protocol/ports:** TCP 5432 (Postgres wire) — not HTTP, so ingress isn't suitable
> - **Traffic profile:** ~200 conns steady, <50 Mbit/s (matters for L2 single-node ceiling; may prompt them to suggest BGP)
> - **Source networks:** partner VPN range 172.16.0.0/12 (they may need firewall/router work)
> - **Specific IP needed?** Only if an external party must allowlist it — say so and why

For the general etiquette, see [Working with the Platform Team](/operations/working-with-platform-team/). And remember the architecture note that explains all of the above: MetalLB is just another [reconcile loop](/controllers/reconciliation/) — Services in, IP allocations and network announcements out, with the evidence trail in status and Events like everything else.
