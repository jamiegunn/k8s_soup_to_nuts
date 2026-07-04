---
title: "Requests & Limits on a Running Fleet"
description: Retrofitting resource management onto an existing, live-traffic fleet — the audit kit, deriving numbers from production history instead of load tests, and the wave-by-wave rollout choreography that doesn't page anyone.
sidebar:
  order: 5
---

The [Sizing Walkthrough](/tuning/sizing-walkthrough/) is the luxury version: a brand-new service, a load-test environment, and permission to be wrong in staging. Most of us don't get that. We inherit forty Deployments that have been serving production traffic for three years, sized by whoever was on the team at the time, and the mandate is "get this under control **without an incident**." That is a different discipline. This article is that discipline: audit what you have, derive numbers from the traffic you're already serving, and change things in an order that never bets the fleet on one edit.

## Where brownfield fleets actually start

Every fleet audit I've run finds the same five archetypes. Be honest about which ones you have, because each one fails differently and each one is retrofitted differently.

| Starting position | How it got there | The failure mode you're carrying |
|---|---|---|
| **No requests at all** (BestEffort) | "It worked without them" | First evicted under node pressure; scheduler packs it anywhere, so it lands on already-hot nodes. And it makes the *cluster* unschedulable to reason about: the scheduler thinks the node is empty while your pod eats 3 GiB. |
| **Wiki-archaeology requests** | Copy-pasted from a "standard service" Confluence page written in 2021, for a service that has since tripled its traffic and added two caches | Requests bear no relation to usage in either direction; HPA math is fiction |
| **Superstition limits** | An incident happened; someone doubled the memory limit at 2am; nobody ever revisited | Slack the size of the original allocation, forever, times every replica |
| **LimitRange-stamped defaults** | Namespace `LimitRange` injected `256Mi/500m` because the pod spec said nothing | Nobody *chose* these numbers, so nobody defends or questions them. Java services OOM at 256Mi; batch jobs get throttled at 500m |
| **HPA tuned against wrong requests** | The autoscaler target was raised/lowered to "make scaling behave" instead of fixing the request it's a percentage of | The HPA target now *encodes* the wrong request. Fix the request without retuning and you double- or half-scale (math below) |

