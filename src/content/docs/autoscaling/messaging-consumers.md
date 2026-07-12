---
title: "Reference Architecture: IBM MQ and RabbitMQ Consumers (Brokers Outside the Cluster)"
description: KEDA queue-depth scaling for Spring listeners against external IBM MQ and RabbitMQ — trigger math from a freshness SLO, broker-side ceilings, and scale-in that doesn't corrupt messages.
keywords:
  - keda ibm mq queue depth scaling
  - keda rabbitmq external broker
  - scale consumers on queue depth
  - rabbitmq prefetch scale in requeue
  - jmslistener graceful shutdown kubernetes
  - messages processed twice after scale down
  - queue backlog not draining overnight
  - single active consumer scaling limit
sidebar:
  order: 12
---

You are here if: your overnight backlog isn't drained by morning; or you're wiring KEDA to a broker that lives outside the cluster; or messages got processed twice after a scale-down and you're here to make sure it never happens again.

**What you'll have at the end:** queue-depth scaling for a `@JmsListener` app on external IBM MQ and a `@RabbitListener` app on external RabbitMQ — built **both ways**, because this platform assumes neither mechanism: an exporter-fed HPA for clusters whose external-metrics grant is prometheus-adapter, and ScaledObjects for clusters that got KEDA ([the fork](/autoscaling/getting-the-metrics/#5-the-fork-adapter-or-keda) is where that ask gets made). Plus trigger numbers derived from a freshness SLO instead of folklore, ceilings that respect the broker, and — the part everyone skips — scale-in that provably doesn't lose or double-process a message.

