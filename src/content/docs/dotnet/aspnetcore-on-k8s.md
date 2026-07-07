---
title: ASP.NET Core on Kubernetes
description: Health checks, graceful shutdown, configuration reload, Kestrel behind an ingress, and observability — the production checklist for ASP.NET Core pods.
keywords:
  - health checks liveness readiness tags
  - MapHealthChecks predicate
  - HostOptions ShutdownTimeout
  - shell-form ENTRYPOINT SIGTERM dropped requests
  - IOptionsMonitor reloadOnChange
  - subPath configmap never reloads
  - DOTNET_USE_POLLING_FILE_WATCHER
  - Kestrel port 8080 non-root
  - ASPNETCORE_FORWARDEDHEADERS_ENABLED redirect loop
  - gRPC h2c HTTP2 without TLS
  - OpenTelemetry .NET instrumentation
  - request header 431 too large
sidebar:
  order: 4
---

ASP.NET Core is a good Kubernetes citizen out of the box — it handles
SIGTERM, reads env vars natively, binds cleanly to a port. The failures come
from the seams: probes wired to the wrong endpoint, shutdown math that
doesn't add up, ConfigMaps that never reload, an ingress the app doesn't
know exists. The checklist, then a reference Deployment.

## Health checks: the liveness/readiness split done right

The framework gives you primitives; the discipline comes from
[Health checks](/workloads/health-checks/): **liveness must not check
dependencies**. A liveness probe that pings the database converts every DB
blip into a fleet-wide restart — the most common self-inflicted outage here.

Tag your checks, then filter by tag per endpoint:

```csharp
builder.Services.AddHealthChecks()
    // liveness: only "is this process able to serve anything at all"
    .AddCheck("self", () => HealthCheckResult.Healthy(), tags: ["live"])
    // readiness: things that should pull the pod OUT of the Service when broken
    .AddNpgSql(connString, name: "postgres", tags: ["ready"])
    .AddCheck<MessageBusHealthCheck>("rabbitmq", tags: ["ready"]);

var app = builder.Build();

app.MapHealthChecks("/healthz/live", new HealthCheckOptions
{
    Predicate = r => r.Tags.Contains("live")
});
app.MapHealthChecks("/healthz/ready", new HealthCheckOptions
{
    Predicate = r => r.Tags.Contains("ready")
});
```

Matching probes (knob rationale in
[Health check knobs](/tuning/health-check-knobs/)):

```yaml
startupProbe:              # absorbs cold start; keep liveness dumb and fast
  httpGet: { path: /healthz/live, port: 8080 }
  failureThreshold: 30
  periodSeconds: 2
livenessProbe:
  httpGet: { path: /healthz/live, port: 8080 }
  periodSeconds: 10
  timeoutSeconds: 2
readinessProbe:
  httpGet: { path: /healthz/ready, port: 8080 }
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 3
```

:::caution[The default MapHealthChecks runs EVERY registered check]
`app.MapHealthChecks("/healthz")` with no predicate executes all checks —
the moment someone adds an `.AddNpgSql(...)`, your liveness endpoint quietly
starts checking Postgres. The `Predicate` filters above are the fence, not
decoration. Also: checks aren't cached — readiness every 5 s × 30 pods is
6 DB pings/sec. Cheap, but budget it.
:::

## Graceful shutdown: the 30-second math

On pod deletion: kubelet sends **SIGTERM** → the host raises
`IHostApplicationLifetime.ApplicationStopping` → Kestrel stops accepting and
drains in-flight requests → `ApplicationStopped` → exit. Two clocks race:

- **`HostOptions.ShutdownTimeout`** — how long the host gives hosted
  services and Kestrel to drain. Default **30 s**.
- **`terminationGracePeriodSeconds`** — how long Kubernetes waits before
  SIGKILL. Default **also 30 s**.

Equal budgets means .NET loses the race whenever anything else eats time —
notably the `preStop` sleep you should have (to let endpoint removal
propagate before the app stops accepting; see
[Health checks](/workloads/health-checks/)). Make the inequality explicit:

```text
terminationGracePeriodSeconds  >  preStop sleep + ShutdownTimeout + ~5 s margin
                          45   >        5       +       30        +   5   ✓
```

```csharp
builder.Services.Configure<HostOptions>(o =>
    o.ShutdownTimeout = TimeSpan.FromSeconds(30));
```

```yaml
terminationGracePeriodSeconds: 45
lifecycle:
  preStop:
    exec: { command: ["sleep", "5"] }  # chiseled image, no sleep binary? delay in ApplicationStopping instead
```

:::danger[The shell-form ENTRYPOINT swallows SIGTERM]
`ENTRYPOINT dotnet MyApi.dll` (shell form) wraps your app in `/bin/sh -c`,
which does **not** forward SIGTERM. The app never hears the shutdown, drains
nothing, and gets SIGKILLed at the grace deadline — every deploy drops
in-flight requests, and it looks intermittent. Always exec form:
`ENTRYPOINT ["dotnet", "MyApi.dll"]`.
:::

