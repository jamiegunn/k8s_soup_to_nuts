---
title: "Lab 10: Autoscale orders-api — HPA Under Load, then KEDA on a Queue"
description: Add an HPA to the orders-api chart and watch it scale under fortio load, hit the fixed-capacity wall on purpose, then install KEDA and scale a worker on Valkey queue depth — including to zero.
keywords:
  - hpa lab hands on kubernetes
  - watch hpa scale under load
  - keda lab redis list scaler
  - autoscaling tutorial k3s
  - scaledobject triggerauthentication example
  - hpa unknown then scaling
  - scale to zero keda demo
  - pods pending insufficient memory scale up
sidebar:
  order: 12
---

Every autoscaling number on this site — targets, windows, floors, ceilings — has so far been something you *read*. This lab makes them something you *watched happen*. You'll wire an HPA into the `orders-api` chart and load it until it scales, meet the two famous failure modes (`<unknown>` and `Pending`) in a place where they're funny instead of career-limiting, then install KEDA and scale a queue worker on the depth of a Valkey list — from zero, and back to zero.

This is the deployable companion to the [Autoscaling Playbook](/autoscaling/overview/). One honest difference from production, named up front: the playbook's brokers (IBM MQ, RabbitMQ) live *outside* the cluster, behind firewalls and credentials; the lab's queue is the Valkey you built in Lab 9, inside it. The scaling mechanics are identical — what prod adds is the network path, the TLS, and [the broker admin conversation](/autoscaling/messaging-consumers/).

**What you'll have at the end:** the `orders-api` chart carrying a values-gated HPA (the production pattern), a before-your-eyes scale-up under fortio load and a calm scale-down after it, one deliberately provoked `Pending` pod that teaches the fixed-capacity lesson, KEDA 2.20.1 installed and understood (it *feeds* an HPA, it doesn't replace one), and an `orders-worker` that scales 0→4→0 as a job queue fills and drains.

## Prerequisites

