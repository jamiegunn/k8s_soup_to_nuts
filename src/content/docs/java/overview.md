---
title: Java on Kubernetes, JRE-Only
description: How to diagnose JVM problems in production pods that ship a JRE without JDK tools — the constraint, the toolbox, and where to find each technique.
sidebar:
  order: 1
---

Your production images ship a JRE. Often a jlink-minimized one. That means the
tools every Java troubleshooting guide assumes you have — `jstack`, `jmap`,
`jcmd`, `jps` — may simply not exist in the container. And you can't SSH to the
node, because you don't own the node.

What you *do* have: `kubectl exec` into your own pods, `kubectl logs`,
`kubectl debug` (if your cluster is new enough and your RBAC allows ephemeral
containers), `kubectl port-forward`, and a CI/CD pipeline that can change JVM
flags and redeploy. That is enough. This section shows you how to get thread
dumps, heap dumps, GC data, flight recordings, and a live debugger out of a
JRE-only pod — without asking the platform team for anything, except where we
explicitly flag it.

:::note[The one-sentence version of the whole section]
`kill -3` always works, `-XX:+HeapDumpOnOutOfMemoryError` always works, JFR
ships in every OpenJDK 11+ runtime, jattach is a tiny static binary you can
copy into any pod, and `kubectl debug` can bring a full JDK to the party.
:::

## First: inventory what your runtime actually has

Before an incident, not during one, run these against a real production pod
(or the exact image locally). Two minutes now saves you guessing at 3 a.m.

```bash
# What JVM is this, exactly?
kubectl exec -it myapp-7d4b9c6f5d-x2klm -- java -version
```

```console
openjdk version "21.0.5" 2024-10-15 LTS
OpenJDK Runtime Environment Temurin-21.0.5+11 (build 21.0.5+11-LTS)
OpenJDK 64-Bit Server VM Temurin-21.0.5+11 (build 21.0.5+11-LTS, mixed mode, sharing)
```

```bash
# What binaries shipped in the runtime image?
kubectl exec myapp-7d4b9c6f5d-x2klm -- ls /opt/java/openjdk/bin
# (adjust path: sometimes /usr/lib/jvm/..., or check `env | grep JAVA_HOME`)
```

A full JDK shows 25+ binaries (`jcmd`, `jstack`, `jmap`, `jfr`, ...). A stock
JRE shows a handful (`java`, `keytool`, maybe `jrunscript`). A jlink image
might show only `java` and `keytool`.

```bash
# The decisive check for a jlink runtime: is the jdk.jcmd module in?
kubectl exec myapp-7d4b9c6f5d-x2klm -- java --list-modules | grep jdk.jcmd
```

If that prints `jdk.jcmd@21.0.5`, you have `jcmd`, `jstack`, `jmap`, `jstat`,
and `jinfo` even in a jlink image — the "JRE-only" problem mostly disappears.
If it prints nothing, you're in the world this section is written for.

Also worth checking once:

```bash
# Is there a shell at all? (distroless images: no)
kubectl exec myapp-7d4b9c6f5d-x2klm -- sh -c 'echo yes'
# Is the JVM pid 1, and what user runs it?
kubectl exec myapp-7d4b9c6f5d-x2klm -- sh -c 'ls -l /proc/1/exe; id'
# Does the image have tar (needed by kubectl cp) and base64?
kubectl exec myapp-7d4b9c6f5d-x2klm -- sh -c 'command -v tar; command -v base64'
```

Record the answers in your team runbook. Every article in this section
branches on them.

## Decision table: evidence → technique

| I need... | Best JRE-only route | Article |
|---|---|---|
| Thread dump (what is every thread doing right now?) | `kubectl exec <pod> -- kill -3 1`, read it with `kubectl logs` | [Thread dumps](/java/thread-dumps-jre-only/) |
| Deadlock / hot-loop / stuck-pool diagnosis | 3–5 thread dumps 10 s apart, diff them | [Thread dumps](/java/thread-dumps-jre-only/) |
| Heap dump after an `OutOfMemoryError` | `-XX:+HeapDumpOnOutOfMemoryError` + `HeapDumpPath` on a volume — set it *today* | [Heap dumps](/java/heap-dumps-jre-only/) |
| Heap dump on demand from a live pod | jattach `dumpheap`, or `kubectl debug` with a JDK image, or Spring Actuator `/actuator/heapdump` | [Heap dumps](/java/heap-dumps-jre-only/) |
| Cheap "what's filling the heap" without a full dump | Class histogram (`GC.class_histogram` via jattach/jcmd) | [Heap dumps](/java/heap-dumps-jre-only/) |
| The 2 GB `.hprof` file on my laptop | `kubectl cp` if tar exists; `exec` + `cat`/base64 streaming if not | [Getting dumps out](/java/getting-dumps-out/) |
| Step-through debugging of live code | JDWP via `JAVA_TOOL_OPTIONS` + `kubectl port-forward 5005` — read the safety notes first | [Remote debugging](/java/remote-debugging/) |
| GC pause / throughput analysis | `-Xlog:gc*` to stdout or a volume; JFR recording | [GC and performance](/java/gc-and-performance/) |
| CPU / allocation profile over time | JFR (`-XX:StartFlightRecording`), in every OpenJDK 11+ runtime | [Java observability](/java/java-observability/) |
| Why the *container* was killed at exit 137 | That's the kernel, not the JVM — different workflow | [Memory leaks and OOM](/java/memory-leaks-and-oom/) |
| Why the heap keeps growing | Histograms over time → dump → Eclipse MAT dominator tree | [Memory leaks and OOM](/java/memory-leaks-and-oom/) |
| Right-size heap vs container limits | Understand `MaxRAMPercentage` and the non-heap budget first | [JVM in containers](/java/jvm-in-containers/) |

