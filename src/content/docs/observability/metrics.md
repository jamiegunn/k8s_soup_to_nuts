---
title: Metrics
description: metrics-server vs the Prometheus stack, exposing app metrics, the essential PromQL for app teams, and dashboards worth building.
sidebar:
  order: 4
---

Metrics answer "how much, how fast, how often" — the questions logs are terrible at. In Kubernetes there are two metric systems that beginners constantly conflate: **metrics-server**, a tiny in-memory component that powers `kubectl top` and the HPA, and the **Prometheus stack**, the real time-series system where history, dashboards, and alerts live. Knowing which one you're talking to matters.

## Layer 1: metrics-server and kubectl top

metrics-server scrapes CPU/memory from every kubelet, keeps only the **latest** sample in memory, and serves it through the Metrics API. It exists to feed `kubectl top` and [autoscaling](/workloads/autoscaling/) — nothing else.

```bash
kubectl top pod
```

```console
NAME                            CPU(cores)   MEMORY(bytes)
checkout-api-7d4b9fc6c-x2k4f    212m         987Mi
checkout-api-7d4b9fc6c-9jwq2    198m         1002Mi
worker-6f7c88d9d5-tt8xl         1840m        410Mi
```

```bash
kubectl top pod --containers          # per-container breakdown in multi-container pods
kubectl top pod --sort-by=memory     # find the hog fast
kubectl top node                     # node-level view — needs cluster read; may be denied
```

Limitations to internalize:

- **No history.** It's a snapshot averaged over the last scrape window (~15–60 s). A CPU spike 90 seconds ago is invisible. You cannot answer "what was it doing at 14:30" with `kubectl top`.
- **Memory shown is the working set** — the same number the OOM killer cares about, so comparing it to your limit is legitimate. See [Resources and QoS](/workloads/resources-and-qos/).
- **Short CPU bursts get averaged away.** A pod that's throttled hard in 200 ms bursts can still show comfortable-looking averages.

`kubectl top` is a triage tool. Everything else needs layer 2.

## Layer 2: the Prometheus stack

Platform-installed (usually kube-prometheus-stack): Prometheus scrapes targets on an interval, stores time series, Grafana visualizes, Alertmanager pages. The cluster comes pre-instrumented — **cAdvisor** (built into the kubelet) already exports per-container CPU/memory/network, and **kube-state-metrics** exports object state (replica counts, restart counts, pod phases). Your pods have history in Prometheus *even if you've instrumented nothing*.

### Exposing your own app metrics

Your job: serve a Prometheus text-format `/metrics` endpoint (every language has a client library; Java teams see [Java Observability](/java/java-observability/) — Micrometer makes this a dependency and a config line). Then tell Prometheus to scrape it, one of two ways depending on what your platform supports — **ask which**:

**Annotation-based discovery** (older convention, still common):

```yaml
# pod template metadata
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "8080"
  prometheus.io/path: "/metrics"
```

**ServiceMonitor / PodMonitor CRs** (Prometheus Operator — the modern default):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: checkout-api
  namespace: shop            # your namespace — you can usually create these yourself
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: checkout-api
  endpoints:
    - port: http-metrics     # must match a *named* port on your Service
      interval: 30s
```

:::caution
The two most common "Prometheus isn't scraping me" bugs: the ServiceMonitor's `port` doesn't match a **named** port in your Service, or the Prometheus instance is configured to only pick up ServiceMonitors with a specific label (e.g. `release: prometheus`). Both are five-second fixes once you know; ask the platform team which label their Prometheus selects on.
:::

Verify from inside the cluster before blaming the scraper:

```bash
kubectl exec deploy/checkout-api -- curl -s localhost:8080/metrics | head -5
```

## Essential PromQL for app teams

You don't need to be a PromQL wizard. You need about eight queries. Substitute your namespace/pod regex.

**The golden rule: counters need `rate()`.** A counter's raw value is meaningless; its rate of change is the signal.

```text
# CPU usage in cores, per pod
sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="shop", pod=~"checkout-api.*", container!=""}[5m]))
```

**Memory — use working set, the OOM-relevant number:**

```text
container_memory_working_set_bytes{namespace="shop", pod=~"checkout-api.*", container!=""}

# ...as a fraction of the limit (>0.9 sustained = OOMKill risk)
container_memory_working_set_bytes{namespace="shop", container="app"}
  / on(pod, container)
  kube_pod_container_resource_limits{resource="memory", namespace="shop", container="app"}
```

Ignore `container_memory_usage_bytes` for capacity questions — it includes reclaimable page cache and reads scarier than reality. Working set is what the kernel weighs before an [OOMKill](/troubleshooting/oomkilled/).

**CPU throttling — the silent latency killer:**

```text
# Fraction of scheduling periods in which the container was throttled
rate(container_cpu_cfs_throttled_periods_total{namespace="shop", container="app"}[5m])
  / rate(container_cpu_cfs_periods_total{namespace="shop", container="app"}[5m])
```

Sustained values above ~0.25 mean your CPU limit is squeezing you even though average usage looks fine. This bites multi-threaded runtimes (JVM, Go) hardest and is invisible in `kubectl top`. More in [Performance Analysis](/observability/performance-analysis/).

**Restarts — from kube-state-metrics:**

```text
increase(kube_pod_container_status_restarts_total{namespace="shop"}[1h]) > 0
```

These eight get you through most days. When you need the full cookbook — consumed vs requests vs limits, per-namespace rollups, and the right-sizing queries — go deeper with [PromQL for CPU and Memory](/observability/promql-for-resources/).

## USE and RED, briefly

Two checklists keep dashboards honest:

- **USE** (for *resources*): **U**tilization, **S**aturation, **E**rrors — apply to CPU (usage / throttling / —), memory (working set / % of limit / OOMKills). Saturation, not utilization, is what hurts.
- **RED** (for *services*): **R**ate, **E**rrors, **D**uration — requests/sec, error ratio, latency percentiles from your app's own metrics.

RED tells you *whether* users are hurting; USE tells you *why*.

## Grafana dashboards worth building

One dashboard per service, this layout, roughly top-to-bottom in incident-usefulness order:

1. **RED row** — request rate, error rate, p50/p95/p99 latency (from your app metrics).
2. **Saturation row** — CPU throttled-period ratio, memory working set vs limit (both as % — instantly readable at 3 AM).
3. **Stability row** — restart count, replica count vs desired, pod age.
4. **Dependencies row** — client-side latency/error rate for each downstream you call (DB, cache, other services).

Template it on namespace and pod so one dashboard serves dev/stage/prod. Resist the 60-panel dashboard; if a panel has never changed a decision, delete it.

Dashboards are for looking; the queries that matter should also wake someone up. [Alerting](/observability/alerting/) covers turning these queries into alerts — and, crucially, what deserves a page versus a ticket.

:::tip
Your cluster almost certainly already has the standard "Kubernetes / Compute Resources / Namespace (Pods)" dashboards from kube-prometheus-stack. Find them before building your own resource panels — build the RED/app-specific parts yourself and link to the platform's dashboards for the rest.
:::

## What to ask your platform team

- Annotations or ServiceMonitor? If ServiceMonitor: which label does Prometheus select on, and can we create them in our namespace?
- What's the scrape interval and retention (how far back can we query)?
- Can we get alerts routed to our channel (PrometheusRule CRs in our namespace, or a request process)?
- Is there a per-namespace series/cardinality budget? (Metric labels with unbounded values — user IDs, URLs — will blow it.)
