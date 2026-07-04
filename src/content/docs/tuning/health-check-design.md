---
title: "Health Check Design"
description: What "healthy" should actually mean — designing probe endpoints backwards from their consequences, classifying dependencies, per-archetype designs, and the retrofit program for a fleet full of inherited probes.
sidebar:
  order: 7
---

[Health Check Knobs](/tuning/health-check-knobs/) owns the timing dials — periods, thresholds, budgets. [Health Checks](/workloads/health-checks/) owns the probe semantics — what the kubelet does with each probe type. This article owns the question both of them assume you've already answered: **what should the endpoint say, and why?** That's a design discipline, not a config field. And because most of us are retrofitting it onto services that already have probes — usually bad ones — the second half is the fleet program for fixing them without breaking production.

## Design backwards from the consequence

A probe is not a status page. It is a **contract with the kubelet**, and the kubelet's side of the contract is an action. Design the endpoint by starting from the action and asking "when do I want *that* to happen?":

| Probe | Consequence of failing | So the endpoint must answer | And therefore must NEVER |
|---|---|---|---|
| **Liveness** | kubelet **kills and restarts** the container | "Would a restart fix my current state?" | Fail for anything a restart won't fix — a down database, a slow downstream, high load |
| **Readiness** | pod **removed from Service endpoints** (traffic stops; pod keeps running) | "Can I serve a request *right now*?" | Fail for things that don't affect serving, or flap on transient blips |
| **Startup** | liveness/readiness are **held off**; fail the whole budget → restart | "Have I finished initializing?" | Model ongoing health — it runs only once, at boot |

Read the fourth column twice. Almost every probe pathology in the wild is an endpoint answering the wrong probe's question: a liveness endpoint that answers "can I serve?" (restart storms during a DB outage), or a readiness endpoint that answers "am I alive?" (traffic sent to a pod that can't serve it).

## Dependency classification — the core discipline

Take your service's dependency list — database, cache, downstream APIs, message broker, config store — and classify each one. This twenty-minute exercise determines every endpoint's contents.

| Class | Definition | Probe consequence |
|---|---|---|
| **Hard** | The service can serve **nothing** useful without it | Gates **readiness** (only) |
| **Soft** | Degraded service is possible without it (stale data, slower path, feature off) | Gates **nothing** — it gates feature flags and fallback paths in *application* code |
| **Async** | Invisible to the request path (email sends, event publishing, batch export) | Gates nothing; alert on its backlog instead ([Alerting](/observability/alerting/)) |

Three rules fall out of the table, and they are the whole discipline:

**Rule 1: liveness checks nothing but self.** Deadlock detection, wedged event loop, poisoned worker threads — things where the process itself is broken and a restart is the actual cure. Here is the fleet outage that teaches this, retold in one paragraph: a team wired their liveness probe to an endpoint that pinged the database. The database had a 90-second failover. Every pod in the fleet — all healthy, all holding warm caches and in-flight requests they could have completed or queued — failed liveness three times, and the kubelet dutifully killed all of them. Sixty JVMs cold-started simultaneously into a thundering herd against a database that had just come back, which promptly went down again. A 90-second database blip became a 40-minute full outage, *caused entirely by the probe*. The database was never the service's problem to restart its way out of.

**Rule 2: readiness checks hard deps only — with hysteresis.** If the DB is down, this pod genuinely cannot serve; leaving rotation is correct and it's what makes rolling deploys and failovers clean. But check with flap-damping: one failed DB ping should not yank a pod from rotation for 10 seconds and back. Require N consecutive failures in the *endpoint logic* (or lean on `failureThreshold` — the trade-offs are in [Health Check Knobs](/tuning/health-check-knobs/)), and remember that if *all* pods leave rotation because a shared hard dep died, callers get connection refused instead of fast 503s — sometimes keeping ready and returning 503s with a `Retry-After` is the kinder failure. That's a design decision to make per service, on purpose, and to write down.

**Rule 3: soft deps never gate probes.** Cache down? Serve slower from the DB and set a flag that trips the "degraded" alert. The moment a soft dep appears in a probe you've promoted it to hard — you've told Kubernetes to remove capacity because a *cache* hiccuped, converting a 5% latency degradation into a 100% capacity loss.

### Worked example: orders-api

