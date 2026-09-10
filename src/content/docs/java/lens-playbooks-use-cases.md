---
title: "Three Lenses, Tactically I: The Use Cases"
description: Twelve questions a delivery team actually asks — are customers happy, is this release good, can we take the peak, is it us or the platform, are we leaking, are we paying for what we use, can we trust the dashboard, why were we paged, will scaling help, is the JVM sized right, are we ready to be drained, are we ready for on-call — each answered with the exact commands, then the symptoms to rule out, in order, with the one number that rules each in.
keywords:
  - are customers happy slo query promql
  - error budget burn rate promql http_server_requests
  - is the release good rollback decision commands
  - can we handle peak traffic capacity headroom kubernetes
  - is it us or the platform kubernetes
  - memory leak predict_linear time to oom
  - are we over requesting cpu memory kubernetes cost
  - can we trust prometheus dashboard up absent
  - what happened overnight kubernetes events restarts
  - will adding replicas help shared bottleneck
  - is my jvm sized right checklist
  - ready for node drain checklist pdb
  - on-call readiness checklist jvm kubernetes
sidebar:
  order: 10.1
---

You are here if: someone asked you a question — "are customers happy?", "can we run the promo on Friday?", "is it us or the platform?" — and you want the commands that answer it, and then the list of things to rule out when the answer is *no*; or you're on call and want to start from the question instead of from a graph.

This page is the front door to the tactical trilogy. A **use case** is a question a person asks — a product owner, an incident commander, the platform team, you at the end of a shift. A **symptom** is a number that's wrong — memory climbing, p99 on fire, one pod slower than its siblings. You start from the question, because that is where you actually start; the symptoms are what you rule out, in an order, once the question's answer is *no*. The symptoms live on [the symptom page](/java/lens-playbooks-diagnose/) as eight walks with the commands and the console output; the sizing and scaling procedures live on [the third page](/java/lens-playbooks-size-and-scale/). This page lists, under each question, exactly which of those to run and in which order — with the *one number* that rules each in or out, so the walk you take is the shortest one.

