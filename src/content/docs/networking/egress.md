---
title: "Egress: Leaving the Cluster and the Identity You Leave As"
description: Everything about outbound traffic — why the database sees a node IP instead of your pod, the three egress-identity strategies, egress gateways as a stable SNAT passport, forward proxies, and getting a firewall rule that survives a scale-up.
keywords:
  - outbound traffic
  - source IP
  - SNAT masquerade
  - egress gateway
  - firewall allow-list
  - database calls fail only when busy
  - HTTPS_PROXY
  - NO_PROXY
  - x509 certificate signed by unknown authority
  - SNAT port exhaustion
  - toFQDNs
  - stable static IP for whitelist
sidebar:
  order: 16
---

Almost every networking article on this site is about traffic coming *in* — ingress, LoadBalancers, Services, the front door. This one runs the other way. Your pods call corporate databases, internal APIs, license servers, and the internet, and the moment a packet crosses the cluster boundary a different set of rules applies — a different NAT, a different identity, a different team that has to allow you through a firewall. The question that organizes everything here: **when your pod talks to the outside, whose address does the outside see?** The answer is almost never "your pod's," and the gap between what you assume and what's true is a standing source of "it worked in test, the firewall blocks it in prod" tickets.

## The default: your pod is wearing the node's IP

A pod's IP (`10.244.x.y`) comes from the cluster's pod CIDR, and the outside world has **no route back to it** ([The Networking Model](/networking/networking-model/)). So on the way out, the node **masquerades** the packet — SNATs the source from the pod IP to the node's own IP — so replies have somewhere routable to return to. This is rewrite **(e)** in the [SNAT and DNAT census](/routing/nat/#e-pod-egress-masquerade--pod-ip-to-node-ip), and it fires on essentially every packet leaving the cluster.

The consequence is the entire reason this article exists:

> **The corporate database, the firewall, and the security team do not see your pod. They see a node IP** — and node IPs change as pods reschedule, so "allow the app's IP" quietly means "allow *every node in the cluster*."

You can watch your own egress identity from inside a pod, without any node access, by asking an outside echo service what source it sees:

```console
$ kubectl exec deploy/orders -- curl -s https://ifconfig.me
10.40.8.13
```

