---
title: "Sizing Walkthrough: From Zero to Tuned"
description: An end-to-end worked example that sizes one real service — probes, JVM, requests, limits, and HPA — from first deploy to production, with every number traced to a measurement.
sidebar:
  order: 5
---

The other articles in this section are reference material: every probe field ([Health Check Knobs](/tuning/health-check-knobs/)), every JVM memory flag ([JVM Memory Knobs](/tuning/jvm-memory-knobs/)), every resources field ([Requests & Limits Knobs](/tuning/requests-limits-knobs/)). This one is the assembly manual. We take a single new service and carry the *same numbers* from "we have no data" to "this is guarded by alerts in production", showing every calculation on the way.

The patient: **orders-api**, a new Spring Boot service on JVM 21. Product expects ~200 req/s at peak. The SLO is p99 latency under 250ms. It talks to Postgres (HikariCP, pool of 10 per pod) and one downstream API. That's everything we know on day zero — which is exactly the point.

## Phase 0 — the honest starter config

You have no measurements, so any number you write is a guess. The goal of Phase 0 is not to be right; it's to be **oversized but bounded**, so the service survives long enough to give you data, and nothing it does can hurt its neighbors.

```yaml
# deploy/orders-api.yaml — Phase 0 (deliberately generous, deliberately bounded)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: orders-api
          image: registry.internal/orders-api:1.0.0
          env:
            - name: JAVA_TOOL_OPTIONS
              value: "-XX:MaxRAMPercentage=65.0 -XX:+ExitOnOutOfMemoryError"
          resources:
            requests:
              cpu: "1"            # a whole core: pure guess, roomy on purpose
              memory: 1.5Gi       # guess; request == limit so memory is Guaranteed
            limits:
              memory: 1.5Gi       # bounded: an OOM kills this pod, not the node
              # no CPU limit: throttling a service we haven't measured is self-sabotage
          startupProbe:           # the "slow JVM starter" archetype
            httpGet: { path: /actuator/health/readiness, port: 8080 }
            periodSeconds: 5
            failureThreshold: 36  # 36 × 5s = 3 min startup budget — huge, on purpose
          readinessProbe:
            httpGet: { path: /actuator/health/readiness, port: 8080 }
            periodSeconds: 5
            failureThreshold: 3
            timeoutSeconds: 2
          livenessProbe:
            httpGet: { path: /actuator/health/liveness, port: 8080 }
            periodSeconds: 10
            failureThreshold: 3
            timeoutSeconds: 2
```

Where each guess comes from:

- **1 CPU request, no CPU limit.** A whole core reserves real scheduler capacity, and the missing limit means a slow start or a traffic spike burns spare node CPU instead of hitting the CFS throttle. The full argument for limitless CPU lives in [Requests & Limits Knobs](/tuning/requests-limits-knobs/).
- **1.5Gi request = limit.** Memory is incompressible; request == limit means the scheduler reserved exactly what the OOM killer will enforce — no surprises from overcommit. `MaxRAMPercentage=65` gives the heap ~1000Mi of that and leaves ~500Mi for metaspace, threads, and off-heap — the standard opening bid from [JVM Memory Knobs](/tuning/jvm-memory-knobs/).
- **A three-minute startup budget.** The startup probe holds liveness and readiness off until the app is truly up, so a cold JVM can't be killed mid-boot. Way too generous — we'll shrink it with data in Phase 2. The archetype recipes are in [Health Check Knobs](/tuning/health-check-knobs/).
- **2 replicas + a PDB**, because a "new" service still gets caught in node drains:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: orders-api
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: orders-api
```

Two replicas is the floor for anything that takes traffic — one replica means every deploy and every drain is an outage. See [High Availability](/workloads/high-availability/) for the spreading and PDB mechanics.

:::note[Why oversized beats tight]
A too-generous Phase 0 wastes some quota for a week. A too-tight Phase 0 produces OOMKills, throttling, and probe-killed startups — and every one of those *corrupts the data you need for Phase 2*, because a pod that keeps dying never shows you its true working set. Buy clean data with temporary overprovisioning.
:::

## Phase 1 — load test in a dev namespace

Deploy the Phase 0 config to a dev namespace and point a load generator at it. A k6 Job keeps the whole thing in-cluster and in git:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: orders-api-loadtest
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: k6
          image: grafana/k6:0.51.0
          args: ["run", "/scripts/ramp.js"]
          volumeMounts:
            - { name: scripts, mountPath: /scripts }
      volumes:
        - name: scripts
          configMap: { name: orders-api-k6 }
```

