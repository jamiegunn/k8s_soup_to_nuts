---
title: "Field Notes: The Throttled App That Looked Idle"
description: p99 latency tripled at peak every day while kubectl top swore we were at 40% CPU. We spent a week blaming GC, the database, and the network before finding the one metric that mattered.
keywords:
  - container_cpu_cfs_throttled_periods_total
  - CFS bandwidth controller 100ms quota
  - CPU limit throttling
  - low CPU usage high tail latency
  - kubectl top hides throttling
  - remove CPU limit honest request
  - throttle ratio PromQL
  - availableProcessors JVM sizing ActiveProcessorCount
date: 2026-03-18
authors: editor
tags:
  - cpu
  - throttling
  - latency
  - promql
excerpt: >-
  Every day at peak, p99 latency tripled. Every dashboard said the service was loafing at 40% CPU. We spent a week interrogating the garbage collector, the database, and the network — all innocent — because nobody thought to ask whether a container can be starved and idle at the same time. It can.
---

Here is the paradox that ate a week of our lives: `pricing-api` got dramatically slower at peak traffic every single day, and every resource dashboard we owned said it wasn't working hard.

The symptom was clean. From about 11:00 to 14:00 — our traffic peak — p99 latency went from ~280ms to ~900ms, sometimes worse. p50 barely moved. Outside that window, flawless. And the "obvious" first check:

```console
$ kubectl top pods -l app=pricing-api
NAME                          CPU(cores)   MEMORY(bytes)
pricing-api-7d9f6b8c9-4kzmw   412m         1189Mi
pricing-api-7d9f6b8c9-hx8vn   398m         1201Mi
pricing-api-7d9f6b8c9-t2r7q   405m         1177Mi
```

The container had `requests.cpu: 500m` and `limits.cpu: "1"`. So: ~40% of the limit, comfortably under request, at the *worst* moment of the day. The Grafana CPU panel agreed — a gentle hill, nowhere near the ceiling. Whatever was hurting us, it obviously wasn't CPU.

That word "obviously" cost us five days.

## The week of wrong theories

Because CPU had an alibi, we went hunting elsewhere, in the traditional order:

**Day 1–2, garbage collection.** It's a JVM service and the latency was spiky, so GC was suspect number one. We turned on GC logging, stared at pause times, tuned nothing because there was nothing to tune — young-gen pauses of 8–15ms, no full GCs during the window. GC was innocent, though we did spend an afternoon *almost* migrating garbage collectors before someone asked what problem we were solving.

**Day 3, the database.** Peak traffic means more queries; maybe we were queuing on the connection pool or hitting a slow plan. Pool metrics: healthy, borrow times flat. Slow-query log: empty. The DB's own p99 during the window: unchanged. Innocent.

**Day 4, the network and neighbors.** We theorized about a noisy neighbor on shared nodes, conntrack, DNS. We don't own the nodes — the platform team does — so this phase was mostly opening a ticket and hypothesizing into the void. The platform team came back with node-level graphs: nodes at 55% CPU, no pressure, no drops. Innocent.

By day 5 we had a service that was slow for three hours a day, four exonerated suspects, and a dashboard wall insisting everything was fine.

## Day 5: the metric with the unpronounceable name

A platform engineer looking at our ticket asked one question that ended the investigation: *"What does your throttling look like?"* Followed by a query none of us had ever run:

```promql
sum by (pod) (
  rate(container_cpu_cfs_throttled_periods_total{namespace="shop", pod=~"pricing-api-.*"}[5m])
)
/
sum by (pod) (
  rate(container_cpu_cfs_periods_total{namespace="shop", pod=~"pricing-api-.*"}[5m])
)
```

The result, during the peak window: **0.58 to 0.71**. Our containers were being throttled in six or seven out of every ten CPU enforcement periods — during the exact hours the latency graph caught fire, on pods that `kubectl top` said were 60% idle. Overlaid on the p99 graph, the two lines were the same shape. Five days of forensics, one query.

There's a companion metric worth knowing while you're here: `container_cpu_cfs_throttled_seconds_total` measures *how long* threads sat frozen, not just how often. For us:

```promql
sum(rate(container_cpu_cfs_throttled_seconds_total{pod=~"pricing-api-.*"}[5m]))
# peak window: ~2.4 — 2.4 seconds of enforced stall injected per second, across the fleet
```

The ratio tells you throttling is happening; the seconds tell you how much latency budget it's eating. Both were screaming. Neither was on any dashboard we owned.

## How a container is starved and idle at the same time

The mechanism is worth understanding precisely, because once you see it, "40% CPU" stops being reassuring.

A CPU *limit* is enforced by the Linux CFS bandwidth controller in fixed windows of **100 milliseconds**. `limits.cpu: "1"` means: in each 100ms window, all threads in this container may consume 100ms of CPU time, combined. Burn through the quota in the first part of the window and every runnable thread in the container is frozen — not deprioritized, *stopped* — until the next window opens.

Now look at what `pricing-api` actually does per request: fan out to a handful of downstream calls, then score ~200 candidate prices on a small thread pool. That scoring burst is embarrassingly parallel. With 8 worker threads running hot, the container consumes its entire 100ms quota in about **12ms of wall-clock time**. Then everything — the workers, the request threads, the health-check handler — sits throttled for the remaining ~88ms.

