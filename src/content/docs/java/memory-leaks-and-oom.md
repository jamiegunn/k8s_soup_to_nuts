---
title: Memory Leaks and OOM
description: Telling container OOMKills apart from java.lang.OutOfMemoryError, and the workflows for heap, metaspace, native, and thread leaks in Kubernetes pods.
keywords:
  - OOMKilled exit 137 vs OutOfMemoryError
  - java.lang.OutOfMemoryError Java heap space
  - OutOfMemoryError Metaspace
  - Direct buffer memory
  - unable to create native thread
  - GC overhead limit exceeded
  - NativeMemoryTracking VM.native_memory
  - classloader leak DevTools
  - MALLOC_ARENA_MAX glibc arena
  - Netty direct ByteBuffer leak
  - Inflater Deflater native leak
  - heap dump dominator tree MAT
sidebar:
  order: 9
---

"The Java service keeps OOMing" describes at least five different diseases
with five different treatments. The single most important move is the first
one: determine *which* out-of-memory you have. Teams burn days heap-dumping
a service whose heap was fine, because the kernel — not the JVM — was doing
the killing.

## Step zero: which OOM is it?

```bash
kubectl describe pod myapp-7d4b9c6f5d-x2klm | grep -A5 'Last State'
```

```console
Last State:     Terminated
  Reason:       OOMKilled
  Exit Code:    137
```

**`OOMKilled` / exit 137** — the *kernel* killed the container because total
RSS hit the cgroup memory limit. The JVM got SIGKILL: no stack trace, no
heap dump hook, no goodbye. The heap may have been perfectly healthy;
something *outside* the heap (or the heap plus everything else) outgrew the
container. Kubernetes-side mechanics of this are in
[OOMKilled](/troubleshooting/oomkilled/).

**`java.lang.OutOfMemoryError` in the logs** — the *JVM* ran out of one of
its own pools while the container was fine. The message names the pool, and
the pool names the workflow:

```bash
kubectl logs myapp-7d4b9c6f5d-x2klm --previous | grep -m3 OutOfMemoryError
```

| Message | Pool | Go to |
|---|---|---|
| `Java heap space` | Heap | Heap-leak workflow below |
| `GC overhead limit exceeded` | Heap (dying slowly) | Same |
| `Metaspace` | Class metadata | Metaspace section |
| `Direct buffer memory` | NIO direct buffers | Native section |
| `unable to create native thread` | Threads / process limits | Thread section |

They can compound: a JVM with a too-big `-Xmx` will often get OOMKilled
*before* it ever throws `Java heap space`. Rule of interpretation: exit 137
with no `OutOfMemoryError` in `--previous` logs = size the container/native
side; `OutOfMemoryError` present = fix the named pool.

## The triage tree

```text
Pod restarting with memory symptoms
├─ Exit 137 / OOMKilled (kernel)
│  ├─ Heap usage (metrics/GC log) also near max?
│  │  └─ Heap simply too big for container → rebalance (Xmx vs limit), or a heap leak
│  │     dragged RSS up → treat as heap leak
│  └─ Heap flat and modest, RSS climbing anyway?
│     └─ Native / metaspace / threads / direct buffers → NMT workflow
└─ java.lang.OutOfMemoryError (JVM)
   └─ Message names the pool → matching workflow below
```

## Heap leaks: histogram → dump → dominator tree

The disciplined workflow — cheap evidence first:

**1. Confirm the shape.** Post-GC heap baseline over days (GC log `->`
values, or Micrometer `jvm_memory_used_bytes{area="heap"}` after GC). A
sawtooth with a *rising floor* is a leak; a sawtooth with a flat floor
that OOMs under burst load is undersizing. See
[GC and performance](/java/gc-and-performance/) for reading those.

**2. Histograms over time.** Cheap (brief pause, kilobytes of text), works
JRE-only via jattach:

```bash
for i in 1 2 3; do
  kubectl exec $POD -- /usr/local/bin/jattach 7 jcmd GC.class_histogram > histo-$i.txt
  sleep 600
done
# Which classes only ever grow?
diff <(awk '{print $4, $2}' histo-1.txt) <(awk '{print $4, $2}' histo-3.txt) | grep '^>' | sort -k2 -rn | head
```

If `com.example.SessionCacheEntry` went 40k → 400k → 4M, you may not even
need the dump.

**3. Heap dump + MAT.** Capture with any route from
[Heap dumps](/java/heap-dumps-jre-only/) — ideally the automatic
`HeapDumpOnOutOfMemoryError` artifact, which catches the heap at its worst.
In Eclipse MAT: Leak Suspects first, then the **dominator tree** for
retained sizes, then **path to GC roots** (exclude weak/soft) on the top
suspect to find the reference that should have been dropped. Two dumps taken
an hour apart and MAT's *compare* feature turn "big" into "growing", which
is the fact that matters.

Usual suspects: unbounded caches (`Map` as cache with no eviction), listener
registration without deregistration, `ThreadLocal` in pooled threads,
per-request objects captured by a long-lived lambda.

## Metaspace leaks: the classloader disease

