---
title: Dumps and Diagnostics (Runtime-Only Images)
description: Every way to get memory dumps, GC heap graphs, CPU traces, and thread stacks out of a .NET pod that ships no SDK — dotnet-monitor, ephemeral containers, and crash dumps.
sidebar:
  order: 3
---

The tools every .NET troubleshooting guide reaches for — `dotnet-dump`,
`dotnet-trace`, `dotnet-counters` — are SDK-era global tools that do not
exist in your `mcr.microsoft.com/dotnet/aspnet` image. Good news: **they
never needed to be there.** They are clients. The server is already running
inside your container.

## The diagnostic socket: the load-bearing fact

Every CoreCLR process creates an EventPipe diagnostics IPC endpoint at
startup — a Unix domain socket in its temp directory:

```console
/tmp/dotnet-diagnostic-1-7261-socket
```

(`1` = PID inside the container, the second number disambiguates restarts.)
Everything in this article is a strategy for getting a client to that
socket:

- **Door A — dotnet-monitor sidecar**: the production answer. Official
  image, HTTP API, always there when the incident starts.
- **Door B — ephemeral container** (`kubectl debug`): the ad-hoc answer,
  with a `/tmp` dance explained honestly below.
- **Door C — copy a single-file tool in**: works only on images with a
  shell and tar.

Plus the one mechanism that needs no client at all: **crash dumps written
by the runtime itself** (`DOTNET_DbgEnableMiniDump`), which you should
configure today, while nothing is on fire.

## The tool menu — and where things actually run

| Tool | Gets you | Output written by | Practical size |
|---|---|---|---|
| `dotnet-counters` | Live metrics: GC, thread pool, exceptions/sec | The tool (stdout/CSV) | tiny |
| `dotnet-stack report` | Thread stacks, right now | The tool (stdout) | tiny |
| `dotnet-gcdump` | Heap *graph* — types, counts, roots; low pause | **The tool's filesystem** (streamed over the socket) | MBs |
| `dotnet-trace` | CPU sampling / EventPipe events (`.nettrace`) | **The tool's filesystem** | MBs–100s of MBs |
| `dotnet-dump` | Full process dump + SOS analysis REPL | **The target process** (runtime spawns `createdump`) | ≈ working set (GBs) |

That last column is the one people trip on: `gcdump` and `trace` files
appear where the *client* runs (easy to retrieve), but a full dump is
written by the *target* into the *target's* filesystem — so the output path
must be writable inside your app container, ideally a volume. Full dumps
also pause the process for seconds and briefly double committed memory;
prefer `gcdump` when the question is "what's on the heap".

## Door A: the dotnet-monitor sidecar (do this one)

