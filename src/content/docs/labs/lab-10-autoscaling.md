---
title: "Lab 10: Autoscale orders-api — HPA Under Load, then an HPA on Queue Depth"
description: Add an HPA to the orders-api chart and watch it scale under fortio load, hit the fixed-capacity wall on purpose, then build the no-KEDA pipeline — redis_exporter, Prometheus, prometheus-adapter — and scale a worker on Valkey queue depth.
keywords:
  - hpa lab hands on kubernetes
  - watch hpa scale under load
  - prometheus adapter external metrics lab
  - scale on queue depth without keda
  - autoscaling tutorial k3s
  - redis exporter key size hpa
  - hpa unknown then scaling
  - pods pending insufficient memory scale up
sidebar:
  order: 12
---

Every autoscaling number on this site — targets, windows, floors, ceilings — has so far been something you *read*. This lab makes them something you *watched happen*. You'll wire an HPA into the `orders-api` chart and load it until it scales, meet the two famous failure modes (`<unknown>` and `Pending`) in a place where they're funny instead of career-limiting, then build the playbook's **adapter track** end to end — an exporter watching a Valkey list, Prometheus scraping it, prometheus-adapter serving it to the cluster's external metrics API — and scale a queue worker on the depth of that list.

This is the deployable companion to the [Autoscaling Playbook](/autoscaling/overview/). Two honest notes up front. First, the playbook's brokers (IBM MQ, RabbitMQ) live *outside* the cluster, behind firewalls and credentials; the lab's queue is the Valkey you built in Lab 9, inside it. The scaling mechanics are identical — what prod adds is the network path, the TLS, and [the broker admin conversation](/autoscaling/messaging-consumers/). Second, the playbook builds every consumer recipe both ways — KEDA, or exporter + prometheus-adapter ([the fork](/autoscaling/getting-the-metrics/#5-the-fork-adapter-or-keda)) — and this lab deliberately builds the **adapter track**, because it's the one you can't fake: five pipeline pieces you wire and verify yourself, each one a page of [Getting the Metrics](/autoscaling/getting-the-metrics/) made physical. The KEDA variant of the same worker is a supported side quest: [Event-Driven Autoscaling with KEDA](/architectures/keda-autoscaling/).

**What you'll have at the end:** the `orders-api` chart carrying a values-gated HPA (the production pattern), a before-your-eyes scale-up under fortio load and a calm scale-down after it, one deliberately provoked `Pending` pod that teaches the fixed-capacity lesson, and — Phase B — a working external-metrics pipeline: `redis_exporter` publishing a Valkey list's depth, a trimmed Lab-6-style monitoring stack scraping it, prometheus-adapter answering the external metrics API, and an `orders-worker` HPA scaling 1→4→1 as the queue fills and drains. Plus the honest boundary: the one thing this track cannot do (scale to zero) and where that feature lives (KEDA).

## Prerequisites

- **Labs 0–8 completed.** You need the cluster, the `orders` release of `charts/orders-api` (with Lab 8's preStop/grace/PDB hardening), and Lab 8's `~/k8s-labs/loadgen-job.yaml`.
- **Lab 9 for Phase B** (the Valkey primary and the `valkey-auth` Secret). Skipped it? There's a fallback aside at step 7.
- **Lab 6's monitoring stack returns in Phase B.** You tore it down at the end of Lab 6; step 6 reinstalls it, trimmed further. Having *done* Lab 6 matters more than having it running — every ServiceMonitor lesson from there is load-bearing here.
- **RAM headroom.** Phase B adds roughly 0.7–1 GiB inside the k3s VM (Prometheus + operator + adapter, with Grafana and Alertmanager off). The default 4 GiB VM handles it — Phase A's load test is over before the stack arrives.
- If you paused since a previous sitting, revive the cluster:

```bash
limactl start k3s
kubectl get nodes
```

All commands run from `~/k8s-labs/`, with `kubectl` defaulting to the `labs` namespace as configured in Lab 0.

## 1. Preflight — the prerequisites checklist, run for real

The playbook has a [ten-item no-assumptions checklist](/autoscaling/prerequisites/); your lab cluster passes the load-bearing ones out of the box, and proving that is the right first move. The cluster can measure CPU (k3s bundles metrics-server — you saw its pod in Lab 0):

```bash
kubectl top pods -l app.kubernetes.io/name=orders-api
```

```console
$ kubectl top pods -l app.kubernetes.io/name=orders-api
NAME                          CPU(cores)   MEMORY(bytes)
orders-api-7b8d4c9f66-p4k2m   4m           352Mi
orders-api-7b8d4c9f66-q9d7w   3m           348Mi
```

Real numbers, two replicas, nearly idle — good. And the pods declare requests (set in Lab 1, load-bearing now: the HPA's percentage math is a percentage *of the request*):

```bash
kubectl get deploy orders-api -o jsonpath='{.spec.template.spec.containers[0].resources}'
```

```console
$ kubectl get deploy orders-api -o jsonpath='{.spec.template.spec.containers[0].resources}'
{"limits":{"memory":"512Mi"},"requests":{"cpu":"100m","memory":"384Mi"}}
```

`cpu: 100m` is the denominator for everything Phase A does: "60% utilization" will mean *60 millicores of actual use per pod*. Probes exist (Lab 1), graceful shutdown is drilled (Lab 8), and `helm list` should show `orders` (and `valkey` if you've done Lab 9) — if any of that's missing, the earlier lab is the fix, not this one.

## 2. Teach the chart about autoscaling

Two edits, and both are *the* production pattern, not lab shortcuts.

**First, end the replicas tug-of-war before it starts.** Your chart says `replicaCount: 2`; an HPA is about to disagree. If both express an opinion, every `helm upgrade` resets the fleet to 2 and the HPA spends minutes clawing back — the classic self-inflicted outage. The fix: when autoscaling owns the count, the chart stays silent. In `charts/orders-api/templates/deployment.yaml`, wrap the existing `replicas:` line:

```yaml
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
```

**Second, the HPA template itself** — scaling config travels with the app it scales, exactly like the ServiceMonitor did in Lab 6. Create `charts/orders-api/templates/hpa.yaml`:

```yaml
{{- if .Values.autoscaling.enabled }}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "orders-api.fullname" . }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "orders-api.fullname" . }}   # same helper as the Deployment —
                                                   # a rename can never strand the HPA
  minReplicas: {{ .Values.autoscaling.minReplicas }}
  maxReplicas: {{ .Values.autoscaling.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .Values.autoscaling.targetCPU }}
  behavior:
    scaleDown:
      stabilizationWindowSeconds: {{ .Values.autoscaling.scaleDownWindow }}
      policies:
        - type: Pods
          value: 1
          periodSeconds: 30
{{- end }}
```

And the values block, at the end of `charts/orders-api/values.yaml`:

```yaml
autoscaling:
  enabled: false        # off until asked — enabling is a deliberate act
  minReplicas: 2        # matches the PDB story from Lab 8: never below the HA floor
  maxReplicas: 5        # small on purpose — you'll meet the reason in step 5
  targetCPU: 60         # scale when average CPU exceeds 60% of the 100m request
  scaleDownWindow: 60   # LAB PACING — see the caution below
```

:::caution[scaleDownWindow: 60 is for watching, not for production]
The default scale-down stabilization is 300 seconds, and for a real JVM service it should be *at least* that: a pod costs ~90 seconds to warm, so discarding one on a 60-second dip means paying warmup again on the rebound. This lab shortens it to 60s purely so you can watch a full up-and-down cycle without a coffee break. The production reasoning — and the scale-up policies a real Spring fleet also wants — is [Spring Boot Under an HPA](/autoscaling/spring-boot-scaling/).
:::

Enable it and watch the HPA wake up. Two terminals from here on: **A** watches, **B** acts. In terminal A:

```bash
kubectl get hpa -w
```

In terminal B:

```bash
helm upgrade orders charts/orders-api --reset-then-reuse-values --set autoscaling.enabled=true
```

:::note[Why not plain `--reuse-values`]
The block you just wrote lives in the **new** chart's `values.yaml`, and `--reuse-values` ignores the new chart's defaults entirely — your HPA would render with empty `minReplicas`/`maxReplicas` and the upgrade would fail validation. `--reset-then-reuse-values` (Helm ≥ 3.14) starts from the new defaults, then re-applies the `--set` history earlier labs accumulated. After this upgrade the release's stored chart knows the `autoscaling` block, so the plain `--reuse-values` in the steps below is safe again. The full precedence story: [Values and Overrides](/helm/values-and-overrides/).
:::

Terminal A, over the next ~45 seconds:

```console
$ kubectl get hpa -w
NAME         REFERENCE               TARGETS         MINPODS   MAXPODS   REPLICAS   AGE
orders-api   Deployment/orders-api   <unknown>/60%   2         5         2          8s
orders-api   Deployment/orders-api   3%/60%          2         5         2          45s
```

That `<unknown>` is worth savoring: it's the most-searched autoscaling symptom on this site, and here it's *normal* — the HPA exists but metrics-server hasn't handed it a first sample yet (~15–30s). Persisting `<unknown>` is the pathological version, and [the runbook](/troubleshooting/hpa-not-scaling/) starts from exactly this line. `3%/60%`: the loop is alive, measured CPU is 3% of requests, nothing to do.

## 3. Load until it scales

Copy Lab 8's load Job and turn it up. Create `~/k8s-labs/hpa-load-job.yaml` — a copy of `loadgen-job.yaml` with four changed args:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: hpa-load
spec:
  backoffLimit: 0
  template:
    metadata:
      labels:
        app: hpa-load
    spec:
      restartPolicy: Never
      containers:
        - name: fortio
          image: fortio/fortio:1.69.4
          args:
            - load
            - -qps=120           # up from 50: enough to push 2 pods well past 60% CPU
            - -c=16              # more connections, so traffic can spread to new pods
            - -t=420s            # 7 minutes — room for a full scale-up story
            - -keepalive=false   # THE load-bearing flag — see the note
            - -timeout=2s
            - http://orders-api.labs.svc:8080/api/orders/1001
```

:::note[Why -keepalive=false]
Lab 8 ended with this exact lesson: fortio's default keep-alive connections pin to the pods that existed at connect time, so *new* pods get no traffic. Under an HPA that's fatal to the experiment — the hot pods stay hot, the new pods idle at 0%, the average stays high, and the HPA looks insane while doing arithmetic perfectly. `-keepalive=false` makes every request a fresh connection that can land anywhere. Production clients with connection pools behave like the default — that's [Long-Lived Connections](/networking/long-lived-connections/), and it ambushes real HPAs constantly.
:::

Terminal A keeps `kubectl get hpa -w` running. Terminal B:

```bash
kubectl delete job hpa-load --ignore-not-found
kubectl apply -f hpa-load-job.yaml
kubectl wait --for=condition=ready pod -l app=hpa-load
```

Now watch terminal A tell the story:

```console
orders-api   Deployment/orders-api   3%/60%      2   5   2     3m
orders-api   Deployment/orders-api   192%/60%    2   5   2     4m
orders-api   Deployment/orders-api   192%/60%    2   5   4     4m
orders-api   Deployment/orders-api   87%/60%     2   5   4     5m
orders-api   Deployment/orders-api   87%/60%     2   5   5     5m
orders-api   Deployment/orders-api   66%/60%     2   5   5     6m
```

Read the second line with the playbook's arithmetic: 120 qps across 2 pods ≈ 190m CPU each against a 100m request = ~192%. The HPA computes `ceil(2 × 192/60) = 7`, wants 7, is capped at 5, and moves in steps. Ask it to show its work:

```bash
kubectl describe hpa orders-api
```

```console
$ kubectl describe hpa orders-api
...
Metrics:                    ( current / target )
  resource cpu on pods (as a percentage of request):  66% (66m) / 60%
Conditions:
  Type            Status  Reason            Message
  AbleToScale     True    ReadyForNewScale  recommended size matches current size
  ScalingActive   True    ValidMetricFound  the HPA was able to successfully calculate a replica count
  ScalingLimited  True    TooManyReplicas   the desired replica count is more than the maximum replica count
Events:
  Normal  SuccessfulRescale  2m    horizontal-pod-autoscaler  New size: 4; reason: cpu resource utilization above target
  Normal  SuccessfulRescale  90s   horizontal-pod-autoscaler  New size: 5; reason: cpu resource utilization above target
```

`ScalingLimited=True` at max is a **fact, not a fault**: the HPA is saying "I'd go higher if you let me." In production that line pinned for 30+ minutes is [a capacity conversation](/autoscaling/capacity-and-governance/); here it's your cue for the next drill. Confirm with `kubectl top pods -l app.kubernetes.io/name=orders-api` that all five pods are warm and roughly even — that's `-keepalive=false` earning its flag.

## 4. Hit the fixed-capacity wall on purpose

The playbook's central on-prem lesson is that `maxReplicas` is a claim on a *fixed* pool. Your pool is spectacularly fixed: one k3s VM with 4 GiB. Each `orders-api` pod *reserves* 384Mi (requests are reservations, used or not) — so raise the ceiling and let arithmetic meet reality. With the load still running, terminal B:

```bash
helm upgrade orders charts/orders-api --reuse-values --set autoscaling.maxReplicas=8
kubectl get pods -l app.kubernetes.io/name=orders-api
```

```console
$ kubectl get pods -l app.kubernetes.io/name=orders-api
NAME                          READY   STATUS    RESTARTS   AGE
orders-api-7b8d4c9f66-p4k2m   1/1     Running   0          3d
orders-api-7b8d4c9f66-q9d7w   1/1     Running   0          3d
orders-api-7b8d4c9f66-mv2ls   1/1     Running   0          6m
orders-api-7b8d4c9f66-zk8fh   1/1     Running   0          6m
orders-api-7b8d4c9f66-8xj4n   1/1     Running   0          5m
orders-api-7b8d4c9f66-w3nqp   1/1     Running   0          40s
orders-api-7b8d4c9f66-t6vhc   0/1     Pending   0          40s
```

There's the wall. Ask the stuck pod why:

```bash
kubectl describe pod -l app.kubernetes.io/name=orders-api | grep -A4 "Events:" | tail -4
```

```console
Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  40s   default-scheduler  0/1 nodes are available: 1 Insufficient memory. preemption: 0/1 nodes are available: 1 No preemption victims found for incoming pod.
```

`Insufficient memory`: the sum of requests — N × 384Mi of orders-api, plus Valkey, plus the system pods — no longer fits the node's allocatable. The exact replica where *your* wall lands depends on what else is running (if 8 somehow fit, `--set autoscaling.maxReplicas=9` — the lesson is the wall, not the number; `kubectl describe node | grep -A6 "Allocated resources"` shows the ledger). Your cluster at work does precisely this, just at a bigger number and with five other teams' pods as the neighbors — which is why the playbook makes [Σ(maxReplicas × requests) ≤ allocatable](/autoscaling/capacity-and-governance/) somebody's actual job.

Lower the ceiling back before moving on:

```bash
helm upgrade orders charts/orders-api --reuse-values --set autoscaling.maxReplicas=5
```

## 5. Feel the scale-down

When the load Job finishes (or `kubectl delete job hpa-load`), terminal A shows the other half of the loop — slower, on purpose:

```console
orders-api   Deployment/orders-api   4%/60%    2   5   5     9m
orders-api   Deployment/orders-api   4%/60%    2   5   4     10m
orders-api   Deployment/orders-api   3%/60%    2   5   3     11m
orders-api   Deployment/orders-api   3%/60%    2   5   2     11m
```

CPU collapsed instantly; replicas didn't. That's your 60-second stabilization window plus the 1-pod-per-30s policy: the HPA waits out the window, then sheds gently. Now run the thought experiment the caution box set up: at the production default of 300s, this descent wouldn't *begin* for five minutes — and that patience is the entire defense against paying JVM warmup on every traffic wobble. You've now seen every number in the [quick start](/autoscaling/quick-start/) move.

## 6. Reinstall the monitoring stack — smaller this time

Phase B scales on *work waiting* instead of *effort spent* — the correct signal for anything queue-shaped ([the catalog's verdict](/autoscaling/signals-catalog/#queue-depth--message-lag)). Without KEDA, that number travels the playbook's **adapter track**: something exports it, Prometheus collects it, prometheus-adapter serves it to the HPA. First, Prometheus itself — Lab 6's stack, minus everything this experiment doesn't need. Create `~/k8s-labs/values-monitoring-lab10.yaml`:

```yaml
# Lab 6's values-monitoring.yaml, trimmed further: this lab needs Prometheus and
# the operator — nothing else. Grafana and Alertmanager stay OFF (same lesson,
# less RAM); the control-plane scraper disables are Lab 6's, unchanged.
kubeEtcd: {enabled: false}
kubeControllerManager: {enabled: false}
kubeScheduler: {enabled: false}
kubeProxy: {enabled: false}
alertmanager: {enabled: false}
grafana: {enabled: false}
prometheus:
  prometheusSpec:
    retention: 2d
    resources:
      requests: {cpu: 200m, memory: 512Mi}
```

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  -f values-monitoring-lab10.yaml --wait --timeout 10m
```

Same release name as Lab 6 on purpose: the `release: monitoring` ServiceMonitor selector — Lab 6's silently-ignored-target lesson — transfers verbatim, and it's about to be load-bearing for scaling rather than dashboards.

## 7. Export the queue depth

Phase B's "queue" is a Valkey **list**: producers `LPUSH` jobs on, workers `BRPOP` them off — honest FIFO queueing, and depth is one `LLEN` away. But the HPA can't run `LLEN`; something must publish it as a metric. That something is **redis_exporter** with its `--check-single-keys` flag: point it at a key, and the key's length appears as the gauge `redis_key_size`. (Valkey speaks RESP — the Redis Serialization Protocol — so the exporter neither knows nor cares which server answers it.) Confirm the target exists, then create the exporter:

```bash
kubectl get pod valkey-primary-0
kubectl get svc valkey-rw
```

```console
$ kubectl get pod valkey-primary-0
NAME               READY   STATUS    RESTARTS   AGE
valkey-primary-0   1/1     Running   0          5d
$ kubectl get svc valkey-rw
NAME        TYPE        CLUSTER-IP     PORT(S)    AGE
valkey-rw   ClusterIP   10.43.118.6    6379/TCP   5d
```

:::note[Skipped Lab 9?]
Lab 3's throwaway cache works too — it's the same Valkey speaking the same protocol. Substitute in every manifest below: `valkey-rw` → `cache-valkey`, secret `valkey-auth` → `cache-auth`. Two names, nothing else changes.
:::

`~/k8s-labs/queue-exporter.yaml` — Deployment, Service, and the ServiceMonitor that makes Prometheus care:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis-exporter
spec:
  replicas: 1
  selector:
    matchLabels: {app: redis-exporter}
  template:
    metadata:
      labels: {app: redis-exporter}
    spec:
      containers:
        - name: exporter
          image: oliver006/redis_exporter:v1.66.0
          args:
            - --redis.addr=redis://valkey-rw:6379
            - --check-single-keys=orders:jobs    # THE flag: publish this key's length
          env:
            - name: REDIS_PASSWORD               # the exporter reads this env natively
              valueFrom:
                secretKeyRef: {name: valkey-auth, key: password}
          ports:
            - name: metrics
              containerPort: 9121
          resources:
            requests: {cpu: 10m, memory: 32Mi}
---
apiVersion: v1
kind: Service
metadata:
  name: redis-exporter
  labels: {app: redis-exporter}
spec:
  selector: {app: redis-exporter}
  ports:
    - name: metrics
      port: 9121
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: redis-exporter
  labels:
    release: monitoring          # Lab 6's lesson, now load-bearing for scaling:
spec:                            # omit this and NOTHING errors — the target just
  selector:                      # never appears, and your HPA reads <unknown>
    matchLabels: {app: redis-exporter}
  endpoints:
    - port: metrics
      interval: 10s              # lab pacing — production scrapes every 30s
```

Apply, then prove the number reached Prometheus — the same "prove each link" discipline as [the pipeline page](/autoscaling/getting-the-metrics/):

```bash
kubectl apply -f queue-exporter.yaml
kubectl -n monitoring port-forward svc/prometheus-operated 9090 >/dev/null &
sleep 3
curl -s 'localhost:9090/api/v1/query?query=redis_key_size' | python3 -m json.tool | grep -E '"key"|"namespace"|value' 
kill %1
```

```console
$ curl -s 'localhost:9090/api/v1/query?query=redis_key_size' | python3 -m json.tool | grep -E '"key"|"namespace"|value'
                    "key": "orders:jobs",
                    "namespace": "labs",
                "value": [
```

Depth zero (the queue is empty), but the *series exists*, labeled with the key and — load-bearing for the next step — the namespace.

## 8. Teach the HPA to see it — prometheus-adapter

Prometheus has the number; the HPA still can't see it, because the HPA speaks only the Kubernetes metrics APIs — this is exactly [the playbook's fork](/autoscaling/getting-the-metrics/#5-the-fork-adapter-or-keda), and you're about to install the adapter side of it. prometheus-adapter registers as the cluster's **external metrics API** and answers from PromQL you configure. Create `~/k8s-labs/values-adapter.yaml`:

```yaml
prometheus:
  url: http://monitoring-kube-prometheus-prometheus.monitoring.svc
  port: 9090
rules:
  default: false                 # no rule sprawl: this adapter serves exactly one metric
  external:
    - seriesQuery: 'redis_key_size{key="orders:jobs"}'
      resources:
        overrides:
          namespace: {resource: "namespace"}   # ties the metric to the labs namespace —
                                               # external metrics are namespaced queries
      name:
        as: "orders_queue_depth"               # the name the HPA will ask for
      metricsQuery: 'max(<<.Series>>{<<.LabelMatchers>>}) by (<<.GroupBy>>)'
```

```bash
helm install adapter prometheus-community/prometheus-adapter \
  --namespace monitoring -f values-adapter.yaml --wait
kubectl get apiservice v1beta1.external.metrics.k8s.io
```

```console
$ kubectl get apiservice v1beta1.external.metrics.k8s.io
NAME                              SERVICE                                 AVAILABLE   AGE
v1beta1.external.metrics.k8s.io   monitoring/adapter-prometheus-adapter   True        30s
```

:::note[One external-metrics server per cluster]
That APIService row is the exact seat KEDA would occupy — a cluster gets **one** `external.metrics.k8s.io` backend, ever. This is why the playbook treats the adapter-vs-KEDA choice as a platform decision, not a per-team one: whoever installs first decides for everyone. On your lab cluster, you're the platform team, and you just decided.
:::

Now ask the API directly — the same call the HPA is about to make every 15 seconds:

```bash
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1/namespaces/labs/orders_queue_depth" | python3 -m json.tool
```

```console
$ kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1/namespaces/labs/orders_queue_depth" | python3 -m json.tool
{
    "kind": "ExternalMetricValueList",
    "apiVersion": "external.metrics.k8s.io/v1beta1",
    "items": [
        {
            "metricName": "orders_queue_depth",
            "metricLabels": {},
            "value": "0"
        }
    ]
}
```

Every link is now proven: Valkey → exporter → Prometheus → adapter → the Kubernetes API. The pipeline is real; nothing consumes it yet.

## 9. A worker that drains the queue

No new images: the `valkey/valkey:8` image already on your node contains `valkey-cli`, which is all a demonstration worker needs. Create `~/k8s-labs/queue-worker.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-worker
spec:
  replicas: 1                  # a starting opinion — the HPA takes ownership in step 10
  selector:
    matchLabels:
      app: orders-worker
  template:
    metadata:
      labels:
        app: orders-worker
    spec:
      containers:
        - name: worker
          image: valkey/valkey:8
          command: ["sh", "-c"]
          args:
            - |
              echo "worker starting"
              while true; do
                job=$(valkey-cli -h valkey-rw -a "$VALKEY_PASSWORD" --no-auth-warning BRPOP orders:jobs 5)
                if [ -n "$job" ]; then
                  sleep 1        # the sleep IS the simulated work — 1 job/second/pod,
                fi               # slow enough that a backlog visibly needs more pods
              done
          env:
            - name: VALKEY_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: valkey-auth
                  key: password
          resources:
            requests: {cpu: 50m, memory: 32Mi}   # honest, tiny — 4 workers fit easily
```

```bash
kubectl apply -f queue-worker.yaml
kubectl logs -l app=orders-worker --tail=1
```

```console
$ kubectl logs -l app=orders-worker --tail=1
worker starting
```

`BRPOP … 5` blocks up to five seconds waiting for a job, then loops — an idle worker costs almost nothing and reacts instantly. It's a five-line stand-in for `dispatch-worker`'s `@JmsListener`, and every scaling behavior from here on transfers.

## 10. The HPA — external metric, same controller

Create `~/k8s-labs/queue-hpa.yaml`:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: orders-worker
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: orders-worker
  minReplicas: 1                 # the adapter track's hard floor: an HPA cannot scale
                                 # to zero — that trick is KEDA's alone. One idle
                                 # worker is this track's standing cost, priced in.
  maxReplicas: 4
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 60   # lab pacing, same as Phase A
      policies:
        - type: Pods
          value: 1
          periodSeconds: 30
  metrics:
    - type: External
      external:
        metric:
          name: orders_queue_depth     # the name the adapter serves — step 8's `as:`
        target:
          type: AverageValue
          averageValue: "5"    # target ~5 waiting jobs per worker. AverageValue on an
                               # External metric means the HPA divides the TOTAL by this:
                               # 200 jobs → wants 40 → capped at 4. The playbook derives
                               # this number from a freshness SLO; the lab picks it to
                               # make the arithmetic visible.
```

```bash
kubectl apply -f queue-hpa.yaml
kubectl get hpa
```

```console
$ kubectl get hpa
NAME            REFERENCE                  TARGETS       MINPODS   MAXPODS   REPLICAS   AGE
orders-api      Deployment/orders-api      3%/60%        2         5         2          40m
orders-worker   Deployment/orders-worker   0/5 (avg)     1         4         1          20s
```

Stop and appreciate that output: **two HPAs, same kind of object, different pipes.** Phase A's rides `metrics.k8s.io` (metrics-server, bundled with k3s); this one rides `external.metrics.k8s.io` (the adapter you installed). The controller doing the arithmetic never changed — only the source of its number did. That's the whole adapter track, and most of what KEDA would have done for you invisibly.

## 11. Produce a backlog, watch the whole arc

Create `~/k8s-labs/queue-producer-job.yaml`:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: queue-producer
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: producer
          image: valkey/valkey:8
          command: ["sh", "-c"]
          args:
            - |
              for i in $(seq 1 200); do
                valkey-cli -h valkey-rw -a "$VALKEY_PASSWORD" --no-auth-warning \
                  LPUSH orders:jobs "job-$i" > /dev/null
              done
              echo "pushed 200 jobs"
          env:
            - name: VALKEY_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: valkey-auth
                  key: password
```

Terminal A — watch the queue depth itself:

```bash
watch -n2 "kubectl exec valkey-primary-0 -- sh -c 'valkey-cli -a \"\$VALKEY_PASSWORD\" --no-auth-warning LLEN orders:jobs'"
```

Terminal B — fire, then watch the HPA:

```bash
kubectl apply -f queue-producer-job.yaml
kubectl get hpa orders-worker -w
```

The arc, over the next ~4 minutes:

```console
orders-worker   Deployment/orders-worker   0/5 (avg)     1   4   1
orders-worker   Deployment/orders-worker   198/5 (avg)   1   4   1     ← the signal lands
orders-worker   Deployment/orders-worker   198/5 (avg)   1   4   4     ← wants 40, capped at 4
orders-worker   Deployment/orders-worker   64/5 (avg)    1   4   4     ← draining at ~4 jobs/s
orders-worker   Deployment/orders-worker   0/5 (avg)     1   4   4
orders-worker   Deployment/orders-worker   0/5 (avg)     1   4   3     ← 60s window, then
orders-worker   Deployment/orders-worker   0/5 (avg)     1   4   2        1 pod per 30s
orders-worker   Deployment/orders-worker   0/5 (avg)     1   4   1     ← …and it stops at ONE
```

Two things to notice while it runs. First, the lag between `LPUSH` and the first rescale — count the hops: producer → exporter's next scrape (≤10 s) → Prometheus → adapter → the HPA's next 15 s tick. Half a minute of honest pipeline latency, and every hop is one you built; the playbook budgets [exactly this way](/autoscaling/dynatrace-signals/) for longer pipes. Second, the ending:

:::note[The floor is 1 — and that's the track, not a bug]
The empty-queue steady state keeps one warm worker forever. KEDA's 0↔1 activation is the single capability this pipeline cannot reproduce — the HPA's `minReplicas` minimum is 1. For `orders-worker` at 50m/32Mi that's pocket change; for a fleet of night-idle consumers it's the line item that [justifies the KEDA ask](/autoscaling/messaging-consumers/#scale-to-zero-honestly). Everything else you watched — trigger math, capping, stabilization — is mechanism-independent.
:::

## 12. Break it, fix it

Lab 5 tradition: cause the failure now, so you recognize it later. Phase A met `<unknown>` as a newborn HPA's 30-second stutter; here's its pathological adult form. Kill the pipeline at its first link:

```bash
kubectl scale deploy redis-exporter --replicas=0
sleep 60
kubectl get hpa orders-worker
```

```console
$ kubectl get hpa orders-worker
NAME            REFERENCE                  TARGETS           MINPODS   MAXPODS   REPLICAS   AGE
orders-worker   Deployment/orders-worker   <unknown>/5 (avg)   1       4         1          25m
```

Ask for the diagnosis:

```bash
kubectl describe hpa orders-worker | grep -A5 "Conditions:"
```

```console
Conditions:
  Type            Status  Reason                   Message
  ----            ------  ------                   -------
  AbleToScale     True    ReadyForNewScale         recommended size matches current size
  ScalingActive   False   FailedGetExternalMetric  the HPA was unable to compute the replica count: unable to get external metric labs/orders_queue_depth/nil: no metrics returned from external metrics API
```

`ScalingActive=False` — the mechanism-neutral "I am blind" condition, and the exact line [the playbook's pipeline alerts](/autoscaling/getting-the-metrics/#pipeline-health--alert-on-the-pipe-itself) watch for. Note what *didn't* happen: nothing got killed. The worker keeps draining; only the *scaling decisions* stopped, frozen at the current count. That's the same failure posture KEDA has — the difference is that KEDA offers a `fallback` replica block for this moment, while the adapter track's answer is the alert plus the fix. Repair and confirm:

```bash
kubectl scale deploy redis-exporter --replicas=1
sleep 30
kubectl get hpa orders-worker
```

```console
$ kubectl get hpa orders-worker
NAME            REFERENCE                  TARGETS     MINPODS   MAXPODS   REPLICAS   AGE
orders-worker   Deployment/orders-worker   0/5 (avg)   1         4         1          27m
```

## 13. Teardown

Phase B first — consumer, pipeline, then the stack:

```bash
kubectl delete -f queue-hpa.yaml -f queue-worker.yaml -f queue-exporter.yaml
kubectl delete job queue-producer --ignore-not-found
kubectl exec valkey-primary-0 -- sh -c 'valkey-cli -a "$VALKEY_PASSWORD" --no-auth-warning DEL orders:jobs'
helm uninstall adapter -n monitoring
helm uninstall monitoring -n monitoring
kubectl get crd | grep monitoring.coreos.com
```

```console
$ kubectl get crd | grep monitoring.coreos.com
alertmanagers.monitoring.coreos.com          2026-07-12T15:20:41Z
prometheuses.monitoring.coreos.com           2026-07-12T15:20:41Z
prometheusrules.monitoring.coreos.com        2026-07-12T15:20:41Z
servicemonitors.monitoring.coreos.com        2026-07-12T15:20:41Z
...
```

Lab 6's lesson, replayed: **`helm uninstall` leaves CRDs behind**, deliberately — deleting a CRD deletes every object of that type cluster-wide, so Helm refuses to decide that for you. Finish the job yourself, then the namespace:

```bash
kubectl delete crd $(kubectl get crd -o name | grep monitoring.coreos.com | cut -d/ -f2)
kubectl delete namespace monitoring
```

Phase A's HPA you *keep* — it's chart-managed now, so it turns off like anything else:

```bash
helm upgrade orders charts/orders-api --reuse-values --set autoscaling.enabled=false
kubectl get deploy orders-api
```

```console
$ kubectl get deploy orders-api
NAME         READY   UP-TO-DATE   AVAILABLE   AGE
orders-api   2/2     2            2           3d
```

Replicas snap back to the chart's `replicaCount: 2` — the `{{- if not }}` guard re-rendering, which is exactly why it exists. The HPA template and values block stay in your chart, off, one `--set` from returning. Delete `hpa-load-job.yaml`'s Job if it lingers (`kubectl delete job hpa-load --ignore-not-found`), and your cluster is back to its Lab 9 state.

## Where you are now

Your chart gained the two production autoscaling patterns — the gated `replicas:` and the values-driven HPA — and you've *watched* every abstract number act: a target trigger scaling, `ScalingLimited` at the ceiling, a `Pending` pod at the capacity wall, a stabilization window pacing the descent, an external-metrics pipeline built link by link and broken on purpose, and the floor-of-one that marks the adapter track's honest boundary.

What the lab deliberately left out is the playbook's actual substance: this lab scaled on CPU and list length because the lab has no users — production starts from **what you promised users** ([the SLO](/autoscaling/slos-for-scaling/)), chooses **the signal that predicts it** ([the catalog](/autoscaling/signals-catalog/)), builds **the pipeline that delivers it** ([getting the metrics](/autoscaling/getting-the-metrics/) — you now know its adapter track by hand), respects **the ceilings your dependencies impose** ([Oracle](/autoscaling/rest-api-oracle/), [the brokers](/autoscaling/messaging-consumers/)), and answers to **a capacity ledger** ([governance](/autoscaling/capacity-and-governance/)). The knobs are the same ones you just turned. The numbers, in production, are earned.

And the other track: the same worker, scaled by KEDA instead — operator, ScaledObject, TriggerAuthentication, scale-to-zero — is [Event-Driven Autoscaling with KEDA](/architectures/keda-autoscaling/). After this lab it will read as "the pipeline you built, with fewer visible pieces and one extra trick."
