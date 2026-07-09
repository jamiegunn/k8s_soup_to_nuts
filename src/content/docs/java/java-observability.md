---
title: Java Observability in Kubernetes
description: Always-on JFR flight recordings, Micrometer metrics into Prometheus, structured JVM logging, and async-profiler — continuous evidence instead of incident archaeology.
keywords:
  - always-on JFR ring buffer
  - -XX:StartFlightRecording
  - JDK Mission Control
  - Micrometer Prometheus binders
  - async-profiler flame graph
  - perf_event_paranoid
  - structured JSON logging logback
  - jvm_memory_used_bytes
  - RecordingStream event streaming
  - logstash-logback-encoder
  - native leak detection kubectl top
sidebar:
  order: 10
---

Everything else in this section is reactive: something broke, go capture
evidence. This article is about making the evidence *already exist*. A JVM
with a JFR ring buffer, Micrometer metrics, and structured logs turns most
incidents from "redeploy with instrumentation, wait for recurrence" into
"pull the recording that covers the incident".

## JFR: the black-box flight recorder you already have

Java Flight Recorder ships in **every OpenJDK 11+ runtime** (and 8u262+),
including jlink-minimized JREs (the `jdk.jfr` module is in the default
module set — verify once with `java --list-modules | grep jdk.jfr`). Default
profile overhead is around 1%. There is very little reason not to run it
always-on in production:

```yaml
env:
  - name: JAVA_TOOL_OPTIONS
    value: >-
      -XX:StartFlightRecording=maxsize=100m,maxage=1h,filename=/dumps/myapp.jfr,dumponexit=true,settings=default
volumeMounts:
  - name: dumps
    mountPath: /dumps
```

What each part buys you:

- `maxsize=100m,maxage=1h` — a bounded ring buffer: keep the last hour or
  100 MB, whichever bites first. Disk and overhead stay flat forever.
- `dumponexit=true` — on JVM exit (including `ExitOnOutOfMemoryError`
  exits, but *not* SIGKILL/OOMKill — the kernel gives no dying breath) the
  buffer is written to `filename`. Crash forensics for free.
- `filename=/dumps/myapp.jfr` — on a volume, same reasoning as heap dumps:
  survives container restarts, doesn't count against ephemeral storage
  limits. If you give a directory, the JVM generates a name.
- `settings=default` (~1% overhead) vs `settings=profile` (~2%, adds finer
  allocation/contention detail — use temporarily, not as the resting state).

### Dumping the buffer on demand

During an incident, snapshot the last hour without touching the app:

```bash
# jdk.jcmd present:
kubectl exec $POD -- jcmd 7 JFR.dump filename=/dumps/incident-$(date +%s).jfr
# JRE-only, via jattach (see the thread dumps article for getting it in):
kubectl exec $POD -- /usr/local/bin/jattach 7 jcmd "JFR.dump filename=/dumps/incident.jfr"
```

Then pull the file out ([Getting dumps out](/java/getting-dumps-out/)) and open
it in **JDK Mission Control** (free, separate download). The money pages:
Method Profiling (CPU flame graph), Memory (allocation by class/stack),
Garbage Collections, Lock Instances (contended monitors), Socket/File I/O,
Exceptions (including *caught* ones — a top thrower burning 20% CPU in
fillInStackTrace is a classic JFR find).

You can also start recordings on demand (`JFR.start duration=5m ...`) on a
JVM launched without the flag — attach-based, same jattach/jcmd routes.

### JFR event streaming

JDK 14+ can consume events *in-process* (`jdk.jfr.consumer.RecordingStream`)
— a few lines of code exports JFR-quality data (GC pauses, allocation,
contention) to your metrics system continuously, no files involved. Some
agents (e.g. OpenTelemetry Java instrumentation) already do this for you.
If you run an OTel agent, check what it captures before building anything.

## Metrics: Micrometer → Prometheus

The metrics backbone (`kubectl top`, Prometheus scraping, dashboards) is
covered in [Metrics](/observability/metrics/); the JVM specifics:

Spring Boot Actuator with `micrometer-registry-prometheus` exposes
`/actuator/prometheus` with the full JVM set out of the box; plain apps get
the same via Micrometer's `JvmMemoryMetrics`, `JvmGcMetrics`,
`JvmThreadMetrics`, `ClassLoaderMetrics` binders. Make sure your pod carries
whatever scrape convention your platform uses (commonly a `PodMonitor`/
`ServiceMonitor` you own in your namespace, or annotations).

The JVM panels worth building *before* you need them:

