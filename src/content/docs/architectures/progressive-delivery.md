---
title: "Progressive Delivery: Metric-Gated Canary"
description: A complete Argo Rollouts build — canary steps over ingress-nginx, Prometheus-backed AnalysisTemplates that judge the new version on real traffic, and automatic rollback with the GitOps interplay spelled out.
sidebar:
  order: 12
---

A perfect rolling update proves exactly one thing: the new pods became **Ready**. Readiness is a [health check](/workloads/health-checks/) — it says the process is up, the port answers, the dependencies connect. It says nothing about whether the new version is *correct*. A release that returns 5xx on 8% of requests passes readiness on every pod. A release whose p99 doubled because someone dropped an index hint passes readiness on every pod. The [zero-downtime build](/architectures/zero-downtime/) makes the *mechanics* of the swap lossless; the [manual two-Deployment canary](/workloads/rollouts-and-rollbacks/) puts a human in front of a Grafana dashboard to judge correctness. This article is the layer above both: **shift a slice of real traffic to the new version, measure it against explicit statistical gates, and promote or roll back automatically** — no human watching a dashboard at 2 a.m.

The patient is **orders-api** from the [Golden Service](/architectures/golden-service/) — same container, same probes, same resources. What changes is who owns the ReplicaSets.

## Choosing the tool honestly

Three real options exist on a platform-managed cluster, and the right one is not always the fanciest:

| | ingress-nginx canary annotations | Flagger | Argo Rollouts |
|---|---|---|---|
| **What it is** | Two Deployments + two Ingresses; you set `canary-weight` by hand | A controller that *wraps* your existing Deployment, generating primary/canary copies | A [CRD](/controllers/crds-explained/) that *replaces* Deployment entirely |
| **New CRDs** | None | Canary, MetricTemplate | Rollout, AnalysisTemplate, AnalysisRun, Experiment |
| **Metric gating** | You, squinting at Grafana | Automatic | Automatic |
| **Manifest invasiveness** | None | Low — Deployment unchanged | High — kind changes, GitOps pipeline must know |
| **Rollback** | You edit the weight back | Automatic | Automatic |

The [ingress-nginx](/networking/ingress-nginx/) annotation approach is genuinely fine for a service that ships weekly and has one on-call team: zero platform asks, zero new CRDs, and the manual canary procedure in [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/) already documents it. Flagger's wrap-don't-replace model is the gentler migration — your Deployment stays a Deployment — but the generated `-primary` copy confuses every `kubectl` habit you have, and debugging *which* object owns the pods gets genuinely weird.

