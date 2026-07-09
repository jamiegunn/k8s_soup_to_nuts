---
title: Autoscaling
description: HPA v2 metrics and behavior tuning, why replica thrash almost always traces to bad CPU requests, and where VPA and KEDA fit.
keywords:
  - horizontalpodautoscaler
  - pods scaling up and down constantly
  - replica flapping
  - failedgetresourcemetric missing request for cpu
  - scale to zero
  - queue depth scaling
  - metrics server
  - scaledobject
  - hpa not scaling
  - kubectl describe hpa
  - unable to fetch pod metrics
sidebar:
  order: 6
---

Autoscaling is one of those features that works beautifully when the inputs are honest and becomes a chaos generator when they're not. The HPA is simple arithmetic on top of your resource requests — so most "autoscaling bugs" are actually requests bugs wearing a disguise.

## HPA v2 in one example

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: payments
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payments
  minReplicas: 3
  maxReplicas: 12
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - type: Percent
          value: 100
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Pods
          value: 1
          periodSeconds: 120
```

The core loop, every ~15 seconds:

```text
desiredReplicas = ceil(currentReplicas × currentMetric / targetMetric)
```

With CPU `Utilization` targets, `currentMetric` is average CPU usage across pods **as a percentage of each pod's CPU request**. Not the limit. Not node capacity. The request. Everything downstream follows from that.

## Metric types

- **Resource** — CPU or memory from the metrics server. CPU utilization is the workhorse. Memory is usually a poor scaling signal: JVMs and most runtimes don't release memory when load drops, so memory-based HPAs scale up and never scale down (see [JVM in containers](/java/jvm-in-containers/)).
- **ContainerResource** — same, but scoped to one named container, so a sidecar's usage doesn't pollute the math. Use this if you run service-mesh sidecars.
- **Pods** — a custom per-pod metric (e.g., `requests_per_second`) averaged across pods. Needs a metrics adapter (Prometheus adapter, typically) that the platform team installs.
- **Object / External** — one metric describing something else: ingress RPS, queue depth in an external system. Also adapter-dependent.

Scaling on RPS or queue depth beats CPU whenever your bottleneck isn't CPU — but check what adapters exist in your cluster before writing the manifest. `kubectl get apiservices | grep -E 'custom|external'` shows whether custom/external metrics APIs are even served; if not, that's a [platform team conversation](/operations/working-with-platform-team/).

## behavior: the anti-flapping controls

Defaults if you omit `behavior`: scale up fast (no stabilization), scale down with a 300s stabilization window. Usually right. Know the knobs anyway:

- **stabilizationWindowSeconds** — the HPA uses the *highest* desired-replica recommendation (for scale-down) computed over this window. A 300s down-window means "don't shrink unless we've wanted fewer replicas continuously for 5 minutes." This is your main defense against sawtooth flapping on bursty traffic.
- **policies** — rate limits: at most X pods or Y percent per period. Multiple policies take the most permissive by default (`selectPolicy: Max`).
- `selectPolicy: Disabled` on `scaleDown` turns off scale-down entirely — handy during an incident when you want the HPA to add but never remove.

For spiky workloads I run scale-up aggressive (100%/minute, no window) and scale-down timid (1 pod per 2 minutes, 300s window). Being over-provisioned for ten minutes is cheap; being under-provisioned for one is a page.

## The classic misconfigurations

**CPU requests set too low → thrash.** The most common one by far. Suppose your pod idles at 180m and you set `requests.cpu: 100m` (because someone "optimized" it): idle utilization is already 180%, target is 70%, so the HPA scales toward maxReplicas *at rest* and pins there. The inverse — requests far above real usage — means utilization never reaches the target and the HPA never scales up until you're already on fire. **Fix the requests first** ([sizing methodology](/workloads/resources-and-qos/)), then tune the HPA. To check the utilization-of-request math against what your pods actually consume, the [PromQL for resources cookbook](/observability/promql-for-resources/) has the exact queries.

**`replicas` in your manifest + HPA = tug of war.** Every CI/CD apply resets replicas to the manifest value; the HPA then corrects it back. On a scaled-up fleet, a deploy suddenly drops you from 10 pods to 3 and users notice. Remove `replicas` from the manifest entirely when an HPA owns the count (kubectl apply leaves the field alone if it's absent). This is a first-class [drift problem](/operations/drift-and-cicd/).

**minReplicas below your HA floor.** The HPA will happily scale to `minReplicas: 1` at night, defeating your PDB and [anti-affinity story](/workloads/high-availability/). Floor it at your availability minimum, not your cost minimum.

**Missing readiness gates the math.** Pods that aren't Ready are excluded from the utilization average in scale-up decisions, but a fleet of NotReady pods still counts toward `currentReplicas` for scaling limits. If a rollout goes bad while the HPA is active, expect strange numbers; check `kubectl describe hpa` first.

```console
$ kubectl describe hpa payments
...
Metrics:                    ( current / target )
  resource cpu on pods (as a percentage of request):  184% (461m) / 70%