At low traffic, bursts are rare and mostly land in separate windows; nobody notices. At peak, requests arrive fast enough that most windows contain a burst, so most requests eat one or more 88ms freezes. A request unlucky enough to straddle two throttled windows pays twice. There's your p99 tripling — built entirely out of 100ms-scale stalls.

And the averages? Over any human-scale interval the pod really did use ~400 millicores: 12ms of frantic work plus 88ms of enforced nap, repeated, averages out to "idle-ish." `kubectl top` samples usage over a window vastly longer than 100ms. The Grafana panel was `rate(container_cpu_usage_seconds_total[5m])`. Both were telling the truth about the *average* and completely blind to the *distribution*. The starvation lived inside a window a hundred times smaller than anything we graphed — see [PromQL for resources](/observability/promql-for-resources/) for the family of queries that do see it.

:::caution
`kubectl top` can never show you throttling. It reports usage, and a throttled container's usage is *low by definition* — that's what throttling does. If you only remember one thing: **low CPU usage plus high tail latency is a throttling signature, not an alibi.**
:::

## The fix, and the argument about it

The fix was a two-line diff and one honest conversation:

```diff
     resources:
       requests:
-        cpu: 500m
+        cpu: 750m
         memory: 1536Mi
       limits:
-        cpu: "1"
         memory: 2048Mi
```

We **removed the CPU limit** and **raised the request to what the service actually uses at peak** (measured p95 usage plus headroom, not a vibe). The request is what the scheduler uses to place pods and what our capacity is billed against, so it has to stay honest — that's the deal we have with the platform team, and it's the deal described in [resources and QoS](/workloads/resources-and-qos/). With no limit, the burst borrows idle node CPU for 12ms and gives it back; with an honest request, we're not stealing that headroom from anyone, because CPU is compressible — worst case under true node contention, we're throttled back toward our request, which is precisely the guarantee we paid for.

The argument, of course, was "isn't removing limits dangerous?" For memory: yes, keep the limit, always — memory is incompressible and the failure mode is an OOMKill. For CPU: the danger runs the other way. A CPU limit doesn't protect the node (requests and the scheduler do that); it protects an *accounting boundary*, and it collects its fee in 100ms slices of your tail latency. Our platform team allows limitless CPU with honest requests; if yours mandates limits, size the limit off *burst* demand — several multiples of the average — never off the average itself.

Verification took one day instead of five. Peak window, next day:

```console
$ kubectl top pods -l app=pricing-api
NAME                          CPU(cores)   MEMORY(bytes)
pricing-api-6b8f9c4d7-lq2wn   431m         1194Mi     # basically unchanged
pricing-api-6b8f9c4d7-mz5rk   407m         1182Mi
pricing-api-6b8f9c4d7-vx3jp   419m         1208Mi
```

Throttle ratio: pinned at 0.00 through the whole window. p99: 290ms, flat. Same traffic, same code, and — this is the part to sit with — essentially the same `kubectl top` output as during the incident. The average never knew anything was wrong, in either direction.

## The bonus damage we found on the way out

One more thing surfaced while we were in there, worth flagging for anyone running JVMs (or Go runtimes) under CPU limits: the limit doesn't just throttle you at runtime, it *shapes the process at startup*. The JVM sizes itself from the container's CPU quota — with `limits.cpu: "1"`, `Runtime.availableProcessors()` returns 1, and from that flow the default sizes of the common ForkJoin pool, GC worker threads, and every library that sizes a pool from "the number of CPUs." Our service had been configuring itself as a single-core machine for two years, then running a fan-out workload on top. Removing the limit (the runtime then sees the node's CPUs, or you set `-XX:ActiveProcessorCount` explicitly to match your request) is effectively a second, quieter performance fix riding along with the first one.

## What we changed

- **The throttle-ratio query is now step one — before GC, before the database — whenever latency is spiky but usage looks low.** It's written into our [triage methodology](/troubleshooting/triage-methodology/) with the exact PromQL above. Cost: thirty seconds. It would have saved four and a half days.
- **CPU limits are removed by default; CPU requests are honest by policy.** Requests are set from measured p95 usage and re-checked quarterly. Where a limit is unavoidable, it's sized from burst behavior with the throttling metric watched for a week after.
- **A recording rule and alert watch throttling fleet-wide.** Throttle ratio > 25% for 15 minutes posts to the team channel with the pod name. Three other services were quietly throttling when we turned it on. None of them had a latency complaint *yet*.
- **Dashboards got a distribution conscience.** Every CPU usage panel now has throttled-periods plotted on the same graph. An average without its throttle ratio is now treated the way we'd treat a mean without a p99: as half a number.
- **We wrote down the paradox for the next team:** a container can be starved for 88ms out of every 100 and still average 40% utilization. Averages are where window-level starvation goes to hide.

The uncomfortable summary: for five days we kept asking "what is slow?" when the right question was "what is being *stopped*?" Nothing in our system was slow. It was fast, in 12ms bursts, and then it was handcuffed — and every graph we trusted averaged the handcuffs away.
