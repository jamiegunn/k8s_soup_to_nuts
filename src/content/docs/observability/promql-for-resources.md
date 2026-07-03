---
title: PromQL for CPU and Memory
description: The working query cookbook for consumed vs requested vs limited — CPU throttling, memory-to-OOM distance, right-sizing percentiles, and restart forensics.
sidebar:
  order: 8
---

Every resource problem in Kubernetes comes down to three numbers per container: what it **consumes**, what it **requested**, and what it's **limited** to. `kubectl top` shows you one snapshot of the first number. Prometheus has all three, with history. This article is the query cookbook — the stack layers and how metrics get into Prometheus are covered in [Metrics](/observability/metrics/); requests and limits semantics live in [Resources and QoS](/workloads/resources-and-qos/).

Run everything below in Grafana Explore or the Prometheus UI. You don't need write access to anything.

## Just enough PromQL to be dangerous

**Instant vector**: one value per matching series, right now. `container_memory_working_set_bytes{namespace="myteam"}` returns the current working set of every container in your namespace.

**Range vector**: the last N of samples per series, written with `[5m]`. You can't graph a range vector directly — you feed it to a function like `rate()`.

**`rate()` and counters.** CPU usage is exported as a *counter*: `container_cpu_usage_seconds_total` is total CPU-seconds consumed since the container started. The raw number is useless (it only goes up); what you want is its slope. `rate(x[5m])` gives per-second increase averaged over 5 minutes — for a CPU-seconds counter, that's literally "cores in use." Rule of thumb: metric name ends in `_total` → it's a counter → wrap it in `rate()` or `increase()` before doing anything else.

**Label matchers**: `{namespace="myteam", container!="", pod=~"checkout-.*"}` — exact match `=`, negative `!=`, regex `=~`/`!~`.

**Aggregation**: `sum by (pod, container) (...)` collapses everything except the listed labels. `sum`, `max`, `avg`, `count`, `topk(5, ...)` all work the same way.

:::caution[The two cAdvisor traps]
cAdvisor exports each pod's usage at multiple levels, and if you sum naively you double-count:

1. **Empty `container` label** — series with `container=""` are pod-level and cgroup-slice aggregates. Always filter `container!=""`.
2. **The pause container** — every pod has an infrastructure container named `POD` that holds the network namespace. Filter `container!="POD"`.

So the boilerplate selector for anything from cAdvisor is `{namespace="myteam", container!="", container!="POD"}`. Newer stacks drop these series via relabeling, but write the filter anyway — it's free and it travels.
:::

Two more functions you'll use constantly: `quantile_over_time(0.99, x[7d])` gives the 99th percentile of a single series' values across a window (right-sizing gold), and `predict_linear(x[1h], 3600)` extrapolates a gauge one hour into the future (time-to-OOM).

## The metric inventory

You didn't instrument any of this — it's already there. Two exporters matter for resources:

**cAdvisor** (built into the kubelet, per-container cgroup stats):

| Metric | Type | What it is |
|---|---|---|
| `container_cpu_usage_seconds_total` | counter | CPU-seconds consumed. `rate()` of it = cores in use. |
| `container_cpu_cfs_throttled_periods_total` | counter | CFS scheduler periods in which the container wanted CPU but was throttled at its limit. |
| `container_cpu_cfs_periods_total` | counter | Total CFS periods in which the container was runnable. Denominator for throttle ratio. |
| `container_memory_working_set_bytes` | gauge | usage minus inactive file cache. **This is what the OOM killer compares to your limit.** |
| `container_memory_rss` | gauge | Anonymous memory (heap, stacks). No page cache at all. |
| `container_memory_usage_bytes` | gauge | Everything including all page cache — reads high, scares people unnecessarily. |
| `container_memory_cache` | gauge | Page cache alone. |

The memory metric zoo trips everyone. `usage_bytes` includes reclaimable file cache, so a pod reading lots of files looks near its limit while being perfectly healthy. `rss` excludes cache entirely, so it under-reports pressure from active mmap'd files. `working_set_bytes` is usage minus *inactive* cache — memory the kernel can't cheaply reclaim — and it's the number the kubelet and the OOM killer act on. **Watch working_set. Compare working_set to your limit. Alert on working_set.** The others are for diagnosis (a big usage/working_set gap = cache; a big working_set/rss gap = active cache or shared memory).

**kube-state-metrics** (object state from the API server):

| Metric | What it is |
|---|---|
| `kube_pod_container_resource_requests{resource="cpu"\|"memory"}` | The request from your pod spec, as a gauge (cores / bytes). |
| `kube_pod_container_resource_limits{resource="cpu"\|"memory"}` | Ditto for limits. Absent if you didn't set one. |
| `kube_pod_container_status_restarts_total` | Restart counter per container. |
| `kube_pod_container_status_last_terminated_reason` | Series exists with value 1, `reason` label = `OOMKilled`, `Error`, etc. |

