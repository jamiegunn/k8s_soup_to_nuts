---
title: "Field Notes: OOMKilled, but the Heap Was Fine"
description: The container kept dying at its memory limit while every heap dump showed a healthy 60% heap — the missing gigabyte was direct buffers, metaspace, and thread stacks.
keywords:
  - exit code 137
  - NativeMemoryTracking jcmd VM.native_memory
  - netty direct buffers off-heap
  - metaspace classloader leak
  - MaxDirectMemorySize cap
  - unbounded newCachedThreadPool
  - container_memory_working_set_bytes
  - MALLOC_ARENA_MAX glibc arenas
  - RSS exceeds committed memory
date: 2026-04-28
authors: editor
tags:
  - java
  - jvm
  - memory
  - oomkilled
excerpt: Exit code 137, over and over — but the heap dumps were boring. Sixty percent used, healthy object graph, nothing leaking. We were hunting a Java memory leak in the one part of the JVM that heap dumps can't see.
---

`stream-ingest` was getting OOMKilled every eight to twelve hours, and everyone knew the drill: it's Java, it's memory, grab a heap dump, find the leak. So we did.

```console
$ kubectl describe pod stream-ingest-0 | grep -A4 'Last State'
    Last State:     Terminated
      Reason:       OOMKilled
      Exit Code:    137
      Started:      Mon, 20 Apr 2026 03:11:42 +0000
      Finished:     Mon, 20 Apr 2026 11:52:07 +0000
```

The pod had a 3Gi limit and `-Xmx2g`. The heap dump, taken twenty minutes before a kill: 1.2GB of a 2GB heap, tidy object graph, no suspicious dominators, GC keeping up beautifully. We took another one ten minutes before the next kill. Also fine. The heap was the healthiest thing in the building, and the kernel kept executing the process anyway.

That's the tell, and it took us embarrassingly long to say it out loud: **the OOM killer doesn't read heap dumps.** cgroup accounting counts every page the process touches. `-Xmx` caps exactly one of the JVM's dozen memory regions. We were auditing the one region that had an auditor while the others ran wild.

## Watching the RSS climb past the heap

First, the shape of the problem from inside the pod — no tools needed beyond `/proc` and the cgroup files:

```console
$ kubectl exec stream-ingest-0 -- sh -c \
    'cat /sys/fs/cgroup/memory.current; grep VmRSS /proc/1/status'
3103784960
VmRSS:   2988012 kB
```

2.85GiB resident against a 3Gi limit, with a heap using 1.2GB. Roughly 1.7GB of the process was *not heap*, and it grew a few MB an hour. To see where, we turned on the JVM's own ledger — NativeMemoryTracking, which costs ~5-10% and requires a restart, so we ate one scheduled restart to get it:

```yaml
env:
  - name: JAVA_TOOL_OPTIONS
    value: "-XX:NativeMemoryTracking=summary"
```

Then, sampling over several hours via jattach (our images carry it now — see [the previous heap-dump saga](/blog/the-heap-dump-with-no-jdk/)):

```console
$ kubectl exec stream-ingest-0 -- /opt/tools/jattach 1 jcmd "VM.native_memory summary"
```

```text
Total: reserved=4805MB, committed=2761MB
-  Java Heap  reserved=2048MB, committed=2048MB
-  Class      reserved=1090MB, committed=418MB     ← growing
-  Thread     reserved=517MB,  committed=517MB     ← 512 threads?!
-  Internal   reserved=61MB,   committed=61MB
-  Other      reserved=402MB,  committed=402MB     ← direct buffers live here
...
```

Three culprits, none visible in an hprof's retained-size view.

## Culprit 1: Netty direct buffers (~400MB, spiky)

Our Kafka and HTTP layers both sat on Netty, and Netty pools **direct ByteBuffers** — off-heap memory allocated with the heap none the wiser. By default the direct memory cap follows `-Xmx`, so our "2GB heap" tacitly authorized up to another 2GB off-heap. Under a consumer-rebalance burst, the pool ballooned; pooled buffers don't shrink back eagerly. NMT's `Other` plus `-Dio.netty.maxDirectMemory` metrics confirmed it. We capped it explicitly (`-XX:MaxDirectMemorySize=512m`) and surfaced Netty's `PooledByteBufAllocatorMetric` into Prometheus.

## Culprit 2: A classloader leak into metaspace (~400MB and climbing)

