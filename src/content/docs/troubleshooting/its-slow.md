---
title: "It's Slow, Not Down"
description: Symptom-first playbook for latency incidents — the p50/p99 four-quadrant read, then the eight causes of mystery slowness ranked by base rate, from CPU throttling to retry storms.
keywords:
  - high latency but pods healthy
  - p99 latency spike slow but green
  - cpu throttling cfs quota
  - container_cpu_cfs_throttled_periods_total
  - gc pause stop the world
  - connection pool exhaustion HikariCP pending
  - dns 5 second timeout ndots
  - conntrack table full slow requests
  - noisy neighbor node pressure
  - downstream dependency slow
  - retry amplification storm timeout budget
  - slow database query pg_stat_statements
sidebar:
  order: 9
---

**Symptom:** every dashboard is green. Pods `1/1 Running`, zero restarts, error rate flat, CPU graphs cruising at 40%. And the p99 latency alert has been screaming for twenty minutes, users are complaining, and someone in the incident channel just typed "but everything looks fine???" It's 2am.

Slowness is the hardest symptom class in Kubernetes because *nothing is broken*. There's no `CrashLoopBackOff` to describe, no error string to read literally, no red pod to point at. Every layer is doing its job — just 400ms later than it should. The triage discipline from [Triage Methodology](/troubleshooting/triage-methodology/) still applies (what changed? blast radius? cheapest test first?), but the "read the actual error" step needs a replacement, because there is no error. This page is that replacement: one confirm step that picks your branch, then eight causes ranked by how often they're actually guilty.

One ground rule before anything: **get a number, not a feeling.** "It feels slow" has burned more incident hours than any config bug. Before touching a single cause, pull the latency histogram for the affected service ([Metrics](/observability/metrics/) covers where these live and why histograms, not averages):

```promql
histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket{namespace="myteam", service="api"}[5m])) by (le))
histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{namespace="myteam", service="api"}[5m])) by (le))
```

```console
p50: 0.043   ← last Tuesday: 0.041. The median didn't move.
p99: 2.87    ← last Tuesday: 0.31. The tail is on fire.
```

Two numbers, and this pair already says something: the typical request is *fine* — some fraction of requests is hitting a wall. Everything else in this page branches off which of those two numbers moved.

:::tip[War story]
Cause #1 has a Field Note: [The Throttled App That Looked Idle](/blog/the-throttled-app-that-looked-idle/) — a week of chasing GC while CFS quota froze the p99.
:::

## The confirm step: slow for everyone, or slow for some?

This is the single highest-leverage question in latency triage, and it has two axes:

**Axis 1 — p50 vs p99.** Did the *median* move, or only the tail?

- **p50 shifted up** (say 40ms → 300ms): *every* request got slower. Something in the path of all traffic degraded — a shared dependency, saturated capacity, a code change. Smooth, systemic.
- **p99 on fire, p50 unchanged**: most requests are fine, but some fraction — 1%, 5% — hit a wall. That's a *pause* or a *stall* pattern: something intermittently freezes requests. Throttling, GC, a dropped packet, a queue.

**Axis 2 — one endpoint or all of them?** Break the same query down by route:

```promql
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket{namespace="myteam", service="api"}[5m])) by (le, path))
```

```console
{path="/api/orders"}     2.91   ← on fire
{path="/api/products"}   2.74   ← on fire
{path="/api/health"}     2.60   ← even the no-op endpoint?!
```

One endpoint slow → the problem lives in *that code path's* dependencies. All endpoints slow — especially when a trivial endpoint that touches nothing is slow too — → the problem lives in the *runtime or infrastructure* underneath all of them. (A slow `/health` that does no I/O is practically a signed confession from causes 1, 2, or 7: nothing in the handler can be slow, so the slowness is in getting the handler scheduled at all.)

**The four-quadrant read:**

