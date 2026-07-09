---
title: "The JVM–Kubernetes Coupling Map"
description: "Every point where the JVM and Kubernetes are wired together — twelve couplings, the failure mode when each one is misaligned, and the rule that keeps them in agreement."
keywords:
  - restart spiral CrashLoopBackOff throttling
  - SIGTERM shutdown hooks exec form ENTRYPOINT
  - JIT warmup cold start
  - networkaddress.cache.ttl DNS caching
  - HikariCP maxLifetime stale connection
  - thread stacks invisible OOMKilled
  - virtual threads Loom
  - CDS AppCDS GraalVM CRaC
  - exit code 137 vs OutOfMemoryError
  - terminationGracePeriodSeconds
  - liveness probe timeoutSeconds GC pause
sidebar:
  order: 12
---

The JVM and Kubernetes were designed a decade apart, for different problems —
yet in a pod they are welded together at a dozen precise points. The JVM
reads the cgroup; the kubelet probes the JVM; the kernel kills what the
garbage collector was about to save. Almost every production incident in a
Java-on-Kubernetes fleet is one of these welds failing: two systems, each
behaving exactly as documented, disagreeing about a number.

This article is the map. Each coupling point follows the same shape: how the
Kubernetes side works, how the JVM side reacts, what breaks when they
disagree, the rule that keeps them aligned, and a pointer to the deep
article. At the end: the whole map compressed into a one-page checklist.

## Resource couplings: the cgroup is the contract

### 1. Memory limit ↔ heap ergonomics

**Kubernetes side.** `resources.limits.memory` becomes `memory.max` in the
pod's cgroup. Exceed it and the kernel's OOM killer sends SIGKILL — no
appeal, no stack trace, exit code 137.

**JVM side.** A container-aware JVM reads `memory.max` **once, at startup**,
and sizes its default heap from it — the ergonomics, the defaults, and the
heap-vs-non-heap split are the story of
[The JVM in Containers](/java/jvm-in-containers/). The coupling knob is
`-XX:MaxRAMPercentage`: heap as a percentage of whatever the cgroup allows,
so the manifest and the JVM can never disagree about the number.

**Failure when misaligned.** Two different deaths on two sides of the same
line. Heap too large relative to the limit and total process RSS crosses
`memory.max`: the *kernel* kills you — [OOMKilled](/troubleshooting/oomkilled/),
exit 137, nothing in the application log. Heap too small for the workload and
the *JVM* kills itself: `java.lang.OutOfMemoryError`, stack trace, heap dump
if you asked for one. Teams routinely debug one as if it were the other; the
exit code tells you which side of the line you died on.

:::caution[In-place pod resize does not re-ergonomize the JVM]
Kubernetes can now resize a pod's memory limit in place, without a restart.
The JVM will not notice: ergonomics are computed once, `Runtime.maxMemory()`
is frozen. Resize 1Gi → 4Gi and the JVM still runs its old 256Mi heap.
Resize *down* and a heap sized for the old limit now overshoots the new one —
you've scheduled an OOMKill. For JVM workloads, a memory resize requires a
restart, whatever the platform allows.
:::

**Alignment rule.** Size heap as a percentage of the limit, never as a fixed
`-Xmx` divorced from the manifest, and budget the non-heap remainder
explicitly — flag-by-flag treatment in
[JVM Memory Knobs](/tuning/jvm-memory-knobs/).

### 2. CPU limit ↔ availableProcessors

**Kubernetes side.** `resources.limits.cpu` becomes a CFS quota in `cpu.max`:
"this cgroup may run N×100ms of CPU time per 100ms period." A limit of `500m`
means 50ms of runtime per 100ms window — across *all* threads combined.

**JVM side.** The JVM converts the quota to a processor count — fractional
quotas round **up**, so `500m` → 1, `2500m` → 3 — and publishes it as
`Runtime.availableProcessors()`. That single integer, sampled at startup,
sizes GC worker threads, JIT compiler threads, `ForkJoinPool.commonPool()`,
Netty event loop groups, parallel streams, and every library that caches
"CPU count" in a static initializer.

**Failure when misaligned.** Two distinct failures. First, sizing: a pod with
`limits.cpu: 1` gets one GC thread, one common-pool thread, serial-ish
everything. Second, throttling: when the quota is exhausted mid-period, CFS
freezes **every thread in the cgroup** until the next period — application
threads, GC threads, and the JIT compiler alike. The symptom is a 50–400ms
"pause" in request latencies that is *not* in the GC log: the GC pause that
wasn't a GC pause. You won't find it inside the JVM, because it happened *to*
the JVM; the throttle counters are the only witness — see
[PromQL for Resources](/observability/promql-for-resources/).

