---
title: The 15-Minute Conservative HPA
description: The smallest safe autoscaling setup for a Spring Boot service — a four-check gate, a fully annotated conservative HPA, a one-sentence SLO seed, and the honest list of what this doesn't do.
keywords:
  - enable autoscaling quickly
  - simple hpa for spring boot
  - safe default hpa settings
  - minimal hpa setup kubernetes
  - conservative autoscaling defaults
  - hpa by friday deadline
sidebar:
  order: 2
---

You are here if: you've been told to enable autoscaling by Friday; or you want one safe win before reading a sixteen-page playbook; or you're piloting the section's approach on a low-stakes service first.

Here is the smallest setup that won't hurt anyone — and, at the end, the honest list of what it deliberately doesn't do. Fifteen minutes assumes the gate passes; if the gate fails, the gate just saved you an incident, which is a better use of the fifteen minutes.

The example is `payments-api` in namespace `payments` — substitute your names throughout.

## The gate: four checks

Each is one command. Any failure → stop, follow the link, come back.

**1. Requests exist.** The HPA's percentage math is built on your CPU request — no request, no autoscaling ([why](/autoscaling/prerequisites/#1-your-pods-declare-resource-requests)):

```bash
kubectl get deployment payments-api -n payments \
  -o jsonpath='{.spec.template.spec.containers[*].resources.requests}'
```

```console
$ kubectl get deployment payments-api -n payments -o jsonpath='...'
{"cpu":"250m","memory":"512Mi"}
```