```javascript
// ramp.js — ramp past the target so you see where the knee is
export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-arrival-rate",
      startRate: 20, timeUnit: "1s",
      preAllocatedVUs: 200,
      stages: [
        { target: 200, duration: "10m" },  // ramp to expected peak
        { target: 200, duration: "20m" },  // hold: memory needs time to plateau
        { target: 300, duration: "5m"  },  // overshoot: find the knee
      ],
    },
  },
  thresholds: { http_req_duration: ["p(99)<250"] },
};
```

While it runs, record five things (the queries are dissected in [PromQL for CPU and Memory](/observability/promql-for-resources/)):

```text
# CPU per pod, p95 over the test window
quantile_over_time(0.95,
  rate(container_cpu_usage_seconds_total{pod=~"orders-api-.*",container="orders-api"}[2m])[35m:])

# Working set per pod — the number the OOM killer judges you by
max_over_time(container_memory_working_set_bytes{pod=~"orders-api-.*",container="orders-api"}[35m])

# Throttle ratio (should be ~0 — we set no CPU limit, but verify nothing injected one)
rate(container_cpu_cfs_throttled_periods_total{pod=~"orders-api-.*"}[5m])
  / rate(container_cpu_cfs_periods_total{pod=~"orders-api-.*"}[5m])
```

Plus startup time (`kubectl describe pod` shows when the startup probe first succeeded — or watch `kube_pod_status_ready`), and GC behavior from `-Xlog:gc*` (reading those logs is covered in [GC and Performance](/java/gc-and-performance/)).

Our invented-but-plausible results, and the ones you should expect to collect:

| Measurement | Value at 200 req/s (2 pods) |
|---|---|
| Startup → ready, p99 of 20 restarts | **38s** |
| Request latency p50 / p99 | 42ms / **180ms** |
| Working set, plateau after 20 min hold | **1.1Gi** per pod |
| Heap used p99 / after full GC | 780Mi / 620Mi |
| CPU per pod, p95 | **750m** (~100 req/s per pod) |
| Throttle ratio | 0% (no CPU limit) |
| Allocation rate / young GC pause p99 | ~180MiB/s / 14ms |
| Knee (latency > 250ms) | ~150 req/s **per pod** |

:::tip[Restart the pods a dozen times]
One startup measurement is an anecdote. `kubectl rollout restart` in the dev namespace ten or twenty times and take the p99 — startup time varies with node cache state, image pulls, and CPU contention, and the slowest start is the one your startup probe has to survive.
:::

## Phase 2 — derive the numbers

Now every Phase 0 guess gets replaced by arithmetic. This is the whole method: **measurement × safety factor = setting**, with the factor written down so the next person can re-derive it.

**Startup budget.** Slowest observed start 38s; double it for bad days (cold image cache, busy node): **~80s**. With `periodSeconds: 5` that's `failureThreshold: 16` (16 × 5 = 80s). We just cut the boot-loop detection time from 3 minutes to 80 seconds without risking a single false kill.

**Probe timeouts.** Request p99 is 180ms and the health endpoint is cheaper than a real request, so `timeoutSeconds: 2` already carries a 10× margin — keep it. (If your p99 were 1.5s, a 2s probe timeout would be flap bait; the reasoning is in [Health Check Knobs](/tuning/health-check-knobs/).)

