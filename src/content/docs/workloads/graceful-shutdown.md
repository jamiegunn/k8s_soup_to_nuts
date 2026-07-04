---
title: "Graceful Shutdown and the Termination Lifecycle"
description: The canonical termination mechanics — the full deletion timeline, the endpoint-propagation race, the grace-period budget inequality, PID 1 signal reality, and per-stack drain wiring.
sidebar:
  order: 19
---

Every pod you will ever run gets killed. Deploys kill pods. Node drains kill pods. Scale-downs, evictions, spot reclaims, liveness failures — all of them end in the same sequence of events, and whether that sequence drops requests is decided by fields *you* write in your manifest and code *you* ship in your image. This page owns those mechanics. Other pages use them in context — [rolling updates](/workloads/rollouts-and-rollbacks/), [node drains](/workloads/high-availability/), [the full zero-downtime build](/architectures/zero-downtime/) — and all of them link back here for the sequence itself. The tunable numbers get their own dial-table in [Rollout & Shutdown Knobs](/tuning/rollout-shutdown-knobs/).

## The termination sequence

Everything below is triggered identically whether the deletion comes from `kubectl delete pod`, a rolling update replacing a ReplicaSet, a node drain's eviction call, or the HPA scaling in. One sequence, one set of rules ([official reference](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)):

1. **Deletion request hits the API server.** The pod object is *not* deleted — it gets a `deletionTimestamp` and a `deletionGracePeriodSeconds` copied from your `terminationGracePeriodSeconds` (default **30**). `kubectl get pods` now shows `Terminating`. **The grace-period clock starts here.**
2. **Two things begin simultaneously and independently.** This fork is the single most important fact on this page:
   - **Path A (kubelet):** the kubelet sees the deletionTimestamp and starts killing the pod: it runs your `preStop` hook to completion (if you have one), *then* sends **SIGTERM** to PID 1 of each container.
   - **Path B (routing):** the EndpointSlice controller sees the deletionTimestamp and marks the pod's endpoint as terminating/not-ready. Then every consumer of that data — kube-proxy on *every node*, ingress controllers, service meshes — independently reconciles. This is **eventually consistent**: typically sub-second to a few seconds, worse under apiserver load or in large clusters.
3. **Your app drains.** On SIGTERM it should stop accepting new work, finish in-flight work, close pools cleanly, and exit 0.
4. **The deadline.** If PID 1 is still alive when the grace period expires, the kubelet sends **SIGKILL**. No handler runs, no flushing happens, the container dies with exit code **137**.
5. **Cleanup.** The container runtime tears down the sandbox, the kubelet reports the pod dead, the API server removes the object. The endpoint disappears entirely.

```text
T0          DELETE hits apiserver → deletionTimestamp set, pod Terminating
            grace clock (G = terminationGracePeriodSeconds) STARTS
            │
            ├── Path A (kubelet, sequential)      ├── Path B (routing, concurrent)
            │   preStop hook runs (S seconds)     │   EndpointSlice: endpoint → terminating
            │   ▼                                 │   kube-proxy syncs rules (per node)
T0+S        │   SIGTERM → PID 1, each container   │   ingress controller re-syncs upstreams
            │   app drains in-flight work (D)     │   ▼ ...converges T0+~1s to T0+several s
T0+S+D      │   app exits 0  ✓ done               │   traffic stops ARRIVING
            │                                     │
T0+G        SIGKILL if still alive → exit 137, no appeal
```

Path A is sequential and yours to schedule. Path B is a distributed system you cannot hurry. The whole discipline of graceful shutdown is arranging Path A so it finishes *after* Path B converges and *before* T0+G.

One caveat before the evidence: `kubectl delete pod --grace-period=0 --force` skips the whole ceremony — the API object vanishes immediately and the kubelet SIGKILLs in the background with no preStop, no SIGTERM window, no drain. It exists for wedged pods on dead nodes, not for impatience; every force-delete is a deliberate decision to drop whatever that pod was doing.

### Evidence at every step

