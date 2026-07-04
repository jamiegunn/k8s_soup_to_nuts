---
title: The Kubernetes Networking Model
description: The pod-IP contract, how CNI plugins implement it, packet walks for same-node and cross-node traffic, and where MTU problems come from.
sidebar:
  order: 3
---

Everything in Kubernetes networking rests on one deceptively simple contract. Once you internalize it, Services, Ingress, and NetworkPolicies all make sense as layers on top. Skip it, and you'll spend incidents chasing ghosts.

## The contract

Kubernetes imposes three requirements on any cluster network:

1. **Every pod gets its own IP address.** Containers in the same pod share that IP (and can talk to each other over `localhost`).
2. **All pods can reach all pods, across all nodes, without NAT.** The IP a pod sees as its own is the IP other pods use to reach it.
3. **Agents on a node (kubelet) can reach all pods on that node.**

That's it. No port mapping, no per-host port juggling like classic Docker. Your app binds to port 8080; every replica binds to port 8080; each has a distinct IP. This is why you never think about port conflicts between pods.

The contract deliberately says nothing about *how*. That's the CNI plugin's job.

## CNI plugins: you don't pick it, but you must know it

The Container Network Interface (CNI) plugin is what actually wires a pod into the network when it starts: creates interfaces, assigns the IP, programs routes. Your platform team chose it and runs it. Common ones you'll encounter:

- **Calico** — very common on-prem. Routed (BGP) or overlay (VXLAN/IPIP) modes. Enforces NetworkPolicy.
- **Cilium** — eBPF-based; often replaces kube-proxy entirely. Enforces NetworkPolicy plus its own extended policies.
- **Flannel** — simple VXLAN overlay. **Does not enforce NetworkPolicy** on its own.
- **Cloud CNIs** (AWS VPC CNI, Azure CNI, GKE) — pods get real IPs from the cloud VPC. No overlay; cloud routing does the work.

Why you care, even without owning it:

- Whether your NetworkPolicies do anything at all depends on the CNI (see [Network Policies](/networking/network-policies/)).
- Overlay vs routed determines MTU behavior (below).
- Debugging output differs: `ip addr` inside a Cilium pod looks different from a Calico pod.

Find out which one your cluster runs — you usually can't list pods in `kube-system`, so just ask your platform team, or check if the CNI leaves fingerprints you can see:

```bash
# Node labels/annotations are often readable even with namespace-scoped RBAC
kubectl get nodes -o jsonpath='{.items[0].metadata.annotations}' | tr ',' '\n' | grep -iE 'cilium|calico|flannel'
```

```console
projectcalico.org/IPv4Address":"10.40.2.17/24"
projectcalico.org/IPv4VXLANTunnelAddr":"10.244.19.0"
```

That's Calico in VXLAN mode — overlay, so remember the MTU section below.

## Packet walk: same node

Two pods on the same node, `app` (10.244.1.5) calling `db` (10.244.1.9):

```text
app pod eth0 ──> veth pair ──> node bridge / eBPF ──> veth pair ──> db pod eth0
```

- Each pod's `eth0` is one end of a **veth pair**; the other end sits in the node's root network namespace.
- A bridge (e.g. `cni0`) or eBPF program on the node forwards between veth ends.
- No encapsulation, no NAT. Sub-millisecond. If same-node pod-to-pod fails, something is deeply wrong (usually NetworkPolicy, not the network).

## Packet walk: cross node

`app` on node A (10.244.1.5) calling `db` on node B (10.244.2.7). Two implementation families:

**Routed (Calico BGP, cloud CNIs):**

```text
app ──> veth ──> node A routing table ──> physical network ──> node B ──> veth ──> db
```

Nodes (or the cloud VPC) know "10.244.2.0/24 lives on node B" as an ordinary route. Packets travel unmodified. Full MTU available.

**Overlay (VXLAN/IPIP — Flannel, Calico VXLAN, Cilium tunnel mode):**

```text
app ──> veth ──> node A encapsulates pod packet inside a UDP packet ──> node B decapsulates ──> db
```

The pod packet becomes the payload of a node-to-node packet. The underlying network only ever sees node IPs — which is why overlays work on networks that know nothing about pod CIDRs.

Either way, the contract holds: `db` sees the source IP 10.244.1.5. No NAT between pods.

:::note[Where NAT does happen]
Pod-to-**external** traffic (out of the cluster) is typically SNATed to the node's IP — the internet can't route pod CIDRs. So your database's firewall sees node IPs, not pod IPs. When requesting firewall openings for an external dependency, ask your platform team for the node/egress IP range, not pod IPs.
:::

