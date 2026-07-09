---
title: "Spring Boot Actuator as an Ops Surface"
description: "The full Actuator endpoint catalog for locked-down Kubernetes: runtime log levels, thread and heap dumps over HTTP, live config inspection, and the exposure discipline that keeps it all off your attack surface."
keywords:
  - change log level without redeploy
  - /actuator/heapdump credential leak
  - exposure.include=* vulnerability
  - management port 8081 port-forward
  - runtime log levels over http
  - management.endpoints.web.exposure.include
  - /actuator/env masked values
  - show-values=when-authorized
  - CycloneDX SBOM endpoint
  - micrometer prometheus scrape
  - git commit id which version running
sidebar:
  order: 13
---

On a cluster you don't administer, you can't install tools. No node access, no debug sidecars without a change request, a production image that is JRE-only and distroless-adjacent. What you *do* have is whatever your application compiled in — and Spring Boot Actuator is an entire HTTP ops API baked into the app at build time. Every endpoint you enable before the incident is a tool you'll have during it. Every endpoint you didn't is a redeploy away, which during an incident means it might as well not exist.

This page is the operations catalog: what each endpoint gives you, the Kubernetes workflow it unlocks, and the sharp edge on each. Probes, health groups, and graceful shutdown are Actuator too, but they're deployment wiring, not incident tooling — they live in [Spring Boot on Kubernetes](/java/spring-boot/) and [Health Checks](/workloads/health-checks/) and won't be repeated here.

The access pattern for everything below is the same, because the management port should never be reachable through your ingress:

```bash
kubectl -n payments port-forward deploy/payment-api 8081:8081
# then, in another terminal, everything is curl against localhost:8081
```

`kubectl port-forward` is your tunnel of last and first resort on a namespace-scoped kubeconfig — more tricks for it in [kubectl Tips and Tricks](/kubectl/tips-and-tricks/).

## Exposure discipline: enabled ≠ exposed ≠ reachable

Three separate gates, and teams conflate them constantly:

1. **Enabled** — the endpoint bean exists (`management.endpoint.<id>.access=read-only` or the legacy `.enabled=true`). Most are enabled by default; `shutdown` is not.
2. **Exposed** — the endpoint is mapped over HTTP (`management.endpoints.web.exposure.include`). Only `health` is exposed by default.
3. **Reachable** — the network lets someone hit it. This one is yours to control with ports and NetworkPolicy.

The config that gets all three right:

```yaml
# application.yaml
management:
  server:
    port: 8081            # separate connector, separate thread pool
  endpoints:
    web:
      exposure:
        include: health,info,prometheus,loggers,threaddump,heapdump,env,metrics
  endpoint:
    shutdown:
      access: none        # exists in the framework; keep it dead (see below)
```

That `include` list is an explicit allowlist, and the discipline matters. `management.endpoints.web.exposure.include=*` in production is a gift to attackers: the historical pattern behind a whole family of Spring Boot compromises is an internet-reachable `/actuator/env` or `/actuator/heapdump` leaking credentials, followed by lateral movement. You should be able to recite your production allowlist from memory. If you can't, it's too long.

Reachability, concretely:

- The management port goes in the pod spec as a named `containerPort` (so Prometheus annotations and NetworkPolicy can reference it) but **not** in the Service that backs your Ingress. No route, no exposure.
- A [NetworkPolicy](/networking/network-policies/) allows ingress to port 8081 only from the monitoring namespace (Prometheus scraping `/actuator/prometheus`) — everything else is denied. `kubectl port-forward` still works because it tunnels through the kubelet, not the pod network.
- If your security team requires authentication anyway, a small Spring Security config scoped to the management port does it: permit `EndpointRequest.to(HealthEndpoint.class)`, require a role on `EndpointRequest.toAnyEndpoint()`, HTTP Basic with credentials from a [Secret](/workloads/secrets/). Ten lines. But treat it as defense in depth, not a substitute for keeping the port off the Ingress.

:::caution[Port-forward beats "just add it to the ingress" every time]
Every ingress path to `/actuator/**` you add "temporarily for debugging" becomes permanent, unauthenticated, and forgotten. The port-forward one-liner costs you five seconds per incident and zero attack surface the rest of the year.
:::

And the pod-spec side — the named port that NetworkPolicy and scrape configs reference, deliberately absent from the app Service:

