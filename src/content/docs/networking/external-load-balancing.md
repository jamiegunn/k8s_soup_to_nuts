---
title: External Load Balancing
description: How traffic enters cloud and on-prem clusters — LoadBalancer Services, MetalLB, F5 CIS, externalTrafficPolicy, and preserving client IPs.
keywords:
  - EXTERNAL-IP pending
  - LoadBalancer service stuck
  - north-south traffic
  - client IP lost
  - PROXY protocol
  - X-Forwarded-For
  - healthCheckNodePort
  - NodePort
  - MetalLB
  - F5 BIG-IP CIS
  - LB says all nodes down
  - static IP reservation
sidebar:
  order: 9
---

Everything inside the cluster — Services, DNS, ingress — assumes traffic is already *in*. This article is about the front door: how packets from the outside world reach a node in the first place, and why the answer differs completely between cloud and on-prem clusters even though your manifest looks identical. (For the opposite direction — how your pods reach *out* to corporate databases and the internet, and what source IP they leave as — see [Egress](/networking/egress/).)

## The universal interface: type LoadBalancer

You declare intent; something else provisions reality:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: orders-public
spec:
  type: LoadBalancer
  selector:
    app: orders
  ports:
    - port: 443
      targetPort: 8443
```

A `LoadBalancer` Service is a NodePort Service (see [Services deep dive](/networking/services-deep-dive/)) plus a request: "give me an external entry point that forwards to these node ports." Then:

```console
$ kubectl get svc orders-public
NAME            TYPE           CLUSTER-IP     EXTERNAL-IP     PORT(S)         AGE
orders-public   LoadBalancer   10.96.81.3     203.0.113.45    443:31672/TCP   2m
```

If `EXTERNAL-IP` stays `<pending>`, **nothing in the cluster is fulfilling LoadBalancer Services** — or you're not entitled to one. That's never fixable from your manifest; it's a platform team conversation. Check `kubectl describe svc orders-public` first: provisioning errors ("exceeded quota", "no available IPs in pool") appear as events.

:::note[Most apps shouldn't own an LB]
One external LB per Service is expensive and unmanageable at scale. The common pattern: the *platform team's ingress controller* owns the one LoadBalancer Service, and your app gets external traffic via an [Ingress or HTTPRoute](/networking/ingress-and-routing/). Ask for a dedicated LB only for non-HTTP protocols (databases, MQ, gRPC without an L7 path) or hard isolation requirements.
:::

## Cloud: the controller does it for you

On EKS/AKS/GKE, a cloud controller watches for LoadBalancer Services and calls cloud APIs to provision an NLB/ALB/Azure LB/GCP forwarding rule pointed at your node group. Behavior is tuned through provider-specific annotations (`service.beta.kubernetes.io/aws-load-balancer-*`, etc.) — internal vs internet-facing, TLS certs, proxy protocol. Which annotations are permitted, and whether internet-facing LBs are allowed at all, is typically policy-controlled by your platform team.

A minimal AWS example of the annotation dialect (yours will differ — check your platform team's docs):

```yaml
metadata:
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
    service.beta.kubernetes.io/aws-load-balancer-internal: "true"   # keep it off the internet
```

Watch the Service's events while the controller works:

```console
$ kubectl describe svc orders-public | tail -4
Events:
  Type    Reason                Age   From                Message
  ----    ------                ----  ----                -------
  Normal  EnsuringLoadBalancer  41s   service-controller  Ensuring load balancer
  Normal  EnsuredLoadBalancer   12s   service-controller  Ensured load balancer
