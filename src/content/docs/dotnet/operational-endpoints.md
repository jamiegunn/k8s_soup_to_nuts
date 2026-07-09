---
title: ".NET Operational Endpoints"
description: "Assembling a Spring-Boot-Actuator-equivalent operational HTTP surface for .NET pods from ASP.NET Core health middleware and the dotnet-monitor sidecar API — with collection rules actuator can't match."
keywords:
  - dotnet-monitor HTTP API
  - actuator equivalent for .NET
  - collection rules triggers egress
  - /gcdump /dump /trace endpoints
  - port 52323 port-forward
  - live log streaming /logs
  - runtime log level change gap
  - EventCounter trigger high cpu
  - dotnet-monitor API key auth
  - Prometheus /metrics separate port
  - automatic dump on high CPU
sidebar:
  order: 5
---

Spring Boot ships an ops API in the framework: add one dependency and
`/actuator/*` exists. .NET ships **no actuator**. The equivalent surface is
assembled from two pieces you already met in this section:

1. **ASP.NET Core middleware you add** — health checks mapped to probe
   endpoints, covered in [ASP.NET Core on Kubernetes](/dotnet/aspnetcore-on-k8s/).
2. **The dotnet-monitor sidecar's HTTP API** — introduced as dump *tooling*
   in [Diagnostics](/dotnet/diagnostics/); here it's what it actually is: a
   full operational API for the pod, actuator's twin with a different shape.