Same cast and assumptions as the other two pages: `payments-api` (Spring Boot 3.3 / Java 21, JRE-only image, HikariCP → external Oracle, SLO **99.9% of requests < 800 ms over 28 days**), with `dispatch-worker`, `notify-worker`, and `catalog-web` where the question is theirs; jattach for the inside lens, prometheus-adapter and no KEDA for scaling; [the toolkit](/java/lens-playbooks-diagnose/#the-toolkit-set-up-once) — `$NS`, `$POD`, `$JPID`, `$JATTACH`, `pq`, `pqr`, the flags, the histograms — set up. Every command carries the site's [seat marker](/disruption/overview/#who-owns-what).

| # | The question | Who asks it | The symptoms under it | The artifact |
|---|---|---|---|---|
| 1 | [Are customers happy?](#1-are-customers-happy) | the product owner, you before anything else | 3 · 2 · 6 · 4 · 5, then the front door | the SLO card |
| 2 | [Is this release good — or do we roll back?](#2-is-this-release-good--or-do-we-roll-back) | the deployer, in the 30 minutes after | 3 · 1 · 7 · 5 · 2 | the release table |
| 3 | [Can we take the peak?](#3-can-we-take-the-peak) | the on-call lead before Friday, the promo, month-end | the four ceilings, then 6 · 2 · the signal audit | the headroom table |
| 4 | [Is it us or the platform?](#4-is-it-us-or-the-platform) | the incident commander at minute five | 4 · 2 · 1, then the disruption decoder | the blame table → the evidence pack |
| 5 | [Are we leaking — will it be alive on Monday?](#5-are-we-leaking--will-it-be-alive-on-monday) | the weekly review, the end of a shift | 1 · 7 · 6 (the leak variant) | the time-to-wall table |
| 6 | [Are we paying for what we use?](#6-are-we-paying-for-what-we-use) | the capacity review, the ledger | the sizing procedure, then the floor question | the citizenship table |
| 7 | [Can we trust the dashboard?](#7-can-we-trust-the-dashboard) | anyone, before believing a flat line | 8, then the bucket and shutter traps | the trust checklist |
| 8 | [Why did we get paged at 3 a.m.?](#8-why-did-we-get-paged-at-3-am) | the on-call, the postmortem author | 1 · the eviction decoder · 5 · 3 · 2 | the timeline |
| 9 | [Will adding replicas help?](#9-will-adding-replicas-help) | the hand on `kubectl scale` | 6 · 2 · 4, then the signal audit | the per-pod-throughput table |
| 10 | [Is the JVM sized right?](#10-is-the-jvm-sized-right) | the reviewer of a values file | 5 · 1 (the budget branch) · 2 | the sizing scorecard |
| 11 | [Are we ready to be drained?](#11-are-we-ready-to-be-drained) | the platform's window announcement | the four-check gate's failure modes | the drain-readiness card |
| 12 | [Are we ready for on-call?](#12-are-we-ready-for-on-call) | the new rotation, the night before | nothing to rule out — eight proofs | the readiness card |

Symptom numbers refer to [the symptom page](/java/lens-playbooks-diagnose/): **1** memory climbing / OOMKilled · **2** CPU idle but p99 on fire · **3** latency regressed after a deploy · **4** one pod slower than its siblings · **5** is GC the problem · **6** pool exhaustion · **7** thread leak · **8** no data. The procedures on [the size-and-scale page](/java/lens-playbooks-size-and-scale/) are **P1** size from data, **P2** pick and prove a scaling signal, **P3** the evidence pack.

## 1. Are customers happy?

**Who asks, and when.** The product owner in the Monday review; the on-call before touching anything else; you, when a graph looks wrong and you need to know whether a *person* has noticed. The honest answer is the SLI against the SLO — not a CPU panel — and it has three time scales: right now, today, and the 28-day promise.

**What answers it.** The fraction of requests under 800 ms, the same fraction over the SLO window, how much error budget is left and how fast it's burning, which route is breaking the promise, and the errors — because a `500` in 20 ms is inside the latency SLO and still an unhappy customer.

```bash
# seat: tenant — the SLI (fraction under 800 ms, health routes excluded) at three scales: now, today, the 28-day promise
SLI='sum(rate(http_server_requests_seconds_bucket{namespace="payments", service="payments-api", uri!~"/actuator.*", le="0.8"}[WINDOW])) / sum(rate(http_server_requests_seconds_count{namespace="payments", service="payments-api", uri!~"/actuator.*"}[WINDOW]))'
for w in 5m 1d 28d; do printf '%s\t' "$w"; pq "${SLI//WINDOW/$w}"; done
# the burn rate: 1.0 = spending the budget at exactly the rate that empties it in 28 days; 14 = gone in two days (the alerting page's page threshold)
pq "(1 - (${SLI//WINDOW/1h})) / 0.001"
# which route is breaking the promise
pq 'sum by (uri) (rate(http_server_requests_seconds_bucket{namespace="payments", service="payments-api", uri!~"/actuator.*", le="0.8"}[5m])) / sum by (uri) (rate(http_server_requests_seconds_count{namespace="payments", service="payments-api", uri!~"/actuator.*"}[5m]))'
# and the errors, which the latency SLI doesn't see
pq 'sum(rate(http_server_requests_seconds_count{namespace="payments", service="payments-api", status=~"5.."}[5m])) / sum(rate(http_server_requests_seconds_count{namespace="payments", service="payments-api"}[5m]))'
```

```console
5m	-	0.9912
1d	-	0.9987
28d	-	0.99931
-	3.6
/api/checkout	0.9842
/api/quotes	0.9996
-	0.0041
```

Read it top down. Right now, 0.9912 — below the promise; today, 0.9987 — below it too; the 28-day window still reads 0.99931, so the promise is *technically* kept, on a budget being spent at 3.6× the sustainable rate: an hour like this costs three and a half hours of budget. One route is doing it — `/api/checkout` at 0.9842 while `/api/quotes` is fine — and 0.4% of requests are failing outright. So: customers on checkout are not happy, and if this hour becomes a day the 28-day number goes too. (For `catalog-web` the same three queries with `le="1.0"`; for `dispatch-worker` the SLI is freshness, not latency — backlog ÷ drain rate against the five-minute promise, [the consumer page's arithmetic](/autoscaling/messaging-consumers/#the-trigger-number-from-the-freshness-slo).)

**Rule out, in order.** The symptoms under this question, ordered by how often each is the answer and how cheap it is to check:

| Order | Symptom | The one number that rules it in | If it does |
|---|---|---|---|
| 1 | [3 · latency regressed after a deploy](/java/lens-playbooks-diagnose/#3-latency-regressed-after-a-deploy) | `kubectl rollout history deployment/payments-api -n $NS \| tail -2` — a revision in the last hours, and p95 `offset` to before it | the release table, then [Card A](/operations/emergency-playbooks/#card-a-bad-deploy-going-out-right-now) |
| 2 | [2 · CPU idle, p99 on fire](/java/lens-playbooks-diagnose/#2-cpu-looks-idle-but-p99-is-on-fire) | throttle ratio > 0.05, or busy threads / max > 0.9 with pending 0 | the quota, or the downstream stall |
| 3 | [6 · pool exhaustion](/java/lens-playbooks-diagnose/#6-connection-pool-exhaustion-against-oracle) | `hikaricp_connections_pending` > 0 on every pod | the pool timeline |
| 4 | [4 · one pod slower than its siblings](/java/lens-playbooks-diagnose/#4-one-pod-is-slower-than-its-siblings) | p99 by pod: one pod ≥ 3× the others at the same RPS | the pod-vs-fleet table |
| 5 | [5 · is GC the problem](/java/lens-playbooks-diagnose/#5-is-gc-the-problem) | `jvm_gc_pause_seconds` p99 > 200 ms, after the throttle ratio said no | the GC table |
| 6 | not us at all | the 5xx are minted by the ingress, not the app: [fingerprint who minted the error](/troubleshooting/front-door-5xx/#step-1-fingerprint-who-minted-the-error) | the front-door runbook |

**The artifact — the SLO card.**

| Number | Value | Source |
|---|---|---|
| SLI now / today / 28 d | 0.9912 / 0.9987 / 0.99931 (SLO 0.999) | L2 histogram |
| Burn rate (1 h) | 3.6× | L2 |
| Worst route | `/api/checkout` 0.9842 | L2 |
| 5xx ratio | 0.41% | L2 counter |
| Verdict | no — checkout, since ~14:00; budget holds for now | — |

**Decide.** Burn rate ≥ 14 → this is a page, and the symptoms above are the order; 1–14 → a ticket today, same order, less hurry; < 1 with the 28-day number green → customers are happy — spend the hour on question 3 or 6 instead. And write the burn-rate alert if it doesn't exist ([the two-window version](/observability/alerting/#symptom-alerts-red-on-your-own-metrics)), because the product owner should never be the one who tells you.

## 2. Is this release good — or do we roll back?

**Who asks, and when.** The person who ran `helm upgrade`, in the thirty minutes after; the release manager at the go/no-go; the next day's on-call, who inherits whatever the release shipped slowly. A release is good when the fast numbers are flat over thirty minutes *and* the slow poisons — memory and threads — are flat over a day.

**What answers it.** Did the rollout finish; the same five numbers before and after it, by route; and the slope of the two things a release can leak.

```bash
# seat: tenant — did it finish, and when (the new ReplicaSet's age is your offset)
kubectl rollout status deployment/payments-api -n $NS --timeout=1s
kubectl get rs -n $NS -l app.kubernetes.io/name=payments-api --sort-by=.metadata.creationTimestamp -o custom-columns=RS:.metadata.name,DESIRED:.spec.replicas,READY:.status.readyReplicas,CREATED:.metadata.creationTimestamp | tail -2
# after vs before, by route: the last 15 minutes against the 15 minutes that ended an hour ago (adjust to the rollout time)
pq 'histogram_quantile(0.95, sum by (le, uri) (rate(http_server_requests_seconds_bucket{namespace="payments", service="payments-api", uri!~"/actuator.*"}[15m])))'
pq 'histogram_quantile(0.95, sum by (le, uri) (rate(http_server_requests_seconds_bucket{namespace="payments", service="payments-api", uri!~"/actuator.*"}[15m] offset 1h)))'
pq 'sum(rate(http_server_requests_seconds_count{namespace="payments", service="payments-api", status=~"5.."}[15m])) / sum(rate(http_server_requests_seconds_count{namespace="payments", service="payments-api"}[15m]))'
# the slow poisons: working-set slope and thread slope since the rollout, in MiB/h and threads/h — and restarts
pq 'max by (pod) (deriv(container_memory_working_set_bytes{namespace="payments", container="payments-api"}[30m])) * 3600 / 1024 / 1024'
pq 'deriv(jvm_threads_live_threads{namespace="payments", service="payments-api"}[30m]) * 3600'
pq 'sum(increase(kube_pod_container_status_restarts_total{namespace="payments", container="payments-api"}[30m]))'
```

```console
deployment "payments-api" successfully rolled out
payments-api-7c9d4f6b8   0   0        2026-09-09T11:02:17Z
payments-api-5d8f7c9b4   3   3        2026-09-10T14:05:41Z
/api/checkout	0.74
/api/quotes	0.40
/api/checkout	0.71
/api/quotes	0.39
-	0.0011
payments-api-5d8f7c9b4-m4kqx	2.1
payments-api-5d8f7c9b4-w9dzt	1.8
payments-api-5d8f7c9b4-x2rnc	2.4
payments-api-5d8f7c9b4-m4kqx	0
payments-api-5d8f7c9b4-w9dzt	0
payments-api-5d8f7c9b4-x2rnc	0
-	0
```

Rolled out at 14:05; p95 within 30 ms of before on both routes; errors at 0.1%; the working set climbing ~2 MiB/h on every pod — a fresh JVM warming its code cache and metaspace, not a leak, which is the same slope you'd see on any day's first hour — threads flat, no restarts. Good, so far: the thirty-minute answer. The one-day answer is the same three slope queries tomorrow at this hour, and *that* is the check most teams skip.

**Rule out, in order.**

| Order | Symptom | The one number that rules it in | If it does |
|---|---|---|---|
| 1 | [3 · latency regressed after a deploy](/java/lens-playbooks-diagnose/#3-latency-regressed-after-a-deploy) | one route's p95 after ≥ 1.5× before, image-only change | JFR `hot-methods` on the ring buffer, then roll back or forward |
| 2 | [1 · memory keeps climbing](/java/lens-playbooks-diagnose/#1-memory-keeps-climbing-and-the-pod-gets-oomkilled) | working-set slope still > 10 MiB/h *after the first hour*, live set climbing with it | the histogram diff on one pod — before the night does the OOMKill for you |
| 3 | [7 · thread leak](/java/lens-playbooks-diagnose/#7-a-thread-leak) | thread slope > 0 an hour after the rollout | the name histogram: a new executor per event |
| 4 | [5 · is GC the problem](/java/lens-playbooks-diagnose/#5-is-gc-the-problem) | allocation rate after ≥ 2× before: `sum(rate(jvm_gc_memory_allocated_bytes_total[15m]))` vs `offset 1h` | `jfr view allocation-by-class` — a new hot spot |
| 5 | [2 · CPU idle, p99 on fire](/java/lens-playbooks-diagnose/#2-cpu-looks-idle-but-p99-is-on-fire) | busy threads / max after ≥ 1.5× before at the same RPS — the release added a wait | the dump: which new call the threads sit in |

**The artifact — the release table.** Before and after, one row per number above, plus a column for the same numbers 24 hours later. Its second column is what the go/no-go reads; its third is what stops the slow poison from becoming question 5.

**Decide.** Any fast row red inside thirty minutes → [Card A](/operations/emergency-playbooks/#card-a-bad-deploy-going-out-right-now): roll back now, understand later — unless the fix is a one-liner that ships inside the error budget. Fast rows flat → the release is provisionally good; the slow rows tomorrow make it good. A working-set slope that hasn't flattened by then is symptom 1, caught a day before it would have caught you.

## 3. Can we take the peak?

**Who asks, and when.** The on-call lead the week before a known event — the Friday peak, month-end, the marketing promo that "might triple traffic"; the product owner asking whether to run it at all. The answer is arithmetic against four ceilings, and only one of them is yours.

**What answers it.** Today's load per pod against the measured knee; the HPA's room to its ceiling; the last real peak and what it took; and the shared ceilings the HPA can't see — Oracle sessions, and the nodes.

```bash
# seat: tenant — load per pod now, against the knee (60 rps/pod measured, P1); the HPA's room; the last peak
pq 'sum(rate(http_server_requests_seconds_count{namespace="payments", service="payments-api", uri!~"/actuator.*"}[5m])) / count(kube_pod_info{namespace="payments", pod=~"payments-api.*"})'
kubectl get hpa payments-api -n $NS
pq 'max_over_time(sum(rate(http_server_requests_seconds_count{namespace="payments", service="payments-api", uri!~"/actuator.*"}[5m]))[7d:5m])'
pq 'max_over_time(kube_horizontalpodautoscaler_status_current_replicas{namespace="payments", horizontalpodautoscaler="payments-api"}[7d])'
# the shared ceiling the HPA can't see: Oracle sessions across every consumer of the budget
pq 'sum(hikaricp_connections{namespace="payments"})'
# seat: cluster-read — the nodes: CPU still unclaimed by requests, cluster-wide; ask if denied
pq 'sum(kube_node_status_allocatable{resource="cpu"}) - sum(kube_pod_container_resource_requests{resource="cpu"})'
```

```console
-	38.4
NAME           REFERENCE                 TARGETS                     MINPODS   MAXPODS   REPLICAS   AGE
payments-api   Deployment/payments-api   510m/750m, cpu: 48%/65%     2         16        3          41d
-	612
-	11
-	42
-	9.7
```

Then the arithmetic, written down where the ledger can read it:

```text
Forecast:   last peak 612 rps × promo 1.8 ≈ 1,100 rps
Knee:       60 rps/pod (P1, 2026-09-09) → 1,100 ÷ 60 = 18.4 → 19 pods
HPA:        maxReplicas 16 → ceiling reached at ~960 rps; the last 140 rps have nowhere to go
Oracle:     19 pods × pool 10 = 190 sessions; the namespace holds 42 now; our budget is 160 (the pool math) → 16 pods is the DB's answer too
Nodes:      19 × 250m = 4.75 cores of request against 9.7 unclaimed → fits, if nothing else grows
Verdict:    at 1,100 rps the promise breaks at the ceiling, and the ceiling is the database's, not ours
```

**Rule out, in order.** The ceilings first, then the symptoms that appear only at peak:

| Order | What | The one number that rules it in | If it does |
|---|---|---|---|
| 1 | the HPA ceiling | pods needed > `maxReplicas` | [the capacity conversation](/autoscaling/capacity-and-governance/#the-capacity-conversation) — raise it only inside the Oracle budget |
| 2 | the Oracle session budget | pods needed × `maximumPoolSize` > the budget | [the pool math](/autoscaling/rest-api-oracle/#the-pool-math): a smaller pool per pod, or a bigger budget from the DBA, before the promo — not during |
| 3 | [6 · pool exhaustion](/java/lens-playbooks-diagnose/#6-connection-pool-exhaustion-against-oracle) at the last peak | `max_over_time(hikaricp_connections_pending{…}[7d])` > 0 | the pool was the wall last time; it will be again, sooner |
| 4 | [2 · the quota](/java/lens-playbooks-diagnose/#2-cpu-looks-idle-but-p99-is-on-fire) at the last peak | `max_over_time` of the throttle ratio over 7 d > 0.05 | a LimitRange put a limit on you; get it removed before the event |
| 5 | the signal itself | [P2 — the signal audit](/java/lens-playbooks-size-and-scale/#2-pick-and-prove-an-hpa-signal-without-keda): did the busy ratio lead p95 at the last peak, or trail it? | re-prove the signal; a lagging signal scales you after the customers noticed |
| 6 | a drain during the peak | `kubectl get pdb -n $NS` — `ALLOWED DISRUPTIONS` and the HPA floor | [the 3 a.m. problem](/disruption/pod-disruption-budgets/#pdb-and-hpa-the-3-am-problem); ask the platform to hold the window |

**The artifact — the headroom table.** Forecast, knee, pods needed, each ceiling with its number, and the verdict — the block above, pasted into the ticket that asks for the ceiling. [The load profile's state table](/autoscaling/load-profile/#the-state-table--the-artifact) is where the forecast's inputs live; this is its peak-day instantiation.

**Decide.** Pods needed within every ceiling → yes, and watch question 1's burn rate during the event. Pods needed above *your* ceiling only → the capacity conversation, this week. Above the *database's* ceiling → the promo is a DBA conversation before it's a Kubernetes one — [the Oracle page](/autoscaling/rest-api-oracle/#the-pool-math) exists because scaling past that number is the batch team's outage. Either way, the knee is a number you must re-measure after every release that changes what a request does (P1); a knee from June under a September build is a guess with a date on it.

## 4. Is it us or the platform?

**Who asks, and when.** The incident commander at minute five, when someone in the channel says "the cluster is slow"; you, before opening a platform ticket that will come back "works for us". The answer is three comparisons: our pods against each other, our walls against their limits, and the platform's own signals against the timeline.

**What answers it.** Whether it's one pod or all; whether *our* throttle ratio and working set are at their walls (then it's us); and whether the platform's signals — node conditions, evictions, drains — say something happened to us.

```bash
# seat: tenant — one pod, or all? and where do they live?
kubectl get pods -n $NS -l app.kubernetes.io/name=payments-api -o custom-columns=POD:.metadata.name,NODE:.spec.nodeName,READY:.status.conditions[?(@.type=="Ready")].status,RESTARTS:.status.containerStatuses[0].restartCount
pq 'histogram_quantile(0.99, sum by (le, pod) (rate(http_server_requests_seconds_bucket{namespace="payments", service="payments-api"}[5m])))'
# our walls: if either is at the wall, stop — it's us
pq 'sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{namespace="payments", container="payments-api"}[5m])) / sum by (pod) (rate(container_cpu_cfs_periods_total{namespace="payments", container="payments-api"}[5m]))'
pq 'max by (pod, container) (container_memory_working_set_bytes{namespace="payments", container="payments-api"}) / on (pod, container) max by (pod, container) (kube_pod_container_resource_limits{namespace="payments", container="payments-api", resource="memory"})'
# did something happen to us? the eviction decoder, and the last hour of events
kubectl get pods -n $NS -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="DisruptionTarget")].reason}{"\n"}{end}' | awk -F'\t' '$2!=""'
kubectl get events -n $NS --sort-by=.lastTimestamp | grep -vE "Pulled|Created|Started|Scheduled" | tail -8
# seat: cluster-read — the platform's own signals: node conditions; ask if denied
kubectl get nodes -o custom-columns='NODE:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,MEM:.status.conditions[?(@.type=="MemoryPressure")].status,DISK:.status.conditions[?(@.type=="DiskPressure")].status,PIDS:.status.conditions[?(@.type=="PIDPressure")].status,SCHED:.spec.unschedulable' | grep -E "NODE|node-w0[379]"
```

```console
POD                            NODE       READY   RESTARTS
payments-api-7c9d4f6b8-k2xvn   node-w03   True    0
payments-api-7c9d4f6b8-r8pqz   node-w07   True    0
payments-api-7c9d4f6b8-t7mzc   node-w09   True    0
payments-api-7c9d4f6b8-k2xvn	0.44
payments-api-7c9d4f6b8-r8pqz	3.51
payments-api-7c9d4f6b8-t7mzc	0.47
payments-api-7c9d4f6b8-k2xvn	0.02
payments-api-7c9d4f6b8-r8pqz	0.03
payments-api-7c9d4f6b8-t7mzc	0.02
payments-api-7c9d4f6b8-k2xvn	0.61
payments-api-7c9d4f6b8-r8pqz	0.64
payments-api-7c9d4f6b8-t7mzc	0.60
NODE       READY   MEM     DISK    PIDS    SCHED
node-w03   True    False   False   False   <none>
node-w07   True    False   False   False   <none>
node-w09   True    False   False   False   <none>
```

One pod, on one node, with our walls nowhere near — throttle 0.03, working set 0.64 — no evictions, no events worth reading, and the node reporting no pressure it admits to. That combination is the noisy-neighbor signature: not us, and not something the platform's conditions will confess to on their own. If instead *all three* pods were slow with the walls innocent, look downstream before you look at the platform (question 9's shared ceilings); if the walls were at 0.4 and 0.95, it's us, and this page's questions 1 and 5 already have you.

**Rule out, in order.**

| Order | Symptom | The one number that rules it in | If it does |
|---|---|---|---|
| 1 | [4 · one pod slower than its siblings](/java/lens-playbooks-diagnose/#4-one-pod-is-slower-than-its-siblings) | one pod ≥ 3× p99, same RPS, throttle innocent | the node: `describe node` allocations and the node-exporter join; then [P3](/java/lens-playbooks-size-and-scale/#3-the-evidence-pack-for-the-platform-team) |
| 2 | [2 · the quota](/java/lens-playbooks-diagnose/#2-cpu-looks-idle-but-p99-is-on-fire) | throttle ratio > 0.05 on every pod | us — or a LimitRange the platform added, which is still ours to get fixed |
| 3 | [1 · memory at the wall](/java/lens-playbooks-diagnose/#1-memory-keeps-climbing-and-the-pod-gets-oomkilled) | working set / limit > 0.9 | us |
| 4 | a disruption | a `DisruptionTarget` reason on any pod — [the decoder](/disruption/anatomy-of-a-drain/#the-decoder-who-killed-my-pod) says who: `EvictionByEvictionAPI` (a drain), `DeletionByTaintManager` (a node went bad), `PreemptionByScheduler` | the platform's window: [Card G](/operations/emergency-playbooks/#card-g-the-platform-says-were-blocking-a-drain), or [involuntary disruptions](/disruption/involuntary-disruptions/) |
| 5 | the node itself | a condition `True`, or `SCHED` cordoned, or `NotReady` | [node problems](/troubleshooting/node-problems/) — theirs, with your evidence |
| 6 | neither | all pods slow, walls innocent, nodes quiet | the dependency: Oracle or the partner — [the timeout budget's audit kit](/tuning/timeout-budget/#the-audit-kit) |

**The artifact — the blame table**, which is the top half of [the evidence pack](/java/lens-playbooks-size-and-scale/#3-the-evidence-pack-for-the-platform-team): ours per pod (p99, RPS, busy threads, GC), our walls (throttle, working set), theirs (node, conditions, disruption reason), one UTC timestamp.

**Decide.** Our walls at the wall → us: the symptom page, and no ticket. Our pods innocent and one place hot → the evidence pack, sent [the way that gets a fast yes](/operations/working-with-platform-team/#writing-requests-that-get-fast-yeses); meanwhile `kubectl delete pod` the slow one — you are the budget check, a delete isn't gated by the PDB — and ship the soft spread. Everything innocent → the dependency, and the ticket goes to the DBA or the partner, with the thread dump that names the call.

## 5. Are we leaking — will it be alive on Monday?

**Who asks, and when.** Whoever notices the restart count in the weekly review; the on-call at the end of a shift, deciding whether Friday's pod survives the weekend; the team that just shipped a release and wants the day-two answer to question 2. The answer is four slopes with a date on each, because a leak is only a problem on the day it reaches a wall.

**What answers it.** The working set's slope extrapolated to the limit; the thread count's slope; the pool's idle floor (a leaked connection never goes back to zero); the pid count against its ceiling; and the restarts that already happened, with their reason.

```bash
# seat: tenant — four slopes, each as "where will it be in three days" or "per day"; then what already died, and why
pq 'max by (pod, container) (predict_linear(container_memory_working_set_bytes{namespace="payments", container="payments-api"}[6h], 259200)) / on (pod, container) max by (pod, container) (kube_pod_container_resource_limits{namespace="payments", container="payments-api", resource="memory"})'
pq 'deriv(jvm_threads_live_threads{namespace="payments", service="payments-api"}[6h]) * 86400'
pq 'min_over_time(hikaricp_connections_active{namespace="payments", service="payments-api"}[6h])'
pq 'predict_linear(container_threads{namespace="payments", container="payments-api"}[6h], 259200) / container_threads_max{namespace="payments", container="payments-api"}'
pq 'sum by (pod) (increase(kube_pod_container_status_restarts_total{namespace="payments", container="payments-api"}[7d]))'
pq 'count by (reason) (kube_pod_container_status_last_terminated_reason{namespace="payments", container="payments-api"} == 1)'
```

```console
payments-api-7c9d4f6b8-k2xvn	1.34          ← over the limit by Saturday, at this slope
payments-api-7c9d4f6b8-r8pqz	1.29
payments-api-7c9d4f6b8-k2xvn	0
payments-api-7c9d4f6b8-r8pqz	0
payments-api-7c9d4f6b8-k2xvn	0             ← the pool empties out at idle: no leaked connections
payments-api-7c9d4f6b8-r8pqz	0
payments-api-7c9d4f6b8-k2xvn	0.11
payments-api-7c9d4f6b8-r8pqz	0.11
payments-api-7c9d4f6b8-k2xvn	4
payments-api-7c9d4f6b8-r8pqz	3
OOMKilled	2
```

The working set will cross the limit in about two days on *both* pods — a leak is in every replica, which is how you tell it from a bad pod — threads flat, the pool clean, pids nowhere near the ceiling, seven restarts this week, and the last death on each pod was the kernel's. It won't be alive on Monday; it hasn't been alive on any Monday this month. (`predict_linear` over six hours assumes the slope is linear — a working set that climbs to a plateau and stops, which a JVM does in its first hour as the heap grows to its maximum, is not a leak: check that the *live set* climbs with it, which is the first thing symptom 1 does.)

**Rule out, in order.**

| Order | Symptom | The one number that rules it in | If it does |
|---|---|---|---|
| 1 | [1 · memory keeps climbing](/java/lens-playbooks-diagnose/#1-memory-keeps-climbing-and-the-pod-gets-oomkilled) | the working-set prediction > 1.0 inside your deploy cadence, with `jvm_gc_live_data_size_bytes` climbing (heap) or flat (native) | the histogram diff or NMT — on the healthy replica, this week |
| 2 | [7 · thread leak](/java/lens-playbooks-diagnose/#7-a-thread-leak) | thread slope > 0 per day, or pids predicted > 0.8 of the ceiling | the name histogram and JFR's `jdk.ThreadStart` |
| 3 | [6 · the leak variant of pool exhaustion](/java/lens-playbooks-diagnose/#6-connection-pool-exhaustion-against-oracle) | `min_over_time(hikaricp_connections_active[6h])` > 0 — connections that never come home | `leakDetectionThreshold: 20000` and read the borrower's stack in the log |
| 4 | not a leak — a plateau | the prediction crosses 1.0 but the 6-hour slope is falling and the live set is flat: the JVM finished growing into its heap | question 10, the budget: heap + non-heap don't fit, and the fix is a size, not a hunt |

**The artifact — the time-to-wall table.** One row per wall: the wall, today's value, the slope, the predicted date, and the restart count with its reason. The date column is what turns "memory looks high" into a ticket with a deadline.

**Decide.** A wall inside your next deploy → mitigate today so the death is diagnosable rather than silent: the cap that fits the leak (`MaxDirectMemorySize`, `MaxMetaspaceSize`, a bounded executor) turns an OOMKill into a JVM error with a stack and a dump; then the hunt on a healthy replica. A wall weeks out → the hunt this week, at leisure. No wall → not leaking; go back to whatever you were doing.

## 6. Are we paying for what we use?

**Who asks, and when.** The platform team's quarterly capacity review; finance, translated through your manager; you, when [the ledger](/autoscaling/capacity-and-governance/#the-invariant) says the namespace is full and you'd like to know whether that's true. The answer is claimed versus used, per workload, over a week — and the difference between waste and headroom you're entitled to.

**What answers it.** CPU p95 usage over the week against the request; memory working-set p99 against the request; the namespace's total claim against its total use; how much of the week the HPA spent at its floor.

```bash
# seat: tenant — per pod, over a week: used ÷ requested (CPU at p95, memory at p99), then the namespace's claim vs use, then time at the floor
pq 'quantile_over_time(0.95, (sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="payments", container!=""}[5m])))[7d:5m]) / on (pod) sum by (pod) (kube_pod_container_resource_requests{namespace="payments", resource="cpu"})'
pq 'quantile_over_time(0.99, (sum by (pod) (container_memory_working_set_bytes{namespace="payments", container!=""}))[7d:5m]) / on (pod) sum by (pod) (kube_pod_container_resource_requests{namespace="payments", resource="memory"})'
pq 'sum(kube_pod_container_resource_requests{namespace="payments", resource="cpu"})'
pq 'sum(rate(container_cpu_usage_seconds_total{namespace="payments", container!=""}[7d]))'
pq 'avg_over_time((kube_horizontalpodautoscaler_status_current_replicas{namespace="payments", horizontalpodautoscaler="payments-api"} == bool on () kube_horizontalpodautoscaler_spec_min_replicas{namespace="payments", horizontalpodautoscaler="payments-api"})[7d:5m])'
```

```console
payments-api-7c9d4f6b8-k2xvn	0.84
payments-api-7c9d4f6b8-r8pqz	0.81
dispatch-worker-6b9c8d7f5-p2xzk	0.12          ← 12% of its request, all week
notify-worker-84d6c9b7f-h7wqm	0.31
catalog-web-59f8b6d4c-z3mnv	0.58
payments-api-7c9d4f6b8-k2xvn	0.82
payments-api-7c9d4f6b8-r8pqz	0.83
dispatch-worker-6b9c8d7f5-p2xzk	0.44
notify-worker-84d6c9b7f-h7wqm	0.51
catalog-web-59f8b6d4c-z3mnv	0.77
-	6.5                                       ← the namespace claims 6.5 cores
-	1.9                                       ← and used 1.9 on average
-	0.71                                      ← payments-api sat at its floor 71% of the week
```

Read each row against what it's *for*. `payments-api` at 0.84 of its CPU request and 0.82 of its memory request is sized from a measurement (P1) and is exactly where it should be; the floor it sits at 71% of the week is two pods, and two is [the HA floor](/workloads/high-availability/), not waste. `dispatch-worker` at 0.12 all week is the row to explain — a consumer sized for its 01:30 batch peak, running that request around the clock; and the namespace claiming 6.5 cores to use 1.9 is the number the ledger will quote back at you.

**Rule out, in order.** Here the things to rule out are the *legitimate* reasons a number looks like waste:

| Order | What | The one number that rules it in | If it does |
|---|---|---|---|
| 1 | the request was a guess | no derivation comment in the values file; usage / request < 0.3 for a week on a workload with a stable profile | [P1](/java/lens-playbooks-size-and-scale/#1-size-the-heap-the-limit-and-the-request-from-data) — measure, then lower it, with the comment |
| 2 | the floor is HA, not cost | `minReplicas` = 2 and the SLO is a latency promise | leave it; a floor of 1 buys 250m and costs the SLO on every rollout and drain |
| 3 | the peak is nocturnal | `max_over_time` of the consumer's CPU over 7 d lands at 01:30 and reads 0.9 of the request | the request is right for its peak; the *ledger* should know the profile — [the state table](/autoscaling/load-profile/#the-state-table--the-artifact) |
| 4 | memory "waste" that isn't | working-set p99 / request at 0.8 with request = limit | correctly sized: memory is incompressible and the request is the kill line — [request = limit](/tuning/requests-limits-knobs/#memory-request--limit) |
| 5 | the quota is what's full, not the nodes | `kubectl describe quota -n $NS` — requests against the namespace quota | the [hoarding query](/observability/promql-for-resources/#namespace-wide-are-we-hoarding-quota) for the review; the ledger conversation with numbers |

**The artifact — the citizenship table.** One row per workload: request, p95/p99 use, the ratio, time at floor, and a verdict column that says *measured*, *guessed*, or *peak elsewhere* — the last two with a date for the re-measure.

**Decide.** A guessed request under 0.3 for a week → measure and lower it; that's the only row the ledger should get back. A measured request → defend it with the derivation comment, which is what [the review checklist](/autoscaling/capacity-and-governance/#the-review-checklist) reads. Never lower a memory request below the working-set p99 with its margin — that "saving" is an OOMKill at the next peak — and never trade the HA floor for a quarter core.

## 7. Can we trust the dashboard?

**Who asks, and when.** Anyone, before believing a flat line; the on-call when a panel says *No data* and the question is whether that's silence or health; you, before every other question on this page — because a number that isn't being scraped answers nothing. Five checks, a few seconds each.

**What answers it.** Every pod scraped; the last sample fresh; the histogram's buckets actually present for the route you'll quantile; the HPA reading a number; the cardinality sane; and the alert that watches the watcher, armed.

```bash
# seat: tenant — scraped, fresh, bucketed, read by the HPA, sane
pq 'up{namespace="payments"}'
pq 'time() - max by (pod) (timestamp(http_server_requests_seconds_count{namespace="payments", service="payments-api"}))'
pq 'count(count by (le) (http_server_requests_seconds_bucket{namespace="payments", service="payments-api", uri="/api/checkout"}))'
kubectl get hpa payments-api -n $NS -o custom-columns=NAME:.metadata.name,TARGETS:.status.currentMetrics[*].pods.current.averageValue,CPU:.status.currentMetrics[*].resource.current.averageUtilization
pq 'scrape_samples_scraped{namespace="payments"}'
# the dead-man's switch is armed: an absent() alert on our own scrape exists in Prometheus, not just in a PR
curl -s "$PROM/api/v1/rules?type=alert" | jq -r '.data.groups[].rules[] | select(.query | test("absent.*payments")) | [.name, .state] | @tsv'
```

```console
payments-api-7c9d4f6b8-k2xvn	1
payments-api-7c9d4f6b8-r8pqz	1
payments-api-7c9d4f6b8-k2xvn	12
payments-api-7c9d4f6b8-r8pqz	14
-	15
NAME           TARGETS   CPU
payments-api   410m      52
payments-api-7c9d4f6b8-k2xvn	3114
payments-api-7c9d4f6b8-r8pqz	3097
PaymentsApiScrapeMissing	inactive
```

Both pods up, samples 12–14 s old on a 30 s interval, fifteen buckets on the checkout route (so `histogram_quantile` has edges to read, including the one at 0.8), the HPA reading a number in both slots, three thousand series per pod (a Spring Boot app with its `uri` templates intact; thirty thousand would mean a path with an ID in it leaked into the tag), and the absent-alert present and quiet. *Now* the dashboard is admissible — and a flat line on it means flat.

**Rule out, in order.**

| Order | Symptom | The one number that rules it in | If it does |
|---|---|---|---|
| 1 | [8 · no data for our pod](/java/lens-playbooks-diagnose/#8-no-data-for-our-pod) | `up` missing or 0 for a pod that's Running | the four links, in order — the fault is almost always link two |
| 2 | the bucket trap | the `count by (le)` returns 0 for a route, or 1 (only `+Inf`) | [toolkit step 6](/java/lens-playbooks-diagnose/#6-histograms-for-the-four-timers-youll-quantile): `percentiles-histogram` is off by default; every percentile on that panel was invented |
| 3 | the shutter | a `rate()` window shorter than 4× the scrape interval; a gauge panel showing "spikes" that are one sample | [the three-lenses rule](/start/three-lenses/#a-scrape-is-a-sample): nothing shorter than the interval is trustworthy from a gauge |
| 4 | `<unknown>` in the HPA | either HPA column empty | [the runbook](/troubleshooting/hpa-not-scaling/#custom--external-metrics-prometheus-adapter-keda): scale-down is suspended while it says that |
| 5 | a cardinality leak | `scrape_samples_scraped` per pod ≥ 10× last month's; `count by (uri)` growing without a release | a raw path in the `uri` tag ([the cardinality trap](/start/three-lenses/#the-two-traps-of-the-second-lens)); Prometheus will eventually drop you, and the platform will ask why |
| 6 | the switch isn't armed | the rules query prints nothing | write [the dead-man's switch](/observability/alerting/#the-dead-mans-switch-absent) today — an empty dashboard because nothing is scraped looks exactly like one because nothing is wrong |

**The artifact — the trust checklist**, six rows, each with its proof line and a ✔ — the top of every incident doc, because every number under it depends on them.

**Decide.** Any row failing → fix it before reading anything else; a diagnosis on unscraped data is fiction with a graph. All six green → proceed to the question you came for. And put rows 1, 2, and 6 into the chart's README as the proof commands, so the next person doesn't rediscover them at 3 a.m.

## 8. Why did we get paged at 3 a.m.?

**Who asks, and when.** The on-call, groggy, with a page that says *restarts* and a cluster that has already healed; the postmortem author on Tuesday. The answer is a timeline reconstructed from what remembers the night — the cluster's events (an hour, then gone), the metrics (days), the JVM's own history (the ring buffer, the GC log, the automatic dump) — *before* anyone restarts anything, because a restart erases the inside lens's memory.

**What answers it.** Restarts by time; what killed the container; whether anything evicted it; what the HPA did; and what the JVM left behind.

```bash
# seat: tenant — the cluster's short memory first (events expire), then the metrics' longer one
kubectl get events -n $NS --sort-by=.lastTimestamp | grep -E "payments-api" | grep -vE "Pulled|Created|Started|Scheduled" | tail -12
pqr 'sum by (pod) (increase(kube_pod_container_status_restarts_total{namespace="payments", container="payments-api"}[5m]))' 1 5m | awk -F'\t' '$3 > 0'
pq 'count by (reason) (kube_pod_container_status_last_terminated_reason{namespace="payments", container="payments-api"} == 1)'
kubectl get pods -n $NS -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="DisruptionTarget")].reason}{"\t"}{.status.conditions[?(@.type=="DisruptionTarget")].lastTransitionTime}{"\n"}{end}' | awk -F'\t' '$2!=""'
pqr 'kube_horizontalpodautoscaler_status_current_replicas{namespace="payments", horizontalpodautoscaler="payments-api"}' 1 15m | awk -F'\t' '$2 ~ /T0[1-4]:/'
# what the JVM left behind on the volume (an emptyDir outlives a container restart): the OOM dump, the exit recording, the previous container's last GC lines
kubectl exec $POD -n $NS -- ls -lh /dumps
kubectl logs $POD -n $NS --previous 2>/dev/null | grep -E 'OutOfMemoryError|Pause Full|To-space exhausted|Dumping heap' | tail -5
```

```console
41m         Warning   Unhealthy   pod/payments-api-7c9d4f6b8-k2xvn   Liveness probe failed: Get "http://10.42.3.17:8081/actuator/health/liveness": context deadline exceeded
39m         Normal    Killing     pod/payments-api-7c9d4f6b8-k2xvn   Container payments-api failed liveness probe, will be restarted
payments-api-7c9d4f6b8-k2xvn	2026-09-10T02:40:00Z	1
payments-api-7c9d4f6b8-k2xvn	2026-09-10T03:05:00Z	1
Error	1
-	2026-09-10T02:00:00Z	3
-	2026-09-10T02:45:00Z	4
-	2026-09-10T03:15:00Z	4
-rw-r--r-- 1 10001 10001 271M Sep 10 02:39 java_pid1.hprof
-rw-r--r-- 1 10001 10001  98M Sep 10 03:05 payments-api.jfr
[2026-09-10T03:04:12.771+0000][1421.104s][info][gc] GC(388) Pause Full (G1 Compaction Pause) 612M->598M(616M) 2411.505ms
[2026-09-10T03:04:41.006+0000][1449.339s][info][gc] GC(391) To-space exhausted
[2026-09-10T03:04:52.310+0000][1460.643s][info][gc] GC(392) Pause Full (G1 Compaction Pause) 614M->601M(616M) 2588.220ms
```

The timeline writes itself. 02:39: the JVM in `k2xvn` ran out of heap, wrote the dump the toolkit's flag asked for, and exited (`ExitOnOutOfMemoryError` — so the container's reason is `Error`, exit 3, not `OOMKilled`: the *JVM* died, the kernel never got involved); the kubelet restarted the container at 02:40. 02:45: the HPA added a fourth pod, because the survivors' threads filled while `k2xvn` was warming up. 03:04: the restarted container hit the same wall in twenty-five minutes — Full GCs of two and a half seconds collecting 612 down to 598 MiB, which is a live set that *is* the heap — and the liveness probe timed out against a JVM that was mostly pausing, so the kubelet killed it again at 03:05. No `DisruptionTarget`, so nobody evicted anything: this was ours. A live set that fills the heap twice in a night, both times after 02:00, is a cache with no bound meeting the nightly reconciliation run (row 6 below) — and the dump from 02:39 will name the class. Note what survived: both files are on the `/dumps` volume, which outlives a container restart; a dump on the writable layer would have died with the container.

**Rule out, in order.** Here the order is *the timeline's* — the first event that isn't a consequence of an earlier one is the cause:

| Order | Symptom | The one number that rules it in | If it does |
|---|---|---|---|
| 1 | [1 · memory](/java/lens-playbooks-diagnose/#1-memory-keeps-climbing-and-the-pod-gets-oomkilled) | `OutOfMemoryError` in `--previous` (the JVM's wall: reason `Error`, exit 3, a dump on `/dumps`), or `last_terminated_reason` = `OOMKilled` (the kernel's wall: nothing written — unless JFR's repository lives on the volume, `-XX:FlightRecorderOptions=repository=/dumps/jfr`, and then `jfr assemble /dumps/jfr/<dir> night.jfr` recovers the ring buffer) | the heap branch if the live set filled the heap; the native branch if the heap was fine and the container died anyway |
| 2 | an eviction | a `DisruptionTarget` reason with a time in the window — [the decoder](/disruption/anatomy-of-a-drain/#the-decoder-who-killed-my-pod) | not yours: the platform's window ([why my pod died at 3 a.m.](/disruption/cheat-sheet/#why-did-my-pod-die-at-3-am-when-nobody-deployed)), and the PDB conversation if it hurt |
| 3 | [5 · GC](/java/lens-playbooks-diagnose/#5-is-gc-the-problem) | `Pause Full` lines in `--previous`, a liveness probe timing out against pauses | the GC table on the dump's timestamps; the probe's timeout against the pause p99 ([footgun #1](/workloads/health-checks/#footgun-1-liveness-probes-that-kill-slow-but-healthy-apps)) |
| 4 | [3 · a deploy](/java/lens-playbooks-diagnose/#3-latency-regressed-after-a-deploy) | `kubectl rollout history` shows a revision in the evening; the ReplicaSet age | the release table, run late |
| 5 | [2 · a downstream stall](/java/lens-playbooks-diagnose/#2-cpu-looks-idle-but-p99-is-on-fire) | busy threads at max overnight with the pool idle — the partner's nightly maintenance | the timeout that should have failed fast; the ring buffer's `jdk.SocketRead` events name the host |
| 6 | a nocturnal load | the consumer's queue depth, or the batch that runs at 01:30 | [the load profile](/autoscaling/load-profile/#peak--the-recurring-high) — the peak was always at night; the floor was set for the day |

**The artifact — the timeline.** One row per event: UTC time, the source that remembers it (event, metric, condition, dump, log), what happened, and whether it's a cause or a consequence. Its first *cause* row is the postmortem's first sentence.

**Decide.** Reconstruct before you restart — [Card F](/operations/emergency-playbooks/#card-f-triage-snapshot--capture-state-before-it-self-heals) is the snapshot to take *now*, and a restart that "fixes it" discards the ring buffer and the previous log. Cause found → its symptom's walk on the evidence you already have. Cause is the platform's → the decoder's reason and the time, into the ticket. Cause is a probe killing a slow-but-alive JVM → the probe, not the JVM, is the bug.

## 9. Will adding replicas help?

**Who asks, and when.** The person with a finger on `kubectl scale` during an incident; the reviewer of an HPA whose ceiling someone wants raised; the on-call who has watched the HPA add four pods and the p99 not move. The question underneath is whether the bottleneck is *per pod* (then replicas help) or *shared* (then they don't, and can make it worse — every new pod opens ten more Oracle sessions and one more connection to the partner).

**What answers it.** Per-pod throughput as replicas rose: flat means each pod is doing its share and one more will too; falling means a shared ceiling is being divided thinner. Then the shared ceilings by name.

```bash
# seat: tenant — per-pod throughput alongside the replica count, over the last hour of scaling
pqr 'sum(rate(http_server_requests_seconds_count{namespace="payments", service="payments-api", uri!~"/actuator.*"}[5m])) / count(kube_pod_info{namespace="payments", pod=~"payments-api.*"})' 1 15m | tail -5
pqr 'kube_horizontalpodautoscaler_status_current_replicas{namespace="payments", horizontalpodautoscaler="payments-api"}' 1 15m | tail -5
# the shared ceilings, by name: the pool (sessions are a namespace-wide budget), the partner (429s and its p95), a lock (BLOCKED threads)
pq 'sum(hikaricp_connections_active{namespace="payments"})'
pq 'sum(hikaricp_connections_pending{namespace="payments", service="payments-api"})'
pq 'sum(rate(http_client_requests_seconds_count{namespace="payments", service="payments-api", status="429"}[5m]))'
pq 'histogram_quantile(0.95, sum by (le, client_name) (rate(http_client_requests_seconds_bucket{namespace="payments", service="payments-api"}[5m])))'
kubectl exec $POD -n $NS -- $JATTACH $JPID threaddump | grep -c 'java.lang.Thread.State: BLOCKED'
```

```console
-	2026-09-10T14:00:00Z	58.1
-	2026-09-10T14:15:00Z	44.7
-	2026-09-10T14:30:00Z	36.2
-	2026-09-10T14:45:00Z	30.9
-	2026-09-10T15:00:00Z	27.4
-	2026-09-10T14:00:00Z	4
-	2026-09-10T14:15:00Z	5
-	2026-09-10T14:30:00Z	6
-	2026-09-10T14:45:00Z	7
-	2026-09-10T15:00:00Z	8
-	23
-	0
-	3.7
-	2.9
0
```

The signature of a shared ceiling: replicas doubled, per-pod throughput halved, total throughput flat — the HPA is dividing the same 220 rps across more pods and reading each pod's busy threads as "still saturated", because every one of them is waiting on the same thing. Which thing: the pool has room fleet-wide (23 of 80 sessions active) and nobody is queueing for it, the partner is answering `429` almost four times a second with a 2.9 s p95, and no thread is blocked on a lock. The partner is rate-limiting us, and each new pod adds a client to be rate-limited. (`http_client_requests_seconds` is what a `RestTemplate` built through Spring's `RestTemplateBuilder` — or a `RestClient` — publishes, tagged by `client_name`; a client built with `new` publishes nothing, which is a finding on its own.)

**Rule out, in order.**

| Order | Symptom | The one number that rules it in | If it does |
|---|---|---|---|
| 1 | [6 · pool exhaustion](/java/lens-playbooks-diagnose/#6-connection-pool-exhaustion-against-oracle) — the pool is the shared ceiling | `sum(hikaricp_connections_active)` at the session budget, pending > 0 | replicas open more sessions against a database that's already the wall: [the pool math](/autoscaling/rest-api-oracle/#the-pool-math), not `kubectl scale` |
| 2 | [2 · a downstream stall](/java/lens-playbooks-diagnose/#2-cpu-looks-idle-but-p99-is-on-fire) — the partner is the ceiling | busy threads at max, pool idle, client p95 or `429` rate climbing with replicas | the timeout and the [circuit](/tuning/timeout-budget/); replicas multiply the load you're being refused for |
| 3 | [4 · one pod](/java/lens-playbooks-diagnose/#4-one-pod-is-slower-than-its-siblings) | the fleet is fine on average and one pod holds the p99 | replace it, don't add to it |
| 4 | a lock | `BLOCKED` count > 10 in the dump, the same monitor in every dump | the holder's stack — [reading a thread dump](/java/thread-dumps-jre-only/#reading-a-thread-dump); replicas don't share a JVM lock, so this one *does* scale — but the code is still wrong |
| 5 | the signal | [the signal audit](/autoscaling/signals-catalog/#the-signal-audit): a signal that reads "saturated" for a shared cause scales you into the ceiling | [P2](/java/lens-playbooks-size-and-scale/#2-pick-and-prove-an-hpa-signal-without-keda), with the guard: busy threads *and* the downstream's health |
| 6 | the ceiling itself | `REPLICAS` = `MAXPODS` with per-pod throughput still flat and the walls innocent | yes, it helps — [the capacity conversation](/autoscaling/capacity-and-governance/#the-capacity-conversation) for a higher ceiling, inside the Oracle budget |

**The artifact — the per-pod-throughput table.** Replicas against per-pod RPS and total RPS at three points in the last hour, plus the three shared-ceiling numbers. Flat per-pod → scale; falling per-pod → the row above that names the ceiling.

**Decide.** Per-pod throughput flat as replicas rise → scaling works, and the only question is the ceiling's derivation. Per-pod throughput falling → *stop scaling* — the HPA's `behavior` is where a maximum scale-up rate lives if it keeps trying — and go to the ceiling by name; every replica you add is a customer of the thing that's already full. A lock → the code, and scaling as a bridge is legitimate for the afternoon.

## 10. Is the JVM sized right?

**Who asks, and when.** The team inheriting a chart whose numbers nobody can defend; the reviewer of a values file; you, after question 5 said *not a leak, a budget*. The answer is five ratios, each with a healthy range, and every one of them a single query — the sizing procedure's scorecard, read in a minute, before the two-hour measurement.

**What answers it.** Heap against the live set; the working set against the limit; time spent in GC pauses; the throttle ratio; CPU usage against the request.

```bash
# seat: tenant — five ratios; the healthy range is in the comment
pq 'jvm_gc_live_data_size_bytes{namespace="payments", pod="'$POD'"} / jvm_gc_max_data_size_bytes{namespace="payments", pod="'$POD'"}'                                                                         # live set / max heap: 0.3–0.5; > 0.6 the heap is small, < 0.2 it's big
pq 'max by (pod, container) (max_over_time(container_memory_working_set_bytes{namespace="payments", pod="'$POD'", container="payments-api"}[1d])) / on (pod, container) max by (pod, container) (kube_pod_container_resource_limits{namespace="payments", pod="'$POD'", container="payments-api", resource="memory"})'   # working-set peak / limit: 0.6–0.85
pq 'sum(rate(jvm_gc_pause_seconds_sum{namespace="payments", pod="'$POD'"}[1h]))'                                                                                                                              # fraction of wall time in pauses: < 0.02
pq 'sum(rate(container_cpu_cfs_throttled_periods_total{namespace="payments", pod="'$POD'", container="payments-api"}[1h])) / sum(rate(container_cpu_cfs_periods_total{namespace="payments", pod="'$POD'", container="payments-api"}[1h]))'   # throttle ratio: NaN (no limit) or < 0.05
pq 'quantile_over_time(0.95, (sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="payments", pod="'$POD'", container="payments-api"}[5m])))[1d:1m]) / on (pod) max by (pod) (kube_pod_container_resource_requests{namespace="payments", pod="'$POD'", container="payments-api", resource="cpu"})'   # CPU p95 / request: 0.6–0.9
# and the one the metrics can't show: did the JVM size its threads from the node? (13 GC threads on a 250m pod = no ActiveProcessorCount)
kubectl exec $POD -n $NS -- $JATTACH $JPID threaddump | grep -c '^"GC Thread#'
```

```console
payments-api-7c9d4f6b8-k2xvn	0.39
payments-api-7c9d4f6b8-k2xvn	0.84
-	0.006
-	NaN
payments-api-7c9d4f6b8-k2xvn	0.86
2
```

Every ratio inside its range: the live set at 39% of the heap (room for ×2.5), the working-set peak at 84% of the limit (the cast's measured 1 Gi, at its condition's edge), 0.6% of time in pauses, no quota, CPU p95 at 86% of the request, and two GC threads — `ActiveProcessorCount=2` is set. Sized right, *today*; the scorecard is a snapshot, and the number that moves first after a release is the second one.

**Rule out, in order.** Each ratio outside its range names a symptom:

| Order | Ratio out of range | Symptom | If it does |
|---|---|---|---|
| 1 | live / max heap > 0.6, or pauses > 0.02 | [5 · GC](/java/lens-playbooks-diagnose/#5-is-gc-the-problem) | the heap is small for what it keeps — or the live set grew (symptom 1's histogram diff decides which) |
| 2 | working set / limit > 0.9 with the live set flat | [1 · the budget branch](/java/lens-playbooks-diagnose/#1-memory-keeps-climbing-and-the-pod-gets-oomkilled) | heap + non-heap don't fit: [P1](/java/lens-playbooks-size-and-scale/#1-size-the-heap-the-limit-and-the-request-from-data) — NMT itemizes what, and the limit or the percentage moves with a derivation, never by hand |
| 3 | throttle ratio > 0.05 | [2 · the quota](/java/lens-playbooks-diagnose/#2-cpu-looks-idle-but-p99-is-on-fire) | a limit you didn't set: [the LimitRange reality check](/tuning/requests-limits-knobs/#the-limitrange-reality-check) |
| 4 | CPU p95 / request > 1.0 | under-requested | the scheduler is promising less than you use — the HPA's percentage math is built on this denominator, and it's lying: [P1](/java/lens-playbooks-size-and-scale/#1-size-the-heap-the-limit-and-the-request-from-data), then [the honest request](/tuning/requests-limits-knobs/#cpu-honest-request-no-limit) |
| 5 | CPU p95 / request < 0.3 for a week | over-requested | question 6 — measure and lower, with the comment |
| 6 | GC threads ≫ the request's cores | no `ActiveProcessorCount` | [the CPU section](/java/jvm-in-containers/#cpu-quota-shares-and-surprising-thread-counts): the JVM sized itself from the node; pin it |

**The artifact — the sizing scorecard.** Five ratios, their ranges, today's values, and a date — the top of the values file's derivation comment block, so a reviewer can re-run it.

**Decide.** All in range → leave it, and re-run the scorecard after every release that changes what a request does. One out of range → its symptom's walk *before* any knob moves; a knob turned without the walk is a guess with a commit message. Two or more out of range → the full procedure ([P1](/java/lens-playbooks-size-and-scale/#1-size-the-heap-the-limit-and-the-request-from-data)) — the numbers were never measured, and no amount of adjusting will make them so.

## 11. Are we ready to be drained?

**Who asks, and when.** The platform's window announcement in the ops channel — "patching the worker pool Thursday 02:00–04:00" — and you, before you go home Wednesday. Also every night, silently: the kubelet, the autoscaler, and the cloud's own maintenance ask the same question without announcing it. The answer is [the quick-start's gate](/disruption/quick-start/#the-gate-four-checks-one-command-each): four checks, and the drill that proves them.

**What answers it.** A budget exists, is legal, and allows a disruption right now; the fleet can land on N-1 nodes; the termination handshake is long enough for in-flight requests; and the HPA floor doesn't jam the budget.

```bash
# seat: tenant — the gate, one command each
kubectl get pdb -n $NS
kubectl get pods -n $NS -l app.kubernetes.io/name=payments-api -o custom-columns=POD:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,NODE:.spec.nodeName
kubectl get deploy payments-api -n $NS -o jsonpath='{"grace="}{.spec.template.spec.terminationGracePeriodSeconds}{"  preStop="}{.spec.template.spec.containers[0].lifecycle.preStop.exec.command}{"\n"}'
pq 'histogram_quantile(0.99, sum by (le) (rate(http_server_requests_seconds_bucket{namespace="payments", service="payments-api", uri!~"/actuator.*"}[1d])))'
kubectl get hpa payments-api -n $NS -o custom-columns=MIN:.spec.minReplicas,NOW:.status.currentReplicas
# N-1: does the fleet fit without its busiest node? (the landing drill, from your seat — no node access needed)
kubectl get pods -n $NS -o custom-columns=NODE:.spec.nodeName --no-headers | sort | uniq -c | sort -rn | head -3
# the proof: evict one of your own pods through the same API the drain uses, and read the answer (the quick-start's drill)
printf '{"apiVersion":"policy/v1","kind":"Eviction","metadata":{"name":"%s","namespace":"%s"}}' "$POD" "$NS" > eviction.json
kubectl create --raw /api/v1/namespaces/$NS/pods/$POD/eviction -f eviction.json
```

```console
NAME           MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
payments-api   N/A             1                 1                     41d
POD                            READY   NODE
payments-api-7c9d4f6b8-k2xvn   True    node-w03
payments-api-7c9d4f6b8-r8pqz   True    node-w07
payments-api-7c9d4f6b8-t7mzc   True    node-w09
grace=40  preStop=["sh","-c","sleep 5"]
-	0.62
MIN   NOW
2     3
      2 node-w07
      1 node-w03
      1 node-w09
{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Success","code":201}
```

A budget with `ALLOWED DISRUPTIONS 1`; every pod Ready (the budget counts only those); forty seconds of grace against a p99 of 0.62 s and a five-second preStop — [the budget inequality](/workloads/graceful-shutdown/#the-budget-inequality) holds with room; three pods above a floor of two, so one can go; the fleet spread across three nodes with at most two on any one; and the eviction API said `201` and the replacement came back Ready. Ready to be drained — *this* pod, *now*; the drill is a photograph, and the window is Thursday.

**Rule out, in order.** Here the things to rule out are the gate's failure modes:

| Order | What | The one number that rules it in | If it does |
|---|---|---|---|
| 1 | no budget | `kubectl get pdb` prints nothing for your app | the drain takes every pod at once; [the fifteen-minute PDB](/disruption/quick-start/#the-recipe) before Thursday |
| 2 | the jam | `ALLOWED DISRUPTIONS 0` with a pod not Ready | [`unhealthyPodEvictionPolicy: AlwaysAllow`](/disruption/pod-disruption-budgets/#unhealthypodevictionpolicy-letting-the-broken-ones-go) — or fix the pod; a crashlooping pod blocks the whole node's window |
| 3 | the 3 a.m. problem | `minAvailable` equals the HPA's `minReplicas`, and it's night | [PDB and HPA](/disruption/pod-disruption-budgets/#pdb-and-hpa-the-3-am-problem): the budget must leave room below the floor, or the floor must be one higher |
| 4 | a singleton | one replica, `maxUnavailable: 1` | [the one-replica honesty](/disruption/pod-disruption-budgets/#the-one-replica-honesty): it will be down during the window; decide whether that's acceptable, and say so |
| 5 | nowhere to land | two of three pods on the node being drained, or the `FailedScheduling` phrases in the drill | [the N-1 check](/disruption/where-pods-land/#the-n-1-check) and soft spread |
| 6 | the handshake is short | grace < preStop + p99 + the pool's drain; `Killing` events with in-flight 5xx in the last drill | [graceful shutdown](/workloads/graceful-shutdown/#the-budget-inequality): the inequality, then the [kill-during-load drill](/workloads/graceful-shutdown/#verifying-it-the-kill-during-load-drill) |
| 7 | the eviction API says no | `429` from the drill: *Cannot evict pod as it would violate the pod's disruption budget* | [the three answers](/disruption/anatomy-of-a-drain/#3-the-three-answers) — read the cause line; it names the budget and the count |

**The artifact — the drain-readiness card.** The four checks with their proof line and a ✔, the drill's answer, and the date — posted in the ops channel under the window announcement. It is the difference between "we're fine" and being fine.

**Decide.** All green → reply "go" to the window, with the card. Any red → the fix from its row, tonight; a window that blocks on your pod is [Card G](/operations/emergency-playbooks/#card-g-the-platform-says-were-blocking-a-drain) at 02:00 with the platform on the phone. And the silent askers — the autoscaler, the cloud's maintenance — don't announce; the gate has to be true every night, which is what the [disruption alerts](/disruption/pod-disruption-budgets/#alerts) are for.

## 12. Are we ready for on-call?

**Who asks, and when.** The new rotation, the night before its first shift; the team lead handing over a service; you, once, on a quiet afternoon — because every other question on this page assumes the toolkit exists, and an incident is the wrong time to discover that `jattach` isn't in the image. Eight proofs, one line each; anything that prints `MISSING` is the afternoon's first task.

**What answers it.** Each toolkit step proven against the live pod, plus the safety nets and the alert that watches the watcher.

```bash
# seat: tenant — eight proofs; every line prints ok or MISSING (run after the toolkit's variables are set)
[ -n "$JPID" ] && echo "1 pid          ok ($JPID)"      || echo "1 pid          MISSING — toolkit step 1"
kubectl exec $POD -n $NS -- $JATTACH $JPID jcmd VM.version >/dev/null 2>&1 && echo "2 jattach      ok" || echo "2 jattach      MISSING — toolkit step 2 (bake it into the image)"
[ "$(pq 'up{namespace="payments"}' | grep -c $'\t1$')" -gt 0 ] && echo "3 prometheus   ok" || echo "3 prometheus   MISSING — symptom 8"
curl -sf localhost:8081/actuator/health >/dev/null && echo "4 actuator     ok" || echo "4 actuator     MISSING — toolkit step 4"
kubectl get deploy payments-api -n $NS -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="JAVA_TOOL_OPTIONS")].value}' | grep -q 'HeapDumpOnOutOfMemoryError.*StartFlightRecording.*Xlog:gc' && echo "5 flags        ok" || echo "5 flags        MISSING — toolkit step 5"
[ "$(pq 'count(count by (le) (http_server_requests_seconds_bucket{namespace="payments", service="payments-api"}))' | cut -f2)" -gt 2 ] 2>/dev/null && echo "6 histograms   ok" || echo "6 histograms   MISSING — toolkit step 6"
kubectl exec $POD -n $NS -- sh -c 'test -w /dumps' && echo "7 /dumps       ok" || echo "7 /dumps       MISSING — a writable emptyDir at /dumps"
[ -n "$(curl -s "$PROM/api/v1/rules?type=alert" | jq -r '.data.groups[].rules[] | select(.query | test("absent.*payments")) | .name')" ] && echo "8 dead-man     ok" || echo "8 dead-man     MISSING — the absent() alert"
```

```console
1 pid          ok (1)
2 jattach      ok
3 prometheus   ok
4 actuator     ok
5 flags        ok
6 histograms   ok
7 /dumps       ok
8 dead-man     MISSING — the absent() alert
```

Seven of eight. The eighth is the one that would have made question 7's silence a page instead of a surprise — and it's a ten-line PrometheusRule, so it ships this afternoon. Three more that no command proves and the handover should: the runbook links in the alert annotations point at *this* site's pages; someone on the rotation has read [the symptom page's toolkit](/java/lens-playbooks-diagnose/#the-toolkit-set-up-once) end to end once; and the `/dumps` volume is big enough for a heap-sized file plus the recording.

**Rule out, in order.** Nothing — this is the question with no symptoms under it, because it's asked before there are any. Its rows are the eight above; the "if it does" column is the toolkit step that fixes each.

**The artifact — the readiness card.** The eight lines, dated, in the on-call handover doc; re-run at each handover, because images get rebuilt and flags get "cleaned up".

**Decide.** Any `MISSING` → fix it before the rotation starts; the ones that need a rollout (flags, the volume, jattach in the image) need it *today*, because a rollout during the incident is Card A's problem on top of yours. All eight `ok` → you're ready, and the first page will start at step 3 of whichever question it turns out to be.

## Where next

- **Next in the journey:** [Three Lenses, Tactically II: The Symptoms](/java/lens-playbooks-diagnose/) — the eight walks these questions rule out, with the toolkit, the commands, and the console output; then [Tactically III: Size and Scale](/java/lens-playbooks-size-and-scale/) for the procedures the questions send you to.
- **The lateral jump:** the model these questions are built on — [The Three Lenses](/start/three-lenses/) — and its cousin for the cluster, [The Three Doors](/start/three-doors/), whose Door 1 prices every number on this page.
