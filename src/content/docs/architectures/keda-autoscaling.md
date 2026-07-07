---
title: "Event-Driven Autoscaling with KEDA"
description: Scaling a queue consumer on backlog instead of CPU — a complete KEDA build with Kafka lag scaling, scale-to-zero, RabbitMQ and IBM MQ variants, fallback, and drain-safe scale-in.
keywords:
  - ScaledObject ScaledJob
  - scale to zero queue consumer
  - Kafka consumer lag scaling
  - lagThreshold activationLagThreshold
  - TriggerAuthentication scaler credentials
  - keda-hpa flapping duplicate HPA
  - RabbitMQ queue length trigger
  - IBM MQ queue depth trigger
  - fallback replicas broker unreachable
  - partition ceiling max replicas
  - drain-safe scale-in idempotent consumer
sidebar:
  order: 11
---

The [HPA baseline](/workloads/autoscaling/) scales on CPU, and for request/response services that works because CPU tracks load almost instantly. For a queue consumer it fails in the worst possible way: **CPU is a lagging proxy for backlog**. A consumer that is starved — blocked on a slow downstream, rebalancing, or simply outnumbered by producers — shows *low* CPU while the queue explodes. The HPA looks at 30% utilization, concludes everything is fine, and scales you *down* into the incident. The signal you need is the queue itself: lag, depth, oldest-message age. That is what KEDA gives you.

This is the build article that ties the site's messaging stack ([Message Queues on Kubernetes](/stateful/message-queues/)) to its autoscaling story: one consumer Deployment, scaled on Kafka consumer-group lag as the primary path, with RabbitMQ and IBM MQ scaler variants as drop-in alternates.

## How KEDA actually works (and the HPA it owns)