| Dependency | Class | Why | Where it lives |
|---|---|---|---|
| Postgres | **Hard** | Every order read/write touches it; no fallback | Readiness |
| Redis (catalog cache) | **Soft** | Cache miss path falls through to Postgres, 40ms slower | Degraded-mode flag + alert; **not** in any probe |
| payments-api (downstream) | **Hard for checkout, soft for browse** | Mixed! Classify per *service capability*. If checkout is why this service exists → hard. Or: split the service's read path off. Mixed dependencies are an architecture smell wearing a probe costume. | Readiness (as hard), with the mixed-ness documented |
| SMTP relay (order emails) | **Async** | Emails queue; requests never wait on it | Queue-depth alert only |
| Config store (startup fetch) | **Hard at boot, absent at runtime** | Fetched once, cached in memory | **Startup** probe only |

And the manifest that classification produces — this is the destination the whole article drives toward:

```yaml
# orders-api: probes designed from the dependency table above.
# Timing values are illustrative — derive yours in /tuning/health-check-knobs/.
containers:
  - name: orders-api
    startupProbe:
      httpGet: { path: /health/started, port: 8080 }
      periodSeconds: 5
      failureThreshold: 36        # 3-minute boot budget: migrations + cache warm
    livenessProbe:
      httpGet: { path: /health/live, port: 8080 }   # self only: threads + event loop
      periodSeconds: 10
      timeoutSeconds: 5           # survives a full GC pause
      failureThreshold: 3
    readinessProbe:
      httpGet: { path: /health/ready, port: 8080 }  # postgres + payments-api, budgeted
      periodSeconds: 5
      timeoutSeconds: 2           # per-dep budgets sum to 1.2s — see below
      failureThreshold: 3         # hysteresis: 15s of failures before leaving rotation
```

## Designing each endpoint

### Liveness: `/health/live`

In-process checks only, and cheap — this endpoint runs every few seconds forever, so it must cost microseconds and allocate nothing worth mentioning:

- Event loop / servlet threads responsive (the fact that the HTTP response happened *is* most of the check).
- Critical background threads alive (consumer loop, scheduler) — a "last heartbeat < 60s ago" timestamp check, not a live poke.
- Optionally: not in an unrecoverable internal state (poisoned circuit that only a restart clears).

No I/O. No locks shared with request handling (a liveness probe blocked on the same lock as your wedged requests fails *with* them — which is arguably correct, but make it a choice). One JVM warning: a long GC pause stalls the probe response exactly when a restart is most harmful; the timeout math for that lives in [Health Check Knobs](/tuning/health-check-knobs/).

### Readiness: `/health/ready`

Hard deps only, each with a **per-dependency timeout budget that sums below the probe timeout**. If the probe's `timeoutSeconds: 2` and you check two deps serially with 3s client timeouts each, your readiness endpoint's failure mode is "hangs until the kubelet gives up" — indistinguishable from down, and slower to report than either dep. Budget it like a real latency budget:

