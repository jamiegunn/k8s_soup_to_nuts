---
title: "Three Lenses, Tactically II: The Symptoms"
description: Eight production situations — memory climbing, CPU idle but slow, a post-deploy regression, one slow pod, GC, pool exhaustion, thread leaks, missing metrics — each walked lens by lens with the exact commands (kubectl, PromQL, jattach/jcmd, JFR), the console output to expect, the data artifact you end up with, and the decision rule. JRE-only images, no KEDA.
keywords:
  - jattach commands kubernetes pod thread dump heap dump
  - memory keeps climbing oomkilled what to run
  - cpu idle but slow commands to run
  - latency regression after deploy promql offset
  - one pod slower than the others
  - gc pause investigation commands
  - hikaricp connections pending thread dump
  - jvm thread leak how to find
  - no metrics in prometheus for my pod checklist
  - class histogram diff jattach
  - native memory tracking jattach jcmd
  - jfr dump jattach jfr view
sidebar:
  order: 10.2
---

You are here if: [the use cases](/java/lens-playbooks-use-cases/) sent you to a symptom by number; or [The Three Lenses](/start/three-lenses/) told you *which* lens and you want to know *exactly what to type* through it; or you're mid-incident and need the commands in the right order; or you want a standing toolkit so the next incident starts at step 3 instead of step 0.

