---
title: Observability Overview
description: The four signals — logs, metrics, events, traces — and what Kubernetes gives you for free versus what needs platform tooling.
sidebar:
  order: 1
---

You can't fix what you can't see. When your service is slow at 2 AM, the difference between a ten-minute fix and a four-hour war room is almost always observability that was set up *before* the incident. This section covers what signals exist in a Kubernetes cluster, which ones you get for free, and which ones require you to instrument your app or ask the platform team for tooling.

## The four signals

Kubernetes-flavored observability breaks down into four signal types. They answer different questions and fail in different ways:

| Signal | Answers | Free with kubectl? | Retention |
|---|---|---|---|
| **Logs** | "What did my app say happened?" | Yes — `kubectl logs` | Until pod deletion / node rotation |
| **Metrics** | "How much, how fast, how often?" | Barely — `kubectl top` | metrics-server keeps ~nothing; Prometheus keeps weeks |
| **Events** | "What did the *cluster* do to my app?" | Yes — `kubectl get events` | ~1 hour by default |
| **Traces** | "Where in the request path did time go?" | No — requires instrumentation | Whatever the backend keeps |

The single most common observability mistake we see from app teams: treating `kubectl logs` as the whole story. Logs tell you what your code chose to print. Events tell you what the scheduler, kubelet, and controllers did *to* your pod — OOM kills, failed mounts, probe failures. During an incident you almost always need both.

## What the cluster gives you for free

With nothing more than namespace-scoped kubectl access, you already have:

```bash
# Logs from any container you own, including the previous crashed instance
kubectl logs deploy/checkout-api --since=15m
kubectl logs pod/checkout-api-7d4b9-x2k4f --previous

# The cluster's own audit trail of what happened to your objects
kubectl get events --sort-by=.lastTimestamp

# Point-in-time resource usage (if metrics-server is installed — it almost always is)
kubectl top pod
```

That's genuinely useful, but it's all **ephemeral**. Logs vanish when pods are deleted. Events expire after about an hour. `kubectl top` shows *now* and nothing else. Free observability is enough to debug something happening in front of you; it is useless for "why was the service slow yesterday at 14:30."

## What needs platform tooling

Durable observability requires infrastructure that runs cluster-wide, which means the platform team owns it:

- **Log collection** — a node-level agent (Fluent Bit, Vector, Fluentd) running as a DaemonSet, shipping to Loki, Elasticsearch, or a cloud service. You control the *format* of your logs; they control the pipe. See [Log Collection](/observability/log-collection/).
- **Metrics storage** — a Prometheus stack scraping your `/metrics` endpoint. You expose metrics; they run the scraper, storage, and Grafana. See [Metrics](/observability/metrics/).
- **Tracing backend** — an OpenTelemetry collector plus Jaeger/Tempo/vendor backend. You instrument; they run the collector. See [Tracing](/observability/tracing/).

:::tip[First question for your platform team]
Before writing a single line of instrumentation, ask: "What logging, metrics, and tracing stack does this cluster have, and where do I look at my data?" Instrumenting for a backend that doesn't exist is wasted work, and the answer shapes everything from log format to which annotations you add.
:::

## What YOU own regardless

Even though the platform team owns the pipes, the quality of what flows through them is entirely on you:

1. **Log to stdout/stderr, in JSON, one event per line.** This is the contract that makes everything downstream work. Details in [Logging Fundamentals](/observability/logging-fundamentals/).
2. **Expose a `/metrics` endpoint** and set requests/limits sanely so the metrics mean something. See [Resources and QoS](/workloads/resources-and-qos/).
3. **Propagate trace context** (W3C `traceparent`) and put `trace_id` in your logs so signals correlate.
4. **Health checks that reflect reality** — probe results surface as events and drive rollouts, restarts, and load balancing.

## Article map

Work through these in order the first time; after that they're reference material.

- **[Logging Fundamentals](/observability/logging-fundamentals/)** — the stdout contract, `kubectl logs` mastery, why logs vanish, multiline stack traces.
- **[Log Collection](/observability/log-collection/)** — the pipeline from node agent to search backend, and why your logs sometimes don't show up.
- **[Metrics](/observability/metrics/)** — metrics-server vs Prometheus, the PromQL every app team needs, dashboards worth building.
- **[Events](/observability/events/)** — the cluster's audit trail, the greatest-hits event reasons, and capturing them before they expire.
- **[Tracing](/observability/tracing/)** — OpenTelemetry, the Java agent, sampling, and log/trace correlation.
- **[Performance Analysis](/observability/performance-analysis/)** — a layered triage methodology for "it's slow," starring CPU throttling.
- **[PromQL for CPU and Memory](/observability/promql-for-resources/)** — the query cookbook for consumed vs requests vs limits: throttling, distance-to-OOM, right-sizing percentiles.
- **[Alerting](/observability/alerting/)** — page on symptoms, ticket on causes: burn-rate alerts, pre-OOM warnings, PrometheusRule anatomy, and a starter rule pack.