**Alignment rule.** Give a JVM at least 2 full CPUs of limit — or no CPU
limit, with an honest request; the debate lives in
[Requests & Limits Knobs](/tuning/requests-limits-knobs/) and
[Resources & QoS](/workloads/resources-and-qos/) — and verify what it concluded:

```bash
kubectl exec deploy/orders -- java -XX:+PrintFlagsFinal -version | grep ActiveProcessorCount
```

### 3. CPU throttling ↔ probe timeouts

**Kubernetes side.** The kubelet's liveness probe has a `timeoutSeconds`
(default: 1) and a `failureThreshold` (default: 3). Miss the deadline three
times in a row and the container is restarted.

**JVM side.** A throttled JVM cannot answer *anything* on time — including
the probe endpoint. And a freshly restarted JVM is a *cold* JVM, burning more
CPU per request than the warm process it replaced.

**Failure when misaligned.** The restart spiral, the nastiest feedback loop
on this map: load rises → CFS throttling → probe misses its 1s timeout ×3 →
kubelet restarts the container → cold JIT burns even more CPU → deeper
throttling → faster probe failure. Fleets have gone down not from the
original load but from the platform's response to it.

**Alignment rule.** `timeoutSeconds` ≥ 5 for any JVM liveness probe, and
liveness must never depend on CPU-hungry work or downstream calls. Probe
patterns are in [Health Checks](/workloads/health-checks/); the exact numbers
in [Health Check Knobs](/tuning/health-check-knobs/).

## Lifecycle couplings: the kubelet and the process

### 4. Probes ↔ the JVM lifecycle