This page is the symptom library of the tactical trilogy: [the use cases](/java/lens-playbooks-use-cases/) are the questions that send you here, and [the third page](/java/lens-playbooks-size-and-scale/) holds the sizing and scaling procedures the questions end in. A symptom is a number that's wrong; each one below is one situation walked in the model's order *from wherever the symptom entered* — lens 1 when the page was a wall (a kill, a limit), lens 2 when it was a latency or a pool number — with the cluster's view naming the pod and the wall, the process's view naming the route or the pool or the heap area, and the inside view naming the threads and the objects, always on a named pod. Each ends with a **data artifact** (the table or file you'll paste into the ticket) and a **decision rule**. Everything is written for the site's cast: `payments-api`, a Spring Boot 3.3 / Java 21 service in namespace `payments`, JRE-only image, HikariCP to an external Oracle, scraped by the platform's kube-prometheus-stack in namespace `monitoring`.

Two assumptions run through both pages, because they're the constraints most delivery teams actually live under. **The image is JRE-only:** no `jcmd`, no `jmap`, no `jstack` — every inside-lens command goes through [jattach](/java/jattach-deep-dive/). **There is no KEDA:** custom signals reach the HPA through [prometheus-adapter](/autoscaling/getting-the-metrics/#5-the-fork-adapter-or-keda), which the platform runs. Nothing here needs cluster-admin; the few commands that read nodes or the Prometheus CR say so with the site's [seat marker](/disruption/overview/#who-owns-what).

## The toolkit, set up once

Every symptom walk assumes the six things below are in place. Do them once, on a quiet afternoon; the first three take a minute, the last three are a values-file change.

### 1. Variables, and the JVM's pid

```bash
# seat: tenant — set once per terminal
export NS=payments
export POD=$(kubectl get pods -n $NS -l app.kubernetes.io/name=payments-api -o jsonpath='{.items[0].metadata.name}')
# The JVM's pid inside the container: 1 with an exec-form entrypoint, 7 or so under tini. Ask /proc, never assume.
export JPID=$(kubectl exec $POD -n $NS -- sh -c 'for p in /proc/[0-9]*; do if { tr "\0" " " < $p/cmdline; } 2>/dev/null | grep -qE "(^|/)java "; then basename $p; fi; done' | head -1)
echo "pod=$POD jvm pid=$JPID"
```

```console
pod=payments-api-7c9d4f6b8-k2xvn jvm pid=1
```

If `JPID` comes back empty, the image has no shell (distroless) — use the ephemeral-container form in step 2 for every inside-lens command; with `--target` the debug container shares the app's process namespace, so the JVM is visible at its namespaced pid — `1` with an exec-form entrypoint, otherwise whatever `ps` in the debug container shows. And whenever you switch `$POD` to a different replica mid-incident, re-run steps 1 and 2: the pid may differ and the copied binary lives only in the pod you copied it into.

### 2. jattach, in the pod

Bake it into the image at build time (the [deep dive's](/java/jattach-deep-dive/#getting-jattach-onto-the-box) recommendation — a pinned, checksummed `COPY --from=`), and set `JATTACH=/usr/local/bin/jattach`. Until that's shipped, copy it in for the incident:

```bash
# seat: tenant — needs tar in the image (kubectl cp); otherwise see Getting Dumps Out for the raw-stream copy
kubectl cp ./jattach $NS/$POD:/tmp/jattach && kubectl exec $POD -n $NS -- chmod +x /tmp/jattach
export JATTACH=/tmp/jattach
kubectl exec $POD -n $NS -- $JATTACH $JPID jcmd VM.version
```

```console
Connected to remote JVM
JVM response code = 0
OpenJDK 64-Bit Server VM version 21.0.4+7-LTS
JDK 21.0.4
```

`Connected to remote JVM` is the whole handshake proven — same UID, writable `/tmp`, attach not disabled. For a distroless image, the equivalent of every `kubectl exec $POD -n $NS -- $JATTACH $JPID …` on this page is:

```bash
# seat: tenant — a tools image carrying jattach, sharing the app container's PID namespace; match the app's UID under a restricted PSS
kubectl debug -it $POD -n $NS --image=registry.example.com/jvm-tools:latest --target=payments-api -- jattach 1 jcmd VM.version
```

The UID rule and the `Unable to open socket file` failure it produces are in [the deep dive](/java/jattach-deep-dive/#in-cluster-attaching-inside-kubernetes).

### 3. Prometheus, from the terminal

A port-forward and two shell functions turn every PromQL on this page into a tab-separated table you can paste into a ticket:

```bash
# seat: tenant — needs pods/portforward in the monitoring namespace (ask if denied); the operator's stable Service name
kubectl -n monitoring port-forward svc/prometheus-operated 9090 >/dev/null 2>&1 & PROM_PID=$!; sleep 1
# No port-forward rights? Point PROM at the platform's Prometheus or Thanos query URL instead — the helpers don't care.
export PROM=${PROM:-http://localhost:9090}

# pq  — instant query → "label<TAB>value" (label = whichever of pod, uri, nodename, node, instance, id, state, action, reason the result carries)
pq()  { curl -sG "$PROM/api/v1/query" --data-urlencode "query=$1" \
        | jq -r '.data.result[] | [(.metric.pod // .metric.uri // .metric.nodename // .metric.node // .metric.instance // .metric.id // .metric.state // .metric.action // .metric.reason // "-"), .value[1]] | @tsv'; }
# pqr — range query over the last N days at step S → "label<TAB>time<TAB>value"
pqr() { local days=${2:-7} step=${3:-1h}
        curl -sG "$PROM/api/v1/query_range" --data-urlencode "query=$1" \
          --data-urlencode "start=$(( $(date -u +%s) - days*86400 ))" --data-urlencode "end=$(date -u +%s)" --data-urlencode "step=$step" \
        | jq -r '.data.result[] | (.metric.pod // .metric.uri // "-") as $l | .values[] | [$l, (.[0]|todate), .[1]] | @tsv'; }
```

```bash
# seat: tenant — the smoke test for the helper and the scrape at once
pq 'up{namespace="payments"}'
```

```console
payments-api-7c9d4f6b8-k2xvn	1
payments-api-7c9d4f6b8-r8pqz	1
```

`up == 1` for every pod is the precondition for everything in lens 2; [symptom 8](#8-no-data-for-our-pod) is what to do when it isn't.

### 4. Actuator, from the terminal

The management port never goes through the ingress ([Actuator](/java/actuator/#exposure-discipline-enabled--exposed--reachable)); reach it with a port-forward and read single metrics without waiting for a scrape:

```bash
# seat: tenant
kubectl -n $NS port-forward $POD 8081:8081 >/dev/null 2>&1 & ACT_PID=$!; sleep 1
curl -s localhost:8081/actuator/metrics/hikaricp.connections.pending | jq -c '.measurements'
```

```console
[{"statistic":"VALUE","value":0.0}]
```

### 5. The JVM flags that make the inside lens cheap

Set once in the chart's `JAVA_TOOL_OPTIONS`, with a `/dumps` `emptyDir` mounted ([why a volume](/java/heap-dumps-jre-only/#option-0-do-this-today-dump-automatically-on-outofmemoryerror)). Three are the resting state; the fourth is switched on while chasing memory:

```yaml
# values.yaml — the always-on inside lens. The chart joins the list with spaces into JAVA_TOOL_OPTIONS
# ({{ join " " .Values.jvmFlags }}); a list, because a '#' inside a folded ">-" scalar is NOT a comment —
# it becomes part of the string, and the JVM refuses to start with "Unrecognized option: #".
jvmFlags:
  - -XX:+HeapDumpOnOutOfMemoryError          # the dump you'll want exists before you know you want it
  - -XX:HeapDumpPath=/dumps                  # a volume, never the writable layer
  - -XX:+ExitOnOutOfMemoryError              # let Kubernetes restart it cleanly after the dump
  - -XX:StartFlightRecording=maxsize=100m,maxage=1h,filename=/dumps/payments-api.jfr,dumponexit=true,settings=default
  - -XX:FlightRecorderOptions=repository=/dumps/jfr   # the ring buffer's chunk files on the volume: they survive a SIGKILL that dumponexit doesn't
  - -Xlog:gc*:stdout:time,uptime,level,tags  # every pause, timestamped, in kubectl logs
  # - -XX:NativeMemoryTracking=summary       # ~5% overhead: add (rollout) for symptom 1's native branch, remove after
```

The trade: ~1% CPU for JFR, log volume for GC, and a `/dumps` volume sized to the heap plus the recording — in exchange for an inside lens that has *history* the moment lens 2 says "since 02:40". The repository line is the one people skip: `dumponexit` needs the JVM to *exit*, and an OOMKill is a SIGKILL — nothing exits. With the repository on the volume, the last hour's chunks are still there afterwards, and `jfr assemble /dumps/jfr/<the dated directory> night.jfr` on your laptop turns them back into a recording. [Java Observability](/java/java-observability/#the-layered-posture-summarized) argues the case.

### 6. Histograms for the four timers you'll quantile

Without buckets, `histogram_quantile` has nothing to read — no p95 for requests, no p99 for GC pauses, no acquire- or hold-time percentile for the pool ([the gotcha](/autoscaling/getting-the-metrics/#1-make-the-app-publish)). And Tomcat's thread gauges are off until the MBean registry is on:

```yaml
# application.yaml
management:
  server.port: 8081                                      # the management port: off the ingress, on its own Service
  endpoints.web.exposure.include: "health,prometheus,metrics"
  metrics:
    distribution:
      percentiles-histogram:
        http.server.requests: true
        jvm.gc.pause: true
        hikaricp.connections.acquire: true
        hikaricp.connections.usage: true
      slo:
        http.server.requests: 200ms,500ms,800ms,2s     # an exact edge at the 800 ms SLO
server:
  tomcat:
    mbeanregistry.enabled: true                          # tomcat_threads_* exist only with this
```

Now the symptoms. Each opens with the situation in one breath, then the walk.

| # | Symptom | The walk | The artifact |
|---|---|---|---|
| 1 | [Memory keeps climbing; OOMKilled](#1-memory-keeps-climbing-and-the-pod-gets-oomkilled) | L1 → L2 delta → L3 histogram diff / NMT | the leak table |
| 2 | [CPU idle, p99 on fire](#2-cpu-looks-idle-but-p99-is-on-fire) | L1 throttle → L2 quadrants + pools → L3 dumps | the quadrant table + dump grouping |
| 3 | [Latency regressed after a deploy](#3-latency-regressed-after-a-deploy) | L2 `offset` → L1 what changed → L3 JFR | the before/after table |
| 4 | [One pod is slower than its siblings](#4-one-pod-is-slower-than-its-siblings) | L2 per-pod → L1 node → L3 on that pod | the pod-vs-fleet table |
| 5 | [Is GC the problem?](#5-is-gc-the-problem) | L1 throttle first → L2 GC histogram → L3 GC log | the GC table |
| 6 | [Pool exhaustion against Oracle](#6-connection-pool-exhaustion-against-oracle) | L2 pool gauges → L3 dump grouping | the pool timeline |
| 7 | [Thread leak](#7-a-thread-leak) | L2 staircase → L3 name histogram + JFR's creator → L1 pids | the thread-name histogram |
| 8 | [No data for our pod](#8-no-data-for-our-pod) | L2's four links, in order | the four-link checklist with proofs |

## 1. Memory keeps climbing, and the pod gets OOMKilled

**Situation.** Working set rises through the day, a pod restarts with exit 137 every night or two, the heap "looks fine" on the JVM dashboard. Three different problems produce this, and they have three different fixes — the walk tells them apart.

**The walk.** L1 proves it's the *container* limit (not a Java `OutOfMemoryError`) and shows the slope → L2 subtracts heap from working set to say heap-or-native → L3 names the class (heap) or the category (native).

**Lens 1 — which wall, and how fast.**

```bash
# seat: tenant — the kernel's verdict and the slope
kubectl get pod $POD -n $NS -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}{"  exit="}{.status.containerStatuses[0].lastState.terminated.exitCode}{"  restarts="}{.status.containerStatuses[0].restartCount}{"\n"}'
# max by () on both sides: a restart-looping pod briefly has two cAdvisor series per container, and a bare "/ on ()" errors on the duplicate
pq 'max by (pod, container) (container_memory_working_set_bytes{namespace="payments", container="payments-api"}) / on (pod, container) max by (pod, container) (kube_pod_container_resource_limits{namespace="payments", container="payments-api", resource="memory"})'
pqr 'max by (pod) (container_memory_working_set_bytes{namespace="payments", container="payments-api"}) / 1024 / 1024' 3 6h
```

```console
OOMKilled  exit=137  restarts=4
payments-api-7c9d4f6b8-k2xvn	0.91
payments-api-7c9d4f6b8-r8pqz	0.62
payments-api-7c9d4f6b8-k2xvn	2026-09-08T06:00:00Z	612
payments-api-7c9d4f6b8-k2xvn	2026-09-08T12:00:00Z	701
payments-api-7c9d4f6b8-k2xvn	2026-09-08T18:00:00Z	788
payments-api-7c9d4f6b8-k2xvn	2026-09-09T00:00:00Z	871
```

`OOMKilled` + 137 is the *kernel's* kill at the container limit, not the JVM's — [step zero](/java/memory-leaks-and-oom/#step-zero-which-oom-is-it) — and ~85 MiB per six hours is the slope. If the reason is instead `Error` with a `java.lang.OutOfMemoryError` in the previous logs, skip to the heap branch below: the dump already exists in `/dumps` (toolkit step 5).

**Lens 2 — heap, or everything else?** The two-lens query, plus the heap's own trend and the non-heap gauges that name the usual suspects:

```bash
# seat: tenant
pqr 'container_memory_working_set_bytes{namespace="payments", pod="'$POD'", container="payments-api"} - on (pod) sum by (pod) (jvm_memory_used_bytes{namespace="payments", pod="'$POD'", area="heap"})' 3 6h
pq 'jvm_gc_live_data_size_bytes{namespace="payments", pod="'$POD'"} / 1024 / 1024'
pq 'sum by (id) (jvm_memory_used_bytes{namespace="payments", pod="'$POD'", area="nonheap"}) / 1024 / 1024'
pq 'jvm_buffer_memory_used_bytes{namespace="payments", pod="'$POD'", id="direct"} / 1024 / 1024'
pq 'jvm_threads_live_threads{namespace="payments", pod="'$POD'"}'
```

```console
payments-api-7c9d4f6b8-k2xvn	2026-09-08T06:00:00Z	214000000
payments-api-7c9d4f6b8-k2xvn	2026-09-08T12:00:00Z	301000000
payments-api-7c9d4f6b8-k2xvn	2026-09-08T18:00:00Z	392000000
payments-api-7c9d4f6b8-k2xvn	2026-09-09T00:00:00Z	480000000
payments-api-7c9d4f6b8-k2xvn	238            ← live set after old-gen GC: flat for days
CodeHeap 'non-nmethods'	3
CodeHeap 'non-profiled nmethods'	19
CodeHeap 'profiled nmethods'	27
Compressed Class Space	11
Metaspace	91
payments-api-7c9d4f6b8-k2xvn	254            ← direct buffers: 254 MiB and climbing (steady state was ~25)
payments-api-7c9d4f6b8-k2xvn	241
```

Read the first block against the working-set slope: the *delta* is growing at the same ~85 MiB per six hours while the live set is flat — so it's not the heap. Metaspace, the three code heaps (JDK 21's segmented code cache), and the class space are ordinary and flat; the thread count is flat; the direct-buffer gauge is the loudest non-heap number, ten times its steady state. That's the native branch; had the live set been climbing instead, it's the heap branch.

**Lens 3, heap branch — name the class.** Two class histograms ten minutes apart, diffed by bytes; then a heap dump only if the histogram doesn't settle it. Take both on the *healthier* replica — a leak is in every replica, and [the interrogation can be the push](/start/three-lenses/#the-two-traps-of-the-third-lens) on the one already at 0.91:

```bash
# seat: tenant — each histogram is a full-heap walk (a pause of seconds); a leak shows in every replica, so use the one with headroom
export POD=payments-api-7c9d4f6b8-r8pqz        # the 0.62 pod; re-run toolkit steps 1–2 after any switch of $POD
kubectl exec $POD -n $NS -- $JATTACH $JPID jcmd GC.class_histogram > histo-1.txt
sleep 600
kubectl exec $POD -n $NS -- $JATTACH $JPID jcmd GC.class_histogram > histo-2.txt
awk 'FNR==NR { if ($1 ~ /^[0-9]+:$/) b[$4]=$3; next } $1 ~ /^[0-9]+:$/ { d=$3-b[$4]; if (d>0) printf "%12d  %s\n", d, $4 }' histo-1.txt histo-2.txt | sort -rn | head -8
```

```console
   148221440  [B
    61030400  java.util.LinkedHashMap$Entry
    41984000  com.acme.payments.cache.QuoteSnapshot
    18726912  java.lang.String
     2097152  java.util.HashMap$Node
```

Bytes gained in ten minutes, by class. A domain class (`QuoteSnapshot`) growing alongside `LinkedHashMap$Entry` and byte arrays is a cache without a bound — you can usually stop here. If the growers are all generic (`byte[]`, `String`, `HashMap$Node`) you need *who holds them*:

```bash
# seat: tenant — pauses the JVM for the write; live objects only (a full GC runs first) unless you append -all; /dumps is the emptyDir from the toolkit
kubectl exec $POD -n $NS -- $JATTACH $JPID dumpheap /dumps/payments-$(date +%H%M).hprof
kubectl exec $POD -n $NS -- ls -lh /dumps
```

```console
-rw-r--r-- 1 10001 10001 271M Sep  9 09:41 payments-0941.hprof
```

The file is about the size of the live set (238 MiB plus the dump's own overhead), not of the heap. Then [get it out](/java/getting-dumps-out/) and open the dominator tree in MAT — [three moves](/java/heap-dumps-jre-only/#analyzing-eclipse-mat-in-three-moves).

:::caution[Dump the pod at the edge only on purpose]
If the histogram was clean on the healthy replica and you must dump the worst pod — the one at 0.91 — three checks first: it isn't the last Ready replica (`kubectl get pods -n $NS -l app.kubernetes.io/name=payments-api`), `/dumps` has room for a heap-sized file, and the liveness probe's `failureThreshold × periodSeconds` outlives the pause. A dump that the probe interrupts is a truncated file *and* a restart — the incident, hastened, with nothing to show for it. [Memory Leaks and OOM](/java/memory-leaks-and-oom/#the-classic--xmx-fits-container-still-dies) makes the same point the other way round: leaks appear in every replica, so the healthy one is the better witness — and the automatic `HeapDumpOnOutOfMemoryError` file from toolkit step 5 costs nothing extra, because that JVM was dying anyway.
:::

**Lens 3, native branch — name the category.** NMT needs the flag from toolkit step 5 (a rollout); once it's on, take a baseline and a diff an hour apart. The grep keeps only the category lines (they start with `-`), so the sub-lines NMT prints under each don't clutter the diff:

```bash
# seat: tenant — requires -XX:NativeMemoryTracking=summary at JVM start; the healthy replica is fine here too (same leak, earlier stage)
kubectl exec $POD -n $NS -- $JATTACH $JPID jcmd "VM.native_memory baseline"
sleep 3600
kubectl exec $POD -n $NS -- $JATTACH $JPID jcmd "VM.native_memory summary.diff" | grep -E '^Total|^- +(Java Heap|Class|Thread|Code|GC|Internal|Other|Metaspace) \('
```

```console
Total: reserved=2594017KB +14686KB, committed=955337KB +14866KB
-                 Java Heap (reserved=614400KB, committed=430080KB)
-                     Class (reserved=1049745KB +14KB, committed=12433KB +14KB)
-                    Thread (reserved=246784KB, committed=38120KB)
-                      Code (reserved=253440KB +64KB, committed=50176KB +64KB)
-                        GC (reserved=38912KB, committed=38912KB)
-                  Internal (reserved=4212KB +8KB, committed=4212KB +8KB)
-                     Other (reserved=262144KB +14600KB, committed=262144KB +14600KB)
-                 Metaspace (reserved=98304KB, committed=93184KB +180KB)
```

`Other +14600KB` in an hour — 14 MiB, which is the working-set slope (85 MiB per six hours) seen from inside — is where direct `ByteBuffer`s land: 256 MiB committed against a gauge reading 254. The fix is `-XX:MaxDirectMemorySize` (so the next leak dies as a diagnosable `OutOfMemoryError: Direct buffer memory` instead of an OOMKill) plus finding the allocator — Netty's pooled allocator holding peak, an `Inflater` never `end()`ed: [the offenders list](/java/memory-leaks-and-oom/#native-memory-the-heap-looks-innocent-because-it-is). `Thread` growing → symptom 7. `Metaspace` or `Class` growing → a classloader leak. Total NMT flat while the working set grows → JNI or glibc arenas (`MALLOC_ARENA_MAX=2` as the experiment).

Three things about the shape, because the reference pages show an older one. On JDK 17+ **`Metaspace` is its own line** and `Class` is only the compressed class space (~12 MiB here, not the ~100 MiB of metadata) — a grep without `Metaspace` silently drops the biggest fixed tenant. **`Thread` shows two numbers**: `reserved` is threads × `-Xss` (241 × 1 MiB), `committed` is the stack pages actually touched (38 MiB) — the leak in symptom 7 grows both, a deep recursion grows only the second. And the heap's `committed` (420 MiB) sits under its `reserved` (the 614 MiB that `MaxRAMPercentage=60` allows) because G1 grows the heap only as it needs to — the Total committed (933 MiB) is the working set at 0.91 of the limit, seen from inside, and 512 MiB of it is not heap.

**The artifact — the leak table.** Paste it into the ticket; every row is a command above:

| Number | Value | Source |
|---|---|---|
| Kill | `OOMKilled`, exit 137, 4 restarts / 3 d | L1 `lastState` |
| Working set vs limit | 0.91 (limit 1 GiB) | L1 |
| Working-set slope | ~85 MiB / 6 h | L1 `pqr` |
| Live set after GC | 238 MiB, flat | L2 `jvm_gc_live_data_size_bytes` |
| Non-heap delta slope | ~85 MiB / 6 h | L2 two-lens query |
| Loudest non-heap gauge | direct buffers 254 MiB ↑ (steady state ~25) | L2 |
| Threads | 241, flat | L2 |
| NMT diff, 1 h | `Other +14600KB` (≈ the slope); `Metaspace`, `Class`, `Thread` flat | L3 |
| Verdict | native: direct-buffer growth | — |

**Decide.** Live set climbing with the working set → heap leak: histogram diff → dump → dominator tree; the fix is code. Live set flat, delta climbing → native: NMT names the category; the fix is a cap (`MaxDirectMemorySize`, a bounded executor) and the leaking allocator. Both flat, working set simply near the limit at steady state → not a leak but a budget: heap + non-heap don't fit the limit; resize with [the RSS budget](/tuning/jvm-memory-knobs/#the-rss-budget-worked), never by raising the limit alone.

## 2. CPU looks idle, but p99 is on fire

**Situation.** The CPU panel shows 30% of the limit, latency p99 is five times normal, nobody deployed. This is the site's most common "slow but green" and it has three usual causes — a CPU quota wall, threads waiting on something downstream, or a hot loop — and the lenses separate them in under five minutes. They also, often, find two at once.

**The walk.** L1 throttle ratio (the average hides a quota) → L2 the four-quadrant read and the pool gauges (waiting or computing?) → L3 three thread dumps (on what, exactly).

**Lens 1 — is the quota biting?**

```bash
# seat: tenant
pq 'sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{namespace="payments", container="payments-api"}[5m])) / sum by (pod) (rate(container_cpu_cfs_periods_total{namespace="payments", container="payments-api"}[5m]))'
pq 'sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="payments", container="payments-api"}[5m])) / on (pod) max by (pod) (kube_pod_container_resource_limits{namespace="payments", container="payments-api", resource="cpu"})'
# a quota means a CPU limit — and the chart sets none, so where did it come from?
kubectl get pod $POD -n $NS -o jsonpath='{.spec.containers[0].resources}{"\n"}'
kubectl get limitrange -n $NS -o jsonpath='{range .items[*]}{.metadata.name}{"  default.cpu="}{.spec.limits[0].default.cpu}{"\n"}{end}'
```

```console
payments-api-7c9d4f6b8-k2xvn	0.41
payments-api-7c9d4f6b8-r8pqz	0.38
payments-api-7c9d4f6b8-k2xvn	0.31
payments-api-7c9d4f6b8-r8pqz	0.29
{"limits":{"cpu":"500m","memory":"1Gi"},"requests":{"cpu":"250m","memory":"512Mi"}}
payments-defaults  default.cpu=500m
```

Throttled in 41% of 100 ms periods while *averaging* 31% of the limit. That pair of numbers is the whole [cause 1](/troubleshooting/its-slow/#cause-1-cpu-throttling--the-1-and-the-one-your-graphs-hide) signature: bursty work meeting a quota. And the quota isn't in the chart — [the cast's values](/autoscaling/rest-api-oracle/#the-build) set a CPU *request* and no limit; the namespace's LimitRange filled in a `500m` limit at admission, which is exactly the case [the sizing walkthrough's throttle alert](/tuning/sizing-walkthrough/#phase-5--productionize-the-feedback-loop) exists to catch. If the ratio is under ~0.05, the quota is innocent — go to lens 2. (No limit anywhere gives `NaN`, not zero: no quota means no periods to count.) And a ratio *this* high doesn't end the walk either: a quota explains bursts being clipped, not why a service averaging 31% of its CPU is five times slower — lens 2 says what the threads are doing between the bursts.

**Lens 2 — waiting or computing, and where?**

```bash
# seat: tenant — the four-quadrant read: p50 and p99, by route
pq 'histogram_quantile(0.99, sum by (le, uri) (rate(http_server_requests_seconds_bucket{namespace="payments", service="payments-api"}[5m])))'
pq 'histogram_quantile(0.50, sum by (le, uri) (rate(http_server_requests_seconds_bucket{namespace="payments", service="payments-api"}[5m])))'
# the pools: are requests waiting for a thread, or for a connection?
pq 'tomcat_threads_busy_threads{namespace="payments", service="payments-api"} / tomcat_threads_config_max_threads{namespace="payments", service="payments-api"}'
pq 'hikaricp_connections_pending{namespace="payments", service="payments-api"}'
```

```console
/api/checkout	3.12
/api/quotes	2.88
/actuator/health/**	0.04
/api/checkout	0.19
/api/quotes	0.17
payments-api-7c9d4f6b8-k2xvn	0.98
payments-api-7c9d4f6b8-r8pqz	0.97
payments-api-7c9d4f6b8-k2xvn	0
payments-api-7c9d4f6b8-r8pqz	0
```

p99 up on the business routes, p50 barely moved, the no-op health route innocent (Micrometer tags every health sub-path as `/actuator/health/**`): the top-right quadrant of [the confirm step](/troubleshooting/its-slow/#the-confirm-step-slow-for-everyone-or-slow-for-some) — a *stall* on those paths, not a systemic slowdown. Busy threads at 98% of Tomcat's max with **zero** connections pending says the threads aren't waiting for the *pool* — with ten connections and 196 busy threads, a pool stall would show ~180 pending (that's symptom 6). They're waiting inside their work, on something that isn't pooled. Lens 3 says on what.

**Lens 3 — three dumps, ten seconds apart, grouped.**

```bash
# seat: tenant — jattach prints the dump to YOUR terminal (kill -3 would print to the pod's log instead)
for i in 1 2 3; do kubectl exec $POD -n $NS -- $JATTACH $JPID threaddump > td-$i.txt; sleep 10; done
# group by (state + top two lines): the site's ten-second idiom, one dump at a time
grep -A2 'java.lang.Thread.State' td-2.txt | grep -v '^--$' | paste - - - | sort | uniq -c | sort -rn | head -5
# then one of the 187 — its block ends at the blank line — filtered to the frames that name the caller
grep -m1 -A40 'SocketDispatcher.read0' td-2.txt | sed '/^$/q' | grep -E '\.read0\(|HttpURLConnection\.|RestTemplate\.|com\.acme'
```

```console
    187    java.lang.Thread.State: RUNNABLE		at sun.nio.ch.SocketDispatcher.read0(java.base@21.0.4/Native Method)		at sun.nio.ch.SocketDispatcher.read(java.base@21.0.4/SocketDispatcher.java:47)
      9    java.lang.Thread.State: WAITING (parking)		at jdk.internal.misc.Unsafe.park(java.base@21.0.4/Native Method)		- parking to wait for  <0x00000000e0a1c2f8> (a java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject)
      3    java.lang.Thread.State: RUNNABLE		at sun.nio.ch.EPoll.wait(java.base@21.0.4/Native Method)		at sun.nio.ch.EPollSelectorImpl.doSelect(java.base@21.0.4/EPollSelectorImpl.java:118)
	at sun.nio.ch.SocketDispatcher.read0(java.base@21.0.4/Native Method)
	at sun.net.www.protocol.http.HttpURLConnection.getInputStream0(java.base@21.0.4/HttpURLConnection.java:1671)
	at sun.net.www.protocol.http.HttpURLConnection.getInputStream(java.base@21.0.4/HttpURLConnection.java:1568)
	at org.springframework.web.client.RestTemplate.doExecute(RestTemplate.java:889)
	at com.acme.payments.rates.PartnerRateClient.quote(PartnerRateClient.java:57)
	at com.acme.payments.checkout.CheckoutService.price(CheckoutService.java:112)
```

187 of 200 request threads `RUNNABLE` in a socket read — which is [the state table's](/java/thread-dumps-jre-only/#reading-a-thread-dump) "waiting on the network, not burning CPU" (the nine `WAITING (parking)` are idle Tomcat threads on the queue's condition; the three in `EPoll.wait` are the acceptor and pollers) — and thirty frames up, the caller: a `RestTemplate` on the JDK's blocking `HttpURLConnection`, inside `PartnerRateClient.quote`, called from checkout and quotes alike. Not the database at all: an HTTP dependency with no pool to be exhausted and, as it turns out, no read timeout. The same stacks in all three dumps make it a stall, not a busy moment. For the third cause — a hot loop — the dump's `cpu=` field does the work: a thread whose `cpu=` gains ~10,000 ms between dumps taken 10 s apart is spinning a core, and its top frame is the loop.

**The artifact — the quadrant table plus the grouping.**

| Number | Value | Source |
|---|---|---|
| Throttle ratio | 0.41 / 0.38 | L1 |
| Usage vs limit | 0.31 (limit `500m`, from the namespace LimitRange, not the chart) | L1 |
| p99 / p50, `/api/checkout` | 3.12 s / 0.19 s | L2 |
| p99, health route | 0.04 s | L2 |
| Busy threads / max | 0.98 | L2 |
| Hikari pending | 0 | L2 |
| Dump grouping (3 dumps) | 187 threads in `SocketDispatcher.read0` ← `HttpURLConnection.getInputStream0` ← `RestTemplate.doExecute` ← `PartnerRateClient.quote` | L3 |

**Decide.** Two findings here, in the order you fix them. Throttle ratio high → the quota is a wall, and this one wasn't even yours: get the LimitRange default raised or removed — a LimitRange fills in any limit you leave blank, so "we don't set one" is not the same as "we don't have one" ([the compressible-resource argument](/start/three-doors/#the-asymmetry-that-governs-everything-cpu-is-compressible-memory-is-not)) — and re-measure, because throttling also *masquerades as GC* (symptom 5). Threads parked in a socket read on a *client* call → that dependency and its timeout: a read timeout on `PartnerRateClient` sized from [the timeout budget](/tuning/timeout-budget/), so a slow partner costs you a fast error instead of every Tomcat thread ([cause 4](/troubleshooting/its-slow/#cause-4-downstream-slowness--youre-just-the-messenger)); more replicas would only open more connections against it, and that fix — not the quota — is where the 5× came from. The same read inside the JDBC driver, with `pending` climbing, is symptom 6. A `cpu=` runaway → the frame; JFR's `hot-methods` (symptom 3) confirms it with a sample-based profile.

## 3. Latency regressed after a deploy

**Situation.** p95 on one route doubled at 14:07 and the rollout finished at 14:05. You need to prove it in a table, decide roll-back-or-forward in minutes, and hand the developer a profile rather than a hunch.

**The walk.** L2 the same query with `offset`, before vs after, by route → L1 what else changed in the pod spec (requests, limits, JVM flags, replica count) → L3 a JFR dump of the last hour, compared to a baseline.

**Lens 2 — the before/after table, one query each side.**

```bash
# seat: tenant — "the last 30 minutes" vs "the 30 minutes that ended an hour ago"; at 15:20, with a 14:05 rollout, that's after vs before
pq 'histogram_quantile(0.95, sum by (le, uri) (rate(http_server_requests_seconds_bucket{namespace="payments", service="payments-api"}[30m])))'
pq 'histogram_quantile(0.95, sum by (le, uri) (rate(http_server_requests_seconds_bucket{namespace="payments", service="payments-api"}[30m] offset 1h)))'
pq 'sum by (uri) (rate(http_server_requests_seconds_count{namespace="payments", service="payments-api", status=~"5.."}[30m])) / sum by (uri) (rate(http_server_requests_seconds_count{namespace="payments", service="payments-api"}[30m]))'
```

```console
/api/checkout	1.64
/api/quotes	0.41
/api/checkout	0.71
/api/quotes	0.39
/api/checkout	0.004
```

`/api/checkout` 0.71 s → 1.64 s, `/api/quotes` unchanged, and one 5xx row (a route with no 5xx has no numerator series and simply doesn't print — absence is the zero). One route, no failures: a code-path regression rather than a dependency. Confirm the timing lines up with the rollout — the revision and its pod template diff:

**Lens 1 — what else changed.**

```bash
# seat: tenant — CHANGE-CAUSE is <none> unless the chart sets the kubernetes.io/change-cause annotation; the revision numbers are what you need
kubectl rollout history deployment/payments-api -n $NS | tail -3
kubectl rollout history deployment/payments-api -n $NS --revision=42 | grep -E "Image|Limits|Requests|cpu|memory|JAVA_TOOL_OPTIONS"
kubectl rollout history deployment/payments-api -n $NS --revision=41 | grep -E "Image|Limits|Requests|cpu|memory|JAVA_TOOL_OPTIONS"
pq 'sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{namespace="payments", container="payments-api"}[10m])) / sum by (pod) (rate(container_cpu_cfs_periods_total{namespace="payments", container="payments-api"}[10m]))'
```

```console
REVISION  CHANGE-CAUSE
41        <none>
42        <none>
    Image:      registry.internal/payments/payments-api:2.15.0
    Limits:
      memory:   1Gi
    Requests:
      cpu:      250m
      memory:   512Mi
    Image:      registry.internal/payments/payments-api:2.14.0
    Limits:
      memory:   1Gi
    Requests:
      cpu:      250m
      memory:   512Mi
payments-api-7c9d4f6b8-k2xvn	0.03
payments-api-7c9d4f6b8-r8pqz	0.02
```

Same requests, same limits, same flags (the two `JAVA_TOOL_OPTIONS:` lines the grep also prints are long and identical — elided here), no throttling: the image is the only change. (If the resources *had* changed, that's your answer and symptom 2 or 5 is the follow-up.)

**Lens 3 — the profile, from the ring buffer that was already recording.**

```bash
# seat: tenant — dump the last hour (toolkit step 5), pull it out, read it with a JDK 21's jfr on your laptop
F=regression-$(date +%H%M).jfr
kubectl exec $POD -n $NS -- $JATTACH $JPID jcmd "JFR.dump filename=/dumps/$F"
kubectl cp $NS/$POD:/dumps/$F ./$F
jfr view hot-methods $F | head -12
```

```console
                                     Hot Methods
Method                                                                  Samples  Percent
----------------------------------------------------------------------- ------- -------
com.acme.payments.checkout.PriceCalculator.applyPromotions(...)           2,911   38.4%
java.util.regex.Pattern$Curly.match0(...)                                  1,720   22.7%
com.acme.payments.checkout.PromotionRule.matches(...)                        934   12.3%
oracle.net.ns.Packet.receive(...)                                            402    5.3%
```

38% of samples in `applyPromotions`, most of it under a regex — a new promotion rule compiling a pattern per request. The developer gets a method name, not a graph. Two other views earn their keep on a regression: `jfr view allocation-by-class` (a new allocation hot spot shows here before it shows in GC) and `jfr view contention-by-site` (a new `synchronized` block). No JDK 21 on the laptop → JDK Mission Control reads the same file ([JFR](/java/java-observability/#jfr-the-black-box-flight-recorder-you-already-have)).

**The artifact — the before/after table.**

| Route | p95 before (rev 41) | p95 after (rev 42) | 5xx rate | Changed in rev 42 | Hot method |
|---|---|---|---|---|---|
| `/api/checkout` | 0.71 s | 1.64 s | 0.4% | image only | `PriceCalculator.applyPromotions` 38% |
| `/api/quotes` | 0.39 s | 0.41 s | 0% | image only | — |

**Decide.** One route, no errors, image-only change, a named hot method → roll forward if the fix is a one-liner the developer can ship inside the SLO's error budget, otherwise `kubectl rollout undo` ([Card A](/operations/emergency-playbooks/#card-a-bad-deploy-going-out-right-now)) and fix at leisure. All routes slower with no image change → not a regression: symptoms 2 or 4.

## 4. One pod is slower than its siblings

**Situation.** Fleet p99 is fine on average, but one pod is 8× slower, and averages are hiding it. Either the pod is different (its own GC, a pinned connection, a bad start) or its *node* is (a noisy neighbor, pressure).

**The walk.** L2 per-pod, not per-service → L1 the pod's node and what else lives there → L3 on *that* pod, and no other.

**Lens 2 — break every number down by pod.**

```bash
# seat: tenant
pq 'histogram_quantile(0.99, sum by (le, pod) (rate(http_server_requests_seconds_bucket{namespace="payments", service="payments-api"}[5m])))'
pq 'sum by (pod) (rate(http_server_requests_seconds_count{namespace="payments", service="payments-api"}[5m]))'
pq 'tomcat_threads_busy_threads{namespace="payments", service="payments-api"}'
pq 'sum by (pod) (rate(jvm_gc_pause_seconds_sum{namespace="payments", service="payments-api"}[5m]))'
```

```console
payments-api-7c9d4f6b8-k2xvn	0.44
payments-api-7c9d4f6b8-r8pqz	3.51      ← the one
payments-api-7c9d4f6b8-t7mzc	0.47
payments-api-7c9d4f6b8-k2xvn	61.2
payments-api-7c9d4f6b8-r8pqz	58.9      ← same load
payments-api-7c9d4f6b8-t7mzc	60.4
payments-api-7c9d4f6b8-k2xvn	22
payments-api-7c9d4f6b8-r8pqz	188       ← threads piling up
payments-api-7c9d4f6b8-t7mzc	24
payments-api-7c9d4f6b8-k2xvn	0.004
payments-api-7c9d4f6b8-r8pqz	0.006     ← GC innocent
payments-api-7c9d4f6b8-t7mzc	0.004
```

Same RPS, eight times the p99, threads piling up, GC no different: the pod is slow *for reasons outside the JVM's own accounting* — a node symptom until proven otherwise.

**Lens 1 — the node, and the neighbors.**

```bash
# seat: tenant — where is it, and is its cgroup being squeezed?
kubectl get pods -n $NS -l app.kubernetes.io/name=payments-api -o custom-columns=POD:.metadata.name,NODE:.spec.nodeName
pq 'sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{namespace="payments", container="payments-api"}[5m])) / sum by (pod) (rate(container_cpu_cfs_periods_total{namespace="payments", container="payments-api"}[5m]))'
# seat: cluster-read — the node's other tenants and its pressure; ask if denied
kubectl describe node node-w07 | grep -A6 "Allocated resources"
pq 'count by (node) (kube_pod_info{node=~"node-w0[379]"})'
# node-exporter labels its series by instance (often IP:9100); the join to node_uname_info names the node and filters to the three you care about
pq '(1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))) * on (instance) group_left (nodename) node_uname_info{nodename=~"node-w0[379]"}'
```

```console
POD                            NODE
payments-api-7c9d4f6b8-k2xvn   node-w03
payments-api-7c9d4f6b8-r8pqz   node-w07
payments-api-7c9d4f6b8-t7mzc   node-w09
payments-api-7c9d4f6b8-k2xvn	0.02
payments-api-7c9d4f6b8-r8pqz	0.03      ← NOT throttled: its quota isn't the wall
payments-api-7c9d4f6b8-t7mzc	0.02
  cpu                14200m (89%)  31600m (197%)
  memory             52Gi (83%)    96Gi (153%)
node-w03	38
node-w07	61
node-w09	35
node-w03	0.41
node-w07	0.97                                ← the node itself is at 97% CPU
node-w09	0.38
```

Not throttled by its own limit — but the node is at 97% and 197% overcommitted on limits: the pod is getting its *request* and nothing more, while its siblings burst freely on quieter nodes. That's [cause 7](/troubleshooting/its-slow/#cause-7-noisy-neighbor-and-node-pressure--slow-by-location), and it isn't yours to fix — it's evidence for [the pack](/java/lens-playbooks-size-and-scale/#3-the-evidence-pack-for-the-platform-team). (If `nodename` on your stack isn't the Kubernetes node name — some node-exporter installs relabel it as `node` — swap the label; `pq` prints either.)

**Lens 3 — on that pod, to make sure.** If the node had been quiet, the difference is inside the pod, and the dump is taken on `r8pqz` and nowhere else:

```bash
# seat: tenant — a different pod: re-run toolkit steps 1–2 (its pid, and a jattach copy of its own)
export POD=payments-api-7c9d4f6b8-r8pqz
for i in 1 2 3; do kubectl exec $POD -n $NS -- $JATTACH $JPID threaddump > td-slow-$i.txt; sleep 10; done
grep -c 'HikariPool' td-slow-2.txt; grep -B1 -A6 'Found one Java-level deadlock' td-slow-2.txt
```

A pod-local cause shows here as a lock convoy (many `BLOCKED … waiting to lock` on one monitor — the holder's stack is the answer), a deadlock the JVM names for you, or a client that pinned every connection to this pod ([long-lived connections](/networking/long-lived-connections/)). Nothing unusual in the dump plus a hot node = the node.

**The artifact — the pod-vs-fleet table.**

| | `k2xvn` (node-w03) | **`r8pqz` (node-w07)** | `t7mzc` (node-w09) |
|---|---|---|---|
| p99 | 0.44 s | **3.51 s** | 0.47 s |
| RPS | 61 | 59 | 60 |
| Busy threads | 22 | **188** | 24 |
| GC s/s | 0.004 | 0.006 | 0.004 |
| Throttle ratio | 0.02 | 0.03 | 0.02 |
| Node CPU busy | — | **0.97**, limits 197% overcommitted | — |
| Dump | — | nothing pod-local | — |

**Decide.** Node hot, pod innocent → the evidence pack and, immediately, `kubectl delete pod` so the replacement lands elsewhere. A delete is not an eviction: the PDB doesn't gate it, so *you* are the budget check — confirm the other replicas are Ready first ([the budget page](/disruption/pod-disruption-budgets/)) — and the scheduler may well put the replacement back on w07 unless something says otherwise, which is why the durable fix is [soft spread](/workloads/high-availability/#spreading-pods-anti-affinity-and-topologyspreadconstraints), asked for the same day. Node quiet, dump shows a convoy or pinning → pod-local: the lock or the client. Node quiet, dump clean, GC high on this pod only → symptom 5 on this pod.

## 5. Is GC the problem?

**Situation.** Someone says "it's GC." Sometimes it is; often it's CPU throttling wearing a GC costume, and the only way to tell is the GC's own numbers next to the throttle ratio.

**The walk.** L1 the throttle ratio *first* — a throttled JVM's GC threads stall too, so nothing GC says is admissible until the quota is ruled out ([its-slow](/troubleshooting/its-slow/#cause-1-cpu-throttling--the-1-and-the-one-your-graphs-hide) and [GC and Performance](/java/gc-and-performance/#cpu-throttling-masquerading-as-gc-problems) both put it first) → L2 the pause histogram, the time fraction, the allocation rate, the live set → L3 the GC log's danger phrases and the exact pauses.

**Lens 1 — is it the costume?** The same query as symptom 2; if you ran it there in the last few minutes, that answer stands.

```bash
# seat: tenant
pq 'sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{namespace="payments", container="payments-api"}[30m])) / sum by (pod) (rate(container_cpu_cfs_periods_total{namespace="payments", container="payments-api"}[30m]))'
```

```console
payments-api-7c9d4f6b8-k2xvn	0.04
payments-api-7c9d4f6b8-r8pqz	0.03
```

Throttle ratio negligible → whatever GC says next is honest. A ratio of 0.3 with *young* pauses at 400 ms is the costume: G1's parallel threads are being quota-stalled mid-pause, and the fix is the CPU limit, not the heap ([throttling masquerading as GC](/java/gc-and-performance/#cpu-throttling-masquerading-as-gc-problems)) — go back to symptom 2 and stop here.

**Lens 2 — four numbers.**

```bash
# seat: tenant — needs the jvm.gc.pause histogram (toolkit step 6)
pq 'histogram_quantile(0.99, sum by (le) (rate(jvm_gc_pause_seconds_bucket{namespace="payments", pod="'$POD'"}[30m])))'
pq 'sum(rate(jvm_gc_pause_seconds_sum{namespace="payments", pod="'$POD'"}[30m]))'
pq 'sum(rate(jvm_gc_memory_allocated_bytes_total{namespace="payments", pod="'$POD'"}[30m])) / 1024 / 1024'
pq 'jvm_gc_live_data_size_bytes{namespace="payments", pod="'$POD'"} / jvm_gc_max_data_size_bytes{namespace="payments", pod="'$POD'"}'
pq 'sum by (action) (increase(jvm_gc_pause_seconds_count{namespace="payments", pod="'$POD'"}[1h]))'
```

```console
-	1.84            ← p99 pause 1.84 s
-	0.061           ← 6.1% of wall time in pauses
-	48.2            ← 48 MiB/s allocated
payments-api-7c9d4f6b8-k2xvn	0.71    ← live set is 71% of the max heap
end of major GC	4      ← four FULL collections in the last hour
end of minor GC	612
```

A p99 pause near two seconds, four full GCs an hour, and a live set at 71% of the heap's maximum is a heap that's too small for what it has to keep — G1 is compacting because it has nowhere to evacuate. (For G1, Micrometer's `jvm_gc_max_data_size_bytes` is the max heap, and `live_data_size` is refreshed after any collection that shrank the old generation — so read the ratio as "what survives, over what the heap can ever be".) That's a *real* GC problem. If instead the pauses are short, the time fraction is under 1–2%, and there are no major collections, GC is innocent, whatever the panel's colour.

**Lens 3 — the log has every pause.** The toolkit's `-Xlog:gc*` goes to stdout, so it's in `kubectl logs`. Each pause is two lines — a `gc,start` line and the summary ending in `ms` — so count the summaries:

```bash
# seat: tenant
kubectl logs $POD -n $NS --since=1h | grep -E 'Pause (Full|Young)' | grep -oE '[0-9]+M->[0-9]+M\([0-9]+M\) [0-9.]+ms' | awk '{print $NF}' | sort -n | tail -3
kubectl logs $POD -n $NS --since=1h | grep -c 'To-space exhausted'
kubectl logs $POD -n $NS --since=1h | grep -cE 'Pause Full.*ms$'
kubectl logs $POD -n $NS --since=1h | grep -E 'Pause Full.*ms$' | tail -2
```

```console
1793.221ms
1841.907ms
1902.334ms
7
4
[2026-09-09T13:41:02.113+0000][41802.318s][info][gc] GC(7712) Pause Full (G1 Compaction Pause) 608M->437M(616M) 1841.907ms
[2026-09-09T13:52:44.870+0000][42505.075s][info][gc] GC(7791) Pause Full (G1 Compaction Pause) 612M->441M(616M) 1902.334ms
```

`608M->437M(616M)`: the 616 MiB heap (60% of the 1 GiB limit) collecting down to 437 MiB — the live set — with `To-space exhausted` seven times and four full collections in an hour ([the danger phrases](/java/gc-and-performance/#reading-gc-logs)). The exact timestamps line up against the p99 spikes in lens 2, which is the proof the *pauses* are the stalls.

**The artifact — the GC table.**

| Number | Value | Healthy looks like |
|---|---|---|
| Throttle ratio | 0.04 | < 0.05 — checked *before* anything else |
| Pause p99 (30 m) | 1.84 s | < 200 ms for a latency SLO of 800 ms |
| Time in pauses | 6.1% | < 1–2% |
| Allocation rate | 48 MiB/s | steady; a 2× jump after a deploy = a new hot spot |
| Live set / max heap | 0.71 (437 of 616 MiB) | < 0.5 |
| Full GCs / h | 4 | 0 |
| `To-space exhausted` / h | 7 | 0 |
| Verdict | heap too small for the live set | — |

**Decide.** Live set high and full GCs → the heap is undersized for what it keeps: raise `MaxRAMPercentage` inside the same limit only if the [RSS budget](/tuning/jvm-memory-knobs/#the-rss-budget-worked) has room, otherwise the limit *and* the request together, with the derivation written down — or find why the live set grew (symptom 1's histogram diff). Allocation rate jumped → `jfr view allocation-by-class` on a dump (symptom 3). Throttle ratio high → the CPU limit first, then re-measure GC; it usually vanishes.

## 6. Connection pool exhaustion against Oracle

**Situation.** Latency climbs on every DB-backed route at once, error logs mention `Connection is not available, request timed out after 30000ms`, CPU is bored. The pool is the ceiling with the suspiciously round number ([cause 3](/troubleshooting/its-slow/#cause-3-connection-pool-exhaustion--the-ceiling-with-a-suspiciously-round-number)).

**The walk.** L2 the pool gauges and acquire time (is the pool full, and are connections *slow* or *leaked*?) → L3 who holds them, and what they're doing.

**Lens 2 — the pool's four numbers, per pod.**

```bash
# seat: tenant — needs the hikaricp.connections.acquire histogram (toolkit step 6)
pq 'hikaricp_connections_active{namespace="payments", service="payments-api"}'
pq 'hikaricp_connections_max{namespace="payments", service="payments-api"}'
pq 'hikaricp_connections_pending{namespace="payments", service="payments-api"}'
pq 'histogram_quantile(0.95, sum by (le, pod) (rate(hikaricp_connections_acquire_seconds_bucket{namespace="payments", service="payments-api"}[5m])))'
pq 'sum by (pod) (increase(hikaricp_connections_timeout_total{namespace="payments", service="payments-api"}[30m]))'
pq 'histogram_quantile(0.95, sum by (le, pod) (rate(hikaricp_connections_usage_seconds_bucket{namespace="payments", service="payments-api"}[5m])))'
```

```console
payments-api-7c9d4f6b8-k2xvn	10
payments-api-7c9d4f6b8-r8pqz	10
payments-api-7c9d4f6b8-k2xvn	10            ← active == max on both: full, fleet-wide
payments-api-7c9d4f6b8-r8pqz	10
payments-api-7c9d4f6b8-k2xvn	41            ← 41 requests waiting for a connection
payments-api-7c9d4f6b8-r8pqz	38
payments-api-7c9d4f6b8-k2xvn	28.4          ← p95 wait to ACQUIRE: 28 s (timeout is 30)
payments-api-7c9d4f6b8-r8pqz	27.1
payments-api-7c9d4f6b8-k2xvn	117           ← timeouts in 30 min
payments-api-7c9d4f6b8-r8pqz	104
payments-api-7c9d4f6b8-k2xvn	6.9           ← p95 time a connection is HELD: 6.9 s
payments-api-7c9d4f6b8-r8pqz	6.7
```

Active equals max on every pod, a queue of ~40 each, and — the discriminating number — connections are *held* for 6.9 s at p95. Ten connections held seven seconds each is 1.4 requests per second of DB capacity per pod, against 60 rps. Either the queries got slow (Oracle's side, or a plan change) or something holds connections open across non-DB work. If usage time were normal (tens of ms) and the pool still full, it's a *leak* — connections checked out and never returned. Every pod reading the same is the fleet-wide signature; one pod alone would be symptom 4.

**Lens 3 — who has them, and what are they doing.**

```bash
# seat: tenant
for i in 1 2 3; do kubectl exec $POD -n $NS -- $JATTACH $JPID threaddump > td-pool-$i.txt; sleep 10; done
# threads waiting for a connection (one ConcurrentBag.borrow frame per waiter) vs threads holding one and working
grep -c 'ConcurrentBag.borrow' td-pool-2.txt
grep -A12 'HikariProxyConnection\|HikariProxyPreparedStatement' td-pool-2.txt | grep -oE 'at com\.acme\.[A-Za-z.]+\([A-Za-z]+\.java:[0-9]+\)' | sort | uniq -c | sort -rn | head -5
```

```console
41
     10  at com.acme.payments.quotes.QuoteRepository.findByAccountWithHistory(QuoteRepository.java:88)
```

41 threads parked in HikariCP's `ConcurrentBag.borrow` (the queue, seen from inside — `HikariPool.getConnection` appears twice per waiter's stack, so counting that would say 82) and all ten connections inside the same repository method, in all three dumps. One query. Had the ten holders been in `RestTemplate` calls or `Thread.sleep` with a connection open, that's the leak pattern — a connection borrowed before a slow remote call and returned after — and HikariCP's `leakDetectionThreshold` (a config line) will name the borrower's stack in the log on the next occurrence.

**The artifact — the pool timeline.**

| Number | Value | Source |
|---|---|---|
| Active / max | 10 / 10 | L2 |
| Pending | 41 | L2 |
| Acquire p95 | 28.4 s (timeout 30 s) | L2 |
| Timeouts / 30 m | 117 | L2 |
| Usage p95 (held) | 6.9 s | L2 |
| Holders (3 dumps) | 10 × `QuoteRepository.findByAccountWithHistory:88` | L3 |
| Verdict | one slow query holding the pool | — |

**Decide.** One method holding every connection → the query (an execution plan, a missing bind, a new data volume) — the DBA conversation, with the method name and the timestamps; a statement timeout so the pool can't be held hostage ([the timeout budget](/tuning/timeout-budget/)). Held time normal, pool still full → a leak: `leakDetectionThreshold: 20000` and read the log. Everything healthy but pending non-zero at peak → the pool is simply small for the load — and raising it is an [Oracle session budget](/autoscaling/rest-api-oracle/#the-pool-math) decision, because `maxReplicas × maximumPoolSize` is the number the DBA cares about. Never "fix" pool exhaustion by adding replicas without doing that arithmetic.

## 7. A thread leak

**Situation.** `jvm_threads_live_threads` climbs like a staircase over days, the pod's working set climbs with it (each thread's stack is native memory), and eventually the JVM fails with `unable to create native thread` or the kernel kills the container.

**The walk.** L2 the staircase and the thread states → L3 a thread dump grouped by *name*, which names the executor, and JFR for who created it → L1 the stacks showing up in NMT's `Thread` category.

**Lens 2.**

```bash
# seat: tenant
pqr 'jvm_threads_live_threads{namespace="payments", pod="'$POD'"}' 3 12h
pq 'sum by (state) (jvm_threads_states_threads{namespace="payments", pod="'$POD'"})'
```

```console
payments-api-7c9d4f6b8-k2xvn	2026-09-07T00:00:00Z	214
payments-api-7c9d4f6b8-k2xvn	2026-09-07T12:00:00Z	289
payments-api-7c9d4f6b8-k2xvn	2026-09-08T00:00:00Z	361
payments-api-7c9d4f6b8-k2xvn	2026-09-08T12:00:00Z	438
timed-waiting	401
waiting	22
runnable	15
```

Seventy-odd new threads every twelve hours, nearly all `timed-waiting` — idle threads that were created and never reclaimed. An executor without a bound, or one created per request.

**Lens 3 — group by name prefix, then ask JFR who made them.**

```bash
# seat: tenant — the histogram: strip the trailing number so "reconcile-scheduler-317" and "-318" count together
kubectl exec $POD -n $NS -- $JATTACH $JPID threaddump > td-threads.txt
grep -oE '^"[^"]+"' td-threads.txt | sed -E 's/-?[0-9]+"$/"/' | sort | uniq -c | sort -rn | head -6
# who creates them: the ring buffer records jdk.ThreadStart with the creating thread's stack (on in settings=default)
F=threads-$(date +%H%M).jfr
kubectl exec $POD -n $NS -- $JATTACH $JPID jcmd "JFR.dump filename=/dumps/$F"
kubectl cp $NS/$POD:/dumps/$F ./$F
jfr print --events jdk.ThreadStart --stack-depth 30 $F | grep -A30 'reconcile-scheduler' | grep -m1 'com.acme'
```

```console
    388 "reconcile-scheduler"
     23 "http-nio-8080-exec"
      8 "GC Thread#"
      6 "ForkJoinPool.commonPool-worker"
      4 "kafka-producer-network-thread"
      2 "Catalina-utility"
    com.acme.payments.reconcile.ReconcileService.schedule(PaymentEvent) line: 61
```

388 threads named `reconcile-scheduler-N` from one place: a `ScheduledExecutorService` built inside a method that runs per event, never shut down. The name prefix *is* the diagnosis, and it's what you grep the code for (`grep -rn 'reconcile-scheduler' src/` finds the `ThreadFactory` that names them). What the thread dump can *not* tell you is who created them — an idle executor thread's stack is all JDK frames (`Unsafe.park` … `DelayedWorkQueue.take` … `ThreadPoolExecutor.runWorker`), and a busy one's stack names its *task*, not its creator. The creator is a JFR question: `jdk.ThreadStart` carries the stack of the thread that called `start()`, and the ring buffer from toolkit step 5 has the last hour of them.

**Lens 1 — the cost, in memory and in pids.** With NMT on (symptom 1's native branch), the same leak reads on the `Thread` line as `reserved` growing by exactly `-Xss` per thread (388 × 1 MiB) and `committed` by only what each idle thread touched (tens of KB each — the working-set-minus-heap delta from symptom 1 climbs slowly, not 388 MiB). Which is why a thread leak usually hits a *count* wall before a memory wall: the pod's pid limit. cAdvisor counts both the threads and the ceiling:

```bash
# seat: tenant — every thread is a pid to the cgroup; the kubelet's podPidsLimit (platform-set) is the wall, and cAdvisor exports it
pq 'container_threads{namespace="payments", pod="'$POD'", container="payments-api"}'
pq 'container_threads_max{namespace="payments", pod="'$POD'", container="payments-api"}'
```

```console
payments-api-7c9d4f6b8-k2xvn	452
payments-api-7c9d4f6b8-k2xvn	4096
```

452 of 4,096 and climbing a staircase (the JVM's own gauge counts Java threads; the cgroup also counts the GC and JIT threads) — at the ceiling, the next `new Thread().start()` fails with `java.lang.OutOfMemoryError: unable to create native thread` ([the thread-leak section](/java/memory-leaks-and-oom/#thread-leaks)), a pid failure wearing a memory error's name. The staircase's slope gives you the date.

**The artifact.** The staircase (`pqr`), the state breakdown, the name histogram, the creating frame from JFR, and the pid count — five lines.

**Decide.** One prefix dominating → bound it: a shared, sized executor (Spring's `ThreadPoolTaskScheduler`/`TaskExecutor` beans, `executor_*` metrics for free) and `shutdown()` on whatever was creating them. Many prefixes growing slowly → a library creating threads per connection (HTTP clients per request are the classic); one client instance, reused. `-Xss` and `MaxDirectMemorySize` are not fixes for a leak, only for its blast radius.

## 8. No data for our pod

**Situation.** The dashboard is empty for `payments-api`, or the HPA says `<unknown>`, or an alert never fired. Nothing on lens 2 exists until four links hold, and the fault is almost always link two.

**The walk.** Lens 2's chain, in order: does the app publish → is it scraped → does Prometheus have it → is the query right. The scrape goes through a *second* Service — `payments-api-management`, a ClusterIP on port 8081 only — because [the Actuator page's rule](/java/actuator/#exposure-discipline-enabled--exposed--reachable) keeps the management port out of the Service behind the Ingress.

```bash
# seat: tenant — link 1: the app publishes (via the port-forward from toolkit step 4)
curl -s localhost:8081/actuator/prometheus | grep -cE '^(http_server_requests_seconds_bucket|tomcat_threads_busy_threads|jvm_memory_used_bytes)'
# link 2: the scrape object exists, names a port that exists on the management Service, and carries the label the platform's Prometheus selects on
kubectl get servicemonitor -n $NS -o custom-columns=NAME:.metadata.name,LABELS:.metadata.labels,PORT:.spec.endpoints[0].port,SELECTOR:.spec.selector.matchLabels
kubectl get svc payments-api-management -n $NS -o jsonpath='{range .spec.ports[*]}{.name}={.port}{"\n"}{end}'
# seat: cluster-read — the selector Prometheus actually uses; ask if denied
kubectl get prometheus -n monitoring -o jsonpath='{.items[0].spec.serviceMonitorSelector}{"\n"}'
# link 3: Prometheus has a target for you, and it's healthy
curl -s "$PROM/api/v1/targets?state=any" | jq -r '.data.activeTargets[] | select(.labels.namespace=="payments") | [.labels.pod, .health, .scrapeUrl, .lastError] | @tsv'
pq 'up{namespace="payments"}'
# link 4: the series exists under the name and labels you're querying
curl -sG "$PROM/api/v1/series" --data-urlencode 'match[]=http_server_requests_seconds_count{namespace="payments"}' | jq -r '.data[0]'
```

```console
1893
NAME           LABELS                                                  PORT         SELECTOR
payments-api   map[app.kubernetes.io/name:payments-api team:payments]  management   map[app.kubernetes.io/name:payments-api app.kubernetes.io/component:management]
management=8081
{"matchLabels":{"release":"monitoring"}}

null
```

Link 1 holds (1,893 series published). Link 2 is broken exactly the way [Lab 6](/labs/lab-6-observability/) breaks it: the ServiceMonitor carries `team: payments` and the platform's Prometheus selects on `release: monitoring` — so link 3 prints nothing (no target at all, not even an unhealthy one) and link 4 prints `null`. The fix is one label. Other link-2 faults with the same empty result: the endpoint's `port` naming a port that doesn't exist on the Service it selects, a `namespaceSelector` on the Prometheus that excludes you, or a NetworkPolicy blocking `monitoring` → 8081 ([debugging network](/networking/debugging-network/)). A target that *exists* but is `down` with a `lastError` is a different, easier day: the error names the port, the path, or the policy.

```bash
# seat: tenant — the fix, then the proof: the operator reloads its config and the first scrape lands within a minute or two
kubectl label servicemonitor payments-api -n $NS release=monitoring
sleep 90; pq 'up{namespace="payments"}'
```

```console
payments-api-7c9d4f6b8-k2xvn	1
payments-api-7c9d4f6b8-r8pqz	1
```

The label proves the link; it doesn't keep it. The ServiceMonitor is a Helm-managed object, and the next `helm upgrade` renders it from the template — without `release: monitoring` — and the metrics vanish again, a week later, with nobody touching anything. Before the incident closes, the label goes into the chart's ServiceMonitor template.

**The artifact — the four-link checklist**, with the proof line for each; it belongs in the chart's README:

| Link | Proof | Holds? |
|---|---|---|
| 1. App publishes | `curl …/actuator/prometheus \| grep -c` > 0 | ✔ 1,893 |
| 2. Scrape object matches | ServiceMonitor label ⊇ Prometheus selector; port name exists on the management Service | ✘ `team` ≠ `release` |
| 3. Prometheus has a healthy target | `/api/v1/targets` shows the pod `up`; `up == 1` | ✘ (no target) |
| 4. The series exists as queried | `/api/v1/series` returns it | ✘ (`null`) |

**Decide.** Fix the first broken link, re-run the rest, and put the fix in the chart, not on the object. Then make the silence impossible to miss: `absent(up{namespace="payments", job=~"payments-api.*"})` as an alert ([the dead-man's switch](/observability/alerting/#the-dead-mans-switch-absent)) — a dashboard that's empty because nothing is scraped looks exactly like a dashboard that's empty because nothing is wrong.

## Where next

- **Next in the journey:** [Three Lenses, Tactically III: Size and Scale](/java/lens-playbooks-size-and-scale/) — the zoom run the other way: requests and limits from data, a scaling signal proved through prometheus-adapter, and the evidence pack.
- **Back to the questions:** [Three Lenses, Tactically I: The Use Cases](/java/lens-playbooks-use-cases/) — the twelve questions these symptoms are ruled out under, and the order to rule them out in.
- **The lateral jump:** the model these commands implement, and why the walk has this order — [The Three Lenses](/start/three-lenses/).