## MTU: the silent killer

Encapsulation costs bytes. VXLAN adds ~50 bytes of headers, so if the physical network MTU is 1500, pods must use ~1450. The CNI usually configures this correctly — until someone adds a hop that doesn't (a VPN between sites, IPsec, a cloud peering with MTU 1400).

The symptom is unmistakable once you've seen it:

- Small requests work. **Large responses hang.** TLS handshakes stall (certificates are big). `curl -v` connects, sends the request, then freezes mid-transfer.
- Health checks pass (tiny payloads), so everything looks green while real traffic dies.

This happens because oversized packets with DF set get dropped, and ICMP "fragmentation needed" replies are blocked somewhere, breaking Path MTU Discovery — a *blackhole*. You can confirm it from inside your pod:

```bash
kubectl debug -it app-6f7d8-x2k4p --image=nicolaka/netshoot --target=app
# Inside: probe with decreasing packet sizes, DF bit set
ping -M do -s 1472 db.other-ns.svc.cluster.local   # 1472 + 28 = 1500 total
ping -M do -s 1400 db.other-ns.svc.cluster.local
```

```console
$ ping -M do -s 1472 10.244.2.7
PING 10.244.2.7 1472(1500) bytes of data.
ping: local error: message too long, mtu=1450
$ ping -M do -s 1400 10.244.2.7
1408 bytes from 10.244.2.7: icmp_seq=1 ttl=62 time=0.61 ms
```

If large pings fail *between two specific points* while small ones work, take those exact numbers to your platform team. MTU fixes are node/CNI configuration — squarely their territory — but this evidence turns a week of "works for me" into a same-day fix. More symptoms and tests in [Debugging the network](/networking/debugging-network/).

## hostNetwork pods

A pod with `hostNetwork: true` skips all of the above: no veth, no pod IP — it shares the node's network namespace and IP, and binds ports directly on the node. This is how some ingress controllers and node agents run.

For application teams: you almost never want it, and most clusters block it via admission policy anyway (port conflicts, security exposure, scheduling constraints). If you think you need `hostNetwork`, you probably need a `NodePort` or `LoadBalancer` [Service](/networking/services-deep-dive/) instead — and if you genuinely do need it, that's an "ask your platform team" conversation.

One debugging note: traffic *from* a hostNetwork pod (like an ingress controller) arrives at your pod with a **node IP** as source, not a pod IP. This matters when writing NetworkPolicies that try to allow "from the ingress controller."

## Dual-stack (IPv4/IPv6)

Clusters can run dual-stack, giving pods and Services both an IPv4 and an IPv6 address. If yours does:

- `kubectl get pod -o wide` shows the primary IP; `.status.podIPs` lists both.
- Services choose families via `ipFamilyPolicy` (`SingleStack`, `PreferDualStack`, `RequireDualStack`).
- The classic bug: an app binds to `0.0.0.0` (IPv4 only) while the probe or client connects over IPv6, or vice versa. Bind to `::` with dual-stack sockets, or pin your Service to one family.

Most enterprise clusters are still IPv4-only; ask before you engineer for dual-stack.

## Orienting yourself in an unfamiliar cluster

Five commands that map the terrain from namespace-scoped access, worth running once in every new cluster:

```bash
kubectl get pods -o wide                      # pod IPs + which nodes — infer the pod CIDR
kubectl get svc kubernetes -n default         # the API server's ClusterIP — infer the service CIDR
kubectl exec deploy/orders -- cat /etc/resolv.conf   # DNS service IP and search domains
kubectl exec deploy/orders -- ip route        # default route + MTU hints from inside a pod
kubectl get nodes -o wide 2>/dev/null         # node IPs, if your RBAC allows listing nodes
```

Knowing "pods are 10.244.0.0/16, services are 10.96.0.0/12, nodes are 10.40.0.0/22" turns every packet capture and firewall conversation from guesswork into arithmetic. Write it in your team runbook.

## What this means day-to-day

- **Never hardcode pod IPs.** They change on every restart. That's what [Services](/networking/services-deep-dive/) and [DNS](/networking/dns/) are for.
- **"No route to host" between pods** is a CNI/node problem (platform ticket, with the pod names and nodes involved). **"Connection refused"** means the network delivered your packet and nothing was listening — that's yours. **Timeouts** are ambiguous: think NetworkPolicy first, then MTU, then platform.
- The flat network means **any pod can reach your pod** unless a NetworkPolicy says otherwise. Multi-tenant cluster? Read [Network Policies](/networking/network-policies/) next.
