---
title: Resource Tuning in Prod
description: Changing CPU and memory requests/limits on live workloads — evidence first, rolling-restart planning, JVM coordination, and in-place resize on newer clusters.
sidebar:
  order: 6
---

Requests and limits are the fields you'll retune most often over a service's life — and they're uniquely easy to get wrong live, because a resource change looks like a metadata tweak but behaves like a deploy. This article is the safe procedure.

:::tip[Sizing from scratch?]
This article covers changing resources on a LIVE workload safely. For deriving the numbers in the first place, work through the [Sizing Walkthrough](/tuning/sizing-walkthrough/) and the [Knobs & Levers references](/tuning/overview/).
:::

## First fact: it's a rolling restart

`resources` lives inside the pod template. Change it — by `kubectl edit`, `kubectl patch`, or `kubectl set resources` — and the Deployment controller performs a full rolling update:

```bash
kubectl set resources deployment/payments -c payments \
  --requests=cpu=500m,memory=1Gi --limits=memory=2Gi
deployment.apps/payments resource requirements updated

kubectl rollout status deployment/payments
```

That means everything a deploy means: surge pods need quota and node capacity, readiness gates traffic, caches go cold, and if the service is fragile under churn you've just added churn during whatever incident prompted the tuning. **Plan it like a deploy** — check `kubectl get pdb`, watch `rollout status`, and don't retune three services simultaneously. (Exception: in-place resize, below.)

:::note[CPU limits: consider not having them]
This article covers *how* to change values, but the perennial *what*: memory limits are near-mandatory (they bound blast radius), while CPU limits cause throttling and are often better omitted if your platform team's policy allows, letting requests govern scheduling. The full argument is in [Resources and QoS](/workloads/resources-and-qos/) — including how changing requests/limits can silently change your QoS class and eviction priority.
:::

## Evidence before edits

Resource tuning by vibes ("double it") wastes quota going up and causes incidents going down. Spend ten minutes gathering data.

**Instantaneous usage** — fine for "is it on fire right now", useless for sizing:

```bash
kubectl top pod -l app=payments --containers
POD                        NAME       CPU(cores)   MEMORY(bytes)
payments-7d4b9c5f6-x2k1p   payments   412m         1417Mi
payments-7d4b9c5f6-9qwzr   payments   388m         1362Mi
```

**History and percentiles** — what you actually size against. `kubectl top` has no memory of yesterday; Prometheus does (see [Metrics](/observability/metrics/) for the stack). The queries that matter:

```text
# Working-set memory, p99 over 7 days — size your limit against this, not the average
quantile_over_time(0.99, container_memory_working_set_bytes{pod=~"payments-.*",container="payments"}[7d])

# CPU throttling — the smoking gun for a too-low CPU limit
rate(container_cpu_cfs_throttled_periods_total{pod=~"payments-.*"}[5m])
  / rate(container_cpu_cfs_periods_total{pod=~"payments-.*"}[5m])
```

These two — and the rest of the consumed-vs-requests-vs-limits repertoire — are worked through in detail in [PromQL for CPU and Memory](/observability/promql-for-resources/).

Rules of thumb from the trenches:

- **Memory limit**: p99 working set over a representative window (include batch peaks, month-end, Monday mornings) plus 20–30% headroom. Memory limit breach = OOM kill, so headroom is cheap insurance.
- **Memory request** ≈ typical working set — this is what the scheduler reserves and what your quota pays for.
- **CPU request**: p95-ish of sustained usage. CPU is compressible; a burst above request just contends, it doesn't kill anything.
- **Throttle ratio above ~5–10%** with a CPU limit set means the limit is taxing your latency. Raise it or remove it.
- Check `kubectl get events --field-selector reason=OOMKilling` history and restart counts before trusting any "memory usage" graph — a container that keeps dying never shows you its true peak. See [OOMKilled](/troubleshooting/oomkilled/).

## JVM apps: coordinate the two knobs

For Java workloads, the container limit and the heap ceiling are **two separate settings that must move together**. Raising the container memory limit does nothing for a JVM whose `-Xmx` still caps the heap at the old size — you've bought RAM the process refuses to use. Worse, raising `-Xmx` *without* raising the limit walks the JVM straight into an OOM kill, because heap is only part of JVM footprint (metaspace, threads, code cache, direct buffers ride on top).

The maintainable pattern is percentage-based, so one knob (the limit) drives both:

```yaml
resources:
  limits:
    memory: 2Gi
env:
  - name: JAVA_TOOL_OPTIONS
    value: "-XX:MaxRAMPercentage=75.0"
```

The JVM sees the cgroup limit and sizes the heap to 75% of it, leaving 25% for everything else — adjust the ratio for thread-heavy or off-heap-heavy apps. If your app uses explicit `-Xmx`, every limit change is a two-field change; make them in the same edit and the same PR. Full treatment (including container-awareness flags and how to verify what the JVM actually computed) in [JVM in containers](/java/jvm-in-containers/).