**What you can't see without node access**: node-level pressure (`node_memory_*` from node-exporter is usually queryable but interpreting it is platform territory), kubelet eviction decisions, and other tenants' namespaces if the platform scopes your Grafana datasource. If a query returns nothing that should return something, ask the platform team whether the metric is dropped by relabeling or scoped away.

## The money queries: consumed vs request vs limit

Assume `namespace="myteam"` throughout; substitute yours.

### CPU consumed, per pod

```promql
sum by (pod) (
  rate(container_cpu_usage_seconds_total{namespace="myteam", container!="", container!="POD"}[5m])
)
```

Line by line: take the CPU-seconds counter for real containers only, turn it into cores-in-use with `rate()`, sum the containers within each pod.

```text
{pod="checkout-api-7d4b9fc6c-x2k4f"}   0.212
{pod="checkout-api-7d4b9fc6c-9jwq2"}   0.198
{pod="worker-6f7c88d9d5-tt8xl"}        1.84
```

`0.212` = 212 millicores, matching `kubectl top` — except now you can graph the last two weeks of it.

### CPU consumed ÷ requested — the join everyone gets stuck on

```promql
sum by (pod, container) (
  rate(container_cpu_usage_seconds_total{namespace="myteam", container!="", container!="POD"}[5m])
)
/ on (pod, container) group_left ()
sum by (pod, container) (
  kube_pod_container_resource_requests{namespace="myteam", resource="cpu"}
)
```

The division is between two different metrics with **different label sets** — cAdvisor series carry labels like `image` and `id` that kube-state-metrics series don't. A bare `/` requires labels to match exactly, so it returns nothing. The fix, piece by piece:

- Aggregating both sides `by (pod, container)` first strips the mismatched labels — the cheapest way to make a join work.
- `on (pod, container)` says "match series using only these two labels."
- `group_left` says "left side may have many series per right-side series" (many-to-one). With both sides pre-aggregated it's technically one-to-one and `group_left` is belt-and-braces, but keep the habit: the moment you skip the aggregation, you need it.

```text
{pod="checkout-api-7d4b9fc6c-x2k4f", container="app"}   0.42
{pod="worker-6f7c88d9d5-tt8xl", container="app"}        3.68
```