## The four tiers of access, in preference order

1. **Signals and flags — always work.** `SIGQUIT` thread dumps,
   `-XX:+HeapDumpOnOutOfMemoryError`, `-Xlog:gc*`, `-XX:StartFlightRecording`.
   These are features of the JVM itself, present in every HotSpot build, JRE
   or JDK, jlink or not. Your first move should always be here.
2. **Modules that happened to be included.** If `jdk.jcmd` made it into the
   jlink image, use `jcmd` like the manuals say. Check, don't assume.
3. **Bring a tiny tool to the pod.** [jattach](https://github.com/jattach/jattach)
   is a static binary well under 1 MB that speaks the JVM's dynamic attach
   protocol — thread dumps, heap dumps, and full `jcmd` passthrough without a
   JDK. Copy it in with `kubectl cp` or bake it into your image (recommended).
4. **Bring a whole JDK in an ephemeral container.** `kubectl debug --target`
   attaches a JDK-equipped container into the pod's process namespace and runs
   real `jstack`/`jmap`/`jcmd` against your JVM. Powerful, with attach caveats
   (matching UID, `/proc/<pid>/root` paths) covered in the thread- and
   heap-dump articles.

:::tip[Do the prep work while nothing is on fire]
Three changes to make in your next routine release: (1) add
`-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/dumps` with `/dumps` on an
`emptyDir`, (2) add a continuous JFR ring buffer
(`-XX:StartFlightRecording=maxsize=100m,maxage=1h,...`), (3) bake `jattach`
into the image. Each costs almost nothing at runtime, and together they turn
most future incidents from "redeploy with instrumentation and wait for it to
happen again" into "the evidence is already on disk".
:::

## Where your access ends

Almost everything in this section works with namespace-scoped kubectl. The
known exceptions, so you can open the platform-team conversation early
instead of discovering the wall mid-incident:

- **Ephemeral containers** (`kubectl debug`) need the
  `pods/ephemeralcontainers` RBAC verb — some clusters don't grant it.
- **perf_events-based CPU profiling** (async-profiler's default mode) is
  gated by node sysctls you can't change.
- **Node-level evidence** (kubelet logs, container runtime state, node
  `dmesg` for OOM-killer lines) is theirs; ask, with pod name and timestamp.

Everything else — signals, flags, exec, port-forward, volumes, ephemeral
storage — is yours.

## What's in this section

- [The JVM in containers](/java/jvm-in-containers/) — how the JVM sees cgroup
  limits, sizing heap vs container memory, CPU count surprises.
- [Thread dumps with a JRE only](/java/thread-dumps-jre-only/) — the full menu,
  from `kill -3` to ephemeral containers, and how to read what you capture.
- [Heap dumps with a JRE only](/java/heap-dumps-jre-only/) — five ways to get an
  `.hprof`, and when a class histogram is the smarter choice.
- [Getting dumps out of the pod](/java/getting-dumps-out/) — `kubectl cp`, its
  tar dependency, and the fallbacks when the image is distroless.
- [Remote debugging](/java/remote-debugging/) — JDWP over port-forward, and why
  a breakpoint in prod will get your pod killed by its own liveness probe.
- [GC and performance](/java/gc-and-performance/) — collector choice, GC logs,
  and CPU throttling masquerading as GC trouble.
- [Memory leaks and OOM](/java/memory-leaks-and-oom/) — OOMKilled vs
  `OutOfMemoryError`, and the workflow for each flavor of leak.
- [The JVM–Kubernetes Coupling Map](/java/jvm-kubernetes-coupling/) — the section
  capstone: every point where the JVM and Kubernetes interlock, and the failure
  when they disagree.
- [Spring Boot on Kubernetes](/java/spring-boot/) — actuator probes, graceful
  shutdown, config, and a production-ready reference Deployment.
- [Java observability](/java/java-observability/) — JFR as an always-on flight
  recorder, Micrometer metrics, structured logs, async-profiler.

If you're new to operating without cluster-admin in general, start with
[Working without admin](/start/working-without-admin/) — everything here
assumes that posture.
