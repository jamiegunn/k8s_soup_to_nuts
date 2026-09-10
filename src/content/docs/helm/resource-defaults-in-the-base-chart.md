---
title: "The Blank Resources Block"
description: Should the platform's base chart ship default requests and limits, or leave the block empty for teams to fill? Both sides argued for a Java fleet with a spread of -Xmx values — then a verdict, with the conditions under which it flips.
keywords:
  - base chart resources default
  - golden chart default requests limits
  - resources empty helm values passthrough
  - besteffort pods missing requests
  - limitrange defaultrequest vs chart default
  - xmx bigger than memory limit oomkilled
  - maxrampercentage ignored when xmx set
  - serial gc 1792mb two cpus ergonomics
  - hpa utilization percentage of default request
  - values.schema.json required resources
  - kyverno require requests audit enforce
  - who owns requests platform team or app team
  - devsecops base chart pipeline defaults
sidebar:
  order: 7
---

Every paved-road chart has a `resources:` block, and in most of them it is empty. The DevSecOps team that owns the pipeline and the base chart left it that way on purpose, with a comment: *override per service, based on your project's requirements*. Then the fleet grew to a few hundred Java services, a quarterly audit found a fifth of them running as BestEffort, and the argument started. One side wants the base chart to ship a sensible default so that nothing can deploy unsized. The other side — delivery teams, and about half the platform team — says a default is a number nobody measured, wearing a policy badge. Both positions are held by competent people and both are partly right, which is why the argument keeps recurring in chart review instead of getting settled.

This page settles it, or at least argues it properly: the case for defaults at its strongest, the case against at its strongest, the exchange between them round by round, and then a verdict with the conditions under which it flips. The vocabulary note first: this site says *platform team* for the people who own the cluster, the pipeline, and the shared chart; if yours calls them DevSecOps, read the two as the same seat. The mechanics this page leans on are the [resources family](/tuning/requests-limits-knobs/) and the [JVM memory budget](/tuning/jvm-memory-knobs/); the arithmetic of what a default actually does to each JVM is worked through in the companion page, [One Default, Many Heaps](/tuning/one-default-many-heaps/).

## The block in question

The base chart, abridged to the part everyone argues about:

```yaml
# base-chart/values.yaml — platform-owned, consumed by every service pipeline
image:
  repository: ""            # required
  digest: ""                # required — CI pins it
javaOpts: ""                # rendered into the JAVA_OPTS env var; teams put heap flags here

# Requests and limits are intentionally blank. Every service sizes itself —
# override `resources` in your values file based on your project's requirements.
resources: {}
```

The block is a verbatim passthrough, exactly as [Rule 4](/helm/authoring-best-practices/) says it should be, and it is empty. What consumers put in `javaOpts` is the part of the picture the defaults proposal usually doesn't have in front of it — five representative services from a fleet of a few hundred:

| Service | `javaOpts` (abridged) | Heap ceiling | Non-heap it actually needs | Honest limit (request = limit) |
|---|---|---|---|---|
| ledger-api | `-Xms512m -Xmx512m -XX:+UseG1GC` | 512Mi | ~450Mi (small metaspace, ~80 threads) | 1Gi |
| orders-api | `-Xmx1g -XX:MaxMetaspaceSize=192m` | 1Gi | ~600Mi | 1.75–2Gi |
| pricing-batch | `-Xms2g -Xmx2g -XX:+AlwaysPreTouch` | 2Gi | ~700Mi | 3Gi |
| catalog-cache | `-Xmx4g -XX:MaxDirectMemorySize=512m` | 4Gi | ~1.3Gi (direct buffers, G1 structures) | 5.5–6Gi |
| notify-worker | `-XX:MaxRAMPercentage=65` (no `-Xmx`) | 65% of the limit | the other 35% | any — the heap follows the limit |

The non-heap column is the itemized budget from [JVM Memory Knobs](/tuning/jvm-memory-knobs/) — metaspace, code cache, thread stacks, direct memory, GC structures, allocator overhead, a margin — estimated per service rather than copied from one. Hold on to this table; the whole argument turns on it.

And the proposal on the table, in the form it usually arrives:

```yaml
# Proposed base-chart default: "sane for most services, Guaranteed so nothing gets evicted"
resources:
  requests: { cpu: 250m, memory: 1Gi }
  limits:   { cpu: "1",  memory: 1Gi }
```

