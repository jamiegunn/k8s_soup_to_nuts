---
title: CoreDNS Deep Dive
description: The Corefile line by line, how cluster records are synthesized from the API watch, where your external lookups go, and the cache semantics that explain "I fixed DNS but pods still fail."
sidebar:
  order: 5
---

Every lookup your pod makes — every Service call, every outbound HTTPS request, every database connection string — terminates at the same place: a CoreDNS pod in `kube-system`. The client side of that story (resolv.conf, ndots, search domains) lives in [DNS inside the cluster](/networking/dns/). This article is the *server* side: what CoreDNS actually is, what its config means, and why it behaves the way it does when things get weird.

You almost certainly can't edit any of this — CoreDNS is platform territory. But reading the config fluently changes the quality of every DNS conversation you have with the [platform team](/operations/working-with-platform-team/), and half the "DNS is flaky" mysteries dissolve once you know what the server is doing.

## What CoreDNS is

CoreDNS is a **single Go binary** whose behavior is entirely defined by a config file called the **Corefile**. There is no monolithic feature set — instead, each *server block* in the Corefile compiles an ordered **plugin chain**, and every incoming query passes through that chain until some plugin answers it. A plugin can respond, mutate the query, or pass it along. That's the whole model. Understanding CoreDNS *is* understanding the chain.

In a cluster it runs as a plain **Deployment** (typically 2 replicas) fronted by a ClusterIP Service — named `kube-dns` for backwards compatibility, classically at `10.96.0.10`. That's the `nameserver` line kubelet writes into every pod.

```bash
kubectl get deploy,svc -n kube-system -l k8s-app=kube-dns   # if RBAC lets you peek
```

```console
NAME                      READY   UP-TO-DATE   AVAILABLE
deployment.apps/coredns   2/2     2            2

NAME               TYPE        CLUSTER-IP   PORT(S)
service/kube-dns   ClusterIP   10.96.0.10   53/UDP,53/TCP,9153/TCP
```

Why two replicas plus a PodDisruptionBudget matter more here than for almost any other workload: **DNS has no fallback in a pod.** Your resolv.conf lists exactly one nameserver. If CoreDNS is unavailable for even a few seconds — a node drain that takes both replicas, an OOM kill — *every* name resolution in the cluster stalls simultaneously, and it looks like a total network outage.

```console
$ kubectl get pdb -n kube-system coredns
NAME      MIN AVAILABLE   ALLOWED DISRUPTIONS
coredns   1               1
```

That PDB is doing more work than any other object in the cluster: it guarantees a node drain can never evict both replicas at once. Combined with anti-affinity (the replicas repel each other onto different nodes), it's the canonical example of why [high availability](/workloads/high-availability/) means "replicas *plus* a PDB *plus* spreading" and not just `replicas: 2`.

The plugin chain each query traverses, in execution order (not Corefile order — more on that below):

```text
query in → errors → cache ──hit──→ answer
                      │miss
                      ▼
                 kubernetes ──cluster.local──→ synthesize from API watch → answer
                      │not my zone
                      ▼
                   forward ──→ node's upstream resolvers → answer (and cache it)
```

## The Corefile, line by line

Here is the standard kubeadm-style Corefile, essentially what most platform-managed clusters run, with annotations. It lives in the `coredns` ConfigMap in `kube-system`.

```txt
.:53 {                       # one server block, authoritative for "." (everything), port 53
    errors                   # log query errors to stdout
    health {
       lameduck 5s           # on shutdown: report unhealthy but keep serving 5s (graceful drain)
    }
    ready                    # :8181 readiness endpoint — pod joins the Service only when plugins are up
    kubernetes cluster.local in-addr.arpa ip6.arpa {
       pods insecure         # answer pod-IP records without verifying the pod exists
       fallthrough in-addr.arpa ip6.arpa   # unmatched reverse lookups continue down the chain
       ttl 30                # TTL on synthesized cluster records
    }
    prometheus :9153         # metrics endpoint
    forward . /etc/resolv.conf {   # everything not answered above → the NODE's resolvers
       max_concurrent 1000
    }
    cache 30                 # cap cached answers (positive AND negative) at 30s
    loop                     # detect forwarding loops at startup, crash loudly if found
    reload                   # watch the Corefile, apply changes without a restart
    loadbalance              # shuffle A/AAAA record order per response
}
```

