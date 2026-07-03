---
title: High Availability
description: PodDisruptionBudgets, anti-affinity, topology spread, priority, and graceful shutdown — surviving node drains and cluster upgrades without paging anyone.
sidebar:
  order: 4
---

Your platform team drains nodes constantly: kernel patches, cluster upgrades, autoscaler consolidation, spot reclaims. Each drain evicts your pods. Whether that's a non-event or an outage is decided entirely by things *you* control in your manifests. This article is the checklist.

## Replicas > 1 is table stakes, not HA

One replica means every voluntary drain, every OOMKill, every image pull hiccup is a full outage for your service. Two replicas on the *same node* is barely better — one drain still takes both. Real availability is three layers:

1. **Multiple replicas** — so losing one pod loses capacity, not the service.
2. **Spread across failure domains** — so one node (or zone) can't take them all.
3. **Disruption budgets and graceful shutdown** — so planned maintenance replaces pods without dropping requests.

Run at least 2 replicas for anything anyone depends on, 3+ for anything with an SLO. If the app can't run with 2 replicas because it has state or a single-writer constraint, that's a [stateful workload](/stateful/overview/) and needs different machinery.

## PodDisruptionBudgets

A PDB tells the eviction API how much *voluntary* disruption your app tolerates. Node drains use the eviction API; the drain **blocks** until evicting a pod wouldn't violate your PDB.

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payments
spec:
  maxUnavailable: 1          # or minAvailable: 2 — pick one style
  selector:
    matchLabels:
      app: payments
```

With 3 replicas and `maxUnavailable: 1`, a drain evicts one pod, waits for its replacement to become Ready elsewhere, then the next drain (or the same drain hitting your second pod) can proceed. Rolling cluster upgrades become invisible to your users.

PDBs guard **voluntary** disruptions only: drains, eviction API calls, descheduler. They do nothing against node crashes, OOMKills, or your own rolling updates (those are governed by `maxUnavailable` in the [Deployment strategy](/workloads/rollouts-and-rollbacks/)).

:::danger[A bad PDB is how you end up on the platform team's blocklist]
These configurations **block node drains indefinitely**:

- `minAvailable: 1` with `replicas: 1` — zero disruptions allowed, ever.
- `maxUnavailable: 0` — same, explicitly.
- Any PDB whose selected pods are permanently NotReady — an unhealthy pod counts against the budget, so the drain can never make progress.

The platform team's upgrade automation will stall on your namespace, and eventually a human will either page you or force-delete your pods — worst of both worlds. Rule of thumb: **never create a PDB that allows zero disruptions.** If you have 1 replica, the fix is 2 replicas, not a PDB. See [working with the platform team](/operations/working-with-platform-team/).
:::

Check your budget's arithmetic actually allows movement:

```console
$ kubectl get pdb payments
NAME       MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
payments   N/A             1                 1                     12d
```

`ALLOWED DISRUPTIONS: 0` on a healthy day means you've built a drain-blocker.

## Spreading pods: anti-affinity and topologySpreadConstraints

The scheduler will happily put all 3 of your replicas on one node if that's where the space is. You have to ask for spread.

**Pod anti-affinity** — "don't put me next to my own kind":

```yaml
spec:
  template:
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: payments
                topologyKey: kubernetes.io/hostname
```

- `preferredDuringScheduling...` — best effort. Scheduler spreads when it can, co-locates when it must. **Use this by default.**
- `requiredDuringScheduling...` — hard rule. With 3 replicas and required hostname anti-affinity, you need 3 schedulable nodes with room, *including during rollout surge and drains*. On a small or busy cluster this manifests as [Pending pods](/troubleshooting/pod-pending/) at the worst possible time. Reserve `required` for the cases where co-location is genuinely catastrophic.

**topologySpreadConstraints** — the newer, more expressive tool, and better at "spread evenly" (anti-affinity only expresses "not together"):

```yaml
spec:
  template:
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway     # soft
          labelSelector:
            matchLabels:
              app: payments
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: payments
```

This says: keep the pod-count difference between zones ≤ 1 and between nodes ≤ 1, but schedule anyway if impossible. `whenUnsatisfiable: DoNotSchedule` is the hard variant, with the same Pending-pod risks as required anti-affinity.

:::tip
Zone spread only helps if the cluster actually spans zones — `kubectl get nodes -L topology.kubernetes.io/zone` will tell you (node listing is usually readable even with namespace-scoped access; if not, ask your platform team what the topology looks like).
:::

## priorityClassName

PriorityClasses are cluster-scoped — the platform team defines them; you reference one:

```yaml
spec:
  template:
    spec:
      priorityClassName: business-critical