- **Labs 0–8 completed.** You need the cluster, the `orders` release of `charts/orders-api` (with Lab 8's preStop/grace/PDB hardening), and Lab 8's `~/k8s-labs/loadgen-job.yaml`.
- **Lab 9 for Phase B** (the Valkey primary and the `valkey-auth` Secret). Skipped it? There's a fallback aside at step 7.
- Lab 6's monitoring stack is **not** needed — you tore it down, and this lab deliberately runs on what k3s bundles. The metrics-pipeline story the lab therefore skips is [Getting the Metrics](/autoscaling/getting-the-metrics/).
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
helm upgrade orders charts/orders-api --reuse-values --set autoscaling.enabled=true
```

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

## 6. Install KEDA

Phase B: scaling on *work waiting* instead of *effort spent* — the correct signal for anything queue-shaped. KEDA is the standard machinery for it:

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update
helm install keda kedacore/keda --namespace keda --create-namespace --version 2.20.1
```

The version pin matches the [playbook's section baseline](/autoscaling/dynatrace-signals/) — one KEDA everywhere the docs speak, no split-brain. (The Redis Lists scaler you're about to use is years older than 2.20; the pin is for consistency, not necessity.) First install pulls three images from ghcr.io — the pods sit in `ContainerCreating` for the duration, same as fortio did in Lab 8:

```bash
kubectl get pods -n keda
```

```console
$ kubectl get pods -n keda
NAME                                              READY   STATUS    RESTARTS   AGE
keda-operator-7c4b9b8f6d-x2m4k                    1/1     Running   0          2m
keda-operator-metrics-apiserver-6d8f7c9b4-p8qwl   1/1     Running   0          2m
keda-admission-webhooks-5f9b6c8d7-k4j2n           1/1     Running   0          2m
```

And the punchline of the architecture, verifiable in one command — KEDA registers itself as the cluster's **external metrics API**:

```bash
kubectl get apiservice v1beta1.external.metrics.k8s.io
```

```console
$ kubectl get apiservice v1beta1.external.metrics.k8s.io
NAME                                   SERVICE                                     AVAILABLE   AGE
v1beta1.external.metrics.k8s.io        keda/keda-operator-metrics-apiserver        True        2m
```

:::note[Two metrics APIs, no conflict]
Phase A's HPA reads `metrics.k8s.io` (served by metrics-server); KEDA serves `external.metrics.k8s.io`. Different APIs, different servers, coexisting happily — but a cluster only gets **one** external-metrics server, which is why KEDA is a platform-level install in production, [asked for, not applied](/autoscaling/prerequisites/#7-youre-allowed-to-create-the-objects).
:::

## 7. Point at Lab 9's Valkey

Phase B's "queue" is a Valkey **list**: producers `LPUSH` jobs on, workers `BRPOP` them off — honest FIFO queueing, and depth is one `LLEN` away. Confirm the target exists:

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

## 8. A worker that drains the queue

No new images: the `valkey/valkey:8` image already on your node contains `valkey-cli`, which is all a demonstration worker needs. Create `~/k8s-labs/queue-worker.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-worker
spec:
  replicas: 1                  # a starting opinion — KEDA takes ownership in step 9
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

## 9. The ScaledObject — and where the HPA went

Create `~/k8s-labs/queue-scaler.yaml`:

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: orders-worker-valkey
spec:
  secretTargetRef:
    - parameter: password        # the redis scaler's auth parameter name
      name: valkey-auth          # Lab 9's Secret (cache-auth if you took the fallback)
      key: password
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: orders-worker
spec:
  scaleTargetRef:
    name: orders-worker
  minReplicaCount: 0             # scale to ZERO when the queue is empty — the feature
                                 # a plain HPA cannot give you
  maxReplicaCount: 4
  pollingInterval: 10            # check depth every 10s (default 30 — lab pacing)
  cooldownPeriod: 60             # quiet time before the last pod goes (default 300 —
                                 # lab pacing; prod earns its number from the SLO)
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 60   # lab pacing for the 4→1 descent, same as Phase A
  triggers:
    - type: redis                # Valkey speaks RESP — the redis scaler neither knows
      metadata:                  # nor cares which server answers it
        address: valkey-rw.labs.svc.cluster.local:6379
        listName: orders:jobs
        listLength: "5"          # target ~5 waiting jobs per worker — the playbook derives
                                 # this number from a freshness SLO; here it's chosen to
                                 # make the math visible: 200 jobs → wants 40 → capped at 4
      authenticationRef:
        name: orders-worker-valkey
```

```bash
kubectl apply -f queue-scaler.yaml
kubectl get scaledobject
```

```console
$ kubectl get scaledobject
NAME            SCALETARGETNAME   MIN   MAX   READY   ACTIVE   FALLBACK   AGE
orders-worker   orders-worker     0     4     True    False    False      15s
```

`READY True` — KEDA can reach Valkey and authenticate. `ACTIVE False` — the queue is empty, so the workload counts as idle. Now the two punchlines. First:

```bash
kubectl get hpa
```

```console
$ kubectl get hpa
NAME                     REFERENCE               TARGETS              MINPODS   MAXPODS   REPLICAS   AGE
keda-hpa-orders-worker   Deployment/orders-worker   <unknown>/5 (avg)  1         4         1          30s
orders-api               Deployment/orders-api      3%/60%             2         5         2          25m
```

**KEDA didn't replace the HPA — it built one.** `keda-hpa-orders-worker` is a real HorizontalPodAutoscaler that KEDA manages, feeding it queue depth through that external metrics API from step 6. Everything Phase A taught about HPAs still applies; KEDA adds the signal and the zero. ([The full architecture](/architectures/keda-autoscaling/).) Second, within about a minute:

```bash
kubectl get pods -l app=orders-worker
```

```console
$ kubectl get pods -l app=orders-worker
No resources found in labs namespace.
```

The queue is empty, so the worker is *gone* — scale-to-zero happened before any scale-up did. The `replicas: 1` you deployed was an opinion; KEDA now owns the count, and the correct count for an empty queue is zero.

## 10. Produce a backlog, watch the whole arc

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
watch -n2 'kubectl exec valkey-primary-0 -- valkey-cli -a labs-valkey-pw --no-auth-warning LLEN orders:jobs'
```

Terminal B — fire, then watch the scaling objects:

```bash
kubectl apply -f queue-producer-job.yaml
kubectl get scaledobject,hpa,pods -l app=orders-worker -w
```

The arc, over the next ~4 minutes:

```console
NAME            ...   READY   ACTIVE
orders-worker   ...   True    True          ← depth crossed activation: the workload wakes

NAME                          READY   STATUS
orders-worker-6f9c8b7d4-q2w8x   1/1   Running       ← 0→1
orders-worker-6f9c8b7d4-m4k7l   1/1   Running       ← the HPA does the rest of the math:
orders-worker-6f9c8b7d4-z8n3p   1/1   Running          200 jobs ÷ 5 per pod = wants 40,
orders-worker-6f9c8b7d4-c5v9t   1/1   Running          capped at 4
```

Terminal A's `LLEN` melts at ~4 jobs/second (four workers, one job each per second) — 200 jobs gone in under a minute. Then the descent: depth 0 → `ACTIVE False` → the 60s stabilization sheds 4→1 → the 60s `cooldownPeriod` takes the last pod 1→0.

:::note[The two-stage scale-in people always miss]
4→1 and 1→0 are governed by **different knobs**. The descent *toward* one pod is the KEDA-managed HPA's ordinary `scaleDown` stabilization — Phase A's mechanism. The final step *to zero* is KEDA's own `cooldownPeriod`, because zero isn't an HPA concept at all (KEDA handles 0↔1 itself, then hands 1↔max to the HPA). When a production ScaledObject "won't scale to zero," check `cooldownPeriod`; when it "sheds too fast from max," check the HPA behavior — two knobs, two complaints, [one page that untangles them](/architectures/keda-autoscaling/).
:::

## 11. Break it, fix it

Lab 5 tradition: cause the failure now, so you recognize it later. Sabotage the TriggerAuthentication — point it at a key that doesn't exist:

```bash
kubectl patch triggerauthentication orders-worker-valkey --type=json \
  -p='[{"op":"replace","path":"/spec/secretTargetRef/0/key","value":"passwrod"}]'
kubectl get scaledobject
```

```console
$ kubectl get scaledobject
NAME            SCALETARGETNAME   MIN   MAX   READY   ACTIVE   FALLBACK   AGE
orders-worker   orders-worker     0     4     False   False    False      12m
```

`READY False`. The details are in the events:

```bash
kubectl describe scaledobject orders-worker | tail -4
```

```console
Events:
  Type     Reason              Age   From           Message
  ----     ------              ----  ----           -------
  Warning  KEDAScalerFailed    30s   keda-operator  error resolving auth params: key 'passwrod' not found in secret 'valkey-auth'
```

Note what *didn't* happen: nothing got killed. Existing workers (if any were running) keep draining; only the *scaling decisions* stop — frozen at the current count, blind. That's KEDA's default failure posture, and production hardens it with a `fallback` replica count for exactly this moment ([the KEDA page's treatment](/architectures/keda-autoscaling/)). Repair and confirm:

```bash
kubectl patch triggerauthentication orders-worker-valkey --type=json \
  -p='[{"op":"replace","path":"/spec/secretTargetRef/0/key","value":"password"}]'
kubectl get scaledobject
```

```console
$ kubectl get scaledobject
NAME            SCALETARGETNAME   MIN   MAX   READY   ACTIVE   FALLBACK   AGE
orders-worker   orders-worker     0     4     True    False    False      13m
```

## 12. Teardown

Phase B first — the worker, the scaler, the producer, then KEDA itself:

```bash
kubectl delete -f queue-scaler.yaml -f queue-worker.yaml
kubectl delete job queue-producer --ignore-not-found
kubectl exec valkey-primary-0 -- valkey-cli -a labs-valkey-pw --no-auth-warning DEL orders:jobs
helm uninstall keda -n keda
kubectl get crd | grep keda.sh
```

```console
$ kubectl get crd | grep keda.sh
clustertriggerauthentications.keda.sh    2026-07-09T14:02:11Z
scaledjobs.keda.sh                       2026-07-09T14:02:11Z
scaledobjects.keda.sh                    2026-07-09T14:02:11Z
triggerauthentications.keda.sh           2026-07-09T14:02:11Z
```

Lab 6's lesson, replayed: **`helm uninstall` leaves CRDs behind**, deliberately — deleting a CRD deletes every object of that type cluster-wide, so Helm refuses to decide that for you. Finish the job yourself, then the namespace:

```bash
kubectl delete crd $(kubectl get crd -o name | grep keda.sh | cut -d/ -f2)
kubectl delete namespace keda
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

Your chart gained the two production autoscaling patterns — the gated `replicas:` and the values-driven HPA — and you've *watched* every abstract number act: a target trigger scaling, `ScalingLimited` at the ceiling, a `Pending` pod at the capacity wall, a stabilization window pacing the descent, scale-to-zero, and a broken scaler failing *safe* rather than failing *loud*.

What the lab deliberately left out is the playbook's actual substance: this lab scaled on CPU and list length because the lab has no users — production starts from **what you promised users** ([the SLO](/autoscaling/slos-for-scaling/)), chooses **the signal that predicts it** ([the catalog](/autoscaling/signals-catalog/)), builds **the pipeline that delivers it** ([getting the metrics](/autoscaling/getting-the-metrics/)), respects **the ceilings your dependencies impose** ([Oracle](/autoscaling/rest-api-oracle/), [the brokers](/autoscaling/messaging-consumers/)), and answers to **a capacity ledger** ([governance](/autoscaling/capacity-and-governance/)). The knobs are the same ones you just turned. The numbers, in production, are earned.