Empty, or no `cpu` key → [prerequisites #1](/autoscaling/prerequisites/), stop.

**2. The cluster can measure.**

```bash
kubectl top pods -n payments
```

Real numbers → pass. `Metrics API not available` → platform ticket ([#2](/autoscaling/prerequisites/#2-the-cluster-can-measure-cpu-at-all)), stop.

**3. Probes exist.** New pods get traffic the instant readiness passes; no probes means scale-ups ship 502s ([#3](/autoscaling/prerequisites/#3-readiness-and-liveness-probes-exist--and-are-honest)):

```bash
kubectl get deployment payments-api -n payments \
  -o jsonpath='{.spec.template.spec.containers[0].readinessProbe.httpGet.path}'
```

```console
$ kubectl get deployment payments-api -n payments -o jsonpath='...'
/actuator/health/readiness
```

**4. The 60-second safety screen.** More copies of an unsafe app is a bug factory, not capacity. Two questions: does anything run on a schedule inside the app, and do user sessions live in the JVM?

```bash
grep -rn "@Scheduled\|@EnableScheduling" src/main/java/ | head -3
```

Any hit — or a "yes" on in-JVM sessions — → [the safety audit](/autoscaling/classify-your-app/#part-1--can-n-copies-safely-coexist) first, stop. (A scaled `@Scheduled` job fires once *per replica*; the nightly report goes out four times.)

## The recipe

Two chart edits, both of which you keep forever. First, gate the replica count so `helm upgrade` and the HPA stop fighting ([the tug-of-war](/autoscaling/prerequisites/#9-replicas-is-out-of-your-chart-when-the-hpa-is-on)):

```yaml
# templates/deployment.yaml
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
```

Then the HPA template plus conservative values — every choice annotated with its reason and its trade:

```yaml
# templates/hpa.yaml
{{- if .Values.autoscaling.enabled }}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "payments-api.fullname" . }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "payments-api.fullname" . }}
  minReplicas: {{ .Values.autoscaling.minReplicas }}
  maxReplicas: {{ .Values.autoscaling.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .Values.autoscaling.targetCPU }}
  # No behavior block: the defaults (scale up fast, scale down after a 300s window)
  # are the conservative choice — that 300s window is most of what makes this recipe
  # safe for a slow-warming JVM. The trade: you run over-provisioned for ~5min after
  # each peak. Accept it today; tune it later with /autoscaling/spring-boot-scaling/.
{{- end }}
```

```yaml
# values.yaml
autoscaling:
  enabled: true
  minReplicas: 3    # = today's replicaCount. NEVER lower on day one: floor-at-today
                    # means enabling the HPA cannot reduce your capacity, so the worst
                    # case of this whole exercise is "nothing changes". The trade: no
                    # scale-in savings yet — that's deliberate; earn them later with a
                    # measured trough (/autoscaling/load-profile/).
  maxReplicas: 6    # = today × 2. A borrowing limit, not a plan.
                    # derivation: TODO — today×2 placeholder. Real ceiling math (Oracle
                    # sessions! /autoscaling/rest-api-oracle/) before raising. If 6 pods'
                    # DB connections would already exceed your session budget, LOWER this
                    # now — it's the one number here that can hurt someone else.
  targetCPU: 70     # forgiving-by-default: scales at 70% of request. If your requests
                    # are honest this rarely triggers at steady state; if it triggers
                    # constantly, your requests are too low — fix those, not this
                    # (/tuning/requests-limits-knobs/).
```

:::tip[Good citizen]
`maxReplicas: 6` is a claim on shared capacity and shared Oracle sessions, even as a placeholder. Today×2 is acceptable *because* it's modest; ×10 "to be safe" would be hoarding with a TODO attached. The ledger conversation comes [later](/autoscaling/capacity-and-governance/) — keep the placeholder honest so that conversation is easy.
:::

Ship it and watch it wake up:

```bash
helm upgrade payments charts/payments-api -n payments --set autoscaling.enabled=true
kubectl get hpa -n payments -w
```

```console
$ kubectl get hpa -n payments -w
NAME           REFERENCE                 TARGETS         MINPODS   MAXPODS   REPLICAS   AGE
payments-api   Deployment/payments-api   <unknown>/70%   3         6         3          10s
payments-api   Deployment/payments-api   24%/70%         3         6         3          45s
```

Reading that output, column by column, first time through: `TARGETS` is current-vs-target — `<unknown>` for the first ~15–30 s is *normal* (the first metrics sample hasn't landed; only worry if it persists, which is [the runbook's opening symptom](/troubleshooting/hpa-not-scaling/)). `REPLICAS` is what the HPA currently runs. When `24%/70%` appears, the loop is alive: measured CPU is 24% of requests, comfortably under target, nothing to do — exactly what a conservative HPA at steady state should say.

## The one-sentence SLO seed

Two minutes that upgrade this from "a thing we enabled" to "a thing we can judge." Write down, anywhere durable:

> **Users are OK if ______.**

("…checkout responds in about a second." "…the confirmation email arrives within a few minutes.") Can't fill the blank? Then record today's behavior as your provisional line in the sand. Today's **p95** — the response time 95 of 100 requests beat, i.e. your unluckiest 1-in-20 user's experience — one query, if your app publishes latency histograms ([if not](/autoscaling/getting-the-metrics/#1-make-the-app-publish), skip and note that too):

```promql
histogram_quantile(0.95, sum by (le) (rate(http_server_requests_seconds_bucket{namespace="payments", service="payments-api"}[1h])))
```

Write "PROVISIONAL: keep p95 ≤ <that number>" next to the values file. This sentence is the seed the [SLO page](/autoscaling/slos-for-scaling/) grows into a real objective — and the difference, starting today, between a target and a guess.

## Watch it for a week

Three queries, each with what-good-looks-like and the action if it doesn't:

| Watch | Query | Healthy | If not |
|---|---|---|---|
| Replica count over time | `kube_horizontalpodautoscaler_status_current_replicas{horizontalpodautoscaler="payments-api"}` | flat at 3 with occasional purposeful excursions | sawtooth all day → requests are dishonest or the signal's wrong: [signals catalog](/autoscaling/signals-catalog/) |
| CPU vs target | `avg(rate(container_cpu_usage_seconds_total{namespace="payments",pod=~"payments-api.*"}[5m])) / avg(kube_pod_container_resource_requests{namespace="payments",pod=~"payments-api.*",resource="cpu"})` | steady state well under 0.70 | pinned near/over target at rest → requests too low, fix them ([knobs](/tuning/requests-limits-knobs/)) |
| Your seed sentence | the p95 query above | at/under your provisional line | worse during scale events → cold-pod problem: [Spring Boot page](/autoscaling/spring-boot-scaling/) |

A week of this watching is, quietly, real measurement: you now have the raw material for a proper [state table](/autoscaling/load-profile/) — you've accidentally started the load-profile exercise; go finish it.

:::caution[What this deliberately doesn't do]
Honesty about the recipe's edges — this is L1 of [the maturity ladder](/autoscaling/overview/#the-maturity-ladder), not the destination:

- **CPU may be the wrong signal for you.** Apps that *wait* on Oracle/MQ saturate threads while CPU idles — this HPA will scale late for them. → [The Numbers That Matter](/autoscaling/signals-catalog/)
- **The targets aren't derived from users.** You planted a seed, not an SLO. → [Start With the User](/autoscaling/slos-for-scaling/)
- **maxReplicas is a placeholder, not a ceiling.** Nobody has checked Oracle's session budget. → [the pool math](/autoscaling/rest-api-oracle/)
- **Nobody else knows about your claim.** The capacity ledger hasn't heard of you. → [Capacity and Governance](/autoscaling/capacity-and-governance/)

Your real homework, in order: [prerequisites](/autoscaling/prerequisites/) (all ten) → [classify](/autoscaling/classify-your-app/) → [SLO](/autoscaling/slos-for-scaling/) → [load profile](/autoscaling/load-profile/) → your archetype's reference architecture.
:::

## Where next

- **Next in the journey:** the homework list above, starting with [the full prerequisites](/autoscaling/prerequisites/).
- **The lateral jump:** want to *feel* an HPA under load before trusting this one? [Lab 10](/labs/lab-10-autoscaling/) runs the whole lifecycle on a laptop.