**Memory limit.** Working set plateaued at 1.1Gi. Apply ×1.35 headroom: 1.1Gi × 1.35 ≈ 1.49Gi → **limit 1.5Gi**, request = limit. The Phase 0 guess survives — not because we were smart, but now it's *evidence*, not luck.

**Heap cross-check.** Does the JVM's slice fit? `MaxRAMPercentage=65` of 1536Mi ≈ **1000Mi max heap**. Observed heap p99 was 780Mi — 220Mi of heap headroom, fine. Non-heap observed ~350Mi (metaspace 140Mi, threads, code cache, direct buffers), so worst case 1000 + 350 = 1350Mi < 1536Mi limit. The percentage stays at 65. If heap p99 had been 950Mi we'd be one promotion spike from GC thrash — raise the limit or trim the heap, per the RSS-budget method in [JVM Memory Knobs](/tuning/jvm-memory-knobs/).

**CPU request.** p95 usage 750m per pod at target load → round up to **request 800m**. Still **no CPU limit**: throttle ratio was zero, latency is the SLO, and a limit would tax exactly the tail we're being measured on. If platform policy forces one, set it ≥ 2× request and watch the throttle ratio like a hawk ([Requests & Limits Knobs](/tuning/requests-limits-knobs/) has the policy-negotiation angle).

The result — every number annotated with the measurement it came from:

```yaml
# Phase 2 — each value traceable to the Phase 1 table
resources:
  requests:
    cpu: 800m           # p95 usage 750m at 100 req/s/pod, rounded up
    memory: 1.5Gi       # working_set plateau 1.1Gi × 1.35
  limits:
    memory: 1.5Gi       # request == limit: no overcommit surprises
    # no cpu limit      # throttle ratio 0; p99 SLO says never throttle
startupProbe:
  httpGet: { path: /actuator/health/readiness, port: 8080 }
  periodSeconds: 5
  failureThreshold: 16  # slowest start 38s × 2 ≈ 80s budget
readinessProbe:
  httpGet: { path: /actuator/health/readiness, port: 8080 }
  periodSeconds: 5
  failureThreshold: 3   # 15s to leave rotation on real failure
  timeoutSeconds: 2     # request p99 180ms → 10× margin
livenessProbe:
  httpGet: { path: /actuator/health/liveness, port: 8080 }
  periodSeconds: 10
  failureThreshold: 3   # 30s of sustained deadness before restart
  timeoutSeconds: 2     # max observed GC pause 14ms — no contest
```

:::note[Round up, and to boring numbers]
750m → 800m, 1.49Gi → 1.5Gi. Requests like `783m` imply a precision the data doesn't have and make every later diff noisy. Sizing has maybe one significant figure of real accuracy; act like it.
:::

## Phase 3 — HPA on top

The knee was ~150 req/s per pod; we want scaling to kick in well before that. Target **70% of the 800m request = 560m**, which the Phase 1 data says corresponds to ~75 req/s per pod — half the knee. Comfortable.

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: orders-api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: orders-api
  minReplicas: 3        # HA: one per zone; NOT derived from load
  maxReplicas: 6        # Postgres pool math, see below
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70   # 70% × 800m = 560m ≈ 75 req/s/pod, half the knee
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      policies: [{ type: Pods, value: 2, periodSeconds: 60 }]
    scaleDown:
      stabilizationWindowSeconds: 300   # ≥ startup budget: don't shed pods you'll re-pay 80s to recreate
