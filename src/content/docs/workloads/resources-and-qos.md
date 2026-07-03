---
title: Resources and QoS
description: Requests vs limits precisely, QoS classes and eviction order, detecting CPU throttling, and a sizing methodology that survives contact with production.
sidebar:
  order: 7
---

Requests and limits are four small numbers that decide where your pods run, who gets killed under pressure, and whether your p99 latency has a mysterious sawtooth. Most teams set them once by copy-paste and never revisit. Let's do better.

## Requests vs limits: two different machines

```yaml
resources:
  requests:
    cpu: 500m        # scheduling: reserved on the node for this container
    memory: 512Mi
  limits:
    cpu: "1"         # enforcement: CFS throttling above this
    memory: 512Mi    # enforcement: OOMKill above this
```

**Requests are a scheduling promise.** The scheduler places a pod only on a node whose *unreserved* capacity (allocatable minus the sum of existing requests — not actual usage) covers the pod's requests. After placement, requests also set the container's CPU weight (`cpu.weight` in cgroups): under CPU contention, containers share the node proportionally to their requests. Requests are never a cap — a container with `cpu: 100m` requested can happily burn 4 cores on an idle node.

**Limits are runtime enforcement**, and CPU and memory enforce very differently:

- **CPU limit** → throttling. The kernel's CFS quota gives your container `limit × period` of CPU time per period (default 100ms). Use it up in the first 40ms and your threads sit frozen for the remaining 60ms — even if the node is otherwise idle. CPU limits never kill anything; they add latency.
- **Memory limit** → the OOM killer. Exceed it and the kernel kills the process; the kubelet restarts the container with reason `OOMKilled`. There's no throttling for memory — it's a cliff. The full anatomy is in [OOMKilled](/troubleshooting/oomkilled/).

:::note
Requests without limits: legal, common, often correct for CPU. Limits without requests: the request silently defaults **to the limit** — a frequent source of accidentally huge requests and unschedulable pods.
:::

## QoS classes and who dies first

Kubernetes assigns every pod a QoS class from its resource spec:

| Class | Criteria | Under node memory pressure |
|---|---|---|
| **Guaranteed** | Every container has requests == limits for both CPU and memory | Evicted last |
| **Burstable** | At least one request or limit set, but not Guaranteed | Middle — eviction favors pods using most over their memory *request* |
| **BestEffort** | No requests, no limits, anywhere in the pod | First against the wall |

```console
$ kubectl get pod payments-7d9f8b6c4d-x2kfp -o jsonpath='{.status.qosClass}'
Burstable
```

When a node runs short on memory, the kubelet evicts pods to save itself: BestEffort first, then Burstable pods consuming furthest above their memory requests. Separately, if things move too fast for the kubelet, the kernel OOM killer picks victims with a score derived from QoS. Either way, the practical takeaway is the same: **a pod with an honest memory request is dramatically safer than one without.** BestEffort in production is volunteering to be shot first.

Priority classes interact here too — see [high availability](/workloads/high-availability/) — but QoS is the lever you fully control.

## My recommended defaults

After enough incident retros, I've settled on:

- **Memory: requests == limits.** Memory isn't compressible; "bursting" into memory you might not get is how you meet the OOM killer at 2 a.m. Equal values give predictability and better QoS treatment.
- **CPU: set requests honestly, skip the limit** (or set it high). CPU throttling buys you almost nothing on a well-scheduled node and costs real latency. Requests already guarantee fair sharing under contention.

The caveat: some platform teams **mandate CPU limits** via policy or LimitRange (multi-tenant fairness, chargeback). If so, set the limit at 2–4× the request and watch throttling metrics — don't fight the policy, measure its cost and negotiate with data.

## Detecting CPU throttling

Throttling is invisible in `kubectl top` — usage looks modest while your latency burns. The evidence lives in the container's cgroup:

```console
$ kubectl exec payments-7d9f8b6c4d-x2kfp -- cat /sys/fs/cgroup/cpu.stat
usage_usec 8123456789
nr_periods 8421103
nr_throttled 96411
throttled_usec 5183329112
```

`nr_throttled / nr_periods` is your throttle ratio — here ~11% of periods hit the quota wall, and `throttled_usec` says threads spent ~86 minutes cumulatively frozen. Anything over a few percent on a latency-sensitive service is worth acting on. (Older nodes with cgroup v1 expose the same counters at `/sys/fs/cgroup/cpu/cpu.stat`.)

If Prometheus scrapes cadvisor (it almost always does), the same data is queryable without exec:

```text
rate(container_cpu_cfs_throttled_periods_total{pod=~"payments-.*"}[5m])
  / rate(container_cpu_cfs_periods_total{pod=~"payments-.*"}[5m])
```

Multi-threaded runtimes get burned worst: a JVM with 8 runnable threads and `limits.cpu: 1` can consume its entire 100ms quota in ~12ms of wall time, then stall. GC pauses stretch, [startup crawls, probes time out](/workloads/health-checks/). If you run Java, read [JVM in containers](/java/jvm-in-containers/) before setting any CPU limit.