KEDA is two things, both **platform-installed** cluster-wide (operators and [CRDs](/controllers/crds-explained/) are the platform team's side of the [contract](/operations/working-with-platform-team/); you own the namespaced CRs):

1. **The operator** watches your `ScaledObject`/`ScaledJob` CRs and polls the broker on your behalf.
2. **The metrics adapter** registers as an external-metrics API server, so the ordinary HPA controller can consume queue metrics.

The part that surprises everyone: **a ScaledObject creates and owns an HPA.** When you apply the ScaledObject below, KEDA generates `keda-hpa-order-events-consumer` in your namespace. For any replica count from `minReplicaCount` up to `maxReplicaCount`, scaling is done by that HPA using KEDA's external metrics — standard HPA math, standard behavior policies. **Do not also define your own HPA** for the same Deployment: two controllers writing `replicas` produces flapping that looks like a KEDA bug and isn't. If you had a manual HPA before adopting KEDA, delete it in the same change.

The one thing the HPA cannot do is scale to zero — HPAs bottom out at 1. Scale-to-zero (and zero-to-one) is **KEDA's alone**, which is why there are two thresholds and people persistently confuse them:

- **`activationLagThreshold`** — the 0↔1 knob. Above it, KEDA wakes the workload from zero; at or below it, KEDA is allowed to park it at zero. KEDA decides this directly.
- **`lagThreshold`** — the 1↔N knob. The *target lag per replica* that the generated HPA aims for once at least one pod exists.

Miss the two-knob model and you get workloads that never wake (activation set too high) or never sleep (assuming `lagThreshold: 100` means "sleep below 100" — it doesn't).

Authoritative reference for every scaler and field: [keda.sh/docs](https://keda.sh/docs/).

## The build: order-events consumer

The patient is **order-events-consumer**: a worker that reads the `order-events` topic from the Kafka cluster built in [Kafka on Strimzi](/architectures/kafka-strimzi/), processes each message in ~200ms typical / 30s worst case (a payment-provider call), and writes to Postgres. Traffic is bursty — quiet overnight, storms at campaign time — which is exactly the shape that justifies scale-to-zero. The [RabbitMQ](/architectures/rabbitmq/) and [IBM MQ](/architectures/ibm-mq/) variants swap only the trigger and auth; everything else stands.

```text
 producers ──▶ Kafka: order-events (12 partitions)
                     │ consumer group: order-events-consumer
                     ▼
   Deployment: order-events-consumer (0..12 replicas)
                     ▲ replicas
   KEDA operator ────┘ (owns keda-hpa-order-events-consumer)
        │ polls lag every 15s
        └──▶ bootstrap: orders-kafka-kafka-bootstrap:9093 (SASL/TLS)
```

## 1. The consumer Deployment

A queue worker serves no HTTP, so the usual `httpGet` probes don't apply. The pattern for [health checks](/workloads/health-checks/) on a non-HTTP worker: the poll loop touches a heartbeat file every iteration; liveness asserts the file is fresh. That catches the real failure — a wedged consumer that holds its partition assignments while processing nothing — which is invisible to CPU and to any port check.

Two other decisions in this manifest carry the build. Resources are measured, not guessed — the method is [Requests & Limits Knobs](/tuning/requests-limits-knobs/), and note the deliberately absent CPU limit: throttling a consumer *manufactures* the very lag you scale on. And `terminationGracePeriodSeconds` is the scale-in correctness knob: sized to worst-case message time plus offset-commit slack, it is the same drain discipline as [long-lived connections](/networking/long-lived-connections/), with "in-flight message" standing in for "open connection".

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-events-consumer
  namespace: orders
  labels:
    app: order-events-consumer
spec:
  # No replicas field: KEDA owns this number. Setting it just gets
  # overwritten on the next reconcile and confuses your GitOps diff.
  selector:
    matchLabels:
      app: order-events-consumer
  template:
    metadata:
      labels:
        app: order-events-consumer
    spec:
      # Scale-IN correctness: on SIGTERM the consumer stops polling,
      # finishes in-flight messages, commits offsets, leaves the group.
      # Budget = worst-case message (30s) + commit/leave slack.
      # Same drain discipline as long-lived HTTP connections:
      # /networking/long-lived-connections/
      terminationGracePeriodSeconds: 45
      containers:
        - name: consumer
          image: registry.example.com/orders/order-events-consumer:1.4.2
          env:
            - name: KAFKA_BOOTSTRAP
              value: orders-kafka-kafka-bootstrap.kafka.svc:9093
            - name: KAFKA_GROUP_ID
              value: order-events-consumer   # must match the ScaledObject
          # Measured under load, method per /tuning/requests-limits-knobs/:
          # requests from steady-state p95, memory limit from peak batch,
          # no CPU limit (throttling a consumer manufactures lag).
          resources:
            requests:
              cpu: 250m
              memory: 384Mi
            limits:
              memory: 512Mi
          livenessProbe:
            exec:
              # Poll loop touches this file each iteration; stale file
              # (> 120s) means a wedged consumer squatting on partitions.
              command: ["/bin/sh", "-c",
                        "test $(( $(date +%s) - $(stat -c %Y /tmp/heartbeat) )) -lt 120"]
            initialDelaySeconds: 30
            periodSeconds: 30
            failureThreshold: 2
          readinessProbe:
            exec:
              command: ["/bin/sh", "-c", "test -f /tmp/ready"]  # set after group join
            periodSeconds: 10
```

:::caution[Scale-in is a correctness event, not just a cost one]
Every scale-in kills a pod mid-batch. If your handler isn't idempotent *and* the consumer doesn't drain on SIGTERM within the grace period, scale-in loses or duplicates messages — and KEDA will scale in far more often than a deploy would. Fix the shutdown path before turning autoscaling on.
:::

## 2. TriggerAuthentication — the auth wiring people get wrong

KEDA's operator connects to the broker itself; your pod's env vars and mounted certs are invisible to it. Credentials for the *scaler* come from a `TriggerAuthentication` referencing a Secret in **your** namespace. The classic failure: the app consumes fine, the ScaledObject sits at `Ready: False`, and the fix is realizing there are two Kafka clients — yours and KEDA's — each needing creds.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: keda-kafka-creds
  namespace: orders
type: Opaque
stringData:
  sasl: scram_sha512
  username: order-events-scaler         # KafkaUser from the Strimzi build
  password: "<from the KafkaUser secret>"
  tls: enable
  ca: |
    -----BEGIN CERTIFICATE-----
    <cluster CA from orders-kafka-cluster-ca-cert>
    -----END CERTIFICATE-----
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-scaler-auth
  namespace: orders
spec:
  secretTargetRef:
    - parameter: sasl
      name: keda-kafka-creds
      key: sasl
    - parameter: username
      name: keda-kafka-creds
      key: username
    - parameter: password
      name: keda-kafka-creds
      key: password
    - parameter: tls
      name: keda-kafka-creds
      key: tls
    - parameter: ca
      name: keda-kafka-creds
      key: ca
```

The scaler user needs *read* on the topic and *describe* on the consumer group (it reads committed offsets; it never consumes). Grant it via a `KafkaUser` ACL in the [Strimzi build](/architectures/kafka-strimzi/), not by reusing the app's credentials — separate creds mean an app-side credential rotation can't silently break scaling, and vice versa.

## 3. The ScaledObject — every knob justified

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-events-consumer
  namespace: orders
spec:
  scaleTargetRef:
    name: order-events-consumer        # the Deployment above
  # --- floor and ceiling ---
  minReplicaCount: 0    # scale-to-zero: see the honesty box below
  maxReplicaCount: 12   # = partition count AND what Postgres tolerates;
                        # take the LOWER of the two ceilings
  # --- timing ---
  pollingInterval: 15   # seconds between broker polls (default 30);
                        # this bounds your zero→one wake-up latency
  cooldownPeriod: 300   # seconds of inactivity before the LAST replica is
                        # removed (the N→0 step only; 1→N scale-in is
                        # governed by HPA behavior below)
  # --- when KEDA can't see the broker ---
  fallback:
    failureThreshold: 3   # consecutive failed polls before engaging
    replicas: 4           # park here, blind but consuming.
                          # 0 = "fail closed", cheap but an outage if the
                          # break is network-only. 4 = "fail open".
                          # For revenue-bearing queues, fail open.
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:            # standard HPA behavior, applied to the HPA
        scaleDown:         # KEDA generates — gentle scale-in beats
          stabilizationWindowSeconds: 300   # flapping on bursty topics
          policies:
            - type: Pods
              value: 2
              periodSeconds: 60   # shed at most 2 pods/minute
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: orders-kafka-kafka-bootstrap.kafka.svc:9093
        consumerGroup: order-events-consumer   # MUST match the app's group.id
        topic: order-events
        # Target lag PER REPLICA, not total. desired ≈ ceil(totalLag / 100):
        # lag 1200 → 12 pods. Derive it: one pod drains ~50 msg/s, so 100
        # means "catch up within ~2s of work per pod". Too low → pinned at
        # max on every blip; too high → backlog you never feel.
        lagThreshold: "100"
        # The 0↔1 knob: wake when total lag exceeds 10; eligible to sleep
        # at or below it. Small but nonzero, so one stray heartbeat message
        # doesn't wake the fleet.
        activationLagThreshold: "10"
      authenticationRef:
        name: kafka-scaler-auth
```

:::danger[The partition ceiling]
Kafka assigns each partition to at most one consumer in a group. With 12 partitions, replica 13 joins the group, receives nothing, and burns its full resource request doing so — and `lagThreshold` math will happily ask for it. **Cap `maxReplicaCount` at the partition count.** If you need more than 12 consumers' throughput, the fix is repartitioning in the [Strimzi build](/architectures/kafka-strimzi/), not a bigger ceiling here. (KEDA's kafka scaler also has `limitToPartitionsWithLag` to refine this, but the ceiling is still yours to set.)
:::

:::note[minReplicaCount 0 vs 1 — the honest trade]
Zero is not free. The next message pays: pollingInterval (≤15s) + pod schedule and image pull + app start + consumer-group join and rebalance — 30–90s of activation latency in practice, and *every* wake triggers a rebalance. If your SLO tolerates a minute of first-message latency (overnight batch feeds, notification fan-out), take the savings. If p99 end-to-end latency matters, run `minReplicaCount: 1` and let KEDA handle 1→12: you keep 90% of the elasticity and lose the cold start entirely.
:::

## 4. Broker variants: RabbitMQ and IBM MQ

Only the trigger and Secret change. For the [RabbitMQ build](/architectures/rabbitmq/), scale on ready-message count in the quorum queue:

```yaml
  triggers:
    - type: rabbitmq
      metadata:
        protocol: http            # management API, not amqp — depth via AMQP
                                  # is slower and misses some queue types
        mode: QueueLength
        value: "20"               # target READY messages per replica
        queueName: order-events   # the quorum queue from the RabbitMQ build
        vhostName: orders
      authenticationRef:
        name: rabbitmq-scaler-auth   # host param: https://user:pass@orders-rmq...:15671
```

Gotchas: `QueueLength` counts **ready** messages only — a consumer that hoards a huge unacked prefetch makes the queue look empty while work is stuck, so keep prefetch modest; the `host` URL (with credentials) belongs in the TriggerAuthentication, not inline in the trigger where it lands in plain text in the CR; and point `host` at the management port (15671/15672), not the AMQP port — the connection-refused error KEDA logs looks identical either way.

For the [IBM MQ build](/architectures/ibm-mq/), scale on current queue depth via the queue manager's administrative REST API:

```yaml
  triggers:
    - type: ibmmq
      metadata:
        host: "https://qm1-ibm-mq-web.mq.svc:9443/ibmmq/rest/v2/admin/action/qmgr/QM1/mqsc"
        queueName: ORDER.EVENTS
        queueDepth: "20"          # target depth per replica
        tlsDisabled: "false"
      authenticationRef:
        name: ibmmq-scaler-auth   # username/password with mqreader REST role
```

Gotchas: the scaler talks to the **web/REST server** (9443), not an MQ channel — the web server must be enabled and its TLS trusted, which the MQ build configures but many minimal queue managers don't; the credential needs a REST *viewer/reader* role on the queue manager, not MQ channel auth; and CURDEPTH counts uncommitted messages inside open units of work, so long transactions inflate the signal slightly. The broker-selection question itself is [Message Queues on Kubernetes](/stateful/message-queues/).

## 5. PDB — and the zero-replica interplay

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: order-events-consumer
  namespace: orders
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: order-events-consumer
```

Be clear-eyed about what this does at each end of the scale range. **At zero replicas the PDB blocks nothing** — there are no pods to protect, and a correctly-written PDB on a scaled-to-zero Deployment does not wedge node drains (`minAvailable: 1` with zero desired pods is simply not violated by an eviction of nothing). Where it earns its keep is mid-burst: without it, a node drain during your campaign spike can evict half the consumer fleet at once, and the lag spike re-triggers scale-out into a rebalance storm. Voluntary-disruption mechanics are covered in [High Availability](/workloads/high-availability/). One caveat: don't use `maxUnavailable` percentages with scale-to-zero workloads — some controllers evaluate them badly at low counts; absolute `minAvailable: 1` is predictable.

## 6. ScaledJob: when a message is a job, not a stream

If each message is a self-contained *work item* measured in minutes — a report render, a video transcode — a long-lived consumer is the wrong shape: scale-in kills a 20-minute job at minute 19, and no sane `terminationGracePeriodSeconds` covers it. `ScaledJob` spawns one Job per unit of backlog instead; each pod takes one message, finishes, and exits, so "scale-in" is just *not starting new Jobs* — nothing running is ever interrupted. Job semantics (backoff, TTL, completion) are [Jobs & CronJobs](/workloads/jobs-and-cronjobs/).

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: report-render
  namespace: orders
spec:
  jobTargetRef:
    template:
      spec:
        containers:
          - name: render
            image: registry.example.com/orders/report-render:2.1.0
        restartPolicy: Never
    backoffLimit: 2
  pollingInterval: 30
  maxReplicaCount: 20          # concurrent Jobs, not Deployment replicas
  successfulJobsHistoryLimit: 5
  scalingStrategy:
    strategy: default          # pending Jobs count against demand
  triggers:
    - type: rabbitmq
      metadata: { protocol: http, mode: QueueLength, value: "1",
                  queueName: report-requests, vhostName: orders }
      authenticationRef:
        name: rabbitmq-scaler-auth
```

Decision rule: message processed in **seconds** → ScaledObject; **minutes, and interruption is expensive** → ScaledJob. Don't use ScaledJob for high-rate streams — Job-per-message churn will hammer the API server.

## 7. Verification: five drills before you trust it

**1. Burst and watch scale-out.** Publish 5,000 messages with the Strimzi perf producer, then watch both objects:

```bash
kubectl -n kafka run producer -ti --rm --image=quay.io/strimzi/kafka:0.45.0-kafka-3.9.0 -- \
  bin/kafka-producer-perf-test.sh --topic order-events --num-records 5000 \
  --record-size 512 --throughput -1 --producer-props \
  bootstrap.servers=orders-kafka-kafka-bootstrap:9092

kubectl -n orders get scaledobject,hpa -w
```

Expected phases — quiet, burst, drained:

```text
NAME              MIN  MAX  READY  ACTIVE  FALLBACK  TRIGGERS  AGE
order-events-c…   0    12   True   False   False     kafka     2d    # quiet: parked at 0
order-events-c…   0    12   True   True    False     kafka     2d    # burst: Active flips

NAME                                REFERENCE                    TARGETS       REPLICAS
keda-hpa-order-events-consumer      Deployment/order-events-c…   417/100 (avg) 5→10
```

Lag 5000 / lagThreshold 100 asks for 12 (capped at max); watch it step up under the HPA's scale-out policy, then drain back under the 2-pods-per-minute scale-down policy.

**2. Cold start.** Let it idle past `cooldownPeriod` (replicas → 0), then send one batch above `activationLagThreshold` and time message-publish → first-commit. That number — expect 30–90s — is your activation latency; if it violates the SLO, that's the `minReplicaCount: 1` decision made with data.

**3. Fallback.** Break the scaler's view only (rotate the scaler Secret to a bad password — the app keeps consuming). After 3 failed polls, `FALLBACK: True` and replicas pin at 4. Fix the Secret; confirm normal scaling resumes.

**4. The drain test — prove scale-in loses nothing.** Publish 1,000 *numbered* messages while at high replicas, then stop the producer and let KEDA scale in through the burst's tail. Count distinct processed IDs downstream: exactly 1,000 (duplicates acceptable if you're at-least-once; gaps never). If IDs go missing, your SIGTERM handling or `terminationGracePeriodSeconds` is wrong — fix the Deployment, not the ScaledObject.

**5. Wedged-consumer probe.** `kubectl exec` into a consumer and SIGSTOP the process: heartbeat file goes stale, liveness restarts it within ~90s, and lag never silently accumulates behind a zombie.

## 8. Failure modes

| Symptom | Likely cause | How to confirm and fix |
|---|---|---|
| Replicas pinned at max, lag still growing | Consumer itself is broken (crash-looping, downstream dead) — no replica count fixes a zero consume rate. Or `lagThreshold` far below realistic per-pod throughput. | If per-pod consume rate ≈ 0, debug the app first. Otherwise re-derive `lagThreshold` from measured msg/s per pod. |
| Replicas oscillating (flapping) | Scale-in too aggressive for bursty arrivals; or a second controller fighting KEDA. | Raise `scaleDown.stabilizationWindowSeconds` / tighten the pods-per-period policy; check for a manual HPA (below). |
| Stuck at zero while messages wait | Backlog below `activationLagThreshold`; or the trigger is erroring so KEDA can't see the backlog at all. | `kubectl -n orders describe scaledobject order-events-consumer` — `Ready: False` = trigger error (read the Events on the CR; KEDA copies scaler errors there, no keda-namespace access needed). `Ready: True, Active: False` = threshold genuinely not met. |
| `Ready: False`, app consumes fine | TriggerAuthentication broken: wrong Secret key names, expired scaler cert, missing group *describe* ACL. Remember: two clients, two credential sets. | Compare the CR's Events against the broker's auth log; test the scaler creds by hand with the broker CLI. |
| Scale-out stops at N < demand | Partition ceiling: replicas = partitions, extra pods would idle. | This is Kafka's limit, not KEDA's — add partitions ([Strimzi build](/architectures/kafka-strimzi/)) *and* raise `maxReplicaCount`. |
| Replicas snap between two values after a "fix" | Someone re-added a manual HPA; it and `keda-hpa-…` are both writing `replicas`. | `kubectl -n orders get hpa` — exactly one, named `keda-hpa-<scaledobject>`. Delete the other. |

## 9. Alerts and sizing

Three alerts cover the failure surface; wiring and routing per [Alerting](/observability/alerting/). PromQL sketches (lag from your broker's exporter, KEDA health from the operator's metrics, which most platforms scrape into the shared Prometheus):

```promql
# Backlog absolute — the SLO breach
sum(kafka_consumergroup_lag{group="order-events-consumer"}) > 5000

# Backlog growth while at max replicas — scaling can no longer help
sum(rate(kafka_consumergroup_lag{group="order-events-consumer"}[10m])) > 0
  and on() kube_deployment_spec_replicas{deployment="order-events-consumer"} >= 12

# Scaler broken / fallback engaged — you are scaling blind
sum(rate(keda_scaler_errors_total{scaledObject="order-events-consumer"}[5m])) > 0
```

Alert on the queue and on KEDA's *ability to see* the queue — never on replica count itself, which is KEDA's output, not your SLO.

| Knob | Start | Derive from |
|---|---|---|
| `lagThreshold` | 100 | measured per-pod msg/s × acceptable catch-up seconds |
| `activationLagThreshold` | 10 | smallest backlog worth a cold start |
| `maxReplicaCount` | 12 | min(partitions, downstream capacity) |
| `pollingInterval` | 15s | wake-up latency budget vs broker API load |
| `cooldownPeriod` | 300s | longest routine gap between bursts |
| `terminationGracePeriodSeconds` | 45s | worst-case message time + commit slack |
| `fallback.replicas` | 4 | steady-state average replica count |

The pattern generalizes: any metric a KEDA scaler can read — queue depth, lag, Prometheus queries, cron windows — can drive the same ScaledObject shape. But queues are where it pays first, because queues are exactly where CPU lies to you.
