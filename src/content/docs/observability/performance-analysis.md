---
title: Performance Analysis
description: A layered triage methodology for "it's slow" — locating the latency with data, catching CPU throttling, and building an evidence pack for the platform team.
keywords:
  - the service is slow triage
  - CPU throttling cpu.stat
  - noisy neighbor node pressure
  - readiness probe flapping
  - connection pool exhaustion HikariCP
  - bimodal latency histogram
  - p99 latency spike
  - GC memory pressure
  - kubectl port-forward direct to pod
  - in-cluster load testing hey Job
  - podAntiAffinity spread replicas
  - evidence pack for platform team
sidebar:
  order: 7
---

"The service is slow" is the vaguest ticket in operations, and the most common. The failure mode is guessing: restarting pods, bumping limits, blaming the network — vibes-driven engineering. The fix is a layered elimination method: establish *where* the time goes with data, then dig into that layer only. This article is the method, plus the specific Kubernetes pathologies that cause most slowness.

## Step 0: Define "slow" with a number

Before touching kubectl, get: which endpoint/operation, observed latency vs normal (p95 went from 80 ms to 1.4 s?), since when, all traffic or a subset, and constant or spiky. "Slow since yesterday's 14:00 deploy, only on POST /checkout, p99 only" eliminates 80% of the search space before you start. If you built the RED dashboard described in the metrics article, this step is one glance.

## Step 1: Locate the layer

A request traverses: **client → ingress → Service → pod (your app) → downstreams (DB, cache, other services)**. Slowness lives in exactly one of these more often than not. Bracket it:

- **App's own latency metric** (or access log durations): does the *server-side* measurement show the slowness? If server-side says 40 ms but clients see 1.4 s, the time is being lost *before* your app — ingress, Service, or client side. If server-side shows 1.3 s, it's your app or its downstreams.
- **Traces are the shortcut.** One [trace](/observability/tracing/) of a slow request shows the whole waterfall — this is the payoff for setting up OpenTelemetry before the incident.
- **No traces?** Bisect manually. `kubectl port-forward deploy/checkout-api 8080:8080` and hit the pod directly, bypassing ingress and Service:

```bash
curl -w 'total=%{time_total}s connect=%{time_connect}s ttfb=%{time_starttransfer}s\n' \
  -o /dev/null -s http://localhost:8080/api/checkout/health
```

Fast direct but slow through the front door → the problem is in routing/ingress (see [Debugging Network](/networking/debugging-network/)). Slow direct → it's the pod. Then bracket downstream the same way: time your app's DB/cache calls (client metrics, or slow-query logs) to split "my code" from "my dependencies."

The rest of this article covers the pod-layer pathologies, in the order of how often they turn out to be the answer.

## CPU throttling: the silent killer

The number-one Kubernetes-specific latency pathology. Your container has a CPU **limit**; the kernel CFS enforces it in 100 ms accounting periods. Burn your quota in the first 30 ms of a period and your threads *stop dead* for 70 ms — repeatedly. Average CPU usage looks comfortable, `kubectl top` looks fine, and p99 latency is destroyed. Multi-threaded runtimes (JVM especially) burn quota across many threads simultaneously and hit this hardest.

**Detect via Prometheus:**

```text
rate(container_cpu_cfs_throttled_periods_total{namespace="shop", container="app"}[5m])
  / rate(container_cpu_cfs_periods_total{namespace="shop", container="app"}[5m])
```

Sustained > 0.25 = actively hurting. This throttle-ratio query, along with the utilization queries used throughout this triage, is unpacked in [PromQL for CPU and Memory](/observability/promql-for-resources/).

**Detect from inside the pod** — no metrics stack needed, just exec:

```bash
kubectl exec -it checkout-api-7d4b9fc6c-x2k4f -- cat /sys/fs/cgroup/cpu.stat
```

```console
usage_usec 84211930
nr_periods 48231
nr_throttled 19754
throttled_usec 512883021
```

`nr_throttled / nr_periods` is your throttled-period ratio — here 41%, a smoking gun. (Older nodes on cgroup v1: `cat /sys/fs/cgroup/cpu/cpu.stat` for the same counters.) Take two snapshots ~60 s apart and diff, so you measure *now* rather than since container start.

**Fixes:** raise the CPU limit, or remove it and keep only the request — a legitimate, increasingly mainstream pattern, but check your cluster's policy since some platforms mandate limits (LimitRange/policy will tell you). Also right-size runtime thread pools to the actual quota — an undersized quota with a default-sized thread pool is a throttling machine.

## Memory pressure and GC

Slowness that ramps up over hours/days, then resets on restart, is the classic memory-pressure signature. Working set creeping toward the limit means, for the JVM, a shrinking-headroom heap and increasingly desperate GC — long pauses read as latency spikes with *low* CPU in between. Check working set vs limit (the query is in [Metrics](/observability/metrics/)), then go runtime-deep: [GC and Performance](/java/gc-and-performance/) covers pause analysis and what to do when the heap never plateaus. If pods are actually dying rather than slowing, that's an OOMKilled investigation, not a performance one.

## Noisy neighbors and node pressure

Your pod shares a node with strangers. If your CPU *request* is below your actual usage, you're gambling on spare node capacity — and when a neighbor claims it, your latency doubles with zero change on your side. The tell: only *some* replicas are slow, and they cluster on specific nodes.

What you can see with namespace-scoped access:

```bash
kubectl get pods -l app=checkout-api -o wide     # which node is each replica on?
kubectl top node                                  # may work; node-level read is often allowed
kubectl describe node worker-14                   # if allowed: Conditions (MemoryPressure, DiskPressure),
                                                  # and Allocated resources (is the node overcommitted?)
```

If `kubectl top node` / `describe node` are denied by RBAC, that's expected — correlate slow replicas to node names, and hand that to the platform team. **Self-defense regardless:** set your CPU/memory requests to what you actually use (requests are your *guaranteed* share; that's the whole point), and consider `podAntiAffinity` to spread replicas across nodes so one bad neighbor can't slow every replica at once.

## Readiness flapping: slowness that's actually gaps

If readiness probes intermittently fail, endpoints get pulled from and re-added to the Service. Traffic concentrates on remaining pods (loading them further — a positive feedback loop), and requests in flight to a pulled pod can error or stall. From the outside this reads as "random slowness," when it's really *capacity oscillation*.

```bash
kubectl get events --field-selector type=Warning --sort-by=.lastTimestamp | grep Unhealthy
kubectl get endpointslices -l kubernetes.io/service-name=checkout-api -w   # watch endpoints churn live
```

`Unhealthy ... (x31 over 20m)` on multiple pods = flapping. Root causes, in observed order: readiness probe timeout too tight for an app under load (GC pause > probe timeout = false failure), probe endpoint doing expensive work (hitting the DB per probe), or genuine intermittent overload. Fix the probe budget first — a probe timeout shorter than your worst-case GC pause is a self-inflicted outage generator.

## Connection pool exhaustion

The signature: latency histogram goes **bimodal** — most requests normal, a slice pinned at exactly the pool's checkout timeout (a suspiciously round 5 s or 30 s) — while CPU stays low. Requests aren't slow; they're *queued* waiting for a connection (DB pool, HTTP client pool to a downstream).

Diagnosis: expose pool metrics (HikariCP publishes `hikaricp_connections_pending` and friends via Micrometer); `pending > 0` sustained is the confirmation. A latency spike whose ceiling equals a configured timeout is pool exhaustion until proven otherwise. Fixes: right-size the pool **per replica** (10 replicas × 20 connections = 200 server-side connections — coordinate before the database runs out), fix connection leaks (checkout without return under exception paths), and shorten checkout timeouts so failures are fast and visible instead of slow and mysterious.

## Benchmarking inside the cluster

To split "the network/ingress path is slow" from "the app is slow," generate load from *inside* the cluster, adjacent to the target. A throwaway Job in your own namespace needs no privileges:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: loadgen-checkout
spec:
  ttlSecondsAfterFinished: 600
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: hey
          image: williamyeh/hey
          args: ["-z", "60s", "-c", "20",
                 "http://checkout-api.shop.svc.cluster.local:8080/api/health"]
          resources:
            requests: { cpu: 500m, memory: 128Mi }
            limits:   { cpu: "1",  memory: 256Mi }
```

```bash
kubectl apply -f loadgen.yaml && kubectl wait --for=condition=complete job/loadgen-checkout --timeout=120s
kubectl logs job/loadgen-checkout
```

In-cluster p99 of 45 ms while external clients see 900 ms → the app is fine; the path in front of it isn't. In-cluster p99 of 850 ms → stop blaming the network. Test against both the Service name and a single pod IP to isolate Service-level effects.

:::caution
Load-test production deliberately, not casually: announce it, start with low concurrency, and remember your load generator competes for the same cluster resources — give it its own requests so it doesn't perturb the measurement it's taking.
:::

## Escalating to the platform team: the evidence pack

Escalate when the data points below your reach: node pressure/overcommit, CNI or kube-proxy behavior, ingress controller latency, cluster DNS slowness. A vague "we think it's the cluster" goes to the back of the queue. This gets acted on:

1. **Symptom with numbers:** "p99 on checkout-api rose 80 ms → 1.4 s starting 2026-07-03 09:10 UTC; app-server-side latency unchanged."
2. **What you ruled out, with evidence:** throttling ratio (< 1%), working set vs limit, no `Unhealthy`/`Evicted` events (attach the [event dump](/observability/events/)), in-cluster benchmark results.
3. **The correlation you found:** "only replicas on worker-14 and worker-17 are slow; pods list attached with `-o wide`."
4. **Reproduction:** the loadgen Job YAML and its output, so they can re-run it after any change.

That's a ticket a platform engineer can act on in minutes. More on making this relationship work: [Working with the Platform Team](/operations/working-with-platform-team/).

## Quick reference: the pod-layer suspects

| Signature | Likely cause | First check |
|---|---|---|
| p99 bad, average fine, CPU "fine" | CPU throttling | `cpu.stat` in the pod; throttled-period ratio |
| Degrades over hours, resets on restart | Memory pressure / GC | Working set vs limit trend |
| Only some replicas slow, node-correlated | Noisy neighbor / node pressure | `kubectl get pods -o wide` + `top node` |
| "Random" slowness + Warning events | Readiness flapping | Events for `Unhealthy`; watch EndpointSlices |
| Bimodal latency, ceiling = a round timeout | Connection pool exhaustion | Pool pending/active metrics |
| Slow externally, fast in-cluster | Ingress/LB/network path | In-cluster loadgen Job vs external curl |

Work the table top to bottom — it's ordered by base rate. Most "Kubernetes is slow" tickets are the first row.