```

Priority matters in two moments: when the scheduler must **preempt** lower-priority pods to place yours, and when the kubelet chooses **eviction victims** under node pressure (alongside [QoS](/workloads/resources-and-qos/)). Find out what classes exist (`kubectl get priorityclass` if you're allowed, otherwise ask) and use the one your service tier deserves. Don't self-promote to the highest class "just in case" — platform teams notice, and preemption cuts both ways.

## Graceful shutdown: the part everyone skips

Every drain, rollout, and scale-down delivers SIGTERM to your containers. What happens next is the difference between zero dropped requests and a spike of 502s on every deploy.

The termination sequence:

1. Pod is marked Terminating; it's removed from Service endpoints — **in parallel**, not before anything else.
2. `preStop` hook runs (if defined), then SIGTERM goes to PID 1 of each container.
3. After `terminationGracePeriodSeconds` (default 30) from the start of termination, SIGKILL.

The race in step 1 is the classic wound: kube-proxy on every node must observe the endpoint removal, and that takes hundreds of milliseconds to a few seconds. If your app exits instantly on SIGTERM, it dies while nodes are still routing new connections to it. The boring, bulletproof fix is a short sleep:

```yaml
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 45
      containers:
        - name: payments
          lifecycle:
            preStop:
              exec:
                command: ["sh", "-c", "sleep 8"]
```

The sleep holds the pod alive-and-serving while endpoint removal propagates; *then* SIGTERM arrives and your app drains in-flight requests. Requirements on the app side:

- **Actually handle SIGTERM**: stop accepting new connections, finish in-flight work, exit. Most frameworks have this (Spring `server.shutdown=graceful`, Go `http.Server.Shutdown`); it's usually not on by default.
- **Make sure SIGTERM reaches your process.** If your entrypoint is `sh -c "java -jar app.jar"`, the shell is PID 1 and shells don't forward signals — your app gets no SIGTERM, just a SIGKILL 30s later. Use exec-form ENTRYPOINT or `exec` in the wrapper script.
- **Size the grace period honestly**: preStop sleep + worst-case request drain + buffer. A 60s long-poll endpoint with a 30s grace period drops connections on every single deploy.

:::caution
`terminationGracePeriodSeconds` is a *ceiling*, not a delay — exiting early is fine and normal. But note that drains and rollouts wait for the pod to actually die, so a 300s grace period on a slow-exiting app makes every deploy and every node drain crawl.
:::

## The drain-survival checklist

Before you claim a service is HA, verify:

```console
$ kubectl get deploy payments -o jsonpath='{.spec.replicas}'          # ≥ 2
$ kubectl get pdb -l app=payments                                     # exists, ALLOWED DISRUPTIONS ≥ 1
$ kubectl get pods -l app=payments -o wide                            # not all on one node
```

- [ ] replicas ≥ 2 (3+ with an SLO)
- [ ] PDB exists and allows at least 1 disruption at all times
- [ ] Soft anti-affinity or topology spread across hostname (and zone if available)
- [ ] preStop sleep + real SIGTERM handling + honest grace period
- [ ] [Readiness probe](/workloads/health-checks/) that reflects actual serving ability
- [ ] Rollout strategy that doesn't dip below your capacity floor

Do all six and cluster upgrade night becomes somebody else's problem — which is exactly where you want it.
