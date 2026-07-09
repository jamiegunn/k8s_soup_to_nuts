---
title: .NET in Containers
description: How the CLR sees cgroup limits, why Server GC is the decision that sizes your pod, and the memory knobs that keep .NET inside its container limit.
keywords:
  - Server GC vs Workstation GC
  - DOTNET_gcServer
  - DOTNET_GCHeapHardLimitPercent hex
  - DATAS GCDynamicAdaptationMode
  - Environment.ProcessorCount cgroup
  - DOTNET_PROCESSOR_COUNT
  - thread pool starvation
  - ReadyToRun Native AOT
  - cgroup v2 .NET Core 3.1 OOMKilled
  - GC env var hexadecimal trap
  - container_memory_working_set_bytes
  - OutOfMemoryException heap hard limit
sidebar:
  order: 2
---

The CLR has been container-aware longer and more thoroughly than most
runtimes — but "aware" hides version cliffs, a GC-mode decision with a 10x
RSS impact, and a default heap limit that is the *opposite* of Java's. This
article is the sizing and knobs reference for everything else in the
section.

## Does your .NET actually see the limits?

| Runtime | cgroup v1 | cgroup v2 | Verdict |
|---|---|---|---|
| .NET Core 2.1 | Partial (memory only, quirks) | No | Upgrade |
| .NET Core 3.0/3.1 | Yes, solid | **No** | The trap: fine until the node OS upgrades |
| .NET 5 | Yes | Yes (first support, rough edges) | OK |
| .NET 6+ | Yes | Yes, solid | Target this |

The cgroup v2 row is the live war story: clusters have been defaulting to
cgroup v2 nodes for years (Ubuntu 22.04+, AL2023, current COS). A
.NET Core 3.1 app rescheduled onto a v2 node stops seeing its limits
entirely — it sizes GC and thread pool for the *node* (say, 64 CPUs and
256 GiB), then gets [OOMKilled](/troubleshooting/oomkilled/) at its 1 GiB
limit with no warning. If you still run 3.1, this is your migration argument.

Verify what the runtime believes, from inside the app (log it at startup):

```csharp
var gc = GC.GetGCMemoryInfo();
logger.LogInformation(
    "CLR view: ProcessorCount={Cpus}, TotalAvailableMemory={MemMiB} MiB, ServerGC={ServerGc}",
    Environment.ProcessorCount,
    gc.TotalAvailableMemoryBytes / 1024 / 1024,
    System.Runtime.GCSettings.IsServerGC);
```

```console
CLR view: ProcessorCount=2, TotalAvailableMemory=2048 MiB, ServerGC=True
```

`TotalAvailableMemoryBytes` equal to your container's memory limit is the
"container awareness is working" green light. Equal to node RAM: it isn't.

## CPU limits, ProcessorCount, and the thread pool

The CLR derives `Environment.ProcessorCount` from the cgroup CPU quota,
**rounded up**: a limit of `500m` → 1, `1500m` → 2, no limit → all node
CPUs. Two version notes:

- **.NET 6 stopped looking at cpu *shares*** (i.e. Kubernetes *requests*).
  On .NET Core 3.1/.NET 5, a pod with `requests.cpu: 250m` and no limit saw
  `ProcessorCount = 1`. On .NET 6+ the same pod sees every node CPU. Teams
  that "fixed" thread pool sizing by setting requests got un-fixed by the
  runtime upgrade.
- **`DOTNET_PROCESSOR_COUNT`** (.NET 6+) overrides the computed value
  outright. It's the supported way to say "you have a 4-CPU limit but please
  behave like a 2-CPU process" — or the reverse for burst-friendly nodes.

Everything downstream keys off this number: thread pool minimum threads,
Server GC heap count, `Parallel` defaults, and various framework
concurrency heuristics. A wrong `ProcessorCount` is a systemic problem, not
a cosmetic one. The interaction with CFS throttling (rounding `1500m` up to
2 means two compute-hungry threads can outrun the quota and get throttled)
is covered in [Requests & limits knobs](/tuning/requests-limits-knobs/).

Thread pool starvation under low CPU limits shows up as latency spikes with
idle-looking CPU; if you must pin minimums:

```yaml
env:
  - name: DOTNET_ThreadPool_MinThreads
    value: "8"        # decimal, this one; floor for worker threads
```