The split means the ops surface lives on a **different port than your
app** (the sidecar's 52323) — a security feature, it turns out. If you
also run JVM services, read this side by side with
[the actuator article](/java/actuator/); the two are written as mirrors.

## The translation table

| Actuator endpoint | .NET equivalent | Notes |
|---|---|---|
| `/actuator/health` | `MapHealthChecks` in the app | In-process, on the app port — see [ASP.NET Core on K8s](/dotnet/aspnetcore-on-k8s/); probe discipline in [Health checks](/workloads/health-checks/) |
| `/actuator/threaddump` | monitor `/stacks`, or `/dump?type=Mini` | `/stacks` needs the in-process features flag (experimental — below) |
| `/actuator/heapdump` | monitor `/gcdump` (graph) + `/dump?type=WithHeap` (full) | Two-tier where Java has one; `/gcdump` is the cheap first move |
| `/actuator/metrics`, `/prometheus` | monitor `/metrics`, or OTel exporter in-app | Prometheus text with zero app changes — [Metrics](/observability/metrics/) |
| `/actuator/loggers` (GET) | monitor `/logs` — live structured log *streaming* | Filterable by level/category at read time |
| `/actuator/loggers` (POST) | **none** — the honest gap | No runtime level change over HTTP; workaround is ConfigMap reload, per [ASP.NET Core on K8s](/dotnet/aspnetcore-on-k8s/) |
| `/actuator/env` | monitor `/env` (process env block) | Raw env vars only |
| `/actuator/configprops` | **none** — the other gap | The merged `IConfiguration` view has no endpoint; `/processes` + `/info` give process-level basics |
| `/actuator/info` | monitor `/info` | Monitor + runtime version, connection mode |
| `/actuator/shutdown` | **none** | Good. Kubernetes owns lifecycle; so should it on the JVM |

Everything labeled "monitor" is served by the sidecar on port 52323 via
the diagnostic socket — no code in your app, works on chiseled
runtime-only images.

## The API tour, endpoint by endpoint

All of these assume the sidecar wiring from
[Diagnostics](/dotnet/diagnostics/) and a port-forward (never a Service):

```bash
kubectl port-forward myapi-6f9d8b7c44-qx2lp 52323:52323 &
```

**`/processes` — discovery.** The monitor may see more than one process
(rare in containers, normal on shared sockets). Everything else takes
`?pid=` or `?uid=`; with a single default process you can omit it:

```bash
curl -s localhost:52323/processes | jq -c
```

```json
[{"pid":1,"uid":"b6f50f4d-8c1e-4c0a-9d38-2f6e1a0c9b77","name":"MyApi","isDefault":true}]
```

**`/info` — the monitor's own identity** (actuator `info`, roughly):
version, runtime version, diagnostic port mode and path. `/env?pid=1`
returns the process's environment block as JSON — actuator's `env`, minus
the merged-configuration half.

**`/gcdump` — the heap graph, the safe first move.** Object types, counts,
sizes, and roots; seconds of pause, tens of megabytes streamed straight to
your laptop (vs gigabytes for a full dump):

```bash
curl -sOJ localhost:52323/gcdump    # → 20260703_101412_1.gcdump, 38 MB
```

**`/dump` — the full process dump.** Actuator's `heapdump` with more
control: `?type=Mini|WithHeap|Triage|Full`. Sizes at roughly the working
set — gigabytes — and briefly pauses the process. Past a few hundred MB,
skip streaming: `/dump?egressProvider=artifacts` writes pod-to-storage
directly (transport trade-offs in [Getting dumps out](/java/getting-dumps-out/)):

```bash
curl -sOJ "localhost:52323/dump?type=WithHeap"
```

**`/trace` — EventPipe profiles over HTTP.** This is the workflow actuator
never had: "get me a 30-second CPU profile of production, now, with no
agent restart":

```bash
curl -sOJ "localhost:52323/trace?profile=Cpu&durationSeconds=30"
```

The call blocks for the duration, then delivers a `.nettrace` — open in
PerfView, or `dotnet-trace convert --format speedscope` for a browser flame
graph. Profiles: `Cpu`, `Http`, `GcCollect`, `Metrics`, `Logs`, comma-combinable.

**`/stacks` — thread stacks (actuator `threaddump`).** Honest caveat:
requires **in-process features** — a component injected into the target,
still marked experimental. Enable deliberately:

```yaml
# on the monitor container
- name: DotnetMonitor_InProcessFeatures__Enabled
  value: "true"
```

```bash
curl -s -H "Accept: application/json" localhost:52323/stacks | jq '.stacks | length'
```

If you'd rather not run experimental features in production, a
`/dump?type=Mini` analyzed with `dotnet-dump analyze` → `clrstack -all` is
the boring, supported thread dump.

**`/metrics` — Prometheus text.** `System.Runtime` counters (GC, thread
pool, exceptions, allocation rate) by default; add your own
`System.Diagnostics.Metrics` Meters by name
(`DotnetMonitor_Metrics__Providers__0__ProviderName: MyApi.Checkout`). Runtime metrics
with zero app changes — scraping in [Metrics](/observability/metrics/):

```console
$ curl -s localhost:52323/metrics | grep -A1 heap_size
# TYPE systemruntime_gc_heap_size_bytes gauge
systemruntime_gc_heap_size_bytes 412090368 1751536142000
```

**`/livemetrics` — the incident view.** The same counters streamed as JSON
for a bounded window — `dotnet-counters monitor` over HTTP:

```bash
curl -s "localhost:52323/livemetrics?durationSeconds=15"
```

**`/logs` — live structured log streaming.** Actuator's `loggers` GET half,
done better: tap the app's `ILogger` stream at whatever level you ask for,
*without changing the app's configured level*, filtered by category:

```bash
curl -s -H "Accept: application/x-ndjson" \
  "localhost:52323/logs?durationSeconds=60&level=Debug&filterSpecs=MyApi.Services.ReportCache"
```

```json
{"Timestamp":"2026-07-03T10:16:02.114Z","LogLevel":"Debug","Category":"MyApi.Services.ReportCache","Message":"Cache miss for key reports/2026-07/emea","State":{"key":"reports/2026-07/emea"}}
{"Timestamp":"2026-07-03T10:16:02.371Z","LogLevel":"Debug","Category":"MyApi.Services.ReportCache","Message":"Built report in 214ms, 18432 rows","State":{"elapsedMs":214,"rows":18432}}
```

One precision worth internalizing: `/logs` taps events via EventPipe — it
can capture Debug even while your sinks write Information — but it does
**not** change what the app writes to stdout
([Logging fundamentals](/observability/logging-fundamentals/)). For that
(actuator's `loggers` POST) the answer is `Logging__LogLevel__*` via
ConfigMap + `reloadOnChange` — about a minute, not instant
([ASP.NET Core on K8s](/dotnet/aspnetcore-on-k8s/)).

## Collection rules: the thing actuator doesn't have

Every endpoint above is *pull*: a human notices, connects, collects. The
CPU spike at 03:40 that self-resolved by 03:44 doesn't care how fast you
port-forward. **Collection rules** invert this — the sidecar watches
triggers and collects for you, so the trace you wish you'd taken is
already on egress storage when you sit down with your coffee.

Mount this as the monitor's settings file
(`/etc/dotnet-monitor/settings.json`, via ConfigMap):

```json
{
  "CollectionRules": {
    "HighCpuProfile": {
      "Filters": [ { "Key": "ProcessName", "Value": "MyApi" } ],
      "Trigger": {
        "Type": "EventCounter",
        "Settings": {
          "ProviderName": "System.Runtime",
          "CounterName": "cpu-usage",
          "GreaterThan": 80,
          "SlidingWindowDuration": "00:01:00"
        }
      },
      "Actions": [
        { "Type": "CollectTrace",
          "Settings": { "Profile": "Cpu", "Duration": "00:00:30", "Egress": "artifacts" } },
        { "Type": "CollectGCDump", "Settings": { "Egress": "artifacts" } }
      ],
      "Limits": { "ActionCount": 2, "ActionCountSlidingWindowDuration": "01:00:00" }
    }
  },
  "Egress": {
    "FileSystem": { "artifacts": { "DirectoryPath": "/artifacts" } }
  }
}
```

Rule anatomy, the four parts:

- **Trigger** — the tripwire: `EventCounter` (counter over a threshold,
  sustained across the window), `AspNet*` (request rate, status ratio,
  duration), or `Startup` (once at attach — "trace the first 60 s").
- **Filters** — which discovered processes the rule applies to.
- **Actions** — what to collect, in order: `CollectTrace`, `CollectGCDump`,
  `CollectDump`, `CollectLogs`, `CollectLiveMetrics`, even `Execute`.
- **Limits** — the safety rail. Without `ActionCount` + window, a flapping
  trigger fills storage with forty identical gcdumps; two per hour is
  plenty.

Where artifacts land is the **egress provider**. `FileSystem` to a volume
is the minimum viable version (emptyDir if pod-lifetime is acceptable, a
PVC if evidence must survive rescheduling); `AzureBlobStorage` and
`S3Storage` (dotnet-monitor 8+) write straight to object storage — right
for multi-GB dumps and fleets. Same transport calculus as
[Getting dumps out](/java/getting-dumps-out/), except automated:

```yaml
# monitor container: rules + egress mounted, artifacts on a volume
volumeMounts:
  - name: monitor-config
    mountPath: /etc/dotnet-monitor
    readOnly: true
  - name: artifacts
    mountPath: /artifacts
# pod volumes:
volumes:
  - name: monitor-config
    configMap: { name: myapi-monitor-rules }
  - name: artifacts
    persistentVolumeClaim: { claimName: myapi-artifacts }
```

For S3, keep credentials out of the JSON — dotnet-monitor reads any setting
from env vars, so feed `Egress__S3Storage__artifacts__SecretAccessKey` from
a Secret ([Secrets](/workloads/secrets/)).

## Deploying the surface

The full wiring is in [Diagnostics](/dotnet/diagnostics/); the recap:

```yaml
containers:
  - name: myapi
    env:
      - name: DOTNET_DiagnosticPorts
        value: /diag/monitor.sock,nosuspend   # suspend ⇒ ordering matters
    volumeMounts:
      - { name: diag, mountPath: /diag }
      - { name: tmp, mountPath: /tmp }        # socket vs readOnlyRootFilesystem
  - name: monitor
    image: mcr.microsoft.com/dotnet/monitor:9
    args: ["collect", "--urls", "http://localhost:52323"]
    env:
      - { name: DotnetMonitor_DiagnosticPort__ConnectionMode, value: Listen }
      - { name: DotnetMonitor_DiagnosticPort__EndpointName, value: /diag/monitor.sock }
    securityContext: { runAsUser: 1654 }      # must match the app's UID
    volumeMounts:
      - { name: diag, mountPath: /diag }
      - { name: monitor-config, mountPath: /etc/dotnet-monitor, readOnly: true }
```

If you use `suspend` or `Startup`-triggered rules, run the monitor as a
native sidecar (init container, `restartPolicy: Always`) so it's up before
the app — [Sidecar lifecycle and ordering](/sidecars/lifecycle-and-ordering/).

**Listen vs Connect, once.** In *Listen* mode (shown throughout) the app
dials out to the monitor's socket — deterministic, works without sharing
`/tmp`, and required for `suspend` and for rules that must see the process
from its first instruction. In *Connect* mode you configure nothing: mount
the same emptyDir at `/tmp` in both containers and the monitor discovers
sockets itself. Connect is fine for a pull-only ops API; prefer Listen once
collection rules matter.

**Sizing.** The monitor idles near zero; spikes come during collection
(buffering traces, streaming dumps). `requests: {cpu: 20m, memory: 64Mi}`,
`limits: {memory: 256Mi}` is a sane default; its requests bill against the
pod like any container's.

## Security stance

Mirror [the actuator rules](/java/actuator/), because the threat is
identical — this API dumps process memory, and dumps contain everything the
process holds: connection strings, JWTs, PII. Artifacts are Secret-grade.

- **52323 never appears on a Service or Ingress.** No exceptions. The port
  isn't even in `containerPort` lists in our manifests — port-forward
  reaches it regardless.
- **Auth is on by default — keep it when anything beyond port-forward can
  connect.** Unconfigured, dotnet-monitor generates an ephemeral API key
  and logs it — useless across restarts, so pin a real one: `dotnet-monitor
  generatekey` emits the public key + bearer token; token goes in the
  team vault, public key into a Secret ([Secrets](/workloads/secrets/)):

```yaml
env:
  - name: Authentication__MonitorApiKey__Subject
    valueFrom:
      secretKeyRef: { name: myapi-monitor-key, key: subject }
  - name: Authentication__MonitorApiKey__PublicKey
    valueFrom:
      secretKeyRef: { name: myapi-monitor-key, key: public-key }
```

```bash
curl -s -H "Authorization: Bearer $MONITOR_TOKEN" localhost:52323/processes
```

- **`--no-auth` is defensible in exactly one topology**: the monitor binds
  `localhost` inside the pod, nothing publishes the port, and the only path
  in is `kubectl port-forward` — your RBAC on `pods/portforward` *is* the
  auth. The moment the port binds `0.0.0.0`, switch to API keys. Prometheus
  never needs the privileged port: `--metricUrls http://+:52325` serves
  `/metrics` alone, unauthenticated, on its own port.
- **NetworkPolicy**: default-deny the pod, allow the app port from the
  ingress path, allow 52325 from the monitoring namespace only, allow
  nothing to 52323 — [Network policies](/networking/network-policies/).

:::danger[The dump endpoint is remote memory disclosure by design]
Anyone who can reach 52323 with a valid token — or without one, if you ran
`--no-auth` on a published port — can exfiltrate full process memory in one
HTTP request. That is the endpoint working as intended. Scope who holds the
token as tightly as who holds `kubectl exec`.
:::

## A worked incident, mirrored from the Java article

10:12 — p99 on `myapi` jumps 400ms → 3s. The actuator article's triage, translated:

```bash
kubectl port-forward myapi-6f9d8b7c44-qx2lp 52323:52323 &

# 1. What's the runtime doing right now? (≈ actuator /metrics loop)
curl -s "localhost:52323/livemetrics?durationSeconds=15" | jq -r \
  'select(.name=="cpu-usage" or .name=="threadpool-queue-length") | "\(.name)=\(.value)"'
```

```console
cpu-usage=91
threadpool-queue-length=143
```

CPU pinned, thread pool queue climbing. 10:15 — take the profile
(≈ nothing actuator has):

```bash
curl -sOJ "localhost:52323/trace?profile=Cpu&durationSeconds=30"
dotnet-trace convert --format speedscope 20260703_101532_1.nettrace
```

Flame graph: 71% of samples under `ReportCache.GetOrBuild` →
`Regex..ctor` — an uncached `new Regex(...)` per request. 10:21 — confirm
nothing heap-shaped is also brewing (≈ actuator `heapdump`, at 2% of the cost):

```bash
curl -sOJ localhost:52323/gcdump    # 38 MB, heap stable, no second problem
```

10:24 — root cause in hand; the fix is a `static readonly Regex`. Twelve
minutes, four HTTP calls, zero redeploys, zero restarts — and with the
`HighCpuProfile` rule deployed, the trace would have been waiting in
`/artifacts` before anyone was paged.

## Ops hygiene: the closing checklist

**Always on, every pod**: the sidecar itself, `/metrics` (scraped on the
separate metrics port), `/gcdump` and `/logs` reachable via port-forward,
crash-dump env vars from [Diagnostics](/dotnet/diagnostics/).

**Gated behind auth + deliberate use**: `/dump` (secret-grade output, pauses
the process) and long `/trace` runs (real overhead). Available ≠ casual.

**Collection rules are the production default**, not the advanced option —
one CPU rule, one working-set rule, limits set, egress to object storage.
The pull API is for humans; the rules are for the incidents that don't wait
for humans.

**The honest gaps vs actuator**, so nobody goes hunting: no runtime
log-level POST (workaround: `Logging__LogLevel__*` via ConfigMap reload)
and no merged-configuration endpoint (workaround: `/env`, plus logging
effective config at startup behind a flag). Everything else on the table,
.NET matches — and on automated capture, it's actuator that's missing the
endpoint.