Queue consumers are the easiest workloads to scale correctly and the easiest to corrupt while scaling in. Easiest correctly: the queue *is* the backlog — [queue depth measures work-not-yet-done directly](/autoscaling/signals-catalog/#queue-depth--message-lag), no proxy signals, no guessing. Easiest to corrupt: scale-in kills consumers mid-message by design, several times a day, and whatever that does to your messages is what autoscaling now does at scale.

One scoping note: KEDA's mechanics — operator model, `ScaledObject` anatomy, `TriggerAuthentication`, `fallback`, `ScaledJob` — are built end to end in [Event-Driven Autoscaling with KEDA](/architectures/keda-autoscaling/), and the adapter pipeline's five steps live on [the pipeline page](/autoscaling/getting-the-metrics/); this page repeats neither. It owns what both builds gloss over for *Spring* consumers on *your* brokers: where the trigger numbers come from, what the broker's limits do to your ceiling, and the SIGTERM path.

## The lifecycle, with the cluster boundary drawn

```mermaid
flowchart TD
    subgraph outside["Outside the cluster"]
        MQ[("IBM MQ<br/>DISPATCH.Q<br/><i>depth rises</i>")]
    end
    subgraph cluster["Kubernetes cluster"]
        KEDA["depth watcher:<br/>KEDA operator, <i>or</i><br/>MQ exporter → Prometheus → adapter"]
        HPA["the HPA it feeds"]
        W1["dispatch-worker"] 
        W2["dispatch-worker<br/><i>added</i>"]
    end
    MQ -.->|"admin REST, monitoring creds"| KEDA
    KEDA --> HPA --> W2
    MQ -->|"messages"| W1
    MQ -->|"messages"| W2
    W2 -->|"depth falls → cooldown →<br/><b>SIGTERM: prefetched +<br/>in-flight messages exist</b>"| X["scale-in —<br/>where loss/duplication lives"]
```

Two boundary consequences before any YAML. **Something reaches out of the cluster** — the KEDA operator, or your exporter pod: firewall path, TLS trust to the corporate CA, and a *monitoring-only* account on the broker — the three PLATFORM asks [named on the pipeline page](/autoscaling/getting-the-metrics/#lane-c--systems-outside-the-cluster). **When the broker is unreachable, scaling goes blind but pods stay up**: KEDA freezes replicas at the current count (or applies your `fallback` block — [decide it before the outage](/architectures/keda-autoscaling/)); on the adapter track the depth series goes stale and the HPA freezes with `FailedGetExternalMetric`. Either way your consumers keep consuming — only the *scaling* stops.

## The trigger number, from the freshness SLO

Consumers promise **freshness**: [the cast table](/autoscaling/slos-for-scaling/#the-casts-slos) has `dispatch-worker` at *99% of dispatch messages processed within 5 minutes*. That promise converts directly into the trigger:

```text
Measured: one dispatch-worker pod drains ~40 msg/min (measured, not guessed —
          same discipline as per-pod RPS capacity)

The SLO tolerates a backlog that one pod clears within the promise window:
    tolerable backlog per pod = drain rate × window = 40 × 5 = 200 messages

Safety factor for reaction + startup lag (~2× is honest for a JVM consumer):
    queueDepth trigger = 200 / 2 = 100 messages per pod

Meaning: the scaler targets 1 pod per 100 queued messages — depth 400 → 4 pods,
each facing ~2.5 minutes of work: inside the promise, with margin for lag.
```

When message cost varies wildly (some dispatches take 50× longer), raw depth misleads — 500 cheap messages need one pod, 500 expensive ones need ten. Scale on **lag-time** instead: depth ÷ measured drain rate, built as a [custom metric or a Prometheus-scaler query](/autoscaling/getting-the-metrics/), same freshness math on an honest denominator.

Floor and ceiling come from the [arrival-rate state table](/autoscaling/load-profile/#consumers-same-states-different-series) — remember consumer peak is often *nocturnal* (the 01:30 batch dump), so derive from the consumer's own profile, not the API team's intuition about "busy."

## IBM MQ: `dispatch-worker`

Two ways to get `DISPATCH.Q`'s depth in front of the HPA — build the track your platform granted ([the fork](/autoscaling/getting-the-metrics/#5-the-fork-adapter-or-keda)). The trigger arithmetic above is identical in both; only the plumbing differs.

### Track A — exporter + adapter (no KEDA)

IBM publishes its own Prometheus exporter — `mq_prometheus`, from [mq-metric-samples](https://github.com/ibm-messaging/mq-metric-samples) — which connects to the queue manager **as an ordinary MQ client** (a server-connection channel and a monitoring account; no `mqweb` required) and exposes, among much else, `ibmmq_queue_depth`. Deploy it in-cluster like any small app — Deployment + Secret + ServiceMonitor — and the depth rides [Lane B](/autoscaling/getting-the-metrics/) into Prometheus. The part of its config worth showing (the rest is an ordinary Deployment):

```yaml
# mq_prometheus config — mounted from a ConfigMap; credentials from the Secret
connection:
  queueManager: QM1
  connName: "mq01.corp.internal(1414)"   # the LISTENER port — a client channel, not mqweb
  channel: MONITORING.SVRCONN            # ask the MQ admin for a monitoring channel
  user: mq_monitor                       # the monitoring account — NOT the app's identity
objects:
  queues:
    - DISPATCH.Q                         # export only what you scale/alert on — not the
                                         # queue manager's whole estate (cardinality is a bill)
```

Then the external-metric mapping (part of the platform's adapter install — include it verbatim in the ask) and the HPA that consumes it:

```yaml
# prometheus-adapter values (PLATFORM) — external-metric rule
rules:
  external:
    - seriesQuery: 'ibmmq_queue_depth{queue!=""}'
      resources:
        overrides:
          namespace: {resource: "namespace"}
      name:
        as: "ibmmq_queue_depth"
      metricsQuery: 'max(<<.Series>>{<<.LabelMatchers>>}) by (<<.GroupBy>>)'
```

```yaml
# templates/hpa.yaml — dispatch-worker on the adapter track
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: dispatch-worker
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: dispatch-worker
  minReplicas: 1                   # this track's hard floor — scale-to-zero is KEDA-only
                                   # (below). For an SLA'd flow like dispatch, 1 warm
                                   # consumer is what you wanted anyway.
  maxReplicas: 8                   # derivation: broker ceiling, next section
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300   # this track's cooldown — same role as KEDA's cooldownPeriod
      policies: [{ type: Pods, value: 1, periodSeconds: 60 }]
  metrics:
    - type: External
      external:
        metric:
          name: ibmmq_queue_depth
          selector:
            matchLabels:
              queue: DISPATCH.Q
        target:
          type: AverageValue
          averageValue: "100"      # the freshness-SLO math above: 1 pod per 100 messages.
                                   # AverageValue = the HPA divides TOTAL depth by this —
                                   # depth 400 → 4 pods, exactly KEDA's queueDepth semantics
```

### Track B — KEDA's `ibmmq` scaler

The `ibmmq` scaler talks to the queue manager's **admin REST endpoint** — the `mqweb` server, port 9443. Whether that's already running depends on how MQ is deployed: the MQ container image ships it on by default, but on a traditional install — a queue manager on a VM or z/OS, administered through MQSC — `mqweb` is a separately started component, and long-lived queue managers often don't run it. Check before you plan around it: `curl -k https://mq01.corp.internal:9443/ibmmq/rest/v2/admin/qmgr` answering at all (even a 401) means the endpoint is up. If it isn't, that's your first named ask to the MQ admin, and it's for two things: the REST endpoint reachable from the cluster, and a monitoring account allowed to inquire queue depth (nothing more).

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: dispatch-mq-auth
  namespace: payments
spec:
  secretTargetRef:
    - parameter: username          # the monitoring account — NOT the app's credentials;
      name: mq-monitoring-creds    # depth-reading should not be able to touch messages
      key: username
    - parameter: password
      name: mq-monitoring-creds
      key: password
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: dispatch-worker
  namespace: payments
spec:
  scaleTargetRef:
    name: dispatch-worker
  minReplicaCount: 1               # SLA'd flow: never zero — see scale-to-zero below
  maxReplicaCount: 8               # derivation: broker ceiling, next section
  pollingInterval: 30              # seconds between depth checks — freshness of the signal
  cooldownPeriod: 300              # quiet time before dropping toward min — the consumer
                                   # equivalent of scaleDown stabilization
  triggers:
    - type: ibmmq
      metadata:
        # Queue manager name is IN THE URL PATH (QM1 here) — there is no separate
        # queueManager field. Ask the MQ admin for this exact URL.
        host: "https://mq01.corp.internal:9443/ibmmq/rest/v2/admin/action/qmgr/QM1/mqsc"
        queueName: "DISPATCH.Q"
        queueDepth: "100"          # the freshness-SLO math above: 1 pod per 100 messages
        activationQueueDepth: "5"  # below 5 queued, the workload counts as idle —
                                   # activation (0↔min) vs target (scaling curve) differ
      authenticationRef:
        name: dispatch-mq-auth
```

(TLS to a corporate CA: mount the CA into the TriggerAuthentication rather than `unsafeSsl: "true"` — the field name is honest about what you'd be trading away.)

### The MQ-side ceiling

Oracle had a session budget; MQ has its own arithmetic, and it caps your `maxReplicaCount` the same way — the rhyme is deliberate, and it repeats on every page of this section: **every external dependency contributes a ceiling term, and the smallest one wins.**

- **`MAXINST`** on the server-connection channel: the maximum simultaneous instances — every pod's connections count against it. Ten consumer pods × 4 listener sessions each = 40 instances against a channel someone configured for 25 in 2019.
- **Queue open-handle limits** (`IPPROCS` is the *count* of open-for-input handles; the queue and qmgr have maximums): more consumer pods = more input handles.
- **Ordering/exclusive flags** from your [classification card](/autoscaling/classify-your-app/#exclusive-consumers-and-ordering-parallelism-capped-by-design): an exclusive-input queue caps you at 1 regardless of what KEDA wants.

Ask the MQ admin for the numbers, do the division, write the derivation next to `maxReplicaCount`. The [broker deep-dive](/architectures/ibm-mq/) covers the MQ side in full.

## RabbitMQ: `notify-worker`

Same fork, second broker.

### Track A — exporter + adapter (no KEDA)

Two routes into Prometheus, and the deciding question is *whose config can change*. If the broker admin will enable it, RabbitMQ ≥ 3.8 ships the `rabbitmq_prometheus` plugin natively (`rabbitmq-plugins enable rabbitmq_prometheus`, metrics port 15692) — but per-queue series additionally need `prometheus.return_per_object_metrics = true`, and scraping a target *outside* the cluster means an `additionalScrapeConfigs` entry on the platform's Prometheus, not a ServiceMonitor. When broker config can't change — the common case with a shared corporate broker — run a **management-API exporter in-cluster** instead (kbudde's `rabbitmq-exporter` is the standard one): it polls the same management API KEDA would (15672), with the same monitoring account, and exposes `rabbitmq_queue_messages{queue="notify.q"}` behind an ordinary ServiceMonitor. Symmetric with the MQ exporter above, and the [three platform conversations](/autoscaling/getting-the-metrics/#lane-c--systems-outside-the-cluster) attach to it identically.

The HPA is the MQ one with the names swapped:

```yaml
# templates/hpa.yaml — notify-worker on the adapter track
  minReplicas: 1                   # notify-worker WANTED zero (see scale-to-zero, below) —
                                   # the adapter track can't give it: one idle pod is the
                                   # standing cost of not having KEDA on tolerant flows
  maxReplicas: 6                   # derivation: connection/channel ceiling + the mail
                                   # gateway's ~600/min rate limit — a ceiling term that
                                   # isn't even the broker's!
  metrics:
    - type: External
      external:
        metric:
          name: rabbitmq_queue_messages
          selector:
            matchLabels:
              queue: notify.q
        target:
          type: AverageValue
          averageValue: "150"      # notify SLO is 15 min, drain ~20 msg/min/pod:
                                   # 20×15/2 = 150 per pod — same math, same comment
```

(The adapter's external rule is the MQ one with `rabbitmq_queue_messages` substituted — one rule shape per metric family.)

### Track B — KEDA's `rabbitmq` scaler

The `rabbitmq` scaler's `host` is a full connection string, credentials included — which is precisely why it belongs in the TriggerAuthentication's Secret, never in the ScaledObject:

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: notify-rabbit-auth
  namespace: payments
spec:
  secretTargetRef:
    - parameter: host              # the WHOLE connection string is the secret:
      name: rabbit-monitoring-creds # http://monitor:pass@rabbit01.corp.internal:15672/vhost
      key: host                     # http = management API (needed for MessageRate mode)
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: notify-worker
  namespace: payments
spec:
  scaleTargetRef:
    name: notify-worker
  minReplicaCount: 0               # notifications tolerate first-message latency — see below
  maxReplicaCount: 6               # derivation: connection/channel ceiling + downstream
                                   # (the mail gateway rate-limits at ~600/min — a ceiling
                                   # term that isn't even the broker's!)
  pollingInterval: 30
  cooldownPeriod: 300
  triggers:
    - type: rabbitmq
      metadata:
        protocol: http             # management API — required for rate-based modes
        mode: QueueLength          # scale on backlog; MessageRate scales on throughput
                                   # *arriving*, useful when you must keep pace rather
                                   # than clear a backlog. Depth = freshness SLO → QueueLength.
        value: "150"               # notify SLO is 15 min and drain is ~20 msg/min/pod:
                                   # 20×15/2 = 150 per pod
        queueName: "notify.q"
      authenticationRef:
        name: notify-rabbit-auth
```

### Prefetch: the number that decides your blast radius

`spring.rabbitmq.listener.simple.prefetch` is how many messages the broker hands each consumer *in advance* — a throughput optimization with a scale-in bill. Every prefetched-but-unprocessed message in a terminating pod must be requeued and redelivered; prefetch 250 × a scale-in of 3 pods = up to 750 messages re-shuffled per scale-down, ordering scrambled, duplicates guaranteed under any handler that isn't idempotent.

The trade table:

| Prefetch | You gain | You pay |
|---|---|---|
| High (250) | throughput on cheap messages | requeue storms on every scale-in; slow-message head-of-line blocking |
| Low (5–20) | tiny scale-in blast radius, honest depth signal | more broker round-trips |

**Autoscaled consumers want low prefetch.** With scaling handling throughput via pod count, prefetch's job shrinks to hiding network latency — 5 to 20 does that fine. High prefetch also distorts any **ready-only** depth signal: IBM MQ `CURDEPTH` and RabbitMQ `messages_ready` exclude messages a consumer has already taken but not acked, so they can under-report the backlog by up to `prefetch × pods`. RabbitMQ's total `messages` value — exported by many Prometheus plugins as `rabbitmq_queue_messages` and used by KEDA's HTTP `QueueLength` mode — includes ready + unacked messages, so it is safer for scaling; if you write your own PromQL, choose deliberately.

## Safe scale-in — the heart of the page

The SIGTERM sequence for a Spring listener, in plain narrative. Kubernetes decides to remove a pod → preStop hook runs → SIGTERM → Spring's graceful shutdown tells the listener containers to stop *accepting* new deliveries → in-flight handlers get to finish → the app closes broker connections → anything delivered-but-unacked (in-flight interrupted, plus the whole prefetch buffer) is **requeued by the broker** and redelivered elsewhere. If the process is still alive at `terminationGracePeriodSeconds`, SIGKILL — no more finishing, everything unacked requeues.

Your job is making that sequence *sufficient*, and it's arithmetic again:

```text
terminationGracePeriodSeconds ≥ preStop + (prefetch × worst-case per-message time) + margin

dispatch-worker: prefetch 10, worst message 3s → 5 + 30 + 10 = 45s
(and if that formula yields 10 minutes, your prefetch is too high — fix the input,
 don't request a 10-minute grace)
```

```yaml
# application.yaml — the Spring half of the handshake
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s   # in-flight handlers get up to 30s — must fit
                                      # INSIDE terminationGracePeriodSeconds (45s here)
  rabbitmq:
    listener:
      simple:
        prefetch: 10                  # the blast-radius decision, made deliberately
```

One trap nested inside the handshake: the listener container has its **own** shutdown timeout, and it is not controlled by `spring.lifecycle.timeout-per-shutdown-phase`. Left alone, that container timeout can quietly override the 30 s you just configured: the container abandons a 20-second handler early and its message requeues anyway. Set it where your listener factory is built so the three timeouts nest — container `shutdownTimeout` ≤ `timeout-per-shutdown-phase` ≤ `terminationGracePeriodSeconds` − preStop.

For RabbitMQ's `SimpleMessageListenerContainer`, wire the factory's container customizer:

```java
@Bean
SimpleRabbitListenerContainerFactory rabbitListenerContainerFactory(
    ConnectionFactory connectionFactory,
    SimpleRabbitListenerContainerFactoryConfigurer configurer) {
  var factory = new SimpleRabbitListenerContainerFactory();
  configurer.configure(factory, connectionFactory);
  factory.setContainerCustomizer(container ->
    container.setShutdownTimeout(30_000L));  // ms — match the lifecycle phase above
  return factory;
}
```

For JMS (`@JmsListener` on IBM MQ), the story is different — and simpler: Spring's `DefaultMessageListenerContainer` has **no shutdown-timeout knob at all** (nothing to align, nothing to forget). On stop it lets in-flight `onMessage` calls finish, bounded in practice by the lifecycle phase timeout and, ultimately, the pod's grace period — so for JMS, the two YAML numbers above are the whole contract. The knob worth checking is `receiveTimeout` (default 1 s): it paces how quickly *idle* consumers notice the stop, so keep it short.

:::danger[Requeue means at-least-once — idempotency is the precondition]
Everything above *minimizes* redelivery; nothing eliminates it. A crashed pod acks nothing; a slow handler overruns the grace. Redelivery is a *when*, and autoscaling raises its frequency from "rare" to "routine." Handlers must be idempotent — dedup on a business key, upsert instead of insert, check-before-send on external effects — **before** the ScaledObject merges. This is [prerequisite #5](/autoscaling/prerequisites/#5-consumers-message-handling-is-idempotent) and a blocking item on [the review gate](/autoscaling/capacity-and-governance/). If ordering matters too, revisit your [classification card](/autoscaling/classify-your-app/#exclusive-consumers-and-ordering-parallelism-capped-by-design) — scale-in requeueing reorders by construction.
:::

Proving idempotency, Spring-side — the five answers a reviewer should be able to point at in the PR:

1. **Ack timing.** Where does the ack happen relative to the side effect? (`AUTO` acks after the listener method returns; `MANUAL` is yours to place — either way: side effect, *then* ack, never the reverse.)
2. **Transaction boundary.** The business write and the "processed" marker commit together — or the write itself is an upsert on a business key. A crash between "did the work" and "recorded the work" must be re-runnable.
3. **Dedup store.** Which table or key answers "have I seen message X?" — and it's shared, not in-JVM ([the state audit](/autoscaling/classify-your-app/#in-memory-state-scale-out-fragments-it-scale-in-deletes-it) already outlawed the `ConcurrentHashMap`).
4. **External effects.** Check-before-send — or an idempotency key the downstream honors — on anything that emails, charges, or calls out.
5. **The drill.** Kill a pod mid-burst in pre-prod (`kubectl delete pod` during a producer run) and assert zero lost, zero double-processed — the redelivery test that makes the four answers above real. Poison messages get a broker-side max-redelivery/DLQ policy, not a hope.

## Scale-to-zero, honestly

`minReplicaCount: 0` is KEDA's headline feature — and **KEDA's alone**: the plain HPA the adapter track drives cannot go below 1, so on that track every consumer keeps one warm pod and this section describes what you're missing, not what you can configure. Where KEDA is granted, it's a per-workload judgment call:

- **`notify-worker`: yes.** Notifications tolerate the first-message latency (cold start + connect, ~60–90 s against a 15-minute SLO) and the queue is empty most of the night — zero gives real capacity back ([citizenship](/autoscaling/overview/#the-citizenship-contract)).
- **`dispatch-worker`: no.** A 5-minute freshness SLO spends a fifth of its budget on every cold start; and on IBM MQ specifically, connection churn is a cost in its own right (channel instance setup, and on some licensing models, a line item). `minReplicaCount: 1` keeps a warm consumer for the price of one idle pod.

The trade in one line: scale-to-zero trades first-message latency (and broker connection churn) for genuinely returned capacity — take it on tolerant flows, refuse it on tight SLOs. And if you're on the adapter track wanting zero for a fleet of night-idle consumers, that's a legitimate line in the KEDA ask: "N consumers × 1 idle pod × their requests, reserved all night" is exactly the arithmetic that justifies the operator.

## Who owns what

| Concern | Owner |
|---|---|
| Monitoring accounts/channels, REST or plugin enablement, MAXINST/handle numbers | MQ / broker admin |
| Firewall path from the poller (KEDA or exporter) to broker ports; KEDA or prometheus-adapter itself | PLATFORM |
| The exporter Deployment + ServiceMonitor (adapter track) or ScaledObject + TriggerAuthentication (KEDA track) | YOU, in your chart |
| Trigger math, prefetch, grace-period arithmetic, idempotency | YOU |
| The ceiling derivation written next to the max, whichever object holds it | YOU |

## Failure modes

| Symptom | What happened | Fix |
|---|---|---|
| Duplicates after every scale-in | prefetch high + non-idempotent handler | prefetch section + the danger box |
| Depth pinned high, replicas at max, drain rate ~0 | poison message redelivering forever | DLQ / max-redelivery policy on the broker; the depth *alert* below catches it |
| Broker refuses connections at high replica count | MAXINST / channel ceiling hit | the MQ ceiling math |
| Depth under-reports vs reality | high prefetch hiding backlog inside consumers | lower prefetch |
| Replicas frozen mid-incident | broker unreachable from the poller — scaling blind | KEDA track: `fallback` block ([KEDA page](/architectures/keda-autoscaling/)); adapter track: fix the exporter/path — the HPA stays frozen until the series returns. Pipeline alerts below |
| HPA `FailedGetExternalMetric` (adapter track) | exporter down, or adapter rule matches nothing | `up{job=~".*exporter.*"}` first, then `kubectl get --raw /apis/external.metrics.k8s.io/v1beta1` |
| Scaled to max, backlog still growing | downstream (mail gateway, Oracle write) is the real bottleneck | drain-rate alert below — more pods can't fix a downstream |

## Alerts

```promql
# Depth high while desired == max: scaling has hit its ceiling with work left —
# capacity conversation, poison message, or downstream bottleneck. Look, don't wait.
(rabbitmq_queue_messages{queue="notify.q"} > 900)
and on()
(kube_horizontalpodautoscaler_status_desired_replicas{horizontalpodautoscaler="keda-hpa-notify-worker"}
 >= on() kube_horizontalpodautoscaler_spec_max_replicas{horizontalpodautoscaler="keda-hpa-notify-worker"})
```

```promql
# Per-pod drain rate FALLING as replicas rise: the broker or the downstream is the
# bottleneck — each new pod gets a thinner slice. Stop scaling, start profiling.
rate(spring_rabbitmq_listener_seconds_count{namespace="payments"}[5m])
/ on() group_left() kube_deployment_status_replicas{deployment="notify-worker"}
```

```promql
# KEDA track: KEDA can't read the broker — scaling is blind (freshness SLO at risk silently)
sum by (scaledObject) (rate(keda_scaler_errors_total{scaledObject=~"dispatch-worker|notify-worker"}[5m])) > 0
```

```promql
# Adapter track (and mechanism-neutral): the HPA could not compute a replica count
kube_horizontalpodautoscaler_status_condition{condition="ScalingActive", status="false",
  horizontalpodautoscaler=~"dispatch-worker|notify-worker|keda-hpa-.*"} == 1
```

(One naming note for every query above: KEDA names its managed HPA `keda-hpa-<scaledobject>`; on the adapter track the HPA carries your own name — adjust the `horizontalpodautoscaler` matchers to your track.)

## Take this with you

Each broker above ships a starter kit per track — exporter + external-metric HPA, or TriggerAuthentication + ScaledObject — plus the `application.yaml` shutdown block, which is track-independent. Adapt in this order: which mechanism your platform granted ([check, don't assume](/autoscaling/getting-the-metrics/#5-the-fork-adapter-or-keda)) → your broker URLs and monitoring credentials → your measured drain rate into the trigger math → your prefetch decision → your grace arithmetic → the ceiling derivation from *your* broker admin's numbers. The comments mark every spot.

## Where next

- **Next in the journey:** [Web + Worker, In-Cluster Valkey, External Redis](/autoscaling/web-worker-and-caches/) — what happens when one chart contains *both* of the archetypes you've now seen.
- **The lateral jump:** the full KEDA mechanics your ScaledObject rides on: [Event-Driven Autoscaling with KEDA](/architectures/keda-autoscaling/).