The checkout pod uses 42% of its CPU request. The worker uses **368%** of its request — legal (CPU requests aren't ceilings), but it means the scheduler placed it based on a fiction, and if it has a limit it's probably throttled. Swap `resource_requests` for `resource_limits` in the same query to get **used ÷ limit**; values approaching 1.0 mean throttling is imminent or happening.

### CPU throttling ratio

```promql
sum by (pod, container) (
  rate(container_cpu_cfs_throttled_periods_total{namespace="myteam", container!=""}[5m])
)
/
sum by (pod, container) (
  rate(container_cpu_cfs_periods_total{namespace="myteam", container!=""}[5m])
)
```

Both metrics come from cAdvisor with identical labels, so no join gymnastics needed. Result = fraction of scheduler periods in which the container hit its limit and was frozen.

```text
{pod="checkout-api-7d4b9fc6c-x2k4f", container="app"}   0.31
```

31% of periods throttled. Anything sustained above ~5–10% is hurting latency; 31% is a fire.

:::note[Throttled while averaging under the limit?]
Completely normal, and the single most misunderstood CPU behavior in Kubernetes. CFS enforces limits in 100 ms accounting periods: a limit of `500m` means 50 ms of CPU per 100 ms period. An app that's idle then bursts (GC, request spikes, JIT compilation) burns its 50 ms in the first 20 ms of some periods and sits frozen for the remaining 80 ms — while its 5-minute *average* shows a cozy 200m. Averages hide it; the throttle ratio doesn't. This is why "CPU looks fine" and "app is slow" coexist.
:::

### Memory: working set ÷ request, ÷ limit

```promql
max by (pod, container) (
  container_memory_working_set_bytes{namespace="myteam", container!="", container!="POD"}
)
/ on (pod, container) group_left ()
max by (pod, container) (
  kube_pod_container_resource_limits{namespace="myteam", resource="memory"}
)
```

Same join pattern; `max` instead of `sum` because working set is a gauge and container restarts can briefly leave duplicate series (old and new container ID) — `sum` would double it, `max` won't.

```text
{pod="checkout-api-7d4b9fc6c-x2k4f", container="app"}   0.93
```

93% of the memory limit. Unlike CPU, memory has no throttling — the next stop is the OOM killer. See [OOMKilled](/troubleshooting/oomkilled/).

### Distance-to-OOM and time-to-OOM

Absolute headroom in bytes:

```promql
max by (pod, container) (kube_pod_container_resource_limits{namespace="myteam", resource="memory"})
- on (pod, container) group_left ()
max by (pod, container) (container_memory_working_set_bytes{namespace="myteam", container!="", container!="POD"})
```

And the trend — will it cross the limit, and when? `predict_linear` fits a line to the last hour and extrapolates 4 hours out:

```promql
predict_linear(
  container_memory_working_set_bytes{namespace="myteam", pod="checkout-api-7d4b9fc6c-x2k4f", container="app"}[1h],
  4 * 3600
)
```

If the predicted value exceeds the limit, you have hours, not days. A steady upward slope that survives restarts of traffic is the classic leak signature — for JVM apps, confirm whether it's heap or native before touching the limit: [Memory Leaks and OOM](/java/memory-leaks-and-oom/).

### Right-sizing percentiles

What should the request actually be? Not the average, not the peak — the p95/p99 over a representative window:

```promql
quantile_over_time(0.99,
  container_memory_working_set_bytes{namespace="myteam", pod=~"checkout-api-.*", container="app"}[7d]
)
```

```text
{pod="checkout-api-7d4b9fc6c-x2k4f", ...}   1041235968    # ~993Mi
```

Memory request ≈ p99 working set plus margin; CPU request ≈ p95 of the 5m rate (average the pods, don't sum). Feeding these numbers into an actual resize — safely, with QoS implications — is [Resource Tuning in Production](/operations/resource-tuning-in-prod/).

:::tip
Run the 7-day quantile per pod, not aggregated — one leaky replica shouldn't inflate the request for all of them. And make sure the window includes your weekly peak (batch night, Monday morning), or you'll right-size for the quiet days.
:::

### Namespace-wide: are we hoarding quota?

```promql
sum(kube_pod_container_resource_requests{namespace="myteam", resource="cpu"})
```
```promql
sum(rate(container_cpu_usage_seconds_total{namespace="myteam", container!="", container!="POD"}[5m]))
```

```text
requests:  24        # cores reserved
usage:      3.1      # cores actually used
```

A 24:3 ratio means you've reserved 8x what you use. The scheduler blocks other teams' pods on your fiction, the platform team buys nodes for it, and eventually someone shows up with this exact query. Run it on yourself first. Same pair with `resource="memory"` and `container_memory_working_set_bytes`.

### Restart and OOM forensics

Restarts in the last hour:

```promql
increase(kube_pod_container_status_restarts_total{namespace="myteam"}[1h]) > 0
```

Why did it last die?

```promql
kube_pod_container_status_last_terminated_reason{namespace="myteam", reason="OOMKilled"} == 1
```

```text
{pod="checkout-api-7d4b9fc6c-x2k4f", container="app", reason="OOMKilled"}   1
```

This survives even after `kubectl describe` history has been churned away by new pods. Cross-check with `kubectl get events` for the kubelet's side of the story; when the reason is `Error` instead, you're in crash-loop territory, not OOM.

## Diagnosis walkthroughs

### "App is slow but CPU looks fine in kubectl top"

1. Throttle ratio (query above). If it's >5–10% sustained: found it.
2. Confirm the mechanism: compare `used ÷ limit` — if the 5m average is well under 1.0 but throttling is high, it's **bursty** consumption hitting the CFS period wall, not sustained starvation.
3. Fix: raise the CPU limit (or remove it — many platforms allow limitless CPU with sane requests; ask), or reduce burstiness (JVM teams: JIT warmup and GC bursts are the usual suspects).
4. If throttling is clean, the bottleneck isn't CPU quota — move on to latency profiling and downstream-dependency analysis.

### "OOMKilled at random"

1. Confirm it's actually OOM: `last_terminated_reason` query above.
2. Graph `working_set ÷ limit` for the affected pods over 24h. **Sawtooth** climbing to ~1.0 and resetting = the kills, plainly visible.
3. Check it's not a cache mirage: graph `container_memory_rss` alongside. If rss is flat and working_set climbs, active page cache is involved (unusual — but rules out heap). If rss climbs in lockstep, it's real anonymous memory.
4. JVM apps: if heap (from your app metrics) is flat but working_set climbs, it's **native** — metaspace, threads, direct buffers, glibc arenas. The limit needs headroom above `-Xmx`, typically 25%+. [JVM in Containers](/java/jvm-in-containers/) has the accounting.
5. Slope steady across days → leak; step changes correlated with deploys → check the diff; spikes correlated with traffic → undersized limit, use the p99 query and resize.

### "HPA won't scale / scales too much"

The HPA's `averageUtilization: 70` means **70% of the CPU request** averaged across pods — not of the limit, not of the node. So the number the HPA sees is exactly the used÷requested query with `avg` instead of `sum by (pod)`:

```promql
avg(
  sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="myteam", pod=~"checkout-api-.*", container!="", container!="POD"}[5m]))
  / on (pod) group_left ()
  sum by (pod) (kube_pod_container_resource_requests{namespace="myteam", pod=~"checkout-api-.*", resource="cpu"})
)
```

Requests set too high → utilization never reaches the target → HPA never scales, app melts. Requests too low → 70% of a tiny request is nothing → HPA scales to max on background noise. The HPA target is a percentage of a number *you chose*; if scaling behaves strangely, audit the denominator first. Full treatment in [Autoscaling](/workloads/autoscaling/).

### "Which of my 30 pods is the problem"

`topk` is the triage tool — top consumers, biggest limit pressure, most throttled:

```promql
topk(5, sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="myteam", container!="", container!="POD"}[5m])))
```

```promql
topk(5,
  max by (pod, container) (container_memory_working_set_bytes{namespace="myteam", container!="", container!="POD"})
  / on (pod, container) group_left ()
  max by (pod, container) (kube_pod_container_resource_limits{namespace="myteam", resource="memory"})
)
```

One replica hot while its siblings idle = uneven load (sticky sessions, partition assignment, a poison message) — not a resource problem at all. All replicas hot together = capacity. The shape of the topk result is itself the diagnosis.

## Grafana practicalities

**Variables.** Define `$namespace` (`label_values(kube_pod_info, namespace)`) and `$pod` (`label_values(kube_pod_info{namespace="$namespace"}, pod)`) once, then write every panel query with `namespace="$namespace", pod=~"$pod"`. One dashboard serves every service you own.

**The six-panel resource dashboard** — this covers 90% of incidents:

1. CPU used per pod (the `rate` query), with request and limit as flat overlay lines.
2. CPU used ÷ request, per pod — the HPA's-eye view.
3. Throttle ratio per container, with a threshold line at 0.05.
4. Working set per pod, with limit overlaid — you'll see the sawtooth before the pager does.
5. Working set ÷ limit, per container — threshold at 0.85.
6. Restarts: `increase(kube_pod_container_status_restarts_total[1h])` as bars, plus a table of `last_terminated_reason`.

**Explore** is for ad-hoc queries during an incident; dashboards are for the queries you've already learned you need. Every query in this article starts life in Explore.

:::note[Retention is not infinite]
Platform Prometheus typically keeps 15–30 days at full resolution. Your `[7d]` right-sizing quantile works; a `[90d]` seasonal analysis probably doesn't, and if long-term storage (Thanos/Mimir) exists, old data may be downsampled — fine for trends, wrong for spike-hunting. Ask the platform team what retention and downsampling actually are before you trust a long-window query.
:::

## Quick reference

| Question | Query |
|---|---|
| CPU cores used, per pod | `sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="X", container!="", container!="POD"}[5m]))` |
| CPU used ÷ request | `sum by (pod,container) (rate(container_cpu_usage_seconds_total{...}[5m])) / on(pod,container) group_left() sum by (pod,container) (kube_pod_container_resource_requests{resource="cpu"})` |
| CPU used ÷ limit | same, with `kube_pod_container_resource_limits{resource="cpu"}` |
| Throttle ratio | `rate(container_cpu_cfs_throttled_periods_total[5m]) / rate(container_cpu_cfs_periods_total[5m])` |
| Memory working set | `max by (pod,container) (container_memory_working_set_bytes{container!="", container!="POD"})` |
| Working set ÷ limit | working set query `/ on(pod,container) group_left()` limits query with `resource="memory"` |
| Headroom to OOM (bytes) | `limits - working_set` (same join) |
| Time-to-OOM trend | `predict_linear(container_memory_working_set_bytes{...}[1h], 4*3600)` vs limit |
| p99 memory for sizing | `quantile_over_time(0.99, container_memory_working_set_bytes{...}[7d])` |
| Namespace requests vs usage | `sum(kube_pod_container_resource_requests{namespace="X", resource="cpu"})` vs `sum(rate(container_cpu_usage_seconds_total{...}[5m]))` |
| Restarts last hour | `increase(kube_pod_container_status_restarts_total{namespace="X"}[1h]) > 0` |
| Last death was OOM | `kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1` |
| Top 5 anything | wrap it in `topk(5, ...)` |

Every threshold worth watching here is also worth alerting on — as a ticket, not a page. That's the next article.