```yaml
# deployment snippet
ports:
  - name: http
    containerPort: 8080   # in the Service, behind the Ingress
  - name: management
    containerPort: 8081   # NOT in the Service; NetworkPolicy + port-forward only
```

## The catalog

First move on any unfamiliar service — ask the app what it's actually serving. The discovery document is the ground truth for this pod's build, not whatever the wiki claims:

```bash
curl -s localhost:8081/actuator | jq -r '._links | keys[]'
```

```console
health
health-path
heapdump
info
loggers
loggers-name
metrics
metrics-requiredMetricName
prometheus
threaddump
```

If the endpoint you need isn't in that list, no amount of curl will conjure it — it goes on the allowlist in the next release, which is exactly why you read this page *before* the incident.

### /actuator/loggers — change log levels without a redeploy

The most underrated endpoint in the list. GET shows every logger and its effective level; POST changes one at runtime:

```bash
curl -s localhost:8081/actuator/loggers/com.acme.payments.gateway | jq
```

```json
{
  "configuredLevel": null,
  "effectiveLevel": "INFO"
}
```

```bash
curl -s -X POST localhost:8081/actuator/loggers/com.acme.payments.gateway \
  -H 'Content-Type: application/json' \
  -d '{"configuredLevel":"DEBUG"}'
```

That's it. No restart, no redeploy, no editing a ConfigMap and waiting for a rollout, no config drift between what Git says and what the pod runs — because you didn't touch the deployed config at all. Scope it to **one logger** (`com.acme.payments.gateway`), not the root: root-at-DEBUG on a busy service can 10x your log volume and take your logging pipeline down as collateral (rates and pipeline math in [Logging Fundamentals](/observability/logging-fundamentals/)).

The change lives in JVM memory only, so it resets when the pod restarts. **That's a feature.** Your DEBUG session cannot outlive the incident, can't get baked into the next deploy, and can't quietly cost you ingestion fees for six months. To undo it immediately, POST `{"configuredLevel":null}` to fall back to the configured level.

:::note[Watch the replica count]
Port-forward targets one pod. If traffic is load-balanced across five replicas, your DEBUG logs capture ~20% of requests. Either forward to the specific pod serving the errors, or POST to each replica.
:::

### /actuator/threaddump — thread dumps over HTTP

Returns a full thread dump — JSON by default, classic `jstack`-style text if you ask:

```bash
curl -s -H 'Accept: text/plain' localhost:8081/actuator/threaddump > dump-1.txt
```

```console
$ head -4 dump-1.txt
2026-07-03 14:22:07
Full thread dump OpenJDK 64-Bit Server VM (21.0.5+11 mixed mode):

"http-nio-8080-exec-3" - Thread t@42 RUNNABLE
```

The JSON form is nice for scripting; the `text/plain` form is what every thread-dump analyzer and every senior engineer's eyeballs expect. Everything about *reading* the dump — and the non-negotiable discipline of taking **three dumps, ten seconds apart**, because one dump is a photo and you need a flipbook — is in [Thread Dumps Without a JDK](/java/thread-dumps-jre-only/). This endpoint is simply the easiest of the JRE-only capture paths: no `kubectl exec`, no `jcmd`, no writable filesystem required.

### /actuator/heapdump — the JRE-only crown jewel

A GET that triggers a live heap dump and streams the `.hprof` straight down the connection:

```bash
kubectl -n payments port-forward pod/payment-api-7c9f8-x2klm 8081:8081 &
curl -s -o heap.hprof localhost:8081/actuator/heapdump
ls -lh heap.hprof
```

```console
-rw-r--r--  1 you  staff   1.4G Jul  3 14:31 heap.hprof
```

Stop and appreciate what just happened on a locked-down cluster: no JDK in the image, no `kubectl exec`, no writable volume, no `kubectl cp` — and the file is already on your laptop. The download **is** the extraction step; the whole file-shuffling problem covered in [Getting Dumps Out of the Cluster](/java/getting-dumps-out/) evaporates for this one artifact. The other capture paths and when you need them are in [Heap Dumps Without a JDK](/java/heap-dumps-jre-only/); what to do with the file once you have it is [Memory Leaks and OOMKilled](/java/memory-leaks-and-oom/).

The costs, because they're real:

- **The dump is a stop-the-world pause.** A multi-GB heap freezes the JVM for seconds. Readiness probes may fail during it (usually fine — the pod stops taking traffic, then recovers); a tight liveness probe can *kill the pod mid-dump*. Know your probe timeouts before you pull the trigger on a struggling pod.
- **Size ≈ live heap.** A 4 GB heap is a multi-GB download through a port-forward tunnel; budget minutes, and don't Ctrl-C the forward halfway.
- **The dump also needs headroom to be written** to the pod's temp dir before streaming — a pod that's OOM-adjacent on ephemeral storage can fail the dump.

:::danger[A heap dump contains everything the JVM had in memory]
Passwords, session tokens, API keys, customer PII — all of it, in plaintext, in that `.hprof`. This is precisely why `heapdump` exposed to the internet is a critical finding, and why the file on your laptop is now sensitive material: encrypt it, don't attach it to tickets, delete it when the analysis is done.
:::

### /actuator/env and /actuator/configprops — what is this pod ACTUALLY running with

The eternal incident question: "is the pod running the config we think it is?" `/actuator/env` shows every property source in precedence order — env vars, ConfigMaps mounted as [environment variables](/workloads/environment-variables/), `application.yaml`, defaults — and which source *won* for each key. `/actuator/configprops` shows the resolved values actually bound into your `@ConfigurationProperties` beans, which is what the code truly sees.

```bash
curl -s localhost:8081/actuator/env/spring.datasource.url | jq
```

```json
{
  "property": {
    "source": "systemEnvironment",
    "value": "******"
  }
}
```

That `******` is the sharp edge and the safety net at once: since Spring Boot 3, **all values are masked by default**, not just key names matching `password|secret|token`. To see values, you opt in deliberately:

```properties
# show values EXCEPT sanitized keys — the sane middle ground
management.endpoint.env.show-values=when-authorized
# or, live dangerously (never in prod):
# management.endpoint.env.show-values=always
# and add your own patterns to the mask list (per endpoint):
management.endpoint.env.additional-keys-to-sanitize=apikey,connectionstring
management.endpoint.configprops.additional-keys-to-sanitize=apikey,connectionstring
```

`show-values=always` on an exposed endpoint reproduces the classic pre-Boot-3 breach pattern in one line of config. Use `when-authorized` with Spring Security on the management port, or leave it masked and use `/actuator/env/{property}` just to confirm *which source* a value came from — during a "wrong database" incident, the source name is usually the answer. Never confirm [Secret](/workloads/secrets/) *values* through this endpoint when confirming the *key and source* will do.

### /actuator/metrics and /actuator/prometheus

`/actuator/metrics/{name}` gives you ad-hoc reads of any Micrometer meter (`jvm.memory.used`, `http.server.requests`, connection pool gauges) with tag drill-down — handy over a port-forward when you want one number *right now* without opening Grafana. `/actuator/prometheus` is the scrape endpoint your monitoring stack should already be consuming. This page won't repeat the metrics story: which meters matter and how to wire the scrape are in [Java Observability](/java/java-observability/) and [Metrics](/observability/metrics/).

### /actuator/mappings, /actuator/beans, /actuator/conditions — the 404 trio

When an endpoint 404s in one environment and works in another, these three answer it in order: `mappings` shows every registered route and its handler method (is the controller even mapped?); `beans` shows whether the bean exists at all; `conditions` shows *why* an auto-configuration did or didn't fire — the runtime version of the startup condition report. Nine times out of ten the answer is a missing property or profile that disabled an auto-config, and `conditions` names it explicitly. All three responses are enormous; pipe to `jq` and grep.

```bash
curl -s localhost:8081/actuator/mappings | jq -r '.. | .predicate? // empty' | grep -i refund
```

### /actuator/info — which commit is actually running

With the `git-commit-id` Maven/Gradle plugin and `springBoot { buildInfo() }`, `/actuator/info` answers the first question of every incident call:

```bash
curl -s localhost:8081/actuator/info | jq '.git.commit.id, .build.time'
```

```json
"a3f81c2"
"2026-07-01T09:14:22Z"
```

Image tags lie (`:latest`, retagged builds, cache surprises). The commit hash compiled into the jar does not. Cheap to add, exposed-by-default-safe, and it ends the "but I thought we deployed the fix" argument in five seconds.

### /actuator/scheduledtasks, /actuator/caches, /actuator/sbom

