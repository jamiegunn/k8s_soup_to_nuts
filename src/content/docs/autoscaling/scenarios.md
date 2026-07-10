---
title: Start From Your Situation
description: Thirteen situations in your own words — my API dies at lunch, the backlog isn't drained by morning, we scaled up and Oracle fell over — each routed to the exact pages that fix it.
keywords:
  - my api slows down every day at lunch
  - queue backlog not drained by morning
  - hpa at max users still hurting
  - we scaled up and oracle fell over
  - pods flapping up and down all day
  - nightly job ran twice
  - inherited helm chart autoscaling
  - how do i review an hpa pull request
  - only dynatrace in production
  - scale on business metric orders per minute
sidebar:
  order: 3
---

Find the sentence that sounds like your week; follow the path. Nothing on this page is new material — it's routing, with an honest effort estimate per journey so you can plan the work instead of discovering it.

### "My API slows down every lunchtime"

The daily-peak classic: fine at 10:00, crawling at 12:30, fine again by 14:00. You'll verify the app is scale-ready, confirm *what* saturates at lunch (it's usually threads waiting on Oracle, not CPU), then build the HPA with a ceiling Oracle agrees to.

The thirty-second version, if lunch is *now*: CPU fine + latency climbing on a Spring API almost always means saturated request threads or a starved connection pool — `tomcat_threads_busy_threads` and `hikaricp_connections_pending` say which ([the thread entry](/autoscaling/signals-catalog/#thread-pool-saturation) reads both). The path below is that answer, earned properly.

**Path:** [prerequisites](/autoscaling/prerequisites/) → [SLO](/autoscaling/slos-for-scaling/) → [signals catalog](/autoscaling/signals-catalog/) (run the signal audit *during* a lunch peak) → [REST API + Oracle](/autoscaling/rest-api-oracle/). **Effort:** one afternoon of reading and measurement + a load test + one PR.

### "Our overnight queue backlog isn't drained by morning"

Messages pile up at 1 a.m., consumers plod through at fixed count, and the business notices at 9. You'll turn "drained by morning" into a freshness SLO, then let KEDA match consumer count to depth.

**Path:** [SLO (freshness shape)](/autoscaling/slos-for-scaling/#the-sli-shape-follows-the-archetype) → [messaging consumers](/autoscaling/messaging-consumers/) → the [KEDA build](/architectures/keda-autoscaling/) for mechanics. **Effort:** one day including the broker-admin conversation (REST endpoint, monitoring account) — start that ask first, it has the longest lead time.

### "We were told to enable autoscaling by Friday"

**Path:** [the 15-minute conservative HPA](/autoscaling/quick-start/), gate included. **Effort:** 15 minutes if the gate passes; if it fails, the gate found the thing that would have paged you Saturday.

### "We scaled up and Oracle fell over"

ORA-00018, angry DBA, several *other* teams' apps erroring too. The maxReplicas came from optimism instead of session arithmetic. You'll do the pool math, cap the ceiling, and put the derivation where review can see it.

**Path:** [the pool math](/autoscaling/rest-api-oracle/#the-pool-math) → [governance](/autoscaling/capacity-and-governance/) (the ledger now knows your name). **Effort:** an hour of arithmetic + one DBA conversation + one values PR. Do it today; the DBA remembers.

### "HPA is at max and users are still hurting"

Two different emergencies wearing one symptom. *Right now*: the [runbook](/troubleshooting/hpa-not-scaling/) — is it `ScalingLimited` (the HPA's own condition: "I'd add more, but I'm at maxReplicas"), Pending pods, or scaled-but-not-helping? *Afterwards*: at-max-and-still-slow usually means the ceiling is too low (capacity conversation) or the signal is wrong (scaled on CPU while threads saturated — the app was drowning politely).

**Path:** [runbook](/troubleshooting/hpa-not-scaling/) first → then [signals catalog](/autoscaling/signals-catalog/) + [capacity](/autoscaling/capacity-and-governance/). **Effort:** incident time now; half a day of diagnosis after.

### "My pods flap up and down all day"

Replica count sawtoothing on a ten-minute period. Either the scale-down window is shorter than your JVM's warmup (each scale-in is instantly regretted), the signal oscillates by construction (latency — [the loop](/autoscaling/spring-boot-scaling/#the-cold-pod-thundering-herd)), or requests are so low the math thrashes.

**Path:** [Spring Boot `behavior:` tuning](/autoscaling/spring-boot-scaling/#behavior-tuned-for-slow-starters) → [signal audit](/autoscaling/signals-catalog/#the-signal-audit). **Effort:** an hour to diagnose with the churn query, one values PR to fix.

### "We only have Dynatrace in prod"

Prometheus lives in dev; prod has OneAgent and nothing else. You'll decide per-workload whether to drive scaling from Dynatrace's metrics API (workable, with token ceremony and a staler signal) or make the case for prod Prometheus.

**Path:** [Dynatrace as a scaling signal](/autoscaling/dynatrace-signals/) — the decision table is the deliverable. **Effort:** half a day + a token-scope conversation with the Dynatrace admin.

### "I'm the reviewer — how do I approve someone's HPA?"

**Path:** [the review checklist](/autoscaling/capacity-and-governance/#the-review-checklist), verbatim — paste it into the PR. Every unchecked box is a conversation. The two most commonly missing: the maxReplicas derivation (should name an external ceiling and its owner) and idempotency for consumers. **Effort:** 20 minutes per review once you've read the checklist's links; the first one takes an evening.

### "Our nightly job just ran twice" / "is this app even safe to run twice?"

The autoscaler multiplied an app that assumed it was alone — `@Scheduled` reports, in-JVM sessions, startup migrations. You'll run the safety audit and fix or extract what fails it.

**Path:** [the safety audit](/autoscaling/classify-your-app/#part-1--can-n-copies-safely-coexist). **Effort:** the audit is an hour; fixes range from a ShedLock dependency (an afternoon) to extracting a CronJob (a sprint story).

### "We inherited this chart and don't know if it can autoscale"

**Path:** [the chart audit](/autoscaling/classify-your-app/#part-3--is-the-chart-ready) — two commands and an eight-item checklist against what the chart *renders*, graded Bronze/Silver/Gold. **Effort:** an hour to grade; Bronze is one PR away if it fails.

### "I want to scale on a business number (orders per minute)"

Better instinct than most defaults — a business rate self-adjusts for request cost and product can review the threshold. You'll emit a Micrometer counter and ride the standard pipeline; no special machinery.

**Path:** [custom metrics](/autoscaling/getting-the-metrics/#custom-metrics--when-and-how) → the [prometheus-scaler fork](/autoscaling/getting-the-metrics/#5-the-fork-adapter-or-keda). **Effort:** ~15 lines of Java + one afternoon of pipeline verification.

### "Product wants a 3-second promise and we have no SLOs"

**Path:** [Start With the User](/autoscaling/slos-for-scaling/) — the translation ladder turns the 3-second sentence into an SLI, an SLO, and a scaling threshold; the fallback ladder covers you until the product conversation happens. **Effort:** the first SLO is an afternoon including the measurement; the fifth takes twenty minutes.

### "We have no idea what minReplicas/maxReplicas should be"

Nobody does, until they measure. Two weeks of data you already have → four numbers → every knob derives.

**Path:** [load profile](/autoscaling/load-profile/) → your [archetype page](/autoscaling/overview/#start-here-by-archetype) for the ceiling cap. **Effort:** the queries are an hour; the confidence is permanent.

### "Will everyone's maxReplicas even fit on this cluster?"

The SRE-shaped worry, and the correct one to have on a fixed pool. **Path:** [the capacity invariant and the ledger](/autoscaling/capacity-and-governance/). **Effort:** the first ledger takes a day of collecting derivations; keeping it is the quarterly true-up.

---

Situation not here? The [overview's "ways in"](/autoscaling/overview/) table routes by role rather than symptom, and [the cheat sheet](/autoscaling/cheat-sheet/) routes by artifact. If it's an incident, it's the [runbook](/troubleshooting/hpa-not-scaling/).