Don't take the timeline on faith — watch it happen. Terminal 1, the events (the full event-reading toolkit is in [Events](/observability/events/)):

```bash
kubectl get events -w --field-selector involvedObject.name=orders-api-7d9f8b6c5-2xkqp
```

```text
LAST SEEN   TYPE     REASON    MESSAGE
0s          Normal   Killing   Stopping container orders-api
```

Note what's *absent*: there is no event for "preStop started," "SIGTERM sent," or "grace expired." `Killing` fires once at the start of Path A, and the only termination-phase events after it are failures (`FailedPreStopHook`, `FailedKillPod`). The positive evidence for the intermediate steps comes from your app's own log timestamps lined up against the event:

```text
10:41:02.114  INFO  ... (normal request logs continue — preStop sleep window)
10:41:07.201  INFO  Commencing graceful shutdown. Waiting for active requests to complete
10:41:08.850  INFO  Graceful shutdown complete
10:41:08.912  INFO  HikariPool-1 - Shutdown completed
```

The 5-second gap between the `Killing` event and "Commencing graceful shutdown" *is* the preStop sleep, observed.

Terminal 2, Path B — watch your pod leave the EndpointSlice:

```bash
kubectl get endpointslices -l kubernetes.io/service-name=orders-api -o yaml -w \
  | grep -A3 "conditions:"
```

```yaml
conditions:
  ready: false          # flipped at deletionTimestamp — Path B has begun
  serving: true         # still capable of serving (this matters for the race)
  terminating: true
```

And the deadline enforcement, after the fact:

```bash
kubectl get pod orders-api-7d9f8b6c5-2xkqp \
  -o jsonpath='{.status.containerStatuses[0].lastState.terminated}'
```

```json
{"exitCode":137,"reason":"Error","startedAt":"...","finishedAt":"..."}
```

Exit 0 means your drain finished inside the budget. Exit 143 (128+15) means the app died *from* SIGTERM without handling it. Exit 137 (128+9) means the kubelet gave up waiting — [the error index](/troubleshooting/error-index/) disambiguates 137-from-deadline vs 137-from-OOM.

:::note[preStop overruns get two seconds of mercy, once]
If your preStop hook is still running when the grace period expires, the kubelet emits a `FailedPreStopHook` event, grants a one-time 2-second extension, sends SIGTERM, and then SIGKILL. A preStop that doesn't fit the budget doesn't fail loudly — it silently eats the time your app needed to drain.
:::

## The race: traffic arrives after SIGTERM

Here is the part that breaks teams who did everything "right." You handled SIGTERM. Your server stops accepting connections immediately and drains in-flight requests beautifully. **You will still drop requests on every deploy** — because Path B lags Path A.

At T0, the kubelet (Path A, local, fast) and the routing plane (Path B, distributed, slow) start at the same instant. With no preStop hook, SIGTERM lands within milliseconds — while the routing plane is still converging. Path B isn't one consumer; it's a chain, each link on its own schedule:

| Path B consumer | How it learns | Typical lag from T0 |
|---|---|---|
| EndpointSlice controller | Watches pods, rewrites the slice | ~10–100ms |
| kube-proxy, **per node** | Watches slices, rewrites iptables/IPVS rules | ~100ms–1s each, worse on big rule sets |
| ingress-nginx | Watches slices, updates its upstream set (Lua, no reload) | its own sync interval — see [Ingress-NGINX](/networking/ingress-nginx/) |
| Cloud LB (LoadBalancer Services) | Target deregistration + its drain delay | seconds to tens of seconds |

Until the *slowest relevant link* converges, new connections keep arriving at the pod. Every request that lands after SIGTERM hits a server that has closed its listener: connection refused at the pod, surfaced to the client as a 502/503 from the layer in front ([Life of a Request](/routing/life-of-a-request/) traces exactly which hop turns the refusal into which status). Under load it looks like this — a deploy with correct SIGTERM handling and no preStop:

```text
Status code distribution:
  [200] 59742 responses
  [502]   118 responses     ← clustered in a ~2s window at each pod deletion
```