:::note
This section pairs tightly with [Troubleshooting](/troubleshooting/overview/). Observability is how you gather evidence; troubleshooting is how you act on it.
:::

## Which signal do I reach for?

A quick mapping from the question in your head to the signal that answers it:

| You're asking... | Reach for | Because |
|---|---|---|
| "Why did this pod crash?" | Logs (`--previous`), then events | The exception is in the dead container's log; the kill reason is in events/describe |
| "Why won't this pod start?" | Events (`describe pod`) | Scheduling, image pulls, and mounts never reach your app's logs |
| "Is it slower than yesterday?" | Metrics | Only time series can compare against history |
| "Which of five services is slow?" | Traces | Only traces follow one request across services |
| "Is it about to run out of memory?" | Metrics (working set vs limit) | Logs won't warn you; the OOM killer doesn't either |
| "Why did the rollout hang?" | Events | The rollout controller and kubelet narrate the failure in events |
| "What exactly did request X do?" | Logs filtered by `trace_id` | Structured logs are the per-request narrative |

Two habits fall out of this table. First: `kubectl describe pod` (which embeds events) before `kubectl logs` for anything lifecycle-related — startup, scheduling, restarts. Second: metrics before logs for anything about *trends* — logs sample points in time, metrics draw the curve.

The signals compound when they're linked. The mature incident workflow walks across all four:

```text
alert fires (metrics: error rate up)
  → dashboard narrows it (metrics: only pods on one node, or one endpoint)
    → trace of a failing request shows the slow/broken hop (traces)
      → trace_id filters logs to that exact request's narrative (logs)
        → events explain any pod lifecycle weirdness underneath (events)
```

Every link in that chain is something you set up in this section: the `/metrics` endpoint, trace propagation, `trace_id` in JSON logs, and the event-capture habit.

## Day-one observability for a new service

When you stand up a new service, wire this in before the first production deploy — it's an hour of work that repays itself on the first incident:

```yaml
# In your Deployment's pod template
metadata:
  labels:
    app.kubernetes.io/name: checkout-api        # becomes a log/metric label
    app.kubernetes.io/version: "2.14.1"
  annotations:
    prometheus.io/scrape: "true"                # or a ServiceMonitor — ask platform
    prometheus.io/port: "8080"
spec:
  containers:
    - name: app
      env:
        - name: LOG_FORMAT                      # JSON in cluster, pretty locally
          value: "json"
        - name: OTEL_EXPORTER_OTLP_ENDPOINT     # trace export, if a collector exists
          value: "http://otel-collector.observability.svc:4317"
```

Plus, in the app itself: JSON logging with `trace_id`, a `/metrics` endpoint, and honest readiness/liveness probes. Every article in this section expands one of those bullets.

## Anti-patterns to unlearn

Habits that made sense on VMs and actively hurt in Kubernetes:

- **SSHing to "the server" to read log files.** There is no server; there are N replaceable pods on nodes you can't reach. The log file you want may be on a node that no longer exists. Everything flows through `kubectl logs` and the collection pipeline.
- **Treating a pod as a pet with history.** Pods are cattle; their local state, logs, and tmp files are disposable. Anything you'll want later must be exported — to the log store, to metrics, to a volume.
- **Debugging by restart.** Restarting a sick pod destroys the evidence (logs, heap state, event correlation) and often "fixes" it just long enough to page you again at a worse hour. Capture first, restart second.
- **Alerting on causes instead of symptoms.** Page on user-facing symptoms (error rate, latency); use cause-level signals (CPU, restarts, GC) for diagnosis. Cause-based paging drowns you in noise the moment anything real happens.
- **Building observability during the incident.** Adding instrumentation requires a deploy, and deploying during an incident is how one incident becomes two. The time to wire this section up is now.

## The one habit that matters

If you take one thing from this section: **capture ephemeral state during incidents, immediately.** Logs, events, and `kubectl top` output all evaporate. A thirty-second capture ritual at the start of any incident —

```bash
NS=my-namespace; TS=$(date +%Y%m%d-%H%M%S)
kubectl -n $NS get events --sort-by=.lastTimestamp > events-$TS.txt
kubectl -n $NS get pods -o wide > pods-$TS.txt
kubectl -n $NS top pod > top-$TS.txt
kubectl -n $NS logs deploy/my-app --since=30m --timestamps > logs-$TS.txt
```

— has saved more post-incident reviews than every dashboard we've ever built.
