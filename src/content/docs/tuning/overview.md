---
title: Knobs & Levers
description: The consolidated tuning references — every health-check, JVM memory, and requests/limits knob with its default, its real effect, and when to turn it.
sidebar:
  order: 1
---

The rest of this site explains how the machinery works. This section is the panel of dials in front of it: every tunable that matters for keeping an app healthy and right-sized, in one place, with defaults, precise semantics, and the interactions between them.

## Why a separate section

Three reasons these live together instead of inside the concept articles:

1. **The knobs interact across domains.** A liveness `timeoutSeconds` of 1s is fine — until a CPU limit throttles the app or a full GC pauses the JVM past it. Memory limits and `MaxRAMPercentage` are one decision wearing two syntaxes. Tuning any one dial in isolation is how probe restarts and OOM storms happen.
2. **Defaults are quietly wrong for real workloads.** `timeoutSeconds: 1`, `MaxRAMPercentage: 25`, unlimited Metaspace, HPA targets against unmeasured requests — the platform won't warn you about any of these.
3. **You need the numbers at tuning time, not the theory.** When you're staring at a manifest, you want "default 10s, kill happens at `failureThreshold × periodSeconds`, watch restart counts after changing it" — not a re-explanation of what liveness means.

## How the pages fit together

Three layers, three jobs:

- **Concepts live in the concept sections.** What a probe *is* and why liveness must never see dependencies: [Health Checks](/workloads/health-checks/). What requests, limits, and QoS classes *mean*: [Resources and QoS](/workloads/resources-and-qos/). How surge and readiness gate a rollout: [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/). Why the JVM and the container are one memory system: [The JVM in Containers](/java/jvm-in-containers/). Read those when a mechanism surprises you.
- **Dials live here.** The four knob references below are lookup tables: field by field, default, real effect, when to turn it, what to watch afterward. They assume you know what the mechanism does and need the number.
- **The programs sequence the dials.** The [Sizing Walkthrough](/tuning/sizing-walkthrough/) is the greenfield program — one service, cold start to production-tuned, every number derived. The two brownfield pages are the retrofit programs for fleets that grew organically, ordered so the rollout doesn't cause the incident it prevents.

So the reading order for any tuning question is: symptom → knob reference (the number) → concept page only if the mechanism doesn't behave as the reference says → walkthrough/brownfield page when you're changing more than one service.

## The references

| Article | The dials it covers |
|---|---|
| [Health Check Knobs](/tuning/health-check-knobs/) | Every probe field with the restart/traffic math, interaction effects (rolling updates, graceful shutdown, GC pauses, throttling), and per-archetype probe recipes |
| [JVM Memory Knobs](/tuning/jvm-memory-knobs/) | Heap and the non-heap budget everyone forgets — `MaxRAMPercentage`, Metaspace, code cache, direct memory, thread stacks — plus the RSS budget formula and ready-made flag strings |
| [Requests & Limits Knobs](/tuning/requests-limits-knobs/) | The four primary knobs with exact semantics (CFS quota math included), QoS, LimitRange/quota interplay, and archetype resource blocks |
| [Rollout & Shutdown Knobs](/tuning/rollout-shutdown-knobs/) | The rollout pacing dials (surge, maxUnavailable, minReadySeconds) and the termination budget (preStop, grace period, drain) — with the combined deploy-under-load math |
| [Sizing Walkthrough](/tuning/sizing-walkthrough/) | The capstone: one service taken from a cold start to production-tuned, every number derived from a measurement, ending in a 12-step ritual you can reuse |
| [Requests & Limits on a Running Fleet](/tuning/brownfield-resources/) | The brownfield companion: auditing what's actually deployed, deriving numbers from live traffic (no load tests), and the wave-by-wave rollout that doesn't cause the incident it prevents |
| [Health Check Design](/tuning/health-check-design/) | Probes as a design discipline: hard/soft dependency classification, per-archetype endpoint designs, and the fleet retrofit order that never breaks prod |

## The three rules that govern every knob here

- **Measure before you turn.** Every reference links the [PromQL queries](/observability/promql-for-resources/) that produce the evidence. A number you didn't measure is a guess with YAML syntax.
- **One knob at a time.** Each article's tuning workflow names what to watch after each change. Turn two dials at once and you've learned nothing either way.
- **Through git, not `kubectl edit`.** Tuning that isn't in the manifest is [drift](/operations/drift-and-cicd/), and the next deploy will un-tune it at the worst possible moment.