```

Three judgment calls worth spelling out:

- **minReplicas comes from availability, not load.** 200 req/s ÷ 75 = 2.7 pods, so load says 3 — but even if load said 1, you'd run 2–3 for zone spread and drain tolerance ([High Availability](/workloads/high-availability/)). Bump the PDB to `minAvailable: 2` to match.
- **maxReplicas comes from the weakest dependency.** Each pod holds a Hikari pool of 10 Postgres connections. The database allows orders-api a budget of 80 of its `max_connections`. 6 pods × 10 = 60 connections — safe. `maxReplicas: 10` would let a traffic spike convert into a connection-exhaustion outage *for every service sharing that database*. Autoscaling amplifies whatever the pods do downstream; [Autoscaling](/workloads/autoscaling/) covers this trap in depth.
- **Scale-down waits 5 minutes** — longer than the 80s startup budget, so a jittery graph doesn't churn pods that cost 80 seconds each to bring back.

:::caution[The request–HPA coupling]
`averageUtilization` is a percentage **of the CPU request**. If someone later "tidies" the request from 800m to 400m, the HPA's trigger point silently drops from 560m to 280m and the fleet doubles. Requests and HPA targets are one system — retune them together, never separately. Details in [Autoscaling](/workloads/autoscaling/) and [Requests & Limits Knobs](/tuning/requests-limits-knobs/).
:::

## Phase 4 — verify under failure, not just load

The load test proved the happy path. Production is the unhappy path. Four drills, still in the dev namespace, all at simulated peak (200 req/s):

**1. Kill a pod at peak.** `kubectl delete pod orders-api-<x>`. With 3 pods at ~67 req/s each, the survivors jump to 100 req/s — the Phase 1 table says that's 750m and p99 180ms, inside SLO. Watch for errors during the *death*, not after: the preStop sleep plus Spring's graceful shutdown must cover endpoint-removal propagation. Errors during the kill mean your shutdown sequence, not your capacity, is wrong.

**2. Rolling deploy at peak.** With `maxSurge: 1, maxUnavailable: 0`, each new pod costs one startup budget: 3 pods × ~40–80s ≈ 2–4 minutes per deploy. If that's too slow, raise `maxSurge` — but then you need scheduler headroom for the surge pods. Verify p99 stays under 250ms for the *whole* rollout; the surge/readiness interplay is in [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/).

**3. Dependency blip.** Stall the downstream API for 60 seconds (a fault-injection sidecar, or just scale its dev deployment to zero). The correct outcome: orders-api returns fast 5xx/fallbacks for affected requests and **all pods stay Ready**. If readiness drops fleet-wide, your readiness check includes the downstream dependency — every pod fails the same check at once, and instead of degraded service you get *no* service. Readiness should assert "this pod is worse than its siblings", not "the world is healthy". This is the single most common probe-design bug; see [Health Check Knobs](/tuning/health-check-knobs/).

**4. GC pause vs. liveness.** Worst observed pause was 14ms against a 2s probe timeout — three orders of magnitude of margin. The real risk is a full-GC death spiral (back-to-back multi-second pauses when the heap is nearly exhausted), where liveness kills a pod that was busy, not dead. Our heap cross-check in Phase 2 (780Mi p99 in a 1000Mi heap) is the actual defense; the failure mode is dissected in [GC and Performance](/java/gc-and-performance/).

:::tip[One hour, once]
These four drills take about an hour and are the difference between "we sized it" and "we proved it". Every number from Phases 2–3 gets exercised: startup budget (drill 2), readiness semantics (drill 3), PDB and shutdown (drill 1), liveness margin (drill 4).
:::

## Phase 5 — productionize the feedback loop

Sizing decays. Traffic grows, a dependency gets slower, a library update fattens the heap. Ship the numbers *with* their guardrails.

**Four dashboard panels**, one per number we derived:

```text
# 1. Memory headroom: working set as % of limit (sized to plateau ~73%)
container_memory_working_set_bytes{container="orders-api"}
  / on(pod) kube_pod_container_resource_limits{resource="memory",container="orders-api"}

# 2. CPU vs request + throttle ratio (throttle must stay 0 — no limit exists)
rate(container_cpu_usage_seconds_total{container="orders-api"}[5m])
  / on(pod) kube_pod_container_resource_requests{resource="cpu",container="orders-api"}

