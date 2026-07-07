---
title: Sidecar Recipes
description: Five production-ready sidecar patterns with complete YAML, sizing guidance, and failure modes — plus the anti-recipes to refuse.
keywords:
  - Fluent Bit log shipper sidecar
  - config reloader SIGHUP inotify
  - Vault agent secrets sidecar tmpfs
  - local caching proxy Valkey
  - OpenTelemetry collector agent
  - memory_limiter OOMKill collector
  - ConfigMap reload without rollout
  - shareProcessNamespace pkill HUP
  - anti-recipe cron or database sidecar
  - maxmemory versus container limit headroom
sidebar:
  order: 3
---

Five patterns that have earned their per-replica cost in production, each with the question that decides whether *you* should use it, complete YAML, sizing, and how it fails. All assume native sidecar support (1.29+) — check availability per [Lifecycle and Ordering](/sidecars/lifecycle-and-ordering/), which also covers the shared-grace-period and probe mechanics these recipes rely on. Resource numbers here are starting points; measure and adjust per [Requests, Limits, and the Knobs That Matter](/tuning/requests-limits-knobs/).

## Recipe 1: Fluent Bit log shipper for a file-logging app

**Say it up front: if the app can log to stdout, do that and delete this recipe.** The node's log collector already ships stdout once per node instead of once per pod — see [Log Collection](/observability/log-collection/). This sidecar is for the app you *can't* fix: the vendor JAR hardwired to `log4j` file appenders, the app writing three distinct files (access, audit, application) that must stay distinct.

**When:** app writes log files, you can't change it, and the files must reach your log backend with pod metadata attached.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: legacy-billing
spec:
  replicas: 4
  selector:
    matchLabels: { app: legacy-billing }
  template:
    metadata:
      labels: { app: legacy-billing }
    spec:
      terminationGracePeriodSeconds: 60   # app drain + shipper flush share this
      initContainers:
        - name: log-shipper
          image: cr.fluentbit.io/fluent/fluent-bit:3.1.4
          restartPolicy: Always            # native sidecar: outlives the app on shutdown
          args: ["-c", "/fluent-bit/etc/fluent-bit.conf"]
          env:
            - name: POD_NAME
              valueFrom: { fieldRef: { fieldPath: metadata.name } }
            - name: POD_NAMESPACE
              valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
          volumeMounts:
            - { name: app-logs, mountPath: /var/log/app, readOnly: true }
            - { name: flb-config, mountPath: /fluent-bit/etc }
            - { name: flb-state, mountPath: /var/lib/fluent-bit }
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { memory: 128Mi }
      containers:
        - name: app
          image: registry.example.com/billing/legacy:7.2
          volumeMounts:
            - { name: app-logs, mountPath: /opt/app/logs }
      volumes:
        - name: app-logs
          emptyDir: { sizeLimit: 1Gi }     # cap it — see failure modes
        - name: flb-state
          emptyDir: {}                     # tail-position DB survives shipper restarts
        - name: flb-config
          configMap: { name: legacy-billing-flb }
```

The Fluent Bit config's essentials — tail with a state DB, flush on SIGTERM within its grace window:

```ini
[SERVICE]
    grace         20
