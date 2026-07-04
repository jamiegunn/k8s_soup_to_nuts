---
title: Debugging the Network
description: A systematic hop-by-hop playbook for network failures — ephemeral netshoot containers, the right tools, signature symptoms, and a printable checklist.
sidebar:
  order: 10
---

Network debugging goes wrong when you test end-to-end, see a failure, and start guessing. It goes right when you decompose the path into hops and test each one independently. Every network problem in a Kubernetes cluster lives on exactly one of four paths:

```text
A. pod → pod          (the CNI fabric)
B. pod → Service      (DNS + kube-proxy/EndpointSlices, on top of A)
C. pod → external     (egress: SNAT, NetworkPolicy egress, upstream firewalls)
D. external → pod     (ingress: LB → controller → Service → pod)
```

Find which path fails, then bisect that path. This article gives you the toolkit and the signatures; [service unreachable](/troubleshooting/service-unreachable/) covers the most common instance end-to-end.

## Your debugging platform: ephemeral netshoot containers

Your app image has no curl, no dig, no tcpdump — by design. Don't rebuild it; attach a debug container that **shares the target pod's network namespace**, so everything you test uses the pod's exact IP, routes, resolv.conf, and NetworkPolicy identity:

```bash
kubectl debug -it orders-6f7d8-x2k4p --image=nicolaka/netshoot --target=orders
```

```console
Targeting container "orders". If you don't see processes from this container it may be because the container runtime doesn't support this feature.
orders-6f7d8-x2k4p:~# ip addr show eth0 | grep inet
    inet 10.244.1.5/24 brd 10.244.1.255 scope global eth0
```

Notes from the field:

- `--target` shares the process namespace too, letting you inspect the app's own sockets. Without it you still share the *network* namespace, which is the part that matters here.
- Ephemeral containers can't be removed without deleting the pod, and they don't survive pod restarts. Fine — they're disposable by nature.
- For tests where the *source* doesn't matter, a standalone throwaway is faster: `kubectl run net --rm -it --image=nicolaka/netshoot -- bash`. But remember it has default labels — NetworkPolicies will treat it differently than your app pods. When policy is a suspect, always use `kubectl debug` on a real app pod.
- If ephemeral containers are disabled by cluster policy, ask your platform team; the fallback is a netshoot sidecar in a dev deployment.
- For a quick first probe, `busybox` (~2MB, with nc/wget/nslookup) pulls in seconds where netshoot's 300MB may not — start there and escalate to netshoot when you need tcpdump or dig; the decision rule lives in [The BusyBox Toolkit](/troubleshooting/busybox/).

:::tip[Meshed namespace? Test as the app, not beside it]
In a namespace with a [service mesh](/networking/service-mesh/), mTLS makes outside-in curl lie to you — a throwaway pod without a sidecar fails (or succeeds) for reasons your app never sees. Use `kubectl debug --target` so you test from the app container's own network identity, and read the sidecar's logs alongside your app's.
:::

## The toolkit, one line each

All inside netshoot:

```bash
curl -sv --max-time 5 http://orders.myteam:80/healthz   # L7: connect + request + response, verbose
dig orders.myteam.svc.cluster.local +short              # DNS, no search-path ambiguity
dig api.stripe.com +short && time dig api.stripe.com    # external DNS + latency
cat /etc/resolv.conf                                    # what resolver config is this pod living with?
nc -zv -w 3 10.244.2.7 5432                             # L4: does this IP:port accept TCP at all?
ss -tnp                                                 # sockets currently open from this netns
traceroute -n 10.244.2.7                                # path (expect 1-3 hops in-cluster)
ping -M do -s 1400 10.244.2.7                           # MTU probe (see blackholes below)
tcpdump -ni eth0 'tcp port 5432' -c 20                  # the ground truth: are packets leaving/arriving?
```

`tcpdump` deserves emphasis: it's your only source of *truth* rather than inference. Sending SYNs and seeing no SYN-ACK? The problem is downstream of you. Not even seeing your SYNs leave? It's local (policy/eBPF drops appear as silent non-transmission on some CNIs). Seeing SYN-ACK but app still times out? Look at the app, not the network.

## The playbook

Work the numbered steps; stop at the first failure — that's your layer.

### Step 0: is it actually running?

```bash
kubectl get pods -l app=orders -o wide     # Running? Ready? Which nodes?
kubectl get endpointslices -l kubernetes.io/service-name=orders
```

**Check EndpointSlices before blaming the network.** An empty slice means no Ready backends — a readiness/selector problem wearing a network costume. This single check resolves half of all "service is unreachable" reports. Chain details in [Services deep dive](/networking/services-deep-dive/).

### Step 1: pod → pod (bypass everything)

From a debug container in a *client* pod, hit a backend **pod IP** directly:

```bash
curl -sv --max-time 5 http://10.244.2.7:8080/healthz
```

- **Works** → the network fabric is fine; move to step 2.
- **Connection refused** → packet delivered, nothing listening: wrong port, or the app binds `127.0.0.1` instead of `0.0.0.0` (check with `ss -tln` in the target pod). Not a network problem.
- **Timeout** → NetworkPolicy first (`kubectl get netpol` in *both* namespaces — see [network policies](/networking/network-policies/)), then same-node vs cross-node comparison: if same-node pods connect and cross-node don't, that's CNI/routing — platform ticket with pod names, IPs, and node names.