That's a **node** IP, not the pod's `10.244.x.y`. Run it again after the pod reschedules to a different node and the answer changes — which is exactly the problem a DBA hits when they pin a firewall rule to whatever single IP they saw the day they set it up. (Confirm the pod's *own* view with `kubectl exec deploy/orders -- ip -br addr` — the `10.244` address it thinks it has — and the two not matching is the masquerade, caught in one comparison.)

## The three egress identities

There are exactly three answers to "whose address does the outside see," in ascending order of stability and effort. Choosing among them is the core decision of cluster egress.

### 1. Node IP (the default) — allow every node, forever

Nothing to configure; it's what masquerade does. The cost is operational, not technical: the destination must allow-list **the entire node IP range**, and that range grows every time the cluster scales out. A firewall rule that lists today's twelve node IPs silently starts dropping traffic the day node thirteen joins and your pod lands on it.

- **Reach for it when:** the destination doesn't care about source IP (it authenticates by credential/mTLS), or the node pool is small and static and the security team is fine allow-listing the whole subnet.
- **The trap:** autoscaling. A cluster that adds nodes under load will schedule your pod onto a brand-new node IP that no firewall rule mentions — an outage that appears only at peak, only sometimes, and looks nothing like a networking problem from the app side. If you ever see "database calls fail only when we're busy," suspect a node that scaled in without a matching firewall entry.

### 2. Real pod IP — routed pod networks

If the CNI *routes* pod CIDRs into the corporate network (Calico with BGP-advertised pod ranges, or a cloud CNI where pods get VPC-native IPs), egress masquerade can be turned off and the destination sees the pod's true address. In Calico this is one field per pool:

```console
$ calicoctl patch ippool default-ipv4-ippool -p '{"spec":{"natOutgoing": false}}'
```

with the pod ranges advertised to the datacenter so return traffic is routable ([The Networking Model](/networking/networking-model/)).

- **Gain:** true end-to-end source identity — the database's own logs show which workload called it, and `ipBlock` egress policies on the far side actually mean something.
- **Cost:** the pod CIDR becomes **corporate routing-table inventory** — sized, advertised, firewalled, and never-overlapping-with-anything, forever. And it only helps toward destinations that *have* the routes; internet egress still masquerades somewhere. Pod IPs also churn constantly, so "allow this pod's IP" is no better than the node case for *pinning* a firewall rule — it's better for *observability*, worse for *stability*.
- **Who acts:** platform team (CNI) + network team (BGP/routes). Not an app-team change.

### 3. Egress gateway — a stable SNAT passport

The option people underrate. Instead of removing the SNAT, you **fix its identity**: all egress from a namespace is funneled through a dedicated gateway (a gateway pod, a labeled egress node, or a cloud NAT gateway) that owns one stable IP. Sometimes you *want* NAT — you just want a *predictable* one.

```text
        without egress gateway                 with egress gateway
   pod ──▶ node A IP ─┐                    pod ──▶ egress-gw (10.40.9.9) ──▶ DB
   pod ──▶ node B IP ─┼─▶ DB sees          pod ──▶ egress-gw (10.40.9.9) ──▶ DB
   pod ──▶ node C IP ─┘   3 changing IPs   pod ──▶ egress-gw (10.40.9.9) ──▶ DB
                                            DB sees ONE fixed IP, forever
```

This is the **"give the DB team one IP to allow"** pattern, and for authorization it inverts the census's usual framing that "SNAT is a compromise": here the rewrite is the *product*. A firewall rule for `10.40.9.9/32` that never changes beats both "allow every node" (breaks on scale-out) and "allow the pod CIDR" (routing project + re-advertise on every growth). The workload gets a fixed network passport that survives rescheduling, autoscaling, and cluster growth.

Implementations you'll meet:

- **Calico egress gateway** — a per-namespace/per-pod gateway; traffic from selected pods SNATs to the gateway's IP.
- **Cilium egress gateway** — a `CiliumEgressGatewayPolicy` selecting pods and a fixed egress IP on a chosen node.
- **A plain NAT gateway / egress node** — no fancy [CRD](/controllers/crds-explained/): route the namespace's egress through one node with a stable IP and let it masquerade. Cloud clusters often already have a managed NAT gateway with a static IP for exactly this.

:::tip[A stable SNAT is a feature, not a defeat]
The [NAT census](/routing/nat/) frames every SNAT as losing information — and it does, for *identity*. For *authorization*, an egress gateway is the correct answer, not a workaround: you trade "which pod sent this?" (which the credential already answers) for "one firewall rule that never needs a change ticket again." When a DBA asks for "the IP your app comes from," the right response is almost always to stand up an egress gateway and give them one, not to send them the node list.
:::

## When the destination is a name, not an IP: FQDN egress

Half of egress goes to things whose IP you don't control and can't pin — SaaS APIs, package registries, an S3 endpoint behind dozens of rotating addresses. Allow-listing IPs is hopeless; the answer is **FQDN-based egress policy**, where the CNI resolves the allowed *name* and programs the allow-list from the DNS answers as they change. Cilium's `toFQDNs` and Calico's DNS/domain rules both do this:

```yaml
# Cilium: allow egress only to a named destination, IPs tracked automatically
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-payments-api
spec:
  endpointSelector:
    matchLabels: {app: orders}
  egress:
    - toFQDNs:
        - matchName: "api.pay-vendor.example"
      toPorts:
        - ports:
            - {port: "443", protocol: TCP}
```

This is the egress complement to the ingress-side `ipBlock` trap in [Network Policies](/networking/network-policies/): standard Kubernetes `NetworkPolicy` egress rules can only match IP CIDRs and pod/namespace selectors — they **cannot** match a hostname, because the policy engine sees packets after DNS resolution, at L3/L4. FQDN egress is a CNI *extension* precisely to close that gap. If your security posture is "this workload may only reach these three domains," that's a CNI-specific feature to ask the platform team for, not vanilla `NetworkPolicy`.

## The corporate forward proxy: egress that must go through a chokepoint

Many enterprises don't let workloads talk to the internet directly at all — egress must traverse a **forward proxy** (Squid, Zscaler, a Blue Coat appliance) that logs, filters, and TLS-inspects every outbound request. Your pod doesn't route to the internet; it routes to the proxy, and the proxy decides. The wiring is the familiar environment variables:

```yaml
env:
  - name: HTTPS_PROXY
    value: "http://egress-proxy.corp.example:3128"
  - name: HTTP_PROXY
    value: "http://egress-proxy.corp.example:3128"
  - name: NO_PROXY
    # CRITICAL: in-cluster + link-local must bypass the proxy, or you send
    # ClusterIP and API-server traffic to a proxy that can't route it.
    value: "10.0.0.0/8,.svc,.cluster.local,169.254.169.254,localhost"
```

Two failure modes dominate here, both worth pre-empting:

- **A missing or wrong `NO_PROXY`** sends *internal* traffic — ClusterIP Services, the API server, the metadata endpoint — to the forward proxy, which has no idea what `10.96.x.y` or `orders.payments.svc` is. Symptom: in-cluster calls that used to work break the moment someone adds a proxy env var. Always exclude the pod/Service CIDRs, `.svc`/`.cluster.local`, and `169.254.169.254`.
- **TLS interception breaks certificate validation.** A TLS-inspecting proxy presents *its own* certificate, signed by a corporate CA your pod doesn't trust by default — so every HTTPS call fails with a certificate error until that CA is in the pod's trust store. That whole problem, and how to mount the corporate CA bundle, is [TLS and Corporate CAs](/networking/tls-and-corporate-cas/). If egress HTTPS started failing with `x509: certificate signed by unknown authority` right after a network change, the proxy began intercepting and you're missing its CA.

`NO_PROXY` semantics are also maddeningly inconsistent between languages (Go, Java, curl, and Python each parse it differently — trailing dots, CIDR support, and leading-dot wildcards all vary), so test the actual bypass from the actual runtime, not from `curl` in a debug shell.

## The failure that hides as everything else: SNAT port exhaustion

Egress is where SNAT **port exhaustion** bites hardest, and it's worth naming because the symptom points everywhere except the real cause. When many pods on one node hammer the *same* external `dst_ip:dst_port` through the node's single masquerade IP, conntrack runs out of unique source ports for that destination tuple and **silently drops the SYN** — no `EADDRNOTAVAIL` in the app log, just a connection that hangs and retries. The evidence lives on the node:

```console
$ conntrack -S | grep -v 'insert_failed=0'
cpu=3  found=88213 invalid=12 insert=0 insert_failed=1274 drop=1274 early_drop=0 ...
```

Climbing `insert_failed`, only on the busiest node, only toward the hottest destination, is the signature. The full mechanism — and why locally-originated sockets fail *loudly* while masqueraded traffic fails *silently* — is in the [NAT census's failure catalog](/routing/nat/#why-you-care-the-failure-catalog). The app-side fixes are the same ones that help everywhere: **pool and reuse connections** (a connection-churning egress workload manufactures this), and, for a truly hot path, an egress gateway spreads the SNAT across a dedicated IP instead of fighting every other pod for the node's port range.

## Getting the firewall rule right the first time

The recurring egress ticket is "please allow my app to reach `db.corp.example:1521`." What the network team needs from you depends entirely on which egress identity you're using — and giving them the wrong thing is the difference between an hour and a week:

| Your egress identity | What to hand the network/DB team | The trap to call out |
|---|---|---|
| Node IP (default) | the **whole node subnet**, and a heads-up that it grows on scale-out | a single node IP will break on reschedule/autoscale |
| Routed pod IPs | the **pod CIDR**, advertised via BGP | churns per-pod; good for logs, useless for pinning one rule |
| Egress gateway | the **one gateway IP** (`/32`) | none — this is why it exists; the rule never needs changing |

The single most useful sentence you can put in an egress firewall request: **"traffic will arrive from `<egress-gateway-IP>/32`, which is stable across pod rescheduling and cluster scaling."** It closes the DBA's real worry — *will this IP change and silently break?* — before they ask. Compare with the [pre-flight checklist](/networking/external-load-balancing/#pre-flight-checklist-for-a-new-external-service) on the ingress side: same principle, opposite direction — request access for the *node* range or a *stable* egress IP, never for pod IPs you don't control.

## The decision table

| I need… | Reach for | Who acts |
|---|---|---|
| A DB/firewall to allow my app by IP, permanently | **Egress gateway** — one stable `/32` | platform + network team; you request |
| The destination to log *which workload* called | Routed pod IPs (`natOutgoing: false` + BGP) | platform + network team |
| To restrict egress to a set of **domains** | CNI FQDN policy (`toFQDNs` / DNS rules) | platform team (CNI feature) |
| Internet access through the corporate chokepoint | `HTTPS_PROXY` + `NO_PROXY` + [corporate CA](/networking/tls-and-corporate-cas/) | you (pod spec) + platform |
| To stop a hot egress path dropping SYNs | connection pooling, then an egress gateway | you, then platform |
| Nothing special; dest authenticates by credential | The default node-IP masquerade | nobody — it already works |

And the honest default to write into your service's README: **decide your egress identity on purpose, once, and document the exact source address your traffic leaves as.** The expensive failure isn't the SNAT — it's a firewall rule pinned to one node IP that works for three months and then drops your traffic the first time the pod reschedules, with no code change and no obvious cause. From here, [SNAT and DNAT](/routing/nat/) is the full rewrite census this article draws rewrite (e) from, [Network Policies](/networking/network-policies/) is how you *restrict* egress rather than just identify it, and [TLS and Corporate CAs](/networking/tls-and-corporate-cas/) is the certificate half of talking to a TLS-inspecting outside world.
