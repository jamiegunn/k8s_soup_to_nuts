---
title: Start From Your Situation
description: Twelve situations in your own words — the platform says we're blocking their upgrade, 502s on a night nobody deployed, a pod died and I don't know who killed it, our Job burned its retries during patching — each routed to the exact pages that fix it, with an honest effort estimate.
keywords:
  - platform team says our namespace is blocking the drain
  - 502 errors during patch night nobody deployed
  - who deleted my pod nobody deployed
  - pods pending after node drain
  - drain took forty minutes because of us
  - lost quorum during cluster upgrade
  - nightly job failed during node patching
  - hpa scaled to minreplicas and the drain came
  - one replica cant add another pdb
  - how to review a pdb pull request
  - when is the next maintenance window
  - single node cluster does pdb apply
sidebar:
  order: 3
---

Find the sentence that sounds like your week; follow the path. Nothing on this page is new material — it's routing, with an honest effort estimate per journey so you can plan the work instead of discovering it.

### "The platform team says our namespace is blocking their upgrade"

A drain has been retrying against one of your pods for an hour, and someone with cluster-admin is about to override you. Unblock them first, understand it second: the ten-minute fix is a `kubectl patch` (raise the floor, switch the shape, or let broken pods go); the real fix is a budget shape that holds at every replica count, in the chart.

