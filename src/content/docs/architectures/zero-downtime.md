---
title: "Zero-Downtime Deploys: The Complete Build"
description: The end-to-end zero-dropped-requests build — timeline math, annotated manifests, and a load-test harness that proves deploys, pod kills, node drains, and scale-downs never return a non-2xx.
keywords:
  - preStop sleep shutdown race
  - terminationGracePeriodSeconds grace budget
  - 502 during deploy or pod termination
  - maxSurge maxUnavailable rolling update
  - endpoint propagation eventual consistency
  - graceful shutdown SIGTERM drain
  - FailedPreStopHook distroless image
  - vegeta load-test harness
  - HPA scale-down 502s
  - minReadySeconds soak
  - connection refused dropped requests
sidebar:
  order: 9
---

The other builds in this section are topologies — brokers, databases, edges. This one is a *behavior*: a service that never drops a request while pods are being created, killed, drained, and rescheduled underneath it. The mechanics live scattered across this site — probes in [Health Checks](/workloads/health-checks/), the PDB in [High Availability](/workloads/high-availability/), surge math in [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/), propagation lag in [Services Deep Dive](/networking/services-deep-dive/). Here they are assembled into one internally consistent artifact — and then **drilled**, because a zero-downtime configuration you haven't load-tested through a deploy is a hypothesis, not a property.

The patient is `checkout-api`, a Spring Boot HTTP service (the .NET wiring differs by two lines; both are covered). Every number below traces to a Knobs & Levers article — nothing here is folklore.

## The claim and the physics

"Zero downtime" is two invariants that must hold **at every instant**, not on average:

1. **Capacity invariant:** at least N ready pods are in the load-balancing set.
2. **Termination invariant:** no pod terminates while requests are in flight to it *or still being routed to it*.

The second clause is the one everybody misses. Two races break these invariants, and they live at opposite ends of a pod's life:

```text
 THE STARTUP RACE                          THE SHUTDOWN RACE
 (pod added too early)                     (pod removed too late)

 t ──────────────────────────►             t ──────────────────────────►
 pod starts                                pod deletion begins
 │ readiness passes ◄── LIE?               ├──► SIGTERM to app        (path A)
 │ │ endpoints add pod                     └──► endpoint removal      (path B)
 │ │ │ traffic arrives                          │ API server updates
 │ │ │ ▼                                        │ EndpointSlice rewritten
 │ │ │ app still warming ──► 5xx                │ kube-proxy syncs (every node)
 │ │ │                                          │ ingress-nginx re-syncs
 │ ▼ ▼                                          ▼ ...100ms–seconds later
 └── app truly serving                     traffic STILL ARRIVING at a pod
     (should have been Ready HERE)         that already got SIGTERM ──► 5xx
```

**The startup race** is the honest-readiness problem: the kubelet adds the pod to endpoints the moment readiness passes, so readiness must mean "genuinely able to serve this instant" — dependencies connected, caches warm enough, listener accepting. If readiness lies, `maxUnavailable: 0` is a comforting fiction ([Health Checks](/workloads/health-checks/) is the full treatment). The fix is honest probes plus a startup probe so honesty doesn't cost you restart loops.

**The shutdown race is the load-bearing one.** When a pod is deleted, two things start **simultaneously and independently**: the kubelet sends SIGTERM (path A), and the pod is removed from endpoints (path B). Path B is *eventually consistent* — the endpoints controller, every node's kube-proxy, and the ingress controller each converge on their own schedule, typically ~1s and seconds under load ([Services Deep Dive](/networking/services-deep-dive/) walks the chain). So for that window, **traffic arrives at a pod that has already been told to die**. If SIGTERM makes your app stop accepting connections immediately, every one of those requests is a connection refused → a client-visible 502.

The fix is not to make path B faster — you can't; it's a distributed system. The fix is to make path A *slower*: a `preStop` sleep that keeps the app fully serving while deregistration propagates everywhere, and only then delivers SIGTERM.

:::note[Why not fail readiness in preStop?]
You'll see advice to fail the readiness probe during shutdown so the pod leaves rotation "gracefully." Unnecessary: a Terminating pod is removed from endpoints *regardless* of readiness — that's path B, already running. Failing readiness adds nothing to deletion and doesn't speed propagation. The sleep is the mechanism. (Failing readiness is the right tool for a different job: taking traffic away from a pod you *aren't* terminating.) See [Health Check Knobs](/tuning/health-check-knobs/).
:::

## The timeline math

This sequence is the artifact everything else in this article implements. Learn it once and every manifest field below becomes obvious:

```text
T0        kubectl delete / rollout replaces pod
          ├─ pod marked Terminating; endpoint removal (path B) begins
          └─ preStop hook starts: sleep S ─── app STILL SERVING NORMALLY
T0+S      preStop returns → kubelet sends SIGTERM
          app graceful shutdown: stop accepting NEW connections,
          finish in-flight requests, drain for up to D
T0+S+D    app exits cleanly (ideally well before this)
T0+G      terminationGracePeriodSeconds expires → SIGKILL, no appeal

THE INEQUALITY THAT MUST HOLD:

    G  >  S  +  D  +  margin

    G = terminationGracePeriodSeconds   (kubelet's patience, from T0)
    S = preStop sleep                   (covers endpoint propagation)
    D = app drain timeout               (longest in-flight request)
    margin ≈ 5s                         (framework teardown, context close)
```

The grace-period clock starts at T0, **not** after preStop — the sleep spends grace budget. Teams set `preStop: sleep 10` against the default `terminationGracePeriodSeconds: 30` with a 25s app drain and wonder why long requests die at exactly T0+30: `10 + 25 + 5 > 30`. The inequality fails; SIGKILL wins.

Our numbers: **S = 10** (the defensive end of the 5–15s propagation-cover range in [Health Check Knobs](/tuning/health-check-knobs/) — this cluster has an external ingress watching endpoints, so we buy the extra margin), **D = 25** (app drain timeout), **G = 45** (`10 + 25 + 5`, with a couple of seconds spare).

`D` is not a Kubernetes knob — it's wired **in your framework**, and unwired it silently defaults to "drop everything":

```yaml
# Spring Boot — application.yaml (details: /java/spring-boot/)
server:
  shutdown: graceful              # SIGTERM → stop accepting, finish in-flight
spring:
  lifecycle:
    timeout-per-shutdown-phase: 25s   # this is D
```

```csharp
// ASP.NET Core — Program.cs (details: /dotnet/aspnetcore-on-k8s/)
builder.Services.Configure<HostOptions>(o =>
    o.ShutdownTimeout = TimeSpan.FromSeconds(25));   // this is D
```

Both stacks have a fatal footgun that makes D irrelevant: if PID 1 in the container is a shell or launcher that doesn't forward SIGTERM (a `sh -c` entrypoint, .NET's stock `ENTRYPOINT` behind a script), the app never hears the shutdown and gets SIGKILLed cold at T0+G. Verify signal delivery per [Spring Boot on Kubernetes](/java/spring-boot/) and [ASP.NET Core on K8s](/dotnet/aspnetcore-on-k8s/) before trusting anything below.

## The manifests

Complete and internally consistent — every number is either derived above or cited to its knob article. Namespace `checkout-prod` assumed.

### Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout-api
  namespace: checkout-prod
  labels:
    app.kubernetes.io/name: checkout-api
spec:
  replicas: 3
  revisionHistoryLimit: 5
  selector:
    matchLabels:
      app.kubernetes.io/name: checkout-api
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1          # add one NEW pod first...
      maxUnavailable: 0    # ...never dip below 3 serving. Zero, not 25%:
                           # any nonzero value licenses a capacity dip that
                           # your p99 pays for. Requires quota headroom for
                           # N+1 pods or the rollout stalls Pending —
                           # see /workloads/rollouts-and-rollbacks/
  minReadySeconds: 10      # a pod must stay Ready 10s before it counts as
                           # Available — a soak that catches crash-on-first-
                           # request pods BEFORE the rollout proceeds and
                           # paces replacement to one pod per ~probe cycle
  template:
    metadata:
      labels:
        app.kubernetes.io/name: checkout-api
    spec:
      terminationGracePeriodSeconds: 45   # G = S(10) + D(25) + margin(5) + slack
      containers:
        - name: checkout-api
          image: ghcr.io/example/checkout-api:1.4.2
          ports:
            - name: http
              containerPort: 8080
            - name: mgmt
              containerPort: 8081        # probes off the traffic port
          resources:                     # measured, not guessed —
            requests:                    # method: /tuning/requests-limits-knobs/
              cpu: 500m                  # p95 steady-state + headroom
              memory: 1Gi
            limits:
              memory: 1Gi               # limit = request: no overcommit surprise
                                        # no CPU limit: throttling during startup
                                        # is how honest probes get slow
          startupProbe:
            httpGet: { path: /actuator/health/readiness, port: mgmt }
            periodSeconds: 5
            failureThreshold: 24   # 120s budget = slowest measured start (55s) x2
                                   # sizing rule: /tuning/health-check-knobs/
          readinessProbe:
            httpGet: { path: /actuator/health/readiness, port: mgmt }
            periodSeconds: 5
            timeoutSeconds: 2
            failureThreshold: 3    # 15s to leave rotation on real failure —
                                   # fast enough to matter, slow enough to
                                   # survive one GC pause
          livenessProbe:
            httpGet: { path: /actuator/health/liveness, port: mgmt }
            periodSeconds: 10
            timeoutSeconds: 2
            failureThreshold: 3    # 30s of sustained deadness before restart;
                                   # liveness must NOT check dependencies
          lifecycle:
            preStop:
              exec:
                command: ["sh", "-c", "sleep 10"]   # S — the shutdown-race fix
