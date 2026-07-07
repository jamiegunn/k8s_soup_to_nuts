---
title: "Rollout & Shutdown Knobs"
description: Every deploy-time and termination dial in one place — surge and unavailability math, the grace-period budget, the combined deploy timeline, recipes, and the anti-pattern table.
keywords:
  - zero downtime deployment
  - maxsurge maxunavailable
  - terminationgraceperiodseconds
  - prestop hook sleep
  - exit code 137 graceful shutdown
  - progressdeadlineseconds progressdeadlineexceeded
  - kubectl rollout status undo
  - 502 errors during deploy
  - dropped requests rolling update
  - minreadyseconds soak
  - distroless no sleep binary
  - failedprestophook event
sidebar:
  order: 8
---

This is the dial-by-dial reference for how pods are *replaced*: the Deployment strategy fields that pace a rollout and the termination fields that decide whether each replaced pod dies cleanly. The mechanics — what actually happens between deletionTimestamp and SIGKILL, and why traffic keeps arriving after SIGTERM — live in [Graceful Shutdown](/workloads/graceful-shutdown/); the rollout state machine lives in [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/). This page assumes you know both and need the numbers: defaults, what turning each dial changes, and how they multiply into deploy duration and dropped-request counts.

## The rollout knobs

All under `spec.strategy.rollingUpdate` unless noted; percentages resolve against `spec.replicas` (surge rounds **up**, unavailable rounds **down**).

| Knob | Default | What it actually does | When to turn it | What to watch after |
|---|---|---|---|---|
| `maxSurge` | `25%` | How many pods *above* `replicas` may exist mid-rollout. The controller creates this many new-revision pods before (and while) killing old ones. Bigger surge = more parallelism = faster deploys — paid for in temporary capacity. | Up (50–100%) when deploys are slow and quota allows; down to a fixed `1` when the app can't tolerate extra instances (per-instance licenses, connection-count limits on a database). Absolute numbers beat percentages for small `replicas` — 25% of 2 rounds up to 1 anyway, but say what you mean. | Pending pods during rollout (quota/headroom exhaustion — see below), downstream connection counts spiking with the extra pods. |
| `maxUnavailable` | `25%` | How many pods *below* `replicas` may be missing mid-rollout. The controller may delete this many old pods before their replacements are Ready. **Any value above 0 is a standing order to run under-capacity during every deploy.** | To `0` for anything with an SLO — this is the zero-downtime stance: never delete an old pod until a new one is Ready. Requires `maxSurge ≥ 1` (see the deadlock anti-pattern). Leave at 25% only for workloads where brief capacity dips are genuinely free. | p99 latency during deploys (the remaining pods absorb the missing capacity), 5xx bursts timed to rollout batches. |
| `minReadySeconds` | `0` (Deployment `spec`, not `rollingUpdate`) | A pod must stay Ready this long before the controller counts it as available and moves to the next batch. The **soak dial**: it catches pods that pass readiness then die 5 seconds later (warmup OOMs, first-real-request crashes) *before* the rollout has propagated the bad revision everywhere. | Up to 10–30s on user-facing services; it's the cheapest canary you'll ever configure. Higher (60s+) when your failure mode is slow (memory climb). Zero is fine for workers where a crash-loop is cheap and visible. | Deploy duration (it adds `minReadySeconds` per batch), and whether it actually catches anything — check `kubectl rollout status` stalling on a bad revision. |
| `progressDeadlineSeconds` | `600` (Deployment `spec`) | If the rollout makes no progress (no pod becomes available) for this long, the Deployment gets condition `Progressing=False`, reason `ProgressDeadlineExceeded`. **That is all it does.** It does NOT roll back, does not stop the rollout, does not delete anything — it flips a status bit. Auto-rollback in Kubernetes is something *you* build on top of that bit. | Down (120–300s) so CI fails fast instead of hanging 10 minutes on a crash-looping revision. It must stay **above** your slowest legitimate pod start (startup probe budget + image pull + `minReadySeconds`), or healthy deploys report as failed. | CI pipeline duration on failed deploys; false `ProgressDeadlineExceeded` on cold-cache image pulls. |
| `revisionHistoryLimit` | `10` | How many old ReplicaSets (scaled to 0) are kept around. Each is a one-command rollback target: `kubectl rollout undo --to-revision=N`. | Down (2–3) if ReplicaSet clutter bothers your tooling; **never `0`** — that deletes rollback history entirely and `rollout undo` has nothing to return to. | `kubectl rollout history deploy/X` still showing the revisions you'd want back. |