```

`EnsuringLoadBalancer` with no `Ensured` after several minutes, or a `SyncLoadBalancerFailed` warning, is your evidence for the platform ticket.

## On-prem: someone must bring the IPs

Bare-metal and vSphere clusters have no cloud API. Two fulfillment patterns dominate:

**MetalLB** — runs inside the cluster and hands out external IPs from address pools the platform team configured, announcing them to the physical network via ARP (Layer 2 mode) or BGP. From your side it's invisible: create the Service, get an IP from the pool. Pool exhaustion and announcement problems are the platform failure modes. Details in [MetalLB](/controllers/metallb/).

**F5 BIG-IP via CIS** — the Container Ingress Services controller watches Kubernetes resources and programs an external F5 appliance to load-balance to node ports or (in some topologies) directly to pod IPs. Common in enterprises that already standardize on F5. You may interact with it via annotated Services, Ingress, or F5's own [CRDs](/controllers/crds-explained/) (VirtualServer/TransportServer) — whatever contract your platform team established. Details in [F5 CIS](/controllers/f5-cis/).

Either way, your manifest stays a plain `type: LoadBalancer` Service (or an Ingress); the on-prem machinery is the platform team's.

### How the VIP routes to a node (L2 vs. BGP)

Since a `LoadBalancer` Service is defined across all worker nodes in the cluster, how does the upstream physical network know *which* node to deliver the traffic to?

* **In L2 Mode**: MetalLB speaker pods run a leader election. Exactly one worker node is elected to answer ARP requests for the VIP. The upstream switch sends all traffic for the VIP to that node's MAC address.
* **In BGP Mode**: Nodes announce the VIP as a `/32` host route to the upstream routers. The routers then use ECMP (Equal-Cost Multi-Path) to load-balance connection flows across multiple nodes.

Once the packet arrives at the node's physical network interface, Kubernetes' internal proxying (`kube-proxy` or the CNI) takes over, routing it to the destination pod. The detailed mechanics of this two-hop process are in the [MetalLB Routing Guide](/controllers/metallb/#how-the-network-routes-to-a-node-l2-arp-vs-bgp-routing), and the mental model for *why one node (L2) or many (BGP)* answers — with the commands to find the chosen node — is [How MetalLB Chooses the Node](/controllers/metallb-node-selection/).

## externalTrafficPolicy: the trade you must choose

Once the external LB delivers a packet to a node port, kube-proxy takes over — and `externalTrafficPolicy` on your Service decides what happens next.

**`Cluster` (default):** every node accepts traffic and forwards it to any backend pod, cross-node if needed. To make return packets route correctly, the forwarding node **SNATs the packet — destroying the client source IP**. Your app sees a 10.x node IP.

```text
client 198.51.100.7 ──> LB ──> node A (no orders pod) ──SNAT──> node B ──> pod
                                                     pod sees src = node A's IP
```

Pros: even distribution across pods, every node is a valid LB target. Cons: no client IP, one extra hop.

**`Local`:** a node only accepts traffic if it hosts a Ready backend pod, and delivers only to local pods. No cross-node hop, **no SNAT — the client IP survives** all the way to your app.

```text
client 198.51.100.7 ──> LB ──> node B (has orders pod) ──> pod
                                                     pod sees src = 198.51.100.7
```

The costs:

- **Imbalance.** The external LB balances across *nodes*. A node with three of your pods and a node with one each receive ~50%. With small replica counts and lumpy scheduling, some pods run hot. Spread replicas with topology constraints ([high availability](/workloads/high-availability/)).
- **Health check coupling.** Nodes without your pods must fail the LB's checks — which is exactly what the **healthCheckNodePort** is for. Kubernetes allocates it automatically for `Local` Services:

```console
$ kubectl get svc orders-public -o jsonpath='{.spec.healthCheckNodePort}'
32189
```

The external LB probes `http://<node>:32189/healthz`, which answers `200` with `{"localEndpoints": 2}` on nodes running Ready backends and `503` elsewhere. If your platform team manually configures the external LB (common with F5), **they need this port number** — a mismatch here is a classic cause of "LB says all nodes down."

- **Rollout blips.** If a node's last local pod terminates before the LB notices the health check flip, connections to that node reset. Mitigate with multiple replicas per zone and sane termination grace.

Choose `Local` when your app needs real client IPs (audit, geo, per-IP rate limits) or when the extra hop's latency matters. Otherwise `Cluster` is the operationally boring default.

## Requesting specific IPs

Sometimes the external IP must be *known in advance* — firewall rules, DNS records, and change tickets all want it before the Service exists. Options, in order of preference:

