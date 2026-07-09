---
title: DNS Inside the Cluster
description: How CoreDNS resolves service names, why ndots:5 makes external lookups slow, and the per-pod DNS knobs you control.
keywords:
  - can't resolve service name
  - NXDOMAIN
  - CoreDNS
  - kube-dns
  - resolv.conf
  - search domains
  - dnsPolicy
  - dnsConfig
  - every Nth request takes 5 seconds
  - FQDN
  - name resolution slow
  - netshoot dig
sidebar:
  order: 5
---

Every service call in your cluster starts with a DNS lookup, and a shocking fraction of "intermittent network issues" are actually DNS. The good news: the resolution path is completely deterministic once you've read one file — your pod's `/etc/resolv.conf`.

:::tip[Something broken right now?]
This page explains how DNS *works* from the pod's seat. If you're actively chasing a failure — `no such host`, NXDOMAIN, every Nth request stalling 5 seconds, or "it resolves in netshoot but not in my app" — jump to the symptom-first [DNS Resolution Failures](/troubleshooting/dns-failures/) playbook and come back here for the why.
:::

:::tip[Going deeper]
This article covers DNS from the pod's seat. The [Routing & DNS Deep Dive](/routing/overview/) section goes beneath: [CoreDNS itself](/routing/coredns-deep-dive/) (the Corefile, plugin chain, caching, stub domains) and [how cluster DNS integrates with corporate DNS](/routing/dns-integration/) (external-dns, naming architecture, split-horizon).
:::

:::tip[War story]
The ndots tax has a Field Note: [Chasing a DNS Timeout](/blog/chasing-a-dns-timeout/) — intermittent 2-second spikes traced through tcpdump to search-domain expansion and conntrack pressure.
:::

## The architecture in 30 seconds

**CoreDNS** runs as a Deployment (usually 2+ replicas) in `kube-system`, fronted by a ClusterIP Service (traditionally `10.96.0.10`, often named `kube-dns` for historical reasons). It answers queries for cluster names (`*.cluster.local`) from its watch of Services and pods, and **forwards everything else** to upstream resolvers (corporate DNS, cloud VPC DNS). Many clusters also run **NodeLocal DNSCache**, a per-node caching agent, in front of it.

CoreDNS itself — its Corefile, replicas, upstreams, cache settings — is platform territory. Your territory: how your pods query it, and that's where the sharp edges live.

## What kubelet writes into your pod

```bash
kubectl exec deploy/orders -- cat /etc/resolv.conf
```

```console
search myteam.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.96.0.10
options ndots:5
```

Three lines, three consequences:

1. **`nameserver`** — all lookups go to the cluster DNS Service. One resolver, no fallback.
2. **`search`** — unqualified names get these suffixes appended, in order. This is why `curl http://orders` works: the resolver tries `orders.myteam.svc.cluster.local` first and hits.
3. **`options ndots:5`** — the notorious one. A name with **fewer than 5 dots** is treated as "maybe unqualified," so the search domains are tried *before* the name itself.

## The ndots:5 latency tax

Count the dots in `api.stripe.com`. Two. Fewer than five. So a lookup from your pod does this:

```text
api.stripe.com.myteam.svc.cluster.local.  → NXDOMAIN
api.stripe.com.svc.cluster.local.         → NXDOMAIN
api.stripe.com.cluster.local.             → NXDOMAIN
api.stripe.com.                           → finally, the real answer
```

Four queries (eight, with A + AAAA in parallel) for every resolution of an external name. Under load, or when CoreDNS is briefly slow, those wasted NXDOMAIN round-trips become user-visible latency spikes and timeouts. Every experienced K8s operator has a war story about this exact behavior.

Why does Kubernetes do this? So that short names like `orders` and `orders.other-ns` resolve conveniently. The cost lands on external lookups.

**Mitigations, all within your control:**

- **The trailing-dot trick.** A name ending in `.` is *fully qualified* — search domains are skipped entirely: `api.stripe.com.` resolves in one query. Works in config files and most HTTP clients; some libraries and TLS SNI validation choke on the dot, so test it.
- **Lower ndots per pod** via `dnsConfig` (below) if your app mostly calls external names and uses FQDNs for cluster services.
- **Cache in the app.** JVM users: tune `networkaddress.cache.ttl` — see [Java observability](/java/java-observability/) for JVM-side networking behaviors.

## FQDN forms: how much name do you need?

For a Service `orders` in namespace `myteam`:

| From | Shortest working name |
|---|---|
| Same namespace | `orders` |
| Different namespace | `orders.myteam` |
| Anywhere, unambiguous | `orders.myteam.svc.cluster.local` |
| Anywhere, zero search-list queries | `orders.myteam.svc.cluster.local.` |

:::tip
In manifests, ConfigMaps, and connection strings, always write at least `service.namespace` — ideally the full `service.namespace.svc.cluster.local`. Bare service names break silently the day someone copies the config to a different namespace.
:::