```

:::caution[preStop on shell-less images — a silent failure]
`exec` needs `sh` and `sleep` **inside your image**. On distroless/scratch images the hook fails — and a failed preStop does **not** abort termination. Kubernetes records a `FailedPreStopHook` event and proceeds straight to SIGTERM: your race protection evaporates silently, visible only in [Events](/observability/events/). Options: bake a static `sleep` into the image; on clusters ≥1.32 use the native hook `lifecycle: { preStop: { sleep: { seconds: 10 } } }` (no binary needed); or as a last resort an `httpGet` preStop to an app endpoint that blocks 10s — awkward, because now your app implements the sleep and a 5xx from that endpoint also fails silently. After first deploy, `kubectl get events -n checkout-prod | grep -i prestop` — silence is a pass.
:::

The resource block matters here for a non-obvious reason: measure it with [Requests & Limits Knobs](/tuning/requests-limits-knobs/), and skip the CPU limit — a throttled pod answers probes slowly, and slow honest probes at startup are how zero-downtime configs flap their way into the very 5xx bursts they exist to prevent.

Why all three probes, briefly (full reasoning in [Deployments Deep Dive](/workloads/deployments-deep-dive/) and [Health Check Knobs](/tuning/health-check-knobs/)): the **startup** probe absorbs the slow JVM start so readiness/liveness can be tight; **readiness** gates the capacity invariant at both edges of rotation; **liveness** is the deadlock backstop and nothing more.

### PodDisruptionBudget

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: checkout-api
  namespace: checkout-prod
spec:
  minAvailable: 2                 # capacity math: HPA targets 70% CPU, so two
                                  # pods absorb three pods' load at ~105% —
                                  # degraded-but-alive for a drain's duration.
                                  # minAvailable 3 (= replicas) would block
                                  # every node drain forever; see
                                  # /workloads/high-availability/
  selector:
    matchLabels:
      app.kubernetes.io/name: checkout-api
```

The PDB serializes **voluntary** evictions (node drains, cluster upgrades): the drain evicts one pod, waits for a replacement to be Ready *by the readiness probe*, then takes the next. It does nothing for deploys (the rollout obeys `maxUnavailable`), nothing for HPA scale-down, and nothing for node crashes. And it counts *ready* pods — lying readiness breaks the PDB too.

### Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: checkout-api
  namespace: checkout-prod
spec:
  selector:
    app.kubernetes.io/name: checkout-api
  ports:
    - name: http
      port: 80
      targetPort: http
      appProtocol: http
```

Deliberately boring — the Service is the membership list both races fight over, not a tuning surface.

### Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: checkout-api
  namespace: checkout-prod
  annotations:
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "5"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "30"   # > app p99, < D
spec:
  ingressClassName: nginx
  rules:
    - host: checkout.apps.example.internal
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: checkout-api
                port: { name: http }
```

Two ingress-nginx behaviors matter specifically to this build (background: [ingress-nginx](/networking/ingress-nginx/)):

- **Retries are the safety net for the residual race.** Even with the preStop sleep there's a theoretical sliver — nginx's own endpoint view lags too. By default nginx retries the next upstream on *connection-level* failures (`error`, `timeout`): a connect-refused to a just-dead pod is retried transparently and the client never sees it. This is exactly the failure the shutdown race produces, so the default is your friend — don't disable `proxy-next-upstream`.
- **Be honest about what it can't retry.** Once nginx has sent request bytes upstream and the connection dies mid-response, retrying is only safe for idempotent methods — by default `POST`/`PATCH` are **not** retried (adding `non_idempotent` to `proxy-next-upstream` replays payments; don't). The retry net catches connection-refused, not half-processed writes. True zero-loss for non-idempotent traffic comes from the preStop math making the race not happen, plus idempotency keys in the app.

### HPA — the scale-down note

