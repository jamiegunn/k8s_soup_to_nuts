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

**What you'll have at the end:** ScaledObjects for a `@JmsListener` app on external IBM MQ and a `@RabbitListener` app on external RabbitMQ, with trigger numbers derived from a freshness SLO instead of folklore, ceilings that respect the broker, and — the part everyone skips — scale-in that provably doesn't lose or double-process a message.

Queue consumers are the easiest workloads to scale correctly and the easiest to corrupt while scaling in. Easiest correctly: the queue *is* the backlog — [queue depth measures work-not-yet-done directly](/autoscaling/signals-catalog/#queue-depth--message-lag), no proxy signals, no guessing. Easiest to corrupt: scale-in kills consumers mid-message by design, several times a day, and whatever that does to your messages is what autoscaling now does at scale.

One scoping note: KEDA's mechanics — operator model, `ScaledObject` anatomy, `TriggerAuthentication`, `fallback`, `ScaledJob` — are built end to end in [Event-Driven Autoscaling with KEDA](/architectures/keda-autoscaling/), and this page doesn't repeat them. This page owns what that build glosses over for *Spring* consumers on *your* brokers: where the trigger numbers come from, what the broker's limits do to your ceiling, and the SIGTERM path.

## The lifecycle, with the cluster boundary drawn

```mermaid
flowchart TD
    subgraph outside["Outside the cluster"]
        MQ[("IBM MQ<br/>DISPATCH.Q<br/><i>depth rises</i>")]
    end
    subgraph cluster["Kubernetes cluster"]
        KEDA["KEDA operator<br/><i>polls depth every 30s<br/>over the network</i>"]
        HPA["the HPA KEDA manages"]
        W1["dispatch-worker"] 
        W2["dispatch-worker<br/><i>added</i>"]
    end
    MQ -.->|"admin REST, monitoring creds"| KEDA
    KEDA --> HPA --> W2
    MQ -->|"messages"| W1
    MQ -->|"messages"| W2
    W2 -->|"depth falls → cooldown →<br/><b>SIGTERM: prefetched +<br/>in-flight messages exist</b>"| X["scale-in —<br/>where loss/duplication lives"]
```

Two boundary consequences before any YAML. **KEDA reaches out of the cluster**: firewall path, TLS trust to the corporate CA, and a *monitoring-only* account on the broker — the three PLATFORM asks [named on the pipeline page](/autoscaling/getting-the-metrics/#lane-c--systems-outside-the-cluster). **When the broker is unreachable, KEDA freezes replicas at the current count** (or applies your `fallback` block — [decide it before the outage](/architectures/keda-autoscaling/)); your consumers keep consuming, only the *scaling* goes blind.

## The trigger number, from the freshness SLO

Consumers promise **freshness**: [the cast table](/autoscaling/slos-for-scaling/#the-casts-slos) has `dispatch-worker` at *99% of dispatch messages processed within 5 minutes*. That promise converts directly into the trigger:

```text
Measured: one dispatch-worker pod drains ~40 msg/min (measured, not guessed —
          same discipline as per-pod RPS capacity)

The SLO tolerates a backlog that one pod clears within the promise window:
    tolerable backlog per pod = drain rate × window = 40 × 5 = 200 messages

Safety factor for reaction + startup lag (~2× is honest for a JVM consumer):
    queueDepth trigger = 200 / 2 = 100 messages per pod

Meaning: KEDA targets 1 pod per 100 queued messages — depth 400 → 4 pods,
each facing ~2.5 minutes of work: inside the promise, with margin for lag.
```

When message cost varies wildly (some dispatches take 50× longer), raw depth misleads — 500 cheap messages need one pod, 500 expensive ones need ten. Scale on **lag-time** instead: depth ÷ measured drain rate, built as a [custom metric or a Prometheus-scaler query](/autoscaling/getting-the-metrics/), same freshness math on an honest denominator.

Floor and ceiling come from the [arrival-rate state table](/autoscaling/load-profile/#consumers-same-states-different-series) — remember consumer peak is often *nocturnal* (the 01:30 batch dump), so derive from the consumer's own profile, not the API team's intuition about "busy."

## IBM MQ: `dispatch-worker`

The `ibmmq` scaler talks to the queue manager's **admin REST endpoint** — which on on-prem installations is frequently *not enabled*. That's your first named ask to the MQ admin, and it's for two things: the REST endpoint reachable from the cluster, and a monitoring account allowed to inquire queue depth (nothing more).

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

**Autoscaled consumers want low prefetch.** With scaling handling throughput via pod count, prefetch's job shrinks to hiding network latency — 5 to 20 does that fine. (High prefetch also *distorts your scaling signal*: prefetched messages leave the queue's visible depth, so depth under-reports the true backlog by `prefetch × pods`.)

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

One trap nested inside the handshake: Spring AMQP's listener container stops waiting for in-flight handlers after its **own** `shutdownTimeout` — **five seconds by default**, and it isn't an `application.yaml` property. Left alone it quietly overrides the 30 s you just configured: the container abandons a 20-second handler at ~5 s and its message requeues anyway. Set it via a container customizer so the three timeouts nest — container `shutdownTimeout` ≤ `timeout-per-shutdown-phase` ≤ `terminationGracePeriodSeconds` − preStop:

```java
@Bean
ContainerCustomizer<SimpleMessageListenerContainer> shutdownAlignment() {
    return container -> container.setShutdownTimeout(30_000L);  // ms — match the
}                                                                // lifecycle phase above
```

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

`minReplicaCount: 0` is KEDA's headline feature and a per-workload judgment call:

- **`notify-worker`: yes.** Notifications tolerate the first-message latency (cold start + connect, ~60–90 s against a 15-minute SLO) and the queue is empty most of the night — zero gives real capacity back ([citizenship](/autoscaling/overview/#the-citizenship-contract)).
- **`dispatch-worker`: no.** A 5-minute freshness SLO spends a fifth of its budget on every cold start; and on IBM MQ specifically, connection churn is a cost in its own right (channel instance setup, and on some licensing models, a line item). `minReplicaCount: 1` keeps a warm consumer for the price of one idle pod.

The trade in one line: scale-to-zero trades first-message latency (and broker connection churn) for genuinely returned capacity — take it on tolerant flows, refuse it on tight SLOs.

## Who owns what

| Concern | Owner |
|---|---|
| MQ admin REST enabled, monitoring accounts, MAXINST/handle numbers | MQ / broker admin |
| Firewall path from KEDA to broker admin ports, KEDA itself | PLATFORM |
| Trigger math, prefetch, grace-period arithmetic, idempotency | YOU |
| The ceiling derivation written next to maxReplicaCount | YOU |

## Failure modes

| Symptom | What happened | Fix |
|---|---|---|
| Duplicates after every scale-in | prefetch high + non-idempotent handler | prefetch section + the danger box |
| Depth pinned high, replicas at max, drain rate ~0 | poison message redelivering forever | DLQ / max-redelivery policy on the broker; the depth *alert* below catches it |
| Broker refuses connections at high replica count | MAXINST / channel ceiling hit | the MQ ceiling math |
| Depth under-reports vs reality | high prefetch hiding backlog inside consumers | lower prefetch |
| Replicas frozen mid-incident | broker unreachable from KEDA — polling blind | `fallback` block ([KEDA page](/architectures/keda-autoscaling/)); pipeline alert below |
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
# KEDA can't read the broker — scaling is blind (freshness SLO at risk silently)
sum by (scaledObject) (rate(keda_scaler_errors_total{scaledObject=~"dispatch-worker|notify-worker"}[5m])) > 0
```

## Take this with you

Both variants above are the starter kit — TriggerAuthentication + ScaledObject per broker, plus the `application.yaml` shutdown block. Adapt in this order: your broker URLs and monitoring credentials → your measured drain rate into the trigger math → your prefetch decision → your grace arithmetic → the ceiling derivation from *your* broker admin's numbers. The comments mark every spot.

## Where next

- **Next in the journey:** [Web + Worker, In-Cluster Valkey, External Redis](/autoscaling/web-worker-and-caches/) — what happens when one chart contains *both* of the archetypes you've now seen.
- **The lateral jump:** the full KEDA mechanics your ScaledObject rides on: [Event-Driven Autoscaling with KEDA](/architectures/keda-autoscaling/).