## The case for defaults

Start where the platform team stands, because their case is better than the delivery side usually admits.

**BestEffort is the worst row of the QoS table, and blank ships it.** A pod with no requests is invisible to the scheduler's math, first in line for kubelet eviction under node pressure, and worst-in-class for the OOM killer's victim selection — the [QoS ladder](/workloads/resources-and-qos/) is explicit that "no requests" means "first to die", not "flexible". It also blinds the autoscaler: a CPU HPA computes utilization as a percentage of the request, and a container with no request produces `missing request for cpu` and no scaling at all ([HPA not scaling](/troubleshooting/hpa-not-scaling/)). An empty block that one team forgot is not a neutral outcome; it is the worst outcome, shipped by omission. A default turns the forgotten case from *worst* into *mediocre*, and mediocre is survivable.

**The fleet has to be legible.** Quota sizing, the [capacity ledger](/autoscaling/capacity-and-governance/), chargeback, and the cluster autoscaler's arithmetic all need a number in every pod. A fleet where a fifth of the pods carry no request has a ledger that is precisely wrong: the scheduler believes those nodes are empty while the JVMs on them eat gigabytes. Presence everywhere is a precondition for any capacity conversation, and a default is the cheapest way to get presence everywhere.

**Policy already requires it.** "Every container declares requests" is a standard admission control, and it is on most compliance checklists. Without a default, a new team's first deploy is rejected at admission with a message they don't yet understand, the pipeline goes red, and the ticket lands on the platform desk. A default keeps the paved road paved: the first `helm upgrade` works, and the team learns sizing in week three, with metrics, rather than on day one from a document.

**Teams copy blocks anyway.** The delivery side's "every service sizes itself" is, in practice, "every service copies the block from the last service somebody saw." The [copying-blocks anti-pattern](/tuning/requests-limits-knobs/#anti-patterns) is already the norm; a curated default at least started life as a considered number instead of an inherited accident.

**The audit is today's problem.** Twenty percent of the fleet is BestEffort *now*. A default fixes those tonight; the [brownfield wave plan](/tuning/brownfield-resources/) takes a quarter and needs every team's attention.

**And this site preaches the same philosophy.** The autoscaling section's [golden values](/autoscaling/capacity-and-governance/) exist so that "the safe path is the lazy path." A resources default is the same idea applied to the block that matters most.

That is a serious case. It gets one thing right that the blank side has to concede before it says anything else: **a blank block that is allowed to reach the cluster is indefensible.** Nobody in the argument should be defending it. The disagreement is about the *mechanism* that stops it — and about what a default does to the four rows in the table it doesn't fit.

## The case against defaults

