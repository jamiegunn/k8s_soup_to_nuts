---
title: "Three Lenses, Tactically II: Size and Scale"
description: The zoom run outward, with the exact commands — size a JVM service's heap, limit, and request from lens-3 data (GC log, NMT, thread dump) instead of a rule of thumb; pick and prove an HPA signal through prometheus-adapter with no KEDA; and build the evidence pack that gets a platform ticket actioned. Plus the before/after ritual that closes every change.
keywords:
  - size jvm heap and container limit from data
  - maxrampercentage from live set nmt
  - how to prove an hpa signal without keda
  - prometheus-adapter custom metric hpa tomcat busy threads
  - kubectl get --raw custom.metrics.k8s.io
  - recording rule for hpa signal
  - evidence pack for platform team noisy neighbor
  - before after load test table
  - cpu request from p95 usage jvm
sidebar:
  order: 10.2
---

You are here if: you've read [the diagnose page](/java/lens-playbooks-diagnose/) and want the other direction — turning what the inside lens showed you into a request, a limit, a heap, and a scaling signal you can defend in review; or the platform team asked "how much do you actually need?" and you'd like to answer with a table.

This page runs [the zoom](/start/three-lenses/#why-three-and-why-a-zoom) outward. Diagnosis walked in — cluster → process → inside — to find a cause. Sizing walks out: lens 3 says what the JVM *needs* (the live set, the non-heap tenants, the thread count under load), lens 2 says what it *steadily uses*, and lens 1 is where the numbers land — as a request, a limit, and an HPA target, which is the currency [Door 1](/start/three-doors/) prices the whole loop in. Same cast, same assumptions as the diagnose page: `payments-api` in namespace `payments`, a JRE-only image with [jattach](/java/jattach-deep-dive/), and **no KEDA** — a custom signal reaches the HPA through the platform's prometheus-adapter. The [toolkit](/java/lens-playbooks-diagnose/#the-toolkit-set-up-once) — `$NS`, `$POD`, `$JPID`, `$JATTACH`, `pq`, `pqr`, the JVM flags, the histograms — is assumed set up.

| # | Situation | The walk | The artifact |
|---|---|---|---|
| 1 | [Size the heap, the limit, and the request from data](#1-size-the-heap-the-limit-and-the-request-from-data) | L3 live set + NMT + threads → L2 steady gauges → L1 request/limit | the sizing table + `values.yaml` with derivations |
| 2 | [Pick and prove an HPA signal without KEDA](#2-pick-and-prove-an-hpa-signal-without-keda) | L2 candidates vs p95 under a ramp → the adapter → L1 the HPA | the signal table + the HPA with its derivation |
| 3 | [The evidence pack for the platform team](#3-the-evidence-pack-for-the-platform-team) | L2 ours vs L1 theirs, timestamped | the pack |
| — | [The before/after ritual](#the-beforeafter-ritual) | any change, same load, same table | proof |

## 1. Size the heap, the limit, and the request from data

**Situation.** [The cast's chart](/autoscaling/rest-api-oracle/#the-build) says `MEASURED` beside `cpu: 250m` and `memory: 1Gi`. This use case is the measurement — the procedure that produced those numbers, and the one you re-run after any release that changes what the JVM keeps (a new cache), how many threads it runs, or what a request does. The [sizing walkthrough](/tuning/sizing-walkthrough/) gives the load-test method and the CPU-request rule; this adds what only the inside lens can supply — the *live set*, the *non-heap tenants* itemized, and the *thread count* at load — so the memory numbers are measured instead of rule-of-thumbed, and so you know which rule of thumb you're allowed to break.

**The walk.** Run the walkthrough's [Phase 1 load test](/tuning/sizing-walkthrough/#phase-1--load-test-in-a-dev-namespace) — a ramp to 60 rps/pod, a 20-minute hold, an overshoot — in a dev namespace (point `$NS` at it; every command follows). During the *hold*, take lens 3; across the hold, take lens 2; then write lens 1.

**Lens 3, during the hold — what the JVM needs.**

```bash
# seat: tenant — (a) the live set: the FLOOR of post-GC occupancy over the hold, and the gauge that reads it after old-gen collections
kubectl logs $POD -n $NS --since=20m | grep -E 'Pause (Young|Full)' | grep -oE '[0-9]+M->[0-9]+M\([0-9]+M\)' | grep -oE '>[0-9]+M' | tr -d '>M' | sort -n | head -3
pq 'max_over_time(jvm_gc_live_data_size_bytes{namespace="payments", pod="'$POD'"}[20m]) / 1024 / 1024'
# (b) the non-heap tenants, itemized by NMT (flag on for this test run — toolkit step 5); category lines only
kubectl exec $POD -n $NS -- $JATTACH $JPID jcmd "VM.native_memory summary" | grep -E '^Total|^- +(Java Heap|Class|Thread|Code|GC|Internal|Symbol|Other|Metaspace) \('
# (c) the thread count at load — in total, then by pool
kubectl exec $POD -n $NS -- $JATTACH $JPID threaddump > td-load.txt
grep -cE '^"' td-load.txt                       # every thread's header line starts with its quoted name
grep -oE '^"[^"]+"' td-load.txt | sed -E 's/-?[0-9]+"$/"/' | sort | uniq -c | sort -rn | head -6
```

```console
231
234
236
payments-api-7c9d4f6b8-k2xvn	238        ← live set ≈ 238 MiB, and flat across the hold
Total: reserved=2330309KB, committed=862309KB
-                 Java Heap (reserved=614400KB, committed=614400KB)
-                     Class (reserved=1049321KB, committed=9865KB)
-                    Thread (reserved=246784KB, committed=30720KB)
-                      Code (reserved=253440KB, committed=45056KB)
-                        GC (reserved=32768KB, committed=32768KB)
-                  Internal (reserved=4096KB, committed=4096KB)
-                    Symbol (reserved=6144KB, committed=6144KB)
-                     Other (reserved=30720KB, committed=30720KB)
-                 Metaspace (reserved=73728KB, committed=69632KB)
241
    200 "http-nio-8080-exec"
     13 "GC Thread#"
      8 "C2 CompilerThread"
      4 "G1 Conc#"
      4 "C1 CompilerThread"
      3 "kafka-producer-network-thread"
```

Four numbers you couldn't have read from any dashboard. The **live set** is ~238 MiB: the floor of post-GC occupancy over the hold (an upper bound after a *young* collection, exact after a mixed or full one) agrees with the gauge, and it's flat — were it climbing, that's [use case 1](/java/lens-playbooks-diagnose/#1-memory-keeps-climbing-and-the-pod-gets-oomkilled) before any sizing. The **non-heap committed** is `862 − 614 ≈ 242 MiB`, itemized: Metaspace 68, code 44, GC 32, thread stacks 30, `Other` 30 (direct buffers, mostly), the class space 10, and ~28 of small categories the grep skips. **`Thread` reserves 241 MiB and commits 30**: 241 threads × the 1 MiB `-Xss` reservation, of which the touched stack pages are 30 — the number [the RSS budget](/tuning/jvm-memory-knobs/#the-non-heap-knobs--the-rss-budget-everyone-forgets) has to decide what to do with. And Tomcat is at its **200-thread** maximum — with **13 `GC Thread#`s and 12 compiler threads**, which is a JVM that sized its parallelism from the node's 16 cores, because there is no CPU limit and no `ActiveProcessorCount` ([the CPU section](/java/jvm-in-containers/#cpu-quota-shares-and-surprising-thread-counts)) — a finding in its own right.

**Lens 2, across the hold — what it steadily uses.**

```bash
# seat: tenant — the hold window; the [20m] matches its length
pq 'max_over_time(sum by (pod) (jvm_memory_used_bytes{namespace="payments", pod="'$POD'", area="heap"})[20m:1m]) / 1024 / 1024'
pq 'histogram_quantile(0.99, sum by (le) (rate(jvm_gc_pause_seconds_bucket{namespace="payments", pod="'$POD'"}[20m])))'
pq 'sum by (action) (increase(jvm_gc_pause_seconds_count{namespace="payments", pod="'$POD'"}[20m]))'
pq 'quantile_over_time(0.95, tomcat_threads_busy_threads{namespace="payments", pod="'$POD'"}[20m])'
pq 'max_over_time(jvm_buffer_memory_used_bytes{namespace="payments", pod="'$POD'", id="direct"}[20m]) / 1024 / 1024'
pq 'max_over_time(container_memory_working_set_bytes{namespace="payments", pod="'$POD'", container="payments-api"}[20m]) / 1024 / 1024'
pq 'quantile_over_time(0.95, rate(container_cpu_usage_seconds_total{namespace="payments", pod="'$POD'", container="payments-api"}[2m])[20m:1m])'
pq 'sum(rate(container_cpu_cfs_throttled_periods_total{namespace="payments", pod="'$POD'", container="payments-api"}[20m])) / sum(rate(container_cpu_cfs_periods_total{namespace="payments", pod="'$POD'", container="payments-api"}[20m]))'
```

```console
payments-api-7c9d4f6b8-k2xvn	612        ← peak heap in use (eden fills to the ceiling; that's normal)
-	0.142                                  ← GC pause p99 during the hold: 142 ms
end of minor GC	188                     ← and no "end of major GC" row at all: zero full collections
payments-api-7c9d4f6b8-k2xvn	171        ← p95 busy threads: 171 of 200 — the knee test's ~85%
payments-api-7c9d4f6b8-k2xvn	24         ← direct buffers, peak
payments-api-7c9d4f6b8-k2xvn	838        ← working set peak: 0.82 of the 1 GiB limit
payments-api-7c9d4f6b8-k2xvn	0.21       ← CPU p95 at 60 rps: 210m — the knee test's ~80% of the 250m request
-	NaN                                    ← throttle ratio: no CPU limit → no CFS periods → NaN, which is the right answer
```

**Lens 1 — write the numbers, with the arithmetic beside them.** The rule for each line, then the values file:

- **Heap.** Start at **live set × 2** — G1 needs young space to absorb allocation without forcing old-gen collections — and take ×2.5 if the limit affords it: `238 × 2.5 ≈ 595 → 614 MiB`, which is the 60% slice of 1 GiB. Check the hold's pause p99 against the SLO's budget (142 ms against 800 ms: fine) and the major-GC count (zero). If pause p99 had been ugly, or `end of major GC` had a row, the heap is too small for the allocation rate at that live set — and *that* is when you re-run at a bigger limit rather than a bigger percentage.
- **Non-heap.** NMT's committed minus the heap (`242 MiB`), plus a stack-growth allowance, plus glibc's arenas which NMT can't see (a modest allowance, honest only with `MALLOC_ARENA_MAX=2` set): `242 + 30 + 50 ≈ 320 MiB`. The stack line is the judgment call. [The knobs page](/tuning/jvm-memory-knobs/#the-non-heap-knobs--the-rss-budget-everyone-forgets) budgets the full reservation (241 MiB), because a limit kills; NMT says 30 are committed, because idle Tomcat threads touch a few pages each. This page budgets the committed number *twice* — today's stacks plus as much again for deeper ones — and makes NMT's `Thread committed` a **watched number**: the day it doubles, so does the allowance.
- **Limit.** `heap + non-heap` → `614 + 320 = 934 MiB`, 0.91 of **1 Gi**, against a measured peak of 0.82. The walkthrough's rule — [working-set p99 × 1.3–1.5](/tuning/sizing-walkthrough/#phase-2--derive-the-numbers) — says `838 × 1.3 ≈ 1,090 → 1.25 Gi` instead. The two disagree because the factor is a stand-in for the itemized budget you didn't have; now you have it, and the itemized number wins **on two conditions**: the hold's peak stays under 85% at every re-run, and `Thread committed` stays flat. The first release that breaks either, the walkthrough's 1.25 Gi wins, with `MaxRAMPercentage` re-derived (`614 ÷ 1,280 = 48`) so the heap doesn't silently grow with the limit.
- **Memory request = limit.** Incompressible → pin it ([Door 1](/start/three-doors/#the-asymmetry-that-governs-everything-cpu-is-compressible-memory-is-not)). This is the one number the re-measure *changes*: the chart's `512Mi` request under a 1 Gi limit is a scheduling promise the node can't keep for a pod that holds 840 MiB all afternoon.
- **CPU request.** p95 usage at target load, rounded up: `210m → 250m` — the cast's number, re-confirmed. It's a *request*, not a ceiling: with no limit the pod bursts into idle cores under load, which is why a sub-core request serves a latency SLO here where a sub-core *limit* would not ([the JVM page's](/java/jvm-in-containers/#sizing-requests-and-limits-for-a-jvm) "≥ 1 CPU" is about what the JVM is allowed to use, and `ActiveProcessorCount` below is how it's told). **No CPU limit** — throttle ratio `NaN`, latency is the SLO, and a limit taxes exactly the tail you're measured on ([the walkthrough's argument](/tuning/sizing-walkthrough/#phase-2--derive-the-numbers)); if policy forces one, ≥ 2× the request and watch the throttle ratio — and check for a LimitRange that forces one silently ([diagnose, use case 2](/java/lens-playbooks-diagnose/#2-cpu-looks-idle-but-p99-is-on-fire)).

```yaml
# charts/payments-api/values.yaml — every number carries its measurement (hold: 60 rps/pod × 20 min, dev, 2026-09-09)
resources:
  requests:
    cpu: 250m          # p95 of rate(container_cpu_usage_seconds_total) at 60 rps/pod = 210m, rounded up. A request, not a ceiling
    memory: 1Gi        # = limit. Was 512Mi: incompressible, so pin it — the pod holds ~840Mi all day
  limits:
    memory: 1Gi        # heap 614 + NMT non-heap 242 + stack growth 30 + arenas 50 = 934Mi (0.91); hold peak 838Mi (0.82)
                       # conditions: peak < 85% at every re-run, NMT Thread committed flat — else 1.25Gi and MaxRAMPercentage=48
    # cpu: none        # throttle ratio NaN (no quota) in the hold; latency is the SLO. A LimitRange default puts one back — diagnose, use case 2
env:
  MALLOC_ARENA_MAX: "2"                  # glibc arenas follow the NODE's cores; the 50Mi allowance above assumes this
jvmFlags:                                # joined with spaces into JAVA_TOOL_OPTIONS by the chart — a list, because '#' inside a folded scalar isn't a comment
  - -XX:MaxRAMPercentage=60              # 614Mi: live set 238Mi × 2.5; hold pause p99 142 ms, 0 full GCs
  - -XX:ActiveProcessorCount=2           # no CPU limit: without this the JVM sizes GC/JIT threads from the node's 16 cores (13 "GC Thread#" in the dump)
  - -XX:MaxMetaspaceSize=128m            # NMT Metaspace 68Mi + Class 10Mi, with headroom: a classloader leak dies as OutOfMemoryError: Metaspace, not OOMKilled
  - -XX:MaxDirectMemorySize=64m          # direct-buffer peak in the hold 24Mi, ×2 and rounded; the default is ≈ the heap, which is how diagnose's use case 1 got to 254Mi
  - -XX:+HeapDumpOnOutOfMemoryError      # the toolkit's safety nets stay
  - -XX:HeapDumpPath=/dumps
  - -XX:+ExitOnOutOfMemoryError
  - -XX:StartFlightRecording=maxsize=100m,maxage=1h,filename=/dumps/payments-api.jfr,dumponexit=true,settings=default
  - -Xlog:gc*:stdout:time,uptime,level,tags
tomcat:
  threadsMax: 200                        # p95 busy 171 at 60 rps; each thread reserves 1Mi of stack — the budget's watched line
```

**The artifact — the sizing table.**

| Quantity | Value | Lens · source |
|---|---|---|
| Live set (post-GC floor, hold) | 238 MiB, flat | L3 GC log · `jvm_gc_live_data_size_bytes` |
| Non-heap committed | 242 MiB (Metaspace 68, code 44, GC 32, threads 30 of 241 reserved, other 30, class 10, rest ~28) | L3 NMT |
| Threads at load | 241 (Tomcat at its 200 max; 13 GC + 12 JIT threads sized from the node); busy p95 171 | L3 dump · L2 gauge |
| GC pause p99 during hold | 142 ms; 0 full collections | L2 histogram · counter |
| Direct buffers, peak | 24 MiB | L2 gauge |
| Working set peak | 838 MiB (0.82 of 1 Gi) | L1 |
| CPU p95 at 60 rps | 210m | L1 |
| Throttle ratio | `NaN` (no quota) | L1 |
| **Heap / limit / request** | **614 MiB (60%) / 1 Gi / 250m + 1 Gi** — memory request raised from 512Mi | derived |

**Decide.** Re-run the hold with the new values and confirm four things before merging: working-set peak under 85% of the limit, pause p99 unchanged or better, `Thread committed` flat, throttle ratio still `NaN`. Then the request goes to [the capacity ledger](/autoscaling/capacity-and-governance/) with the derivation comments — which is what a reviewer reads — and the two conditions go into the release checklist, because they are the whole reason 1 Gi is defensible. Numbers that came from a load test in dev are re-measured against production's [two-week load profile](/autoscaling/load-profile/) before the HPA is built on them.

## 2. Pick and prove an HPA signal without KEDA

**Situation.** [The Oracle page's](/autoscaling/rest-api-oracle/#signal-and-target-derived) June load test found CPU tracked the knee, so `payments-api` scales on CPU at 65% with a busy-thread guard. Release 2.15 added a partner-rate call to every checkout — the stall in [diagnose, use case 2](/java/lens-playbooks-diagnose/#2-cpu-looks-idle-but-p99-is-on-fire) — and a request that now spends part of its life waiting on a socket spends less of it on the CPU. The signal audit is due: does CPU still move before the SLO breaks? If the answer is "threads", the signal has to reach the HPA, and there is no KEDA — the route is [prometheus-adapter](/autoscaling/getting-the-metrics/#5-the-fork-adapter-or-keda), which the platform runs.

**The walk.** L2 the candidate signals side by side with p95 at three held load levels → the recording rule and the adapter mapping (the one platform ask) → L1 the HPA object reading it → verify under the same ramp.

**Lens 2 — the candidates against the SLO, under a ramp.** Run the ramp from use case 1 (or [the messaging page's](/autoscaling/messaging-consumers/) equivalent for a consumer) at three held levels — 40, 55, and 65 rps per pod, bracketing the knee the June test put at 60 — and read the same five numbers at each:

```bash
# seat: tenant — run once per held level, with [10m] matching the hold
for q in \
 'histogram_quantile(0.95, sum by (le) (rate(http_server_requests_seconds_bucket{namespace="payments", service="payments-api", uri="/api/checkout"}[10m])))' \
 'avg(rate(container_cpu_usage_seconds_total{namespace="payments", container="payments-api"}[10m])) / avg(kube_pod_container_resource_requests{namespace="payments", container="payments-api", resource="cpu"})' \
 'avg(tomcat_threads_busy_threads{namespace="payments", service="payments-api"} / tomcat_threads_config_max_threads{namespace="payments", service="payments-api"})' \
 'avg(hikaricp_connections_pending{namespace="payments", service="payments-api"})' \
 'sum(rate(http_server_requests_seconds_count{namespace="payments", service="payments-api"}[10m])) / count(kube_pod_info{namespace="payments", pod=~"payments-api.*"})'
do pq "$q"; done
```

Collected across the three holds:

| Held load (rps/pod) | p95 `/api/checkout` | CPU util (of request) | Busy-thread ratio | Hikari pending | RPS/pod |
|---|---|---|---|---|---|
| 40 | 0.31 s | 0.52 | 0.34 | 0 | 40 |
| 55 | 0.52 s | 0.61 | 0.58 | 0 | 55 |
| 65 | **1.9 s** ✘ SLO | 0.66 | **0.94** | 0 | 65 |

Read across the rows. CPU barely moved between "fine" and "broken" (0.61 → 0.66 of the request): the CPU HPA's 65% target fires *at* the cliff, not before it — in June, CPU read 0.80 at the knee and led it; the partner call moved that time off the CPU and onto a socket. The busy-thread ratio went 0.58 → 0.94 while p95 quadrupled: it is the number that *saturates* when the SLO breaks, and it was already at 0.58 one step earlier — a leading signal. Hikari pending stayed at zero throughout: the wait isn't the pool. RPS/pod also tracks, but it's a proxy that changes with every code change; the thread ratio measures the thing that actually runs out. That's [the signals catalog's verdict](/autoscaling/signals-catalog/#thread-pool-saturation) reproduced with your own numbers, and the derivation you'll write down: **scale on `tomcat_busy_ratio`, target 0.75** — well above the 0.58 of a healthy 55 rps, well below the 0.94 cliff. The knee itself is still ~60 rps/pod, so the floor and ceiling arithmetic built on it stands; what changed is *which number saturates first*, and that is what a signal audit re-checks after every release that changes what a request does.

**The recording rule — the name the adapter will look for.** The adapter's mapping (owned by the platform, [shown here](/autoscaling/getting-the-metrics/#5-the-fork-adapter-or-keda)) matches series named `<anything>:tomcat_busy_ratio`; you publish one under a prefix that names your *service* (two services in one namespace must not share a series name), in your namespace, with the label the operator selects on:

```yaml
# charts/payments-api/templates/prometheusrule.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: payments-api-scaling
  namespace: payments
  labels:
    release: monitoring                       # the operator picks up rules with this label — same lesson as the ServiceMonitor
spec:
  groups:
    - name: payments-api.scaling
      interval: 15s
      rules:
        - record: payments_api:tomcat_busy_ratio  # <service>:tomcat_busy_ratio — what the adapter's seriesQuery matches
          expr: |
            tomcat_threads_busy_threads{namespace="payments", pod=~"payments-api.*"}
              / tomcat_threads_config_max_threads{namespace="payments", pod=~"payments-api.*"}
```

```bash
# seat: tenant — ship it through the chart (kubectl apply on a templates/ file bypasses Helm and chokes on Go-template syntax); it evaluates one interval later, per pod
helm upgrade payments-api charts/payments-api -n $NS --reuse-values
sleep 30; pq 'payments_api:tomcat_busy_ratio'
```

```console
payments-api-7c9d4f6b8-k2xvn	0.41
payments-api-7c9d4f6b8-r8pqz	0.39
```

**The adapter — prove the path before the HPA depends on it.** Two checks, and the ask if either fails:

```bash
# seat: tenant — is there an adapter at all, and does it expose your series? Both read an aggregated API a namespace seat may not see: ask if denied
kubectl get apiservice v1beta1.custom.metrics.k8s.io -o custom-columns=NAME:.metadata.name,SERVICE:.spec.service.name,AVAILABLE:.status.conditions[0].status
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/payments/pods/*/tomcat_busy_ratio" | jq -r '.items[] | [.describedObject.name, .value] | @tsv'
```

```console
NAME                              SERVICE              AVAILABLE
v1beta1.custom.metrics.k8s.io     prometheus-adapter   True
payments-api-7c9d4f6b8-k2xvn	410m
payments-api-7c9d4f6b8-r8pqz	390m
```

`410m` is 0.41 in the metrics API's quantity notation — the same number lens 2 showed, now speaking Kubernetes. No `apiservice` → the platform hasn't installed an adapter (the ask below). `Error from server (NotFound)` on the raw path with the rule evaluating fine → the adapter's config doesn't map `tomcat_busy_ratio` yet, which is a *rule family* change request, made once:

```text
REQUEST:   Add a prometheus-adapter rule mapping series ^.+:tomcat_busy_ratio$ (label pod → pods,
           namespace → namespaces) to the custom metric name tomcat_busy_ratio, metricsQuery
           avg by (<<.GroupBy>>). Config block attached (from /autoscaling/getting-the-metrics/).
WHY:       payments-api's signal audit after release 2.15 (load test 2026-09-09, attached): CPU util
           0.61→0.66 across the SLO break, busy-thread ratio 0.58→0.94. The June audit found
           CPU-correlated; the partner-rate call in 2.15 changed that.
EVIDENCE:  kubectl get --raw .../pods/*/tomcat_busy_ratio → NotFound; the recording rule evaluates (attached).
DURATION:  permanent
ROLLBACK:  remove the rule block. Our HPA keeps its CPU metric, which still scales us UP; scale-down
           suspends while the Pods metric is unfetchable, so we'd drop the Pods metric from the HPA too.
```

**Lens 1 — the HPA, reading it.** Keep CPU as a second metric — but know what that means:

```yaml
# charts/payments-api/templates/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: payments-api
  namespace: payments
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: payments-api }
  minReplicas: 2       # derivation: trough 40 rps ÷ 60 rps/pod = 1, floored to 2 (HA)
  maxReplicas: 16      # derivation: min(peak 900×1.15 ÷ 60 = 18, Oracle sessions) — /autoscaling/rest-api-oracle/
  metrics:
    - type: Pods
      pods:
        metric: { name: tomcat_busy_ratio }
        target:
          type: AverageValue
          averageValue: "750m"   # derivation: healthy 55 rps = 0.58, SLO cliff at 0.94 (load test 2026-09-09); 0.75 leads the cliff
    - type: Resource            # NOT a fallback: the HPA computes a replica count per metric and takes the LARGEST, every sync.
      resource:                 # If the adapter breaks, CPU can still scale us up; scale-DOWN is suspended until it's fixed.
        name: cpu
        target: { type: Utilization, averageUtilization: 65 }   # the June target, kept as the second opinion
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies: [{ type: Pods, value: 1, periodSeconds: 120 }]   # sessions release in ripples — the Oracle page's note
```

```bash
# seat: tenant
helm upgrade payments-api charts/payments-api -n $NS --reuse-values --set autoscaling.enabled=true
kubectl get hpa payments-api -n $NS
```

```console
NAME           REFERENCE                 TARGETS                      MINPODS   MAXPODS   REPLICAS   AGE
payments-api   Deployment/payments-api   410m/750m, cpu: 52%/65%      2         16        2          31s
```

Two targets, both live: the adapter path (`410m/750m`) and CPU. `<unknown>` in the first slot is the [runbook's](/troubleshooting/hpa-not-scaling/#custom--external-metrics-prometheus-adapter-keda) territory — almost always the adapter check above, re-run — and it must page, because of what it does to scale-down: with one metric unfetchable the controller refuses to *reduce* replicas, so the fleet pins at its high-water mark, quietly, until the pipe is fixed.

**Verify — the ramp again, watching replicas lead the SLO.**

```bash
# seat: tenant — terminal A: the ramp (use case 1); terminal B:
kubectl get hpa payments-api -n $NS -w
```

```console
NAME           REFERENCE                 TARGETS                      MINPODS   MAXPODS   REPLICAS   AGE
payments-api   Deployment/payments-api   580m/750m, cpu: 61%/65%      2         16        2          9m
payments-api   Deployment/payments-api   850m/750m, cpu: 64%/65%      2         16        2          11m
payments-api   Deployment/payments-api   850m/750m, cpu: 64%/65%      2         16        3          11m
payments-api   Deployment/payments-api   610m/750m, cpu: 55%/65%      2         16        3          13m
```

At 11 minutes the thread ratio crossed 0.75 — by more than the controller's 10% tolerance — and a third pod arrived while CPU sat at 64%, one point under its own target. The two proposals were `2 × 0.85 ÷ 0.75 = 2.3 → 3` and `2 × 0.64 ÷ 0.65 = 1.97 → 2`, and the controller took the larger — which is the "not a fallback" rule doing exactly what you want. Read p95 over the same window (`pq` from the candidates block): it stayed under the SLO. That pairing — replicas rising *before* p95 crosses — is the proof, and it's the chart you attach to the PR.

**The artifact — the signal table above, plus the HPA with its derivation comments.** The [review checklist](/autoscaling/capacity-and-governance/) reads the comments, not the numbers.

**Decide.** The signal that saturates when the SLO breaks, and was already moving one step earlier, is the one — for a service that waits on the network that's threads; for a consumer it's [queue depth](/autoscaling/messaging-consumers/); for a CPU-bound service CPU is honestly fine, and was, until a release changed what a request does. Re-run this audit after any such release. Keep CPU as the second metric, knowing the HPA takes the larger proposal and suspends scale-down when either metric goes missing. And never scale on the *symptom* — p95 — or on JVM memory ([the ratchet](/autoscaling/signals-catalog/#jvm-heap-vs-pod-memory--the-delta)).

## 3. The evidence pack for the platform team

**Situation.** [Use case 4 on the diagnose page](/java/lens-playbooks-diagnose/#4-one-pod-is-slower-than-its-siblings) ended with a hot node and an innocent pod. Now you need the platform team to act — and they act on evidence that lets them grep their own logs at your timestamp, not on "our pod is slow" ([writing requests that get fast yeses](/operations/working-with-platform-team/#writing-requests-that-get-fast-yeses)).

**The walk.** Lens 2 proves *your* service is fine everywhere except one place; lens 1 proves the place is the problem; everything carries a UTC timestamp and a pod name.

```bash
# seat: tenant (node metrics: cluster-read — include what you're allowed to see; say what you weren't)
{
  echo "## payments-api — evidence pack $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo; echo "### Placement"; kubectl get pods -n $NS -l app.kubernetes.io/name=payments-api -o custom-columns=POD:.metadata.name,NODE:.spec.nodeName,STARTED:.status.startTime
  echo; echo "### p99 by pod (5m)"; pq 'histogram_quantile(0.99, sum by (le, pod) (rate(http_server_requests_seconds_bucket{namespace="payments", service="payments-api"}[5m])))'
  echo; echo "### RPS by pod (5m)"; pq 'sum by (pod) (rate(http_server_requests_seconds_count{namespace="payments", service="payments-api"}[5m]))'
  echo; echo "### Busy threads by pod"; pq 'tomcat_threads_busy_threads{namespace="payments", service="payments-api"}'
  echo; echo "### GC seconds/second by pod"; pq 'sum by (pod) (rate(jvm_gc_pause_seconds_sum{namespace="payments", service="payments-api"}[5m]))'
  echo; echo "### Our throttle ratio by pod (our limit is NOT the wall)"; pq 'sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{namespace="payments", container="payments-api"}[5m])) / sum by (pod) (rate(container_cpu_cfs_periods_total{namespace="payments", container="payments-api"}[5m]))'
  echo; echo "### Our working set vs limit"; pq 'max by (pod, container) (container_memory_working_set_bytes{namespace="payments", container="payments-api"}) / on (pod, container) max by (pod, container) (kube_pod_container_resource_limits{namespace="payments", container="payments-api", resource="memory"})'
  # the two node rows: an RBAC-scoped datasource answers these with an EMPTY result and exit 0, so test the output, not the exit code
  echo; echo "### Node CPU busy (node-exporter, if visible)"; out=$(pq '(1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))) * on (instance) group_left (nodename) node_uname_info{nodename=~"node-w0[379]"}'); printf '%s\n' "${out:-(not visible from this seat)}"
  echo; echo "### Pods per node (kube-state-metrics, if visible)"; out=$(pq 'count by (node) (kube_pod_info{node=~"node-w0[379]"})'); printf '%s\n' "${out:-(not visible from this seat)}"
  echo; echo "### Events (last hour)"; kubectl get events -n $NS --sort-by=.lastTimestamp | tail -8
} > evidence-$(date -u +%Y%m%dT%H%M).md
```

The pack, trimmed to the rows that carry the argument:

```markdown
## payments-api — evidence pack 2026-09-09T13:52:10Z
### Placement
POD                            NODE       STARTED
payments-api-7c9d4f6b8-k2xvn   node-w03   2026-09-06T04:12:41Z
payments-api-7c9d4f6b8-r8pqz   node-w07   2026-09-06T04:12:44Z
payments-api-7c9d4f6b8-t7mzc   node-w09   2026-09-06T04:12:39Z
### p99 by pod (5m)
payments-api-7c9d4f6b8-k2xvn   0.44
payments-api-7c9d4f6b8-r8pqz   3.51      ← 8× its siblings, same RPS, same build, same config
payments-api-7c9d4f6b8-t7mzc   0.47
### Our throttle ratio by pod (our limit is NOT the wall)
payments-api-7c9d4f6b8-r8pqz   0.03
### Node CPU busy (node-exporter, if visible)
node-w03                       0.41
node-w07                       0.97      ← the one
node-w09                       0.38
### Pods per node (kube-state-metrics, if visible)
node-w03                       38
node-w07                       61
node-w09                       35
```

Then the request, in the platform's format:

```text
REQUEST:   Investigate node-w07 (CPU 97% busy, limits 197% overcommitted, 61 pods) between
           13:20 and 13:55 UTC 2026-09-09; move or throttle the tenant(s) driving it, or add
           node-w07 to the next rebalance. Evidence pack attached.
WHY:       payments-api-7c9d4f6b8-r8pqz on node-w07 runs at p99 3.5 s vs 0.45 s for its two
           siblings on w03/w09 at identical RPS; our own CPU limit isn't throttling it (ratio 0.03),
           GC is identical across pods, thread dumps on r8pqz show no pod-local cause.
EVIDENCE:  evidence-20260909T1352.md (all queries + timestamps UTC); three thread dumps from r8pqz.
DURATION:  for this incident; plus a standing ask — a soft topology spread for our namespace so
           our replicas don't stack on one node (we'll ship it; needs no platform change).
URGENCY:   today — the pod is within the SLO's error budget only because two siblings absorb it.
ROLLBACK:  n/a (read-only investigation; any move is yours to schedule).
```

**The artifact** is the file. What makes it actionable is the shape: *ours is fine everywhere but here* (lens 2, per pod), *our own walls are not the wall* (lens 1, our throttle and working set), *the place is the problem* (lens 1, the node — as far as you can see it, with an honest "not visible from this seat" where you can't), all at one UTC timestamp. What you did meanwhile: `kubectl delete pod payments-api-7c9d4f6b8-r8pqz -n payments` so the replacement landed elsewhere — a delete isn't gated by the [budget](/disruption/pod-disruption-budgets/), so you were the budget check: two Ready siblings first — and a PR adding [soft spread](/workloads/high-availability/#spreading-pods-anti-affinity-and-topologyspreadconstraints), because nothing stops the scheduler putting the replacement straight back on w07, and nothing stops the next scale-up stacking there either.

**Decide.** If the pack's lens-1 rows show *your* throttle ratio or working set at the wall, it isn't a platform ticket — it's [the diagnose page](/java/lens-playbooks-diagnose/), and sending it anyway is how a team earns slow answers. If they show your pod innocent and the node hot, send it, and send it the same way every time; a platform engineer who recognizes the format reads it in a minute.

## The before/after ritual

Every change on these two pages — a limit, a heap flag, a pool size, an HPA target, a rolled-back deploy — closes the same way, and it's worth naming once so it's never skipped: **the same load, the same queries, one table.** Run the hold from use case 1 (or, in production, wait for the same hour of the same weekday and read the [load profile's](/autoscaling/load-profile/) window), and fill in. The table below is an illustrative composite — each row is one of the diagnose page's incidents, before and after its fix; yours will have one change and every row:

| Number | Before | After | Source · the incident |
|---|---|---|---|
| p95, the SLO route | 1.64 s | 0.69 s | L2 histogram · use case 3, after the rollback |
| Error rate | 0.4% | 0.0% | L2 counter · use case 3 |
| Busy threads / max | 0.98 | 0.41 | L2 gauge · use case 2, after the partner read timeout |
| GC pause p99 | 1.84 s | 0.14 s | L2 histogram · use case 5, after the live set was brought back down |
| Working-set peak / limit | 0.91 | 0.82 | L1 · use case 1, after `MaxDirectMemorySize` and the allocator fix |
| Throttle ratio | 0.41 | `NaN` (no quota) | L1 · use case 2, after the LimitRange default was removed |
| Live set after GC / max heap | 0.71 | 0.39 | L3 GC log · use case 5, 437 → 238 of 616 MiB |

A change without the *after* column is a hypothesis. A change with it is the sentence in the postmortem that ends the discussion — and the derivation comment's date, so the next reviewer knows which load test the number came from.

## Where next

- **Back to the walk in:** [Three Lenses, Tactically I: Diagnose](/java/lens-playbooks-diagnose/).
- **The lateral jump:** the whole autoscaling build these numbers feed — [REST API in Front of an External Oracle](/autoscaling/rest-api-oracle/) — and the ledger the request joins, [Capacity and Governance](/autoscaling/capacity-and-governance/).