### Reading a rollout from CI

`kubectl rollout status` is the bridge between these knobs and your pipeline — it blocks until the rollout completes and turns the Deployment's conditions into an exit code:

```bash
kubectl rollout status deploy/orders-api --timeout=5m
echo "exit: $?"
```

```text
Waiting for deployment "orders-api" rollout to finish: 1 out of 4 new replicas have been updated...
Waiting for deployment "orders-api" rollout to finish: 3 of 4 updated replicas are available...
deployment "orders-api" successfully rolled out
exit: 0
```

Exit **0** means done; **non-zero** means `progressDeadlineSeconds` was exceeded (the command reads the `Progressing` condition) or its own `--timeout` fired first. The failed-deploy version:

```text
Waiting for deployment "orders-api" rollout to finish: 1 out of 4 new replicas have been updated...
error: deployment "orders-api" exceeded its progress deadline
exit: 1
```

That exit code is your pipeline's deploy verdict — which makes `progressDeadlineSeconds` effectively a CI knob: set it to "slowest honest deploy + margin" and the pipeline gets a true red/green instead of a 10-minute hang followed by a shrug. The condition itself is visible in `kubectl describe deploy` (`Progressing: False / ProgressDeadlineExceeded`) and in the [event stream](/observability/events/). And to repeat the table's warning: nothing rolls back automatically. Wire the red path yourself:

```bash
kubectl rollout status deploy/orders-api --timeout=5m || {
  kubectl rollout undo deploy/orders-api
  exit 1
}
```

:::caution[Surge needs headroom — quota is a rollout knob you don't own]
`maxSurge: 1` means the namespace must fit `replicas + 1` pods' worth of **requests** during every deploy. If the ResourceQuota (or the cluster's schedulable headroom) can't, the surge pod sits `Pending`, the rollout can't make progress, and `progressDeadlineSeconds` eventually calls it failed — a "deploy outage" caused entirely by arithmetic. Budget quota as `(replicas + maxSurge) × per-pod requests`; the request-sizing side lives in [Requests & Limits Knobs](/tuning/requests-limits-knobs/).
:::

## The shutdown knobs

These live on the pod template. The full sequence they parameterize — the two concurrent paths, the race, PID 1 — is in [Graceful Shutdown](/workloads/graceful-shutdown/).

| Knob | Default | What it actually does | When to turn it | What to watch after |
|---|---|---|---|---|
| `terminationGracePeriodSeconds` | `30` | The **shared budget** from deletionTimestamp to SIGKILL. Everything — preStop hook, app drain, sidecar flush — spends from this one account. Not "drain time": total time. | Up (40–60) for anything with a preStop sleep plus a real drain phase — the stock Spring numbers (5+25) already overflow the default 30. Down (5–10) for stateless workers that exit in milliseconds, so drains and rollouts don't wait on pods with nothing to say. | `lastState.terminated.exitCode` — 137 on pods that *started* a graceful shutdown means the budget is violated. |
| `lifecycle.preStop` | none | Hook the kubelet runs to completion **before** sending SIGTERM. The race-closer: a sleep here keeps the app serving while endpoint removal propagates through kube-proxy and ingress. Time spent counts against the grace budget. | On every HTTP/gRPC service behind a Service: sleep for measured propagation lag + margin (start at 5s). Three forms — `exec` (needs the binary *in your image*), `httpGet` (hook does app-side work), and the native `sleep` field (v1.30+, stable v1.32 — no binary needed, the distroless answer). | `FailedPreStopHook` events (hook errored or overran — you silently lost race protection), 502 bursts timed exactly to pod deletions. |
| Readiness during drain | — | None needed: a Terminating pod leaves endpoints because of its deletionTimestamp, regardless of probe results. Scripting readiness-failure into shutdown adds nothing. | Don't. The interacting probe dial that *matters* is below. | — |
| `startupProbe` on replacements | per-probe | The rollout can only proceed as fast as **new** pods become Ready — so the startup budget (`failureThreshold × periodSeconds`) is a rollout pacing knob in disguise, and `progressDeadlineSeconds` must exceed it. | Size per [Health Check Knobs](/tuning/health-check-knobs/); then re-check `progressDeadlineSeconds` against it. | Rollouts declared failed while pods are legitimately still warming. |
| `controller.kubernetes.io/pod-deletion-cost` | `0` (annotation, per pod) | On ReplicaSet **scale-in**, pods with lower cost are preferred for deletion. Lets you nominate victims (the pod with the coldest cache, the fewest connections). | When scale-in victim choice measurably matters and you have a controller maintaining the annotation. Honest maturity note: beta since v1.22 and stalled there; **best-effort only** — no guarantee, not honored by node drains or rollouts, and updating annotations per pod is API churn. A preference, never a mechanism to rely on. | Whether scale-ins actually pick your nominees (`kubectl get events` on the ReplicaSet). |

