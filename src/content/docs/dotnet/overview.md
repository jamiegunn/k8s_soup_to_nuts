---
title: .NET on Kubernetes
description: Diagnosing and operating .NET services in runtime-only containers — the EventPipe toolbox, dotnet-monitor, and how the story differs from Java's.
sidebar:
  order: 1
---

Your production images are built on `mcr.microsoft.com/dotnet/aspnet` — the
runtime, not the SDK. No `dotnet-dump`, no `dotnet-trace`, no compiler, no
NuGet. Increasingly they're the chiseled Ubuntu or Azure Linux distroless
variants, which means **no shell either**: `kubectl exec -it ... -- sh` returns
`exec: "sh": executable file not found`. And you don't own the node.

What you do have: namespace-scoped kubectl, `exec` into your own pods (when
there's something to exec), `kubectl debug` if RBAC allows ephemeral
containers, port-forward, and a CI/CD pipeline that can change environment
variables and pod specs. That is enough. This section shows you how to get
memory dumps, GC heap graphs, CPU traces, thread stacks, and live runtime
metrics out of a runtime-only .NET pod.

If you came here from the Java section: this is the same book with a
different runtime. The constraint is identical to
[JRE-only Java](/java/overview/); the mechanics are pleasantly different.

:::note[The one-sentence version of the whole section]
Every .NET process exposes a diagnostics socket in its own `/tmp` — no SDK
required in the image — so anything that can reach that socket (a
dotnet-monitor sidecar, an ephemeral container, a copied-in single-file tool)
can pull dumps, traces, and metrics; and `DOTNET_DbgEnableMiniDump=1` pointed
at a volume is your crash-time insurance, exactly like
`HeapDumpOnOutOfMemoryError`.
:::

## How .NET diagnostics work (and why the SDK doesn't matter)

Java's classic tools use the JVM attach protocol; .NET's use **EventPipe and
the diagnostic IPC socket**. Every CoreCLR process (3.0+) creates a Unix
domain socket at startup:

```console
/tmp/dotnet-diagnostic-1-7261-socket
```

The `dotnet-*` diagnostic tools are *clients* of that socket. They never need
to run inside your image — they need to be able to **connect to that socket
as a compatible UID**. That single fact drives every technique in this
section:

- The runtime in your image already contains everything needed to *produce*
  dumps, traces, and counters. Only the *requesting* tool is missing.
- The blessed production answer is the official
  [dotnet-monitor](https://mcr.microsoft.com/product/dotnet/monitor/about)
  **sidecar**: it speaks the socket protocol and exposes an HTTP API to
  trigger dumps/traces/metrics — where Java needs jattach tricks or an
  ephemeral JDK, .NET has a supported, Microsoft-shipped container for the
  job.
- Ephemeral containers (`kubectl debug`) still work as the ad-hoc route, with
  a `/tmp`-sharing dance covered in
  [Dumps and diagnostics](/dotnet/diagnostics/).

The other big difference from Java: crash-dump behavior is an environment
variable (`DOTNET_DbgEnableMiniDump`), not a JVM flag, so you can turn it on
from the pod spec without touching the image.

## Decision table: evidence → technique

| I need... | Runtime-only route | Runs where? | Article |
|---|---|---|---|
| Thread stacks (what is every thread doing?) | `dotnet-stack report`, or `dotnet-dump` + `clrstack -all` | Sidecar or ephemeral container, over the socket | [Diagnostics](/dotnet/diagnostics/) |
| Live runtime metrics (GC, thread pool, exceptions/sec) | `dotnet-counters monitor`, or dotnet-monitor `/livemetrics` | Sidecar or ephemeral container | [Diagnostics](/dotnet/diagnostics/) |
| "What's filling the heap" cheaply | `dotnet-gcdump` (heap *graph*, MBs not GBs, low pause) | Sidecar or ephemeral container; file lands on the tool's side | [Diagnostics](/dotnet/diagnostics/) |
| Full memory dump for deep analysis | `dotnet-dump collect`, or dotnet-monitor `/dump` | Requested over the socket; **written by the target** — needs a volume | [Diagnostics](/dotnet/diagnostics/) |
| Dump automatically when the process crashes | `DOTNET_DbgEnableMiniDump=1` + `DbgMiniDumpName` on a volume — set it *today* | The runtime itself; no tools involved | [Diagnostics](/dotnet/diagnostics/) |
| CPU profile / who's burning cycles | `dotnet-trace collect --profile cpu-sampling` | Sidecar or ephemeral container | [Diagnostics](/dotnet/diagnostics/) |
| Why the container died at exit 137 | That's the kernel OOM killer, not the CLR — different workflow | — | [OOMKilled](/troubleshooting/oomkilled/) |
| Right-size GC heap vs container limit | Understand the 75% default and the non-GC budget first | — | [.NET in containers](/dotnet/dotnet-in-containers/) |
| Probes, shutdown, config reload for ASP.NET Core | The Spring-Boot-equivalent checklist | — | [ASP.NET Core on K8s](/dotnet/aspnetcore-on-k8s/) |

## Coming from the Java section? The translation table

| Java concept | .NET equivalent | Notes |
|---|---|---|
| JVM attach protocol / jattach | EventPipe diagnostic socket in `/tmp` | Socket exists by default; `DOTNET_EnableDiagnostics=0` kills it |
| `kill -3` thread dump to stdout | No signal equivalent — use `dotnet-stack` over the socket | The one place Java is more convenient |
| `-XX:+HeapDumpOnOutOfMemoryError` | `DOTNET_DbgEnableMiniDump=1` + `DbgMiniDumpType` | Fires on *crashes* incl. unhandled `OutOfMemoryException`; not on SIGKILL |
| `.hprof` + Eclipse MAT | ELF core dump + `dotnet-dump analyze` (SOS) | Analysis REPL ships with the tool |
| Class histogram | `dumpheap -stat` inside `dotnet-dump analyze`, or a gcdump | |
| JFR continuous recording | `dotnet-trace` / EventPipe; dotnet-monitor triggers | No exact always-on ring-buffer twin baked into the runtime |
| Ephemeral JDK container | Ephemeral SDK-plus-tools container, or the dotnet-monitor sidecar | Sidecar is the production-grade answer |
| `MaxRAMPercentage` (default 25%) | `GCHeapHardLimitPercent` (default **75%** in containers) | Opposite defaults — see [.NET in containers](/dotnet/dotnet-in-containers/) |

## First: inventory what your runtime actually is

Do this before an incident, against a real pod or the exact image.

```bash
# Framework-dependent app on a runtime image: the muxer exists, even chiseled
kubectl exec myapi-6f9d8b7c44-qx2lp -- dotnet --info
```

```console
Host:
  Version:      8.0.11
  Architecture: x64
  Commit:       xxxxxxxxxx

.NET runtimes installed:
  Microsoft.AspNetCore.App 8.0.11 [/usr/share/dotnet/shared/Microsoft.AspNetCore.App]
  Microsoft.NETCore.App 8.0.11 [/usr/share/dotnet/shared/Microsoft.NETCore.App]
```

No SDKs listed — expected. If instead you get
`exec: "dotnet": executable file not found`, the app is self-contained or
Native AOT (no muxer at all); if `sh` is also missing you're on a chiseled or
distroless base. In that case, identify the runtime without exec:

```bash
# The official images bake version env vars into the image config
kubectl get pod myapi-6f9d8b7c44-qx2lp -o jsonpath='{.spec.containers[0].image}'
docker inspect mcr.microsoft.com/dotnet/aspnet:8.0-noble-chiseled \
  --format '{{json .Config.Env}}' | tr ',' '\n' | grep -E 'DOTNET_VERSION|ASPNET_VERSION'
```

```console
"DOTNET_VERSION=8.0.11"
"ASPNET_VERSION=8.0.11"
```

And the app's own `*.deps.json` (in `/app` next to the entry assembly)
records the exact target framework and runtime pack — readable in CI where
you built the image, or from an ephemeral container via `/proc/1/root/app/`.
Also worth recording in your runbook, once:

- **Is there a shell?** `kubectl exec <pod> -- sh -c 'echo yes'` — chiseled
  and distroless say no, which removes `kubectl cp` and inline scripting.
- **What UID?** .NET 8+ official images default to user `app`, UID 1654.
  The diagnostic socket is owned by that UID; tools must match it.
- **Is `/tmp` writable?** `readOnlyRootFilesystem: true` without an
  `emptyDir` at `/tmp` means *no diagnostic socket at all*.
- **Is `DOTNET_EnableDiagnostics` set to 0 anywhere?** Some security
  baselines set it; it silently disables everything in this section.

## Where your access ends

Everything here works with namespace-scoped kubectl, with the usual edges:
ephemeral containers need the `pods/ephemeralcontainers` RBAC verb;
node-level evidence (kubelet logs, `dmesg` OOM-killer lines) belongs to the
platform team — ask, with pod name and timestamp; and perf-based native
profiling is gated by node sysctls you can't change. The dotnet-monitor
sidecar needs none of that — it's just another container in your own pod
spec, which is exactly why it's the recommended door.

## What's in this section

- [.NET in containers](/dotnet/dotnet-in-containers/) — cgroup awareness,
  `Environment.ProcessorCount`, Server vs Workstation GC (the decision that
  makes or breaks small pods), the memory knobs table, and a worked sizing
  example against [requests and limits](/workloads/resources-and-qos/).
- [Dumps and diagnostics](/dotnet/diagnostics/) — the flagship: every way to
  get dumps, traces, and counters out of a runtime-only pod, with the
  dotnet-monitor sidecar YAML spelled out and the ephemeral-container socket
  dance explained honestly.
- [ASP.NET Core on Kubernetes](/dotnet/aspnetcore-on-k8s/) — health checks
  done right, graceful shutdown math, configuration reload, Kestrel behind
  an ingress, and a complete reference Deployment.

If you operate Java services too, [Java on Kubernetes](/java/overview/) is
this section's older sibling — the transport tricks in
[Getting dumps out](/java/getting-dumps-out/) apply verbatim to `.dmp` and
`.nettrace` files.