### Step 2: pod → Service (add DNS + kube-proxy)

```bash
dig orders.myteam.svc.cluster.local +short     # resolves to the ClusterIP?
curl -sv --max-time 5 http://orders.myteam.svc.cluster.local:80/healthz
```

- **DNS fails** → follow the DNS ladder in [DNS](/networking/dns/); if egress policies exist in your namespace, check the allow-DNS rule first.
- **DNS fine, pod-IP works, ClusterIP times out** → Service port mapping (`port` vs `targetPort`), or kube-proxy programming on that node (platform, but rare — verify the mapping three times before filing).

### Step 3: pod → external

```bash
dig api.stripe.com +short
curl -sv --max-time 10 https://api.stripe.com/healthcheck
nc -zv -w 5 203.0.113.80 5432
```

- **DNS slow (multi-second) but works** → the ndots search-walk; use FQDNs with trailing dots ([DNS](/networking/dns/)).
- **Resolves, connection times out** → egress NetworkPolicy, or an external firewall that doesn't allow the cluster's **node/egress IPs** (pod traffic is SNATed to node IPs on the way out — the firewall team needs node ranges, not pod ranges).
- **TLS handshake starts then stalls** → see MTU blackholes below.

### Step 4: external → pod

Test inbound in halves: from outside, hit the ingress/LB; from inside, hit the same Service the ingress uses.

```bash
# outside:
curl -kv https://orders.example.com/healthz --resolve orders.example.com:443:203.0.113.45
# inside:
kubectl run t --rm -it --image=nicolaka/netshoot -- curl -sv http://orders.myteam/healthz
```

Inside works, outside fails → the ingress/LB layer: `kubectl describe ingress`, then the 502/504 decision tree in [ingress and routing](/networking/ingress-and-routing/), then the LB-to-node section of [external load balancing](/networking/external-load-balancing/).

## Signature symptoms

Pattern-match these before deep-diving; each has its own fingerprint.

**MTU blackhole — "small works, large hangs."** Health checks green, `GET /ping` instant, but big JSON responses, file uploads, and TLS handshakes freeze mid-transfer. Confirm with DF-bit pings of decreasing size:

```console
$ ping -M do -s 1472 10.244.2.7
ping: local error: message too long, mtu=1450
$ ping -M do -s 1472 db.other-site.internal
(silence — packets vanish: THAT path has a blackhole)
$ ping -M do -s 1300 db.other-site.internal
1308 bytes from 10.61.4.20: icmp_seq=1 ttl=58 time=8.2 ms
```

The size where it starts working ≈ the path MTU. This is node/CNI/underlay configuration — platform ticket, with these exact numbers. Background in [the networking model](/networking/networking-model/).

**Conntrack exhaustion — "new connections fail, existing ones are fine."** Nodes track every connection in a fixed-size table; when full, new flows are dropped. Symptoms: connect timeouts that correlate with a *node* (not a pod), especially under high connection churn (an app opening a connection per request instead of pooling). You can't read `conntrack -L` without node access, but you can gather: which node the failing pods share, whether existing long-lived sessions kept working, and whether your app recently lost connection pooling. Report that; also fix the churn — it's often self-inflicted.

**Intermittent 1-in-N failures with ~5s stalls — it's DNS.** Exactly-5-second (or 2.5s) added latency on a fraction of requests is the resolver timeout+retry fingerprint: one UDP query dropped (conntrack race, lossy hop, overloaded CoreDNS). Reproduce with a loop:

```bash
for i in $(seq 1 50); do time dig api.stripe.com +short >/dev/null; done 2>&1 | grep real | sort | uniq -c | tail
```

Mitigate on your side (`single-request-reopen`, FQDNs, app-level caching — [DNS](/networking/dns/)) and report the drop rate to platform.

**Works from my netshoot pod, fails from the app** → different identity: your test pod's labels dodge the NetworkPolicies, or its resolv.conf differs. Re-test with `kubectl debug --target` *inside the failing pod* — this rule saves more wasted hours than any other in this article.

## The printable checklist

```text
□ 0  EndpointSlices non-empty? Pods Ready (not just Running)?
□ 1  Direct pod-IP curl from a debug container in a real client pod
      refused = app/port · timeout = netpol, then CNI (same-node vs cross-node)
□ 2  dig the FQDN → ClusterIP curl
      DNS fail = allow-dns egress rule / CoreDNS · svc fail = port vs targetPort
□ 3  External: dig timing (ndots) · nc to IP:port (egress netpol / firewall vs NODE IPs)
□ 4  Inbound: in-cluster curl vs outside curl → isolate ingress/LB layer
□ S  Signatures: large-hangs=MTU · new-conns-fail=conntrack · 5s-stalls=DNS
□ ★  Always test from the FAILING pod's netns: kubectl debug --target
□ ✎  Ticket = source/dest IPs+ports, node names, timestamps, tcpdump excerpt
```

A platform ticket that says "pod 10.244.1.5 (node w-14) → 10.244.7.3:5432 (node w-09): SYNs leave, no SYN-ACK returns, same-node pairs work, started 14:10 UTC" gets fixed the same day. That's the entire point of this playbook: even for the layers you don't own, you can find *where* the packet dies — and precision is leverage.