- **`scheduledtasks`** lists every `@Scheduled` job with its cron/interval — the fast answer to "is the nightly reconciliation even registered in this pod?" (and to discovering the job is registered in *all five replicas*, which explains the duplicate emails).
- **`caches`** lists cache managers, and `DELETE /actuator/caches/{name}` evicts one at runtime — the surgical fix for "stale config cached in memory" that otherwise gets solved with a rolling restart of twenty pods.
- **`sbom`** (Boot 3.3+) serves the CycloneDX SBOM generated at build time. When the next Log4Shell-class CVE drops, `curl | jq` against the *running pod* tells you whether you're affected — no image archaeology.

### /actuator/shutdown — exists; keep it off

It's disabled by default and should stay that way (`management.endpoint.shutdown.access=none` if you want it explicit). A POST that kills the JVM is strictly worse than what Kubernetes already gives you: `kubectl rollout restart` and pod deletion go through SIGTERM, `preStop`, readiness-gated draining, and PodDisruptionBudgets. `/actuator/shutdown` bypasses your own orchestrator's safety rails and hands any client on the management network a denial-of-service button. There is no incident where it's the right tool.

## A worked twenty minutes

Real shape of an incident, p99 latency spike on `payment-api`, one pod worse than the others:

```bash
# 14:02 — tunnel to the suspect pod
kubectl -n payments port-forward pod/payment-api-7c9f8-x2klm 8081:8081

# 14:03 — turn up exactly one logger
curl -s -X POST localhost:8081/actuator/loggers/com.acme.payments.gateway \
  -H 'Content-Type: application/json' -d '{"configuredLevel":"DEBUG"}'

# 14:04–14:06 — DEBUG logs show requests stalling in the retry wrapper; confirm with threads
for i in 1 2 3; do
  curl -s -H 'Accept: text/plain' localhost:8081/actuator/threaddump > td-$i.txt
  sleep 10
done
# → 40 http-nio threads parked in the same connection-pool wait across all three dumps

# 14:09 — pool exhaustion smells like a leak; grab the heap while it's misbehaving
curl -s -o heap-1402.hprof localhost:8081/actuator/heapdump   # 1.4 GB, ~3 min

# 14:14 — put the log level back
curl -s -X POST localhost:8081/actuator/loggers/com.acme.payments.gateway \
  -H 'Content-Type: application/json' -d '{"configuredLevel":null}'
```

Twelve minutes. Zero redeploys, zero manifest changes, zero config drift to clean up afterward, and a heap dump on your laptop for the postmortem. The alternative timeline — PR to bump the log level, CI, rollout, *the rollout restarts the pod and destroys the evidence* — doesn't produce a root cause at all.

## Ops hygiene: what to expose in prod

| Endpoint | Expose in prod? | Why |
| --- | --- | --- |
| `health` | Yes | Probes need it; safe by design |
| `info` | Yes | Commit hash during incidents; no sensitive data if you keep it to build/git |
| `prometheus`, `metrics` | Yes | Monitoring depends on it; NetworkPolicy-restrict to the scraper |
| `loggers` | Yes | Highest incident value per byte of risk; POST is the only write worth having |
| `threaddump` | Yes | Read-only, cheap, invaluable |
| `heapdump` | Yes, with eyes open | The JRE-only dump path — but it serves your secrets to anyone who can reach it. Port-forward-only, never routed |
| `env`, `configprops` | Cautiously | Masked by default in Boot 3+; keep `show-values` off or `when-authorized` |
| `mappings`, `beans`, `conditions` | Optional | Debugging aids; expose in staging always, prod if your NetworkPolicy is solid |
| `sbom`, `scheduledtasks`, `caches` | Optional | Low risk, occasional high value |
| `shutdown` | **Never** | Kubernetes restart semantics are better in every way |

:::danger[Actuator is attack surface, not just tooling]
The recurring real-world compromise pattern is boring and effective: `exposure.include=*`, management port on the shared connector, `/actuator/**` reachable through the ingress. Attackers scan for it specifically — `/actuator/env` for credentials and cloud keys, `/actuator/heapdump` for everything else in memory. Every control in this article exists because that scan finds someone every week. Allowlist the endpoints, split the port, keep it off the Service, NetworkPolicy the remainder.
:::

## Running .NET too?

Every capability on this page has a dotnet-monitor twin — live log levels, dumps over HTTP, the sidecar pattern that replaces the built-in-endpoint model. The mapping, endpoint by endpoint, is in [.NET Operational Endpoints](/dotnet/operational-endpoints/).
