---
title: Health Checks
description: Startup, readiness, and liveness probes — exact semantics, tuning math, and the classic misconfigurations that turn probes into outage amplifiers.
keywords:
  - liveness probe restarting healthy pod
  - readiness probe failed 503
  - startupprobe slow boot
  - probe context deadline exceeded
  - timeoutseconds too aggressive
  - pod not receiving traffic
  - failurethreshold periodseconds math
  - unhealthy killing container
  - grpc health probe
  - readiness checking database dependency cascade
  - initialdelayseconds
sidebar:
  order: 7
---

Probes are the only channel your app has to tell Kubernetes how it's doing, and Kubernetes acts on them with total literal-mindedness. A wrong probe isn't neutral — it's an automated operator that kills healthy pods or routes traffic to broken ones, at machine speed, around the clock. Get the semantics exactly right.

:::note[The bigger picture]
This is **Door 2 — Truth** of [The Three Doors](/start/three-doors/): a pod's honest contract with the cluster about its own state, from first boot through [graceful shutdown](/workloads/graceful-shutdown/). It's the door that makes scaling and rollouts safe — dishonest here, and every scale event acts on false information.
:::

:::tip[Looking for the dials?]
This article explains how probes behave; the consolidated knob table — every field, default, the restart math, and per-archetype recipes — lives in [Health Check Knobs](/tuning/health-check-knobs/).
:::

:::tip[War story]
Footgun #2 happened for real: [The Readiness Probe That Took Down Prod](/blog/the-readiness-probe-that-took-down-prod/) — a 30-second dependency blip becoming 100% 503s.
:::

## The three probes, precisely

| Probe | Question it answers | On failure (past threshold) | Runs |
|---|---|---|---|
| **startup** | "Has the app finished booting?" | Container is **restarted** | Only until first success, then never again |
| **readiness** | "Can this pod serve traffic *right now*?" | Pod removed from Service **endpoints** — no restart | Entire pod lifetime |
| **liveness** | "Is the process wedged beyond recovery?" | Container is **restarted** (per pod `restartPolicy`) | Entire lifetime (after startup probe passes) |

The distinctions people blur, spelled out:

- **Readiness failure is reversible and non-violent.** The pod is unplugged from load balancing and plugged back in when the probe passes. Nothing restarts. It's a flow-control valve.
- **Liveness failure is a kill.** The kubelet restarts the container in place (same pod, same IP, `RESTARTS` counter increments). Repeated kills earn exponential backoff — that's one of the roads to [CrashLoopBackOff](/troubleshooting/crashloopbackoff/).
- **While a startup probe is defined and hasn't succeeded, liveness and readiness are disabled.** This is the whole point of startup probes: a protected boot window.
- Readiness also gates rollouts: a pod that never becomes Ready never counts as available, and your [rollout stalls](/workloads/rollouts-and-rollbacks/) — which is a feature.
- A pod with **no** readiness probe is Ready the instant its containers start. For anything behind a Service, that means traffic arrives before your app can serve it. Every service pod needs a readiness probe; that part is non-negotiable.
- Liveness, by contrast, is **optional** — and the burden of proof is on adding it, not omitting it.

## Probe mechanics

Four types:

```yaml
readinessProbe:
  httpGet:                      # 2xx/3xx = pass. The workhorse.
    path: /healthz/ready
    port: 8080
livenessProbe:
  tcpSocket:                    # port accepts a connection = pass. Weak signal.
    port: 5432
startupProbe:
  exec:                         # exit 0 = pass. For things without a port.
    command: ["sh", "-c", "test -S /tmp/app.sock"]
```

And the fourth, for gRPC services (shown separately — a container spec can
only declare one `readinessProbe`):

```yaml
readinessProbe:
  grpc:                         # standard gRPC health-checking protocol
    port: 9090
```

`exec` probes fork a process in your container every period — cheap-ish, but I've seen busy nodes where heavyweight exec probes (a JVM-spawning script, say) were a measurable CPU tax. Keep exec probes to a shell one-liner. For gRPC services, the native `grpc` probe beats packaging `grpc_health_probe` into your image.

The timing knobs, per probe:

```yaml
initialDelaySeconds: 0    # wait before first attempt
periodSeconds: 10         # attempt interval
timeoutSeconds: 1         # per-attempt timeout — the default 1s is aggressive
successThreshold: 1       # consecutive passes to flip healthy (readiness only, effectively)
failureThreshold: 3       # consecutive failures to flip unhealthy
```

Time-to-detect = `periodSeconds × failureThreshold` (plus up to one period of phase). Defaults give you ~30s. Time-to-kill a booting app = `initialDelaySeconds + periodSeconds × failureThreshold` — do this arithmetic against your *worst* observed startup, not your laptop's.

:::caution
`timeoutSeconds: 1` default bites real apps: a GC pause or a slow disk makes one probe take 1.2s, and that counts as a failure. Three in a row under load and your liveness probe kills a pod that was merely busy. Set `timeoutSeconds` to 2–5 unless you have a reason not to.
:::

## startupProbe vs initialDelaySeconds

The old way to protect slow boots was a big `initialDelaySeconds` on the liveness probe. It's a bad trade: set it to your worst-case boot (say 120s) and every fast boot still waits 120s before liveness protection begins and — worse — you've added nothing for the day boot takes 130s.

`startupProbe` fixes the shape of the problem:

```yaml
startupProbe:
  httpGet: { path: /healthz/started, port: 8080 }
  periodSeconds: 5
  failureThreshold: 36        # up to 180s of boot allowed
livenessProbe:
  httpGet: { path: /healthz/live, port: 8080 }
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 3         # tight, because startup is already protected
```

Boot finishes whenever it finishes — 20s or 170s — and the moment the startup probe passes, the tight liveness probe takes over. You get a generous ceiling *and* fast steady-state detection. Any app with variable startup (JVMs especially — class loading and JIT warmup vary wildly with CPU throttling; see [JVM in containers](/java/jvm-in-containers/)) should use a startup probe instead of a padded initialDelay.

:::note[JVM warmup ≠ started]
A JVM app can pass "started" and still serve its first hundred requests at 10× normal latency while the JIT warms up. If that matters, keep readiness failing until a warmup routine completes (prime caches, exercise hot paths), or accept the slow-start. Spring Boot ships purpose-built liveness/readiness health groups via the actuator for exactly this wiring — see [Spring Boot on Kubernetes](/java/spring-boot/). Related: [resources-and-qos](/workloads/resources-and-qos/) — CPU limits throttle warmup hard.
:::

## Footgun #1: liveness probes that kill slow-but-healthy apps

The pattern: liveness passes for months, then one day the app is under heavy load (or a long GC, or a slow downstream), responses take 2s, the probe times out three times, kubelet kills the container. Now the survivors carry more load, respond slower, fail *their* probes, get killed... You've built a doom loop where the remedy is the disease. I have watched a liveness probe convert "elevated latency for five minutes" into "total outage for forty."

Rules that prevent it:

- A liveness endpoint must test exactly one thing: **is this process wedged?** Return 200 from a trivial handler that touches no locks, no DB, no downstream. If the HTTP server answers at all, the process is alive.
- Never point liveness and readiness at the **same endpoint**. Their failure actions are different; their questions must be too.
- Ask what restarting actually fixes. Deadlocks, wedged event loops — yes. Load, slow dependencies, memory pressure — no; a restart makes each of those *worse*.
- When in doubt, ship without a liveness probe. An app that crashes on fatal errors (exits, rather than limping) gets restarted by the kubelet anyway, no probe needed.

## Footgun #2: readiness that checks downstream dependencies

Tempting logic: "we can't serve without the database, so readiness should check the database." Now the database blips for 60 seconds and *every replica* of your service goes NotReady simultaneously. The Service has zero endpoints; callers get connection refused instead of fast 503s; **their** deep readiness checks notice and *they* all go NotReady. One flaky dependency has cascaded into a platform-wide gray-out — and when the DB recovers, everything thunders back at once.

Better model:

- **Readiness = "is *this pod* worse than its siblings?"** Local conditions only: booted, config loaded, not saturated. If a dependency is down for you, it's down for all replicas, and removing all of them from rotation helps nobody.
- Handle downstream failure **in the request path**: fail fast, return a 503 with a Retry-After, trip a circuit breaker. Callers coping with an unhealthy response beats callers coping with no endpoints.
- Exception worth knowing: checking a *hard-local* dependency (e.g., a sidecar the pod can't function without) is fine — its failure domain is the pod itself.

To be precise, the rule is never check dependencies **naively**. A disciplined version — hard dependencies only, flap-damped with hysteresis, per-dependency timeout budgets — is legitimate, and [Health Check Design](/tuning/health-check-design/) is the canonical treatment of when and how. Until you're doing that discipline, the local-only model above is the safe default.

If your service mysteriously vanishes from its Service during dependency incidents, this footgun is almost always why — the [service-unreachable runbook](/troubleshooting/service-unreachable/) has the diagnosis path.

## Debugging probe failures

Probe failures land in pod Events with the actual error:

```console
$ kubectl describe pod payments-7d9f8b6c4d-x2kfp
...
Events:
  Warning  Unhealthy  2m (x4 over 3m)  kubelet  Readiness probe failed: HTTP probe failed with statuscode: 503
  Warning  Unhealthy  90s              kubelet  Liveness probe failed: Get "http://10.42.3.17:8080/healthz/live": context deadline exceeded
  Normal   Killing    90s              kubelet  Container payments failed liveness probe, will be restarted
```

`statuscode: 503` means your app answered and said no — read your app's logs for why. `context deadline exceeded` means it didn't answer in `timeoutSeconds` — that's saturation, GC, or a dead process. `connection refused` means nothing is listening — wrong port in the probe, or the app hasn't bound yet. Three different errors, three different fixes; don't treat them as one.

You can also hit the endpoint yourself from inside the pod to remove the kubelet from the equation:

```console
$ kubectl exec payments-7d9f8b6c4d-x2kfp -- wget -qO- --timeout=2 http://localhost:8080/healthz/ready
```

## A sane default template

For a typical HTTP service with variable startup:

```yaml
startupProbe:
  httpGet: { path: /healthz/ready, port: 8080 }
  periodSeconds: 5
  failureThreshold: 24          # 120s boot ceiling — set from YOUR p99 boot time
readinessProbe:
  httpGet: { path: /healthz/ready, port: 8080 }
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 3
# livenessProbe: add only when you can name the wedge it detects,
# and point it at a trivial local endpoint if you do.
```

Sharing the readiness endpoint with the startup probe is fine — it's the *liveness* endpoint that must stay separate and dumb.