`Class` committed grew monotonically — the signature of a **classloader leak**. The service hot-reloaded parser "plugins" on config change, each load spinning up a fresh classloader. A static `ThreadLocal` in a shaded library pinned each old loader forever, so every config push permanently added ~15MB of metaspace. Heap dumps *can* catch this one if you know to look for duplicate classloaders rather than big objects — ours had 27 copies of `PluginClassLoader` sitting quietly below every dominator threshold. We fixed the pinning and set `-XX:MaxMetaspaceSize=384m` so the failure mode becomes a diagnosable `OutOfMemoryError: Metaspace` instead of a silent SIGKILL.

## Culprit 3: An unbounded thread pool (~500MB, step function)

`Thread committed=517MB` meant ~512 threads at 1MB of stack each. A retry path created its own executor via `newCachedThreadPool()` — unbounded — and slow-broker incidents earlier that month had each ratcheted the thread count up a step. Threads don't just cost stack, either; they're the multiplier on arena allocations elsewhere. `jattach 1 threaddump | grep -c 'retry-exec'` → 438. Bounded pool, done, and 400+MB came back.

## Right-sizing with an actual budget

The fix wasn't "raise the limit until it stops dying" — that's how we got 3Gi in the first place. We wrote the footprint down as a budget and made the limit follow from it:

```text
heap (-Xmx)                     2048 MB
metaspace cap                    384 MB
direct buffers cap               512 MB
thread stacks (150 thr × 1MB)    150 MB
GC + code cache + JVM internals  250 MB
glibc/malloc arena slack         150 MB
                                -------
process budget                  3494 MB  → limit: 3.75Gi, request: 3.75Gi
```

Every line is now either capped by a flag or alarmed by a metric, so the budget is enforceable rather than aspirational. (We also set request == limit for Guaranteed QoS — this service is not one we want the scheduler improvising around; see [resources and QoS](/workloads/resources-and-qos/).) The general method, including the container-awareness flags and what `MaxRAMPercentage` does and doesn't cover, is in [the JVM in containers](/java/jvm-in-containers/).

Worth a paragraph of honesty about `MaxRAMPercentage`, because it's often sold as the fix for exactly our situation: `-XX:MaxRAMPercentage=75.0` sizes the *heap* from the container limit, which is convenient — but it doesn't cap direct memory, metaspace, or threads any more than `-Xmx` does. If the other regions are unbounded, a percentage-sized heap just changes which number you exceed the limit by. The budget-then-caps approach is more typing and strictly more honest.

One more diagnostic that earned a permanent place in the runbook — comparing the kernel's view against NMT's, from inside the pod:

```console
$ kubectl exec stream-ingest-0 -- sh -c \
    'grep -E "^(Rss|Pss)" /proc/1/smaps_rollup'
Rss:             2988012 kB
Pss:             2985464 kB
```

If RSS meaningfully exceeds NMT's committed total, the growth is *outside* the JVM's ledger — malloc arenas (glibc's per-thread arenas are a classic; `MALLOC_ARENA_MAX=2` tamed ours), mmap'd files, or a leaky native library. Ours matched within ~200MB, which is what let us trust the NMT numbers and stop looking for a fourth culprit.

:::note
If you take one command from this post: `jcmd <pid> VM.native_memory summary` (via jattach on minimal images) after starting with `-XX:NativeMemoryTracking=summary`. It's the only view where the JVM itemizes what the OOM killer is actually counting. For everything the kernel sees beyond even that — mmap'd files, malloc arenas — `cat /proc/1/smaps_rollup` inside the pod is the ground truth.
:::

## What we changed

- **The mental model, first: `-Xmx` is a floor on your footprint, not a ceiling.** A JVM with a 2GB heap is a 3GB+ process. Our [OOMKilled runbook](/troubleshooting/oomkilled/) now branches immediately on "is the *heap* actually full?" — because exit 137 with a healthy heap is a native-memory hunt, and heap dumps will eat your whole afternoon telling you nothing.
- **Every off-heap region gets an explicit cap:** `MaxDirectMemorySize`, `MaxMetaspaceSize`, bounded executors everywhere (build-time lint for `newCachedThreadPool`). Uncapped regions don't fail loudly; they get you SIGKILLed with no stack trace.
- **NMT stays on in production.** The overhead is noise; flying blind is not. Baseline + periodic `VM.native_memory summary.diff` scraped into metrics gives us native growth curves per region.
- **Memory limits are derived from a written budget in the repo**, reviewed when flags change, instead of "last OOM + 50%".
- **We alert on `container_memory_working_set_bytes` at 90% of limit** — the kernel's count, not the JVM's — so the next mismatch between what Java thinks and what the cgroup knows pages us *before* the kill.

The heap was fine. That was the whole problem — we trusted the one gauge on the dashboard and the truck had eleven other tanks.