### The three preStop forms, side by side

```yaml
lifecycle:
  preStop:
    # 1. exec — runs INSIDE your container: the binary must exist in the image.
    #    Fails instantly (and quietly) on distroless with no /bin/sleep.
    exec:
      command: ["sleep", "5"]

    # 2. sleep field — native, no binary needed. v1.30+ (stable v1.32).
    #    The right default on any current cluster.
    sleep:
      seconds: 5

    # 3. httpGet — the kubelet calls your app; the hook can DO something:
    #    block for N seconds, flip a drain flag, deregister from a registry.
    httpGet:
      path: /internal/drain
      port: 8080
```

(One form per pod, of course — shown together for comparison.) Whichever form you pick, the duration counts against `terminationGracePeriodSeconds`, and a hook that fails emits only a `FailedPreStopHook` event before termination proceeds without it — check for that event after changing images or base layers.

:::note[The probe knobs are rollout knobs wearing a different label]
Nothing in the tables above makes readiness honest — and `maxUnavailable: 0` is only as good as the Ready condition it trusts. A pod that reports Ready while still warming makes the controller delete a real server in exchange for a fake one, with perfect paperwork. The readiness/startup dials are owned by [Health Check Knobs](/tuning/health-check-knobs/); treat that page and this one as one tuning exercise.
:::

## The combined math: one deploy under load

A rolling update is startup math and shutdown math interleaved. One batch, end to end, with `maxSurge: 1, maxUnavailable: 0`:

```text
t0        controller creates 1 surge pod (new revision)
t0..t0+R  surge pod: image pull → start → startupProbe passes → Ready
t0+R..+M  minReadySeconds soak (M) — pod must HOLD Ready
t0+R+M    controller deletes 1 old pod ── termination sequence begins:
            preStop sleep S (still serving; endpoints propagate)
            SIGTERM → drain D
            exit 0        ── must land before grace G expires
t0+R+M+S+D  batch complete; next batch starts
```

So for `replicas = N`, batches of `maxSurge`:

```text
deploy duration ≈ ceil(N / maxSurge) × (R + M + S + D)
```

and the deploy is **dropless** iff two inequalities hold:

1. **The shutdown budget:** `G > S + D + margin` — otherwise every batch ends in a SIGKILL mid-drain (exit 137, client resets).
2. **The honest-readiness gate:** Ready means *genuinely serving now* — otherwise `maxUnavailable: 0` deletes a real server the moment a fake one reports Ready, and the capacity invariant breaks with perfect paperwork. ([Health Check Knobs](/tuning/health-check-knobs/) owns this side.)

Filled in for **orders-api** (Spring Boot, 4 replicas, numbers from [the sizing walkthrough](/tuning/sizing-walkthrough/) and [health-check design](/tuning/health-check-design/)):

| Quantity | Value | Source |
|---|---|---|
| R (start → Ready) | ~45s typical (180s worst-case startup budget) | startupProbe: `5s × 36` |
| M (`minReadySeconds`) | 10s | soak against warmup deaths |
| S (preStop sleep) | 5s | measured propagation lag ~2s, doubled |
| D (drain) | ≤25s, typically ~2s | `timeout-per-shutdown-phase: 25s` |
| **G required** | > 5 + 25 + 5 → **45** | inequality 1 |
| **Deploy duration** | 4 × (45 + 10 + 5 + 2) ≈ **4–5 min typical** | `ceil(4/1) × (R+M+S+D)` |
| `progressDeadlineSeconds` | 300 | > worst R (180) + M (10) + margin |