[INPUT]
    name          tail
    path          /var/log/app/*.log
    db            /var/lib/fluent-bit/tail.db
    mem_buf_limit 32MB
[OUTPUT]
    name          forward
    match         *
    host          log-gateway.observability.svc.cluster.local
```

**Sizing:** 50m/64Mi handles a few MB/s of log volume comfortably; CPU scales with parse complexity (regex-heavy parsers are the usual burner). Watch the shipper's own memory under backend outage — buffered records live somewhere.

**Failure modes:**

- **Disk fills.** The app writes; nothing rotates. The `sizeLimit` on the emptyDir means the *pod gets evicted* at 1Gi instead of eating the node — that's the correct failure, but you must rotate: either the app's own rotation or a `logrotate` in the sidecar image. An unbounded emptyDir here is how a chatty debug flag takes down a node.
- **Backend outage.** Fluent Bit buffers, hits `mem_buf_limit`, and drops or backpressures. Do **not** give this sidecar a readinessProbe tied to backend health — you'd convert "logs delayed" into "service down" fleet-wide.
- **SIGKILL at grace expiry.** Shipper needs its flush window *after* the app exits; the `grace 20` above must fit inside the pod's remaining `terminationGracePeriodSeconds`. Exit code 137 on the shipper plus missing final log lines is the tell.

## Recipe 2: config reloader that SIGHUPs the app

**When:** the app reads config only at boot, honors SIGHUP for reload (nginx, haproxy, many daemons), and you want ConfigMap edits applied without a rollout. The kubelet already syncs mounted ConfigMap volumes to the pod within ~a minute ([Config Files and Volumes](/workloads/config-files-and-volumes/)); what's missing is telling the app. The full rotation strategy landscape — including checksum-annotation rollouts, often the *better* answer — is in [ConfigMap and Secret Rotation](/operations/configmap-secret-rotation/).

```yaml
spec:
  shareProcessNamespace: true              # the reloader must see the app's PID
  initContainers:
    - name: config-reloader
      image: registry.example.com/tools/inotify-reloader:1.4
      restartPolicy: Always
      command:
        - sh
        - -c
        - |
          # ConfigMap volumes update atomically via the ..data symlink swap —
          # watch the symlink, then signal the app process by name.
          while true; do
            inotifywait -e delete_self /etc/app-config/..data 2>/dev/null
            echo "config changed, signaling app"
            pkill -HUP -f '^/usr/sbin/nginx' || echo "app process not found"
          done
      securityContext:
        runAsUser: 101                     # SAME UID as the app, or the signal is denied
      volumeMounts:
        - { name: config, mountPath: /etc/app-config, readOnly: true }
      resources:
        requests: { cpu: 5m, memory: 16Mi }
        limits: { memory: 32Mi }
  containers:
    - name: app
      image: nginx:1.27
      securityContext:
        runAsUser: 101
      volumeMounts:
        - { name: config, mountPath: /etc/nginx/conf.d, readOnly: true }
  volumes:
    - name: config
      configMap: { name: edge-nginx-conf }
```

**Sizing:** nearly free — 5m/16Mi. It sleeps in `inotifywait` and wakes once per config change.

**Failure modes:**

- **UID mismatch = silent no-op.** An unprivileged process can only signal processes with its own UID. Run the reloader as the app's UID, or every reload "works" in the logs and does nothing.
- **Watching the wrong path.** ConfigMap updates swap the `..data` symlink; watching the file itself catches nothing after the first swap. Watch `..data` (as above) or poll a checksum.
- **Bad config + SIGHUP.** nginx survives a bad reload (keeps old config); many apps *die* on reloading invalid config — and now a typo in a ConfigMap restarts your fleet, no rollout, no rollback. Validate before you signal (`nginx -t` first) if the app offers it.
- **Doesn't apply to `subPath` mounts** — those never update in place. And Secret rotation has the same shape but sharper edges; see [ConfigMap and Secret Rotation](/operations/configmap-secret-rotation/).

## Recipe 3: secrets fetcher (Vault-agent style)

**When:** credentials live in an external secrets manager, rotate on short TTLs, and there's no CSI driver or External Secrets Operator available to you. The shape is a **pair**: an init container blocks startup until the first render (the app must never boot without creds), then a native sidecar keeps them fresh. Background on why files beat env vars for rotating secrets: [Secrets](/workloads/secrets/).

```yaml
spec:
  serviceAccountName: orders               # vault auth via bound SA token
  initContainers:
    - name: vault-init                     # one-shot: block until first secrets render
      image: hashicorp/vault:1.17
      command: ["vault", "agent", "-config=/vault/config/agent.hcl", "-exit-after-auth"]
      volumeMounts:
        - { name: vault-config, mountPath: /vault/config }
        - { name: secrets, mountPath: /secrets }
      resources:
        requests: { cpu: 50m, memory: 64Mi }
        limits: { memory: 128Mi }
    - name: vault-agent                    # native sidecar: renew and re-render for pod life
      image: hashicorp/vault:1.17
      restartPolicy: Always
      command: ["vault", "agent", "-config=/vault/config/agent.hcl"]
      volumeMounts:
        - { name: vault-config, mountPath: /vault/config }
        - { name: secrets, mountPath: /secrets }
      resources:
        requests: { cpu: 25m, memory: 64Mi }
        limits: { memory: 128Mi }
  containers:
    - name: app
      image: registry.example.com/shop/orders:2.4.1
      volumeMounts:
        - { name: secrets, mountPath: /secrets, readOnly: true }
  volumes:
    - name: vault-config
      configMap: { name: orders-vault-agent }
    - name: secrets
      emptyDir:
        medium: Memory                     # tmpfs: creds never touch node disk
        sizeLimit: 4Mi
```

`medium: Memory` matters: rendered credentials live in RAM, vanish with the pod, and never land on the node's disk or in its backups. The cost: tmpfs usage counts against the pod's **memory** limits, so keep the `sizeLimit` tight and remember it in the memory budget.

**Sizing:** the init copy is bursty (auth + first render); the sidecar copy idles between renewals. 25–50m / 64Mi each is typical; template-heavy configs (many secrets, big PKI bundles) push memory first.

**Failure modes:**

- **App doesn't re-read the file.** The agent dutifully renders fresh creds; the app read them once at boot and holds the old ones until they expire mid-traffic. Either the app re-reads on failure/interval, or you combine with Recipe 2's signal, or the agent's `template` block runs a `command` on render.
- **Sidecar dies, renewals stop.** The app keeps running on creds that now have a countdown. This is a *delayed* failure — alert on the agent's renewals (its logs/metrics), not just its liveness.
- **Vault outage at startup vs. runtime.** At startup, the init container blocks and the pod sits in `Init:0/2` — correct, loud, visible. At runtime, existing pods coast on their TTLs — which means a Vault outage looks fine until TTLs expire *simultaneously fleet-wide*. Stagger TTLs if you can.

## Recipe 4: local caching proxy

**The honest question first: is this actually better than a shared cache?** A cache Deployment behind a Service gives every replica one warm cache, one memory budget, coherent invalidation, and cache survival across app deploys. The sidecar gives each replica its own cold, small, incoherent cache. The sidecar wins only when the win condition is **latency of the localhost hop** (sub-millisecond, no network variance) or **isolation** (one replica's cache blowout can't evict another's hot keys) — and the data is cheap to re-fetch and tolerant of staleness. Most teams that think they want this actually want a shared Valkey. Run the math both ways before proceeding.

**When:** read-heavy lookups of small, hot, staleness-tolerant data (feature flags, geo/IP data, catalog fragments) where per-request latency to a shared cache measurably hurts.

```yaml
spec:
  initContainers:
    - name: cache
      image: valkey/valkey:8.0-alpine
      restartPolicy: Always
      args:
        - --maxmemory
        - 96mb
        - --maxmemory-policy
        - allkeys-lru
        - --save                            # disable persistence: it's a cache
        - ""
      startupProbe:
        exec: { command: ["valkey-cli", "ping"] }
        periodSeconds: 1
        failureThreshold: 15
      resources:
        requests: { cpu: 50m, memory: 128Mi }
        limits: { memory: 160Mi }           # headroom over maxmemory — see failure modes
  containers:
    - name: app
      image: registry.example.com/shop/catalog:3.1.0
      env:
        - name: CACHE_URL
          value: redis://127.0.0.1:6379    # localhost: shared pod network namespace
```

**Sizing:** the memory limit must exceed `--maxmemory` by real headroom (jemalloc fragmentation and client buffers live *outside* maxmemory — 20–30% is a sane margin). At 40 replicas, this 128Mi request is 5Gi of fleet memory for caching; compare that to one 5Gi shared instance with a 100% warm hit rate before you commit.

**Failure modes:**

- **maxmemory == container limit → OOMKill.** The classic. Valkey enforces `maxmemory` on data, the kernel enforces the limit on the *process*; set them equal and fragmentation gets the container OOMKilled with exit 137 under load.
- **Cold cache per pod start.** Every deploy, every scale-up, every eviction starts at 0% hit rate — your backing store takes the thundering herd exactly when you're rolling out. Cap concurrency on cache-miss fetches in the app.
- **No invalidation.** Update the source data and N replicas serve N independently-stale copies until TTL. If that sentence made someone at your company wince, you need the shared cache.

## Recipe 5: OpenTelemetry collector agent

**When per-pod wins:** you need heavy tail-based sampling or scrubbing *before* telemetry leaves the pod, pod-local enrichment, or a buffer that absorbs collector-gateway outages without the app noticing. **When it doesn't:** most teams do fine pointing the SDK at a collector *gateway* Deployment (or the platform's node agent) — zero per-pod cost, centrally managed pipelines. Start with the gateway; add the sidecar when measurements say so. Tracing architecture context: [Tracing](/observability/tracing/).

```yaml
spec:
  initContainers:
    - name: otel-agent
      image: otel/opentelemetry-collector-contrib:0.109.0
      restartPolicy: Always
      args: ["--config=/etc/otelcol/config.yaml"]
      startupProbe:
        httpGet: { path: /, port: 13133 }   # health_check extension
        periodSeconds: 1
        failureThreshold: 20
      volumeMounts:
        - { name: otel-config, mountPath: /etc/otelcol }
      resources:
        requests: { cpu: 50m, memory: 128Mi }
        limits: { memory: 256Mi }
  containers:
    - name: app
      image: registry.example.com/shop/orders:2.4.1
      env:
        - name: OTEL_EXPORTER_OTLP_ENDPOINT
          value: http://127.0.0.1:4318
  volumes:
    - name: otel-config
      configMap: { name: orders-otel-agent }
```

Native-sidecar startup ordering earns its keep here: the agent passes its startup probe *before* the app boots, so the app's very first spans — startup traces, the ones you want when boot is slow — have somewhere to land instead of erroring against a connection-refused localhost port.

**Sizing:** dominated by the `memory_limiter` processor and batch sizes in the collector config — set `memory_limiter` below the container limit or the collector OOMs instead of applying backpressure. 50m/128Mi covers moderate span volume; heavy tail-sampling configs are memory-hungry and you should measure.

**Failure modes:**

- **Config/limit mismatch:** `memory_limiter` above the container limit means OOMKill under burst instead of graceful span dropping.
- **Pipeline config drift × replicas:** a bad processor config doesn't break one collector, it breaks telemetry in every pod on next rollout — and you're now blind *during* the incident the rollout caused. Canary collector-config changes like app changes.
- **The quiet default:** if the platform already runs node agents, this sidecar may be double-processing every span. Ask before you build it.

## Anti-recipes

Three sidecars people keep writing that you should refuse in review:

**Cron-in-a-sidecar.** A container running `crond` (or `while true; do work; sleep 3600; done`) next to the app, "because it needs the app's config". It runs once *per replica* — your hourly cleanup now runs 40 times an hour, racing itself — and scales with a knob (replica count) that has nothing to do with the schedule. Scheduled work is a [CronJob](/workloads/jobs-and-cronjobs/); share config via the same ConfigMap, not the same pod.

**Database-in-a-sidecar.** Postgres/MySQL next to the app for "simplicity". The data lives in a volume with the *pod's* lifecycle-adjacent churn, every replica gets its own divergent database (or you've silently built replicas=1 forever), and every app deploy restarts your database. Databases are StatefulSets or managed services — full stop.

**Sidecar-as-second-service.** The admin API, the "small internal dashboard", the companion service that other teams start calling. The moment anything *outside the pod* depends on the sidecar, it has its own consumers, its own SLO, and its own scaling curve — and it's pinned to yours. Promote it to a Deployment behind a Service the first time someone else's traffic arrives.

The common thread: each one takes a thing with its own lifecycle — a schedule, a dataset, a consumer base — and shackles it to your replica count. The sidecar test from the [overview](/sidecars/overview/) catches all three.

## Sizing quick reference

Starting points, per replica — multiply by your replica count before approving, and validate with real measurements per [Requests, Limits, and the Knobs That Matter](/tuning/requests-limits-knobs/):

| Recipe | CPU request | Memory request | Memory limit | First thing to watch |
|---|---|---|---|---|
| Fluent Bit log shipper | 50m | 64Mi | 128Mi | mem buffer during backend outage; emptyDir growth |
| Config reloader | 5m | 16Mi | 32Mi | that signals actually land (UID match) |
| Vault agent (init + sidecar) | 25–50m each | 64Mi each | 128Mi | renewal failures; tmpfs counted in pod memory |
| Valkey cache | 50m | 128Mi | maxmemory + 25–30% | limit vs `--maxmemory` headroom; hit rate after deploys |
| OTel agent | 50m | 128Mi | 256Mi | `memory_limiter` below container limit; span drop counters |

Rule of thumb for the review comment: a sidecar whose requests exceed ~25% of the app container's own requests needs a written justification — at that ratio, the DaemonSet, shared-service, or fix-the-app alternative from the [overview's decision framework](/sidecars/overview/) almost always wins.