Run the HPA per the [Golden Service](/architectures/golden-service/); one behavior belongs in *this* article: **HPA scale-down is pod deletion that consults neither `maxUnavailable` nor the PDB.** The ReplicaSet controller just deletes the surplus pod. Its only protection is the termination choreography — preStop, drain, grace. This is why a service can deploy cleanly for months and still throw 502s every time load drops after lunch: surge protects deploys, nothing but the timeline math protects scale-in. Pace it explicitly:

```yaml
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - { type: Pods, value: 1, periodSeconds: 60 }   # one drain at a time
```

## Addendum: long-lived connections

Everything above assumes requests that end. WebSockets, gRPC streams, and SSE make "finish in-flight work within D" impossible — a subscribed client would happily hold the connection for hours, so drain must become an *eviction protocol* ([Long-Lived Connections](/networking/long-lived-connections/) is the full story):

- **Server-initiated close during drain.** On SIGTERM: HTTP/2 and gRPC send **GOAWAY** and finish in-flight streams (`GracefulStop()`); WebSockets send close frames, trickled over a few seconds rather than all at once; TLS gets a clean close-notify so clients see "closed," not "reset." D now means "time to notify and close everyone," not "time for requests to finish."
- **Pace the rollout.** `maxSurge: 1, maxUnavailable: 0` plus `minReadySeconds` means one pod's connections drop per replacement step instead of the whole fleet's — turning a disconnect storm into a drizzle.
- **The client reconnect contract.** Disconnects are a *when*, not an *if* — drains and evictions don't consult your deploy calendar. Clients must reconnect with exponential backoff and jitter, and server-side state must be externalized so the reconnect can land on any pod. For long-lived protocols, "zero downtime" is redefined honestly: *zero failed requests and zero lost messages*, not zero TCP closes.

## The verification harness

The heart of the build. Configuration asserts; only load under fire proves. The harness is a load generator hammering the service **through the ingress** (client path, not cluster shortcut) while you inflict every disruption class. Acceptance criterion: **zero non-2xx responses across all four drills.** Not "under 0.1%." Zero — at 50 req/s the shutdown race produces double-digit failures per pod kill, so any nonzero count means a broken invariant, and the math says the invariants are achievable.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: zdt-drill
  namespace: checkout-prod
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: vegeta
          image: peterevans/vegeta:6.12.0
          command: ["sh", "-c"]
          args:
            - |
              echo "GET http://checkout.apps.example.internal/api/ping" \
                | vegeta attack -duration=600s -rate=50 -timeout=10s \
                | tee /tmp/results.bin \
                | vegeta report -every=10s
              echo "=== FINAL ==="
              vegeta report < /tmp/results.bin
          resources:
            requests: { cpu: 250m, memory: 128Mi }
            limits: { memory: 128Mi }