| | **All endpoints** | **One endpoint** |
|---|---|---|
| **p99 only** | Runtime pauses: **CPU throttling (cause 1)**, **GC (2)**, **DNS (5)**, **conntrack (6)**, **noisy neighbor (7)** | That path's flaky dependency: **pool exhaustion (3)**, **downstream outlier (4)**, a slow query hit by some parameter values |
| **p50 shifted** | Systemic: shared **downstream slow (4)**, **retry amplification (8)**, capacity exhausted, node pressure **(7)** | Code or data change on that path: new N+1 query, cache miss storm, a deploy — back to [step 1 of triage](/troubleshooting/triage-methodology/): *what changed?* |

Thirty seconds with two PromQL queries and you've eliminated half the suspect list. The top-left quadrant — p99 fire, everything affected, p50 innocent — is the most common 2am presentation, and its top two causes account for the majority of all "it's slow but green" incidents. Start there.

The deeper measurement discipline (USE for resources, RED for services, and where a profiler fits) is [Performance Analysis](/observability/performance-analysis/); this page is the incident-speed version.

## Cause 1: CPU throttling — the #1, and the one your graphs hide

If you take one thing from this page: **a container can be throttled to death while its CPU graph shows 40% usage.** This is the single most common cause of "slow but green," and the reason it survives so long in every org is that the default CPU dashboard is structurally incapable of showing it.

The mechanism: CPU limits are enforced by the CFS scheduler in 100ms accounting periods. A limit of `500m` means 50ms of CPU time per 100ms window. Your app idles, then a request arrives and it bursts — JSON parsing, a JIT compile, a GC cycle — burns its 50ms in the first 20ms of the period, and then sits **frozen for 80ms** mid-request. The 5-minute average dutifully reports ~200m of usage. Idle-looking. Meanwhile every request unlucky enough to span a throttled period eats an 80ms wall, and your p99 is a bonfire.

**Confirm — the throttle ratio** (the full query cookbook is [PromQL for Resources](/observability/promql-for-resources/)):

```promql
sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{namespace="myteam", container!=""}[5m]))
/
sum by (pod) (rate(container_cpu_cfs_periods_total{namespace="myteam", container!=""}[5m]))
```

```console
{pod="api-7d4b9c6f8-2xkqp"}   0.31
{pod="api-7d4b9c6f8-9wlmn"}   0.28
{pod="api-7d4b9c6f8-fx8dh"}   0.33
```

Sustained above ~5–10% is hurting latency. 31% during your incident window — while the usage graph shows the container "idle" at 200m of a 500m limit — *is* the incident, and that contradiction is the trap in one screenshot: **usage is an average, throttling is a per-period event, and averages cannot see 80ms freezes.**

No metrics handy? Read the cgroup directly from inside the pod — no tools required, `cat` on a kernel file ([Linux Inside the Pod](/troubleshooting/linux-inside-the-pod/) has the whole /sys tour):

```bash
kubectl -n myteam exec api-7d4b9c6f8-2xkqp -- cat /sys/fs/cgroup/cpu.stat
```

```console
nr_periods 184032
nr_throttled 9217
throttled_usec 460850000
```

`nr_throttled` is the count of 100ms periods in which this container wanted CPU and was frozen instead — 9,217 of them here, for a cumulative 460 seconds of enforced freeze. Read it twice, 30 seconds apart — if it's climbing *now*, your current incident is CPU starvation, full stop.

```bash
# the 30-second confirm loop
kubectl -n myteam exec api-7d4b9c6f8-2xkqp -- sh -c \
  'grep nr_throttled /sys/fs/cgroup/cpu.stat; sleep 30; grep nr_throttled /sys/fs/cgroup/cpu.stat'
```

```console
nr_throttled 9217
nr_throttled 9384      ← 167 freezes in 30 seconds. Live incident.
```