## Sizing methodology

Guessing produces either waste (requests too high — you hog quota and the scheduler strands capacity) or fragility (too low — throttling, eviction-bait, [HPA thrash](/workloads/autoscaling/)). Do this instead:

1. **Start deliberately generous** in a non-prod environment: e.g., `cpu: 500m` request, memory request = your best estimate × 1.5, memory limit = request.
2. **Apply realistic load** — not a hello-world ping. Production-shaped traffic, including the nasty endpoints.
3. **Measure over days, not minutes.** From Prometheus:
   - CPU request → around your **p95–p99** usage (`quantile_over_time` on `rate(container_cpu_usage_seconds_total[5m])`). Not the mean — the mean starves you at peak.
   - Memory request/limit → **peak** `container_memory_working_set_bytes` (that's the OOM-relevant number) plus 20–30% headroom.
4. **Watch the failure signals** after tightening: throttle ratio, `OOMKilled` restarts (`kubectl get pods -o wide` RESTARTS column, then `describe` for the reason), eviction events.
5. **Re-measure quarterly and after big releases.** Sizing rots. A new dependency or cache changes your memory profile overnight.

For a quick point-in-time read:

```console
$ kubectl top pod -l app=payments --containers
POD                         NAME       CPU(cores)   MEMORY(bytes)
payments-7d9f8b6c4d-x2kfp   payments   212m         438Mi
payments-7d9f8b6c4d-9qwlm   payments   198m         441Mi
```

`kubectl top` is a 30-second gauge — fine for triage, useless for sizing. Size from history in your [metrics stack](/observability/metrics/).

## LimitRanges and ResourceQuotas: the house rules

The platform team can (and usually does) constrain your namespace with two objects. You can't change them, but you can — and should — read them:

```console
$ kubectl get limitrange,resourcequota -n team-checkout
$ kubectl describe resourcequota team-checkout-quota
Name:            team-checkout-quota
Resource         Used   Hard
--------         ----   ----
limits.memory    12Gi   16Gi
pods             14     30
requests.cpu     3500m  8
requests.memory  9Gi    12Gi
```

**LimitRange** acts per-object at admission: it injects default requests/limits into containers that don't set them, and rejects pods whose values fall outside min/max. If your pods have requests you never wrote, a LimitRange default is why.

**ResourceQuota** caps namespace totals: sum of requests, sum of limits, object counts. Two gotchas earn their scars:

- Once a quota covers `requests.cpu` or `requests.memory`, **every pod in the namespace must set those requests** or it's rejected at admission with `failed quota` — including Job pods and that quick debug pod you tried to run.
- Quota exhaustion errors surface at pod *creation*, so a Deployment update just quietly fails to make progress. The message hides in the ReplicaSet's events, not the Deployment's or pod's (there is no pod):

```console
$ kubectl describe rs payments-85f6c9d7b8 | tail -3
  Warning  FailedCreate  41s  replicaset-controller  Error creating: pods "payments-85f6c9d7b8-" is
  forbidden: exceeded quota: team-checkout-quota, requested: requests.memory=512Mi,
  used: requests.memory=11776Mi, limited: requests.memory=12288Mi
```

Remember [rollout surge](/workloads/rollouts-and-rollbacks/) needs quota headroom too — a namespace sized for exactly N replicas can't roll with `maxSurge: 1`. If your honest measurements say the quota itself is too small, bring the data to your [platform team](/operations/working-with-platform-team/); a graph of real usage against quota is a conversation, a Slack message saying "we need more" is a ticket that ages.

## Quick triage crib sheet

When resources are the suspect, these five commands cover 90% of it:

```console
# Is anything getting killed or restarted, and why?
$ kubectl get pods -l app=payments
$ kubectl describe pod <pod> | grep -B2 -A6 "Last State"
    Last State:     Terminated
      Reason:       OOMKilled
      Exit Code:    137

# What is it using right now vs what it asked for?
$ kubectl top pod <pod> --containers
$ kubectl get pod <pod> -o jsonpath='{range .spec.containers[*]}{.name}: req={.resources.requests} lim={.resources.limits}{"\n"}{end}'

# Is CPU being throttled?
$ kubectl exec <pod> -- cat /sys/fs/cgroup/cpu.stat | grep -E 'nr_(periods|throttled)'

# Is the namespace out of quota?
$ kubectl describe resourcequota
```

Map the finding to the fix: `OOMKilled` → [oomkilled runbook](/troubleshooting/oomkilled/); high throttle ratio → raise or remove the CPU limit; `exceeded quota` in ReplicaSet events → free headroom or negotiate the quota; pods Pending with `Insufficient cpu/memory` → your requests don't fit any node, see [pod-pending](/troubleshooting/pod-pending/). Changing any of these values means a pod-template change and therefore a rolling restart — plan resource tuning like a deploy, not a tweak; [resource tuning in prod](/operations/resource-tuning-in-prod/) covers doing it safely.