One subtlety before the walk-through: **the order plugins execute in is fixed at compile time** (a plugin ordering baked into the binary), not the order they appear in the Corefile. `cache` runs *before* `forward` at query time even though it's written below it. The Corefile just declares which plugins are active and with what settings.

Now each line, in query-execution terms:

**`errors`** ([coredns.io/plugins/errors/](https://coredns.io/plugins/errors/)) — errors encountered anywhere in the chain get logged to stdout. This, not a `log` plugin, is why per-query logging is usually off: at cluster query volumes, full query logging is a self-inflicted denial of service on the logging pipeline. When platform "enables DNS logging to debug your issue," they're temporarily adding the `log` plugin via `reload`.

**`health` / `ready`** ([health](https://coredns.io/plugins/health/), [ready](https://coredns.io/plugins/ready/)) — liveness on `:8080`, readiness on `:8181`. The `lameduck 5s` detail is quietly important: on SIGTERM, the pod fails health checks but keeps answering for 5 seconds, so queries in flight during a rolling restart don't just vanish. It's the same graceful-shutdown pattern you should be implementing in your own services.

**`kubernetes`** ([coredns.io/plugins/kubernetes/](https://coredns.io/plugins/kubernetes/)) — the heart of the whole system. This plugin **watches the API server** (Services, EndpointSlices, and — depending on mode — pods) through an informer and holds the results in memory. When a query arrives for anything under `cluster.local`, the answer is **synthesized from that in-memory state**. No zone file exists anywhere. `orders.myteam.svc.cluster.local` returns the Service's ClusterIP because the plugin looked it up in its local cache of the API, in microseconds, with zero network I/O.

The record types it synthesizes, per Service shape:

| You have | Query | Synthesized answer |
|---|---|---|
| ClusterIP Service | A/AAAA for `svc.ns.svc.cluster.local` | The ClusterIP |
| Headless Service | A/AAAA for `svc.ns.svc.cluster.local` | Every Ready endpoint IP |
| StatefulSet + headless | A for `pod-0.svc.ns.svc.cluster.local` | That pod's IP |
| Any Service with named ports | SRV for `_http._tcp.svc.ns.svc.cluster.local` | Port + target name |
| Any Service | PTR for its ClusterIP | The service name (reverse lookup) |

This is also why cluster DNS reflects Service changes within seconds: there's no zone transfer or propagation, just an informer event updating a map. When an endpoint flips to NotReady, the headless-service answer changes on the very next query.

Three sub-directives worth decoding:

- **`pods insecure`** — controls pod records like `10-244-1-5.myteam.pod.cluster.local`. `insecure` means CoreDNS answers by *parsing the IP out of the name* without checking any pod actually has that IP (legacy kube-dns compatibility). `verified` makes it check against a pod watch — more correct, but it forces CoreDNS to watch **every pod in the cluster**, which costs real memory at scale. `disabled` turns pod records off. You were told in [the DNS basics](/networking/dns/) to treat pod records as trivia; this is why — with `insecure`, they're not even real.
- **`fallthrough in-addr.arpa ip6.arpa`** — normally the `kubernetes` plugin is *authoritative*: if a name is in its zones and it has no record, that's a definitive NXDOMAIN, end of chain. `fallthrough` carves an exception for reverse lookups: PTR queries for IPs that aren't cluster IPs fall through to `forward`, so reverse DNS for corporate addresses still works.
- **`ttl 30`** — synthesized records carry a 30-second TTL. This bounds how stale a client-side cache can be about a Service IP. Remember it when tuning JVM DNS caching.

**`prometheus`** ([coredns.io/plugins/metrics/](https://coredns.io/plugins/metrics/)) — exposes the metrics on `:9153` that we'll use in the health section below.

**`forward . /etc/resolv.conf`** ([coredns.io/plugins/forward/](https://coredns.io/plugins/forward/)) — anything the `kubernetes` plugin didn't claim gets proxied upstream. And here is the corporate hand-off most people miss: `/etc/resolv.conf` is the **node's** resolv.conf, not a pod's. CoreDNS forwards external queries to whatever resolvers the node OS was provisioned with — on corporate infrastructure, the site DNS servers. **Your pod resolves `api.stripe.com` through the same corporate resolvers, proxy policies, and split-horizon views as any VM in the datacenter.** External-lookup failures are therefore frequently not Kubernetes problems at all; they're corporate DNS problems observed through a Kubernetes periscope. `forward` health-checks its upstreams and takes dead ones out of rotation; `max_concurrent 1000` sheds load rather than queueing unboundedly when upstreams stall.

**`cache 30`** ([coredns.io/plugins/cache/](https://coredns.io/plugins/cache/)) — caches responses, capping TTLs at 30 seconds. Two pools, and the second one is the trap:

- **Success cache** — positive answers, TTL capped at 30s here (plugin default cap is 3600s).
- **Denial cache** — **NXDOMAIN and NODATA answers are cached too** (plugin default cap 1800s if the Corefile didn't set one).

The denial cache is behind the classic: *"The DNS record was wrong, corporate DNS fixed it five minutes ago, my pods still can't resolve it."* The NXDOMAIN is cached — in CoreDNS, possibly in NodeLocal DNSCache, possibly again in your JVM. Each layer honors the negative TTL derived from the zone's SOA record, capped by its own config.

You can watch a cached denial from your own pod — the giveaway is the AUTHORITY section carrying the upstream zone's SOA:

```bash
kubectl exec deploy/orders -- dig newapp.company.com +noall +authority +comments
```

```console
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 41387
;; AUTHORITY SECTION:
company.com.  22  IN  SOA  ns1.company.com. hostmaster.company.com. 2026070301 ...
```

That `22` is the remaining negative TTL: this NXDOMAIN will keep being served for 22 more seconds *no matter what corporate DNS says now*. With `cache 30` the cluster-side pain is bounded at 30 seconds; on clusters running larger caps, a fixed record can stay "broken" inside the cluster for many minutes after `dig` from your laptop says it's fine. That asymmetry — laptop works, pod doesn't, no error anywhere — is almost always negative caching. Reach for a retry loop, not a redeploy.

**`loop`** ([loop](https://coredns.io/plugins/loop/)) — startup self-test: sends a probe query through the forward path and crashes the pod if it comes back to itself. This catches the infamous misconfiguration where the node's resolv.conf points at the cluster DNS (or at a local systemd-resolved stub), which would otherwise melt down as an infinite query loop. If platform ever mentions "CoreDNS is CrashLoopBackOff with a loop detected error," this is what fired.

**`reload`** ([reload](https://coredns.io/plugins/reload/)) — polls the Corefile (via the mounted ConfigMap) and hot-applies changes. Practical consequence for you: Corefile changes like adding a stub domain take effect within a couple of minutes of the ConfigMap edit, **without pod restarts**. If you asked for a change and it "isn't working," the reload interval plus ConfigMap propagation delay (up to ~2 minutes combined) is worth ruling out before reopening the ticket.

**`loadbalance`** ([loadbalance](https://coredns.io/plugins/loadbalance/)) — shuffles the order of A records in responses, so clients that naively take the first answer spread across endpoints. Relevant mostly to headless Services, where a name returns many pod IPs.

## The query walk: two lookups, two very different paths

### `app.company.com` from a pod (external name)

1. **Client side (before CoreDNS is even involved):** the name has two dots, `ndots:5` says "maybe unqualified," so your resolver walks the search list — `app.company.com.myteam.svc.cluster.local`, `.svc.cluster.local`, `.cluster.local` — before trying the bare name. Three wasted round-trips, [covered on the client side](/networking/dns/). Each of those *does* hit CoreDNS.
2. **The search-list queries:** each lands in the `kubernetes` plugin — it owns `cluster.local`, finds nothing, and answers NXDOMAIN authoritatively (~0.1 ms each, and those NXDOMAINs get denial-cached, which is fine).
3. **The real query** (`app.company.com.`): not in `cluster.local`, so the `kubernetes` plugin passes. `cache` misses. `forward` proxies it to the node's corporate resolvers.
4. **Corporate resolver** answers — recursive resolution or an authoritative internal zone. This hop is the wide one: **1–50 ms** on a good day, and subject to every failure mode of corporate DNS.
5. **`cache` stores the answer** (TTL capped at 30s). For the next 30 seconds, any pod on the cluster asking for `app.company.com` gets answered in ~0.1 ms without touching the upstream.

You can see the cache working from your seat — run the same query twice and watch the query time and the TTL:

```console
$ dig app.company.com | grep -E 'Query time|IN\s+A'
app.company.com.    30    IN    A    10.50.8.20
;; Query time: 18 msec              ← miss: paid the forward hop to corporate DNS
$ dig app.company.com | grep -E 'Query time|IN\s+A'
app.company.com.    27    IN    A    10.50.8.20
;; Query time: 0 msec               ← hit: answered from CoreDNS cache, TTL counting down
```

Latency profile: first lookup pays search-walk + upstream (tens of ms, worst case seconds if an upstream is sick); repeats within the cache window are effectively free.

### `orders.myteam.svc.cluster.local` from a pod (cluster name)

1. FQDN with 5 dots — no search walk, one query.
2. The `kubernetes` plugin owns `cluster.local`, looks up the Service in its **in-memory API-watch data**, and synthesizes the A record. No forwarding, no upstream, no disk. Sub-millisecond, every time.
3. `ttl 30` means your client may cache it for up to 30s — which is also roughly your worst-case staleness if the Service's ClusterIP ever changes (rare — ClusterIPs are stable for the life of the Service).

```console
$ dig orders.myteam.svc.cluster.local | grep -E 'Query time|IN\s+A'
orders.myteam.svc.cluster.local.    30    IN    A    10.96.44.7
;; Query time: 0 msec               ← synthesized in-memory; there is no slower case
```

This asymmetry is worth internalizing: **cluster names are answered from local memory; external names traverse a proxy chain into corporate infrastructure.** When "DNS is slow," the first diagnostic question is always *which kind of name?* — it bisects the entire system.

## Stub domains: the enterprise integration point

The default Corefile has exactly two routing decisions: `cluster.local` → API watch, everything else → node resolvers. Real enterprises usually need a third: **internal zones that must go to specific resolvers**, bypassing whatever the node's default path does. That's a **stub domain** — an additional server block:

```txt
corp.example.com:53 {
    errors
    cache 30
    forward . 10.20.0.53 10.20.1.53   # the site resolvers authoritative for corp.example.com
}
```

Each server block gets its own compiled plugin chain; CoreDNS picks the block by longest-matching zone. Queries for `*.corp.example.com` now go straight to those resolvers; everything else still follows the default block. This is *the* mechanism behind "pods need to resolve internal-only names" and one half of [split-horizon setups](/routing/dns-integration/).

You cannot add this yourself — it's a Corefile change, i.e., a [platform request](/operations/working-with-platform-team/). The ticket that gets actioned same-day looks like this:

```text
Request: stub domain in CoreDNS for corp.example.com
Zone:        corp.example.com
Resolvers:   10.20.0.53, 10.20.1.53 (site DNS, confirmed with network team)
Evidence:
  From pod (fails):    dig vault.corp.example.com        → NXDOMAIN, 12 ms
  Against target (ok): dig @10.20.0.53 vault.corp.example.com → 10.20.6.40
Impact:      orders/payments services cannot reach Vault; blocking QA env
```

Zone name, resolver IPs, one failing name proven from a pod, the same name proven against the target resolver. That's a ten-minute ConfigMap change on their side when the ticket arrives pre-proven — and `reload` means no restart is even needed.

:::note
The same server-block mechanism handles the reverse direction of split authority: corporate resolvers can't see `cluster.local` at all (those names exist only in CoreDNS's memory), which is why exposing cluster names to anything outside the cluster is a dead end — the architecture consequences are in [DNS integration](/routing/dns-integration/).
:::

## Two server-side accelerators you should know by name

### autopath — killing the ndots tax at the server

The search-domain walk is client behavior, but CoreDNS can short-circuit it. With [`autopath`](https://coredns.io/plugins/autopath/) (`autopath @kubernetes`), when CoreDNS receives `api.stripe.com.myteam.svc.cluster.local` — recognizably a search-path expansion — it doesn't return NXDOMAIN. It performs the *rest of the walk itself*, resolves `api.stripe.com`, and returns the answer (with a CNAME gluing it to the name that was asked). Your pod's four-query walk becomes **one query**.

The trade-offs, and why many platforms don't enable it: to know which namespace's search path a query implies, CoreDNS must know **which pod sent it** — which requires `pods verified`, which requires watching every pod in the cluster. Memory cost scales with cluster size, and a server answering a *different question than it was asked* is exactly the kind of cleverness that makes debugging captures confusing. It's a legitimate platform ask for external-lookup-heavy clusters, but per-pod `ndots` tuning ([your own knob](/networking/dns/)) gets you most of the win without a ticket.

### NodeLocal DNSCache — the per-node cache

NodeLocal DNSCache is a **DaemonSet** running a small caching DNS instance on every node, listening on a link-local address (`169.254.20.10`) and typically intercepting the kube-dns Service IP so pods need no reconfiguration. You can detect it from your seat:

```console
$ kubectl exec deploy/orders -- cat /etc/resolv.conf | grep nameserver
nameserver 169.254.20.10        # ← NodeLocal is in play (some setups keep 10.96.0.10 and intercept it)
```

What it changes:

- **Cache hits never leave the node.** The bulk of a busy node's query volume — including all those search-walk NXDOMAINs — is answered locally.
- **Misses go upstream over TCP**, on connections the node cache keeps open to CoreDNS.
- **The UDP conntrack race dies.** The interception uses NOTRACK rules, so pod DNS packets skip connection tracking entirely — eliminating the dropped-UDP-packet race that produces the famous "every Nth lookup takes exactly 5 seconds" signature. The conntrack mechanics behind that race are in [kube-proxy and the dataplane](/routing/kube-proxy-and-the-dataplane/).

If your pods show the 5-second signature and per-pod `single-request-reopen` isn't enough, "please evaluate NodeLocal DNSCache" is the correct platform escalation — with your timing evidence attached.

## Scaling and health: reading CoreDNS from your seat

A single CoreDNS replica comfortably handles **thousands to tens of thousands of queries per second** for cache-hit and cluster-name traffic (both are in-memory operations); forwarded external queries are bounded by upstream latency, not CoreDNS. Memory scales with cluster object count — the informer cache holds every Service (and with `pods verified`, every pod). Two replicas on a mid-size corporate cluster is normal and fine; DNS outages are almost never capacity, they're disruption (drains, OOM, upstream death).

If platform exposes CoreDNS metrics through your [metrics stack](/observability/metrics/), these are the ones that answer real questions:

| Metric | Question it answers |
|---|---|
| `coredns_dns_request_duration_seconds` | Is DNS itself slow, and on which path? (bucketed; slice by zone if labeled) |
| `coredns_cache_hits_total` vs `coredns_cache_misses_total` | Cache hit ratio — low ratio + external-heavy workload = TTLs too short or churn too high |
| `coredns_dns_responses_total{rcode="SERVFAIL"}` | Upstream/forward failures surfacing to clients |
| `coredns_forward_healthcheck_failures_total` | Are the corporate resolvers themselves flapping? |
| `coredns_forward_max_concurrent_rejects_total` | Hitting the `max_concurrent` ceiling — upstream stall causing load-shedding |
| `coredns_panics_total` | Should be zero, forever |

Two PromQL expressions worth bookmarking if you have query access:

```promql
# Cache hit ratio over 5m — healthy external-heavy clusters sit well above 0.8
sum(rate(coredns_cache_hits_total[5m]))
  / (sum(rate(coredns_cache_hits_total[5m])) + sum(rate(coredns_cache_misses_total[5m])))

# p99 DNS latency by server block — separates "CoreDNS slow" from "upstream slow"
histogram_quantile(0.99,
  sum(rate(coredns_dns_request_duration_seconds_bucket[5m])) by (le, server))
```

### The failure decoder

You usually can't see any of the above directly — but you can infer server-side state precisely from symptom shape, using nothing but [pod-side testing](/networking/debugging-network/):

| Symptom from your pods | What it means server-side | Whose problem |
|---|---|---|
| **All names fail** (cluster + external), timeouts | CoreDNS unreachable: both replicas down, or your NetworkPolicy blocks egress to it | Check your egress policy first, then platform — see [service unreachable](/troubleshooting/service-unreachable/) |
| **Only external names fail** (SERVFAIL/timeout), cluster names fine | `forward` path broken: corporate resolvers down or unreachable from nodes | Platform / corporate DNS — attach `dig` timings for both name classes |
| **Only cluster names fail**, external fine | `kubernetes` plugin can't reach the API server (rare, serious) | Platform, urgently |
| **Only a brand-new Service fails**, everything else fine | Negative cache holding an earlier NXDOMAIN, or you queried before the Service existed | Wait out the denial TTL (≤30s typical); verify with `dig +noall +authority` |
| **A recently-fixed external record still fails in pods only** | Denial/stale cache in CoreDNS or NodeLocal layer | Time-bounded; if >5 min, ask platform for cache config |
| **Intermittent exact +5s latency** | UDP conntrack race, per-node | Your `dnsConfig` mitigations; escalate for NodeLocal DNSCache |
| **Slow but successful external lookups, always** | ndots search-walk + slow upstream | Yours first (FQDNs, ndots) — [client-side fixes](/networking/dns/) |

:::tip
The single highest-value data point in any DNS ticket is the **pairing**: one cluster name and one external name, `dig`-ed from the same pod in the same minute, with timings. It bisects the plugin chain — `kubernetes` vs `forward` — in one shot.
:::

## What to ask platform for (and the evidence to staple on)

Everything in this article is a ConfigMap edit or a manifest on their side. The asks that are routinely granted when they arrive with evidence:

1. **A stub domain** for an internal zone — evidence: failing `dig` from a pod, succeeding `dig @<site-resolver>` for the same name, zone + resolver IPs.
2. **Cache TTL tuning** (e.g., explicit `denial` TTL under `cache`) — evidence: a timeline showing a corrected record staying broken in-cluster past the fix.
3. **NodeLocal DNSCache** — evidence: the 5-second-spike histogram from your app metrics, plus `dig` timing distributions from a pod.
4. **autopath** — evidence: query-volume math (external lookups × 3 wasted NXDOMAINs) and app latency data; expect pushback toward per-pod `ndots` first, which is fair.
5. **Temporary query logging** scoped to a debugging window — evidence: a reproducible failing name and a time window, so they're not drinking from the firehose.

Frame each as a question, not a config demand — [how to work with the platform team](/operations/working-with-platform-team/) covers the etiquette that gets tickets actioned.

Next up: how this in-cluster resolver and the corporate DNS estate get stitched into one coherent namespace — records, VIPs, external-dns, and split-horizon — in [DNS integration and naming architecture](/routing/dns-integration/).
