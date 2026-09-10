---
title: "One Default, Many Heaps"
description: One fleet-wide resources default walked through five JVMs with different -Xmx values — which die at startup, which die at 3 a.m., which hoard, which silently switch garbage collectors — then how to read what's stamping your pod and derive the number that is actually yours.
keywords:
  - default memory limit smaller than xmx
  - exit code 137 after base chart upgrade
  - helm get values -a computed resources
  - kubectl describe limitrange stamped defaults
  - serialgc selected in container one cpu
  - printflagsfinal maxheapsize activeprocessorcount
  - hpa target percentage of default request
  - java_opts xmx vs maxrampercentage which wins
  - alwayspretouch crashloopbackoff at startup
  - quota hoarding generous default
  - derive memory limit from xmx non-heap budget
  - guaranteed qos requires cpu request equals limit
sidebar:
  order: 8
---

The base chart's `resources:` block is blank, and the proposal is to fill it with one block for the whole fleet. The governance argument — whether the platform's chart should carry that number at all, and who owns it if it does — is made in full in [The Blank Resources Block](/helm/resource-defaults-in-the-base-chart/). This page is the arithmetic that argument rests on: take the proposed default, apply it to five JVMs with five different `-Xmx` values, and write down what each one does, with the exit code. Read it if you are the platform engineer about to propose the default, or the team whose pod started dying with `137` the day after a base-chart version bump.

The default under test, as proposed:

```yaml
resources:
  requests: { cpu: 250m, memory: 1Gi }
  limits:   { cpu: "1",  memory: 1Gi }     # "Guaranteed, so nothing gets evicted"
```

## The fleet, budgeted

Five services from a fleet of a few hundred, each with the heap its team set in `JAVA_OPTS`, and the limit each would need by the budget in [JVM Memory Knobs](/tuning/jvm-memory-knobs/):

```text
limit ≥ heap + metaspace + code cache + (threads × stack) + direct memory + GC structures + margin
```

| Service | `JAVA_OPTS` (abridged) | Heap ceiling | Non-heap estimate | Honest limit (request = limit) |
|---|---|---|---|---|
| ledger-api | `-Xms512m -Xmx512m -XX:+UseG1GC` | 512Mi | ~450Mi | 1Gi |
| orders-api | `-Xmx1g -XX:MaxMetaspaceSize=192m` | 1Gi | ~600Mi | 1.75–2Gi |
| pricing-batch | `-Xms2g -Xmx2g -XX:+AlwaysPreTouch` | 2Gi | ~700Mi | 3Gi |
| catalog-cache | `-Xmx4g -XX:MaxDirectMemorySize=512m` | 4Gi | ~1.3Gi | 5.5–6Gi |
| notify-worker | `-XX:MaxRAMPercentage=65` (no `-Xmx`) | 65% of the limit | the other 35% | any — the heap follows the limit |

The non-heap column is not a rule of thumb; it is per service, and the biggest row shows why. catalog-cache, itemized the way the [RSS budget](/tuning/jvm-memory-knobs/) is:

| Line item | Where it comes from | Budget |
|---|---|---|
| Heap | `-Xmx4g` | 4096Mi |
| Metaspace (Spring + a large client library set) | uncapped — should be `MaxMetaspaceSize=256m` | 256Mi |
| Code cache | `ReservedCodeCacheSize` default 240M, real use ~128Mi | 128Mi |
| Thread stacks (~200 threads × 1MiB) | `-Xss` default, pool sizing | 200Mi |
| Direct memory | `MaxDirectMemorySize=512m` — this is a cache with NIO clients | 512Mi |
| G1 remembered sets and card tables (~5% of heap) | collector choice | 200Mi |
| glibc arenas, symbols, JVM internals | `MALLOC_ARENA_MAX=2` | 50Mi |
| **Non-heap total** | | **~1.3Gi** |

So catalog-cache needs about 5.5Gi and is comfortable at 6Gi. ledger-api, with a quarter of the threads and a fraction of the classes, needs a tenth of that. The two are in the same fleet, deployed by the same chart, and the proposal gives them the same number.

## One default, applied

Walk the proposal's `1Gi` through the fleet, and — because the first objection is always "then make it bigger" — walk `2Gi` and `4Gi` through as well:

| Service | `limits.memory: 1Gi` (proposed) | `2Gi` | `4Gi` |
|---|---|---|---|
| ledger-api (`-Xmx512m`) | Fits, by accident | Hoards ~1Gi per pod | Hoards ~3Gi per pod |
| orders-api (`-Xmx1g`) | **Dies at 3 a.m.** | Fits | Hoards ~2Gi per pod |
| pricing-batch (`-Xms2g -Xmx2g +AlwaysPreTouch`) | **Dies at startup** | **Dies at startup** | Fits, hoards ~1Gi |
| catalog-cache (`-Xmx4g`) | **Dies in warmup** | **Dies in warmup** | **Dies at first cache fill** |
| notify-worker (`MaxRAMPercentage=65`) | Works (665Mi heap) | Works (1.3Gi heap) | Works (2.6Gi heap) |

No column is green. The percentage-sized row works in every column, which is exactly the row the proposal's authors had in mind — and the only one of five that behaves the way the proposal assumes. The rest die or hoard, and which of the two depends on nothing but the ratio between a number in the team's `JAVA_OPTS` and a number in the platform's chart.

The three deaths are worth telling apart, because they look different in `kubectl describe pod` and they land on different people.

**Dies at startup** (pricing-batch, at `1Gi` and `2Gi`). `-Xms2g` commits 2Gi of heap before `main()` runs and `-XX:+AlwaysPreTouch` faults every page of it in, so RSS crosses `memory.max` while the JVM is still initializing. The kernel's OOM killer fires, the container exits `137`, the kubelet restarts it, and it happens again: `CrashLoopBackOff` on the first rollout after the chart bump, `Last State: Terminated, Reason: OOMKilled`, an empty log. This is the *good* failure — loud, immediate, in the pipeline's face — and note that it happens only to the service that followed this site's advice on `-Xms` and pre-touch ([why Xms = Xmx](/tuning/jvm-memory-knobs/)). The rollout gate in [CI/CD Pipeline Design](/operations/cicd-pipeline-design/) turns it into a red build.

**Dies at 3 a.m.** (orders-api at `1Gi`). No `-Xms`, so the heap starts small and grows on demand toward a 1Gi ceiling that the cgroup can't hold once ~600Mi of non-heap is added. The pod passes readiness, serves traffic for hours, and dies the first time a busy period pushes heap plus non-heap past the line. Same `137`, same empty log, but now with a `Restart Count` that climbs by one every night, a p99 that spikes on each restart while the JIT re-warms, and — because the kernel kills the process, not the JVM — no `OutOfMemoryError`, no heap dump, nothing for `-XX:+HeapDumpOnOutOfMemoryError` to do. The team spends a week hunting a memory leak that does not exist; the workflow that tells them so is in [OOMKilled](/troubleshooting/oomkilled/).

**Dies in warmup** (catalog-cache, in every column). A cache's whole job is to fill its heap, so the lazy-growth death arrives in the first minutes of the first deploy rather than at 3 a.m. — the loud failure again, but one that looks, from the outside, like "the new version is broken," because the previous version ran for months under a limit its team had set to 6Gi in *their* values file, which the chart default now overrides.