| Metric | What it tells you |
|---|---|
| `jvm_memory_used_bytes{area="heap"}` vs `container_memory_working_set_bytes` | The heap-vs-RSS gap; a widening gap = native growth ([leak triage](/java/memory-leaks-and-oom/)) |
| `jvm_gc_pause_seconds` (histogram) | Pause p99 and GC time %, without log spelunking |
| `jvm_threads_live_threads` | Thread leaks show as a staircase |
| `jvm_classes_loaded_classes` | Classloader leaks: growth long after warmup |
| `jvm_buffer_memory_used_bytes{id="direct"}` | Direct-buffer creep (Netty) |
| `process_cpu_usage` vs the cgroup throttle counters | Throttling vs real load ([GC and performance](/java/gc-and-performance/)) |

### Correlating with kubectl top

`kubectl top pod` shows the *cgroup's* view (working set ≈ what the OOM
killer judges); Micrometer shows the *JVM's* view. Reading them together is
the fastest native-leak detector there is:

```bash
kubectl top pod -l app=myapp
```

```console
NAME                     CPU(cores)   MEMORY(bytes)
myapp-7d4b9c6f5d-x2klm   212m         3410Mi
```

Heap gauge says 1.6 GiB, `kubectl top` says 3.4 GiB, limit is 4 GiB: you
have a ~1.8 GiB non-heap footprint. Is it stable? Fine, that's your budget.
Growing week over week at flat heap? Start the NMT workflow now, not when
it 137s.

:::tip
To do this correlation with history instead of snapshots, plot the JVM
gauges next to the container's `working_set` and throttle queries from
[PromQL for CPU and Memory](/observability/promql-for-resources/).
:::

## Structured JSON logging

Once logs flow through a collector into a search backend, JSON
lines beat pattern-parsed text: exceptions stop being 40 separate "lines",
MDC fields (trace id, tenant, request id) become queryable, and multiline
stack traces stop shredding. Logback example (`logstash-logback-encoder`):

```xml
<appender name="STDOUT" class="ch.qos.logback.core.ConsoleAppender">
  <encoder class="net.logstash.logback.encoder.LogstashEncoder"/>
</appender>
```

JVM-specific advice:

- Log to **stdout only**. No file appenders, no rotation logic — the
  container runtime and collector own that.
- Two JVM-emitted outputs will *not* be JSON no matter what you configure:
  SIGQUIT thread dumps and `-Xlog` GC output on stdout. Make sure your
  pipeline passes non-JSON lines through raw instead of dropping them —
  that's your incident evidence.
- Put the trace id in MDC so logs join traces.

## async-profiler via ephemeral container

For CPU flame graphs sharper than JFR's sampler (native frames, kernel
frames), [async-profiler](https://github.com/async-profiler/async-profiler)
attaches to a running JVM without restart. From a debug container sharing
the pid namespace:

```bash
kubectl debug -it $POD --image=ghcr.io/yourorg/java-debug:latest --target=myapp -- bash
# inside (same-UID caveats as any dynamic attach — see the thread dumps article):
./asprof -d 60 -f /tmp/flame.html 7
```

The catch: CPU sampling with full fidelity uses **perf_events**, gated by
the node's `kernel.perf_event_paranoid` sysctl (needs ≤ 1, or
`CAP_PERFMON`) and `kernel.kptr_restrict`. Those are node settings —
**ask your platform team**; many lock them down, and unprivileged pods
can't change them. Fallbacks that work without perf_events, entirely within
your pod's permissions:

```bash
./asprof -e ctimer -d 60 -f /tmp/flame.html 7   # timer-based CPU sampling, no perf_events
./asprof -e alloc  -d 60 -f /tmp/alloc.html 7   # allocation profiling (TLAB hooks, no kernel deps)
./asprof -e wall   -d 60 -f /tmp/wall.html 7    # wall-clock: finds waiting, not just burning
```

`ctimer`/`itimer` mode loses native/kernel frames but still gives you
correct Java flame graphs — usually all you need. If flame graphs become
routine, bake async-profiler into a team debug image alongside jattach and a
JDK.

## The layered posture, summarized

1. **Always on:** Micrometer → Prometheus, JSON logs → collector, `-Xlog:gc`
   → stdout, JFR ring buffer → volume, `HeapDumpOnOutOfMemoryError`.
   Steady-state cost: a few percent CPU, ~100 MB disk.
2. **On demand, no restart:** `JFR.dump`, thread dumps, histograms, NMT
   queries (if NMT flag was pre-set), async-profiler in fallback modes.
3. **On demand, restart or platform help:** NMT enablement,
   `settings=profile` JFR, perf_events profiling, JDWP remote debugging.

Build layer 1 into your Deployment template once, and most of this section's
other articles become things you read while the answer downloads.
