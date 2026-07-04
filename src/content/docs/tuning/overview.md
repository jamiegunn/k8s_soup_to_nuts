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

## The references

| Article | The dials it covers |
|---|---|
| [Health Check Knobs](/tuning/health-check-knobs/) | Every probe field with the restart/traffic math, interaction effects (rolling updates, graceful shutdown, GC pauses, throttling), and per-archetype probe recipes |
| [JVM Memory Knobs](/tuning/jvm-memory-knobs/) | Heap and the non-heap budget everyone forgets — `MaxRAMPercentage`, Metaspace, code cache, direct memory, thread stacks — plus the RSS budget formula and ready-made flag strings |
| [Requests & Limits Knobs](/tuning/requests-limits-knobs/) | The four primary knobs with exact semantics (CFS quota math included), QoS, LimitRange/quota interplay, and archetype resource blocks |
| [Sizing Walkthrough](/tuning/sizing-walkthrough/) | The capstone: one service taken from a cold start to production-tuned, every number derived from a measurement, ending in a 12-step ritual you can reuse |
| [Requests & Limits on a Running Fleet](/tuning/brownfield-resources/) | The brownfield companion: auditing what's actually deployed, deriving numbers from live traffic (no load tests), and the wave-by-wave rollout that doesn't cause the incident it prevents |
| [Health Check Design](/tuning/health-check-design/) | Probes as a design discipline: hard/soft dependency classification, per-archetype endpoint designs, and the fleet retrofit order that never breaks prod |

## The three rules that govern every knob here

- **Measure before you turn.** Every reference links the [PromQL queries](/observability/promql-for-resources/) that produce the evidence. A number you didn't measure is a guess with YAML syntax.
- **One knob at a time.** Each article's tuning workflow names what to watch after each change. Turn two dials at once and you've learned nothing either way.
- **Through git, not `kubectl edit`.** Tuning that isn't in the manifest is [drift](/operations/drift-and-cicd/), and the next deploy will un-tune it at the worst possible moment.

:::tip[Where to start]
New service with no data? Start with the honest starter configs in the [Sizing Walkthrough](/tuning/sizing-walkthrough/) and work the phases. Existing fleet that grew organically? [Requests & Limits on a Running Fleet](/tuning/brownfield-resources/) and [Health Check Design](/tuning/health-check-design/) are the retrofit programs. Existing service misbehaving? Go straight to the knob table for the symptom — probe restarts to [Health Checks](/tuning/health-check-knobs/), OOMKills to [JVM Memory](/tuning/jvm-memory-knobs/), latency-with-idle-CPU to [Requests & Limits](/tuning/requests-limits-knobs/).
:::