**Path:** [unjamming, right now](/disruption/pod-disruption-budgets/#unjamming-a-blocked-drain-right-now) → [the two shapes](/disruption/pod-disruption-budgets/#the-two-shapes) → [quick start](/disruption/quick-start/) (put the fix in the chart) → [the contract](/disruption/platform-contract/) (so it's a fifteen-minute standoff next time, not six hours). **Effort:** ten minutes to unblock them; an afternoon to fix it properly. Read [the Field Note](/blog/the-pdb-that-blocked-the-drain/) before the retrospective.

### "We got 502s during patch night and nobody deployed anything"

Every node drain is a rollout you didn't schedule. If the errors clustered at each pod's death, the *eviction* was polite and the *shutdown* raced the endpoint removal — a PDB never touches that. If the errors came from too few pods carrying the load, the budget permitted too many at once for that hour.

**Path:** [what you can see of a drain](/disruption/anatomy-of-a-drain/#watching-a-window-from-your-seat) (was it evictions? the `Killing` timestamps say) → [the race](/workloads/graceful-shutdown/#the-race-traffic-arrives-after-sigterm) and [the kill-during-load drill](/workloads/graceful-shutdown/#verifying-it-the-kill-during-load-drill) → then [the budget at both ends of the day](/disruption/pod-disruption-budgets/#the-canonical-pdb-table). **Effort:** an hour to attribute; the shutdown fix is [Lab 8's](/labs/lab-8-deploy-under-load/) afternoon.

### "A pod died and I don't know who killed it"

The pod carries a condition that names the actor — eviction, preemption, a taint, the kubelet — or carries nothing, which is also an answer (you, a rollout, or the HPA).

**Path:** [the decoder](/disruption/anatomy-of-a-drain/#the-decoder-who-killed-my-pod) → the row's page ([When Nobody Asked](/disruption/involuntary-disruptions/) for the machine's kinds). **Effort:** one command if the pod is still Terminating; ten minutes of event archaeology if it's gone — and a watch loop in [the runbook](/disruption/platform-contract/#the-maintenance-window-runbook) so it's one command next time.

### "Our pods went Pending after a drain and stayed there"

The eviction was permitted; the replacement had nowhere to land — full survivors, a hard anti-affinity rule, a topology spread that still counts the cordoned node, a volume pinned to the drained node, or a quota with no headroom. The `FailedScheduling` message says which.

**Path:** [the FailedScheduling decoder](/disruption/where-pods-land/#the-failedscheduling-decoder) → the matching trap → [Pod Pending](/troubleshooting/pod-pending/) for anything not drain-related. **Effort:** ten minutes to diagnose; the fix ranges from one field (`ScheduleAnyway`) to a storage migration.

### "The drain took forty minutes and it was us"

Quorum sets drain one member at a time by construction, and each move costs the grace period plus startup plus catch-up. That's correct — but forty minutes should be a number you gave the platform team in advance, not a surprise.

**Path:** [why the drain takes forty minutes](/disruption/stateful-and-quorum/#why-the-drain-takes-forty-minutes) → [the drain-side dual of `G`](/disruption/anatomy-of-a-drain/#5-the-drain-waits-for-each-pod-to-be-gone) → [the giant-G anti-pattern](/tuning/rollout-shutdown-knobs/#anti-patterns) → send the measured number ([the contract](/disruption/platform-contract/#what-to-promise-back)). **Effort:** an hour to measure from the last window's `Killing` timestamps; readiness fixes are a PR.

### "Our Valkey / Postgres / RabbitMQ lost quorum during maintenance"

Either the budget permitted two members at once (a shared selector across roles, or `minAvailable` that didn't survive a scale), or readiness said "back" before the member had caught up and the budget believed it.

**Path:** [the rule and its two shapes](/disruption/stateful-and-quorum/#the-rule-and-its-two-shapes) → [readiness is the whole game](/disruption/stateful-and-quorum/#readiness-is-the-whole-game) → [who owns the PDB](/disruption/stateful-and-quorum/#who-owns-the-pdb) (an operator may already have written one — and two is a 500) → your build's page. **Effort:** an afternoon including the readiness probe review.

### "Our nightly Job burned all its retries during an upgrade"

An evicted Job pod counts against `backoffLimit` as if your code had crashed. A drain across three nodes can spend three retries without a bug in sight. One rule fixes it.

**Path:** [Jobs: stop burning retries on drains](/disruption/involuntary-disruptions/#jobs-stop-burning-retries-on-drains) → [checkpoint or be idempotent](/workloads/graceful-shutdown/#shutdown--everything-else) → [the calendar](/disruption/platform-contract/#what-to-ask) so the batch and the window stop meeting. **Effort:** one YAML rule; the checkpointing is real engineering if the job doesn't have it.

### "The HPA scaled us to two at 3 a.m. and then the drain came"

A `minAvailable` equal to your HPA floor permits nothing at the floor — the drain waited until the platform's timeout and someone got paged, at 3 a.m., about a service that was fine.

**Path:** [the 3 a.m. problem](/disruption/pod-disruption-budgets/#pdb-and-hpa-the-3-am-problem) → switch to `maxUnavailable: 1` in the chart ([take this with you](/disruption/pod-disruption-budgets/#take-this-with-you)). If you're mid-autoscaling work, the [autoscaling scenarios](/autoscaling/scenarios/) route back here too. **Effort:** one values change; check the ceiling row of the table while you're there.

### "We have one replica and can't add another — license, state, single writer"

Then the honest budget is one that *permits* the eviction and documents the outage, paired with an agreed window — never one that blocks maintenance forever on a service that goes down when the node does anyway.

**Path:** [the one-replica honesty](/disruption/pod-disruption-budgets/#the-one-replica-honesty) → [the contract's exception process](/disruption/platform-contract/#what-to-promise-back) → for state, [the stateful page](/disruption/stateful-and-quorum/) on getting to two. **Effort:** ten minutes for the budget; the conversation about being a singleton is the real work.

### "I'm reviewing someone's PDB PR"

**Path:** [the review checklist](/disruption/platform-contract/#the-pdb-review-checklist) — shape, derivation with a stated level, both ends of the load table, selector helper, no overlap, policy chosen deliberately, proof in the PR. **Effort:** ten minutes per PR once you've read [the PDB page](/disruption/pod-disruption-budgets/) once.

### "We want to know when maintenance is coming, and whether we survived it"

**Path:** [what to ask](/disruption/platform-contract/#what-to-ask) (the calendar is question four) → [the window runbook](/disruption/platform-contract/#the-maintenance-window-runbook) → [the alerts](/disruption/platform-contract/#alerts-and-dashboards) so a budget at zero pages you, not them. **Effort:** one request, one wiki page, one PrometheusRule.

### "We run on a tiny cluster — or a single node. Does any of this apply?"

More than anywhere: with no room to land, every eviction the budget permits produces a Pending replacement and the drain blocks *itself*. The mechanisms are identical; the headroom isn't.

**Path:** [there is nowhere to land](/disruption/where-pods-land/#there-is-nowhere-to-land) → [Lab 11](/labs/lab-11-survive-the-drain/), which uses a single node as a feature and reproduces the stalemate on purpose. **Effort:** the lab is an afternoon; the capacity conversation is [the ledger's](/autoscaling/capacity-and-governance/).

## Where next

- **Next in the journey:** none of the above? Start at [Disruption, Explained From Zero](/disruption/overview/) and read the section in order.
- **The lateral jump:** just want the tables — [Disruption on One Page](/disruption/cheat-sheet/).