Events:
  Normal  SuccessfulRescale  2m    horizontal-pod-autoscaler  New size: 8; reason: cpu resource utilization above target
  Warning FailedGetResourceMetric  40s  horizontal-pod-autoscaler  missing request for cpu in container istio-proxy
```

That last event is another classic: **every container in the pod needs a CPU request** for Utilization math to work. One request-less sidecar and the HPA goes blind. When the HPA won't move at all, the symptom-first walkthrough is [HPA Not Scaling](/troubleshooting/hpa-not-scaling/) — it starts from that same `kubectl describe hpa` output and works outward.

## VPA: mostly not yours

The Vertical Pod Autoscaler adjusts requests/limits instead of replica counts. It's a cluster-installed component (admission controller + recommender), so whether it exists at all is the platform team's call, and its `Auto` mode evicts your pods to resize them — behavior you want to opt into deliberately, not discover.

Where VPA earns its keep for you: **recommendation mode** (`updateMode: "Off"`), which watches your workload and publishes suggested requests without touching anything. If it's installed, it's a free sizing consultant. Don't run VPA and an HPA on CPU against the same Deployment — they'll fight.

## KEDA: event-driven scaling

If your workload is queue-driven — consuming from Kafka, RabbitMQ, or a [message queue](/stateful/message-queues/) — CPU is a lagging signal: by the time consumers are CPU-hot, the backlog is already deep. KEDA scales on queue depth/lag directly and can scale to zero between bursts. It's another cluster-level install (it ships [CRDs](/controllers/crds-explained/) and an operator), so availability is a platform question, but the `ScaledObject` you'd write is namespace-scoped and yours:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-consumer
spec:
  scaleTargetRef:
    name: order-consumer          # your Deployment
  minReplicaCount: 0
  maxReplicaCount: 20
  triggers:
    - type: rabbitmq
      metadata:
        queueName: orders
        mode: QueueLength
        value: "50"               # ~1 replica per 50 queued messages
```

Under the hood KEDA manages an HPA for you, so the behavior/stabilization concepts above still apply. Don't create your own HPA against the same Deployment. If you're building CronJob-shaped hacks to drain queues, KEDA is the grown-up answer — see the warning in [jobs and cronjobs](/workloads/jobs-and-cronjobs/).

## Manual scaling and drift

```console
$ kubectl scale deploy/payments --replicas=10
```

Legitimate during an incident. But it's an imperative change: if an HPA targets this Deployment, it will override you within a minute (raise `minReplicas` instead if you need a floor to stick); if not, the next pipeline apply resets you to the manifest. Either way, manual scale is a note-to-self that expires. Make the change durable in git or expect it to evaporate — the [drift article](/operations/drift-and-cicd/) covers the pattern.

:::tip[Incident move]
To pin capacity high during an incident with an HPA in play: `kubectl patch hpa payments -p '{"spec":{"minReplicas":10}}'`. It survives HPA reconciliation, it's one line to revert, and it's greppable in your shell history when you write the postmortem.
:::

One more interaction worth knowing: during a [rolling update](/workloads/rollouts-and-rollbacks/), the HPA keeps running. If load is high mid-deploy, it may scale the Deployment up, and the rollout machinery obliges by adding pods on the *new* template. Usually harmless — occasionally surprising when a deploy "created twelve pods" and someone assumes the pipeline is broken. Check `kubectl describe hpa` events before blaming CI.

## Load-test your scaling before prod does it for you

An untested HPA is a guess. Before trusting it:

1. Generate realistic load against a staging copy (k6, vegeta, locust — anything that can ramp).
2. Watch the loop live: `kubectl get hpa payments --watch` alongside `kubectl top pods -l app=payments`.
3. Verify the *whole chain*: metrics appear → HPA computes sanely → new pods schedule (quota! see [ResourceQuotas](/workloads/resources-and-qos/)) → pods become Ready fast enough to matter.
4. Then kill the load and confirm scale-down is calm, not a cliff.

The failure you're hunting isn't "HPA didn't scale" — it's "HPA scaled, but new pods sat Pending on quota" or "pods took 90 seconds of [JVM warmup](/java/jvm-in-containers/) to become Ready, so scaling lagged the spike by two minutes." Both are invisible until you actually push load through the system.

Finally, size `maxReplicas` against reality, not optimism: it must fit inside your namespace quota *and* your downstream dependencies. An HPA that scales your API to 40 pods is just a machine for converting a traffic spike into a database connection-pool outage. Scale limits are a system property — set them where the weakest link is.