This build uses **Argo Rollouts** because it makes the invasive-but-powerful trade explicitly: you convert the Deployment to a Rollout once, and in exchange you get first-class steps, inline and background analysis, a real CLI, and abort semantics you can reason about. The [Argo Rollouts documentation](https://argoproj.github.io/rollouts/) is the upstream reference; everything below is the tenant-side view.

**The platform ask** is one controller: the Argo Rollouts controller plus its CRDs, cluster-scoped, installed once. Frame it per [Working with the Platform Team](/operations/working-with-platform-team/): "we need the Rollouts controller ≥ v1.6 with the nginx traffic-router enabled; all our objects stay namespaced." You also need the cluster Prometheus query endpoint reachable from the controller — get the exact URL from the platform team, it appears in every AnalysisTemplate below.

## Architecture

```text
                     orders.example.com
                            │
                     ingress-nginx
                    ┌───────┴───────────────┐
              weight 90–100%           weight 0–100%
                    │                       │
        Ingress: orders-api      Ingress: orders-api-orders-api-canary
                    │              (written and updated by Rollouts)
         Service: orders-api-stable   Service: orders-api-canary
                    │                       │
          ReplicaSet rev N (stable)  ReplicaSet rev N+1 (canary)
                    └───────────┬───────────┘
                        Rollout: orders-api
                                │
              AnalysisRuns ←── Prometheus (canary-scoped queries)
```

## The build

### 1. The Rollout

The Deployment-to-Rollout conversion changes exactly two things: `apiVersion`/`kind`, and the `strategy` block. Pod template, probes, resources — untouched. Your GitOps pipeline needs to know about the new kind: Argo CD ships a built-in health check for Rollouts, but your [tenant repo](/operations/gitops-for-tenants/) conventions (kustomize patches targeting `kind: Deployment`, image-updater rules, policy checks) all need the same rename. Do the conversion as its own PR, before any canary logic goes live.

```yaml
apiVersion: argoproj.io/v1alpha1      # was: apps/v1
kind: Rollout                          # was: Deployment
metadata:
  name: orders-api
  namespace: orders
spec:
  replicas: 6
  revisionHistoryLimit: 3
  selector:
    matchLabels:
      app: orders-api
  template:                            # identical to the Golden Service pod template
    metadata:
      labels:
        app: orders-api
    spec:
      containers:
        - name: orders-api
          image: registry.example.com/orders-api:1.8.0
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet: {path: /readyz, port: http}
            periodSeconds: 5
          resources:
            requests: {cpu: 800m, memory: 1536Mi}
            limits: {memory: 1536Mi}
  strategy:
    canary:                            # replaces rollingUpdate
      canaryService: orders-api-canary      # Rollouts stamps the canary RS hash into this selector
      stableService: orders-api-stable      # ...and the stable RS hash into this one
      trafficRouting:
        nginx:
          stableIngress: orders-api        # the Ingress YOU own; Rollouts derives the canary twin
      # Background analysis: runs continuously from step 1 until promotion.
      # This is the tripwire — it can abort during a pause, not just at a gate.
      analysis:
        templates:
          - templateName: error-budget-burn
        startingStep: 1
        args:
          - name: canary-hash
            valueFrom:
              podTemplateHashValue: Latest
      steps:
        - setWeight: 10                # step 0: 10% of real traffic to the canary
        - pause: {duration: 5m}        # step 1: accumulate metrics (background analysis armed)
        - analysis:                    # step 2: the inline gate — blocks until Successful
            templates:
              - templateName: success-rate
              - templateName: latency-p99
            args:
              - name: canary-hash
                valueFrom:
                  podTemplateHashValue: Latest
        - setWeight: 25                # step 3
        - pause: {duration: 5m}        # step 4
        - setWeight: 50                # step 5
        - pause: {duration: 5m}        # step 6 — then automatic full promotion (100%)
```

:::tip[The less-invasive migration]
Rollouts also supports `workloadRef`, where the Rollout points at your existing Deployment instead of embedding a pod template. It softens the GitOps rename but splits the source of truth across two objects. For a permanent conversion, embedding the template — as above — is the simpler steady state.
:::

### What Rollouts writes for you

You never create the canary Ingress. The controller derives it from `stableIngress` and updates its weight annotation at every step. Recognize it so you don't "fix" it:

```yaml
# GENERATED by Argo Rollouts — name pattern: <rollout>-<stableIngress>-canary
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: orders-api-orders-api-canary
  namespace: orders
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"   # controller rewrites this per step
spec:
  ingressClassName: nginx
  rules:
    - host: orders.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: orders-api-canary
                port: {number: 80}
```

:::note[The successor path]
Rollouts has a [Gateway API](/networking/gateway-api/) routing plugin that manipulates `HTTPRoute` `backendRefs` weights instead of nginx annotations — cleaner semantics, no generated twin Ingress. If your platform's front door is already Gateway API, use that router; everything else in this article is unchanged.
:::

### 2. The two Services and the stable Ingress

Both Services select `app: orders-api`; the controller *injects* a `rollouts-pod-template-hash` selector into each at runtime so that stable selects only revision N and canary only revision N+1. You write them hash-free:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: orders-api-stable
  namespace: orders
spec:
  selector:
    app: orders-api          # Rollouts adds rollouts-pod-template-hash: <stable-hash>
  ports:
    - name: http
      port: 80
      targetPort: http
---
apiVersion: v1
kind: Service
metadata:
  name: orders-api-canary
  namespace: orders
spec:
  selector:
    app: orders-api          # Rollouts adds rollouts-pod-template-hash: <canary-hash>
  ports:
    - name: http
      port: 80
      targetPort: http
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: orders-api            # the stableIngress named in the Rollout
  namespace: orders
spec:
  ingressClassName: nginx
  rules:
    - host: orders.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: orders-api-stable
                port: {number: 80}
```

:::caution[Argo CD will see the injected selectors as drift]
If self-heal is on, add an `ignoreDifferences` entry for the two Services' `spec.selector` in your Application, or Argo CD will strip the hash and briefly point both Services at all pods. This is the one [GitOps](/operations/gitops-for-tenants/) sharp edge in the conversion itself.
:::

### 3. AnalysisTemplates — the heart

Everything above is plumbing; this is the judgment. The single thing that makes or breaks analysis is **label scoping**: the queries must measure the *canary pods only*. Rollouts labels every pod with `rollouts-pod-template-hash`, and passes the current canary's hash in as `{{args.canary-hash}}`. Your Prometheus scrape config must propagate that pod label onto the metrics — verify with one ad-hoc query before trusting any of this (see [Metrics](/observability/metrics/) for how labels ride along, and [PromQL for Resources](/observability/promql-for-resources/) for `rate()` mechanics). A query that accidentally matches *all* pods will happily average the canary's 40% error rate against the stable fleet and wave the release through.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: success-rate
  namespace: orders
spec:
  args:
    - name: canary-hash
  metrics:
    - name: success-rate
      interval: 1m            # one measurement per minute...
      count: 5                # ...five times: this gate takes 5 minutes
      successCondition: result[0] >= 0.99
      failureLimit: 1         # tolerate ONE bad measurement; the 2nd aborts the rollout
      provider:
        prometheus:
          address: http://prometheus-k8s.monitoring.svc.cluster.local:9090
          query: |
            sum(rate(http_requests_total{namespace="orders", app="orders-api",
              rollouts_pod_template_hash="{{args.canary-hash}}", status!~"5.."}[2m]))
            /
            sum(rate(http_requests_total{namespace="orders", app="orders-api",
              rollouts_pod_template_hash="{{args.canary-hash}}"}[2m]))
---
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: latency-p99
  namespace: orders
spec:
  args:
    - name: canary-hash
  metrics:
    - name: latency-p99
      interval: 1m
      count: 5
      successCondition: result[0] <= 0.5      # p99 under 500ms — set from YOUR baseline, not this page
      failureLimit: 1
      inconclusiveLimit: 2    # empty results (no canary traffic yet) pause rather than fail
      provider:
        prometheus:
          address: http://prometheus-k8s.monitoring.svc.cluster.local:9090
          query: |
            histogram_quantile(0.99, sum by (le) (
              rate(http_request_duration_seconds_bucket{namespace="orders", app="orders-api",
                rollouts_pod_template_hash="{{args.canary-hash}}"}[2m])))
---
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: error-budget-burn      # the business-ish tripwire, run in the BACKGROUND
  namespace: orders
spec:
  args:
    - name: canary-hash
  metrics:
    - name: error-budget-burn
      interval: 1m             # no count: background analysis runs until promotion or abort
      successCondition: result[0] < 14       # 14x burn = the classic fast-burn page threshold
      failureLimit: 1
      provider:
        prometheus:
          address: http://prometheus-k8s.monitoring.svc.cluster.local:9090
          query: |
            (sum(rate(http_requests_total{namespace="orders", app="orders-api",
               rollouts_pod_template_hash="{{args.canary-hash}}", status=~"5.."}[2m]))
             /
             sum(rate(http_requests_total{namespace="orders", app="orders-api",
               rollouts_pod_template_hash="{{args.canary-hash}}"}[2m])))
            / 0.001              # error rate ÷ budget for a 99.9% SLO = burn rate multiple
```

The semantics that matter, precisely:

- **`successCondition`** is evaluated per measurement. A measurement that returns a value failing the condition is **Failed**; an empty vector is **Inconclusive**; an unreachable Prometheus is an **Error**. Three different counters, three different limits (`failureLimit`, `inconclusiveLimit`, `consecutiveErrorLimit` — default 4).
- **`failureLimit: 1`** means the metric fails when failed measurements *exceed* one — i.e. the second bad minute aborts. `failureLimit: 0` (the default) aborts on the first blip; for a `rate()` over real traffic that is usually too twitchy.
- **The interval/count math is the bake time.** This build: 5m pause + 5m inline gate + 5m + 5m = roughly **20 minutes from apply to 100%**, with the background burn-rate check live for all of it. If someone asks "why does deploying take 20 minutes now," this arithmetic is the answer — it is the price of the automatic verdict, and you tune it consciously, not by deleting pauses.

### 4. Inline vs background analysis

The Rollout above wires both deliberately. The **inline** `analysis` step (step 2) is a *gate*: the rollout stops and waits for the AnalysisRun to finish; Successful proceeds to 25%, Failed aborts. The **background** `analysis` block (with `startingStep: 1`) is a *tripwire*: it runs concurrently from the first pause until full promotion, and can abort the rollout *mid-pause* — which is exactly what limits blast radius when the canary is visibly on fire at minute 2 of a 5-minute pause. Gates give you a definitive checkpoint; tripwires give you fast abort. Use both.

## When analysis fails: the rollback story, precisely

On a failed AnalysisRun the controller **aborts**: canary weight goes to 0, the generated Ingress annotation is rewritten, 100% of traffic returns to stable within seconds, the canary ReplicaSet scales down, and the Rollout goes **Degraded** with `message: RolloutAborted`. Wire an alert on that condition (see [Alerting](/observability/alerting/)) — an aborted rollout at 2 a.m. should page the *deploying team's* channel, not on-call, because stable is serving and nothing is down.

Now the un-intuitive part that causes the classic 2 a.m. confusion: **an aborted Rollout's spec still points at the new, bad image.** Abort is a *status*, not a spec change. The cluster is serving revision N while the object declares revision N+1. Your options:

- **`kubectl argo rollouts undo rollout/orders-api -n orders`** rewrites the spec back to the previous template. On a kubectl-driven pipeline this is the fix. **Under GitOps it is a trap**: git still says 1.8.0, so Argo CD self-heal re-applies it, which *un-aborts* and restarts the bad canary. You undo, it comes back, you undo again — that loop is the 2 a.m. story.
- **`git revert`** is the correct move on a GitOps cluster: revert the image bump, let the sync flow through, and the Rollout sees spec == stable, marks itself Healthy, and the incident is over with an audit trail. The abort itself is *not* fought by self-heal — status isn't in git — Argo CD simply reports the app Degraded, which is your signal to revert. Details of the tenant-side flow live in [GitOps for Tenants](/operations/gitops-for-tenants/).
- **`kubectl argo rollouts retry rollout/orders-api`** re-runs the same spec from step 0 — for when the failure was environmental (Prometheus hiccup, dependency blip) and the code is believed good.

## Operating it

The CLI plugin is the daily driver. `kubectl argo rollouts get rollout orders-api -n orders --watch` mid-canary looks like this:

```text
Name:            orders-api
Namespace:       orders
Status:          ॥ Paused
Message:         CanaryPauseStep
Strategy:        Canary
  Step:          1/7
  SetWeight:     10
  ActualWeight:  10
Images:          registry.example.com/orders-api:1.8.0 (canary)
                 registry.example.com/orders-api:1.7.2 (stable)
Replicas:
  Desired:       6
  Current:       7
  Updated:       1
  Ready:         7
  Available:     7

NAME                                     KIND         STATUS        AGE    INFO
⟳ orders-api                             Rollout      ॥ Paused      14d
├──# revision:8
│  ├──⧉ orders-api-7bf9d6c84             ReplicaSet   ✔ Healthy     3m     canary
│  │  └──□ orders-api-7bf9d6c84-x2m4p    Pod          ✔ Running     3m     ready:1/1
│  └──α orders-api-7bf9d6c84-8           AnalysisRun  ◌ Running     2m     ✔ 2
└──# revision:7
   └──⧉ orders-api-6d5f8b9c7             ReplicaSet   ✔ Healthy     14d    stable
      └──□ orders-api-6d5f8b9c7-9wkzt    Pod          ✔ Running     14d    ready:1/1
```

Read it top-down at each phase: `SetWeight` vs `ActualWeight` (they diverge if the traffic router is broken — a key diagnostic), which image is canary vs stable, and the AnalysisRun tally (`✔ 2` = two successful measurements so far). The verbs:

```bash
kubectl argo rollouts promote orders-api -n orders          # skip the current pause/gate
kubectl argo rollouts promote orders-api -n orders --full   # straight to 100% (break-glass)
kubectl argo rollouts abort orders-api -n orders            # manual abort — same semantics as analysis failure
kubectl argo rollouts retry rollout/orders-api -n orders    # re-run an aborted rollout from step 0
kubectl argo rollouts dashboard -n orders                   # local web UI on :3100 — the demo-to-management view
```

**Pipeline integration**: the CI gate is `kubectl argo rollouts status orders-api -n orders --timeout 30m` — it blocks until the rollout is fully promoted (exit 0) or aborted/degraded (exit 1). That single command turns your [deploy job](/operations/cicd-pipeline-design/) into "apply, then wait for the verdict," and a red pipeline now means *the metrics rejected the release*, which is a much better failure than "kubectl apply succeeded."

## Verification plan

Run all four drills in staging before trusting this in production.

**1. The good release.** Bump the image to a known-good build, sync, and watch. Expect: weight 10 → 5m pause with the background AnalysisRun ticking `✔` → inline gate runs 5 measurements, all Successful → 25 → 50 → automatic promotion; stable image becomes 1.8.0; the old ReplicaSet scales to 0 after the 30s default `scaleDownDelaySeconds`. Total ~20 minutes, zero human actions.

**2. The bad release.** Ship a build with a fault flag (e.g. `FAULT_500_RATE=0.3` returning 5xx on 30% of requests — build the flag into your test image; it's the most reusable test asset this article creates). Watch the background burn-rate tripwire catch it *during the first pause*:

```text
Status:          ✖ Degraded
Message:         RolloutAborted: metric "error-budget-burn" assessed Failed due to failed (2) > failureLimit (1)

│  └──α orders-api-5c9f7d2b1-9         AnalysisRun  ✖ Failed   4m   ✔ 1,✖ 2
```

The blast-radius math is the whole sales pitch: the fault reached **10% of traffic for under 5 minutes** — one clean measurement, two failed ones at 1-minute intervals, abort, traffic restored to stable in seconds. Under a plain rolling update the same build would have reached 100% of traffic and stayed there until a human noticed.

**3. The latency regression.** Ship a build with an injected 300ms sleep and a *perfect* success rate. The success-rate template passes every measurement; `latency-p99` fails the inline gate at minute ~7. This drill proves the p99 template catches what error-rate misses — and it is the drill teams skip, then learn about in production.

**4. The abort-then-revert cleanup.** After drill 2, while the Rollout sits Degraded: `git revert` the image bump, sync, and confirm the Rollout returns to Healthy with spec == stable == git, and the failed AnalysisRun is retained for post-mortem (`kubectl get analysisrun -n orders`). Then — once — try `kubectl argo rollouts undo` instead with self-heal on, and watch Argo CD resurrect the bad canary. Seeing the loop in staging is what stops you from doing it in production.

## Failure modes

| Symptom | Cause | What actually happens | Fix |
|---|---|---|---|
| AnalysisRun stuck `Inconclusive`, rollout paused indefinitely | Query returns an empty vector (no canary samples yet, or a label typo) | Inconclusive ≠ Failed: the rollout **pauses for a human**, it does not abort | Fix the label scoping; set `inconclusiveLimit` deliberately; alert on paused-too-long |
| AnalysisRun `Error`, then aborts after ~4 minutes | Prometheus unreachable from the controller | Errors count against `consecutiveErrorLimit` (default 4), then the metric fails | NetworkPolicy/address check with the platform team; treat as environmental → `retry` |
| `ActualWeight` stays 0 while `SetWeight: 10` | Wrong `stableIngress` name, or a pre-existing `canary: "true"` annotation colliding on the ingress | Canary pods run but receive nothing; analysis goes Inconclusive (empty results) | One canary ingress per stable ingress, owned by Rollouts only — remove hand-added canary annotations |
| Analysis passes but you don't believe it | Too little traffic: at 10% weight a 5 rps service gives the canary ~0.5 rps — ~30 requests per measurement | One unlucky request swings success-rate by 3%: **statistical theater** | Honest floor: want ≥ ~100 canary requests per interval. Below ~10 rps total, raise the first weight, lengthen intervals, or use the manual canary |
| Replica counts thrash mid-canary | HPA targeting the old Deployment, or targeting the Rollout with conflicting `replicas` in git | Rollouts supports the scale subresource — HPA should target the Rollout, and `replicas` should be removed from git | `scaleTargetRef: {apiVersion: argoproj.io/v1alpha1, kind: Rollout, name: orders-api}` |
| Abort "doesn't stick" — bad canary keeps coming back | `kubectl argo rollouts undo` under Argo CD self-heal | Spec fight: git says new image, undo says old; self-heal wins forever | `git revert` is the only durable rollback on a GitOps cluster (see above) |
| Canary metrics look implausibly clean | Sticky sessions (cookie affinity) pinning established users to stable | The canary sample is mostly *new* sessions — a biased slice that under-represents logged-in flows | Accept the bias knowingly, or use `canary-by-header` for deliberate test traffic alongside weight |

## The maturity ladder — and when to stop climbing

The honest progression: **manual two-Deployment canary** (a human and a dashboard — [already documented](/workloads/rollouts-and-rollbacks/)) → **gated canary** (weights step automatically, a human approves at a pause) → **auto-rollback** (this build: metrics decide, humans read the verdict) → **blue/green with preview** (Rollouts' other strategy: full parallel stack, test against a preview Service, instant cutover — the right shape when your risk is schema-coupled releases rather than gradual regressions).

Climb only as far as your traffic justifies. The sparse-metrics row in the table above is not an edge case — it is *most internal services*. A 3 rps admin API gains nothing from this machinery: its canary sample is noise, its bake time is pure delay, and the manual canary with a five-minute Grafana check is genuinely the better engineering. This architecture earns its 20-minute bake and its four CRDs when the service has real traffic (tens of rps and up), real SLOs, and a release cadence high enough that "a human watches every deploy" has already failed. That is orders-api. It may not be your service yet — and shipping the Golden Service well is the prerequisite, not the consolation prize.