**Kubernetes side.** Three probes, three questions: startup ("has it booted
yet?"), readiness ("should it receive traffic?"), liveness ("is it wedged
beyond recovery?"), each with its own budget of `periodSeconds ×
failureThreshold`.

**JVM side.** A JVM's boot is not a moment but a ramp: classloading, then
Spring context construction (often 20–60s for a large app — see
[Spring Boot on Kubernetes](/java/spring-boot/)), then minutes of JIT warmup
during which the app *works* but slowly. And at any point in its life, a
stop-the-world GC pause or safepoint stall freezes every thread — including
the one that would have answered the probe.

**Failure when misaligned.** Three flavors. Startup budget < boot time: the
pod is killed mid-classloading, restarts, and loops — `CrashLoopBackOff` on
an app that was never broken. Readiness passing before warmup: the Service
routes real traffic to an interpreter, and your first users after every
deploy eat 10× latency. Liveness tighter than your worst GC pause: a pause
that outlasts `timeoutSeconds × failureThreshold` of consecutive misses
executes a healthy JVM for the crime of collecting garbage — killing exactly
the pods under the most memory pressure, at the worst time.

**Alignment rule.** Startup probe budget ≥ 2× your p99 observed boot time;
readiness gated on actual dependencies (ideally after a warmup exercise);
liveness timeout comfortably above your worst pause in the GC log. Pauses and
safepoints are dissected in [GC and Performance](/java/gc-and-performance/);
probe design in [Health Checks](/workloads/health-checks/).

### 5. SIGTERM ↔ shutdown hooks

**Kubernetes side.** Pod deletion is a two-act play: SIGTERM to PID 1,
a wait of `terminationGracePeriodSeconds` (default: 30), then SIGKILL. In
parallel — not before — the pod is removed from Service endpoints, so traffic
keeps arriving for a few seconds *after* SIGTERM.

**JVM side.** SIGTERM triggers `Runtime` shutdown hooks — where Spring's
graceful shutdown, connection pool draining, and Kafka consumer `close()`
all live. But only if the signal reaches the JVM: shell-form ENTRYPOINT makes
`/bin/sh` PID 1, and the shell does not forward signals. Your JVM never hears
SIGTERM and dies 30 seconds later by SIGKILL, hooks unrun.

```dockerfile
# Shell form — sh is PID 1, JVM never sees SIGTERM:
ENTRYPOINT java -jar app.jar
# Exec form — JVM is PID 1, shutdown hooks actually run:
ENTRYPOINT ["java", "-jar", "app.jar"]
```

**Failure when misaligned.** Grace period shorter than the JVM's shutdown
work (Spring's `spring.lifecycle.timeout-per-shutdown-phase`, in-flight
requests, Kafka rebalances): SIGKILL lands mid-drain, and every rolling
deploy sheds a burst of 502s and half-committed work. Or the race at the
front: requests arriving after SIGTERM hit a server that already closed its
listener.

**Alignment rule.** Exec-form ENTRYPOINT, always. Then:
`terminationGracePeriodSeconds > preStop sleep + shutdown timeout + drain
time`, with a `preStop` sleep of a few seconds so endpoint removal propagates
before the JVM starts refusing work. The full preStop + readiness
choreography is in [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/)
and [Spring Boot on Kubernetes](/java/spring-boot/).

## Fleet couplings: replicas as cold JVMs

### 6. Rolling updates & HPA ↔ JIT warmup

**Kubernetes side.** Rolling updates surge new pods in and old pods out; the
HPA adds replicas when CPU crosses a threshold. Both assume a new replica is
a full replica the moment it's Ready.

**JVM side.** Every new pod is a cold JVM. Code runs in the interpreter, gets
promoted to C1, and only after thousands of invocations reaches optimized C2.
For minutes, the new pod delivers a fraction of the throughput of the warm
pod it replaced — at *higher* CPU cost per request.

**Failure when misaligned.** A rolling update temporarily replaces your warm
capacity with cold capacity: p99 spikes on every deploy, and "deploy during
peak" becomes an outage generator. Worse is the HPA feedback loop: warmup CPU
burn looks like load, so the HPA sees the cold pods running hot and scales
out *again*, adding more cold pods — the autoscaler amplifies the very signal
warmup creates. [Autoscaling](/workloads/autoscaling/) covers stabilization
windows and better signals than raw CPU.

Four technologies attack the cold-start coupling, in ascending ambition:

- **CDS/AppCDS** — memory-maps pre-parsed class metadata. Mature, in every
  modern JDK, cheap to adopt. Shaves 20–40% off startup; does nothing for
  JIT warmup.
- **Project Leyden / AOT cache (JDK 24+)** — extends CDS with ahead-of-time
  class loading and profile-driven compilation. Genuinely promising and
  shipping, but young; treat gains as workload-specific until measured.
- **GraalVM Native Image** — full AOT: ~50ms startup, no warmup at all. The
  trade: a closed-world build, weaker peak throughput than a warmed C2, and a
  different diagnostic story. Excellent for scale-to-zero services; a
  considered bet for a heap-heavy monolith.
- **CRaC** — checkpoint a *warmed* JVM, restore in milliseconds, JIT state
  and all. The most complete answer on paper; in practice it needs framework
  cooperation (open sockets must survive checkpoint/restore) and runtime
  support that is still uneven. Verify in staging before betting a fleet.

**Alignment rule.** `maxSurge` sized so warm capacity never drops below what
peak needs; HPA stabilization window longer than warmup; deploy off-peak
until one of the technologies above breaks the coupling. See
[Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/) and
[High Availability](/workloads/high-availability/) for the fleet math.

## Network couplings: names, addresses, and sockets

### 7. JVM DNS caching ↔ Kubernetes service discovery

**Kubernetes side.** Everything is a DNS name backed by IPs that churn.
ClusterIP Services keep a stable VIP, but headless Services return pod IPs
directly — and pods are cattle. A name resolved five minutes ago may point at
five dead pods now.

**JVM side.** `InetAddress` caches positive lookups per
`networkaddress.cache.ttl` — 30 seconds by default in modern JDKs, but
**forever** if a `SecurityManager` is enabled or an old base image sets
`networkaddress.cache.ttl=-1`. Some HTTP clients and drivers add their own
resolution cache on top.

**Failure when misaligned.** The classic: a client resolves a headless
Service once, caches the pod IP, and connects to a dead pod forever — or to
one pod out of ten, defeating client-side load balancing entirely. Symptoms
look like the *server's* fault ("connection refused from orders-svc") when
the truth is a stale cache in the caller.

**Alignment rule.** Verify the effective TTL in *your* image (≤ 30s); never
cache resolution results in application code; make clients re-resolve on
connection failure. Kubernetes DNS mechanics are in [DNS](/networking/dns/).

### 8. Connection pools ↔ pod churn

**Kubernetes side.** Endpoints churn with every deploy, scale event, and
node drain, and between the JVM and its dependency sit conntrack entries,
kube-proxy rules, load balancers, and service meshes — each with its own idle
timeout, each entitled to silently drop a connection it considers dead.

**JVM side.** Connection pools (HikariCP, HTTP client pools, Lettuce) exist
to *keep* connections alive. A pooled connection is a bet that the far end
and every middlebox in between still agree the socket exists.

**Failure when misaligned.** Pool `maxLifetime` longer than a middlebox's
idle timeout: the pool hands out a connection the network already forgot, and
the first write blocks until a TCP timeout — sporadic multi-second stalls
that correlate with nothing in either the JVM or the pod.

**Alignment rule.** `maxLifetime` < the shortest idle timeout of every
middlebox on the path; TCP keepalives more frequent than that same timeout;
validation-on-borrow for anything that can't afford a stall. The full
middlebox census is in
[Long-Lived Connections](/networking/long-lived-connections/).

### 9. Threads ↔ container memory

**Kubernetes side.** `memory.max` counts *everything* the process maps:
heap, Metaspace, code cache — and every thread stack.

**JVM side.** Each platform thread reserves a stack (`-Xss`, ~1MB default) in
native memory, outside the heap and invisible to `-Xmx`. An unbounded
executor or a library that quietly spawns hundreds of workers is allocating
memory nothing in your heap monitoring can see.

**Failure when misaligned.** The invisible OOM: heap flat at 60%, dashboards
green, pod OOMKilled anyway — because 800 threads × 1MB of stack ate the
headroom between heap and limit. This is the most common "but the heap was
fine!" [OOMKilled](/troubleshooting/oomkilled/) postmortem; a
[thread dump](/java/thread-dumps-jre-only/) is the diagnostic, and
`jcmd VM.native_memory` the proof.

Virtual threads (Loom, JDK 21+) genuinely change this coupling: a virtual
thread's stack lives *in the heap* as a small, growable object, so a million
fit where a few thousand platform threads did — visible to `-Xmx` and your
dashboards. Honest caveats: carrier-thread pinning under `synchronized`
(largely fixed in JDK 24), ThreadLocal-heavy libraries that assumed threads
were scarce, and the fact that they solve thread *memory*, not CPU quota or
pool limits. They shrink coupling #9; they do not touch #2 or #8.

**Alignment rule.** Bound every pool; make `threads × Xss` a line item in
the memory budget ([JVM Memory Knobs](/tuning/jvm-memory-knobs/)); alert on
thread count, not just heap.

## Diagnostic couplings: decided at build time, needed at 3am

### 10. Observability: two truths, one incident

**Kubernetes side.** cAdvisor publishes `container_memory_working_set_bytes`,
`container_cpu_cfs_throttled_periods_total`, restart counts — the cgroup's
view of the process as an opaque box.

**JVM side.** Micrometer/JMX publish heap, GC pause histograms, thread
counts, pool saturation — the process's view of itself, blind to the cgroup
around it.

**Failure when misaligned.** Either alone is a half-truth. Working set
climbing toward the limit: only JVM metrics can say whether that's heap (a
leak — see [Memory Leaks and OOM](/java/memory-leaks-and-oom/)) or native
(threads, direct buffers). Latency rising: only the throttle counters can
reveal coupling #2. Teams with one side of the telemetry reliably
misattribute the other side's failures.

And the flight recorder caveat: always-on JFR is the best black box the JVM
has, but its buffers live in the process, and an OOM kill or eviction takes
the recording down with the pod — unless you configure periodic dumps to a
volume that outlives the container. A flight recorder that dies in the crash
recorded nothing.

**Alignment rule.** Every JVM dashboard pairs heap/GC panels with working-set
and throttle panels for the same pod; JFR dumps land on an `emptyDir` at
minimum, a PVC if you're serious. Setup in
[Java Observability](/java/java-observability/).

### 11. Attach mechanics ↔ pod boundaries

**Kubernetes side.** You have namespace-scoped kubectl and `exec` into your
own pods. Ephemeral containers can inject a toolbox — but unless it shares
the process namespace and runs as the *same UID*, the JVM's attach handshake
refuses it.

**JVM side.** Every dynamic diagnostic — `jcmd`, thread dumps, heap dumps,
JFR start — rides the attach mechanism: a handshake over `/tmp/.java_pid<n>`
plus per-process files in `/tmp/hsperfdata_<user>`, requiring same UID, a
writable `/tmp`, and a visible `/proc/<pid>`.

**Failure when misaligned.** A read-only root filesystem with no `/tmp`, a
mismatched `runAsUser`, or `-XX:-UsePerfData` set for "hardening" — any one
of these, and at 3am the answer to "can we get a heap dump?" is simply *no*.
The pod is eventually recycled and the truth leaves with it.

**Alignment rule.** Prove the full dump path — attach, dump, copy out — in
staging *before* the incident; "can I even get a dump" is a deployment-time
decision. Walkthroughs in [Thread Dumps, JRE-Only](/java/thread-dumps-jre-only/)
and [Heap Dumps, JRE-Only](/java/heap-dumps-jre-only/).

### 12. The image coupling

**Kubernetes side.** The image is immutable and minimal by policy: JRE-only,
distroless, or a jlink-trimmed runtime. No shell, no JDK tools, no package
manager — decided in the Dockerfile, months before any incident.

**JVM side.** `jcmd`, `jstack`, `jmap`, and `jdb` live in the JDK, not the
JRE. A distroless image doesn't even have `sh` for `kubectl exec`. Whether
`jcmd` exists at 3am was decided by a `FROM` line at build time.

**Failure when misaligned.** Every diagnostic has a JRE-only workaround —
`kill -3` for thread dumps, `HeapDumpOnOutOfMemoryError` for heap dumps, JDWP
for [remote debugging](/java/remote-debugging/) — but each must be *arranged
in advance*: the flag set, the volume mounted, the toolbox image allowed.
The failure mode isn't a crash; it's an incident that can't be investigated.

**Alignment rule.** For every diagnostic you might need, write down how you'd
get it from *this* image in *this* cluster, and test it quarterly. If the
answer involves "rebuild the image," that diagnostic doesn't exist.

## The alignment checklist

Every coupling above, compressed to a testable rule. An unchecked box is
your next incident, found in advance.

**Memory & CPU**

- [ ] Heap set via `MaxRAMPercentage`, never an `-Xmx` divorced from `resources.limits.memory`. *(#1)*
- [ ] `heap + Metaspace + threads×Xss + direct + code cache ≤ ~85%` of the memory limit. *(#1, #9)*
- [ ] Any memory-limit change ships with a pod restart — never an in-place resize alone. *(#1)*
- [ ] `Runtime.availableProcessors()` verified in-cluster; every pool sized against it. *(#2)*
- [ ] CPU limit ≥ 2 cores (or none, with an honest request); throttle metrics on the main dashboard. *(#2)*

**Lifecycle**

- [ ] Liveness `timeoutSeconds` ≥ 5 and `timeout × failureThreshold` > worst GC pause in the log. *(#3, #4)*
- [ ] Startup probe budget ≥ 2× observed boot-time p99. *(#4)*
- [ ] Readiness gates on real dependencies, ideally after a warmup exercise. *(#4)*
- [ ] Exec-form ENTRYPOINT; the JVM is PID 1 (or under a signal-forwarding init). *(#5)*
- [ ] `terminationGracePeriodSeconds > preStop sleep + shutdown timeout + drain time`. *(#5)*

**Fleet**

- [ ] Warm capacity during a rollout (replicas − maxUnavailable, discounted for cold pods) covers peak. *(#6)*
- [ ] HPA stabilization window > JIT warmup, or the HPA keys on a signal warmup doesn't pollute. *(#6)*

**Network**

- [ ] Effective `networkaddress.cache.ttl` verified ≤ 30s in the running image. *(#7)*
- [ ] Pool `maxLifetime` < idle timeout of every middlebox on the path; keepalives more frequent still. *(#8)*

**Diagnostics**

- [ ] Every thread pool is bounded; thread count is alerted on. *(#9)*
- [ ] Dashboards pair JVM metrics with working-set and throttle metrics for the same pods. *(#10)*
- [ ] Continuous JFR dumps to a volume that survives the pod. *(#10)*
- [ ] The full dump path (attach → dump → copy out) tested quarterly on the production image. *(#11, #12)*
- [ ] `-XX:+HeapDumpOnOutOfMemoryError` points at a mounted volume. *(#12)*

## Where to go from here

These couplings aren't aligned one at a time — they're aligned in order,
because the numbers feed each other: the limit determines the heap, the heap
determines the pause profile, the pauses determine the probe budgets, the
boot time determines the rollout shape. The
[Sizing Walkthrough](/tuning/sizing-walkthrough/) is that procedure: one
service, taken through this map from cgroup to checklist with real numbers at
every step. Start there; come back here when something disagrees.