### The three rules in one incident

Here's what the discipline looks like when a real symptom walks in. A service's p99 doubles at lunch-hour peak while its CPU graph looks half-idle. The instinct is to raise the CPU request and the memory limit and restart everything — three knobs, zero evidence. Instead: **measure** — the throttle-ratio query from [PromQL for Resources](/observability/promql-for-resources/) shows 40% of CFS periods throttled, so the half-idle graph was averaging away 100ms stalls; the culprit is a CPU *limit*, and memory was never involved. **One knob** — raise (or remove) only the CPU limit, per the decision table in [Requests & Limits Knobs](/tuning/requests-limits-knobs/), and watch exactly two things afterward: throttle ratio to zero, p99 back under SLO. Nothing else changed, so whatever moves, you know why. **Through git** — the change ships as a reviewed commit with the PromQL evidence in the description, so the next deploy re-applies it and the next engineer can read why the limit is gone instead of "tidying" it back in. Total diff: one line. That's the whole method; the walkthroughs below are the same loop run twelve times.

## The interactions that bite

Every knob reference flags its own interactions, but five of them cross page boundaries — each is two dials on two different pages that are secretly one system. Turning either side without checking the other is the classic way a "safe" one-line change becomes an incident:

- **CPU request ↔ HPA target.** `averageUtilization` is a percentage *of the request*. Halve the request and you've halved the scaling trigger — the fleet doubles, or the quota blocks it and latency climbs instead. ([Requests & Limits Knobs](/tuning/requests-limits-knobs/) ↔ [Autoscaling](/workloads/autoscaling/))
- **Memory limit ↔ MaxRAMPercentage.** The heap is sized as a percentage of the container limit — one decision wearing two syntaxes. Lower the limit without re-checking the percentage and the non-heap budget disappears; the OOM killer explains it later. ([Requests & Limits Knobs](/tuning/requests-limits-knobs/) ↔ [JVM Memory Knobs](/tuning/jvm-memory-knobs/))
- **Probe timeout ↔ CPU throttle.** A `timeoutSeconds: 1` liveness probe is fine until CFS throttling stretches a 20ms health check past a second — then the kubelet restarts a perfectly healthy pod, at peak load, in a loop. ([Health Check Knobs](/tuning/health-check-knobs/) ↔ [Requests & Limits Knobs](/tuning/requests-limits-knobs/))
- **Grace period ↔ preStop + drain.** `terminationGracePeriodSeconds` must hold the preStop sleep *plus* the app's graceful shutdown, with slack. Extend the shutdown timeout without extending the grace period and SIGKILL lands mid-request — deploys start dropping traffic that probes can't see. ([Rollout & Shutdown Knobs](/tuning/rollout-shutdown-knobs/) ↔ [Health Check Knobs](/tuning/health-check-knobs/))
- **Surge ↔ quota.** `maxSurge` needs quota headroom for the extra pods at *maximum* fleet size. Raise the requests, the HPA ceiling, or the surge percentage without re-doing the quota math and rollouts stall silently, pods Pending, while the old version keeps serving. ([Rollout & Shutdown Knobs](/tuning/rollout-shutdown-knobs/) ↔ [Requests & Limits Knobs](/tuning/requests-limits-knobs/))

The [Golden Service](/architectures/golden-service/) is the existence proof that all five pairs can be held consistent in one set of manifests — every number there annotates which other number it's coupled to.

:::tip[Where to start]
New service with no data? Start with the honest starter configs in the [Sizing Walkthrough](/tuning/sizing-walkthrough/) and work the phases. Existing fleet that grew organically? [Requests & Limits on a Running Fleet](/tuning/brownfield-resources/) and [Health Check Design](/tuning/health-check-design/) are the retrofit programs. Existing service misbehaving? Go straight to the knob table for the symptom — probe restarts to [Health Checks](/tuning/health-check-knobs/), OOMKills to [JVM Memory](/tuning/jvm-memory-knobs/), latency-with-idle-CPU to [Requests & Limits](/tuning/requests-limits-knobs/).
:::