## Server GC vs Workstation GC: the container decision

This is the .NET twin of Java's collector choice, but with sharper teeth,
because **the Web SDK defaults every ASP.NET Core app to Server GC**
(`ServerGarbageCollection=true` in the generated `runtimeconfig.json`).

- **Workstation GC**: one heap, GC work mostly on the allocating threads.
  Modest RSS, fine throughput for small services.
- **Server GC**: one heap *per logical CPU* (as seen by `ProcessorCount`),
  with dedicated GC threads, and deliberately lazier collection — it lets
  memory climb toward the limit in exchange for throughput.

The failure mode: Server GC + generous node + missing CPU limit = 32 or 64
heaps, each with its own allocation budget. RSS looks like a leak; it's
just Server GC doing what it was designed for on a machine you don't
actually have. The inverse trap: Server GC with a tiny CPU limit and a tiny
memory limit gives you the *lazy collection* behavior without the parallel
benefit — memory rides at 80–90% of the limit constantly, and every
neighboring burst risks the OOM killer.

Rules of thumb that survive contact with production:

| Pod shape | GC mode |
|---|---|
| ≤ 1 CPU limit, ≤ 512 MiB | Workstation (`DOTNET_gcServer=0`) |
| 1–2 CPU, ~1 GiB, latency-tolerant | Workstation, or Server + DATAS on .NET 8+ |
| ≥ 2 CPU, ≥ 2 GiB, throughput-sensitive | Server GC (the default), with a CPU limit set |

```yaml
env:
  - name: DOTNET_gcServer
    value: "0"          # 0 = Workstation, 1 = Server
```

Two version notes that changed the calculus:

- **.NET 7** moved the GC from segments to *regions*, which releases memory
  back to the OS far better — the "Server GC never gives memory back" folk
  wisdom is mostly a pre-7 memory.
- **.NET 8's DATAS** (Dynamic Adaptation To Application Sizes,
  `DOTNET_GCDynamicAdaptationMode=1`; on by default with Server GC in
  .NET 9) starts Server GC with *one* heap and grows/shrinks the heap count
  and gen0 budgets with actual demand. It's explicitly aimed at containers:
  Server GC throughput characteristics with Workstation-like RSS at low
  load. Costs a few percent throughput at sustained peak; for most services
  in pods it's the right default. Note it takes over heap-count decisions —
  `GCHeapCount` is ignored under DATAS.

## Memory knobs and levers

:::danger[GC env var values are HEXADECIMAL]
Numeric values of `DOTNET_GC*` environment variables are parsed as **hex**.
`DOTNET_GCHeapHardLimitPercent=50` means 0x50 = **80 percent**. Write
`0x32` (or `32` if you must, meaning 50) — and put a comment in the YAML,
because the next person will "fix" it. The same settings in
`runtimeconfig.json` (`System.GC.*`) are decimal. This trap has shipped to
production many times.
:::

| Knob (env var) | What it does | Default | Notes |
|---|---|---|---|
| `DOTNET_gcServer` | Server (1) vs Workstation (0) GC | 1 for Web SDK apps | THE decision above |
| `DOTNET_GCHeapCount` | Number of Server GC heaps (hex) | `ProcessorCount` | Ignored under DATAS |
| `DOTNET_GCHeapHardLimit` | Absolute GC heap cap, bytes (hex) | unset | `0x40000000` = 1 GiB |
| `DOTNET_GCHeapHardLimitPercent` | GC heap cap as % of container limit (hex) | **75%** when a memory limit is set (min 20 MB) | The headline default |
| `DOTNET_GCHighMemPercent` | Memory-load % where GC turns aggressive (hex) | 90 (`0x5A`) | Lower it (e.g. `0x50` = 80) to make GC react before the OOM killer does |
| `DOTNET_GCConserveMemory` | 0–9; higher trades CPU for smaller heap | 0 | 5–7 is the useful range for tight pods |
| `DOTNET_GCDynamicAdaptationMode` | 1 = DATAS | 0 in .NET 8; 1 in .NET 9 Server GC | The container-friendly Server GC |
| `DOTNET_GCgen0size` | Gen0 budget, bytes (hex) | heuristic | Rarely needed once DATAS exists |