The whole deploy, batch by batch:

```text
batch 1   [surge pod 5 starts... Ready @45s][soak 10s][old pod 1: preStop 5 + drain 2]
batch 2      [surge pod 6 ... Ready][soak][old pod 2 terminates]
batch 3         [surge pod 7 ... Ready][soak][old pod 3 terminates]
batch 4            [surge pod 8 ... Ready][soak][old pod 4 terminates]
          ─────────────────────────────────────────────────────────────►
          ~62s per batch × 4 batches ≈ 4m 08s, never below 4 Ready pods
```

Worst case per batch is bounded by `R_max + M + G` — which is why a bloated G slows deploys even when drains are fast: the *bound* is what `rollout status --timeout` and your patience are sized against. And notice which knob dominates: R, the startup side. Teams tune shutdown obsessively and then wonder why deploys are slow; the answer is usually a 3-minute startup budget being spent serially, `maxSurge: 1` batch after batch. Faster deploys come from `maxSurge: 2` (quota permitting) or a faster cold start — not from shaving the preStop sleep.

## Recipes

**Zero-downtime HTTP API** (the default for anything with an SLO):

```yaml
spec:
  replicas: 4
  minReadySeconds: 10
  progressDeadlineSeconds: 300
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0          # never dip below N Ready pods
  template:
    spec:
      terminationGracePeriodSeconds: 45   # > preStop 5 + drain 25 + margin
      containers:
        - name: api
          lifecycle:
            preStop:
              sleep: { seconds: 5 }       # v1.30+; exec ["sleep","5"] if older AND image has sleep
```

**Bulk worker / queue consumer** (fast churn is fine; there is no request race to close):

```yaml
spec:
  replicas: 12
  minReadySeconds: 0
  strategy:
    rollingUpdate:
      maxSurge: 50%              # deploy fast
      maxUnavailable: 25%        # capacity dip = queue backlog, not errors
  template:
    spec:
      terminationGracePeriodSeconds: 20   # finish-current-message time, measured
      # no preStop: nothing routes TO a consumer; the race doesn't exist here
```

The worker's real shutdown contract is in the code, not the manifest: stop polling on SIGTERM, finish the current message, ack, exit — see [Graceful Shutdown](/workloads/graceful-shutdown/) for the per-protocol table.

**Singleton-ish StatefulSets.** None of the surge machinery applies: StatefulSets update one pod at a time, in reverse ordinal order, with no surge and no `maxUnavailable` dial worth the name. Your pacing dials are different:

```yaml
spec:
  podManagementPolicy: OrderedReady   # affects scale-up/down parallelism, NOT updates
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 2       # only ordinals >= 2 update — a manual canary gate;
                         # lower it step by step to roll the rest
```

The shutdown knobs apply unchanged — a database pod deserves a bigger G for clean handoff/failover, and the same `G > S + D` arithmetic. For why Deployments get ReplicaSet-based surge and StatefulSets don't, see [Deployments Deep Dive](/workloads/deployments-deep-dive/).

:::note[minReadySeconds is only as honest as Ready itself]
The soak dial extends *how long* Ready must hold, not *what* Ready means. If the readiness probe passes while the app is still warming, `minReadySeconds: 30` soaks a lie for 30 seconds and then proceeds. Fix the probe first ([Health Check Knobs](/tuning/health-check-knobs/)), then use the soak to catch the failure modes probes can't see — the pod that dies on its fifth real request.
:::

## Anti-patterns

