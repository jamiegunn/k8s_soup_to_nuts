---
title: GC and JVM Performance in Pods
description: Choosing a garbage collector for containerized JVMs, capturing and reading GC logs with unified logging, and telling real GC problems from CPU throttling.
keywords:
  - garbage collector selection
  - -XX:+UseG1GC
  - unified logging -Xlog:gc
  - To-space exhausted
  - Pause Full G1
  - humongous allocations
  - allocation rate
  - cpu throttling nr_throttled
  - cpu.stat cgroup
  - JDK Flight Recorder allocation profiling
  - p99 latency spikes
  - Metadata GC Threshold metaspace
sidebar:
  order: 7
---

Most "the JVM is slow in Kubernetes" investigations end in one of three
places: a mis-sized heap, a mis-chosen (or ergonomically surprising)
collector, or CPU throttling that has nothing to do with GC at all. All
three are diagnosable from inside your namespace with flags and logs — no
JDK tools required.

## Choosing a collector

| Collector | Flag | Use when | Watch out |
|---|---|---|---|
| **G1** (default) | `-XX:+UseG1GC` | Default for a reason: balanced pause/throughput, heaps 1–32 GiB | Needs ≥2 CPUs to shine; pause target is a *goal*, not a promise |
| **Serial** | `-XX:+UseSerialGC` | Tiny containers: <2 CPUs or <~1.8 GiB — where the JVM's ergonomics may pick it *for you* | Full-pause collector; fine for small heaps, brutal for big ones |
| **Parallel** | `-XX:+UseParallelGC` | Batch jobs where total throughput matters and pauses don't | Long full-GC pauses |
| **ZGC** | `-XX:+UseZGC` (generational by default in JDK 23+; `-XX:+ZGenerational` on 21) | Latency-critical, sub-ms pauses, heaps up to terabytes | Wants CPU headroom and memory headroom; higher RSS bookkeeping |
| **Shenandoah** | `-XX:+UseShenandoahGC` | Similar niche to ZGC | Not in every build (Temurin yes, some vendors no) |

The container-specific trap: **ergonomics.** On a pod with 1 effective CPU
or a small memory limit, the JVM may silently select SerialGC and minimal
GC threads where your laptop (16 cores) ran G1. Same image, different
collector, different pause profile. Always confirm what you actually got:

```bash
kubectl exec myapp-7d4b9c6f5d-x2klm -- java -XX:+PrintFlagsFinal -version 2>/dev/null | grep -E 'Use.*GC .*true'
```

That runs a *throwaway* JVM with the same ergonomics, which is close enough;
for the live process, `jcmd <pid> VM.flags` or `jattach <pid> jcmd VM.flags`
gives ground truth. Effective CPU
count and how limits shape it is covered in
[JVM in containers](/java/jvm-in-containers/).

Don't collector-shop until you have data. G1 with a right-sized heap is the
correct answer for most services; switching collectors to fix an
undersized-heap problem just changes the shape of the pain.

## GC logging: turn it on, leave it on

Unified logging (JDK 9+) replaced the old `-XX:+PrintGCDetails` zoo with
`-Xlog`:

```text
# To stdout — visible in `kubectl logs`, flows into your log pipeline:
-Xlog:gc*:stdout:time,uptime,level,tags

# Or to a rotating file on a volume — keeps app logs clean, survives scrapes:
-Xlog:gc*:file=/dumps/gc.log:time,uptime,level,tags:filecount=5,filesize=20m
```

Overhead is negligible; there is no good reason a production JVM should run
without GC logging. Stdout vs file is a real choice: stdout means the data
is already in your logging system (searchable across restarts, no
extraction step), but interleaves with app logs and
can be pruned by aggressive pipelines. File on a volume gives clean input
for analyzers (GCeasy, gceasy-style tools, GCViewer). Many teams do both:
`-Xlog:gc:stdout -Xlog:gc*:file=/dumps/gc.log:...`.

## Reading GC logs

```console
[2026-07-03T09:14:02.113+0000][512.318s][info][gc,start    ] GC(241) Pause Young (Normal) (G1 Evacuation Pause)
[2026-07-03T09:14:02.141+0000][512.346s][info][gc,heap     ] GC(241) Eden regions: 612->0(614)
[2026-07-03T09:14:02.141+0000][512.346s][info][gc          ] GC(241) Pause Young (Normal) (G1 Evacuation Pause) 2456M->912M(4096M) 27.842ms
```

The line to internalize: `2456M->912M(4096M) 27.842ms` — heap before →
after (total), and pause time. From a few hours of these you derive the
three numbers that describe your JVM's health:

- **Allocation rate:** heap growth between collections ÷ time between them.
  `912M` after GC(241), `2456M` before GC(242) 30 s later ≈ 51 MB/s. Rates
  that jump (2× the usual) after a deploy = a new allocation hot spot; find
  it with JFR (below), not by staring at code.
- **Pause distribution:** grep the pauses, look at p99 not average. Young
  pauses creeping up usually track live-set growth; a leak shows here before
  it shows anywhere else.
