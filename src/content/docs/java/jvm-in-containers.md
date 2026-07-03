---
title: The JVM in Containers
description: How the JVM reads cgroup limits to size its heap and thread pools, and how to set container requests and limits that a JVM can actually live inside.
sidebar:
  order: 2
---

A JVM in a pod does not see the node. It sees a cgroup: a memory limit, a CPU
quota, and a filesystem. Modern JVMs read those limits and size themselves
accordingly — mostly. The gap between "mostly" and "always" is where OOMKills
and mystery throttling live.

:::tip[Looking for the dials?]
This article explains how the JVM sees the container; the flag-by-flag reference — heap percentages, Metaspace, direct memory, the RSS budget formula, ready-made flag strings — lives in [JVM Memory Knobs](/tuning/jvm-memory-knobs/).
:::

## Container awareness: what the JVM detects

Since JDK 10 (backported to 8u191), HotSpot has `-XX:+UseContainerSupport`,
**on by default**. With it enabled, the JVM derives from the cgroup:

- **Available memory** — from the container's memory limit, not the node's
  RAM. Drives default heap size, and `Runtime.maxMemory()` ergonomics.
- **Available CPUs** — from the CPU quota (`limits.cpu`), rounded up. Drives
  `Runtime.availableProcessors()`, GC worker thread counts, the
  `ForkJoinPool.commonPool()` size, C2 compiler threads, and every library
  that sizes pools from `availableProcessors()` (Netty event loops, parallel
  streams, Kotlin coroutine dispatchers...).

Verify what your JVM actually concluded — this one command settles most
sizing arguments:

```bash
kubectl exec myapp-7d4b9c6f5d-x2klm -- java -XshowSettings:system -version 2>&1 | head -20
```

```console
Operating System Metrics:
    Provider: cgroupv2
    Effective CPU Count: 2
    CPU Period: 100000us
    CPU Quota: 200000us
    CPU Shares: 512us
    Memory Limit: 2.00G
    Memory Soft Limit: Unlimited
    ...
```

That output is available even on a jlink-minimized runtime — it's the `java`
launcher itself, no JDK tools required.

:::caution[cgroup v1 vs v2 — the silent trap]
Kubernetes nodes have been moving from cgroup v1 to cgroup v2 (default in
most distros since ~2022; v1 support is being removed from kubelet). The JVM
gained **cgroup v2** detection in JDK 15, backported to **11.0.16+** and
**8u372+**. An older JVM (say, 11.0.14) on a cgroup v2 node detects *no*
limits: it sees all of the node's RAM and CPUs, sizes a heap off 256 GB of
node memory, and gets OOMKilled at its 2 GiB container limit. If your pods
started dying after a node upgrade you didn't perform, check
`java -version` first and ask your platform team whether nodes moved to
cgroup v2. The fix is on your side: upgrade the base image.
:::

## How the heap gets sized

With no explicit flags, HotSpot picks a max heap using percentages of the
container memory limit:

- `-XX:MaxRAMPercentage=25.0` — default max heap = **25%** of the limit.
- `-XX:InitialRAMPercentage=1.5625` — initial heap.
- `-XX:MinRAMPercentage=50.0` — confusingly, this applies only to *small*
  memory sizes (≲256 MB), where the max heap becomes 50% of the limit.

So a container with `limits.memory: 4Gi` and no flags gets a ~1 GiB max heap.
That default is deliberately conservative and usually wastes money: you pay
for 4 GiB and use 1 for heap. For a typical single-JVM service container, set
it explicitly:

```yaml
env:
  - name: JAVA_TOOL_OPTIONS
    value: >-
      -XX:MaxRAMPercentage=75.0
      -XX:+ExitOnOutOfMemoryError
```

### MaxRAMPercentage vs -Xmx

- **`-Xmx2g`** — absolute. Predictable, but silently wrong the day someone
  changes the container limit and forgets the flag. A 2 GiB heap in a 2 GiB
  container is an OOMKill on a timer.
- **`-XX:MaxRAMPercentage=75.0`** — relative to the cgroup limit. Resize the
  container in one place and the heap follows. This is the right default for
  containers.

Percentage of *what*, exactly: the container **memory limit** (or the node's
memory if the container has no limit — one more reason JVM workloads should
always set `limits.memory`). And note it sizes only the *heap*. The other
25% is not slack; it's spoken for.

## Total JVM memory: heap is just the biggest tenant

The kernel OOM-kills the container based on total resident memory (RSS), and
the JVM's RSS is:

```text
heap
+ metaspace            (class metadata; unbounded by default — cap it if classloading is dynamic)
+ code cache           (JIT output, up to ~240 MB by default)
+ thread stacks        (~1 MB per thread × how many threads? 400 threads = 400 MB)
+ direct byte buffers  (NIO, Netty; defaults to roughly heap-sized cap unless -XX:MaxDirectMemorySize)
+ GC overhead          (G1 remembered sets etc., a few % of heap)
+ native allocations   (JNI libs, zlib, ZIP/JAR handling, glibc arena fragmentation)
```

