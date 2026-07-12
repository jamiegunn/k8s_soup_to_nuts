---
title: Autoscaling on One Page (+ FAQ)
description: The whole playbook condensed — signal table, formula box, golden values, glossary — plus the questions everyone asks, answered in three sentences each.
keywords:
  - why can't i scale on memory jvm
  - do i need keda or is hpa enough
  - can i just set maxreplicas to 100
  - why does my hpa say unknown
  - does autoscaling work if prometheus is down
  - hpa vs vpa vs keda difference
  - what if we don't have slos
  - autoscaling cheat sheet kubernetes
sidebar:
  order: 16
---

Everything condensed; every cell links to the page that earns it. Top half: the tables. Bottom half: the FAQ.

## The ladder, five lines

```text
user behavior → symptom → SLI (the measurement) → SLO (the promise) → signal + threshold
```

Can't start at the top? The [fallback ladder](/autoscaling/slos-for-scaling/#the-fallback-ladder): user-impact SLO → proxy ("today's p95 + 25%, PROVISIONAL") → system objective, written down with a TODO. Any level passes review — *stated*.

## Signals at a glance

| Signal | Verdict | For | Trap |
|---|---|---|---|
| CPU utilization | **scale** — if measured CPU-bound | compute-heavy APIs | lies for apps that wait on Oracle/MQ |
| Queue depth | **scale** — external metric (exporter+adapter, or KEDA) | consumers | raw depth ignores message cost; use lag-time when cost varies |
| Busy threads | **scale** — custom metric | wait-bound Spring apps (most of this stack) | needs `mbeanregistry.enabled` + a deliberate pool max |
| RPS per pod | **scale** — with a measured knee | uniform-cost APIs | knee moves when endpoint mix shifts |
| Latency p95 | **alert only — it's the SLI** | everything | scaling on it oscillates (cold pods worsen it) |
| Memory / heap delta | **rightsize + alert. NEVER scale.** | every JVM | JVM keeps heap → HPA ratchets to max forever |
| `hikaricp_connections_pending` | **alert + ceiling input** | Oracle-backed | "pods or pool" — decide with threads |

Full catalog with observe/decide loops: [The Numbers That Matter](/autoscaling/signals-catalog/).

## Mechanisms in one sentence each