:::note[Which wins: the chart default or the team's value?]
The team's. Helm merges values with the consumer's file on top of the chart's `values.yaml` ([the precedence chain](/helm/values-and-overrides/)), so a team that already set `resources` keeps its number. The default lands only on services that set nothing — which is precisely the population nobody has measured, and the population the proposal was meant to protect. The two-hundred-pod event happens in the other direction: the day the default is *changed*, every service that never set a value is resized at once.
:::

And the hoard column is not free either. At `4Gi`, three of the five rows reserve between 1Gi and 3Gi per pod that they will never touch; across three hundred services and three replicas each, that is a tebibyte or more of memory the scheduler considers spent, quota that other teams' rollouts hit as `exceeded quota`, and nodes the cluster autoscaler adds to hold ghost claims — the [hoarding index](/autoscaling/capacity-and-governance/) at fleet scale, purchased to make a default safe that still kills catalog-cache.

One footnote the proposal's own comment gets wrong: the block is not Guaranteed. The QoS class is computed over *both* resources, and Guaranteed requires request = limit for CPU as well as memory. With `250m` against `"1"`, every pod that inherits the default is Burstable — eviction-ordered by how far its usage exceeds its request, which for the hoarding rows is "not at all" and for the dying rows never gets the chance to matter. The [QoS ladder](/workloads/resources-and-qos/) has the rules.

## The side effects that aren't in the memory column

The memory table is the dramatic part. The CPU half of the proposal applies to all five rows equally, and it changes things no memory graph will show.

**The default picks the garbage collector.** At startup the JVM checks whether it is on a "server-class machine": at least two available processors *and* at least roughly 1792 MiB of memory, both read from the cgroup files the kubelet wrote from your `resources` block ([how container support reads them](/tuning/jvm-memory-knobs/)). Pass both and it selects the default collector — G1 on modern JDKs; fail either and it selects Serial GC. `limits.memory: 1Gi` fails the memory test alone. `limits.cpu: "1"` fails the processor test alone. So under the proposal every service that does not name its collector in `JAVA_OPTS` — four of the five rows; ledger-api's explicit `-XX:+UseG1GC` is the exception — runs a single-threaded, stop-the-world collector, and the fleet's pause profile changes without a line changing in any team's repository. Raising the memory default to `2Gi` fixes the memory half of the test and leaves the CPU half failing. The proof is one command against a running pod:

```bash
kubectl exec deploy/orders-api -- java -XX:+PrintFlagsFinal -version \
  | grep -E 'UseSerialGC|UseG1GC|MaxHeapSize|ActiveProcessorCount'
# UseSerialGC = true  and  ActiveProcessorCount = 1  under the proposed default.
# The first line of -Xlog:gc output says the same thing: "Using Serial".
```

**`availableProcessors()` becomes 1.** A CFS quota of one core makes the JVM report one processor ([the coupling](/java/jvm-kubernetes-coupling/)): one GC worker, one JIT compiler thread, a common pool with parallelism 1 — at which point `CompletableFuture` quietly abandons the common pool for a thread-per-task executor, and every `supplyAsync` spawns a thread — and Netty event-loop groups of one. Then the startup CPU spike that classloading and JIT compilation need is throttled against a 100ms-per-100ms quota, startup stretches from 20 seconds to minutes, and the startup probe's `failureThreshold` — sized by the team for *their* CPU — runs out. The symptom is a restart loop that looks like a broken build; the cause is a number in another team's chart. [Health Check Knobs](/tuning/health-check-knobs/) covers the probe math; the throttle ratio that proves it is in [PromQL for Resources](/observability/promql-for-resources/).

**The default sets every autoscaler's denominator.** HPA utilization is usage divided by the request, so a `250m` request decides the scaling behavior of every HPA that inherits it:

| Real steady-state CPU | Utilization against a `250m` default | What the HPA does at a 70% target |
|---|---|---|
| 40m (notify-worker, idle between batches) | 16% | Never scales out; falls over at the first real peak |
| 250m | 100% | Scales out immediately and continuously; the fleet doubles |
| 800m (orders-api, measured in the [walkthrough](/tuning/sizing-walkthrough/)) | 320% | Pinned at `maxReplicas` from the first deploy; the quota conversation happens at 2 a.m. |

The team that tuned its target against a measured request now has a target against somebody else's guess. [HPA not scaling](/troubleshooting/hpa-not-scaling/) is where those tickets end up.

## Read what's stamping you

A number on a running pod can come from six places, and the debugging move is to find which. Top to bottom, later layers only fill what earlier layers left empty — except the last two, which override nothing and reveal everything:

| Layer | Where the number lives | How to see it |
|---|---|---|
| 1. Your values file | `values-prod.yaml` in your repo | `helm get values <release>` — user-supplied only |
| 2. The base chart's defaults | `values.yaml` in the chart, at *that* chart version | `helm show values <chart> --version <v>` |
| 3. The merged result Helm rendered | the release's computed values | `helm get values -a <release>` — if a number appears here and not in layer 1, the chart put it there |
| 4. The namespace LimitRange | platform-owned, applied at admission to whatever omitted a field | `kubectl describe limitrange -n <ns>` — and remember a `max` with no `default` is stored *as* a default |
| 5. API defaulting | limits set, requests omitted → request = limit | only visible on the pod itself |
| 6. The pod | what the kubelet actually wrote into the cgroup | `kubectl get pod <p> -o jsonpath='{range .spec.containers[*]}{.name}{"\t"}{.resources}{"\n"}{end}'` |
| 7. What the JVM concluded | heap, processors, collector — computed once at startup | `kubectl exec <p> -- java -XX:+PrintFlagsFinal -version \| grep -E 'MaxHeapSize\|ActiveProcessorCount\|Use.*GC '` |

The tell for a chart default is a number in layer 3 that isn't in layer 1 and isn't in layer 4. The tell for a LimitRange is a number on the pod that isn't in layer 3. And the tell that matters most for a JVM is a `MaxHeapSize` in layer 7 that is larger than the `memory` limit in layer 6 — that pod is going to die; the only open question is when.

## Derive yours

The number that fits your service is a function of your `-Xmx`, and there are two coherent ways to write the pair down. Pick one; using both is the [classic confusion](/tuning/jvm-memory-knobs/), because `-Xmx` wins and the percentage is silently ignored.

**Direction A — keep `-Xmx`, derive the limit from it.** Heap is fixed; the limit is heap plus the non-heap budget; the request equals the limit. This is the right shape when the heap genuinely should not scale with the container — a fixed-size cache, a batch job with a known working set.

```yaml
# values-prod.yaml — orders-api, direction A
javaOpts: >-
  -Xms1g -Xmx1g
  -XX:MaxMetaspaceSize=192m -XX:ReservedCodeCacheSize=128m
  -XX:MaxDirectMemorySize=64m -Xss512k
resources:
  requests:
    cpu: 800m           # p95 over 30d, 2026-08-12 — /tuning/sizing-walkthrough/
    memory: 1792Mi      # 1024 heap + 192 metaspace + 128 code cache + 150 stacks + 64 direct
  limits:               #   + ~80 G1 + ~50 internals + ~100 margin = 1788 → 1792Mi. Re-derive when -Xmx moves.
    memory: 1792Mi
```

| `-Xmx` | Typical non-heap (Spring-class service) | `limits.memory` = `requests.memory` |
|---|---|---|
| `512m` | ~400–500Mi | `1Gi` |
| `1g` | ~550–650Mi | `1.75Gi`–`2Gi` |
| `2g` | ~650–800Mi | `3Gi` |
| `4g` | ~900Mi–1.3Gi | `5.5Gi`–`6Gi` |

**Direction B — drop `-Xmx`, derive the heap from the limit.** The limit is the one knob; the heap follows it by percentage. This is the right shape for most web services, and it is what the [JVM–Kubernetes coupling](/java/jvm-kubernetes-coupling/) page calls the alignment rule — but the percentage is still yours to set, because at 512Mi the non-heap dominates (40–50%) and at 6Gi it doesn't (70–75%).

```yaml
# values-prod.yaml — orders-api, direction B
javaOpts: >-
  -XX:MaxRAMPercentage=60 -XX:InitialRAMPercentage=60
  -XX:MaxMetaspaceSize=192m -XX:ReservedCodeCacheSize=128m
  -XX:MaxDirectMemorySize=64m -Xss512k
resources:
  requests:
    cpu: 800m           # p95 over 30d, 2026-08-12
    memory: 1792Mi      # 60% → 1075Mi heap; the remaining 717Mi is the itemized non-heap + margin
  limits:
    memory: 1792Mi      # raise this and the heap follows; re-check the percentage below 1Gi
```

Either way the comment carries the derivation and a date, in *your* file, which is the whole difference between a number and a default. Validate it against `container_memory_working_set_bytes` over a full traffic cycle before you trust it, and if the observed working set sits above 85% of the limit, the budget is wrong, not the kernel.

The CPU half is the same in both directions: the request from your measured p95, no CPU limit unless a throttle ratio or a platform policy says otherwise ([the argument](/tuning/requests-limits-knobs/)), and `-XX:ActiveProcessorCount` pinned to a sane number when there is no limit, so the JVM doesn't size sixty-four GC threads on a big node.

## Where next

If you are the team: your number is above, and the fast check for whether a default has already been applied to you is layer 3 versus layer 1. If you are the platform engineer with the proposal open in an editor: the numbers on this page are why the answer is a floor in the LimitRange and enforcement in the chart rather than a constant — that argument, with both sides and the build, is [The Blank Resources Block](/helm/resource-defaults-in-the-base-chart/). For the services that are BestEffort *today*, the wave plan in [Requests & Limits on a Running Fleet](/tuning/brownfield-resources/) is how they get to measured numbers without the default.