A workable starting budget for a typical Spring-ish service: **heap = 60–75%
of the container limit**, leave 300 MB–1 GiB of headroom depending on thread
count and Netty usage. When the pod is running, compare the JVM's view with
the cgroup's:

```bash
# What the kernel will judge you on (cgroup v2):
kubectl exec myapp-7d4b9c6f5d-x2klm -- cat /sys/fs/cgroup/memory.current
# vs the limit:
kubectl exec myapp-7d4b9c6f5d-x2klm -- cat /sys/fs/cgroup/memory.max
```

If `memory.current` keeps creeping toward `memory.max` while heap usage (from
your metrics) is flat, you have a native/metaspace/thread problem, not a heap
problem — see [Memory leaks and OOM](/java/memory-leaks-and-oom/) for the triage
tree, and turn on `-XX:NativeMemoryTracking=summary` for the breakdown.

## CPU: quota, shares, and surprising thread counts

`Runtime.availableProcessors()` in a container comes from, in order:

1. `-XX:ActiveProcessorCount=N` if set — an explicit override, highest
   precedence, and your escape hatch.
2. The CPU quota (`limits.cpu`), rounded **up**: `limits.cpu: 1500m` → 2
   processors.
3. If there's no quota: historically CPU *shares* (`requests.cpu`) were used,
   which produced absurd results (`requests.cpu: 250m` → 1 processor on a
   64-core node). JDK 19+ (backported to 11.0.17+/17.0.5+) ignores shares by
   default and reports the host CPU count when no limit is set.

Why you care:

- **GC threads** are sized from the processor count. 1 effective CPU can push
  the JVM into Serial GC ergonomics; 2 CPUs gets you G1 with minimal
  parallelism.
- **`ForkJoinPool.commonPool()`** gets `availableProcessors() - 1` workers —
  on a 1-CPU container that's **zero** dedicated workers (work runs on the
  submitting thread), which makes `parallelStream()` and
  `CompletableFuture` defaults behave very differently than on your laptop.
- Libraries cache the value at startup. Changing limits requires a restart to
  take effect in most pools.

A pattern that works well for latency-sensitive JVMs: set `requests.cpu` to
what you truly need, set **no CPU limit** (if your platform team's policy
allows it — many enforce limits via admission control), and pin
`-XX:ActiveProcessorCount` to a sane number so the JVM doesn't size 64 GC
threads on a big node. If CPU limits are mandatory, watch for throttling —
it routinely masquerades as GC trouble, covered in
[GC and performance](/java/gc-and-performance/).

## Sizing requests and limits for a JVM

General request/limit mechanics and QoS classes are covered in
[Resources and QoS](/workloads/resources-and-qos/); the JVM-specific
rules of thumb:

| Setting | Recommendation | Why |
|---|---|---|
| `limits.memory` | Always set; equal to `requests.memory` | JVMs don't give memory back gracefully; Guaranteed-QoS memory avoids eviction surprises |
| `requests.memory` | (heap ÷ 0.7) roughly | Leaves the non-heap budget |
| Heap | `MaxRAMPercentage=65–75` | Relative sizing survives limit changes |
| `requests.cpu` | Sized for steady state, ≥ 1 CPU for anything latency-sensitive | GC parallelism, JIT warmup |
| `limits.cpu` | Omit if policy allows; otherwise ≥ 2× requests | JVM startup (JIT, classloading) is a CPU spike; throttling startup slows readiness |
| `ActiveProcessorCount` | Set explicitly when using shares-only / no-limit | Deterministic pool sizes |

:::tip[Startup CPU is not steady-state CPU]
A JVM that needs 500m at steady state can happily burn 3 CPUs for 40 seconds
at startup (classloading + JIT). With `limits.cpu: 500m` that startup takes
minutes, readiness probes time out, and you conclude the app is broken. If
you must have limits, consider a startup probe with generous
`failureThreshold` — see [Health checks](/workloads/health-checks/).
:::

## Quick reference: flags that matter in containers

```text
-XX:+UseContainerSupport         # default on; -XX:-UseContainerSupport to diagnose detection issues
-XX:MaxRAMPercentage=75.0        # heap as % of container limit
-XX:ActiveProcessorCount=4       # override detected CPU count
-XX:MaxMetaspaceSize=256m        # cap metaspace if classloading is dynamic
-XX:MaxDirectMemorySize=256m     # cap NIO direct buffers explicitly
-XX:+ExitOnOutOfMemoryError      # die fast and let Kubernetes restart you — usually right for pods
-XX:+HeapDumpOnOutOfMemoryError  # free evidence; see the heap dumps article
-Xlog:gc*                        # GC logging to stdout; see GC and performance
```

Deliver these via `JAVA_TOOL_OPTIONS` in the Deployment env (any JVM reads
that variable and echoes `Picked up JAVA_TOOL_OPTIONS: ...` to stderr at
startup — check `kubectl logs` to confirm they took effect).

:::note[Running Spring Boot?]
The framework-level wiring on top of all this — Actuator-backed probes,
graceful shutdown, and a reference Deployment — is covered in
[Spring Boot on Kubernetes](/java/spring-boot/).
:::