| Anti-pattern | What actually happens | The fix |
|---|---|---|
| `G: 30` with preStop 25 + drain 20 | Arithmetic violation: 25+20 = 45 > 30. Drain starts at T0+25, gets 5 of its 20 seconds, SIGKILL. Exit 137 *after* logs show a graceful start — the classic signature (below). | Do the addition in a manifest comment: `# G 55 > preStop 25 + drain 20 + margin`. Then ask why preStop needs 25s (measured, or folklore?). |
| `maxUnavailable: 0` **and** `maxSurge: 0` | The controller may neither create an extra pod nor delete an existing one. Deadlock — so the API server **rejects it** at admission. You'll meet it as a validation error from a helm template that parameterized both to zero. | At least one must be nonzero; for zero-downtime that's `maxSurge ≥ 1`. |
| `progressDeadlineSeconds` < startup budget | Every honest cold deploy (image pull + 3-minute warm) is declared `ProgressDeadlineExceeded`. CI reports failure; the rollout meanwhile completes fine. Teams "fix" it by ignoring deploy status — the worst outcome. | `progressDeadline > R_max + minReadySeconds + margin`, where R_max is the startupProbe budget from [Health Check Knobs](/tuning/health-check-knobs/). |
| `exec: ["sleep","5"]` on distroless | No shell, no `sleep` binary. The hook fails instantly (`FailedPreStopHook` event — easy to miss), SIGTERM lands at T0, and the endpoint-propagation race is wide open. Looks configured; protects nothing. | The `sleep` field (v1.30+), an `httpGet` preStop, or a static sleep binary baked into the image. |
| Giant grace periods hiding broken drains | `G: 600` because "the drain sometimes needs it." A drain that *sometimes needs* 10 minutes is a drain that hangs; the giant G converts that bug into 10-minute rollout batches and node drains that block platform maintenance (they wait out G per pod). | Measure D. Fix the hang (usually an unbounded in-flight timeout or a consumer that won't stop polling). Set G to fit the fixed drain. |

The first row's signature, so you recognize it in the wild — app logs that end mid-sentence, paired with:

```bash
kubectl get pod orders-api-7d9f8b6c5-2xkqp \
  -o jsonpath='{.status.containerStatuses[0].lastState.terminated}'
```

```json
{"exitCode":137,"reason":"Error","finishedAt":"2026-07-03T10:41:32Z"}
```

`137` with reason `Error` (not `OOMKilled`) on a pod whose logs show "Commencing graceful shutdown" is the budget inequality violated — nothing else produces that combination. Full disambiguation in [the error index](/troubleshooting/error-index/).

## The tuning workflow

Four steps, in order — each produces a number the next one consumes.

**1. Measure propagation lag → sizes S.** Under load through the real path (ingress, not port-forward), delete a pod with **no** preStop and timestamp the 502 burst against the deletion event; the burst width is your lag:

```bash
# staging: strip the preStop, then
hey -z 60s -q 50 -c 20 https://orders.staging.internal/api/orders &
kubectl delete pod $(kubectl get pods -l app=orders-api -o name | head -1)
# the 502 cluster's width in the hey output = propagation lag
```

Typically 1–3s in-cluster; more behind ingress, more again behind a cloud LB. Set `S = lag × 2`.

**2. Measure drain time → sizes D and G.** Time "graceful shutdown starting" → process exit in the logs, under load:

```bash
kubectl exec orders-api-7d9f8b6c5-2xkqp -- kill -TERM 1
kubectl logs -f orders-api-7d9f8b6c5-2xkqp   # timestamp delta = actual D
```

Set the framework drain timeout (Spring `timeout-per-shutdown-phase`, .NET `ShutdownTimeout`) just above the longest *legitimate* request; set `G = S + D + 5`.

**3. Set the numbers.** S in the preStop, D in the app config, G in the pod spec — plus the rollout side: `maxUnavailable: 0`, `maxSurge: 1`, `minReadySeconds: 10`, `progressDeadline > startup budget + margin`. Write the G arithmetic in a manifest comment so reviewers can re-check it when any term changes.

**4. Verify with the drill.** Sustained load; run a deploy *and* a pod kill *and* a scale-down; assert zero non-2xx. The full automated harness is [Zero-Downtime Deploys](/architectures/zero-downtime/); the mechanics you're verifying are owned by [Graceful Shutdown](/workloads/graceful-shutdown/). Re-run the drill whenever S, D, G, or the probe numbers change — these dials are a system, and this page's tables are only the parts list.

Where this sits in the section: [the tuning overview](/tuning/overview/) maps all the knob pages; probes are [Health Check Knobs](/tuning/health-check-knobs/); the capacity side of surge is [Requests & Limits Knobs](/tuning/requests-limits-knobs/).