## In-place pod resize (no restart) — on new enough clusters

Kubernetes 1.27 introduced in-place pod vertical scaling (alpha), 1.33 promoted it to **beta and on by default**, and it went stable in 1.35. If your cluster is new enough, you can change a *pod's* CPU and memory without recreating it, via the `resize` subresource:

```bash
# Does my cluster support it? Check the server minor version first
kubectl version
Server Version: v1.35.1

kubectl patch pod payments-7d4b9c5f6-x2k1p --subresource resize -p \
  '{"spec":{"containers":[{"name":"payments","resources":{"limits":{"memory":"3Gi"}}}]}}'
```

Sharp edges — this is *not* a general replacement for the rolling update yet:

- **It's per-pod.** The Deployment template is unchanged, so replacement pods get the old values. In-place resize is an *incident bridge* (relieve memory pressure on live pods right now), not the tune itself.
- **Restart-free only for some changes.** Each container declares `resizePolicy`; memory-limit *decreases* and anything marked `RestartContainer` still restart the container. CPU changes are generally restart-free.
- **Node capacity gates it.** A resize the node can't fit leaves the pod in a `Deferred`/`Infeasible` resize state — check `kubectl describe pod` conditions.
- **RBAC**: patching `pods/resize` is its own permission; you may need to ask your platform team for it.

The play during an OOM incident on a 1.33+ cluster: resize the live pods to stop the bleeding, then make the same change on the Deployment (rolling update) and in git. Three layers — pod, controller, pipeline — all have to agree before you're done.

## Quota headroom: check before you raise

Your namespace almost certainly has a ResourceQuota. Raising requests across N replicas can push you over it, and the failure is quiet: new pods just stop being schedulable, mid-rollout.

```bash
kubectl describe resourcequota
Name:            team-shop-quota
Resource         Used    Hard
--------         ----    ----
limits.memory    18Gi    24Gi
requests.cpu     5500m   8
requests.memory  12Gi    16Gi
```

Arithmetic before the edit: going from `requests.memory: 1Gi` to `1.5Gi` on 8 replicas adds 4Gi → `Used` becomes 16Gi of 16Gi — and the rollout's *surge pod* needs more, so it wedges. Symptoms of a quota-blocked rollout: new ReplicaSet stuck below desired count, and a `FailedCreate` event on it citing `exceeded quota`:

```console
$ kubectl describe rs payments-84c7f5d9b | tail -3
  Warning  FailedCreate  12s  replicaset-controller  Error creating: pods "payments-84c7f5d9b-" is
  forbidden: exceeded quota: team-shop-quota, requested: requests.memory=1536Mi,
  used: requests.memory=16Gi, limited: requests.memory=16Gi
```

The rollout hangs rather than fails loudly — check [Pod Pending](/troubleshooting/pod-pending/) triage, and if the quota itself is the blocker, that's a platform-team request with your Prometheus evidence attached ([Working with the platform team](/operations/working-with-platform-team/) has the template).

Also check for a **LimitRange** in the namespace: it can impose per-container maximums (your new limit may simply be rejected at admission) and it *silently injects defaults* into containers that don't set requests/limits at all. If a container you never configured shows resource values, that's the LimitRange — and it means "just delete the limits" is not a tuning option in that namespace.

```bash
kubectl describe limitrange
Name:       team-shop-limits
Type        Resource  Min   Max   Default Request  Default Limit
----        --------  ---   ---   ---------------  -------------
Container   memory    32Mi  4Gi   256Mi            512Mi
```

## The drift warning

Resource fields are the single most common victims of the clobber described in [Drift and CI/CD](/operations/drift-and-cicd/): tuned live during an incident, silently reverted by the next deploy, incident reruns at peak hours. Resource tuning is *rarely* so urgent that you can't do it through git — a values change and a pipeline run is often 15 minutes. If you do tune live:

1. Make the live change (Deployment-level, not just pod-level).
2. Open the PR that mirrors it **in the same sitting**.
3. Annotate the resource with the incident ID so the drift is discoverable.

And if you find yourself retuning the same service monthly, stop hand-tuning: ask whether VPA in recommendation mode (`updateMode: "Off"` — it computes suggestions without acting) is available on your cluster, and consider whether the real fix is [autoscaling](/workloads/autoscaling/) rather than a bigger static number.

## Checklist

```text
□ Evidence: p99 working set, throttle ratio, OOM history (7+ days incl. peaks)
□ Quota headroom for new requests × replicas + surge
□ JVM? Heap setting moves with the limit (or MaxRAMPercentage already handles it)
□ PDB status checked; rollout planned, one service at a time
□ Change made on the Deployment (and pod resize only as a bridge)
□ PR opened mirroring the change — same sitting
□ rollout status watched to completion; top/metrics rechecked after
```