Headless Services add **per-pod records**: a StatefulSet pod gets `valkey-0.valkey.myteam.svc.cluster.local`, and the headless service name itself returns *all* Ready pod IPs (see [Services deep dive](/networking/services-deep-dive/)). Regular pods also get records like `10-244-1-5.myteam.pod.cluster.local`, which you should treat as trivia — never depend on them.

Note that **only Ready pods appear in DNS** for headless services (unless the Service sets `publishNotReadyAddresses: true`, which clustered databases sometimes need for bootstrap).

## Debugging DNS from where you stand

You likely can't read CoreDNS logs or its Corefile — that's `kube-system`. But you can characterize symptoms precisely from your own pods, which is usually enough to fix your side or file a sharp ticket.

Spin up a throwaway netshoot container in your namespace (or attach one to a running pod):

```bash
kubectl run dnstest --rm -it --image=nicolaka/netshoot -- bash
# or, to test with a specific pod's exact resolv.conf and NetworkPolicy identity:
kubectl debug -it orders-6f7d8-x2k4p --image=nicolaka/netshoot --target=orders
```

Then walk the ladder:

```bash
# 1. Is the resolver reachable at all?
dig @10.96.0.10 kubernetes.default.svc.cluster.local +short
# 2. Does an internal name resolve?
dig orders.myteam.svc.cluster.local +short
# 3. Does an external name resolve, and how long does it take?
time dig api.stripe.com +short
# 4. Watch the search-domain walk explicitly:
nslookup -debug api.stripe.com 2>&1 | grep -E 'QUESTIONS|NXDOMAIN' 
```

```console
$ dig orders.myteam.svc.cluster.local +short
10.96.44.7
$ time dig api.stripe.com +short
104.18.22.171
real    0m0.014s
```

Interpreting results:

| Finding | Likely cause | Whose problem |
|---|---|---|
| Step 1 times out | NetworkPolicy blocking egress to DNS (the classic!), or CoreDNS down | Yours first — check [egress policies](/networking/network-policies/) |
| Internal resolves, external fails | CoreDNS upstream/forwarding broken | Platform (report exact names + times) |
| Everything resolves but slowly (2–5 s) | ndots walk + a slow/dropping resolver; conntrack races on UDP | Mitigate with FQDNs; report to platform |
| Resolves in netshoot pod, fails in your app | App-level: stale DNS cache, musl vs glibc quirks in Alpine, hardcoded resolver | Yours |

That 2–5 second signature deserves a note: 5 seconds is the default resolver timeout, so "every Nth request takes exactly 5 extra seconds" means one DNS packet is being dropped and retried — historically a conntrack race with parallel UDP queries. `single-request-reopen` in `dnsConfig.options` or NodeLocal DNSCache (platform) are the fixes — the [NodeLocal DNSCache deep dive](/cluster-networking/nodelocal-dnscache/) walks the conntrack race and how the per-node cache removes it.

## The knobs you own: dnsPolicy and dnsConfig

You can override DNS behavior **per pod** — no platform ticket required:

```yaml
spec:
  dnsPolicy: ClusterFirst        # the default: cluster DNS + search domains
  dnsConfig:
    options:
      - name: ndots
        value: "2"               # tame the search-walk for external-heavy apps
      - name: single-request-reopen  # work around UDP conntrack races (glibc)
```

`dnsPolicy` values worth knowing:

- **`ClusterFirst`** (default) — everything above.
- **`Default`** — inherit the *node's* resolv.conf; the pod cannot resolve cluster services. Occasionally right for egress-only batch jobs.
- **`None`** — you supply the entire resolver config in `dnsConfig` (nameservers, searches, options). Full control, full responsibility.
- **`ClusterFirstWithHostNet`** — only relevant to hostNetwork pods, which you're probably not running.

:::caution
If you set `ndots: 1`, short names like `orders` stop resolving via search domains in some resolver implementations' edge cases — always test with the exact names your app uses before rolling to prod. `ndots: 2` keeps `orders` and `orders.myteam` working while fixing the external-lookup tax for anything with 2+ dots.
:::

Full example of taking complete control for an external-heavy worker:

```yaml
spec:
  dnsPolicy: None
  dnsConfig:
    nameservers:
      - 10.96.0.10                    # still the cluster DNS — we just rewrite the options
    searches:
      - myteam.svc.cluster.local      # keep short internal names working
      - svc.cluster.local
    options:
      - name: ndots
        value: "2"
      - name: timeout
        value: "2"
      - name: attempts
        value: "3"
```

## What to hand the platform team

If your evidence points at CoreDNS itself, a great ticket includes: the exact names queried, timings from `dig` run inside a pod, whether internal vs external differ, the namespace/pod used for testing, and a timestamp window. They can correlate with CoreDNS logs and metrics you can't see. What *not* to file: "DNS is flaky" — that ticket comes back to you.

DNS is the first hop in almost every flow, which is why it's step one in the [network debugging playbook](/networking/debugging-network/).