**Fix:** limits honesty. Either raise the CPU limit to what the app actually bursts to, or — the increasingly standard position — drop the CPU limit entirely and set an honest CPU *request* (requests are the scheduling contract; CPU is compressible, so no limit means "burst into idle capacity" not "starve the neighbors"). The trade-offs, your org's policy constraints, and the exact YAML are in [Requests and Limits](/tuning/requests-limits-knobs/). What you must *not* do is stare at the usage average and conclude CPU is fine.

## Cause 2: GC pauses — and the throttle wearing a GC costume

JVM (and .NET, and Go under memory pressure — but overwhelmingly JVM in practice) stop-the-world pauses produce exactly the top-left-quadrant signature: p99 spikes, all endpoints, p50 untouched, no errors.

**Confirm:** read the pause log, don't guess from heap graphs. If GC logging is on (`-Xlog:gc*:file=/tmp/gc.log` — it should always be on; the overhead argument died a decade ago):

```bash
kubectl -n myteam exec api-7d4b9c6f8-2xkqp -- grep "Pause" /tmp/gc.log | tail -5
```

```console
[2026-07-03T02:12:31.400+0000] GC(480) Pause Young (Normal) (G1 Evacuation Pause) 804M->238M(1024M) 38.114ms
[2026-07-03T02:13:19.882+0000] GC(481) Pause Young (Normal) (G1 Evacuation Pause) 809M->241M(1024M) 41.550ms
[2026-07-03T02:14:07.101+0000] GC(482) Pause Young (Normal) (G1 Evacuation Pause) 812M->240M(1024M) 640.221ms
```

Two collections at ~40ms, then the same collection, same heap numbers, at **640ms**. A young collection that does identical work sixteen times slower is not a GC-tuning problem — hold that thought for two paragraphs. Pause durations that line up with your p99 spikes, timestamp for timestamp, are a conviction either way. What "normal" looks like per collector, heap sizing inside container limits, and the fixes are all in [GC and Performance](/java/gc-and-performance/). If the metrics pipeline exports Micrometer, `jvm_gc_pause_seconds_max` gives you the same read without exec'ing into anything.

**The mandatory cross-check — throttling masquerading as GC.** Before you tune a single JVM flag: GC is CPU work, done by multiple parallel threads all at once. Inside a CPU limit, **a GC burst is exactly the kind of spike CFS throttles** — so a collection that should take 40ms gets frozen mid-sweep, repeatedly, and the log dutifully reports a 640ms pause. The GC log recorded the symptom; the *cause* was cause 1. That's what the log excerpt above actually shows: same work, same heap, sixteen times slower — the collector didn't change, its CPU ration ran out. Worse, the JVM sizes its GC thread count and default heap from what it perceives the container's CPU and memory to be, so a badly-set limit degrades GC twice over ([JVM–Kubernetes Coupling](/java/jvm-kubernetes-coupling/) is that whole story).

**So the rule: run the throttle-ratio query from cause 1 before tuning GC.**

- Throttle ratio high + long pauses → it's cause 1 wearing a costume. Fix the limit; the "GC problem" evaporates. This outcome is more common than anyone finds comfortable.
- Throttle ratio clean + long pauses → *now* it's really the collector: heap too small for the allocation rate, wrong collector for the latency target, humongous allocations. Proceed to [GC and Performance](/java/gc-and-performance/) with a clear conscience.
- Throttle ratio clean + short pauses + p99 still on fire → GC is innocent; keep walking the ranked list.

## Cause 3: connection-pool exhaustion — the ceiling with a suspiciously round number

Signature: latency is *bimodal*. Most requests fast, an unlucky slice pinned at a ceiling — and the ceiling is a round, human number like 30.0s or exactly 5.0s. Round numbers are configured; nature doesn't produce them. A p99 that equals a timeout someone typed into a YAML file is a queue, and the queue is almost always the DB connection pool.

The mechanism: every replica has a pool (HikariCP default: 10 connections). All connections busy → the next request *waits* for a free connection — silently, no error, no log — until it either gets one (slow request) or hits the checkout timeout (error, but often 30s later).