| | One sentence | Reach for it when |
|---|---|---|
| **HPA on CPU** | The built-in autoscaler on the built-in metric — zero setup | measured CPU-bound, or the [quick start](/autoscaling/quick-start/) |
| **HPA on custom metric** | Same autoscaler fed your app's numbers through prometheus-adapter | the platform's granted mechanism is the adapter |
| **KEDA** | An operator that watches things Kubernetes can't see (queues, Prometheus, Dynatrace) and drives an HPA for you | the platform granted KEDA — or you need scale-to-zero (KEDA-only) |
| **VPA** | Resizes *requests* instead of adding copies | recommendation mode only — a [sizing consultant](/workloads/autoscaling/#vpa-mostly-not-yours) |

Neither adapter nor KEDA ships with the cluster — both are **named asks**, and a cluster runs at most one external-metrics server. Check what exists before designing: [the fork](/autoscaling/getting-the-metrics/#5-the-fork-adapter-or-keda).

## The formula box

```text
SLO → target      target = signal reading at SLO boundary − headroom for
                  (reaction ~30s + JVM warmup ~90s) of load growth        → /autoscaling/slos-for-scaling/

states → min/max  minReplicas = ceil(trough ÷ per-pod capacity), HA floor 2
                  maxReplicas = ceil(peak × growth ÷ per-pod capacity),
                                capped by the SMALLEST external ceiling    → /autoscaling/load-profile/

Oracle ceiling    maxReplicas ≤ (session budget − failover headroom
                                 − other consumers) ÷ maximumPoolSize      → /autoscaling/rest-api-oracle/

queue trigger     queueDepth = (drain rate/pod × SLO minutes) ÷ ~2 safety  → /autoscaling/messaging-consumers/

grace period      tGPS ≥ preStop + prefetch × worst msg time + margin      → /autoscaling/messaging-consumers/

the invariant     Σ teams (maxReplicas × requests) + system + 1-node
                  reserve ≤ allocatable                                    → /autoscaling/capacity-and-governance/
```

## The state table template

| State | Measured | Sets |
|---|---|---|
| Low (trough) | ___ rps @ ___–___ h | minReplicas |
| Steady | ___ rps | target headroom check |
| Peak (recurring) | ___ rps @ ___ | maxReplicas pre-cap |
| Burst (rare) | ___ rps, when: ___ | behavior policies + event plan |
| Growth | ___%/quarter | margin + re-measure date |

Queries to fill it: [load profile](/autoscaling/load-profile/). Consumers: same table on *arrival rate*.

## Golden values skeleton

```yaml
autoscaling:
  enabled: false      # turning on is a reviewed act
  minReplicas: <n>    # derivation: trough ÷ per-pod capacity, HA floor 2
  maxReplicas: <n>    # derivation: min(peak math, <NAMED external ceiling + owner>) — REQUIRED
  targetCPU: <n>      # derivation: knee at SLO boundary − lag headroom; SLO level stated
  behavior:           # JVM-safe: up 2 pods/min, down 1 per 2min after 300s window
priorityClassName: <tier by SLO>
```

Full version with the reasoning: [governance](/autoscaling/capacity-and-governance/#the-golden-values). The two copyable checklists: [prerequisites](/autoscaling/prerequisites/#the-summary-table) (before you build) and [the review gate](/autoscaling/capacity-and-governance/#the-review-checklist) (before it merges); the fill-in [classification card](/autoscaling/classify-your-app/#the-classification-card) (what you're scaling). Chart audit, one row per item: replicas gated · resources from values · probes tunable · grace/preStop tunable · HPA/ScaledObject in chart · PDB · priorityClassName · stable names — [graded Bronze/Silver/Gold](/autoscaling/classify-your-app/#part-3--is-the-chart-ready).

## Top-5 PromQL

```promql
# 1 — p95 (the shape for any percentile). Answers: what are my unluckiest 5% seeing?
#     Worsens exactly at scale-out moments → cold pods (/autoscaling/spring-boot-scaling/)
histogram_quantile(0.95, sum by (le) (rate(http_server_requests_seconds_bucket{service="payments-api"}[5m])))
# 2 — busy-thread ratio (the wait-bound scaling signal). Sustained > 0.75 → scaling
#     should already be happening; pinned at 1.0 → already queueing, scaling is late
avg(tomcat_threads_busy_threads / tomcat_threads_config_max_threads)
# 3 — HPA pinned at max (returns 1 while pinned). 30+ min of 1 → capacity
#     conversation with the ceiling's owner, NOT a bigger number in YAML
kube_horizontalpodautoscaler_status_current_replicas >= bool on(horizontalpodautoscaler)
  kube_horizontalpodautoscaler_spec_max_replicas
# 4 — flapping detector. > 6 desired-count changes/hour → wrong signal or bad
#     windows: run the signal audit (/autoscaling/signals-catalog/)
changes(kube_horizontalpodautoscaler_status_desired_replicas[1h]) > 6
# 5 — hoarding index (reserved vs used — the citizenship number). ~0.5 at steady
#     state = healthy burst headroom; 0.85+ sustained = the true-up will ask
1 - sum(rate(container_cpu_usage_seconds_total{namespace="payments"}[1h]))
    / sum(kube_pod_container_resource_requests{namespace="payments", resource="cpu"})
```

## Mini-glossary

| Term | One plain sentence |
|---|---|
| HPA | The built-in controller that adds/removes copies of your pod to keep one number near a target. |
| Request | The slice of a node reserved for your pod — reserved whether used or not; the HPA's math is a percentage *of this*. |
| prometheus-adapter | The platform add-on that teaches the HPA's own metrics APIs to answer from Prometheus — the KEDA-less bridge to custom/external signals. |
| ScaledObject | KEDA's object: which Deployment to scale, on which external number, between which bounds. |
| TriggerAuthentication | KEDA's pointer at the Secret holding the credentials a scaler polls with. |
| Scrape | Prometheus visiting your app's `/actuator/prometheus` URL on a schedule to collect its numbers. |
| ServiceMonitor | The object that tells Prometheus to scrape you; ships in your chart. |
| p95 | The time 95 of 100 requests beat — your unluckiest 1-in-20 user's experience. |
| SLI / SLO | The measurement / the promise stated on it over a window. |
| Stabilization window | How long the HPA waits before acting on a scale-down opinion — the anti-flapping knob. |
| Prefetch | Messages the broker hands a consumer in advance; also your scale-in blast radius. |
| Connection pool | A pod's fixed set of open database sessions — pool × replicas is what Oracle experiences. |
| Freshness | The consumer SLO shape: "processed within N minutes" — converts directly into a queue-depth trigger. |
| Allocatable | What a node offers pods after system reserves — the real denominator of the capacity invariant. |

## FAQ

### Why can't I scale on memory?

The JVM claims heap and doesn't give it back when load drops, so a memory-triggered HPA sees a number that only rises: it scales up in the morning and never scales down, pinned at maxReplicas by lunch. Memory is a *rightsizing* signal. [The ratchet, in full](/autoscaling/signals-catalog/#jvm-heap-vs-pod-memory--the-delta).

### Do I need KEDA, or is the HPA enough?

Plain HPA on CPU needs nothing extra ([quick start](/autoscaling/quick-start/)). Any better signal needs exactly one bridge, and your cluster ships with neither: **prometheus-adapter** (HPA-native, query in platform config, no scale-to-zero) or **KEDA** (query in your PR, polls brokers/Dynatrace directly, scale-to-zero). KEDA doesn't replace the HPA; it feeds one — and so does the adapter. Check what your cluster has, then ask for what it lacks: [the fork](/autoscaling/getting-the-metrics/#5-the-fork-adapter-or-keda).

### Can I just set maxReplicas to 100?

On this platform that's a claim of `100 × your requests` against a fixed shared pool, and `100 × your pool size` against Oracle's session budget — both ledgers other teams draw on. The ceiling is a derived number with an owner's name on it, or it fails review. [The math](/autoscaling/rest-api-oracle/#the-pool-math), [the ledger](/autoscaling/capacity-and-governance/).

### Why does my HPA say `<unknown>`?

For the first ~30 seconds after creation: normal. Persisting: the metrics pipeline is broken beneath it — missing requests, metrics-server down, scrape failing, adapter misconfigured. [The runbook](/troubleshooting/hpa-not-scaling/) starts from exactly this symptom; [the pipeline page](/autoscaling/getting-the-metrics/) is the repair manual.

### Does autoscaling keep working if Prometheus is down?

CPU-based HPAs: yes (they ride metrics-server, a separate path). Custom-metric HPAs and KEDA prometheus triggers: no — the HPA freezes (or KEDA applies your `fallback`). Which is why [the pipeline gets its own alerts](/autoscaling/getting-the-metrics/#pipeline-health--alert-on-the-pipe-itself) and `fallback` is decided before the outage.

### HPA vs VPA vs KEDA, once and for all?

HPA changes *how many* pods; VPA changes *how big* each pod's requests are; KEDA watches numbers the HPA can't see and drives an HPA for you. On this stack: HPA and KEDA scale, VPA (recommendation mode) advises sizing. Never VPA-on-CPU and an HPA-on-CPU on the same Deployment — [they fight](/workloads/autoscaling/#vpa-mostly-not-yours).

### How do I scale on a business metric?

Emit it with a Micrometer counter/gauge (~15 lines), let the existing scrape collect it, then point your mechanism at it — a recording rule behind the adapter, or a KEDA prometheus trigger. No special machinery — [business metrics are scaling metrics](/autoscaling/getting-the-metrics/#custom-metrics--when-and-how) once they're in the pipeline.

### Will scaling my app break Oracle/MQ?

It can — that's this section's central warning. Every pod multiplies connections against fixed external budgets; the ceiling math ([Oracle](/autoscaling/rest-api-oracle/), [MQ](/autoscaling/messaging-consumers/#the-mq-side-ceiling), [Redis](/autoscaling/web-worker-and-caches/#connection-multiplication--the-ceiling-rhyme-third-verse)) exists so the answer becomes "no, and here's the arithmetic."

### What if we don't have SLOs?

Start anyway, honestly: today's p95 + 25% as a PROVISIONAL target, or even a bare system objective — *written down, with an upgrade TODO*. The [fallback ladder](/autoscaling/slos-for-scaling/#the-fallback-ladder) exists precisely so missing SLOs never block safe scaling — and writing the objective down is what starts the conversation that produces real ones.

### Where do I actually start?

[The overview's ways-in table](/autoscaling/overview/), [a scenario that sounds like your week](/autoscaling/scenarios/), or — to feel it all on a laptop first — [Lab 10](/labs/lab-10-autoscaling/).