**A default isn't a number; it's a guess with a badge.** Every value on a running pod is supposed to trace to a measurement with a date on it — that is the [tuning section's](/tuning/overview/) whole method. A base-chart default traces to a meeting. Worse, it arrives with the platform team's authority attached, which makes it *less* likely to be revisited than a copied block: "the platform set it, they must know." The team that copied a number from a neighbor at least suspects it is wrong.

**The table has five rows and the default fits one.** Walk the proposal through the fleet:

| Service | With the proposed `1Gi` / `cpu: "1"` default | How it fails |
|---|---|---|
| ledger-api (`-Xmx512m`) | Fits — by accident. The CPU limit gives it one processor: one GC thread, a common pool with parallelism 1 (so `CompletableFuture` quietly switches to a thread-per-task executor), JIT warmup throttled | Slower, not dead — until a startup probe times out under the throttle |
| orders-api (`-Xmx1g`) | Heap ceiling equals the container limit; the ~600Mi of non-heap has no room at all | Dies partway through heap growth: OOMKilled, exit 137, no heap dump — at 3 a.m. under load, because the heap grows lazily toward a ceiling the cgroup can't hold |
| pricing-batch (`-Xms2g -Xmx2g +AlwaysPreTouch`) | Commits and touches 2Gi of heap at startup inside a 1Gi cgroup | Dies at startup: CrashLoopBackOff on the first deploy, exit 137 |
| catalog-cache (`-Xmx4g`) | Heap ceiling four times the limit | Dies the first time the cache fills — for a cache, that's the first minutes of the first deploy |
| notify-worker (`MaxRAMPercentage=65`) | Heap becomes 665Mi — the one row the default was designed for | Works. Also gets Serial GC (next section) |

Two of five die, one limps, one works, one works by accident. Notice which ones die loudly: the services that followed this site's advice (`-Xms` = `-Xmx`, pre-touched) fail at deploy, in CI's face; the ones that didn't fail quietly in production. Neither is the outcome anyone wanted from a default. (A footnote the proposal's own comment gets wrong: the block isn't Guaranteed. Guaranteed requires request = limit for CPU *and* memory; with `250m` against `"1"`, every pod that inherits it is Burstable.)

It doesn't matter which number you pick. Make the default generous instead — `4Gi`, so nothing OOMKills — and catalog-cache still dies, because 4Gi of heap plus 1.3Gi of non-heap does not fit in 4Gi, while the other four rows now hoard: 300 services × 3 replicas × 4Gi is roughly 3.5 TiB of reserved memory before anyone has measured anything, [quota hoarding](/operations/cost-and-rightsizing/) at fleet scale, Pending pods for everyone else, the cluster autoscaler buying ghost nodes. There is no number that is safe in both directions when the inputs span `512m` to `4g`. The correct memory number for each row is a *function of its `-Xmx`* plus a non-heap budget, and `-Xmx` lives in `javaOpts`, in the team's values file. A value that is a function of a team-owned input cannot be a platform-owned constant.

:::caution[The defaults side's mental model is the notify-worker row]
"Set the limit and the heap follows" is true — for a service sized with `MaxRAMPercentage`. In a fleet that sets `-Xmx`, the percentage is silently ignored, because `-Xmx` wins ([JVM Memory Knobs](/tuning/jvm-memory-knobs/) has the danger box). A default limit doesn't *size* those heaps; it draws a kill line beneath them.
:::

**The default chooses the fleet's garbage collector.** At startup the JVM decides whether it is on a "server-class machine" — at least two available processors and roughly 1792 MiB of memory, both read from the cgroup — and picks the default collector (G1 on modern JDKs) if so, Serial GC if not. `limits.memory: 1Gi` fails the memory test on its own; `limits.cpu: "1"` fails the processor test on its own. So the proposed default doesn't just size the fleet, it switches the fleet's collector: every service whose `javaOpts` doesn't name one explicitly (ledger-api's `-XX:+UseG1GC` is the only row that opts out) gets a single-threaded, stop-the-world collector, and the fleet's p99 story changes without a line changing in any team's repository. The CPU limit also sets `availableProcessors()` to 1 — GC and JIT thread counts, the common pool, Netty event loops — and throttles the startup CPU spike that classloading and JIT need, which is how a default turns into readiness-probe timeouts ([JVM–Kubernetes Coupling](/java/jvm-kubernetes-coupling/) is the catalog of these).

**The default sets every autoscaler's denominator.** HPA utilization is usage divided by request. With a `250m` default, a service whose p95 is `800m` runs at 320% and is pinned at `maxReplicas` from its first deploy; a service using `40m` runs at 16%, never scales, and falls over at the first real peak. The default has silently chosen the scaling behavior of every HPA in the fleet — [the interaction](/tuning/overview/) the tuning section warns about, applied three hundred times at once.

**Silent success where you needed loud failure.** [Rule 6](/helm/authoring-best-practices/) is *fail loud and early*. A default is the opposite: it converts "this team hasn't decided" from a render error on day one into an OOMKill at 3 a.m. on day forty. And it destroys the evidence — with a default in place, BestEffort disappears from the QoS metrics, and so does the list of who hasn't sized. You have fixed the graph, not the fleet.

**Defaults become load-bearing, then immovable.** Once two hundred services inherit it, changing it is a fleet-wide resize shipped through a chart version bump — each team's pods restart with a number they never saw, in whichever direction hurts. Raise it and services go Pending on quota; lower it and the ones secretly living on the margin OOMKill. This is [Rule 11's](/helm/authoring-best-practices/) honest cost — versioning — at its worst: the platform team now maintains semver discipline over the *sizing of every application it has never load-tested*. And it can never remove the default, because removing one from a chart whose consumers never set the value is a two-hundred-pod BestEffort event.

**It moves the number away from the people who own the p99.** The [ownership map](/operations/working-with-platform-team/) splits it cleanly: the platform owns capacity *policy* — quota, LimitRange, priority tiers, node shapes — and the team owns the *claim*. A request is a claim on shared capacity, and the claimant should be the party that can be held to it. A default converts a claim into an unaccounted subsidy, and when it OOMKills, the ticket goes to the platform desk, because "the base chart set it."

**It's invisible from where the team stands.** The number is not in the team's values file, its pull request, or its git history. `helm get values <release>` shows user-supplied values only — nothing. Only `helm get values -a` (computed) or the live pod reveals it. Six months later nobody on the team knows their service runs at `250m` / `1Gi`, or why. The [golden service's](/architectures/golden-service/) founding principle is that every default that bites has been consciously set; a base-chart resources default is the definition of an unconsciously inherited one.

**The platform already has a better tool for the floor.** A [LimitRange](/tuning/requests-limits-knobs/#the-limitrange-reality-check) is namespace-scoped, applied at admission to *every* pod regardless of which chart or pipeline produced it — including injected sidecars, `kubectl run` debug pods, and the one team that forked the chart — visible in a single `kubectl describe limitrange`, and changeable without a chart release. If the goal is "nothing ships BestEffort," `defaultRequest` does it for the whole namespace; a chart default does it only for pods from this chart, at this chart version. The chart is the wrong layer for a fleet floor, and a `defaultRequest` floor at least doesn't pretend to be sizing.

## The exchange

Eight rounds, each a claim from the defaults side, the answer, and where it lands.

**Round 1 — "A blank block ships BestEffort pods."**

**Defaults:** The QoS table is not a matter of opinion. An empty block that one team forgets is scheduler-blind and first to die, and forgetting is the normal case.

**Blank:** Only if blank is allowed to reach the cluster. Make presence a render error (`values.schema.json`, or a `fail` guard in the templates), a CI failure (`helm template` in the validate stage, day one), and an admission failure (policy in Audit, then Enforce). Three fences, none of which invents a number.

**Where it lands:** The goal is shared. The mechanism is enforcement, not defaults — and a blank block *without* enforcement is the worst option on the table. Nobody is defending it.

**Round 2 — "Teams copy blocks anyway; a curated default beats a random copy."**

**Defaults:** "Size it yourself" is a fiction. The block gets copied from a neighbor, and the neighbor copied it too.

**Blank:** A copied number sits in the team's file, PR, and history — reviewable, blameable, revisitable. A default sits in nobody's. And "curated" is doing a lot of work: curated for which row of the table? Publish starter recipes per archetype with a revisit date in the comment — the site already ships them in [Requests & Limits Knobs](/tuning/requests-limits-knobs/#recipes) — and let the copy be a conscious act in the team's own repository.

**Where it lands:** Recipes, not defaults. The copy-paste instinct is fine; the invisibility is the problem.

**Round 3 — "Consistency: the capacity ledger needs a number in every pod."**

**Defaults:** You cannot run quota, chargeback, or the capacity conversation over pods with no requests.

**Blank:** The ledger needs *presence*, not *sameness*. A fleet of identical unmeasured numbers gives you a ledger that is precise and false — Σ(desired × requests) computed over fiction. Enforced presence gives you numbers someone signed; a default gives you numbers nobody did.

**Where it lands:** Presence enforcement satisfies the ledger. Defaults corrupt it.

**Round 4 — "Then make the default generous, so nothing OOMKills."**

**Defaults:** Pick a number big enough for the largest common case. Hoarding is cheaper than an outage.

**Blank:** Generous times fleet equals hoard: 4Gi × 300 × 3 ≈ 3.5 TiB reserved and idle. And catalog-cache still dies, because 4Gi of heap plus its non-heap doesn't fit in 4Gi. There is no number that is safe in both directions when the inputs span `512m` to `4g`.

**Where it lands:** Nothing survives. This is the round that decides the memory question.

**Round 5 — "Standardize on `MaxRAMPercentage` and the heap follows whatever default we set."**

**Defaults:** This is the strongest technical version of the case, and it is exactly what [JVM Memory Knobs](/tuning/jvm-memory-knobs/) recommends: heap as a percentage makes the limit the single knob.

**Blank:** Agreed — for a fleet that has made that migration. This one hasn't: four of five services set `-Xmx`, and `-Xmx` wins, so the percentage is ignored. Until each team removes its `-Xmx`, a default limit is a kill line, not a sizing. And even afterwards the *percentage* is still per service — 62% at 2Gi, 45% at 512Mi, lower for direct-memory-heavy apps — so the team is still choosing, just in a different file.

**Where it lands:** The coupling direction is a per-service decision that belongs next to `javaOpts`. The base chart can *guard* it (fail on `-Xmx` with no limit; fail on `-Xmx` plus a percentage) — it cannot *choose* it.

**Round 6 — "The audit says 20% BestEffort today. A default fixes that tonight."**

**Defaults:** The wave plan is a quarter of work across forty teams. The default is one PR, and the BestEffort count goes to zero.

**Blank:** It fixes the metric tonight and deletes the list of who needs fixing. The honest fast fix is the LimitRange `defaultRequest` floor — namespace-scoped, visible, temporary by design — while the [wave plan](/tuning/brownfield-resources/) walks each service to a measured number. A chart default is never temporary; see Round 8.

**Where it lands:** A *floor* is legitimate as a stopgap. A floor lives in the LimitRange, not in the chart.

**Round 7 — "Compliance requires limits on every container; a default keeps the pipeline green."**

**Defaults:** The control exists, the auditors check it, and a red pipeline on every new service is a support cost the platform team pays.

**Blank:** Read what the control actually says. "Requests on every container and a memory limit" is a sound control. "CPU limits on every container" is a checklist item this site [argues against](/tuning/requests-limits-knobs/) for latency-sensitive services, and a default that satisfies it institutionalizes throttling across the fleet. Either way the control is about *presence*, and presence is what the schema guard enforces — the pipeline goes red on `helm template` with a message that says what to do, not at admission with one that doesn't.

**Where it lands:** Satisfy the control with enforcement plus recipes; renegotiate the CPU-limit clause with evidence.

**Round 8 — "Changing a chart default later is one PR."**

**Defaults:** If the number turns out wrong, we change it. That's what a base chart is for.

**Blank:** One PR, three hundred rollouts, each pod restarting with a number its team never saw, in whichever direction hurts. And the reverse operation — removing the default once teams "have all sized themselves" — is impossible to verify, because the default hides who hasn't. The chart is now permanently responsible for the sizing of applications it has never seen.

**Where it lands:** Defaults are load-bearing from the day they ship. Treat adding one as a fleet migration, because removing one is.

## The verdict

**Leave the block blank — and make blank impossible to ship.** The defaults side wins its premise and loses its remedy: unsized pods must never reach the cluster, and a fleet-wide constant is the wrong way to guarantee that, because for a Java fleet with a spread of `-Xmx` values the right memory number is a function of a value each team owns. The verdict holds only with four conditions, and a base chart that meets none of them should ship a default tonight and treat it as debt.

1. **Presence is enforced, loud and early.** The schema (or a `fail` guard) makes a missing request a render error; the pipeline's validate stage makes it a red build on day one; an admission policy in Audit mode reports what slipped through and flips to Enforce on a dated schedule. Every error message says what to do next.
2. **The platform's floor lives in the LimitRange, labeled as a floor.** A small `defaultRequest` so that a bare debug pod schedules and nothing is BestEffort; a memory `max` that protects the node shape; **no CPU `max` and no CPU `default`** — either one stamps a CPU limit onto every container that omits one (the build section shows why), which is the throttle trap installed by the floor itself. CPU claims are bounded by the namespace quota on `requests.cpu`, not by the LimitRange.
3. **Recipes are published, not defaulted.** Starter blocks per archetype, with a mandatory-revisit comment, copied into the *team's* values file; the JVM recipe derived from `-Xmx` — or from the limit, for percentage-sized services.
4. **The JVM coupling is guarded, not chosen.** The chart fails on `-Xmx` with no memory limit and on `-Xmx` combined with `MaxRAMPercentage`; CI checks that the limit can hold the heap; each service picks one coupling direction.

### When the defaults side wins

There are cases where a default in the chart is right, and it is worth being precise about them so the verdict doesn't harden into dogma.

- **The chart deploys one kind of thing, and the chart owner measured it.** A chart for the organization's standard log-forwarder sidecar, or for one internal tool the platform team runs: the platform owns the *workload*, not just the packaging. The test is whether the chart owner could defend the number in review with a dated metric. If yes, it isn't a default; it's a value.
- **A non-production sandbox where "it deploys" is the whole goal.** Nothing has an SLO, nothing is sized, and a starter block in a *sandbox values file* — never in the production base — saves everyone a morning.
- **A genuinely homogeneous fleet.** One runtime, one archetype, one heap policy already migrated to `MaxRAMPercentage`, one measured starter. Even here, prefer the LimitRange floor plus schema enforcement over a chart constant, because the fleet will not stay homogeneous, and the constant will not notice when it stops.
- **The fully unfenced fleet.** No schema support, no CI render step, no admission policy, and BestEffort in production tonight. A default is better than BestEffort *tonight* — but it is a debt with a name, and the first three conditions above are the repayment plan, with a date.

## The build

What the verdict looks like as files. Each piece enforces presence or guards an invariant; none of them contains a number a team didn't choose.

**The values file** — same blank block, a comment that is now useful:

```yaml
# base-chart/values.yaml
# Requests and limits are BLANK ON PURPOSE and REQUIRED: rendering fails until you set
#   resources.requests.cpu, resources.requests.memory, resources.limits.memory.
# Derive them — do not copy a neighbour's block:
#   any service:  /tuning/sizing-walkthrough/   (starter block, then measure, then commit)
#   JVM:          /tuning/jvm-memory-knobs/     (limit = heap + non-heap budget; pick -Xmx OR MaxRAMPercentage)
# The namespace LimitRange is a FLOOR for debug pods, not a sizing. Omit limits.cpu unless you
# can show a throttle ratio that says otherwise: /tuning/requests-limits-knobs/
resources: {}
```

**The schema** — presence of three leaves, nothing else modeled. `helm install`, `upgrade`, `lint`, and `template` all validate against it, so the failure happens at render, not at admission:

```json
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["resources"],
  "properties": {
    "resources": {
      "type": "object",
      "required": ["requests", "limits"],
      "properties": {
        "requests": {
          "type": "object",
          "required": ["cpu", "memory"],
          "properties": {
            "cpu":    { "type": ["string", "number"] },
            "memory": { "type": "string", "pattern": "^[0-9]+(Ki|Mi|Gi|Ti)$" }
          }
        },
        "limits": {
          "type": "object",
          "required": ["memory"],
          "properties": {
            "memory": { "type": "string", "pattern": "^[0-9]+(Ki|Mi|Gi|Ti)$" }
          }
        }
      }
    }
  }
}
```

Two deliberate choices. There is no `additionalProperties: false` anywhere in this fragment, so `ephemeral-storage`, hugepages, extended resources, and an *optional* `limits.cpu` all pass through — the block stays a passthrough, per [Values and Overrides](/helm/values-and-overrides/), and the schema checks its shape without re-modeling it. And the memory pattern demands binary units, which rejects `512m` — the [1000× unit bug](/tuning/requests-limits-knobs/#anti-patterns) — at render time instead of at OOM time. The chart's own tests render with `ci/*-values.yaml` fixtures, which is where a *test* number belongs.

**The guards** — for charts without schema support, or as belt to the schema's braces. Presence first, then the JVM coupling. Assumes `javaOpts` is a string that becomes `JAVA_OPTS`; if yours lives in an `env:` list, `range` over it to build the string:

```yaml
{{- /* templates/_guards.tpl — enforce presence and invariants; never choose a number */ -}}
{{- define "base.guards" -}}
{{- $r := .Values.resources | default dict -}}
{{- if not (and (dig "requests" "cpu" "" $r) (dig "requests" "memory" "" $r) (dig "limits" "memory" "" $r)) -}}
{{- fail "resources.requests.cpu, resources.requests.memory and resources.limits.memory must all be set. The base chart ships no defaults on purpose — derive yours: /tuning/sizing-walkthrough/ (any service), /tuning/jvm-memory-knobs/ (JVM: limit = heap + non-heap budget)." -}}
{{- end -}}
{{- $opts := .Values.javaOpts | default "" -}}
{{- $xmx := regexFind "-Xmx[0-9]+[kKmMgG]?" $opts -}}
{{- $pct := regexFind "MaxRAMPercentage=[0-9.]+" $opts -}}
{{- if and $xmx $pct -}}
{{- fail (printf "javaOpts sets both %s and %s: -Xmx wins and the percentage is silently ignored. Pick one — /tuning/jvm-memory-knobs/" $xmx $pct) -}}
{{- end -}}
{{- if and $xmx (not (dig "limits" "memory" "" $r)) -}}
{{- fail (printf "javaOpts sets %s but resources.limits.memory is empty. The heap ceiling and the container limit are a pair: set the limit to your RSS budget, or drop -Xmx and size the heap with -XX:MaxRAMPercentage." $xmx) -}}
{{- end -}}
{{- end -}}
```

```yaml
# templates/deployment.yaml — first line
{{- include "base.guards" . -}}
```

The guard is small on purpose ([Rule 5](/helm/authoring-best-practices/)): it checks that the pair exists, not that the arithmetic works, because parsing `-Xmx1536m` against `1.5Gi` inside Go templates is exactly the logic soup a chart shouldn't contain. The arithmetic belongs in the pipeline.

**The CI check** — runs on the rendered manifests in the validate stage, between `kubeconform` and the server dry-run ([CI/CD Pipeline Design](/operations/cicd-pipeline-design/)):

```python
#!/usr/bin/env python3
# ci/check-jvm-budget.py — fail the build when a container limit can't hold its heap.
# Usage: helm template ... > rendered.yaml && ci/check-jvm-budget.py rendered.yaml
import re, sys, yaml

UNITS = {"k": 2**10, "m": 2**20, "g": 2**30, "Ki": 2**10, "Mi": 2**20, "Gi": 2**30, "Ti": 2**40}
MIN_HEADROOM = 1.35   # a FLOOR for metaspace + code cache + stacks + direct + GC — not a budget

def java_bytes(flag):                       # -Xmx2g, -Xmx1536m
    n, u = re.fullmatch(r"-Xmx(\d+)([kKmMgG])?", flag).groups()
    return int(n) * (UNITS[u.lower()] if u else 1)

def k8s_bytes(q):                           # 2Gi, 1536Mi, 2147483648 — no lowercase m, ever
    n, u = re.fullmatch(r"(\d+)(Ki|Mi|Gi|Ti)?", str(q)).groups()
    return int(n) * (UNITS[u] if u else 1)

rc = 0
for doc in yaml.safe_load_all(open(sys.argv[1])):
    if not doc or doc.get("kind") not in ("Deployment", "StatefulSet", "Job", "CronJob"):
        continue
    spec = doc["spec"] if doc["kind"] != "CronJob" else doc["spec"]["jobTemplate"]["spec"]
    for c in spec["template"]["spec"].get("containers", []):
        opts = " ".join(e.get("value", "") for e in c.get("env", [])
                        if e.get("name") in ("JAVA_OPTS", "JAVA_TOOL_OPTIONS"))
        xmx = re.search(r"-Xmx\d+[kKmMgG]?", opts)
        if not xmx:
            continue
        limit = c.get("resources", {}).get("limits", {}).get("memory")
        where = f"{doc['metadata']['name']}/{c['name']}"
        if not limit:
            print(f"FAIL {where}: {xmx.group()} with no resources.limits.memory"); rc = 1
        elif k8s_bytes(limit) < java_bytes(xmx.group()) * MIN_HEADROOM:
            print(f"FAIL {where}: limits.memory {limit} cannot hold {xmx.group()} "
                  f"plus non-heap (floor ×{MIN_HEADROOM}) — /tuning/jvm-memory-knobs/"); rc = 1
sys.exit(rc)
```

`1.35` is a floor that catches the orders-api and pricing-batch rows above, not a budget that replaces the itemized one — a direct-memory-heavy service needs more, and the team's values file should show its work in a comment.

**The platform's floor** — one per namespace, owned by the platform team, and described everywhere as a floor:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: floor                      # a FLOOR for unsized pods, not a sizing — the chart guard forces sizing
  namespace: orders-prod
spec:
  limits:
    - type: Container
      defaultRequest:              # stamped on containers that omit REQUESTS: keeps a bare
        cpu: 50m                   # `kubectl run` debug pod or an injected sidecar schedulable,
        memory: 128Mi              # and off BestEffort
      default:                     # stamped on containers that omit LIMITS — memory only, and it
        memory: 128Mi              # only ever lands on those same unsized pods, because the chart
                                   # schema already forces a memory limit on everything it renders
      max:                         # memory only: a pod asking for more is rejected at admission,
        memory: 24Gi               # with a message, instead of Pending forever
      # NO default.cpu and NO max.cpu — each would stamp a CPU limit onto every container that
      # omits one (see the note below). Bound CPU claims with the namespace quota instead.
```

:::note[Under the hood: `max` implies `default`, and `default` implies `defaultRequest`]
A Container-type LimitRange is defaulted by the API server on the way in: any resource with a `max` but no `default` gets `default` = `max`, and any resource with a `default` but no `defaultRequest` gets `defaultRequest` = `default`. Write "just `max.cpu: 8`" and what the cluster stores — `kubectl get limitrange -o yaml` shows the filled-in fields — is "stamp `limits.cpu: 8` *and* `requests.cpu: 8` on every container that doesn't set them," which is how a debug pod ends up Pending on an 8-core request nobody wrote. (A Pod-type `max` has no defaults to fill; it simply rejects pods whose containers carry no limit for that resource.) The consequence for a no-CPU-limit policy: **a LimitRange cannot cap CPU without also stamping CPU limits**, and a ResourceQuota that lists `limits.cpu` rejects any container that omits one. Bound CPU with a quota on `requests.cpu`, keep `max` to memory — where every container carries a limit anyway — and the floor stays a floor. This defaulting chain is also the origin story of most stamped CPU limits in the wild: not a policy decision, a `max` that somebody wrote for node protection.
:::

**The admission policy** — presence only, Audit first. With `background: true` the policy report *is* the list of unsized workloads, which is the list the wave plan needs and the list a chart default would have erased:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-requests
spec:
  validationFailureAction: Audit   # flip to Enforce on the date the wave plan clears the fleet
  background: true                 # report existing violations — this IS the unsized list
  rules:
    - name: cpu-memory-requests-and-memory-limit
      match:
        any:
          - resources:
              kinds: [Pod]
      validate:
        message: "every container needs requests.cpu, requests.memory and limits.memory — derive them, don't default them: /tuning/sizing-walkthrough/"
        pattern:
          spec:
            containers:
              - resources:
                  requests:
                    cpu: "?*"
                    memory: "?*"
                  limits:
                    memory: "?*"
```

Note what the policy does *not* require: `limits.cpu`. If your compliance control says it must, that clause is the [negotiation](/operations/working-with-platform-team/) to have with throttle-ratio evidence in hand, not a reason to stamp a CPU limit on every JVM in the fleet.

**The JVM recipe** — published in the base chart's README and the platform's onboarding doc, copied into the team's values file, never into the chart's:

| `-Xmx` in `javaOpts` | Typical non-heap (Spring-class service) | `limits.memory` = `requests.memory` | Or drop `-Xmx` and size by percentage |
|---|---|---|---|
| `512m` | ~400–500Mi | `1Gi` | `MaxRAMPercentage=50` at `1Gi` |
| `1g` | ~550–650Mi | `1.75Gi`–`2Gi` | `MaxRAMPercentage=60` at `1.75Gi` |
| `2g` | ~650–800Mi | `3Gi` | `MaxRAMPercentage=67` at `3Gi` |
| `4g` | ~900Mi–1.3Gi | `5.5Gi`–`6Gi` | `MaxRAMPercentage=70` at `6Gi` |

Either column works; using both does not (`-Xmx` wins, the percentage is ignored, and the guard above refuses the combination). The non-heap column is an estimate to be replaced by the service's own `container_memory_working_set_bytes` minus heap after a full traffic cycle — the workflow is in [JVM Memory Knobs](/tuning/jvm-memory-knobs/), and the CPU side of the block comes from the [sizing walkthrough](/tuning/sizing-walkthrough/), not from this table.

### What to watch after

The build succeeds when three graphs move. BestEffort pods per namespace go to zero and *stay* there — `count by (namespace) (kube_pod_status_qos_class{qos_class="BestEffort"} == 1)` — because presence is enforced, not because a default painted over them. The Kyverno policy report's violation count falls with each wave and reaches zero before the Enforce date. And OOMKilled restarts do not *rise* after the guard ships: if they do, a service that was quietly living above its heap on a generous neighbor's block has just been made honest, and it needs the [OOMKilled](/troubleshooting/oomkilled/) workflow, not a bigger default. The queries are in [PromQL for Resources](/observability/promql-for-resources/).

The argument in one sentence, for the next chart review: *the platform owns the fences, the team owns the number, and the number for a JVM is a function of a flag only the team can see.* The arithmetic behind that sentence — one default walked through five heaps, with the exit codes — is the companion page, [One Default, Many Heaps](/tuning/one-default-many-heaps/); the plan for the services that are BestEffort *today* is [Requests & Limits on a Running Fleet](/tuning/brownfield-resources/).