- **Ask for a reservation.** Cloud: the platform team reserves a static IP and you reference it via provider annotation. MetalLB: they carve a pool or a specific address and you request it with `metallb.universe.tf/loadBalancerIPs: "10.60.5.40"` (or the pool annotation).
- **`spec.loadBalancerIP`** is deprecated and provider-dependent — avoid it in new manifests; use the provider's annotation instead.
- **Never squat.** Requesting an arbitrary IP that "seems free" works right up until MetalLB assigns it to another team's Service and ARP fights break out. IP allocation is platform-owned bookkeeping; go through them.

:::caution
Deleting and recreating a `LoadBalancer` Service usually releases and re-acquires the external IP — and with dynamic pools you may get a *different* one, silently breaking DNS and firewall rules. If an IP must be stable, get it pinned explicitly and treat the Service as delete-protected in your CI/CD.
:::

## Preserving client IPs the other ways

`externalTrafficPolicy: Local` only preserves the IP up to the *first* Kubernetes-aware hop. If traffic then flows through an ingress controller, the controller is now the client from your app's perspective. Two mechanisms carry the original IP further:

**X-Forwarded-For (HTTP only).** Each proxy appends the IP it saw. Your app reads the header — but must only trust it if every hop is trusted, since clients can forge it. Ingress controllers can be configured (platform-side) to append vs replace, and to trust the external LB's entries.

**PROXY protocol (any TCP).** The LB prefixes each connection with a small header carrying the original source IP/port. Both ends must agree: the LB sends it *and* the receiver parses it. Enable on only one side and you get instant garbage — the receiving app sees `PROXY TCP4 198.51.100.7 ...` as the first bytes of what it thinks is TLS or HTTP and resets the connection. This is a coordinated change with the platform team, always.

The practical stack in most enterprises: LB (proxy protocol or transparent) → ingress controller (terminates it, sets `X-Forwarded-For`) → your app reads the header. Confirm what your cluster's chain actually does by logging the header and the socket peer address from a test pod before you build anything on it.

## When the LB is green but traffic dies at the node

A special class of incident: the external LB dashboard shows healthy targets, yet clients time out. The packet is dying between the node's NIC and your pod — kube-proxy territory. Field-observed causes:

- **Health check port ≠ traffic port reality.** The LB probes the healthCheckNodePort (fine) but forwards to a *stale NodePort* after the Service was recreated and got a new allocation. Symptom: checks pass, traffic times out. Compare the LB's configured ports (ask platform) with `kubectl get svc -o wide` *now*.
- **`Local` policy + pod moved.** The LB's health-check interval lags pod rescheduling; a node goes backend-less for 10–30 s and resets connections. Visible as brief, node-correlated outage bursts during deploys.
- **conntrack exhaustion on the node** — new connections dropped while established ones work. You can't see node conntrack tables, but the signature (new-connection timeouts under high connection churn, existing sessions fine) is in the [debugging playbook](/networking/debugging-network/).
- **Firewall between LB and nodes** allows the health check port but not the traffic NodePort (or vice versa). Enterprise networks love this one. The evidence you can gather: from *inside* the cluster, `curl` to the node port works (ask a platform person to verify, or test via a hostNetwork-adjacent path if available); from the LB subnet it doesn't.

Your role in these: localize with the evidence you can collect (Service spec, endpoints, timestamps, whether in-cluster paths work), then hand the platform team a ticket that names the exact node port, health check port, and time window. The difference between "LB is broken" and "traffic to NodePort 31672 times out from the LB subnet while healthCheckNodePort 32189 answers" is the difference between a week and an hour.

## Pre-flight checklist for a new external Service

- [ ] Do you actually need a dedicated LB, or should this ride the shared ingress?
- [ ] `type: LoadBalancer` created and `EXTERNAL-IP` assigned (not `<pending>`)?
- [ ] `externalTrafficPolicy` chosen deliberately — and if `Local`, healthCheckNodePort communicated to whoever configures the LB?
- [ ] Client IP strategy decided (policy Local / XFF / proxy protocol) and tested end-to-end?
- [ ] Firewall openings requested for the *node* IP range and ports — not pod IPs (see [the networking model](/networking/networking-model/) for why)?
- [ ] DNS record for the external IP owned and documented?