For Java readers: this assertive 75% default is the mirror image of the
JVM's timid default — same equation, opposite starting points — see
[The JVM in containers](/java/jvm-in-containers/).

## The RSS budget: why 75% is not "the app gets 75%"

The container limit pays for everything, and the GC hard limit only caps
one line item:

```text
container limit (e.g. 2 GiB)
├── GC heap                  ≤ hard limit (default 1.5 GiB here)
├── native memory            Kestrel buffers, TLS, GRPC/HTTP2 streams,
│                            native driver libs, GC bookkeeping
├── JIT code + loader heaps  grows with assembly count; R2R images map more
├── thread stacks            committed pages per thread (watch thread leaks)
└── assemblies + runtime     mapped images (mostly shared, some private)
```

When GC heap + native exceeds the limit, the kernel sends SIGKILL — exit
137, no managed exception, no dump unless the *kernel* is configured for
one. The CLR-side symptom of a too-high hard limit is different:
`OutOfMemoryException` when the *GC heap* cap is hit while the container
still has headroom. Both workflows are in
[OOMKilled](/troubleshooting/oomkilled/); the requests/limits side is in
[Requests & limits knobs](/tuning/requests-limits-knobs/).

Watch the real number, not the heap: `container_memory_working_set_bytes`
is what the kernel judges you on — queries in
[PromQL for resources](/observability/promql-for-resources/).

## Worked example: sizing a 2 GiB pod

Service: ASP.NET Core API, .NET 8, ~200 threads peak, moderate TLS traffic,
`limits: {memory: 2Gi, cpu: "2"}`.

1. Default GC hard limit: 75% × 2048 MiB = **1536 MiB**.
2. Estimate non-GC: runtime + JIT ~120 MiB, thread stacks ~60 MiB
   committed, Kestrel/TLS native ~150 MiB under load, headroom for spikes
   ~100 MiB → **~430 MiB**.
3. 1536 + 430 = 1966 MiB against 2048. That's a 4% margin — one traffic
   burst or one extra native allocation from OOMKilled.
4. Fix: cap the heap at 60% (`0x3C`) → 1229 MiB heap + 430 MiB native =
   ~1.7 GiB steady, ~350 MiB margin. Or keep 75% and raise the limit to
   3 Gi — a sizing decision, not a GC one.

```yaml
env:
  - name: DOTNET_GCHeapHardLimitPercent
    value: "0x3C"   # hex! 0x3C = 60% of the container memory limit
  - name: DOTNET_GCHighMemPercent
    value: "0x50"   # hex! start aggressive GC at 80% of the heap cap
```

Then load-test and confirm with `dotnet-counters` (`GC Heap Size` vs
`Working Set`) from the [diagnostics toolbox](/dotnet/diagnostics/).

## ReadyToRun and Native AOT: the honest paragraph

**ReadyToRun** (`PublishReadyToRun=true`) precompiles IL to native code in
the image: 30–60% faster cold start, lower startup CPU (which matters when
your CPU limit is small and your
[startup probe](/tuning/health-check-knobs/) is impatient), at the cost of
a 2–3× larger app layer and slightly worse steady-state code quality until
tiered compilation recompiles hot paths. There is no diagnostic downside.
Take it for anything that autoscales.

**Native AOT** is a different contract. You get single-digit-millisecond
starts and dramatically smaller RSS — and you give up the JIT, dynamic
loading, much of reflection, *and most of this section's toolbox*: no
EventPipe diagnostic socket, so no `dotnet-dump`/`dotnet-trace`/
`dotnet-counters`/dotnet-monitor, and crash-dump analysis loses most of the
managed view SOS gives you. Observability has to come from
[OpenTelemetry](/observability/tracing/) wired in at build time and
platform-level profilers. Choose it for CLI tools, scale-to-zero
functions, and sidecar-sized utilities — not for the big stateful API you'll
be debugging at 3 a.m.

## A production Dockerfile

Enough theory about knobs — here's the image they run in. A correct
multi-stage build, annotated for the decisions that actually matter in a pod:

```dockerfile
# ---- build stage: the SDK, thrown away in the final image ----
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# Copy ONLY the project file(s) first and restore. This layer is cached
# and reused on every build where dependencies didn't change — the single
# biggest CI build-time win. (Multi-project? Copy each .csproj to its path.)
COPY MyApi.csproj ./
RUN dotnet restore

# Now the rest of the source. Editing code invalidates from here down,
# but the restore layer above stays warm.
COPY . .
RUN dotnet publish -c Release -o /app/publish --no-restore

# ---- runtime stage: no SDK, no compilers, just the app ----
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS final
WORKDIR /app
COPY --from=build /app/publish .

# Modern MS images ship a built-in non-root user; $APP_UID resolves to it
# (uid 1654). No useradd, no chown dance.
USER $APP_UID

# .NET 8+ containers default to ASPNETCORE_HTTP_PORTS=8080 (older images
# used port 80 as root). Declaring it is documentation for the reader; set
# your containerPort / Service targetPort to 8080 to match — see
# /dotnet/aspnetcore-on-k8s/.
EXPOSE 8080

# Exec form (JSON array), NOT shell form. Shell form wraps the app in
# /bin/sh -c, which does not forward SIGTERM — the app never drains and gets
# SIGKILLed at the grace deadline. See /workloads/graceful-shutdown/.
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

A few substitutions worth knowing:

- **Non-web apps** (workers, CLIs) don't need Kestrel — use the smaller
  `mcr.microsoft.com/dotnet/runtime:8.0` runtime image instead of `aspnet`,
  and drop the `EXPOSE`/port env entirely.
- **Minimal base**: `mcr.microsoft.com/dotnet/aspnet:8.0-jammy-chiseled` is
  a shell-less, package-manager-less, non-root image (the same uid 1654) —
  smaller surface, smaller CVE count, and it already runs as `$APP_UID` by
  default. The trade-off is debugging: no shell means no `kubectl exec … sh`,
  no `kubectl cp`, no copying a tool in. Plan your diagnostics around
  dotnet-monitor or ephemeral containers first — [Dumps and
  diagnostics](/dotnet/diagnostics/) covers exactly what shell-less costs you.
- **Trimming / Native AOT** (`PublishTrimmed=true`, or full AOT) shrink the
  image further by stripping unused IL, but the trimmer can't see
  reflection-based code and AOT drops the diagnostic socket entirely — you
  can lose serializers, DI edge cases, and most of the diagnostics toolbox.
  Honest default: ship untrimmed unless the image size is a real constraint
  and you've tested the trimmed output end to end.

Microsoft's ["Containerize a .NET app"
guide](https://learn.microsoft.com/dotnet/core/docker/build-container) is the
canonical reference for the image variants and the `$APP_UID` convention.

## Recipes: env blocks by pod size

Set these in the Deployment (see
[Environment variables](/workloads/environment-variables/) for the
mechanics), not the Dockerfile — you'll want to change them without a
rebuild.

**Small** (≤ 1 CPU, 256–512 MiB — workers, webhooks):

```yaml
env:
  - name: DOTNET_gcServer
    value: "0"                      # Workstation GC
  - name: DOTNET_GCConserveMemory
    value: "5"
  - name: DOTNET_GCHeapHardLimitPercent
    value: "0x3C"                   # hex = 60%; native share is big in small pods
```

**Standard** (2 CPU, 1–2 GiB — typical API, .NET 8+):

```yaml
env:
  - name: DOTNET_gcServer
    value: "1"
  - name: DOTNET_GCDynamicAdaptationMode
    value: "1"                      # DATAS: server throughput, adaptive RSS
  - name: DOTNET_GCHeapHardLimitPercent
    value: "0x3C"                   # hex = 60%
  - name: DOTNET_GCHighMemPercent
    value: "0x50"                   # hex = 80%
```

**Large** (≥ 4 CPU, ≥ 4 GiB — throughput-critical):

```yaml
env:
  - name: DOTNET_gcServer
    value: "1"
  # DATAS optional here; classic Server GC squeezes out the last few %
  - name: DOTNET_GCHeapHardLimitPercent
    value: "0x46"                   # hex = 70%; native is a smaller fraction
  - name: DOTNET_PROCESSOR_COUNT
    value: "4"                      # match the CPU limit explicitly
```

None of these are magic; all of them are starting points you validate with
counters under production-shaped load. When the working set still climbs
past your model, stop tuning and go get evidence —
[Dumps and diagnostics](/dotnet/diagnostics/) is next.