If you grew up on IIS: there is no app pool, no overlapped recycle. SIGTERM
is the entire contract, and `IHostedService.StopAsync` (run within
`ShutdownTimeout`, reverse registration order) is the recycle hook now.

## Configuration the Kubernetes way

`IConfiguration` is layered; later wins. The idiomatic k8s stack:

```csharp
// baked: appsettings.json, then appsettings.{ASPNETCORE_ENVIRONMENT}.json
// then environment variables (Deployment env / envFrom), then mounts:
builder.Configuration.AddJsonFile("/config/overrides.json",
    optional: true, reloadOnChange: true);   // mounted ConfigMap
builder.Configuration.AddKeyPerFile("/secrets", optional: true);  // mounted Secret
```

Environment variables map `:` to `__` (double underscore):

```yaml
env:
  - name: Logging__LogLevel__Default
    value: Warning
  - name: ConnectionStrings__main       # => ConnectionStrings:main
    valueFrom:
      secretKeyRef: { name: myapi-db, key: connstring }
```

Prefer **files over env for secrets** — files rotate without a pod restart
and don't leak into `kubectl describe` or crash reports
([Secrets](/workloads/secrets/)). Env for scalars, files for anything
structured or secret.

**Live reload works — with two traps.** `reloadOnChange: true` on a mounted
ConfigMap file picks up updates, because kubelet swaps the `..data` symlink
atomically ([ConfigMap & Secret rotation](/operations/configmap-secret-rotation/)):

1. **`subPath` kills it.** A `subPath` mount is a bind mount of one file,
   frozen at pod start; kubelet never updates it. If config "never reloads",
   look for `subPath` first — see
   [Config files and volumes](/workloads/config-files-and-volumes/).
2. **inotify vs symlinks.** The file watcher sometimes misses the
   symlink-swap on certain kernels/CSI setups; the reliable fix is
   `DOTNET_USE_POLLING_FILE_WATCHER=true` in the pod env (cheap for a
   handful of files).

Consume reloadable config through `IOptionsMonitor<T>` (singleton,
`OnChange` callback) or `IOptionsSnapshot<T>` (re-evaluated per request).
Plain `IOptions<T>` is frozen at first resolution and will gaslight you
into thinking reload is broken:

```csharp
public sealed class RateLimiter(IOptionsMonitor<RateLimitOptions> options)
{
    // options.CurrentValue reflects the ConfigMap ~a minute after kubectl apply
}
```

## Kestrel specifics

**Binding.** .NET 8 images default to port **8080** and non-root UID 1654
(older images: port 80, root — the port change breaks Services on upgrade;
check your `containerPort`). Be explicit:

```yaml
env:
  - name: ASPNETCORE_URLS
    value: http://0.0.0.0:8080
```

**gRPC / HTTP2 without TLS.** TLS ends at the ingress or mesh, so pod-to-pod
gRPC is h2c — which Kestrel won't speak on a default endpoint. Give gRPC its
own port with `Protocols: Http2` (config-only, no code):

```yaml
env:
  - name: Kestrel__Endpoints__http__Url
    value: http://0.0.0.0:8080
  - name: Kestrel__Endpoints__grpc__Url
    value: http://0.0.0.0:8081
  - name: Kestrel__Endpoints__grpc__Protocols
    value: Http2
```

**Forwarded headers — the wrong-scheme classic.** Behind a TLS-terminating
ingress Kestrel sees plain HTTP, so `UseHttpsRedirection` builds a redirect
loop with the ingress; subtler versions generate wrong absolute URLs and
broken OIDC callbacks. The one-line fix honors
`X-Forwarded-For`/`X-Forwarded-Proto` and clears the known-proxies
allowlist (safe only because nothing untrusted reaches the pod directly):

```yaml
env:
  - name: ASPNETCORE_FORWARDEDHEADERS_ENABLED
    value: "true"
```

**Limits and timeouts behind an ingress.** Ingresses commonly forward fat
headers (auth cookies, JWTs); Kestrel's request-header limit (~32 KB total
by default) answers `431` before your code runs. And keep Kestrel's
`KeepAliveTimeout` (default 130 s) *longer* than the ingress's upstream idle
timeout, so the proxy closes idle connections — the wrong order causes
sporadic 502s that never reproduce.

## Observability

**Tracing/metrics/logs: OpenTelemetry .NET**, two ways that both work on
runtime-only images:

- **SDK in code** — explicit, AOT-compatible, versioned with the app:

```csharp
builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("myapi"))
    .WithTracing(t => t.AddAspNetCoreInstrumentation()
                       .AddHttpClientInstrumentation().AddOtlpExporter())
    .WithMetrics(m => m.AddAspNetCoreInstrumentation()
                       .AddRuntimeInstrumentation().AddOtlpExporter());
```

- **Auto-instrumentation** — the profiler-based zero-code option, injected
  via env vars and a mounted tools volume; works on runtime-only images
  (it's native, not SDK-dependent), not on Native AOT.

Either way, configuration is standard `OTEL_*` env in the Deployment, per
[Tracing](/observability/tracing/):

```yaml
env:
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: http://otel-collector.observability:4317
  - name: OTEL_SERVICE_NAME
    value: myapi
```

**Runtime metrics.** `AddRuntimeInstrumentation()` exports GC, thread pool,
and exception counters. Alternatively, the dotnet-monitor sidecar from
[Diagnostics](/dotnet/diagnostics/) exposes a Prometheus `/metrics` endpoint
with zero app changes ([Metrics](/observability/metrics/)); for ad-hoc
looks, `dotnet-counters monitor` beats redeploying with instrumentation.

## The failure list, ranked by how often it pages someone

1. **Probe 503s because a health check queries a dependency.** DB hiccup →
   fleet-wide restart storm →
   [CrashLoopBackOff](/troubleshooting/crashloopbackoff/). Fix: the
   tag/predicate split above.
2. **Deploys drop in-flight requests.** Shell-form ENTRYPOINT eating
   SIGTERM, or `ShutdownTimeout` + preStop exceeding the grace period.
3. **ConfigMap changes never arrive.** `subPath` mount, or `IOptions<T>`
   instead of `IOptionsMonitor<T>`, or inotify missing the symlink swap.
4. **Redirect loops / wrong-scheme URLs behind the ingress.** Forwarded
   headers not enabled; OIDC redirect URIs generated as `http://`.
5. **Memory "leak" that is actually Server GC** riding at the limit on a
   big node — the story is [.NET in containers](/dotnet/dotnet-in-containers/).
6. **Port 8080/80 mismatch after a .NET 8 base-image bump.** Service
   targets 80, app now listens on 8080, readiness never passes.

## Reference Deployment, annotated

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
      terminationGracePeriodSeconds: 45          # > preStop + ShutdownTimeout
      securityContext:
        runAsNonRoot: true
        runAsUser: 1654                          # 'app' in .NET 8+ images
      containers:
        - name: myapi
          image: registry.example.com/myapi:1.14.2
          ports:
            - { name: http, containerPort: 8080 }
          env:
            - name: ASPNETCORE_ENVIRONMENT
              value: Production
            - name: ASPNETCORE_URLS
              value: http://0.0.0.0:8080
            - name: ASPNETCORE_FORWARDEDHEADERS_ENABLED
              value: "true"                      # TLS ends at the ingress
            - name: DOTNET_gcServer
              value: "1"
            - name: DOTNET_GCDynamicAdaptationMode
              value: "1"                         # DATAS — adaptive Server GC
            - name: DOTNET_GCHeapHardLimitPercent
              value: "0x3C"                      # HEX = 60% of the memory limit
            - name: DOTNET_USE_POLLING_FILE_WATCHER
              value: "true"                      # reliable ConfigMap reload
            - name: DOTNET_DbgEnableMiniDump     # crash-dump insurance
              value: "1"
            - name: DOTNET_DbgMiniDumpName
              value: /dumps/crash-%p-%t.dmp
            - name: ConnectionStrings__main
              valueFrom:
                secretKeyRef: { name: myapi-db, key: connstring }
          volumeMounts:
            - name: config
              mountPath: /config                 # whole dir — NO subPath, reload works
              readOnly: true
            - name: tmp
              mountPath: /tmp                    # diagnostic socket needs a writable /tmp
            - name: dumps
              mountPath: /dumps
          startupProbe:
            httpGet: { path: /healthz/live, port: http }
            failureThreshold: 30
            periodSeconds: 2
          livenessProbe:                         # dependency-free, always
            httpGet: { path: /healthz/live, port: http }
            periodSeconds: 10
            timeoutSeconds: 2
          readinessProbe:
            httpGet: { path: /healthz/ready, port: http }
            periodSeconds: 5
            failureThreshold: 3
          resources:
            requests: { cpu: 500m, memory: 1Gi }
            limits: { memory: 2Gi, cpu: "2" }    # see /tuning/requests-limits-knobs/
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true         # safe: /tmp and /dumps are volumes
      volumes:
        - name: config
          configMap: { name: myapi-config }
        - name: tmp
          emptyDir: {}
        - name: dumps
          emptyDir: { sizeLimit: 4Gi }
```

Add the dotnet-monitor sidecar from [Diagnostics](/dotnet/diagnostics/) and
this is the pod spec we wish every 3 a.m. incident started from.