118 dropped requests, all "handled gracefully" by an app that did nothing wrong — after the routing plane stopped sending traffic, the drain was flawless. The problem is entirely in the seconds before.

**"Handle SIGTERM correctly" is necessary but not sufficient.** Correct SIGTERM handling protects requests already in flight. It does nothing for requests still *arriving*, and requests keep arriving until Path B converges everywhere. You cannot make Path B faster — it's the EndpointSlice controller plus N kube-proxies plus the ingress sync loop, each on its own schedule ([Services Deep Dive](/networking/services-deep-dive/) walks the propagation chain hop by hop). You can only make Path A slower.

### The preStop sleep, dissected

```yaml
lifecycle:
  preStop:
    exec:
      command: ["sleep", "5"]
```

This is the most cargo-culted five lines in Kubernetes, so be precise about what it buys. During the sleep, **nothing has been signaled**. The app is fully serving — accepting new connections, answering them normally. Meanwhile Path B is converging: the endpoint is marked terminating, kube-proxy rewrites rules, the ingress drops the upstream. The sleep holds SIGTERM back until nobody is sending new traffic, converting the race window from "requests hit a closed listener" into "requests hit a healthy server." That's the entire trick. It is not superstition, and it is not a drain mechanism — the drain happens *after*, when SIGTERM finally lands.

**Sizing it.** The right value is your measured propagation lag plus margin, not a folk number. On a quiet cluster with in-cluster clients only, 2–3s covers it; through ingress-nginx add its sync interval; through a cloud load balancer with its own deregistration delay you may need 10–15s. Measure it: run the kill-during-load drill below and shrink the sleep until errors appear, then double the last clean value. Every second of sleep is a second added to *every pod replacement in every deploy*, so don't ship 60 because it feels safe — a 10-pod rollout at `maxSurge: 1` serializes ~10 of these.

**exec sleep vs `sleep` field vs httpGet.** The exec form above requires a `sleep` binary *in your image* — it executes in your container, not on the node. Since v1.30 (stable v1.32) there's a native alternative that needs nothing in the image:

```yaml
lifecycle:
  preStop:
    sleep:
      seconds: 5
```

On **distroless/scratch images there is no shell and usually no `sleep`** — `exec: ["sleep","5"]` fails instantly with a `FailedPreStopHook` event and you've silently lost your race protection. Use the `sleep` field on any current cluster; on older clusters, either add a static sleep binary to the image or use `httpGet` against an endpoint in your app that blocks for N seconds. The httpGet form also lets the hook do real work (flip an internal drain flag, deregister from a service registry) — but keep it dumb; a preStop that can fail is a preStop that eats your grace budget.

