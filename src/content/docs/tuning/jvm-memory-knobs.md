---
title: "JVM Memory Knobs"
description: Every JVM memory flag that matters in a container — heap, metaspace, code cache, stacks, direct memory — with the RSS budget math and copy-paste recipes.
sidebar:
  order: 7
---

The JVM has one memory number everyone tunes (`-Xmx`) and half a dozen it
spends behind your back. In Kubernetes, the container limit is a hard wall:
the moment total RSS crosses it, the kernel OOM-kills the process — no
`OutOfMemoryError`, no heap dump, exit code 137. Mechanically: the limit is
the container cgroup's `memory.max`; when an allocation can't be charged
under it and the kernel can't reclaim enough page cache to make room, the
[cgroup-scoped OOM killer](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory)
picks a victim inside the container and delivers
[SIGKILL](https://man7.org/linux/man-pages/man7/signal.7.html) — a signal
that cannot be caught or handled, which is why no shutdown hook, no
`-XX:+HeapDumpOnOutOfMemoryError`, and no graceful anything ever runs
(137 = 128 + 9, the SIGKILL signal number). So every knob on this page is
really a line item in one budget:

```text
container_limit ≥ heap + metaspace + code cache + (threads × stack)
                  + direct memory + GC overhead + safety margin
```

Concepts and diagnosis live in [JVM in Containers](/java/jvm-in-containers/)
and [OOMKilled](/troubleshooting/oomkilled/). This page is the dials.

## How to set flags in Kubernetes

You usually don't own the `Dockerfile` `ENTRYPOINT`, so environment
variables are the practical delivery mechanism (see
[Environment Variables](/workloads/environment-variables/) for the
injection patterns):

| Mechanism | Picked up by | Notes |
|---|---|---|
| `JAVA_TOOL_OPTIONS` | **Every** JVM launch — `java`, embedded JVMs, agents, tools | The workhorse. Prints `Picked up JAVA_TOOL_OPTIONS:` to stderr at startup — a free audit trail. Visible in `ps e` and `kubectl describe pod` |
| `JDK_JAVA_OPTIONS` | The `java` launcher only, JDK 9+ | Won't reach JVMs started via JNI or wrapper binaries; can also inject non-`-X` args (e.g. `--add-opens`) |
| Command args in `args:` | That one process | Highest precedence; requires owning the pod spec's command line |

Precedence when combined: `JAVA_TOOL_OPTIONS` is read first,
`JDK_JAVA_OPTIONS` second, explicit command-line arguments last — and for
the same flag, **last one wins**. So a `-Xmx` baked into the image's
command line silently overrides the `-XX:MaxRAMPercentage` you set via env.

Always verify what actually took effect, from inside the pod:

```bash
# Final computed values after ergonomics + all your flags
kubectl exec myapp-7d4b9c6f5d-x2klm -- \
  java -XX:+PrintFlagsFinal -version 2>/dev/null | \
  grep -Ei 'maxheapsize|maxram|metaspace|codecache|threadstack'

# Against the *running* process (jcmd ships in JDK images, not JRE-only)
kubectl exec myapp-7d4b9c6f5d-x2klm -- jcmd 1 VM.flags
```

:::caution
`java -XX:+PrintFlagsFinal -version` starts a *new* JVM. It shows what a
JVM launched right now with the current env would get — which is what you
want for checking ergonomics, but it is not proof of what PID 1 is running
with. For that you need `jcmd` (JDK images) or the startup
`Picked up JAVA_TOOL_OPTIONS` log line.
:::

## The heap knobs

| Knob | Default | What it actually does | When to turn it | Watch after |
|---|---|---|---|---|
| `-Xmx<size>` | Ergonomics (see `MaxRAMPercentage`) | Hard ceiling on heap. Exceed it → `OutOfMemoryError`, not OOMKill | When you want an absolute number decoupled from the container limit | Heap usage %, full-GC frequency |
| `-Xms<size>` | Ergonomics (~1.5% of RAM) | Initial committed heap. Below `-Xmx`, the heap grows on demand | **Set `-Xms` = `-Xmx` in containers** (see below) | RSS at startup jumps — that's the point |
| `-XX:MaxRAMPercentage=<n>` | **25.0** | Max heap as % of the container memory *limit* | Almost always — 25% default means a 4Gi container runs a 1Gi heap. The silent under-use classic | `MaxHeapSize` in `PrintFlagsFinal` |
| `-XX:InitialRAMPercentage=<n>` | 1.5625 | Initial heap as % of limit — the percentage twin of `-Xms` | Set equal to `MaxRAMPercentage` for the same no-growth reasons | Committed heap == max from startup |
| `-XX:MinRAMPercentage=<n>` | 50.0 | **Not** a minimum heap. Only used to compute max heap on *tiny* containers (≲250MiB) | Rarely; only when tuning sub-256Mi sidecars | Mostly: stop expecting it to do anything |
| `-XX:MaxRAM=<size>` | Detected from cgroup | Overrides what the JVM believes "physical memory" is; percentages compute from this | Escape hatch when cgroup detection is wrong or you want percentages of a different base | `PrintFlagsFinal` → `MaxRAM` |
| `-XX:SoftMaxHeapSize=<size>` | = max heap | Soft target the GC tries to stay under, uncommitting above it (ZGC; manageable at runtime) | Cache-heavy ZGC services: cap normal footprint while allowing spikes to `-Xmx` | RSS settles near the soft max |
| `-XX:+UseContainerSupport` | **On** since 8u191 / JDK 10 | Makes the JVM read cgroup limits instead of node RAM | Never turn off. But know when it *silently fails*: cgroup **v2** needs 8u372+ / 11.0.16+ / 15+ | A 25% heap of the 64Gi *node* is the failure signature |

:::note[Under the hood: what "container support" actually reads]
Container awareness is nothing more magical than the JVM parsing the container's cgroup interface files at startup: on cgroup v2, `/sys/fs/cgroup/memory.max` for the memory limit and `/sys/fs/cgroup/cpu.max` for the CPU quota/period pair (on legacy v1, `memory.limit_in_bytes` and `cpu.cfs_quota_us` / `cpu.cfs_period_us`) — the same files the kubelet writes your `resources` block into, documented in the [cgroup v2 admin guide](https://docs.kernel.org/admin-guide/cgroup-v2.html). `MaxRAMPercentage` is computed against that `memory.max` value; the default `ActiveProcessorCount` (and with it GC and JIT thread counts) comes from `cpu.max`. The silent-failure mode in the table row above is exactly this read going wrong: a JDK that predates cgroup v2 parsing finds no v1 files on a v2 node, falls back to `/proc/meminfo`, and cheerfully sizes a 25% heap off 64Gi of node RAM.
:::

### Why Xms = Xmx (and AlwaysPreTouch)

On bare metal, growing the heap lazily saves memory for other processes.
In a container there *are* no other processes worth saving it for — the
limit is reserved for you whether you commit it or not. Setting
`-Xms` = `-Xmx` (or `Initial` = `Max` RAMPercentage) buys you:

- **No growth stalls** — heap expansion is a stop-the-world-ish operation
  you otherwise pay at peak traffic, exactly when you can least afford it.
- **Honest RSS from day one** — working_set at hour 1 looks like
  working_set at day 30, so your dashboards and limit sizing mean something.
- Pair with `-XX:+AlwaysPreTouch` to fault every heap page in at startup:
  slower boot (seconds on big heaps), zero page-fault latency later, and
  RSS that tells the truth immediately.

### Percentage vs -Xmx: pick one

`MaxRAMPercentage` scales with the container limit: bump `resources.limits.memory`
from 2Gi to 3Gi in the manifest and the heap follows — one knob instead of
two that must be changed in lockstep (the manifest side of this trade is
[Requests & Limits Knobs](/tuning/requests-limits-knobs/)). Use absolute
`-Xmx` only when the heap genuinely shouldn't scale with the limit (e.g. a
fixed-size cache plus growing native usage).

