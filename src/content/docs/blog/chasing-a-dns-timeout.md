---
title: "Field Notes: Chasing a DNS Timeout"
description: Intermittent 2-second latency spikes on calls to an external API, and the trail that led through tcpdump to ndots:5, search-domain expansion, and conntrack pressure.
date: 2026-04-01
authors: editor
tags:
  - networking
  - dns
  - latency
  - debugging
excerpt: Our p99 to a payments API had a weird second mode at exactly +2 seconds. The API vendor swore they were fine — and they were. The extra two seconds lived in /etc/resolv.conf, in a line most of us had never read.
---

Every latency histogram tells a story. Ours had started telling two.

Calls from `payment-gateway` to our card processor's API — `api.pay-vendor.example`, hosted outside the cluster — normally ran 80–120ms. In early March, the p99 developed a second hump: a cluster of requests at almost exactly *base latency plus 2000ms*. Not 1900, not 2200. +2000ms, give or take jitter, on maybe 1–2% of requests.

Round numbers in latency data are never the network being slow. The network being slow gives you smears. Round numbers are **timeouts** — something waited a configured interval, gave up, retried, and succeeded. The question was what was timing out, because the vendor's own edge metrics (we made them check twice) showed nothing.

## Ruling out the app

The HTTP client's connect and TLS timings were clean on the slow requests. But the client's total-time metric included one phase that had no breakdown: name resolution. A quick test from inside a pod made the shape obvious:

```console
$ kubectl exec -it payment-gateway-6b8d44f7c9-qp2n7 -- sh -c \
    'for i in $(seq 1 50); do
       s=$(date +%s%N)
       getent hosts api.pay-vendor.example > /dev/null
       echo $(( ($(date +%s%N) - s) / 1000000 ))ms
     done | sort -n | uniq -c'
  46 1ms
   1 2ms
   2 2003ms
   1 2004ms
```

Same distribution as the app. DNS. Two questions: why does a single lookup take four-plus round trips' worth of work, and why does it sometimes lose a packet?

## Reading resolv.conf like it matters

```console
$ kubectl exec payment-gateway-6b8d44f7c9-qp2n7 -- cat /etc/resolv.conf
search payments.svc.cluster.local svc.cluster.local cluster.local internal.corp.example
nameserver 10.96.0.10
options ndots:5
```

If you've never sat with this file, `ndots:5` is the Kubernetes default and it means: *if a name has fewer than five dots, try every search domain first before trying the name as-is.* Great for making `orders-db` resolve to `orders-db.payments.svc.cluster.local`. Less great for `api.pay-vendor.example`, which has two dots and therefore gets this treatment on **every lookup**:

```text
api.pay-vendor.example.payments.svc.cluster.local  -> NXDOMAIN
api.pay-vendor.example.svc.cluster.local           -> NXDOMAIN
api.pay-vendor.example.cluster.local               -> NXDOMAIN
api.pay-vendor.example.internal.corp.example       -> NXDOMAIN
api.pay-vendor.example                             -> A record, finally
```

Five queries — ten, actually, since musl and glibc typically fire A and AAAA for each — to answer one question. On a fast day, that's a few milliseconds of NXDOMAIN theater and you never notice. But it means every external call buys ~10 lottery tickets in the "did a UDP packet get dropped" raffle, and the timeout printed on the losing ticket is resolv.conf's default: `timeout:5`... except ours showed the glibc-resolver retry at 2 seconds because the app image's resolver options set `timeout:2`. There was our round number.

## Catching the drop in the act

To see the loss rather than infer it, we ran tcpdump from an ephemeral debug container sharing the pod's network namespace ([the netshoot pattern](/networking/debugging-network/)):

```console
$ kubectl debug -it payment-gateway-6b8d44f7c9-qp2n7 \
    --image=nicolaka/netshoot --target=payment-gateway -- \
    tcpdump -ni eth0 udp port 53
```

Long minutes of query/answer pairs, and then, at the exact moment the app logged a slow request:

```text
15:42:11.284 IP 10.244.3.17.42918 > 10.96.0.10.53: A? api.pay-vendor.example.svc.cluster.local.
15:42:11.284 IP 10.244.3.17.42918 > 10.96.0.10.53: AAAA? api.pay-vendor.example.svc.cluster.local.
15:42:11.285 IP 10.96.0.10.53 > 10.244.3.17.42918: NXDomain
                    ← one answer. the AAAA answer never arrives.
15:42:13.290 IP 10.244.3.17.42918 > 10.96.0.10.53: AAAA? api.pay-vendor.example.svc.cluster.local.
```

One NXDOMAIN answer missing, one 2-second resolver retry, one p99 outlier. The platform team confirmed the other half of the story from node metrics: `conntrack` insert failures spiking on busy nodes. DNS over UDP through a service VIP means every query burns a conntrack entry; a known race in the conntrack path when two datagrams (hello, parallel A+AAAA on one socket) race an insert causes occasional drops. Our ndots-driven 10x query amplification wasn't just wasting time — it was manufacturing the very conntrack pressure that made drops likely. The failure fed itself.

## The fix, in three sizes

**Small (that afternoon):** a trailing dot. `api.pay-vendor.example.` is a fully-qualified name; the resolver skips the search list entirely. One config value changed, 10 queries became 2. If you control the hostname string, this is free.

**Medium (that week):** set ndots per-pod for workloads that mostly talk to external names. This is squarely inside an app team's authority — it's pod spec, no platform ticket needed:

```yaml
spec:
  dnsConfig:
    options:
      - name: ndots
        value: "2"
      - name: timeout
        value: "1"
      - name: attempts
        value: "3"
```

`ndots:2` keeps `orders-db.payments` short-name resolution working while treating anything with two-plus dots as absolute. The tighter timeout/attempts turns a rare drop into a 1-second blip instead of a 2-second one. (Check your short-name usage before copying this — see the [DNS deep dive](/networking/dns/) for what breaks at each ndots value.)

**Large (the platform team's, but worth asking for):** NodeLocal DNSCache, which moves pod DNS to a node-local daemon over TCP upstream, removing both the conntrack race and most of the latency. Ours had it on the roadmap; our incident writeup moved it up a quarter.

The p99 hump vanished the day the dnsConfig change shipped. Verifying was satisfyingly mechanical — same loop as day one, new distribution:

```console
$ kubectl exec -it payment-gateway-7f4c9d8b5-m3rt8 -- sh -c \
    'for i in $(seq 1 200); do ... getent hosts api.pay-vendor.example. ...'
 198 1ms
   2 2ms
```

Two hundred lookups, zero outliers. We also found, as a bonus, that our per-request lookup volume dropped enough to be visible on the cluster DNS dashboard — we'd been something like 8% of all CoreDNS traffic, mostly NXDOMAINs we generated ourselves. The platform team noticed before we told them.

:::tip
Application-level caching deserves a mention: the JVM and most HTTP clients can cache successful lookups (`networkaddress.cache.ttl` in Java's case), which shrinks how often you play the lottery at all. It doesn't fix the amplification — the unlucky lookup still pays full price — but combined with `ndots:2` it turned "1–2% of requests" into "a couple per day."
:::

## What we changed

- **Every external hostname in our config is now fully qualified with a trailing dot** where the client library tolerates it. Zero-cost, immune to search-path weirdness.
- **`dnsConfig` with `ndots:2` is in our base pod template** for services whose traffic is mostly external. It's our spec, our call — one of the few network knobs namespace tenants fully own.
- **"Read /etc/resolv.conf from inside the pod" is step one of our latency runbook.** Not the node's, not your laptop's — the pod's. Half the team had never seen `ndots:5` before this incident.
- **We alert on DNS lookup latency as its own signal**, not buried inside HTTP client totals. A histogram with a mode at your resolver's retry interval is a page we now understand on sight.
- **We keep the netshoot + `kubectl debug --target` incantation in the runbook**, pre-flighted against our RBAC. Packet captures ended the guessing in ten minutes; the preceding week of graph-staring did not.

The vendor was fine. The network was fine, mostly. The two seconds were in a file inside our own pods that nobody had ever read. Know what your `/etc/resolv.conf` says — it's three lines, and one of them is load-bearing.