**Confirm:** HikariCP publishes the smoking gun via Micrometer:

```promql
max_over_time(hikaricp_connections_pending{namespace="myteam", pool="HikariPool-1"}[15m])
```

```console
{pod="api-7d4b9c6f8-2xkqp"}   14    ← 14 threads queued waiting for a connection
{pod="api-7d4b9c6f8-9wlmn"}   11
```

`pending > 0` sustained = threads queued for connections = pool exhaustion, proven. The companion gauges complete the picture: `hikaricp_connections_active` pinned at `hikaricp_connections_max` for the whole window means the pool is saturated, not leaking spikes. (Other stacks: `npgsql` pool waits, PgBouncer's `cl_waiting`, generic `db_pool_pending` — every serious pool exposes a pending/waiting gauge, and if yours isn't exported, that's your first prevention item.)

**Fix — and do the multiplication first:** pool size is per **replica**:

```console
10 replicas × 20 connections/pool = 200 server-side connections
PostgreSQL default max_connections = 100
→ "just raise the pool" = connection-refused outage, cluster-wide
```

So "just raise the pool" can convert your latency incident into a hard outage for every service sharing that database. The pool-vs-replica arithmetic, PgBouncer, and what the database sees are in [PostgreSQL](/stateful/postgresql/). Also check for the other classic: connections leaking (checked out, never returned on an exception path), which presents as pool exhaustion that gets steadily worse since the last deploy. And shorten the checkout timeout — a 2s fast failure beats a 30s mystery every time.

## Cause 4: downstream slowness — you're just the messenger

Your service's latency is the *sum* of everything it waits on. If the payments API or the shared database got slow, *your* p99 fires, *your* name is on the incident, and nothing in your pods is wrong.

**Confirm — trace first, grep later.** This is the cause distributed tracing was built for, and it's why the trace-first argument wins at 2am: one slow trace shows you the entire request tree with a duration on every span, and the widest span *is the answer* — no correlation guesswork, no cross-referencing four dashboards at matching timestamps. Pull three slow traces from the incident window ([Tracing](/observability/tracing/) covers where and how):

```console
GET /api/orders                                    2,340ms
 ├─ auth-service GET /verify                          12ms
 ├─ SELECT orders WHERE customer_id = $1           2,210ms   ← there it is
 └─ inventory-service GET /stock                      95ms
```

95% of the request inside one DB span ends the "whose fault is it" debate in one screenshot. No tracing? Second-best is your own app logs with per-dependency timing, and the four-quadrant read: a downstream shared by all endpoints shifts p50 everywhere; a downstream used by one path lights up only that path.

**If the wide span is the database:** the statement-level view is `pg_stat_statements` — per normalized query, how often it runs and how its time is distributed:

```sql
SELECT calls, round(mean_exec_time) AS mean_ms, round(max_exec_time) AS max_ms,
       left(query, 60) AS query
FROM pg_stat_statements ORDER BY max_exec_time DESC LIMIT 3;
```

```console
 calls  | mean_ms | max_ms | query
 184220 |       4 |   2211 | SELECT * FROM orders WHERE customer_id = $1
```

Mean 4ms, max 2.2s — the query is fine at p50 and catastrophic for certain parameter values: the missing index that only matters for the big customer, the plan that flips to a sequential scan past a table-size threshold. That mean/max split *is* your p50/p99 split, one layer down. The read-through, plus `EXPLAIN ANALYZE` on the guilty statement, is in [PostgreSQL](/stateful/postgresql/).

**If the wide span is another team's service:** hand them the trace ID and this page. Your fix in the meantime is a timeout aligned to your budget (cause 8) so their slowness degrades you gracefully instead of totally.

## Cause 5: DNS latency — the quantized delay

Signature so distinctive you can diagnose it from the histogram shape alone: latency deltas of **exactly ~2s, ~4s, or ~5s**, in steps, never in between. Real slowness is continuous; DNS retry slowness is quantized, because 5 seconds is the resolver's retry timeout — a lookup that loses one UDP packet costs exactly one timeout, two packets exactly two.

Two mechanisms, one page: the `ndots:5` search-domain walk multiplies every external-name lookup into a burst of queries (any of which can be dropped), and the classic conntrack race on parallel UDP queries eats one of them silently. If every Nth request to anything with a hostname stalls for a flat 5 seconds, this is it.

**Confirm:** time resolution directly from a pod:

```bash
kubectl -n myteam exec api-7d4b9c6f8-2xkqp -- sh -c \
  'for i in 1 2 3 4 5 6 7 8 9 10; do time getent hosts payments.partner.example.com; done 2>&1 | grep real'
```

```console
real    0m 0.02s
real    0m 0.02s
real    0m 5.02s     ← there's your p99
real    0m 0.03s
...
```

Nine instant, one at a flat 5.0s = one dropped-and-retried DNS packet, proven. And note what this does to *request* latency: the app's HTTP call to that host inherits the whole stall before a single byte moves, so a 40ms endpoint reports 5.04s — which is exactly the "some requests slow by a weirdly consistent amount" shape from the quadrant read.

**Fix:** FQDNs with a trailing dot for external names (skips the search-domain walk entirely), `ndots` lowered via the pod's `dnsConfig`, `single-request-reopen` for the glibc parallel-query race — the full knob set, the `ndots:5` mechanism, and what only the platform team can fix (NodeLocal DNSCache) are in [DNS](/networking/dns/). Cheap bonus fix: a client that caches resolutions or reuses connections stops paying the tax per-request.

## Cause 6: conntrack and dataplane pathologies — the 1-in-N pattern

Signature: **exactly one request in N is slow, and slow by a very specific amount** — usually 1s or 3s (TCP SYN retransmission timers), on connections *to* or *from* your pods, with everything else perfectly fast. Not a percentage that drifts with load; a ratio that tracks *connection* count.

The mechanism family: every Service connection is a conntrack entry and a DNAT decision on the node ([kube-proxy and the Dataplane](/routing/kube-proxy-and-the-dataplane/)). When that machinery hiccups — a SYN black-holed by a stale endpoint entry mid-rollout, a full conntrack table, a masquerade source-port collision — the packet just vanishes, the kernel retransmits on its exponential timer, and your app experiences a silent, flat 1s or 3s stall with no error anywhere.

**Confirm what you can from your seat:** the 1-in-N shape itself, plus three correlation questions:

- Does the slow fraction track *new-connection* rate rather than request rate? (Pooled clients suffer less than connection-per-request clients — a dead giveaway.)
- Did it start when a *peer* service rolled out? (Stale endpoint entries during churn.)
- Does it only hit pods on one node? `kubectl get pods -o wide` and split your latency by pod — conntrack exhaustion is per-node, so one node's pods suffering while others don't points here or at cause 7.

The node-side smoking guns are host-level reads you likely can't run yourself, so know what to *ask for*: `conntrack -S` with a climbing `insert_failed` counter, `nf_conntrack: table full, dropping packet` in dmesg, and the `nf_conntrack_count`-vs-`max` fill ratio. What each one means and the masquerade port-collision mechanism behind `insert_failed` are in [NAT](/routing/nat/); the DNAT/conntrack machinery it all hangs off is [kube-proxy and the Dataplane](/routing/kube-proxy-and-the-dataplane/).

**Fix from your side:** connection reuse — keep-alives, a pooled HTTP client — slashes new-connection rate, which shrinks your exposure to every pathology in this family at once. And if your *long-lived* connections are the victim instead (idle streams killed by some middlebox's conntrack timer, reconnect storms every N minutes), that whole genre is [Long-Lived Connections](/networking/long-lived-connections/).

## Cause 7: noisy neighbor and node pressure — slow by location

Signature: **the slow requests come from specific pods, and those pods share a node.** Your app is identical everywhere; the node it landed on isn't.

**Confirm from your seat** (you can't see other tenants' workloads, but you can see *your* pods' geography and vitals):

```bash
kubectl -n myteam get pods -l app=api -o wide     # which pods on which node?
kubectl top pods -n myteam                         # do the slow pods look different?
kubectl describe node worker-07 | grep -A6 Conditions   # MemoryPressure/DiskPressure? (if RBAC allows)
```

```promql
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket{namespace="myteam", service="api"}[5m])) by (le, pod))
```

```console
{pod="api-7d4b9c6f8-2xkqp"}   0.94    ← on worker-07
{pod="api-7d4b9c6f8-9wlmn"}   0.06    ← worker-11
{pod="api-7d4b9c6f8-fx8dh"}   0.06    ← worker-02
```

Per-pod latency broken down by pod name is the clincher: if `api-...-2xkqp` on `worker-07` has a p99 of 940ms while its siblings sit at 60ms, the pod is innocent and the node is guilty — an over-committed neighbor, node-level memory pressure pushing everything into reclaim, or a saturated disk under everyone's logs. **Fix:** short-term, `kubectl delete pod` the slow one and let it reschedule elsewhere (this is legitimate mitigation, not superstition — you're moving away from a bad neighborhood). Long-term: honest CPU *requests* (your only guaranteed slice of a contended node — [Requests and Limits](/tuning/requests-limits-knobs/)), and an escalation with the node name, the per-pod latency split, and timestamps.

## Cause 8: retry amplification — the slowness you're doing to yourself

Signature: latency *and* traffic rise together, but user demand didn't change. Or: a downstream got 20% slower and your system got 400% slower. That nonlinearity is the tell — something is multiplying.

The mechanism: timeouts misaligned across the call chain. Your client times out at 2s and retries; the server is still processing attempt #1 (its own timeout is 10s) when attempt #2 arrives; under mild slowness every real request becomes three, the extra load makes everything slower, which triggers more retries. Congestion collapse in miniature — nobody's down, everybody's drowning.

**Confirm:** compare requests *received* by the server against requests *initiated* by upstream callers during the spike — a growing gap is retries in flight. Then grep your own client config for the deadly pattern:

```yaml
# the shape that detonates: aggressive timeout + retries at a layer
# whose callee is still working on attempt #1
payments-client:
  timeout: 2s          # callee's real p99 under stress: 6s
  retries: 3           # so every slow request becomes 4 requests
  backoff: none        # arriving as fast as possible, while it's down
```

Retry count ≥ 2 with a timeout shorter than the callee's realistic worst case, at more than one layer of the stack (your code retries, *and* the HTTP library retries, *and* the mesh retries...) — multiply those together and one slow dependency triggers a self-inflicted load test.

**Fix:** the timeout budget — every hop's timeout strictly shorter than its caller's remaining budget, retries at *one* layer only, with backoff and a retry cap. The arithmetic and the worked chain are in [Timeout Budgets](/tuning/timeout-budget/). This cause is last in the ranking but first in viciousness, because it turns *any* of causes 1–7 into an outage: the underlying slowness might have been a 10% degradation, and the retry storm is what took you down.

## The flowchart, in words

The whole page compressed into the 2am read order:

```text
Get p50 + p99, per endpoint. No numbers, no triage.
│
├─ latency AND traffic climbing together, demand flat?
│    → STOP: check retries first (cause 8) — anything you do
│      that adds load makes amplification worse
│
├─ p50 shifted, ONE endpoint
│    → what changed? deploy / data / query plan — ordinary debugging,
│      back to Triage Methodology step 1
│
├─ p50 shifted, ALL endpoints
│    → shared downstream (4: trace it)
│    → capacity / node pressure (7)
│    → retry storm already running (8)
│
├─ p99 only, ONE endpoint
│    → ceiling is a round number? → pool exhaustion (3)
│    → else trace 3 slow requests (4), read the widest span
│      → DB span wide? → pg_stat_statements (4)
│
└─ p99 only, ALL endpoints              ← the classic 2am quadrant
     → throttle ratio (1)  — high? fix limits, done. ~half of all cases
     → JVM? GC log (2)     — but only convict GC if (1) was clean
     → delays quantized at 2s/5s?      → DNS (5)
     → flat 1s/3s stalls, 1-in-N conns? → dataplane (6)
     → slow pods share a node?          → noisy neighbor (7)
```

Note the order inside the last branch is the base-rate order — check the cheap, common causes before the exotic ones, exactly per [the methodology](/troubleshooting/triage-methodology/).

## The evidence bundle for escalation

Half these causes end at a boundary you can't cross — node internals, CoreDNS, another team's service, the database server. The difference between a 5-minute handoff and a ping-pong ticket is arriving with:

- **The two histograms** — p50 and p99 for the incident window plus one clean hour before, per endpoint. Screenshot or PromQL link.
- **The quadrant verdict** — one sentence: "p99 only, all endpoints, started 01:52."
- **Your eliminations** — throttle ratio value, GC log tail, pool pending gauge, three trace IDs with the wide span named. Showing what it *isn't* is what stops the "have you checked your app?" reflex.
- **The geography** — pod-to-node mapping and per-pod latency split if cause 7 is in play; the peer service's rollout timestamp if cause 6 is.
- **Timestamps in UTC** and the exact PromQL you ran, so they reproduce your view in one paste.

## Prevention: the alert that catches each cause before users do

Every cause on this page has a leading indicator that fires *before* the p99 alert:

| Cause | Alert on | Threshold to start with |
|---|---|---|
| CPU throttling | throttle ratio ([PromQL for Resources](/observability/promql-for-resources/)) | > 10% for 15m |
| GC pauses | max GC pause per window (Micrometer `jvm_gc_pause_seconds_max`) | > 500ms |
| Pool exhaustion | `hikaricp_connections_pending` | > 0 for 5m |
| Downstream slowness | per-dependency latency from your client metrics, alerted *per dependency* | p99 > its SLO |
| DNS | lookup-duration histogram (or a synthetic `getent` probe) | p99 > 1s |
| Conntrack/dataplane | platform-owned: `insert_failed` rate, conntrack fill ratio — *ask that these exist* | fill > 80% |
| Noisy neighbor | your p99 broken down by node | one node > 3× the median |
| Retry amplification | client retry-count metric; server received ÷ upstream initiated | ratio > 1.2 |

And two habits that beat any alert: keep GC logging and pool metrics on *permanently* (turning them on during the incident means your evidence starts at zero), and record your p50/p99 baseline somewhere findable — "is 180ms bad?" is unanswerable at 2am without last Tuesday's number.

## Which page next

| You're seeing | Go to |
|---|---|
| Actual errors, not slowness — 5xx from the edge | [502, 503, 504 from the Front Door](/troubleshooting/front-door-5xx/) |
| You need the measurement theory under this page | [Performance Analysis](/observability/performance-analysis/) |
| The throttle ratio convicted CPU and you need the resize | [Requests and Limits](/tuning/requests-limits-knobs/) |
| The JVM is guilty (or framed) | [GC and Performance](/java/gc-and-performance/) and [JVM–Kubernetes Coupling](/java/jvm-kubernetes-coupling/) |
| You need to align the timeout chain | [Timeout Budgets](/tuning/timeout-budget/) |
| No idea yet, need the general method | [Triage Methodology](/troubleshooting/triage-methodology/) |

"Slow but green" always means the same thing: your dashboards measure the wrong layer. The request experienced something — a frozen cgroup, a paused heap, a queued connection, a retransmitted SYN — that no green checkmark tracks. Find the number that *does* track it, and the mystery is a config change.