| Check | Timeout | Running total |
|---|---|---|
| Postgres `SELECT 1` (from pool — also proves the pool isn't exhausted) | 500ms | 500ms |
| payments-api `/health/live` — see the anti-checklist below before copying this | 500ms | 1000ms |
| Overhead + serialization headroom | — | ~1200ms |
| **Probe `timeoutSeconds`** | | **2s** ✓ |

**Cached status vs. check-on-probe:** checking on every probe means N pods × M deps × every `periodSeconds` — your readiness traffic can become a real load on the database. The alternative: a background loop refreshes dep status every ~5s and the endpoint returns the cached verdict in microseconds. Cost: up to one refresh-interval of staleness, which stacks with `periodSeconds × failureThreshold`. Cache when deps are shared and fleet is large; check live when the dep is cheap and staleness hurts. Either way, the endpoint should return *which* check failed in the body — future-you at 3am will thank present-you:

```json
{"status": "DOWN", "checks": {"postgres": "UP", "payments-api": "DOWN (timeout 500ms)"}}
```

:::caution[Readiness as load-shedding — powerful, dangerous]
Some teams flip readiness to unready under overload (queue depth, heap pressure) so the pod sheds traffic and recovers. It works — and it's a loaded gun. If overload is fleet-wide (it usually is; load balancers spread load), every pod flips unready *together* and you shed 100% instead of 20%. If you do this: shed on a randomized/staggered threshold, verify the HPA reacts to the same signal *faster* than the shedding does ([Autoscaling](/workloads/autoscaling/)), and do the minReplicas math so that (replicas − shedding pods) still clears your baseline load ([High Availability](/workloads/high-availability/)). If you can't articulate that math, don't ship the pattern.
:::

### Startup: `/health/started`

Models **initialization, not health**: migrations applied, caches warmed, ML model loaded, config fetched. It flips to 200 exactly once and stays there. Its real job is honesty about worst-case boot time so liveness can stay aggressive afterward — the `failureThreshold × periodSeconds` budget arithmetic is worked in [Health Check Knobs](/tuning/health-check-knobs/). If your manifest instead has `initialDelaySeconds: 300` on the liveness probe, you're looking at a fossil from before startup probes existed — it costs you 5 minutes of restart-detection blindness on *every* boot to protect the slowest boot anyone ever saw once.

### Framework wiring, compactly

**Spring Boot** — health *groups* map one actuator onto the three contracts:

```yaml
management:
  endpoint:
    health:
      group:
        liveness:
          include: livenessState              # self only. Resist adding more.
        readiness:
          include: readinessState, db         # hard deps only
      probes:
        enabled: true
```

The gotcha: **any `HealthIndicator` bean you add joins the *default* group automatically, not your probe groups** — but if someone points a probe at bare `/actuator/health` (the default group), every indicator on the classpath gates it. Adding `spring-boot-starter-data-redis` silently puts Redis into that endpoint. Probes must point at `/actuator/health/liveness` and `/actuator/health/readiness`, never the bare endpoint. Details in [Spring Boot on K8s](/java/spring-boot/).

**ASP.NET Core** — tags plus predicates do the same partitioning:

```csharp
builder.Services.AddHealthChecks()
    .AddNpgSql(connString, tags: new[] { "ready" })
    .AddCheck<WorkerHeartbeat>("worker", tags: new[] { "live" });

app.MapHealthChecks("/health/live",  new() { Predicate = r => r.Tags.Contains("live") });
app.MapHealthChecks("/health/ready", new() { Predicate = r => r.Tags.Contains("ready") });
```

Same gotcha, .NET flavor: `MapHealthChecks` with no predicate runs **every** registered check. See [ASP.NET Core on K8s](/dotnet/aspnetcore-on-k8s/).

### Beyond HTTP APIs: per-archetype designs

| Archetype | Liveness | Readiness | Notes |
|---|---|---|---|
| **Queue consumer** (no port) | `exec`: heartbeat **file** freshness — consumer loop touches `/tmp/heartbeat` each poll; probe is `test $(find /tmp/heartbeat -mmin -2)` | Broker connection up (or skip readiness: no Service = nothing routes to it anyway) | The wedge you're catching: consumer thread dead while the process idles happily |
| **Batch / worker** | Same heartbeat pattern, generous thresholds | Usually none | Beware liveness killing a *legitimately* long task — heartbeat from inside the work loop, not around it |
| **gRPC** | `grpc:` probe → standard `grpc.health.v1.Health` service, `NOT_SERVING` vs `SERVING` per service name | Same protocol, per-service names for the two contracts | Native `grpc` probe type on any modern cluster; no exec-based `grpc_health_probe` binary needed |
| **Proxy / gateway** | Self-check only: config loaded, listeners bound, admin port answers | **Upstream-agnostic**: "I can route" — never "my upstreams are healthy." A proxy whose upstreams are down should stay in rotation returning 502s *it* controls | A proxy that goes unready when upstreams blip amplifies every downstream wobble into an edge outage |

The two non-HTTP shapes in YAML, since they're the ones nobody has muscle memory for:

```yaml
# Queue consumer — no port to probe; the consumer loop touches the heartbeat file each poll
containers:
  - name: email-worker
    livenessProbe:
      exec:
        command: ["sh", "-c", "test $(( $(date +%s) - $(stat -c %Y /tmp/heartbeat) )) -lt 120"]
      periodSeconds: 30
      timeoutSeconds: 5
      failureThreshold: 3        # 90s of missing heartbeats + a 2-min-stale file = wedged loop
---
# gRPC service — native probe type against the standard grpc.health.v1.Health service
containers:
  - name: pricing-grpc
    livenessProbe:
      grpc: { port: 9090 }                      # empty service name = "whole server alive"
    readinessProbe:
      grpc: { port: 9090, service: "pricing" }  # per-service SERVING/NOT_SERVING for hard deps
      periodSeconds: 5
```

The heartbeat trick generalizes: any process with a "main loop" — consumer, scheduler, poller — should stamp a file (or a gauge) from *inside* that loop. The probe then checks the stamp, not the process. A process can be alive and its loop dead; the stamp is the only witness.

:::note[Exec probes are not free]
Every `exec` probe forks a process inside the container's cgroup, on the probe period, forever — and that fork's CPU counts against the container's own limit. Keep the command to a shell builtin or a single `stat`, never a script that shells out to `curl`; and on a container with a tight CPU limit, know that a throttled container can fail its exec probe *because* it's throttled — a restart loop where the probe is the load. Prefer `httpGet`/`grpc` wherever a port exists.
:::

## The brownfield retrofit

You rarely design probes on a blank page. You inherit a fleet of them, installed by copy-paste over years. Here is the program for fixing them at fleet scale without causing the outage you're trying to prevent.

### The audit

One command produces the probe-config-per-workload table:

```bash
kubectl get deploy -A -o json | jq -r '
  .items[] | . as $d | .spec.template.spec.containers[] |
  [$d.metadata.namespace, $d.metadata.name,
   (.livenessProbe.httpGet.path // .livenessProbe.exec.command[0] // "NONE"),
   (.readinessProbe.httpGet.path // "NONE"),
   (if .startupProbe then "yes" else "no" end),
   (.livenessProbe.timeoutSeconds // 1),
   (.livenessProbe.initialDelaySeconds // 0)] | @tsv' | column -t
```

```text
shop    orders-api       /actuator/health   /actuator/health   no   1   300
shop    catalog-api      /                  /                  no   1   0
shop    email-worker     NONE               NONE               no   -   -
infra   edge-gateway     /healthz           /ready             yes  3   0
```

Three of those four rows are incidents on a timer. Grade every row against the smells table:

| Smell | What it means | 3am risk |
|---|---|---|
| Liveness == readiness, same endpoint | Nobody designed either; whatever that endpoint checks, the kubelet *restarts* on it | **High** — this is the fleet-outage pattern from Rule 1 |
| Probe hits `/` (or the login page) | "Returns 200" was the whole design; you're health-checking the router and, charmingly, your auth redirect | Medium — passes when the app is broken, occasionally fails when it isn't (a 302 is a probe failure) |
| `timeoutSeconds: 1` on a JVM | One healthy full GC pause = probe failure; three in a row = restart during peak load, which causes more GC... | **High** — self-amplifying, strikes under load |
| No startup probe + `initialDelaySeconds: 300` | The fossil. Five minutes of crash-detection blindness every boot | Low urgency, real cost |
| Readiness checks four downstreams | Any blip anywhere removes this pod from rotation; the failure domain is the union of everyone else's | **High** — and it *looks* diligent in review |
| No probes at all | Kubernetes routes traffic the instant the port opens; rolling deploys drop requests | Medium — hurts at every deploy, invisibly |

Rank by the 3am column. Dependency-checking liveness and 1s-timeout-on-JVM get fixed first; fossils get cleaned up last.

### The migration order that never breaks prod

The ordering principle: **each step is individually safe, and the dangerous probe is touched last.**

1. **Add `startupProbe` first.** Pure safety: it can only *delay* the other probes, never add a new way to die. It also immediately de-risks every subsequent rollout in this program, because slow boots stop racing the liveness clock.
2. **Split endpoints in code.** Ship `/health/live` and `/health/ready` (designed per the sections above) while the old `/actuator/health` keeps answering. Nothing in Kubernetes changes yet; this step is just a deploy.
3. **Point readiness at the new endpoint — under audit-first observation.** Before the cutover, run the new endpoint dark: export its verdict as a metric and build the **would-have-failed dashboard** — "how often would the new readiness have pulled pods, and would it have been right?" The cheapest implementation is a gauge the app updates alongside the (not-yet-wired) endpoint:

   ```promql
   # Would-have-failed minutes per pod, last 7d — the cutover license
   sum by (pod) (
     count_over_time((app_readiness_check_status{check!="", status="down"} == 1)[7d:30s])
   ) * 30 / 60
   ```

   Zero is suspicious (is the check actually checking anything?); a handful of minutes that line up with known dep blips is exactly right; hours of would-have-failed on a service that served fine means a dep is misclassified — fix the classification, not the threshold. Dashboard patterns in [Metrics](/observability/metrics/). A week of explainable results is your license to cut over. Readiness goes first because its blast radius is "one pod briefly out of rotation," which the fleet absorbs.
4. **Fix liveness LAST, most conservatively.** Liveness kills things; it gets the longest observation and the gentlest thresholds (`failureThreshold: 5` and a real timeout on day one — tighten later with data, per [Health Check Knobs](/tuning/health-check-knobs/)). If the old liveness was the dependency-checking kind, this step is where the fleet-outage class of incident actually dies.
5. **Delete the fossils.** `initialDelaySeconds: 300` goes (the startup probe owns that job now); the old shared endpoint gets a deprecation log line, then removal two releases later.

Run the whole sequence in waves under GitOps — same choreography as the [resources retrofit](/tuning/brownfield-resources/): canary workload, then tiers by criticality, every step a PR ([GitOps for Tenants](/operations/gitops-for-tenants/)).

### Verification per wave

Two drills, run on the canary before a wave is called done:

- **The dependency-blip drill.** In a controlled window: block the DB (network policy or a `kubectl exec` iptables rule on a test replica) for 30 seconds. Expected: readiness drops, traffic drains, **zero restarts**, pods return within one probe period of the dep. Any restart means liveness still knows about a dependency — abort, fix, re-run.
- **The deploy-under-load drill.** Roll the deployment during realistic traffic; the error-rate graph should not notice. This proves readiness gating and graceful shutdown are actually doing the zero-downtime dance — the full mechanics are in [Zero-Downtime Architectures](/architectures/zero-downtime/).

While drilling, read the events without panicking — `Unhealthy` events are the probe *working*:

```bash
kubectl get events -n shop --field-selector reason=Unhealthy --sort-by=.lastTimestamp | tail -3
```

```text
LAST SEEN   TYPE      REASON      OBJECT                        MESSAGE
2m14s       Warning   Unhealthy   pod/orders-api-7d9f8b6c5-2x   Readiness probe failed: HTTP 503 {"checks":{"postgres":"DOWN"}}
2m4s        Warning   Unhealthy   pod/orders-api-7d9f8b6c5-2x   Readiness probe failed: HTTP 503 {"checks":{"postgres":"DOWN"}}
```

Readiness failing *during a DB blip you caused* is the contract being honored. The event to fear is `Killing` following `Liveness probe failed` on a pod that was serving fine. Reading event streams calmly is a skill worth building — see [Events](/observability/events/).

## Standardizing across the org

Once the retrofit works on one fleet, freeze it into a paved road so new services never enter the audit table:

**The probe spec** — one page, versioned, linked from every service template: endpoint names (`/health/live`, `/health/ready`, `/health/started`), the consequence table, the dependency-classification rules, response format (status + per-check breakdown), and a link to [Health Checks](/workloads/health-checks/) for the kubelet semantics. Bake the endpoints into your service starters so the default is compliant.

**The probe-review checklist for new services:**

- [ ] Dependency table exists with hard/soft/async classification — and someone argued about at least one row
- [ ] Liveness endpoint does zero I/O
- [ ] Readiness per-dep timeouts sum below `timeoutSeconds`
- [ ] Startup probe present if boot > ~10s; no `initialDelaySeconds` fossils
- [ ] Probes point at group/tag endpoints, not the framework's kitchen-sink default
- [ ] Blip drill and deploy-under-load drill pass in staging

**The anti-checklist** — never, with no exceptions process:

1. **Never** a dependency check in liveness.
2. **Never** one endpoint serving both probes.
3. **Never** a probe that calls *another service's* health endpoint. Transitive health checks build this graph:

```text
  orders /ready ──▶ payments /ready ──▶ fraud /ready ──▶ ML-scorer /ready
     ▲                                                        │
     └──── fleet-wide unready cascade ◀── one slow pod ◀──────┘
```

One slow pod at the end of the chain and every service upstream flips unready in probe-period lockstep. Each service checks its *own* hard deps, one hop, no further — the transitive failures you're tempted to check for are exactly what circuit breakers and fallbacks are for.

## The ten rules

1. Design the endpoint backwards from the kubelet's consequence.
2. Classify every dependency: hard, soft, or async — in writing.
3. Liveness checks nothing but self, and costs microseconds.
4. Readiness checks hard deps only, with hysteresis.
5. Soft deps gate feature flags, never probes.
6. Per-dep timeouts must sum below the probe timeout.
7. Startup probes model initialization; `initialDelaySeconds: 300` is a fossil.
8. Retrofit in the safe order: startup → split → readiness (audited dark first) → liveness last → delete fossils.
9. Prove each wave with the blip drill and the deploy-under-load drill.
10. One endpoint, one hop: no shared probe endpoints, no transitive health checks.

The timing dials for everything above live in [Health Check Knobs](/tuning/health-check-knobs/); the kubelet-side semantics in [Health Checks](/workloads/health-checks/). This article's job was the part no field in the YAML can express: deciding what health *means*.