:::danger
Setting **both** `-Xmx` and `-XX:MaxRAMPercentage` is a classic confusion
generator: `-Xmx` wins and the percentage is silently ignored. Whoever
later "tunes" the percentage changes nothing and concludes the flag is
broken.
:::

## The non-heap knobs — the RSS budget everyone forgets

Heap is the *floor* of JVM memory use, not the total. These are the line
items that turn a "1.5Gi heap in a 2Gi container, should be fine" into an
OOMKill.

| Knob | Default | What it actually does | When to turn it | Watch after |
|---|---|---|---|---|
| `-XX:MaxMetaspaceSize=<size>` | **Unlimited** | Caps class-metadata memory. Uncapped, a classloader leak eats native memory until the *kernel* kills you | Cap it (128–512Mi for most apps) so a metaspace leak dies as a diagnosable `OutOfMemoryError: Metaspace` instead of an OOMKill — see [Memory Leaks & OOM](/java/memory-leaks-and-oom/) | `jcmd 1 GC.heap_info` / NMT `Class` line |
| `-XX:CompressedClassSpaceSize=<size>` | 1G *reserved* | Part of metaspace for compressed class pointers. Reserved ≠ committed — usually not an RSS problem, but caps class count | Shrink only under severe address-space pressure; raise if you hit `Compressed class space` OOM | NMT `Class space` committed |
| `-XX:ReservedCodeCacheSize=<size>` | 240M (tiered compilation) | JIT-compiled code storage. Reserved up front, committed as code compiles; real usage often 60–150Mi | Trim to 128M on small containers; never so low that the JIT stops compiling (throughput cliff) | `jcmd 1 Compiler.codecache`; warn log `CodeCache is full` |
| `-XX:MaxDirectMemorySize=<size>` | **≈ `-Xmx`** | Cap on `ByteBuffer.allocateDirect` off-heap memory. Defaulting to heap size means your worst case is *2×* heap | Any Netty/NIO/gRPC/Kafka-client app: set it explicitly (often 64–512Mi) and budget it | NMT `Other`/`Internal`; Netty `PlatformDependent` metrics |
| `-Xss<size>` / `-XX:ThreadStackSize` | 1M (64-bit Linux) | Stack *reserved* per thread; committed as used. 300 threads × 1MiB = 300Mi of budget | Thread-pool-heavy apps: count your threads first (`jcmd 1 Thread.print \| grep -c tid`); 512k is often safe | `StackOverflowError` in deep stacks (JSON mappers, recursion) |
| `-XX:NativeMemoryTracking=summary` | off | The **measurement** knob: makes `jcmd 1 VM.native_memory summary` itemize every category above | Turn on when building your budget; costs ~5–10% CPU and a bit of memory, so not a permanent prod default | The whole budget, itemized |
| `MALLOC_ARENA_MAX=2` (env var) | glibc: 8 × CPUs | glibc creates up to `8 × cores` independent malloc arenas to cut lock contention between threads — the `M_ARENA_MAX` knob in [mallopt(3)](https://man7.org/linux/man-pages/man3/mallopt.3.html). Each arena holds its own free lists, so on many-core nodes freed memory fragments across dozens of arenas into hundreds of MiB of RSS that's *allocator overhead*, not leak — and note the arena count follows the *node's* core count, not your CPU limit | Any glibc-based image with mysterious slow RSS growth; Alpine/musl images don't need it | RSS growth curve flattens |

```bash
# The itemized bill, once NMT is enabled (needs jcmd — JDK image or sidecar)
kubectl exec myapp-7d4b9c6f5d-x2klm -- jcmd 1 VM.native_memory summary
```

On JRE-only images with no `jcmd`, you're budgeting from the outside:
`container_memory_working_set_bytes` minus heap (from GC logs) is your
native total — the workflow in [OOMKilled](/troubleshooting/oomkilled/).

## The RSS budget, worked

The centerpiece. For a typical Spring web service at a **2Gi limit**:

| Line item | Flag that controls it | Budget |
|---|---|---|
| Heap | `MaxRAMPercentage=62.5` → 1280Mi | 1280Mi |
| Metaspace (Spring + libs ≈ 120–160Mi) | `MaxMetaspaceSize=192m` | 192Mi |
| Code cache (real usage, capped) | `ReservedCodeCacheSize=128m` | 128Mi |
| Thread stacks (≈150 threads × 1MiB) | `-Xss1m`, pool sizing | 150Mi |
| Direct memory (Tomcat/Netty buffers) | `MaxDirectMemorySize=64m` | 64Mi |
| GC structures (G1: ~4–8% of heap) | collector choice | 80Mi |
| JVM internals, symbols, glibc arenas | `MALLOC_ARENA_MAX=2` | 50Mi |
| **Safety margin** | — | **104Mi** |
| **Total** | | **2048Mi** |

That's where the **60–75% rule of thumb** for `MaxRAMPercentage` comes
from: the non-heap lines are roughly fixed-ish, so on a 2Gi container they
leave ~62% for heap; on 8Gi they shrink relatively and 75% is safe. The
rule is **wrong** when: containers are tiny (512Mi → non-heap dominates,
use 40–50%), the app is direct-memory-heavy (Kafka, Netty proxies — budget
direct like a second heap), or thread counts are large and unbounded.

Validate against reality, not the spreadsheet: watch
`container_memory_working_set_bytes` — cgroup memory usage minus the
reclaimable `inactive_file` page cache, i.e. the memory the kernel *can't*
just free when the container hits `memory.max`, and therefore the number
that tracks real OOM risk. Heap is only one tenant of it. Watch it
for a full day/traffic cycle. Queries in
[PromQL for Resources](/observability/promql-for-resources/); what it
looks like when you got it wrong in [OOMKilled](/troubleshooting/oomkilled/).

## GC selection as a memory knob

Deep GC tuning is [GC and Performance](/java/gc-and-performance/); here is
only the memory angle:

| Knob | Default | Memory effect |
|---|---|---|
| `-XX:+UseSerialGC` | Auto on <2 CPUs / <~1.8Gi | Lowest overhead (~1–2% of heap in GC structures). Right answer for 512Mi sidecars — often what ergonomics picks anyway |
| `-XX:+UseG1GC` | Default (≥2 CPUs, ≥~1.8Gi) | ~4–8% of heap in remembered sets and bookkeeping. Budget it |
| `-XX:+UseZGC` | off | Highest bookkeeping overhead (colored pointers, forwarding tables — up to ~10–15%+ on small heaps); shines on big heaps where it uncommits aggressively |
| `-XX:ActiveProcessorCount=<n>` | From cgroup CPU limit | Sets GC (and JIT) thread counts. A pod with no CPU limit on a 64-core node gets 64-core GC threading — memory *and* CPU surprise |
| `-XX:G1PeriodicGCInterval=<ms>` | 0 (off) | Makes an **idle** G1 service run periodic GC and return uncommitted heap to the OS. The answer to "why does my idle service hold 1.5Gi RSS forever" |
| `-XX:ZUncommit` + `ZUncommitDelay=<s>` | on, 300s | ZGC's give-back mechanism; pairs with `SoftMaxHeapSize` |

Giving memory back only matters if something reclaims it — with
`Xms`=`Xmx` you've deliberately opted *out* of give-back for latency. Pick
per service: latency-critical → pre-touch and hold; bursty/idle-mostly →
smaller `Xms` plus periodic GC/uncommit.

## The safety nets

Set these on **every** production JVM. They cost nothing until the day
they're the only evidence you have.

| Knob | Default | What it actually does | Notes |
|---|---|---|---|
| `-XX:+HeapDumpOnOutOfMemoryError` | off | Writes `.hprof` on heap `OutOfMemoryError` | Free until it fires |
| `-XX:HeapDumpPath=/dumps` | cwd | Where the dump lands | **Point at a volume** (emptyDir at minimum) or the dump dies with the container — retrieval on JRE-only images in [Heap Dumps, JRE-only](/java/heap-dumps-jre-only/) |
| `-XX:+ExitOnOutOfMemoryError` | off | JVM exits immediately on first OOME | **The k8s-correct default**: die-and-restart beats a zombie pod that's alive for probes but broken for work |
| `-XX:+CrashOnOutOfMemoryError` | off | Like Exit, but produces `hs_err` + core dump | Choose *instead of* Exit when you need native-level evidence; cores need node-level config |
| `-XX:OnOutOfMemoryError="cmd"` | none | Runs a command on OOME | Niche on distroless (no shell). Prefer the flags above |
| `-Xlog:gc*:stdout:time,uptime,level,tags` | off | Unified GC logging to stdout → pod logs | Your heap-usage history for the budget math; negligible overhead |
| `-XX:StartFlightRecording=maxsize=100m,maxage=24h,disk=true,dumponexit=true,filename=/dumps/app.jfr` | off | Always-on JFR ring buffer, ~1% overhead | Continuous profiling on JRE-only images — see [Java Observability](/java/java-observability/) |

## Recipes

Complete `JAVA_TOOL_OPTIONS` strings with the matching resources block.
Requests = limits for memory (JVMs don't share nicely under memory
pressure) — rationale in [Requests & Limits Knobs](/tuning/requests-limits-knobs/).

### Small sidecar-ish service — 512Mi

Non-heap dominates at this size: heap gets only ~50%.

```yaml
env:
  - name: MALLOC_ARENA_MAX
    value: "2"                             # glibc arena fragmentation cap
  - name: JAVA_TOOL_OPTIONS
    value: >-
      -XX:MaxRAMPercentage=50 -XX:InitialRAMPercentage=50
      -XX:MaxMetaspaceSize=96m
      -XX:ReservedCodeCacheSize=64m
      -XX:MaxDirectMemorySize=32m
      -Xss512k
      -XX:+UseSerialGC
      -XX:+ExitOnOutOfMemoryError
      -Xlog:gc:stdout:time,uptime
resources:
  requests: { cpu: 100m, memory: 512Mi }
  limits:   { memory: 512Mi }              # no CPU limit; see requests-limits-knobs
```

Per-flag: 50% → 256Mi heap; SerialGC because ergonomics would pick it
anyway at this size and it has the smallest footprint; 512k stacks because
sidecars rarely have deep call stacks; heap-dump flags omitted only if
256Mi dumps have nowhere useful to go — add them if you have a volume.

### Standard web service — 2Gi (the worked budget above)

```yaml
env:
  - name: MALLOC_ARENA_MAX
    value: "2"
  - name: JAVA_TOOL_OPTIONS
    value: >-
      -XX:MaxRAMPercentage=62.5 -XX:InitialRAMPercentage=62.5
      -XX:+AlwaysPreTouch
      -XX:MaxMetaspaceSize=192m
      -XX:ReservedCodeCacheSize=128m
      -XX:MaxDirectMemorySize=64m
      -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/dumps
      -XX:+ExitOnOutOfMemoryError
      -Xlog:gc*:stdout:time,uptime,level,tags
      -XX:StartFlightRecording=maxsize=100m,maxage=24h,disk=true,dumponexit=true,filename=/dumps/app.jfr
resources:
  requests: { cpu: "1", memory: 2Gi }
  limits:   { memory: 2Gi }
```

Per-flag: 62.5% → 1280Mi heap per the budget table; G1 by default (2Gi,
≥2 CPUs); pre-touch for honest day-one RSS; `/dumps` is an emptyDir volume
mount; JFR ring buffer for after-the-fact incident forensics.

### Large cache-heavy service — 8Gi, ZGC

```yaml
env:
  - name: MALLOC_ARENA_MAX
    value: "2"
  - name: JAVA_TOOL_OPTIONS
    value: >-
      -XX:MaxRAMPercentage=75
      -XX:SoftMaxHeapSize=5g
      -XX:+UseZGC
      -XX:MaxMetaspaceSize=384m
      -XX:MaxDirectMemorySize=512m
      -XX:ActiveProcessorCount=4
      -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/dumps
      -XX:+ExitOnOutOfMemoryError
      -Xlog:gc*:stdout:time,uptime,level,tags
resources:
  requests: { cpu: "4", memory: 8Gi }
  limits:   { memory: 8Gi }
```

Per-flag: 75% → 6Gi max heap, but `SoftMaxHeapSize=5g` keeps steady-state
around 5Gi with `ZUncommit` (on by default) returning the rest; **no**
`InitialRAMPercentage`/pre-touch — this recipe wants give-back, not
pinning; `ActiveProcessorCount=4` pins GC threading to the request since
there's no CPU limit; ZGC bookkeeping is inside the 25% non-heap margin.

:::note
Heap dumps at 6Gi need somewhere to land and a way out of the pod — size
the volume and read [Heap Dumps, JRE-only](/java/heap-dumps-jre-only/)
*before* the incident.
:::

## Tuning workflow and anti-patterns

The loop: **change one flag → deploy → watch for a full traffic cycle**
(a day, usually). Watch two things: `container_memory_working_set_bytes`
vs limit ([PromQL for Resources](/observability/promql-for-resources/)),
and GC logs for pause times and heap-after-GC trend. Two flags at once
means you don't know which one did it. The end-to-end sizing method — from
first deploy to settled numbers — is the
[Sizing Walkthrough](/tuning/sizing-walkthrough/).

| Anti-pattern | Why it bites | Instead |
|---|---|---|
| `-Xmx` == container limit | Zero native budget: metaspace + stacks + code cache push RSS over → OOMKill, no dump, no OOME | Heap ≤ 75% of limit; do the budget table |
| `MaxRAMPercentage=90` (or more) | Same failure in percentage clothing; survives testing, dies at full thread count in prod | 60–75%, lower on small containers |
| Metaspace unlimited + hot-reload / dynamic classloading | Classloader leak grows native memory until the *kernel* kills you — undiagnosable exit 137 instead of `OOME: Metaspace` | Cap `MaxMetaspaceSize`; see [Memory Leaks & OOM](/java/memory-leaks-and-oom/) |
| Setting `-Xmx` **and** `MaxRAMPercentage` | `-Xmx` wins, percentage silently ignored; future tuning edits the dead flag | One or the other — grep the image entrypoint before adding env flags |
| Copying flags between JDK majors blindly | Defaults and flags move: cgroup v2 support, ZGC generational, removed/renamed `-XX` options (unknown flags abort startup) | Re-verify with `PrintFlagsFinal` after every base-image bump |
| Tuning heap while ignoring `working_set` | The OOM killer doesn't read GC logs; it reads cgroup accounting | Dashboard `working_set / limit` next to heap usage, always |

If a change makes things worse, revert first, theorize second — the flag
string in `JAVA_TOOL_OPTIONS` is one `kubectl rollout undo` away from the
last known-good state.