`OutOfMemoryError: Metaspace` almost always means **classloaders that can't
be collected** — each retained loader pins every class it loaded. Seen with:
hot-reload frameworks (Spring Boot DevTools *in a production image* — check
for this first, it's embarrassingly common), dynamic proxy/bytecode
generation gone wild (some scripting engines, serialization libs generating
classes per type), redeploy-in-place app servers, Groovy/JRuby evaluating
scripts into fresh loaders.

Evidence, JRE-only:

```bash
kubectl exec $POD -- /usr/local/bin/jattach 7 jcmd VM.classloader_stats | sort -k4 -rn | head
kubectl exec $POD -- /usr/local/bin/jattach 7 jcmd GC.class_histogram | grep -c 'GeneratedSerializer'
```

Watch `jvm_classes_loaded` in metrics: monotonic growth long after warmup is
the tell. Fix the generator or cache the generated classes; as a tourniquet,
cap it (`-XX:MaxMetaspaceSize=512m`) so it fails as a clean
`OutOfMemoryError` instead of an OOMKill, and note that recurring
`Metadata GC Threshold` full GCs are the early-warning version.

## Native memory: the heap looks innocent because it is

RSS climbs, heap metrics are flat, exit code 137. Turn on Native Memory
Tracking (flag change + restart; ~5% overhead, fine temporarily):

```text
-XX:NativeMemoryTracking=summary
```

```bash
kubectl exec $POD -- /usr/local/bin/jattach 7 jcmd "VM.native_memory summary"
```

```console
Total: reserved=5812345KB, committed=3456789KB
-                 Java Heap (reserved=2097152KB, committed=2097152KB)
-                     Class (reserved=1090123KB, committed=98123KB)
-                    Thread (reserved=412345KB, committed=412345KB)
-                      Code (reserved=253440KB, committed=182340KB)
-                  Internal (reserved=612345KB, committed=612345KB)
-                     Other (reserved=891234KB, committed=891234KB)
```

Read the committed column; whichever category is outsized names the culprit.
Caveats: NMT tracks *JVM* allocations — `Other` includes direct
ByteBuffers, but memory malloc'd by JNI libraries (native compression,
crypto, image codecs) is invisible to it. If RSS ≫ NMT total, suspect JNI
or glibc arena fragmentation (try `MALLOC_ARENA_MAX=2` as an experiment —
env var, no image change).

Frequent native offenders:

- **Direct ByteBuffers** — Netty, gRPC, NIO. Uncapped by default (roughly
  heap-sized). Set `-XX:MaxDirectMemorySize`, watch Micrometer's
  `jvm_buffer_memory_used_bytes{id="direct"}`. Netty's pooled allocator
  holds on to peak usage by design — spiky traffic ratchets it up.
- **Zip/Inflater leaks** — `java.util.zip.Inflater`/`Deflater` not
  `end()`ed allocate native buffers freed only at finalization; heavy
  compression paths leak native memory that no heap tool will ever show.
- **Anything JNI** — profiling agents included.

## Thread leaks

`OutOfMemoryError: unable to create native thread` — or a slow RSS climb at
~1 MB per thread (default stack). Count and name them, no JDK needed:

```bash
kubectl exec $POD -- sh -c 'ls /proc/7/task | wc -l'
kubectl exec $POD -- kill -3 7 && kubectl logs $POD --since=30s | grep '^"' | sed 's/-[0-9]*"/-N"/' | sort | uniq -c | sort -rn | head
```

Four thousand `pool-N-thread-N` entries means someone creates an
`ExecutorService` per request and never shuts it down — the
[thread dump](/java/thread-dumps-jre-only/) shows the pool name, and the code
that builds it is one grep away. Note the pod's pid limit (kubelet
`podPidsLimit`) can also produce this error with modest thread counts — if
the numbers don't add up, ask your platform team what the pid limit is.

## The classic: "-Xmx fits, container still dies"

`-Xmx3g` in a `limits.memory: 3Gi` container is not a mystery; it's
arithmetic. The heap is only one tenant of RSS — metaspace, code cache,
thread stacks, direct buffers, GC bookkeeping, and the allocator's overhead
all live *outside* `-Xmx` (the full budget is itemized in
[JVM in containers](/java/jvm-in-containers/)). A JVM given a 3 GiB heap will
eventually *use* 3 GiB of heap (GC has no reason to hurry below `-Xmx`), and
RSS lands at 3.4–4 GiB. Kernel: 137.

The heap-to-limit ratios and the full RSS budget are
[JVM Memory Knobs](/tuning/jvm-memory-knobs/) territory. If you're sized
sanely and still getting OOMKilled with a flat heap, that's the native
workflow above, not a reason to shrink the heap blindly — measure with NMT,
then size.

:::tip[Leaks appear in every replica — use that]
You rarely need to risk the struggling pod. Run histograms and NMT against a
*healthy* replica of the same Deployment: same leak, earlier stage, no
pressure. And since dumps and NMT snapshots are per-pod, capturing from two
replicas at different uptimes gives you the time-series a single pod can't.
:::
