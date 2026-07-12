---
title: "Before You Autoscale: The No-Assumptions Checklist"
description: Ten preconditions an app must meet before an HPA touches it, each with a copy-paste check command, the expected output, and who to call when it fails.
keywords:
  - is my app ready for autoscaling
  - hpa requirements checklist
  - missing request for cpu hpa
  - kubectl top pods error metrics api not available
  - can i create an hpa rbac forbidden
  - autoscaling prerequisites kubernetes
  - what do i need before enabling hpa
sidebar:
  order: 4
---

You are here if: you're about to add an HPA and want to know what could go wrong first; or you tried one and it did something strange; or you're the reviewer asking "did they check anything?"

An HPA pointed at an unprepared app doesn't fail loudly — it makes things worse *quietly*. It scales on broken math and pins at max. It adds pods that say Ready before they can serve. It kills pods mid-message during scale-in. None of these page you with "your prerequisites were missing"; they page you with symptoms three layers downstream.

So: ten things that must be true first. Every item has a command that proves it, the output you want to see, and who owns the fix when it fails. Run them top to bottom against a real deployment — this page uses `payments-api` in namespace `payments`; substitute your names. Budget fifteen minutes.

:::tip[This checklist is an artifact]
Copy the [summary table](#the-summary-table) into your PR description or team wiki. It reappears, grown into a full review gate, in [Capacity and Governance](/autoscaling/capacity-and-governance/) — passing it here means passing review later.
:::

## 1. Your pods declare resource requests

A **request** is the slice of a node reserved for your pod — reserved whether you use it or not. The HPA's percentage math is *defined in terms of the CPU request*: "70% utilization" means 70% of what you requested. No request, no math — the HPA reports `<unknown>` and does nothing.

Check what your running Deployment actually declares (not what you think the chart says — what's deployed):

```bash
kubectl get deployment payments-api -n payments \
  -o jsonpath='{.spec.template.spec.containers[*].resources}'
```

```console
$ kubectl get deployment payments-api -n payments -o jsonpath='{.spec.template.spec.containers[*].resources}'
{"limits":{"memory":"1Gi"},"requests":{"cpu":"250m","memory":"512Mi"}}
```

You want to see a `requests` block with **both** `cpu` and `memory`, on **every** container — one request-less sidecar blinds the HPA (`FailedGetResourceMetric: missing request for cpu`). If the output is `{}` or missing `cpu`, stop here: [requests and limits knobs](/tuning/requests-limits-knobs/) explains the fields, and the fix is a chart change, not a kubectl patch.

And the numbers must be **measured, not padded**. Requests are reservations on a fixed shared cluster: pad yours "to be safe" and you silently shrink every neighbor's headroom — then the HPA multiplies the padding by every replica it adds. Compare reserved against actually-used:

```bash
kubectl top pods -n payments -l app.kubernetes.io/name=payments-api
```

```console
$ kubectl top pods -n payments -l app.kubernetes.io/name=payments-api
NAME                            CPU(cores)   MEMORY(bytes)
payments-api-7d4b9c8f6d-2mhxl   61m          403Mi
payments-api-7d4b9c8f6d-x8rwp   58m          397Mi
```

Read it: each pod *uses* ~60m CPU against a 250m request. Some gap is healthy (that's your burst headroom); a 10× gap is hoarding. If you've never measured, the [sizing walkthrough](/tuning/sizing-walkthrough/) is the method and it's a prerequisite for everything downstream — every threshold in this section assumes requests reflect reality.

**If it fails:** yours to fix, in the chart.

## 2. The cluster can measure CPU at all

`kubectl top` works only if **metrics-server** (the cluster component that samples CPU/memory from each node) is installed and healthy. It usually is — but "usually" isn't a prerequisite.

```bash
kubectl top pods -n payments
```

```console
$ kubectl top pods -n payments
NAME                            CPU(cores)   MEMORY(bytes)
payments-api-7d4b9c8f6d-2mhxl   61m          403Mi
```

If instead you get `error: Metrics API not available`, no CPU-based HPA can work on this cluster. **If it fails:** platform team — this is their component. ([What the metrics stack looks like](/observability/metrics/), if you want the map before you ask.)

## 3. Readiness and liveness probes exist — and are honest

A **readiness probe** is the check Kubernetes runs to decide whether to send your pod traffic; a **liveness probe** decides whether to restart it. Autoscaling makes both load-bearing: every scale-up creates a brand-new pod, and the moment its readiness probe passes, real user traffic arrives. A probe that passes before the app can actually serve turns every scale-up into a burst of 502s — scaling that *hurts*.

```bash
kubectl get deployment payments-api -n payments \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{": readiness="}{.readinessProbe.httpGet.path}{" liveness="}{.livenessProbe.httpGet.path}{"\n"}{end}'
```

```console
$ kubectl get deployment payments-api -n payments -o jsonpath='...'
payments-api: readiness=/actuator/health/readiness liveness=/actuator/health/liveness
```

Empty output means no probes — stop and fix. Present-but-dishonest probes (a readiness check that returns 200 before the connection pool has filled) are subtler; [health check design](/tuning/health-check-design/) covers writing ones that tell the truth, and [Spring Boot Under an HPA](/autoscaling/spring-boot-scaling/) covers the JVM-specific traps.

**If it fails:** yours.

## 4. Your app survives being stopped on purpose

Scale-**in** is the HPA deliberately killing your pods, over and over, forever. Whatever your shutdown behavior is today — dropped requests, half-finished work, connection resets — autoscaling multiplies it from "rare deploy artifact" to "several times a day."

The test is behavioral, not a one-liner: delete a pod under light load and watch for errors (Lab 8 runs [exactly this drill](/labs/lab-8-deploy-under-load/) if you want the full method). The quick config check — do you have a preStop hook and a real grace period?

```bash
kubectl get deployment payments-api -n payments \
  -o jsonpath='{.spec.template.spec.terminationGracePeriodSeconds}{" / preStop: "}{.spec.template.spec.containers[0].lifecycle.preStop.exec.command}'
```

```console
$ kubectl get deployment payments-api -n payments -o jsonpath='...'
40 / preStop: ["sh","-c","sleep 5"]
```

If you see `30 / preStop: ` (the default grace, no hook), read [graceful shutdown](/workloads/graceful-shutdown/) before enabling any autoscaler. **If it fails:** yours.

## 5. Consumers: message handling is idempotent

**Idempotent** means processing the same message twice produces the same result as processing it once. Scale-in sends SIGTERM to a consumer that has messages in flight; anything unacknowledged goes back on the queue and *will be redelivered* to another pod. That's not a failure mode — it's how at-least-once delivery works. If your listener charges a card or sends an email per message, redelivery without idempotency means double charges.

No command proves this one; it's a code review question: "what happens if this handler runs twice for the same message?" If the answer involves an uncomfortable silence, [Messaging Consumers](/autoscaling/messaging-consumers/) has the patterns — and this item is a hard blocker for queue-driven scaling, not a nice-to-have.

**If it fails:** yours, in application code.

## 6. Something scrapes your metrics (for anything beyond CPU)

CPU scaling rides on metrics-server (item 2). Every *better* signal — requests per second, busy threads, anything from [the catalog](/autoscaling/signals-catalog/) — needs your app's metrics collected by Prometheus. Two links in that chain, two checks. Your app publishes:

```bash
kubectl exec -n payments deploy/payments-api -- \
  curl -s localhost:8080/actuator/prometheus | head -5
```

```console
$ kubectl exec -n payments deploy/payments-api -- curl -s localhost:8080/actuator/prometheus | head -5
# HELP jvm_memory_used_bytes The amount of used memory
# TYPE jvm_memory_used_bytes gauge
jvm_memory_used_bytes{area="heap",id="G1 Eden Space"} 1.2058624E8
```

And something collects it — a **ServiceMonitor** (the object that tells the Prometheus operator to scrape you):

```bash
kubectl get servicemonitor -n payments
```

```console
$ kubectl get servicemonitor -n payments
NAME           AGE
payments-api   214d
```

Either check empty? [How the Numbers Reach the Autoscaler](/autoscaling/getting-the-metrics/) builds the whole pipeline step by step. **If it fails:** publishing is yours; the Prometheus stack existing at all is the platform's.

## 7. You're allowed to create the objects

Three permission walls, three commands. Can you create an HPA?

```bash
kubectl auth can-i create horizontalpodautoscalers -n payments
```

```console
$ kubectl auth can-i create horizontalpodautoscalers -n payments
yes
```

Does your namespace quota have headroom for more pods? (A **ResourceQuota** caps the total requests a namespace can claim — your HPA scales until it hits this wall, then pods go Pending.)

```bash
kubectl describe resourcequota -n payments
```

```console
$ kubectl describe resourcequota -n payments
Name:            payments-quota
Resource         Used    Hard
--------         ----    ----
requests.cpu     2500m   8
requests.memory  5Gi     16Gi
```

Read it: `Hard` minus `Used` is the room your scale-up has. Divide by one pod's requests to know how many more pods fit before the quota — that number caps your effective maxReplicas no matter what the HPA says. And if you plan anything beyond CPU — custom signals, queue-driven scaling — does the cluster have an **external-metrics mechanism** at all? Neither ships with Kubernetes; check for both fingerprints (a **CRD** — CustomResourceDefinition — is how an add-on like KEDA teaches the cluster a new object type; an APIService is how prometheus-adapter plugs into the HPA's metrics APIs):

```bash
kubectl get crd scaledobjects.keda.sh
kubectl get apiservice v1beta1.custom.metrics.k8s.io v1beta1.external.metrics.k8s.io
```

```console
$ kubectl get crd scaledobjects.keda.sh
Error from server (NotFound): customresourcedefinitions.apiextensions.k8s.io "scaledobjects.keda.sh" not found
$ kubectl get apiservice v1beta1.custom.metrics.k8s.io v1beta1.external.metrics.k8s.io
Error from server (NotFound): apiservices.apiregistration.k8s.io "v1beta1.custom.metrics.k8s.io" not found
Error from server (NotFound): apiservices.apiregistration.k8s.io "v1beta1.external.metrics.k8s.io" not found
```

All `NotFound`, as here, means CPU is the only signal this cluster can scale on *today* — and that's a **named ask to the platform team**, like the others this item surfaces: "grant HPA create in payments," "raise the payments quota, here's the derivation," "install prometheus-adapter or KEDA" ([the fork](/autoscaling/getting-the-metrics/#5-the-fork-adapter-or-keda) decides which to ask for) — [how to ask well](/operations/working-with-platform-team/).

## 8. You can generate load somewhere that isn't prod

An untested HPA is a hypothesis. You need a pre-prod environment and any load tool that can ramp (fortio, k6, vegeta — Lab 8's in-cluster [fortio Job](/labs/lab-8-deploy-under-load/) is the pattern this site uses). The test that matters isn't "did it scale" — it's the whole chain: metric moves → HPA computes sanely → new pods schedule (quota!) → new pods become Ready fast enough to help. [The load-test drill](/workloads/autoscaling/#load-test-your-scaling-before-prod-does-it-for-you) is step-by-step.

**If it fails:** yours to arrange, before prod. This is the one item teams skip and regret on schedule.

## 9. `replicas:` is out of your chart when the HPA is on

Your Helm chart says `replicas: 3`. The HPA scales you to 8. The next `helm upgrade` — any upgrade, even a config tweak — resets you to 3, mid-rush, and the HPA spends the next minutes clawing back. This tug-of-war is the most common self-inflicted autoscaling outage, and the fix is one template guard:

```yaml
# charts/payments-api/templates/deployment.yaml
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}   # only render a replica count when no HPA owns it
  {{- end }}
```

When `autoscaling.enabled=true`, the chart stops expressing an opinion about replica count and the HPA becomes the single owner. Check whether your chart has the guard: `helm template charts/payments-api --set autoscaling.enabled=true | grep -c 'replicas:'` should return `0` for the Deployment. The full chart audit — this plus seven more items — is in [Rationalize the App and the Chart](/autoscaling/classify-your-app/), and [Lab 10](/labs/lab-10-autoscaling/) makes this exact edit on a real chart.

**If it fails:** yours, one PR.

## 10. You can say what users need — at some level

The soft prerequisite, and the one this section trains you on. Before choosing thresholds you need *a stated objective*, even a rough one: "users are OK if pages render in about a second," or failing that, "keep p95 near today's value." There's a whole graceful ladder from "we have real SLOs" down to "we can only describe system behavior" — [Start With the User](/autoscaling/slos-for-scaling/) — and every level is acceptable *if written down*. What's not acceptable is a threshold with no stated reason, because nobody can ever review or revisit it.

**If it fails:** it can't, yet — you just have to write one sentence. That's the point.

## The summary table

| # | Prerequisite | The check | Owner if broken |
|---|---|---|---|
| 1 | Requests declared, measured | `kubectl get deploy … -o jsonpath='…resources'` + `kubectl top` | YOU |
| 2 | metrics-server healthy | `kubectl top pods -n payments` | PLATFORM |
| 3 | Honest probes | jsonpath for readiness/liveness | YOU |
| 4 | Graceful shutdown | grace + preStop check, pod-kill drill | YOU |
| 5 | Idempotent consumers | code review question | YOU |
| 6 | Metrics published + scraped | `curl /actuator/prometheus`, `kubectl get servicemonitor` | YOU / PLATFORM |
| 7 | RBAC, quota headroom, an external-metrics mechanism | `kubectl auth can-i`, `describe resourcequota`, `get crd` / `get apiservice` | PLATFORM (you ask) |
| 8 | Load-test capability | pre-prod + fortio/k6 | YOU |
| 9 | Chart's `replicas:` gated | `helm template … \| grep` | YOU |
| 10 | An objective, written down | one sentence | YOU |

## Where next

- **Next in the journey:** [Rationalize the App and the Chart](/autoscaling/classify-your-app/) — the environment is ready; now check the app itself is safe to multiply, and grade the chart.
- **The lateral jump:** all ten green and in a hurry? [The 15-Minute Conservative HPA](/autoscaling/quick-start/) is now safe for you.