[dotnet-monitor](https://github.com/dotnet/dotnet-monitor) is Microsoft's
purpose-built diagnostics proxy: a small container that connects to your
app's diagnostic socket and exposes an HTTP API — dumps, gcdumps, traces,
live metrics, even a Prometheus endpoint. It is to .NET what the
ephemeral-JDK trick wishes it were for [Java](/java/overview/): supported,
declarative, and present *before* the incident. General sidecar plumbing is
covered in [Sidecars](/sidecars/overview/); here's the .NET-specific wiring.

The app and the sidecar rendezvous over a shared Unix socket volume
("listen mode" — the app dials out to the monitor, which also works when
the app's `/tmp` isn't shared):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapi
spec:
  replicas: 3
  selector:
    matchLabels: { app: myapi }
  template:
    metadata:
      labels: { app: myapi }
    spec:
      containers:
        - name: myapi
          image: registry.example.com/myapi:1.14.2   # aspnet:8.0-noble-chiseled base
          env:
            # App connects OUT to the monitor's socket on the shared volume.
            # nosuspend: don't block startup waiting for the sidecar.
            - name: DOTNET_DiagnosticPorts
              value: /diag/monitor.sock,nosuspend
          volumeMounts:
            - name: diag
              mountPath: /diag
            - name: dumps
              mountPath: /dumps
            - name: tmp
              mountPath: /tmp        # emptyDir so the diagnostic socket exists
                                     # even with readOnlyRootFilesystem: true
        - name: monitor
          image: mcr.microsoft.com/dotnet/monitor:9
          args: ["collect", "--urls", "http://localhost:52323", "--no-auth"]
          env:
            - name: DotnetMonitor_DiagnosticPort__ConnectionMode
              value: Listen
            - name: DotnetMonitor_DiagnosticPort__EndpointName
              value: /diag/monitor.sock
            - name: DotnetMonitor_Storage__DefaultSharedPath
              value: /dumps
          # Must share a UID with the app so socket permissions line up.
          securityContext:
            runAsUser: 1654          # 'app' in .NET 8+ official images
          volumeMounts:
            - name: diag
              mountPath: /diag
            - name: dumps
              mountPath: /dumps
          resources:
            requests: { cpu: 20m, memory: 64Mi }
            limits: { memory: 256Mi }
      volumes:
        - name: diag
          emptyDir: {}
        - name: dumps
          emptyDir: { sizeLimit: 4Gi }
        - name: tmp
          emptyDir: {}
```

:::caution[suspend vs nosuspend, and who starts first]
`DOTNET_DiagnosticPorts=<path>` **defaults to `suspend`**: the app halts
before `Main` until a monitor connects — invaluable when you need startup
traces, a startup deadlock when the sidecar crashes or starts late. Use
`nosuspend` unless you're actively chasing startup behavior, and if you do
need `suspend`, make the monitor a native sidecar (init container with
`restartPolicy: Always`) so ordering is guaranteed — the details live in
[Sidecar lifecycle and ordering](/sidecars/lifecycle-and-ordering/).
:::

The alternative wiring — "connect mode" — is even simpler: mount the *same*
`emptyDir` at `/tmp` in both containers and set nothing at all; the monitor
discovers sockets in `/tmp` on its own. It costs you a shared temp
directory between the containers, which is usually fine and also solves the
read-only-rootfs problem in one move.

Using it — the port is bound to localhost in the pod, so reach it with
port-forward (deliberately: `--no-auth` is acceptable only because nothing
outside the pod can connect; if you expose the port on the pod IP,
configure API-key auth):

```bash
kubectl port-forward myapi-6f9d8b7c44-qx2lp 52323:52323 &

curl -s localhost:52323/processes | jq
```

```console
[{ "pid": 1, "uid": "b6f50f4d-…", "name": "MyApi", "isDefault": true }]
```

```bash
# Live metrics for 30 s; a gcdump; a full dump; a 30 s CPU trace
curl -s "localhost:52323/livemetrics?durationSeconds=30"
curl -sOJ "localhost:52323/gcdump"
curl -sOJ "localhost:52323/dump?type=WithHeap"
curl -sOJ "localhost:52323/trace?durationSeconds=30"
```

`-OJ` saves the file with the server-provided name in your *current
directory on your laptop* — dotnet-monitor streams artifacts over HTTP, so
for gcdumps and traces there is no "getting files out of the pod" step at
all. For multi-GB full dumps over flaky connections, configure an egress
provider (S3-compatible or Azure Blob, dotnet-monitor 8+) and use the
`/dump?egressProvider=...` form instead; it writes straight from the pod to
object storage. dotnet-monitor can also fire *triggers* (dump when CPU > X
or working set > Y) — turn that on before the heisenbug's next visit.

## Door B: ephemeral container with the tools

No sidecar deployed and the pod is misbehaving *right now*:

```bash
kubectl debug -it myapi-6f9d8b7c44-qx2lp \
  --image=registry.example.com/dotnet-debug:9 \
  --target=myapi -- bash
```

Two honesty checks before the commands:

**1. The SDK image does not include the tools.** `dotnet tool install`
inside the debug container needs NuGet egress you may not have. Bake a
debug image once, in CI:

```text
# dotnet-debug.Dockerfile
FROM mcr.microsoft.com/dotnet/sdk:9.0
RUN dotnet tool install -g dotnet-dump && \
    dotnet tool install -g dotnet-gcdump && \
    dotnet tool install -g dotnet-trace && \
    dotnet tool install -g dotnet-counters && \
    dotnet tool install -g dotnet-stack
ENV PATH="${PATH}:/root/.dotnet/tools"
```

**2. The socket lives in the TARGET's `/tmp` — which you don't have.**
`--target` shares the *process* namespace, not mounts. Your debug
container's `/tmp` is empty; the socket is in the app container's `/tmp`.
The escape hatch: with a shared PID namespace, the target's root
filesystem is visible at `/proc/1/root/`, and the tools locate sockets via
the `TMPDIR` environment variable. So:

```bash
# inside the debug container
export TMPDIR=/proc/1/root/tmp     # look for sockets in the target's /tmp
dotnet-counters ps
```

```console
1  MyApi  /usr/share/dotnet/dotnet  /usr/bin/dotnet MyApi.dll
```

```bash
dotnet-stack report -p 1                    # stacks to your terminal
dotnet-gcdump collect -p 1 -o /tmp-local.gcdump   # written in the DEBUG container
dotnet-dump collect -p 1 -o /tmp/big.dmp    # written by the TARGET → its /tmp
ls -lh /proc/1/root/tmp/big.dmp             # retrieve via procfs
```

Caveats, honestly stated: `/proc/1/root` is only traversable if your debug
container runs as the **same UID** as the target (or root, where the
cluster allows it) — .NET 8+ official images run as UID 1654, and the SDK
image defaults to root, so on hardened clusters that force
`runAsNonRoot` you'll need a debug profile that sets `runAsUser: 1654`.
Socket *connections* have the same UID rule. And `kubectl debug` needs the
`pods/ephemeralcontainers` RBAC verb. If any of that is blocked, that's
the argument for Door A in your standard pod template.

The truly robust variant is boring: mount an `emptyDir` at `/tmp` in your
app container *as standard practice* (you did for read-only rootfs anyway),
and when debugging, mount the same volume into the ephemeral container —
no procfs tricks, sockets and dumps just appear on both sides.

## Door C: copy a single-file tool into the pod

Microsoft publishes self-contained single-file builds of the diagnostic
tools (e.g. `https://aka.ms/dotnet-dump/linux-x64`) that run without an
SDK. If — and only if — your image has a shell and `tar`:

```bash
curl -L -o dotnet-dump https://aka.ms/dotnet-dump/linux-x64   # mirror this internally
kubectl cp ./dotnet-dump myapi-6f9d8b7c44-qx2lp:/tmp/dotnet-dump
kubectl exec myapi-6f9d8b7c44-qx2lp -- chmod +x /tmp/dotnet-dump
kubectl exec myapi-6f9d8b7c44-qx2lp -- /tmp/dotnet-dump collect -p 1 -o /tmp/live.dmp
```

Running *inside* the target container, there are no namespace or UID games —
this is the closest .NET gets to the jattach trick. It dies on
chiseled/distroless images (no shell, no tar, so no `kubectl cp` either).
Pull binaries only from a repository you control, and check the tool's
glibc expectations against your base image.

## Crash dumps: the HeapDumpOnOutOfMemoryError twin

Configure the runtime to write a dump when the process crashes — unhandled
exception (including `OutOfMemoryException`), SIGSEGV, SIGABRT:

```yaml
env:
  - name: DOTNET_DbgEnableMiniDump
    value: "1"
  - name: DOTNET_DbgMiniDumpType
    value: "2"                     # 1=Mini 2=WithHeap(default) 3=Triage 4=Full
  - name: DOTNET_DbgMiniDumpName
    value: /dumps/crash-%p-%t.dmp # %p=pid %t=unix time; templates avoid overwrites
volumeMounts:
  - name: dumps
    mountPath: /dumps
volumes:               # pod-level
  - name: dumps
    emptyDir:
      sizeLimit: 4Gi
```

The same "point it at a volume" rule as Java's `HeapDumpPath`, for the same
two reasons: a dump on the writable layer counts against ephemeral storage
(hello, eviction) and evaporates when the container restarts — which, after
a crash, it will. An `emptyDir` survives container restarts; size it at
roughly the working set for `WithHeap`, several × for `Full`.

:::danger[This does NOT fire on OOMKilled]
Exit 137 is the kernel's SIGKILL — the runtime gets no chance to write
anything, exactly like the JVM. `DbgEnableMiniDump` covers *managed* OOM
and crashes. For cgroup OOM kills, your evidence is metrics before death
and a proactive `dotnet-dump`/`gcdump` while the working set climbs — the
workflow in [OOMKilled](/troubleshooting/oomkilled/).
:::

## Getting dumps out

A 2 GiB `.dmp` in an `emptyDir` leaves the pod the same way an `.hprof`
does: `kubectl cp` when the image has tar, `kubectl exec … cat`/base64
streaming when it doesn't, object-storage egress when it's huge — all
covered once in [Getting dumps out](/java/getting-dumps-out/), and every
word applies here. dotnet-monitor's HTTP streaming and egress providers
(Door A) exist precisely so you can skip that article. Whatever the route:
`gzip` first — dumps routinely deflate 5–10×.

## Analyzing what you caught

`dotnet-dump analyze` bundles SOS — no Visual Studio, no Windows, runs on
your laptop against a Linux dump (match major runtime versions):

```console
$ dotnet-dump analyze crash-1-1751536142.dmp
Loading core dump: crash-1-1751536142.dmp ...
Ready to process analysis commands. Type 'help' to list available commands ...
> clrstack
OS Thread Id: 0x1 (0)
        Child SP               IP Call Site
00007FFEB2E3C6A0 00007f31c2a4e12b [HelperMethodFrame_1OBJ] System.Threading.Monitor.ObjWait(Int32, System.Object)
00007FFEB2E3C7D0 00007f31445a9f01 MyApi.Services.ReportCache.GetOrBuild(System.String)
00007FFEB2E3C830 00007f31445a9d47 MyApi.Controllers.ReportsController.Get(System.String)
...
> dumpheap -stat
Statistics:
          MT    Count    TotalSize Class Name
7f3144a81ce8   41,203    2,636,992  Microsoft.Data.SqlClient.SqlCommand
7f3143f01b20  612,440   58,794,240  System.String
7f3143f2d708   38,912  318,504,960  System.Byte[]
7f3144b3fa40  204,800  511,180,800  MyApi.Models.ReportRow
Total 1,204,511 objects, 912,338,182 bytes
```

`ReportRow` at 500 MB is your suspect; ask who's holding it:

```console
> dumpheap -mt 7f3144b3fa40 -short
00007f30d4a81030
...
> gcroot 00007f30d4a81030
HandleTable:
    00007f31c4c015f8 (strong handle)
    -> 00007f30c8000018 MyApi.Services.ReportCache
    -> 00007f30c8000040 System.Collections.Concurrent.ConcurrentDictionary<System.String, MyApi.Models.Report>
    -> ... -> 00007f30d4a81030 MyApi.Models.ReportRow
```

A cache with no eviction — the .NET rendition of the oldest song. For
`clrstack -all` read every thread; for thread-pool starvation look for
dozens of threads parked in `Monitor.Wait` under sync-over-async frames.

`.gcdump` files open in Visual Studio (Memory Usage tool) or
[PerfView](https://github.com/microsoft/perfview) (`GC Heap Net Mem Stacks`)
and diff cleanly: capture two, ten minutes apart, and let the delta point at
the leak. `.nettrace` files open in PerfView, Visual Studio, or convert with
`dotnet-trace convert --format speedscope` for a flame graph in the browser.

## Environment traps checklist

- **Chiseled/distroless image**: no shell → no `exec` scripting, no
  `kubectl cp` (needs tar). Doors A and B are your *only* doors. Decide
  that before the incident.
- **`readOnlyRootFilesystem: true`**: the runtime can't create the socket
  in `/tmp` — it fails *silently*; the app runs, diagnostics don't exist.
  Mount an `emptyDir` at `/tmp`. This belongs in your standard pod
  template.
- **UID mismatch**: socket is `0600`, owned by the app's UID (1654 in
  .NET 8+ images). Sidecar and debug containers must run the same UID, or
  every tool reports "no processes found" while the process sits right
  there.
- **`DOTNET_EnableDiagnostics=0`** somewhere in the env chain disables the
  socket entirely. Grep your Helm values before you grep anything else.
- **Native AOT app**: no EventPipe socket at all — none of the doors open.
  You planned for that when you chose AOT, per
  [.NET in containers](/dotnet/dotnet-in-containers/). Right?

Prep-work summary, in the spirit of the Java section: add the crash-dump
env block and the `/tmp` + `/dumps` emptyDirs today; deploy the
dotnet-monitor sidecar (or keep its YAML one `kubectl apply` away); bake
the debug tools image in CI. Minutes now, an hour of 3 a.m. improvisation
saved later.