:::caution[BestEffort is not "no policy", it's the worst policy]
A pod with no requests is scored `BestEffort` for QoS: it is first in line for kubelet eviction, its OOM-kill priority is worst-in-class, and the scheduler counts it as zero when bin-packing. One BestEffort JVM using 4 GiB on a node the scheduler believes has 4 GiB free is how "random" node-pressure evictions happen at 3am. See [Resources and QoS](/workloads/resources-and-qos/) for the QoS ladder.
:::

## The audit kit

You cannot plan waves without the fleet table: **per workload — current requests/limits, actual usage percentiles over 30 days, restart/OOM counts, QoS class.** Build it once, script it, re-run it quarterly.

First, what's *declared* (and what QoS fell out):

```bash
kubectl get pods -n shop -o custom-columns=\
'NAME:.metadata.name,QOS:.status.qosClass,'\
'CPU_REQ:.spec.containers[*].resources.requests.cpu,'\
'MEM_REQ:.spec.containers[*].resources.requests.memory,'\
'CPU_LIM:.spec.containers[*].resources.limits.cpu,'\
'MEM_LIM:.spec.containers[*].resources.limits.memory'
```

```text
NAME                          QOS         CPU_REQ   MEM_REQ   CPU_LIM   MEM_LIM
orders-api-7d9f8b6c5-2xkqp    Burstable   500m      256Mi     <none>    2Gi
legacy-invoicer-6b8d4f-9wjls  BestEffort  <none>    <none>    <none>    <none>
catalog-api-5c7d9e8f-4mnbv    Burstable   2         4Gi       2         4Gi
image-resizer-8e6f5a4-7hgfd   Burstable   100m      256Mi     500m      256Mi
```

Then what's *true*, from Prometheus (full query patterns and the recording-rule versions live in [PromQL for Resources](/observability/promql-for-resources/); these are the four you need for the table):

```promql
# Memory: p99 working set per workload over 30d (the OOM-relevant number)
quantile_over_time(0.99,
  sum by (namespace, pod) (
    container_memory_working_set_bytes{namespace="shop", container!=""}
  )[30d:5m]
)

# CPU: p95 of the 5m usage rate over 30d
quantile_over_time(0.95,
  sum by (namespace, pod) (
    rate(container_cpu_usage_seconds_total{namespace="shop", container!=""}[5m])
  )[30d:5m]
)

# OOM kills over 30d (any nonzero = under-provisioned, full stop)
sum by (namespace, pod, container) (
  increase(kube_pod_container_status_restarts_total[30d])
  * on (namespace, pod, container) group_left
  kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}
)

# CPU throttling ratio — hidden latency tax from too-tight limits
sum by (namespace, pod) (increase(container_cpu_cfs_throttled_periods_total[30d]))
/
sum by (namespace, pod) (increase(container_cpu_cfs_periods_total[30d]))
```

A word on the OOM query, because the tempting one-liner — `increase(kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}[30d])` — is a lie: that metric is a 0-or-1 **gauge**, not a counter, so `increase()` over a pod chronically parked at 1 returns ~0 and your worst OOM offenders score clean. (It looks diligent in review, which is exactly the problem.) The join above counts actual restarts and keeps only the ones whose last termination was an OOM. One honest caveat on the honest version: `last_terminated_reason` reflects only the *most recent* termination, so a pod restarting for mixed reasons undercounts its OOMs — directionally right, not exact.

Join the two (a 60-line Python script against the Prometheus HTTP API, or a Grafana table panel — the join key is `namespace/pod` collapsed to the workload name) and you get the fleet table. This is the artifact everything else in the article consumes; here's what a real one looks like:

| Workload | QoS | CPU req → p95 use | Mem lim → p99 WSS | OOM/30d | Throttle | Verdict |
|---|---|---|---|---|---|---|
| orders-api | Burstable | 500m → 380m | 2Gi → 1.4Gi | 0 | 0% | Close; trim mem to 1.8Gi eventually |
| legacy-invoicer | **BestEffort** | — → 720m | — → 3.1Gi | 0* | 0% | **Wave 1.** *Zero OOMs but 4 node-pressure evictions |
| catalog-api | Guaranteed | 2000m → 240m | 4Gi → 610Mi | 0 | 0% | 88% waste × 12 replicas — the money row |
| image-resizer | Burstable | 100m → 470m | 256Mi → 249Mi | **7** | **34%** | **Wave 1.** OOMs monthly, throttled always |
| nightly-report | Burstable | 250m → n/a | 512Mi → n/a | 2 | n/a | CronJob — percentile queries lie here, see special cases |

Every workload lands in a quadrant:

| | **Usage well below request** | **Usage at/above request (or OOMs)** |
|---|---|---|
| **Has requests** | Over-provisioned: pure money. Safe to fix slowly. Feed it to [Cost and Rightsizing](/operations/cost-and-rightsizing/). | Under-provisioned: incidents waiting. Fix first, and fixing means *raising* — nobody argues. |
| **No requests** | Both problems at once: invisible to capacity planning *and* first to die. | The time bomb. Top of every wave plan. |

Sort by `(waste × replica count)` on one axis and `(OOM count + throttle ratio + BestEffort)` on the other. Your first wave plan writes itself: risk first, money second.

:::note[VPA in recommendation mode is a free second opinion]
If your platform runs the Vertical Pod Autoscaler, create a `VerticalPodAutoscaler` with `updateMode: "Off"` per workload — it computes lower-bound/target/upper-bound recommendations from the same usage history without ever touching a pod. Don't let it auto-apply on a brownfield fleet (that's an unscheduled rolling restart with numbers you didn't review), but as a cross-check on your percentile math it's excellent: when your spreadsheet and VPA's target disagree by 2×, one of you has a bug.
:::

## Deriving numbers from live traffic

Here is the brownfield consolation prize, and it's a big one: **you don't need a load test, because production has been load-testing this service continuously for years.** A 30-day percentile over real traffic captures your real request mix, your real cache hit rates, your real pathological customers — everything a synthetic test approximates badly. Greenfield sizing guesses at the workload; you *have* the workload.

The formulas are the same ones from [Requests & Limits Knobs](/tuning/requests-limits-knobs/):

- **Memory limit** = p99 working set × 1.2–1.4; **memory request = limit** (Guaranteed-style memory, no eviction roulette).
- **CPU request** = p95 usage rate; **CPU limit** = usually none (the throttling argument is made in the knobs article).

Two brownfield-specific traps in the data itself:

**The seasonality trap.** A 30-day window taken in mid-July misses month-end billing runs, quarter-close, and Black Friday. The rule: **your observation window must contain your longest business cycle, and you size to the max over that window, not the average of windows.** If you can't wait for the cycle, pull last cycle's peak explicitly:

```promql
# What did this thing peak at during last November?
max_over_time(
  sum by (pod) (container_memory_working_set_bytes{namespace="shop", pod=~"orders-api-.*"})
  [30d:5m] @ 1764547200   # pin the evaluation to Dec 1 last year
)
```

If retention doesn't go back that far, say so in the PR description and pick a wider margin. A number with a documented confidence level beats a precise number nobody can defend.

**The no-history bootstrap.** Some services predate your Prometheus retention, or their metrics were never scraped. Don't guess and don't skip them: give them a deliberately conservative interim spec (current LimitRange default × 2 is a fine opening bid, or eyeball one pod with `kubectl top pod`), tag it `sizing: interim` in the manifest, and put a **two-week observation window** on the calendar before anyone judges the numbers. The interim spec's job is to be safely wrong; the two weeks make it right.

:::caution[The JVM wrinkle: your heap fossilized at the old limit]
`MaxRAMPercentage` ergonomics read the container memory limit **once, at JVM startup**. A service that has run with a 4 GiB limit since 2022 has a heap sized against 4 GiB — and its "usage" percentiles partly reflect that heap ceiling, not intrinsic need (a JVM happily fills whatever heap you give it before GC-ing harder). When you shrink the limit, the restart re-runs ergonomics and the heap shrinks with it — usually fine, occasionally an OOM-loop if the live set doesn't fit the new heap. Check `jcmd 1 GC.heap_info` live-set numbers before shrinking a JVM's limit, and read [JVM ↔ Kubernetes Coupling](/java/jvm-kubernetes-coupling/) and [JVM Memory Knobs](/tuning/jvm-memory-knobs/) before touching any Java workload in the fleet.
:::

## The safe rollout choreography

This is the heart of the article. The math above is an afternoon's work; not causing an incident with it is the actual job. Four rules, then the checklist.

**Rule 1 — waves, not fleets.** Never change every workload at once, no matter how confident the spreadsheet makes you feel. Pick one low-criticality, well-observed canary workload; then tier the rest by blast radius (internal tools → async workers → customer-facing read paths → the checkout flow). Each wave gets a watch window before the next starts.

**Rule 2 — one dimension at a time, memory first.** Memory has a deterministic failure mode: cross the limit, get OOM-killed, exit 137, visible in one query. CPU failure is smeared: throttling shows up as p99 latency drift you'll argue about for a week. Fix memory across a wave, watch, *then* do CPU. If you change both and latency regresses, you don't know which knob did it.

**Rule 3 — every change through git.** A `kubectl edit` at 4pm is a change your GitOps controller reverts at 4:03, or worse, a change that silently survives until the next deploy stomps it and "the incident fix disappeared." Resource specs are code: PR, review, merge, sync — see [Drift and CI/CD](/operations/drift-and-cicd/) and [GitOps for Tenants](/operations/gitops-for-tenants/).

**Rule 4 — a resource change IS a deploy.** Editing `resources:` changes the pod template hash, which triggers a full rolling restart of the workload. Schedule it like a release: not Friday 5pm, not during the marketing campaign, with someone watching. [Resource Tuning in Prod](/operations/resource-tuning-in-prod/) covers the operational wrapper in depth.

A wave plan, concretely — this is a document, checked into the same repo as the manifests:

```text
Wave 0 (canary)   image-resizer          — worst offender, internal-only, well-dashboarded
                  memory: 256Mi → 640Mi (p99 WSS 249Mi was pinned AT the limit; real
                  demand is above it — expect the new p99 to settle higher, then re-measure)
                  watch: 48h  | abort: any OOM, restart rate > baseline+2
Wave 1 (risk)     legacy-invoicer        — BestEffort → requests 750m/3.5Gi, limits mem 3.5Gi
                  ⚠ pre-check node headroom with platform team (see special cases)
                  watch: 72h  | abort: Pending >5m, any eviction
Wave 2 (memory)   catalog-api, orders-api, 6 others — memory only
                  watch: 1 week (catalog has month-end batch reads)
Wave 3 (CPU)      same set — CPU requests to honest p95, HPA retuned in same PRs
                  watch: 1 week | abort: throttle >5%, p99 latency >20% over baseline
Wave 4 (batch)    CronJobs — max-observed sizing, CPU limits added
```

And the PR that executes a Wave 3 entry — note the two files changing *together*:

```diff
 # apps/catalog-api/deployment.yaml
       containers:
         - name: catalog-api
           resources:
             requests:
-              cpu: "2"            # wiki default, 2021
+              cpu: "300m"         # p95 240m over 90d incl. month-end; sized 2026-07 (fleet audit Q3)
               memory: "4Gi"
 # apps/catalog-api/hpa.yaml
   metrics:
     - type: Resource
       resource:
         name: cpu
         target:
           type: Utilization
-          averageUtilization: 30   # tuned low in 2023 to "make scaling work" against the 2-core request
+          averageUtilization: 80   # scale-out point held at ~240m/pod: was 2000m×30%=600m (never
+                                   # fired); now 300m×80%=240m = p95, i.e. HPA finally functional
```

That comment trail is not decoration — it's what stops the next person from "fixing" your numbers back.

### Pre-flight checklist, per workload

Run this before merging each PR. Every line here is a real incident I've watched someone have.

- [ ] **Quota headroom for the surge.** A rolling update runs old + new pods simultaneously (`maxSurge` worth). If you're *raising* requests near the namespace quota ceiling, the surge pods won't schedule and the rollout wedges half-done — old pods keep serving, new pods sit unschedulable, and the deploy hangs at 50% for hours until someone notices. Check first:

  ```bash
  kubectl describe resourcequota team-quota -n shop
  ```

  ```text
  Name:            team-quota
  Resource         Used    Hard
  --------         ----    ----
  requests.cpu     7200m   8
  requests.memory  14Gi    16Gi
  ```

  800m of CPU headroom means a workload whose new request is 500m with `maxSurge: 2` (needs 1000m during the roll) **wedges**. Either roll with `maxSurge: 1`, or have the quota raised temporarily, or do the diet waves (which *free* quota) before the raise waves.
- [ ] **PDB exists.** A rolling restart with no `PodDisruptionBudget` and an unlucky node drain mid-rollout can take you to zero replicas. See [High Availability](/workloads/high-availability/).
- [ ] **HPA target recalculated BEFORE the CPU request changes.** This is the trap that bites everyone once. The HPA scales on utilization *as a percentage of the request*. Suppose the pod really uses 400m at comfortable load, the old request was 200m (wiki archaeology), and the HPA target is 70%. Today the HPA sees 400m/200m = **200% utilization** and has scaled you to ~3× the replicas to drag it down to 70% — the wrong request has been silently over-scaling you for a year. Now you correct the request to 500m without touching the target: utilization becomes 400m/500m = 80%... measured across a replica count that immediately collapses as the HPA scales in, concentrating load on fewer pods. The invariant to preserve is **absolute scale-out point** (`request × target%`), not the target number. Old trigger: 200m × 70% = 140m/pod. If your *intended* trigger is "scale when a pod exceeds 350m," the new target is 350m/500m = **70% of the honest request** — same percentage by coincidence here, but do the arithmetic every time and ship the HPA change *in the same PR* as the request change. Full treatment in [Autoscaling](/workloads/autoscaling/).
- [ ] **Alert thresholds that reference the old numbers.** Any alert written as `working_set > 1.8Gi` (hardcoded against the old 2Gi limit) either goes blind or goes off permanently after the change. Grep the rules; better, rewrite them as ratios against `kube_pod_container_resource_limits` while you're in there — see [Alerting](/observability/alerting/).
- [ ] **Shrink pre-check** (below, under special cases): never lower a memory limit below current p99 working set.
- [ ] **In-place resize where the platform offers it.** On clusters with in-place pod resize enabled (stable in recent Kubernetes), a resource change can apply *without* killing the pod — dramatically lower-risk for careful, incremental steps, because you skip the rolling restart entirely:

  ```yaml
  containers:
    - name: orders-api
      resizePolicy:
        - resourceName: cpu
          restartPolicy: NotRequired      # CPU changes apply live
        - resourceName: memory
          restartPolicy: RestartContainer # memory changes restart the container (JVM heap must re-ergonomize anyway)
  ```

  Note the memory asymmetry: even where the kubelet *can* resize memory live, a JVM's heap won't re-ergonomize without a restart, so `RestartContainer` for memory is honest rather than cautious. Ask your platform team what's enabled; don't assume.

### Watch windows and rollback criteria

Every wave gets a written watch window (24h minimum for memory changes; one full business cycle for anything seasonal-adjacent) and **pre-agreed abort criteria** — decided before the merge, when everyone is calm:

| Signal | Query sketch | Abort threshold |
|---|---|---|
| OOM kills | `increase(...restarts_total[1h]) * on (...) group_left ...last_terminated_reason{reason="OOMKilled"}` — the audit-kit join, `[1h]` window | **Any**, on a workload you just shrank |
| Restart rate | `increase(kube_pod_container_status_restarts_total[1h])` | > baseline + 2 |
| Throttle ratio | throttled/total CFS periods | > 5% where it was ~0 (CPU wave) |
| p99 latency | your service SLI | > SLO, or > 20% over the pre-wave baseline |
| Pending pods | `kube_pod_status_phase{phase="Pending"}` | Any pod pending > 5m post-rollout |

Rollback is `git revert` + sync — which is itself another rolling restart, which is why the PDB box got checked. Two rollback realities worth writing into the wave doc:

- **Rollback restores the config, not the casualties.** If the shrunk limit OOM-killed pods mid-wave, the revert stops the bleeding but the restarts already happened; check whether anything stateful (in-flight jobs, local queues) needs manual attention.
- **`kubectl rollout undo` is the emergency-only path.** It works instantly but puts the live state out of sync with git, and your GitOps controller will re-apply the bad spec on its next sync unless you pause reconciliation first. The clean loop is revert-merge-sync; the 3am loop is pause-undo-then-revert-in-git-before-unpausing. Decide which you're running *before* the wave, and write the pause command into the doc.

## The special cases

**Adding requests can make a pod unschedulable.** This one surprises people every time. The BestEffort pod scheduled fine *because it counted as zero*. Give it its honest 2 GiB request and the scheduler may discover there is no node with 2 GiB unallocated — because the cluster has been silently overcommitted for years and your pod was part of the overcommit. The symptom is unmistakable:

```text
$ kubectl get events -n shop --field-selector reason=FailedScheduling | tail -1
0/24 nodes are available: 24 Insufficient memory. preemption: 0/24 nodes are
available: 24 No preemption victims found for incoming pod.
```

The pod isn't broken; the cluster's books were, and your change just made the debt visible. Pre-check before the wave: sum the requests you're about to add and compare against `kubectl describe nodes | grep -A5 'Allocated resources'` across the pool. If the pool can't absorb it, this is a conversation, not a YAML edit — bring the fleet table to your platform team and expect it to turn into a node-pool sizing discussion. [Working with the Platform Team](/operations/working-with-platform-team/) has the script; the short version is that "we found 40 pods the scheduler doesn't know about" is information they badly want.

**Shrinking a limit below the current working set = OOM on rollout, guaranteed.** The new pods start, warm up, cross the new limit, die, CrashLoop. Run the pre-check before every shrink:

```promql
# Anything > 0.85 here: do NOT ship the proposed limit
max_over_time(
  sum by (pod) (container_memory_working_set_bytes{pod=~"orders-api-.*", container!=""})[7d:5m]
) / (1.5 * 1024 * 1024 * 1024)   # proposed new limit: 1.5Gi
```

**Multi-container pods: the requests are per-container, the surprise is the sidecar.** Your service-mesh injects `istio-proxy` with its own requests (often 100m/128Mi) into every pod at admission — it's in no manifest you own, but it counts against quota and node fit, and *its* usage is inside your per-pod usage queries unless you filter by `container`:

```promql
# Per-container, not per-pod — the sidecar gets its own row
quantile_over_time(0.99,
  sum by (pod, container) (
    container_memory_working_set_bytes{namespace="shop", pod=~"orders-api-.*", container!=""}
  )[30d:5m]
)
```

Audit and size per **container**, not per pod; a mesh sidecar under proxy load can itself be the under-provisioned container that OOMs "your" pod. And remember the injected sidecar when the quota math comes out 10% higher than what your YAML says it should be.

**CronJobs and Jobs: percentiles don't apply.** A nightly job that runs for 14 minutes contributes almost nothing to a 30-day p95 — the percentile launders its peak away. Size batch work to **max observed over all runs, plus margin**:

```promql
max_over_time(
  sum by (pod) (container_memory_working_set_bytes{pod=~"nightly-report-.*", container!=""})[30d:1m]
)
```

And a batch job is the one archetype where a CPU *limit* is often right — it has no latency SLO and every neighbor does.

## The politics of taking resources away

Shrinking someone's limits reads as theft, and the burden of proof is on you — as it should be, since you're the one introducing risk into their working service. What actually works:

1. **Lead with their data, not your policy.** "Your p99 working set over 90 days is 610Mi; the limit is 4Gi" is a conversation. "New standards require rightsizing" is a fight.
2. **Propose the margin, don't impose it.** Offer p99 × 1.4 instead of × 1.2 for nervous owners. The difference is pennies; the goodwill funds the next ten workloads.
3. **Agree the rollback trigger in the PR.** "Any OOM or p99 regression in 48h and we revert, no questions" removes most of the fear — it converts an argument about *whether* into an agreement about *how we'd know*.
4. **Renegotiate the quota after the diet, not during.** Once the namespace genuinely needs half its ResourceQuota, giving the headroom back is what makes the exercise visible to whoever pays the node bill ([Cost and Rightsizing](/operations/cost-and-rightsizing/)) — and it's your credibility deposit for the next time you need quota *raised* quickly.

:::note[Slack is not automatically waste]
Some over-provisioning is deliberate: failover headroom, a pending feature launch, a known seasonal peak. The audit finds slack; only the owner knows which slack is load-bearing. Ask before you cut — and write the answer down in the manifest as a comment, so the next auditor doesn't re-litigate it.
:::

## The repeatable ritual

Rightsizing done once decays in about two quarters — traffic grows, features ship, the fossil record accretes again. What keeps a fleet honest is a small, boring, calendared loop:

1. **Quarterly fleet audit** — the scripted kubectl + PromQL sweep from above, dumped into the same spreadsheet format every time so quarter-over-quarter drift is visible.
2. **Top-5 offenders** — by the two quadrant axes: worst risk, worst waste. Five, not fifty; the ritual survives because it's small.
3. **Wave plan** — canary → tiers, memory then CPU, HPA and alerts in the same PRs, watch windows written down.
4. **Done criteria** — each workload exits the list when: usage/request between 60–90%, zero OOM kills in the window, throttle ratio < 1%, HPA target derived from the honest request, and a manifest comment saying who sized it and against which window.

New services shouldn't enter the fleet unsized either — point their teams at the [Sizing Walkthrough](/tuning/sizing-walkthrough/), which is this entire article with the luxuries of a load-test rig and no production traffic to endanger. And for what every one of these knobs *does* at the cgroup level — the semantics this article schedules but doesn't re-derive — the reference is [Requests & Limits Knobs](/tuning/requests-limits-knobs/).
