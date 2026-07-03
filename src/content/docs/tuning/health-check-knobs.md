---
title: "Health Check Knobs"
description: Every probe tunable in one place — defaults, the restart and rotation math, interaction effects, and per-archetype recipes with numbers derived from evidence.
sidebar:
  order: 2
---

This is the dial-by-dial reference for probes. The semantics — what each probe *means* and what Kubernetes does on failure — live in [Health Checks](/workloads/health-checks/); read that first if the difference between readiness and liveness is fuzzy. This page assumes you know the semantics and need the numbers: what each field defaults to, what turning it actually changes, and how the knobs multiply together into time-to-restart, time-to-traffic, and time-out-of-rotation.

## The knob table

Every field below exists on all three probes (`startupProbe`, `readinessProbe`, `livenessProbe`) unless noted.

| Knob | Default | What it actually does | When to turn it | What to watch after |
|---|---|---|---|---|
| `initialDelaySeconds` | `0` | Kubelet waits this long after container start before the *first* probe attempt. A dead delay — nothing probes, nothing passes early. | Almost never. Use a `startupProbe` instead; a delay penalizes your fastest starts and still fails your slowest. Legit only as a tiny stagger (2–5s) when a startup probe would be overkill. | Time-to-Ready on fresh pods (it's a hard floor on it). |
| `periodSeconds` | `10` | Interval between probe attempts. The clock every other knob multiplies against. | Down (3–5s) on readiness for faster traffic reaction; up (15–30s) on expensive `exec` probes. Never below 5s on liveness without a reason you can write down. | Probe overhead in app logs/CPU; detection latency. |
| `timeoutSeconds` | `1` | How long a single attempt may take before it counts as a **failure**. The most under-set knob on this page: the default assumes your health endpoint answers in under one second, always, including during GC pauses and CPU throttling. | Up, on almost every real service. Set it above your health endpoint's p99 latency *under load* — 3–5s is a sane floor for anything JVM-shaped. | `Unhealthy` events with "context deadline exceeded" / "timed out". |
| `successThreshold` | `1` | Consecutive successes needed to flip from failing to passing. **Must be 1 for liveness and startup** — the API server rejects anything else. | Readiness only. `2–3` makes a flappy pod prove itself before rejoining rotation — at the price of `successThreshold × periodSeconds` extra recovery time. | Recovery latency after blips; endpoint churn rate. |
| `failureThreshold` | `3` | Consecutive failures needed to act (kill for liveness/startup, de-rotate for readiness). Your flap-resistance and your detection-latency, in one knob. | Up on liveness to survive transient stalls; way up on startup (it *is* the boot budget). Never `1` — a single dropped packet becomes a restart. | Restart counts (liveness), endpoint add/remove churn (readiness). |
| `terminationGracePeriodSeconds` (probe-level) | unset (inherits pod value) | On **liveness and startup probes only** (rejected on readiness; stable since v1.28): when *this probe* triggers the kill, use this grace period instead of the pod-wide one. | When your pod-level grace is long for clean shutdown (e.g. 120s to drain), but a liveness-failed process is wedged and there's no point waiting — set the probe-level value to 5–10s. | Whether liveness-restarted pods actually die fast (`kubectl get events`). |

:::caution[timeoutSeconds: 1 is the page's biggest footgun]
Every knob here has a defensible default except this one. A health endpoint that usually answers in 80ms will exceed 1s during a full GC, a CPU-throttle window, or a node under I/O pressure — and a timeout **is** a failure. Three of those in a row (default `failureThreshold`) and liveness kills a healthy pod. If you change exactly one number after reading this page, make it this one.
:::

## The mechanism knobs

The probe *handler* is a knob too — you choose what "healthy" is measured by:

| Mechanism | Fields | Pass condition | Cost per period | Reach for it when |
|---|---|---|---|---|
| `httpGet` | `path`, `port` (name or number), `scheme` (`HTTP`/`HTTPS`, self-signed certs accepted), `httpHeaders` | Status 200–399 | One HTTP request from the kubelet | Default choice for anything with an HTTP port. `httpHeaders` for a required `Host:` or auth header. |
| `tcpSocket` | `port`, `host` | TCP connect succeeds | One SYN/ACK/close | Non-HTTP servers (databases, brokers). Weak signal — a wedged app often still `accept()`s. |
| `exec` | `command` (argv array, no shell unless you invoke one) | Exit code 0 | **A process fork/exec inside the container, every period, per probe** | No port at all (workers, sidecars). Keep the command cheap: a shell one-liner, never a JVM/Python interpreter spin-up. |
| `grpc` | `port` (number only), `service` (name passed to the standard `grpc.health.v1.Health` check) | `SERVING` response | One gRPC health RPC | gRPC servers implementing the health protocol (stable since v1.27). Distinct `service` names let readiness and liveness ask different questions on one port. |

:::note[exec probes are the expensive ones]
An `exec` probe is a `fork()`+`exec()` in your container's cgroup every `periodSeconds` — for *each* probe that uses it. Three exec probes at `periodSeconds: 5` is 36 process spawns a minute, billed against your CPU limit. And if the command is `java -jar healthcheck.jar`, you're paying a JVM startup per probe. Use a file-touch check or a tiny shell test, and stretch the period to 30–60s.
:::

## Which knobs matter per probe type

| Probe | The knob(s) that dominate | Why |
|---|---|---|
| **startup** | `failureThreshold × periodSeconds` | That product *is* your boot budget. Everything else is secondary — set `period: 5` for fast handoff and buy time with `failureThreshold`. |
| **readiness** | `periodSeconds` + `timeoutSeconds` (+ `successThreshold`) | Readiness is a flap-resistance problem: react fast to real breakage, ignore one-off blips, and don't churn endpoints. |
| **liveness** | `timeoutSeconds` and `failureThreshold` | Liveness is kill math. The only question is: how long must the process be *provably* wedged before you shoot it? Bias every knob toward patience. |

## The math

All the outage math on this page is multiplication. Worked numbers use the stated knobs.

**Time-to-restart (liveness).** With `periodSeconds: 10`, `timeoutSeconds: 5`, `failureThreshold: 3`:

```text
detection jitter:  up to 1 × period      = 0–10s   (hang starts just after a success)
failing attempts:  3 × period            = 30s     (attempts are period-spaced)
per-attempt wait:  each may burn timeout = up to 5s before counting as failed
                                         ─────────
kill signal sent:  ~30–45s after the hang begins, then SIGTERM → grace period → restart
```

Rule of thumb: **liveness kill time ≈ `failureThreshold × periodSeconds`, plus up to one period of jitter.** Your app must be able to be unresponsive for *less* than this during normal operation (GC, cache rebuild, burst load), or liveness becomes a random pod-killer.

**Time-to-traffic (readiness, fresh pod).** `initialDelaySeconds + (attempts-to-first-success × periodSeconds) + endpoint propagation`. With `initialDelay: 0`, `period: 5`, and an app that's actually ready at t=12s:

```text
t=0    container starts, probes begin immediately (no initialDelay)
t=0,5,10   attempts fail — app still booting (3 "failures", harmless: nothing acts yet)
t=12   app ready
t=15   next scheduled attempt passes → pod condition Ready=True
t=~16  EndpointSlice updated, kube-proxy synced → first real request arrives
```

Worst case adds one full period of jitter (ready at t=15.1, probed at t=20). This per-pod delay × replica count, divided by surge width, is your rollout duration — see the interaction section.

**Startup budget and handoff.** `failureThreshold × periodSeconds` is the ceiling on boot time: `failureThreshold: 30, periodSeconds: 5` = 150s. A pod that hasn't passed by then is killed and restarted — and if it can never pass, that loop is one of the classic roads to CrashLoopBackOff. The handoff on success:

```text
t=0     container starts; ONLY the startup probe runs — liveness/readiness are suspended
t=0..N  startup probe fails quietly, burning budget (each failure is free until the 30th)
t=95    first startup success → startup probe retires permanently
t=95+   liveness and readiness begin on their own periodSeconds, from now
```

Because the startup probe absorbs the whole boot, liveness and readiness keep `initialDelaySeconds: 0` — adding a delay there just re-penalizes every pod for a boot that already happened.

**Time-out-of-rotation on a blip (readiness).** De-rotation costs `failureThreshold × periodSeconds` of serving errors before traffic stops (`3 × 10` = up to 30s of failed requests). Recovery costs `successThreshold × periodSeconds` after the app is fine again (`1 × 10` = up to 10s; `successThreshold: 3` makes it 30s). Both directions on one timeline, defaults everywhere:

```text
t=0    app starts erroring
t=0-30 still in rotation, serving errors (3 failures × 10s to react)
t=30   Ready=False → out of endpoints (~1s later, no more traffic)
t=70   app recovers
t=70-80  still out of rotation (1 success × 10s to notice)
t=80   Ready=True → back in endpoints
```

Tighter periods shrink both windows; higher thresholds trade reaction speed for flap resistance. There is no free lunch on this row — pick which failure mode you'd rather eat.

**Propagation lag.** Ready flipping is not instant traffic change. The kubelet reports the condition, the endpoints controller rewrites EndpointSlices, and every node's kube-proxy re-syncs its rules — typically ~1s, but seconds under load, and external load balancers watching endpoints add their own delay. This lag exists on both edges (into *and* out of rotation) and is why graceful shutdown needs a `preStop` sleep. Details in [Services Deep Dive](/networking/services-deep-dive/).

## Interaction effects

Probe knobs never act alone. These are the cross-products that actually cause incidents.

### Probes × rolling updates

`maxSurge` pods count toward availability only when Ready, so **readiness latency drives rollout duration**. With 20 replicas, `maxSurge: 25%` (5 pods per wave), and 60s time-to-Ready per pod:

```text
4 waves × (60s time-to-Ready + minReadySeconds soak) ≈ 4–6 minute rollout
```

A readiness probe that never passes stalls the rollout entirely — a feature, not a bug: broken code never receives traffic. The knob people forget is `minReadySeconds` on the Deployment: a *soak timer* — a pod must stay Ready that long before counting as available, so a pod that passes readiness once and then crashes at t+20s can't wave a whole rollout through. `minReadySeconds: 30` is cheap insurance on anything user-facing; it also slows each wave by 30s, which is exactly the deal you're making. Full rollout math in [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/).

### Probes × graceful shutdown

When a pod goes Terminating it's removed from endpoints *regardless* of readiness — you don't need to fail readiness in `preStop`. What you do need: a `preStop` sleep (5–15s) covering the propagation lag so in-flight-routed requests land on a still-alive server, and a pod `terminationGracePeriodSeconds` ≥ preStop sleep + your longest request's drain time. If you set the probe-level `terminationGracePeriodSeconds` on liveness, remember it only applies to probe-triggered kills — normal rollout terminations still get the pod-level value. The full choreography is in [High Availability](/workloads/high-availability/).

### Liveness × JVM warmup and GC

A stop-the-world GC pause freezes probe responses along with everything else. With the defaults (`period: 10, timeout: 1, failureThreshold: 3`), a pause or pause-cluster spanning ~30s of probe attempts gets the pod killed *mid-GC*. The storm mechanics:

```text
1. heap pressure → long full GC → probe timeouts → liveness kill
2. replacement pod: cold JIT, cold caches → slower → more heap churn
3. survivors absorb the dead pod's traffic → their GC gets worse
4. goto 1, now with n-1 healthy pods
```

Nothing was ever wrong except the probe config. Defenses: `timeoutSeconds ≥ 5` and `failureThreshold ≥ 5` on JVM liveness probes (a single attempt then tolerates a 5s pause; the kill needs ~50s of *sustained* silence), and fix the pause itself via heap sizing in [JVM in Containers](/java/jvm-in-containers/) and [JVM Memory Knobs](/tuning/jvm-memory-knobs/).

### Liveness timeout × CPU throttling

A pod at its CPU limit gets throttled in 100ms enforcement windows — and the thread answering `/healthz` waits in line with everything else. An app that's merely *busy* starts missing a 1s timeout, liveness kills it, and the survivors inherit its traffic and throttle harder. If restarts correlate with traffic peaks and `container_cpu_cfs_throttled_periods_total` is climbing, this is your loop. Raise `timeoutSeconds` first, then fix the CPU limit.

### Readiness × dependency checks

The cascade-outage knob, and you turn it **off**: a readiness endpoint that pings the database converts one dependency blip into every replica going Unready simultaneously — a full outage where you'd have had degraded responses, and one that *slows recovery*, because Unready pods get no warm-up traffic. Readiness answers "can *this pod* serve?" — deps belong in your own alerting, or at most in a startup gate. Spring Boot's separate liveness/readiness health groups exist precisely so you can keep dependency indicators out of both.

## Recipes

Rationale is inline per knob. Adjust the numbers with the workflow in the next section — these are shapes, not gospel.

### Fast stateless HTTP service

Starts in 2–5s, health endpoint is cheap. Readiness is tight; liveness is deliberately lazy.

```yaml
startupProbe:
  httpGet: { path: /healthz, port: 8080 }
  periodSeconds: 2          # probe often: fast starters shouldn't wait
  failureThreshold: 15      # 30s boot budget — generous even here
readinessProbe:
  httpGet: { path: /healthz, port: 8080 }
  periodSeconds: 5          # react to breakage within ~15s
  timeoutSeconds: 2         # 2s >> the endpoint's p99; the 1s default is still too tight
  failureThreshold: 3       # one blip ≠ de-rotation
livenessProbe:
  httpGet: { path: /healthz, port: 8080 }
  periodSeconds: 10         # no rush — readiness already pulled traffic
  timeoutSeconds: 5         # survive throttle windows
  failureThreshold: 6       # ~60s provably wedged before the kill
```

### Slow-starting JVM / Spring Boot

The startup probe does the heavy lifting; liveness and readiness use [Spring Boot's](/java/spring-boot/) dedicated groups, which exclude dependency indicators by design.

```yaml
startupProbe:
  httpGet: { path: /actuator/health/liveness, port: 8080 }
  periodSeconds: 5
  failureThreshold: 60      # 300s budget ≈ 2× measured startup p99 (see workflow)
  timeoutSeconds: 3         # a booting JVM is slow even at answering
readinessProbe:
  httpGet: { path: /actuator/health/readiness, port: 8080 }
  periodSeconds: 10
  timeoutSeconds: 3         # GC + JIT make 1s a coin flip
  failureThreshold: 3
livenessProbe:
  httpGet: { path: /actuator/health/liveness, port: 8080 }
  periodSeconds: 10
  timeoutSeconds: 5         # must exceed your worst full-GC pause per attempt
  failureThreshold: 6       # 60s of consecutive misses before the kill
  terminationGracePeriodSeconds: 10   # a wedged JVM won't drain; don't wait 60s pod grace
```

### Background worker (no HTTP port)

Liveness-file pattern: the work loop touches a file each iteration; the probe checks freshness. No readiness — the pod isn't behind a Service.

```yaml
livenessProbe:
  exec:
    command: ["sh", "-c", "test $(find /tmp/worker-alive -mmin -2 | wc -l) -eq 1"]
    # app touches /tmp/worker-alive every loop; stale >2min = wedged
  periodSeconds: 60         # exec forks a process each period — keep it rare
  timeoutSeconds: 5
  failureThreshold: 3       # 3min stale + 3 misses before restart; workers aren't urgent
```

The freshness window (`-mmin -2`) must exceed your longest *legitimate* work item, or long jobs get their pod shot mid-task.

### TCP service (database-ish)

Connection acceptance is a weak signal, so thresholds are generous — restarting a database because of one slow accept is worse than waiting.

```yaml
startupProbe:
  tcpSocket: { port: 5432 }
  periodSeconds: 10
  failureThreshold: 30      # 300s: recovery/WAL replay counts as startup
readinessProbe:
  tcpSocket: { port: 5432 }
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 3
livenessProbe:
  tcpSocket: { port: 5432 }
  periodSeconds: 20         # stateful + weak signal = maximum patience
  timeoutSeconds: 5
  failureThreshold: 6       # ~2min wedged before a kill you might regret
```

### gRPC service

Requires the server to implement `grpc.health.v1.Health`. Distinct `service` names let readiness and liveness answer different questions on the same port.

```yaml
startupProbe:
  grpc: { port: 9090 }
  periodSeconds: 5
  failureThreshold: 24      # 120s boot budget
readinessProbe:
  grpc: { port: 9090, service: readiness }   # server sets SERVING/NOT_SERVING per service name
  periodSeconds: 5
  timeoutSeconds: 2
  failureThreshold: 3
livenessProbe:
  grpc: { port: 9090, service: liveness }
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 5
```

## Tuning workflow: numbers from evidence, not folklore

Every number in the recipes above should be re-derived for your app. The procedure:

**1. Measure startup.** Pull real time-to-Ready across a few dozen starts — cold nodes, image pulls, busy neighbors included:

```bash
# Timestamp delta between container start and Ready condition
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].state.running.startedAt}{"\n"}{.status.conditions[?(@.type=="Ready")].lastTransitionTime}{"\n"}'

# Or watch the probe failures during boot burn down in events
kubectl get events --field-selector reason=Unhealthy --sort-by=.lastTimestamp
```

Set the startup budget (`failureThreshold × periodSeconds`) at **~2× the p99**, not the average — the average start is not the one that pages you. More on mining events for this in [Events](/observability/events/).

**2. Measure the health endpoint.** Its p99 latency *under production load* sets `timeoutSeconds` — timeout comfortably above p99. If you haven't measured, 3–5s beats the 1s default on anything nontrivial.

**3. Decide your kill patience.** Find the longest window where the app is legitimately unresponsive (worst GC pause, cache reload, traffic burst), then set liveness `failureThreshold × periodSeconds` at 2–3× that. If you can't name the window, you're not ready to add a liveness probe.

**4. Change one knob at a time.** Probe math is all products; change two factors in one rollout and you can't attribute the result. One knob, one rollout, one observation window (a day, or one full traffic cycle).

**5. Watch after every change.** Three signals, in order of urgency:

```bash
kubectl get pods -l app=<name>            # RESTARTS column trending up = liveness too hot
kubectl get events --field-selector reason=Unhealthy -w   # read the message, not just the count
kubectl get endpointslices -l kubernetes.io/service-name=<svc> -w   # churn = readiness flapping
```

The `Unhealthy` message tells you which knob to turn: `context deadline exceeded` → raise `timeoutSeconds`; `connection refused` → the app isn't listening yet (startup budget); an HTTP 500 → the endpoint itself is reporting a problem, and no probe knob fixes that.

## Anti-pattern quick table

| Anti-pattern | Why it burns you | Instead |
|---|---|---|
| `timeoutSeconds: 1` on a JVM | Any full GC or throttle window > 1s counts as failure; three in a row = liveness kill of a healthy pod | `timeoutSeconds: 5`, and size the heap properly |
| Liveness = readiness copy-paste | Every de-rotation-worthy blip becomes a restart; you've turned a valve into a gun | Different endpoints, and liveness with much looser thresholds |
| `initialDelaySeconds` instead of a `startupProbe` | One number must fit your fastest and slowest boot; it can't — fast starts wait, slow starts die | `startupProbe` with a `failureThreshold × periodSeconds` budget |
| `successThreshold: 2` on liveness or startup | API server rejects the manifest outright | Keep it 1 there; tune it on readiness only |
| `exec` probe spawning a JVM every 5s | A JVM boot per probe per period, billed to your CPU limit | File-touch + shell `find -mmin`, `periodSeconds: 30+` |
| `failureThreshold: 1` anywhere | One dropped packet, one slow accept — instant restart or de-rotation | Minimum 3; liveness deserves 5–6 |
| Readiness probing the database | Dependency blip → all replicas Unready → total outage instead of degraded | Probe only what this pod controls |

The knobs are simple; the products aren't. When a probe misbehaves, write out the multiplication for your actual numbers before touching anything — the fix is usually visible in the arithmetic.