:::note[Failing readiness in preStop is a no-op for termination]
A Terminating pod is removed from endpoints because of its deletionTimestamp — Path B is already running, readiness has no further vote. Scripting a readiness-failure into preStop adds nothing to deletion. (Failing readiness is the right tool for de-rotating a pod you're *not* terminating.)
:::

## The budget inequality

All of Path A shares one clock. Formally:

```text
terminationGracePeriodSeconds  >  preStop  +  in-flight drain  +  margin
            G                  >     S     +        D          +   ~5s
```

The grace period is not "how long the app gets to drain" — it's the budget for *everything* between deletionTimestamp and SIGKILL: the sleep, the app's connection draining, pool closing, buffer flushing, and (see below) sidecar shutdown. Worked numbers for a typical HTTP API:

| Component | Symbol | Value | Where it comes from |
|---|---|---|---|
| preStop sleep | S | 5s | Measured endpoint-propagation lag + margin |
| In-flight drain | D | 25s | Longest legitimate request/phase timeout (Spring's `timeout-per-shutdown-phase: 25s`) |
| Margin | — | 5s | Context close, pool shutdown, JVM exit, sidecar teardown |
| **Required G** | | **> 35 → set 40–45** | |
| Default G | | 30 | **Violated.** |

That last row is the punchline: **the defaults don't add up.** A stock Spring Boot graceful config (5s sleep + 25s phase timeout) already overruns the default 30s grace before margin. What each party observes when the inequality is violated:

- **Your app's logs:** a perfectly normal graceful shutdown *starting* — "Commencing graceful shutdown…" — then the log stream just stops mid-drain. No error, because SIGKILL doesn't let you log.
- **kubectl:** `lastState.terminated.exitCode: 137`, reason `Error` (not `OOMKilled` — that's the tell; see [the error index](/troubleshooting/error-index/)).
- **Your clients:** the in-flight requests that were mid-drain die as connection resets — a small 5xx burst on every deploy, invisible in tests, obvious in production error budgets.

The inequality has a dual, too: **G should not be wildly larger than S+D**. `terminationGracePeriodSeconds: 600` doesn't make shutdown safer — it means a wedged drain holds up node drains and makes every rollout batch wait up to 10 minutes. Set G to fit the real work, then fix drains that don't finish.

The manifest that encodes the arithmetic — write the addition down where the next editor will trip over it:

```yaml
# pod template — the shutdown-relevant fields, with the budget shown
spec:
  terminationGracePeriodSeconds: 45   # G = S(5) + D(25) + margin(5) + sidecar flush(5) + slack
  containers:
    - name: orders-api
      lifecycle:
        preStop:
          sleep:
            seconds: 5                # S: measured endpoint-propagation lag ~2s, doubled
      # D lives in the app config: spring.lifecycle.timeout-per-shutdown-phase: 25s
```

When someone later adds a slow-flushing sidecar or bumps the drain timeout to 40s, the comment turns a silent budget violation into a visible arithmetic error at review time.

## PID 1 and signal reality

The kubelet sends SIGTERM to **PID 1 of the container** — and PID 1 is special twice over.

**The shell-form trap.** These two Dockerfile lines behave completely differently under SIGTERM:

```dockerfile
# Shell form — sh is PID 1, your app is its child. sh does NOT forward SIGTERM.
ENTRYPOINT java -jar /app.jar

# Exec form — your app IS PID 1 and receives SIGTERM directly.
ENTRYPOINT ["java", "-jar", "/app.jar"]
```

With the shell form, SIGTERM goes to `sh`, which ignores it and forwards nothing. Your app never hears the shutdown, drains nothing, serves cheerfully until T0+G, and dies by SIGKILL — every deploy drops requests and *no amount of application-side graceful-shutdown code can help*, because the code never runs. Same trap wearing different clothes: `CMD` in shell form, wrapper scripts that run the app without `exec "$@"`, and Helm charts overriding `command` with `["/bin/sh","-c","..."]`.

**The kernel's PID 1 surprise.** Even with exec form, PID 1 in a PID namespace gets non-standard treatment: the kernel applies **no default action** for signals sent to it — only signals with an explicitly installed handler are delivered ([signal(7)](https://man7.org/linux/man-pages/man7/signal.7.html)). An ordinary process with no handler dies on SIGTERM; a PID 1 with no handler *ignores it silently*. JVMs, .NET, Go's runtime, and Node all install handlers (or let you), so mainstream stacks are fine — but a minimal C binary, a shell script as PID 1, or some static Rust/Go builds with no signal wiring will sit through SIGTERM untouched and eat the SIGKILL. (SIGKILL from the kubelet still works — it's delivered from outside the namespace.)

**When you need an init: tini / dumb-init.** If your entrypoint genuinely must be a script, or your app forks children it doesn't reap (zombie accumulation is the other PID 1 job), put a real init in front:

```dockerfile
ENTRYPOINT ["/usr/bin/tini", "--", "java", "-jar", "/app.jar"]
```

`tini` is PID 1, forwards signals to your app, and reaps zombies. Many runtimes support the same via `docker run --init`; in Kubernetes you bake it into the image. You do *not* need it for a well-behaved single-process app in exec form — it's the fix for scripts-as-entrypoint and forking servers, not a talisman.

**Test the signal path directly** — this takes thirty seconds and settles every argument:

```bash
kubectl exec orders-api-7d9f8b6c5-2xkqp -- kill -TERM 1
kubectl logs -f orders-api-7d9f8b6c5-2xkqp
```

If the logs show your graceful shutdown starting, the whole chain — exec form, handler installed, framework wired — is proven. If nothing happens, you've found the bug *before* a deploy found it for you: check `ps -p 1` inside the container (is PID 1 `sh`?), then whether the app installs a handler at all. Note this only tests Path A; the race with Path B still needs the load drill at the bottom of this page.

## Wiring it per stack and per protocol

The kernel delivers one signal; what happens next is framework configuration. Compact versions here — the full treatments live in the stack articles.

**JVM / Spring Boot.** SIGTERM triggers `Runtime` shutdown hooks; Spring's graceful shutdown registers one. Two properties do all the work:

```yaml
# application.yaml
server:
  shutdown: graceful            # the default since Boot 3.4; set explicitly on older
spring:
  lifecycle:
    timeout-per-shutdown-phase: 25s   # this is your D
```

The web server stops accepting, in-flight requests finish (up to D), then contexts close in reverse order — pools, consumers, everything. A bare JVM app without Spring gets the same via `Runtime.getRuntime().addShutdownHook(...)`. Details, including what happens to Kafka consumers and Hikari pools during the hook: [Spring Boot on K8s](/java/spring-boot/) and [the JVM↔K8s coupling contract](/java/jvm-kubernetes-coupling/).

**ASP.NET Core.** SIGTERM → `IHostApplicationLifetime.ApplicationStopping` fires → Kestrel stops accepting, hosted services get `StopAsync` in reverse registration order — all inside one budget:

```csharp
builder.Services.Configure<HostOptions>(o =>
    o.ShutdownTimeout = TimeSpan.FromSeconds(30));   // this is your D
                                                     // 30s default on .NET 8+, 5s before
```

Full wiring, including the IIS-refugee notes, in [ASP.NET Core on K8s](/dotnet/aspnetcore-on-k8s/).

Per protocol, "drain" means different verbs ([Long-Lived Connections](/networking/long-lived-connections/) is the deep dive):

| Protocol | What draining actually means |
|---|---|
| HTTP/1.1 keep-alive | Finish the in-flight request, then answer the *next* request on each persistent connection with `Connection: close` so clients re-resolve to a live pod. Just closing idle keep-alive sockets mid-request is how you reset clients. Frameworks' graceful modes do this for you. |
| gRPC / HTTP/2 | Send **GOAWAY** on the connection: client opens no new streams here, existing streams complete, client re-balances. `server.GracefulStop()` (Go) / `shutdown()` (Java) emit it. |
| WebSockets / SSE | These never "finish" on their own — your drain must actively send a close frame (WS) or end the stream (SSE) and rely on **client reconnect logic** landing on a live pod. Budget D for the close-and-reconnect, not for the connection's natural life. |
| Queue consumers | Stop polling, **finish the current message**, commit/ack, close the consumer cleanly (Kafka: `consumer.close()` triggers a clean group rebalance). If a message can't finish inside D, you need idempotent redelivery, not a bigger D. |

## Shutdown × everything else

**Rolling updates.** Every rollout is a sequence of pod terminations under load — the surge math in [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/) decides *when* pods die; this page decides whether each death drops requests. The dependency runs one way: `maxUnavailable: 0` promises the capacity invariant ("never fewer than N Ready pods"), but the Deployment controller delivers on it by deleting an old pod *the instant* a replacement reports Ready — and everything from that instant is the race and the budget above. A team that sets `maxUnavailable: 0` without a preStop and a solvent grace budget has bought the expensive rollout pacing and still drops requests at every batch boundary; the knob-level pairing is worked in [Rollout & Shutdown Knobs](/tuning/rollout-shutdown-knobs/).

**Sidecars.** Native sidecars (restartable init containers) terminate *after* the main containers, in reverse start order — so your log shipper and mesh proxy outlive your app's drain, which is exactly what you want: the last request's logs still have somewhere to go, the last response still has a proxy to leave through. But they **share the same grace budget G**: main-app preStop + drain + sidecar flush must all fit inside one `terminationGracePeriodSeconds`. A log shipper that takes 10s to flush its buffer is 10s you must add to G, or it's the component that gets SIGKILLed — and its data loss won't show up in *your* error rate, just in the mysterious gap in the logs for every pod's final seconds. Ordering details and the pre-native-sidecar workarounds: [Sidecar Lifecycle and Ordering](/sidecars/lifecycle-and-ordering/).

**Node drains and evictions.** A drain calls the Eviction API per pod; each granted eviction is a standard deletion — deletionTimestamp, preStop, SIGTERM, G, SIGKILL. Same sequence, same race, same budget. Your PDB controls *how many at once* and *whether now*; this page controls whether each one is clean. This is why graceful shutdown is a pillar of [High Availability](/workloads/high-availability/): the platform team drains nodes weekly, and each drain is a rollout you didn't schedule. The one place the budget gets externally squeezed: kubelet graceful node shutdown on scale-downs and spot reclaims caps the grace it can grant to the node's configured shutdown window — if the platform's spot budget is 30s, your `terminationGracePeriodSeconds: 120` is aspirational on those nodes.

**Jobs.** Batch pods get SIGTERM'd too — by preemption, drains, or deletion — and there's no "drain" in the request sense; the work is the thing in flight. The contract is *checkpoint or be idempotent*: either the SIGTERM handler persists progress and exits non-zero so the retry resumes from the checkpoint, or every unit of work is safely re-runnable from scratch. A pod SIGKILLed at T0+G counts against `backoffLimit` carrying zero information about where it stopped — for a 6-hour batch job, an un-checkpointed SIGTERM is 6 hours of compute converted to heat.

## Verifying it: the kill-during-load drill

A graceful-shutdown configuration you haven't tested through a kill is a hypothesis. The minimum honest test — sustained load, then delete a pod, then read the error count:

```bash
# Terminal 1: sustained load through the real path (ingress, not port-forward)
hey -z 120s -q 50 -c 20 https://orders.internal/api/orders

# Terminal 2: kill one pod mid-load, normal grace (NOT --force)
kubectl delete pod $(kubectl get pods -l app=orders-api -o name | head -1)
```

The verdict is the status-code distribution:

```text
Status code distribution:
  [200] 119883 responses          ← clean: zero non-2xx during a pod death
```

Any 502/503 burst timestamped at the deletion is the race (preStop missing or too short). Errors ~G seconds *after* the deletion — connection resets, truncated responses — are the budget inequality (drain SIGKILLed; check for exit 137). Two different bugs, two different fixes, distinguishable purely by *when* the errors cluster. The full harness — deploys, drains, scale-downs, and the automated assertion loop — is built in [Zero-Downtime Deploys](/architectures/zero-downtime/), with every knob value catalogued in [Rollout & Shutdown Knobs](/tuning/rollout-shutdown-knobs/).

### The shutdown audit

Ten lines to run against any service you own:

- [ ] `ENTRYPOINT`/`CMD` in **exec form**; wrapper scripts end in `exec "$@"`.
- [ ] App installs a SIGTERM handler (or the framework does) — verified by `kubectl exec` + `kill -TERM 1` in a test pod, watching the logs.
- [ ] `preStop` sleep present, sized from **measured** propagation lag, not folklore.
- [ ] On distroless: `sleep` field or httpGet — not `exec: ["sleep",...]` with no binary.
- [ ] `terminationGracePeriodSeconds > S + D + 5`, written down as arithmetic in a manifest comment.
- [ ] Framework drain timeout (D) explicitly set — Spring `timeout-per-shutdown-phase`, .NET `ShutdownTimeout`.
- [ ] Long-lived protocols have an active drain verb (GOAWAY, close frames, finish-current-message).
- [ ] Sidecar flush time counted inside G.
- [ ] Rollout/drain histories show exit 0, never 137/143 — checked in `lastState.terminated`.
- [ ] Kill-during-load drill passes with zero non-2xx, re-run after any change to S, D, or G.

Pass all ten and deploys, drains, and scale-ins become non-events — which is the entire point.