# 3. Restarts by reason (any OOMKilled invalidates the memory sizing)
increase(kube_pod_container_status_restarts_total{container="orders-api"}[1h])

# 4. HPA position: replicas vs maxReplicas, alongside request p99
kube_horizontalpodautoscaler_status_current_replicas{horizontalpodautoscaler="orders-api"}
```

**Three alerts** that fire *before* the sizing fails (thresholds derived from our own numbers; wiring in [Alerting](/observability/alerting/)):

- **Working set > 90% of limit for 15m** — we sized for ~73%; 90% means the working set grew ~25% past the measured plateau. Re-size before the OOM killer does it for you.
- **Throttle ratio > 5%** — should be impossible with no CPU limit, which is exactly why it's a great alert: it fires when a LimitRange or a well-meaning teammate injects one.
- **Any restart increase over 1h** — a Guaranteed-memory pod with 10×-margin probes should restart only on deploys. Anything else is an OOM, a liveness kill, or a crash, and all three mean a Phase 2 number is stale.

And two rituals:

- **Quarterly re-size**: rerun the Phase 1 PromQL over the last 90 days of *production* data and re-derive Phase 2. Twenty minutes; usually a no-op; occasionally catches 30% quota waste or a working set that quietly grew to 95%.
- **After every incident and every major dependency bump**, re-check the two fragile couplings: startup time vs. startup budget, and heap p99 vs. the 65% slice.

Every change from either ritual goes through git and a normal rollout — a resources edit *is* a deploy, with everything that implies. The live-change procedure (and in-place resize on newer clusters) is in [Resource Tuning in Prod](/operations/resource-tuning-in-prod/).

## The transferable checklist

The whole walkthrough, compressed. Numbers in parentheses are orders-api's, so you can see the shape of a "done" answer:

1. Start oversized-but-bounded: generous CPU request, no CPU limit, memory request = limit, `MaxRAMPercentage` 65 (1 CPU / 1.5Gi / 65%).
2. Startup-heavy probes from the archetype recipes; 2 replicas + PDB before first deploy (3-min budget, `minAvailable: 1`).
3. Load test past target peak with a hold phase; overshoot to find the knee (200 req/s target, knee at 150/pod).
4. Record: startup p99, latency p50/p99, working-set plateau, CPU p95, throttle ratio, GC log (38s / 180ms / 1.1Gi / 750m / 0% / 14ms).
5. Startup budget = slowest start × 2 → `failureThreshold × periodSeconds` (38s × 2 → 16 × 5s).
6. Memory limit = working-set p99 × 1.3–1.5, request = limit (1.1Gi × 1.35 → 1.5Gi).
7. Cross-check: heap % of limit vs. observed heap p99 + non-heap (1000Mi vs 780 + 350 — fits).
8. CPU request = p95 usage, rounded up; keep no CPU limit if policy allows (750m → 800m).
9. HPA: target ~70% of request; minReplicas from HA; maxReplicas from downstream capacity (70% / 3 / 6-from-Postgres-pool).
10. Scale-down stabilization ≥ startup budget (300s ≥ 80s).
11. Drill it: pod kill, rolling deploy, and dependency blip at peak; GC pause vs. liveness margin.
12. Guard it: 4 panels, 3 alerts, quarterly re-derive, everything through git.

And the three numbers you must **never** set without a measurement, because guessing them wrong fails silently until it fails completely:

- **The startup budget** — guessed too low, it boot-loops your slowest starts, and only on the worst days.
- **The memory limit** — guessed too low, the OOM killer erases the evidence; too high, you never notice the leak growing into the slack.
- **The HPA utilization target** — guessed without knowing the knee, it either scales too late to save your p99 or stampedes your database pool.

Everything else has a safe default. These three only have *your* numbers.