- **Post-GC baseline:** the `->912M` numbers over days. Flat = healthy.
  Monotonic rise = the leak workflow in
  [Memory leaks and OOM](/java/memory-leaks-and-oom/).

```bash
kubectl logs myapp-7d4b9c6f5d-x2klm | grep -oE 'Pause Young.*[0-9.]+ms' | awk '{print $NF}' | sort -n | tail -5
```

Danger phrases to grep for in G1 logs:

- `Pause Full` — G1 fell off a cliff; heap too small or humongous-allocation
  pressure. One after startup is noise; recurring is an incident.
- `To-space exhausted` — evacuation failed because there was nowhere to copy
  survivors; almost always "heap too small for the live set + allocation
  spike". Precedes Full GCs.
- `Humongous` regions churning — allocations >½ region size (big byte
  arrays, giant JSON). Consider `-XX:G1HeapRegionSize=16m` or fixing the
  allocation.

## JFR for GC and allocation profiling

GC logs say *that* you allocate 500 MB/s; Flight Recorder says *which code*.
JFR ships in every OpenJDK 11+ runtime, including jlink JREs (module
`jdk.jfr`, included by default), at ~1% overhead:

```text
-XX:StartFlightRecording=maxsize=100m,maxage=1h,filename=/dumps/app.jfr,dumponexit=true
```

Dump the ring buffer on demand with `jcmd 7 JFR.dump name=1 filename=/dumps/now.jfr`
— or via jattach on a bare JRE. Open in JDK Mission Control: the *Memory*
page gives allocation-by-class and allocation-by-stack (TLAB sampling), the
*Garbage Collections* page gives pause causes and longest-pause analysis.
Full JFR operations, including continuous recording as a default posture,
are in [Java observability](/java/java-observability/).

## CPU throttling masquerading as GC problems

The most common wrong diagnosis in containerized JVM performance. Symptoms:
occasional multi-hundred-ms "pauses", p99 latency spikes, sometimes even GC
log lines showing modest pause times *while users see much worse*.

With `limits.cpu` set, the kernel enforces the quota per period (default
100 ms): use up your quota in the first 40 ms of a period and the container
sits frozen for the remaining 60. A GC cycle is exactly the kind of burst
that eats a period's quota — so GC *triggers* throttling, and throttling
inflates the *observed* pause far beyond what the JVM measured. The GC log
says 30 ms; the world stopped for 300.

Check throttling from inside the pod — it's your cgroup, no platform team
needed:

```bash
# cgroup v2:
kubectl exec myapp-7d4b9c6f5d-x2klm -- cat /sys/fs/cgroup/cpu.stat
```

```console
usage_usec 8123456789
nr_periods 861234
nr_throttled 91422
throttled_usec 412345678
```

`nr_throttled / nr_periods` > a few percent on a latency-sensitive service
is your smoking gun (here: 10.6%). On cgroup v1 the file is
`/sys/fs/cgroup/cpu/cpu.stat`. Also compare `kubectl top pod` against your
`limits.cpu` — sustained 90%+ means every burst throttles.

Fixes, cheapest first: raise `limits.cpu` (or remove it, where policy
allows); reduce GC CPU demand (smaller young gen churn, fewer GC threads via
`-XX:ParallelGCThreads` if the thread count is silly relative to quota);
`-XX:ActiveProcessorCount` to stop the JVM sizing for CPUs it can't burst
to. Request/limit strategy trade-offs live in
[Resources and QoS](/workloads/resources-and-qos/).

:::note[Rule of thumb]
Before tuning any GC flag, rule out throttling and confirm heap sizing. In
that order. The majority of "GC tuning" tickets close with `cpu.stat`
evidence and a limits change — zero JVM flags touched.
:::

## A symptom → cause table

| Symptom | Likely cause | Confirm with |
|---|---|---|
| Long young pauses, growing over days | Live set growing (leak) | Post-GC baseline in GC log; then heap dump |
| Sudden frequent GCs after deploy | Allocation-rate regression | GC log rate math; JFR allocation profile |
| `Pause Full` recurring | Heap too small / humongous churn / metaspace | GC log cause field (`Metadata GC Threshold` = metaspace, not heap!) |
| `To-space exhausted` | Evacuation failure under spike | GC log; raise heap or `G1ReservePercent` |
| Pauses fine in log, latency terrible | CPU throttling | `cpu.stat` nr_throttled |
| High GC CPU, tiny heap freed each cycle | Heap barely above live set | `->` numbers hugging max; raise heap |
| Great for hours, then a huge pause | Full GC from slow promotion buildup | GC log; JFR GC page |
| OOMKilled with healthy-looking GC log | Container limit, not heap — different problem | [Memory leaks and OOM](/java/memory-leaks-and-oom/) |

Everything here is capturable with flags you deploy through CI/CD and files
you read with `kubectl logs`/`kubectl exec` — the JRE-only constraint costs
you nothing for GC work.