```

Start the Job, `kubectl logs -f job/zdt-drill -n checkout-prod`, then run the four drills inside the 10-minute window. In a second and third terminal, watch the mechanics you're testing ([Events](/observability/events/) decodes what you'll see):

```bash
kubectl get events -n checkout-prod -w        # Killing, Scheduled, Unhealthy, FailedPreStopHook
kubectl get endpointslices -n checkout-prod -w -o wide   # pods entering/leaving rotation
```

**Drill 1 — rolling deploy:** `kubectl set image deployment/checkout-api checkout-api=ghcr.io/example/checkout-api:1.4.3 -n checkout-prod && kubectl rollout status deployment/checkout-api -n checkout-prod`. Watch the surge pod appear, soak through `minReadySeconds`, and only then see an old pod enter Terminating.

**Drill 2 — pod kill:** `kubectl delete pod -n checkout-prod $(kubectl get pod -n checkout-prod -l app.kubernetes.io/name=checkout-api -o name | head -1)`. The rawest form of the shutdown race — endpointslice removal and the preStop window racing in real time.

**Drill 3 — node drain:** with your platform team (or in staging): `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data`. Watch the PDB serialize the eviction; if you drain a second node hosting the other pods, watch it *block* until the replacement is Ready — that block is the PDB doing its job.

**Drill 4 — scale-down:** `kubectl scale deployment/checkout-api -n checkout-prod --replicas=2` (then back to 3). This is the drill teams skip and the one that exposes a missing preStop even when deploys look clean.

### PASS — and what FAIL looks like

A passing final report:

```text
Requests      [total, rate, throughput]         30000, 50.00, 49.99
Duration      [total, attack, wait]             10m0s, 10m0s, 41.2ms
Latencies     [p50, p95, p99, max]              18ms, 61ms, 142ms, 1.9s
Success       [ratio]                           100.00%
Status Codes  [code:count]                      200:30000
Error Set:
```

The `max` of 1.9s is honest — during the drills some requests queued behind rollout churn. Slower is acceptable; failed is not.

Now the pedagogical core: **remove the `preStop` block, redeploy, and rerun drill 2.** Same app, same probes, same grace period — only the sleep gone:

```text
Requests      [total, rate, throughput]         30000, 50.00, 49.93
Success       [ratio]                           99.85%
Status Codes  [code:count]                      200:29954, 502:37, 0:9
Error Set:
502 Bad Gateway
Get "http://checkout.apps.example.internal/api/ping": EOF
```

Forty-six failures from **one** pod kill: 37 requests that nginx couldn't retry (bytes already sent to a dying upstream) and 9 connections reset mid-flight. That is the shutdown race, measured. It's a 99.85% success ratio — which is why it hides in dashboards and averages, and why the acceptance criterion is an integer zero, not a percentage. Put the `preStop` back, rerun, watch the 502 row disappear. You have now *proven* the mechanism, not just configured it.

:::tip[Make the harness a habit, not a ceremony]
This Job costs nothing to keep in the repo. Run it on every change to probes, grace periods, drain timeouts, or base images — those are the changes that silently reopen the race (a base-image swap to distroless kills the exec preStop, and only the drill notices). Wire drill 1 into the pipeline's promotion gate alongside `kubectl rollout status` — see [CI/CD Pipeline Design](/operations/cicd-pipeline-design/).
:::

## Failure modes

| Symptom | When it fires | Root cause | Fix |
|---|---|---|---|
| 5xx burst at the **start** of each deploy | New pods entering rotation | Readiness lies — passes before dependencies/warm-up are real | Readiness checks true serving ability; `minReadySeconds` soak; [Health Checks](/workloads/health-checks/) |
| 5xx burst at the **end** of each deploy | Old pods terminating | The shutdown race — no preStop, or app closes listener on SIGTERM | preStop sleep 10; framework graceful drain; verify `FailedPreStopHook` absent in events |
| Long requests fail at exactly T0+G | Deploys and drains, only slow endpoints | Inequality broken: `G < S + D` — SIGKILL mid-request | Recompute `G > S + D + margin`; raise `terminationGracePeriodSeconds` |
| Errors during cluster maintenance only | Node drains, upgrades | No PDB (parallel evictions), or PDB present but grace math broken on eviction path | PDB `minAvailable: 2`; same timeline math applies to evictions |
| 502s **only** when load drops | HPA scale-in | Surge protects deploys; nothing but termination choreography protects scale-in — preStop missing or D unwired | Same preStop/drain fix; pace `scaleDown` to 1 pod/min |
| Disconnect storms, thundering-herd reconnects | Any pod replacement, WS/gRPC/SSE workloads | Drain closes all streams at once; clients reconnect simultaneously | GOAWAY/close-frame trickle; client backoff+jitter; [Long-Lived Connections](/networking/long-lived-connections/) |
| Rollout hangs, no errors | Deploy in quota-tight namespace | Surge pod Pending — quota sized for exactly N | Budget quota for N+1 or accept `maxSurge: 0, maxUnavailable: 1` and its capacity dip |

## The checklist

Ten rules, each testable — "testable" meaning drill 1–4 output, not code review:

1. `maxSurge: 1, maxUnavailable: 0` — and quota headroom for the surge pod actually exists.
2. Readiness means "serving now"; startup probe budget = slowest measured start × 2 ([Health Check Knobs](/tuning/health-check-knobs/)).
3. `minReadySeconds` ≥ 10 so a pod soaks before the rollout advances past it.
4. `preStop` sleep 10s — and a `FailedPreStopHook` check after every base-image change.
5. The inequality holds: `terminationGracePeriodSeconds > sleep + drain + 5s`, recomputed whenever any term changes.
6. Framework graceful shutdown wired and SIGTERM actually reaches the app (PID 1 check).
7. PDB `minAvailable` set from capacity math — strictly less than replicas.
8. HPA `scaleDown` paced; scale-in included in the drill set, not just deploys.
9. Ingress retry defaults intact; non-idempotent endpoints carry idempotency keys instead of retry hacks.
10. The harness Job lives in the repo and drill 1 gates promotion in the pipeline.

This build is the deployment-behavior module of the [Golden Service](/architectures/golden-service/) — that article surrounds these manifests with the security, spreading, config, and observability layers a production service also needs. And the rollout-status gate that turns drill 1 into an automated promotion check is designed in [CI/CD Pipeline Design](/operations/cicd-pipeline-design/). Deploy at 2 p.m. on a Friday; the harness already told you nothing will drop.
