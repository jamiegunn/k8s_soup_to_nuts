---
title: Cost and Rightsizing
description: FinOps from the app-team seat — why you're billed on requests not usage, the waste taxonomy with PromQL detection queries, reading showback numbers without arguing about them, and the quarterly rightsizing ritual.
keywords:
  - finops
  - requests vs usage
  - opencost kubecost
  - showback chargeback
  - resource slack
  - over-provisioned cpu
  - orphaned pvc
  - vpa recommendation mode
  - minreplicas too high
  - scale dev to zero at night
  - reserved but idle capacity
  - namespace resourcequota
sidebar:
  order: 14
---

Here is the sentence that reframes every Kubernetes cost conversation you will ever have: **in a shared cluster, you are billed — or capacity-managed, which is the same thing with extra steps — on what you *request*, not what you *use*.**

The scheduler doesn't care that your service idles at 80 millicores. When your pod declares `requests.cpu: "2"`, the scheduler carves two full cores out of a node and marks them spoken for. No other tenant's pod can be placed against that capacity, ever, for as long as your pod exists. The platform team has to buy nodes to back the sum of everyone's requests — [that's literally what scheduling is](/workloads/scheduling/): bin-packing requests onto machines. Whether the reserved capacity does work or sits idle changes your electricity contribution by rounding error; the node was provisioned either way.

This is why the most common cost-review defense — "but look, our usage graph is tiny!" — lands so badly. Of course your usage graph looks innocent. Usage was never the problem. A service requesting 4 CPU and using 0.2 is, from the cluster's accounting perspective, a 4-CPU service that happens to be 95% wasted. The [requests-and-QoS model](/workloads/resources-and-qos/) means the reservation is the cost; the usage is trivia.

:::note[Quota is billing with a different currency]
Even if your org doesn't do chargeback in dollars, your namespace ResourceQuota is denominated in requests. Over-requesting burns the same finite budget — you just pay in "sorry, quota exceeded" during your next scale-up instead of on an invoice.
:::

Once you internalize requests-are-the-bill, everything below is mechanical: find where requests exceed reality, close the gap safely, and stop recreating it.

:::note[The resources family]
These pages share this territory, each with one job: [Resources and QoS](/workloads/resources-and-qos/) (concepts), [Requests & Limits Knobs](/tuning/requests-limits-knobs/) (the dials), [Sizing Walkthrough](/tuning/sizing-walkthrough/) (greenfield) and [Running Fleet](/tuning/brownfield-resources/) (brownfield), [Resource Tuning in Prod](/operations/resource-tuning-in-prod/) (changing live workloads safely). Version-sensitive claims (in-place resize: beta 1.33, stable 1.35) are owned by the knobs page.
:::

## The waste taxonomy

Five patterns account for nearly all tenant-side waste. Each has a detection query — the query patterns are explained in depth in [PromQL for resources](/observability/promql-for-resources/); here they're aimed at money.

### 1. Requests ≫ actual usage (slack)

The big one, usually 60–80% of a namespace's waste. Someone sized the service during a load test two years ago, or copied a manifest from a heavier service, or "doubled it to be safe" three times in a row. Detection: compare requests against p95–p99 of real usage over a representative window (a week minimum — you want to catch the Monday spike).

```promql
# CPU slack per workload: requested minus p99-of-usage, in cores
sum by (workload) (
  kube_pod_container_resource_requests{namespace="shop", resource="cpu"}
  * on (pod) group_left(workload) namespace_workload_pod:kube_pod_owner:relabel
)
-
quantile_over_time(0.99,
  sum by (workload) (
    rate(container_cpu_usage_seconds_total{namespace="shop"}[5m])
    * on (pod) group_left(workload) namespace_workload_pod:kube_pod_owner:relabel
  )[7d:5m]
)
```

Anything where that difference is more than ~40% of the request is a rightsizing candidate.

### 2. Memory limits ≫ requests (the illusion)

`requests.memory: 512Mi, limits.memory: 4Gi` *feels* like frugality — small reservation, big ceiling. It's actually a Burstable-QoS trap: your pod routinely uses 2Gi of memory the scheduler never reserved, which means it's running on capacity borrowed from other tenants' unfulfilled requests, and it's first in line for eviction when the node gets tight. For memory, honest sizing means requests near real usage and limits close to requests — the [knobs article](/tuning/requests-limits-knobs/) covers why memory is not compressible and why this gap bites. Cost-wise: if you genuinely use 2Gi, you cost 2Gi; requesting 512Mi didn't make you cheaper, it made you dishonest and evictable.

### 3. Replicas > needed at trough

The HPA `minReplicas` set by fear. Someone got paged during a traffic spike once, raised `minReplicas` from 2 to 6, and now six pods' worth of requests sit reserved through every night and weekend. Detection: compare replica count against what the [HPA](/workloads/autoscaling/) would actually choose at your traffic trough.

```promql
# Do we ever get near minReplicas? If desired == min for days, min is too high.
kube_horizontalpodautoscaler_status_desired_replicas{namespace="shop"}
- on (horizontalpodautoscaler)
kube_horizontalpodautoscaler_spec_min_replicas{namespace="shop"}
```

If that's zero for 90% of the week, the HPA is pinned at the floor — the floor *is* your sizing, and it was chosen by adrenaline.

### 4. Abandoned namespaces and PVCs

Storage is forever until someone deletes it. A PersistentVolumeClaim outlives the Deployment that used it, the engineer who created it, and sometimes the project itself — [PVC lifecycle](/stateful/storage-pv-pvc/) means that 500Gi of SSD keeps billing monthly with zero pods attached. Detection is embarrassingly easy:

```console
$ kubectl get pvc -n shop -o custom-columns=NAME:.metadata.name,SIZE:.spec.resources.requests.storage,STATUS:.status.phase
NAME                    SIZE    STATUS
postgres-data-0         100Gi   Bound
loadtest-scratch-2023   500Gi   Bound     # <- nothing has mounted this since 2023
```

Cross-reference with `kubectl get pods -n shop -o jsonpath='{.items[*].spec.volumes[*].persistentVolumeClaim.claimName}'` — any Bound PVC not in that list is a candle burning in an empty room.

### 5. Dev environments running weekends

Your dev and staging namespaces request capacity 168 hours a week and are used maybe 50. That's a 70% discount waiting for a CronJob (below).

## The PromQL cost pack

Four queries to keep in a dashboard. They answer "where does the money go" before anyone asks.

```promql
# 1. Namespace request-hours (the thing you're actually billed on) — CPU core-hours/day
sum by (namespace) (
  kube_pod_container_resource_requests{resource="cpu"}
) * 24

# 2. Slack ratio: fraction of requested CPU doing nothing (0 = perfect, 1 = pure waste)
1 - (
  sum by (namespace) (rate(container_cpu_usage_seconds_total{container!=""}[1h]))
  /
  sum by (namespace) (kube_pod_container_resource_requests{resource="cpu"})
)

# 3. Top-10 slack workloads by absolute reserved-but-idle cores
topk(10,
  sum by (namespace, workload) (
    kube_pod_container_resource_requests{resource="cpu"}
    * on (pod) group_left(workload) namespace_workload_pod:kube_pod_owner:relabel
  )
  - sum by (namespace, workload) (
    rate(container_cpu_usage_seconds_total{container!=""}[1h])
    * on (pod) group_left(workload) namespace_workload_pod:kube_pod_owner:relabel
  )
)

# 4. PVC allocated vs actually used
sum by (namespace, persistentvolumeclaim) (kubelet_volume_stats_capacity_bytes)
- sum by (namespace, persistentvolumeclaim) (kubelet_volume_stats_used_bytes)
```

Run the same pack for `resource="memory"` with `container_memory_working_set_bytes`. Memory slack is usually smaller in ratio but pricier per unit.

What the top-10 query typically surfaces the first time anyone runs it:

```console
$ promtool query instant http://prometheus:9090 'topk(10, ...)'   # query 3 above
{namespace="shop", workload="recommendation-engine"}  => 14.2   # 16 requested, ~1.8 used
{namespace="shop", workload="legacy-import-worker"}   => 7.6    # "temporary", deployed 2024
{namespace="shop-dev", workload="shop-web"}           => 5.9    # dev sized same as prod
{namespace="shop", workload="shop-web"}               => 3.1
...
```

Note the pattern: the top entries are almost never your flagship service. They're the sidecar-heavy batch thing someone sized "like prod," the temporary worker that outlived its author, and dev environments that inherited production requests wholesale. The flagship gets attention; the waste hides where nobody looks.

Translating to money for the conversation with your manager: at a typical ~$25–35/core-month all-in for on-demand cloud capacity, that `recommendation-engine` line alone is roughly $400–500/month of reserved-and-idle CPU — before memory, before the idle-cost smearing described next.

## Showback and chargeback: reading the bill

Most platform teams run OpenCost or Kubecost to allocate cluster spend to namespaces. Two things about those numbers confuse every new tenant:

- **Idle cost allocation.** The cluster is never 100% packed; someone has to eat the cost of unallocated node capacity. Many configs smear idle cost across tenants proportionally to their requests. So your bill can be *higher* than your requests × unit price — you're paying your share of the empty seats too. This is a policy choice, not an error.
- **Shared-cost smearing.** Control plane, monitoring stack, ingress controllers, the platform team's own tooling — allocated across tenants by some formula (evenly, by request share, by namespace label). Again: policy, not arithmetic you can dispute line-by-line.

The strategic advice: **don't argue the bill; fix the slack.** Arguing allocation methodology with the platform team burns goodwill over the 15% you can't control. Cutting your slack ratio from 0.7 to 0.3 changes the 85% you do control, and it changes it on *every* future bill. If the methodology genuinely seems broken, that's a calm [platform-team conversation](/operations/working-with-platform-team/) with query output attached, not a bill dispute.

## The rightsizing ritual

Quarterly, one hour per service. This is the [sizing walkthrough](/tuning/sizing-walkthrough/) condensed to its cost framing:

1. **Measure** — p50, p99, and max of CPU and memory usage over the last 30 days (query pack above, or your existing dashboards).
2. **Compare** — usage percentiles against current requests. Slack over 40%? Candidate.
3. **Propose** — new request = p99 usage + headroom (typically 20–30% CPU, 10–20% memory, more if the service has known burst patterns the window missed).
4. **Change one thing** — through your normal deploy pipeline, one service at a time, following [production tuning discipline](/operations/resource-tuning-in-prod/): change, watch a full traffic cycle, then the next one.
5. **Record why** — a comment in the manifest (`# sized 2026-07: p99=310m over 30d, +30% headroom`) so the next person doesn't re-derive or fear-double it.

If your cluster runs VPA in recommendation mode, `kubectl describe vpa <name>` hands you step 3 pre-computed (the `target` and `upperBound` values) — treat it as a second opinion on your percentile math, not a replacement for looking at the graph. VPA doesn't know about the quarterly batch job your window missed; you do.

:::caution[The safety rule]
**Never cut below p99 + headroom to save money.** The failure math is lopsided: memory slack costs a few dollars a day, quietly; an OOMKill storm costs an incident, a rollback, a retro, and every future sizing conversation being had in the shadow of "remember when we cut memory and it blew up." Under-sizing memory doesn't produce a smaller bill — it produces [CrashLoopBackOff with a receipt](/tuning/requests-limits-knobs/). Take the safe 40% cut on the over-provisioned service; leave the tight one alone.
:::

## Cheap wins, ranked by effort-to-savings

**1. HPA minReplicas honesty.** A one-line change. If desired replicas sits at the floor all week, lower the floor and let the [autoscaler](/workloads/autoscaling/) do its job. Keep `minReplicas: 2` for HA; question anything above that. On a fixed shared pool this is a governance norm, not just thrift — [the capacity ledger and quarterly true-up](/autoscaling/capacity-and-governance/) track the floors too.

**2. Dev environments sleep at night.** A CronJob pair that scales dev Deployments to zero at 20:00 and back up at 07:00 weekdays reclaims ~70% of dev request-hours. Complete, working version:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: dev-scale-down
  namespace: shop-dev
spec:
  schedule: "0 20 * * 1-5"        # 20:00 Mon-Fri; add "0 20 * * 6,0" or just leave it down all weekend
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: env-scaler   # needs RBAC: get/list/patch deployments in this namespace only
          restartPolicy: Never
          containers:
          - name: scale
            image: bitnami/kubectl:1.30
            command:
            - /bin/sh
            - -c
            - |
              kubectl scale deployment --all --replicas=0 -n shop-dev
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: dev-scale-up
  namespace: shop-dev
spec:
  schedule: "0 7 * * 1-5"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: env-scaler
          restartPolicy: Never
          containers:
          - name: scale
            image: bitnami/kubectl:1.30
            command:
            - /bin/sh
            - -c
            - |
              kubectl scale deployment --all --replicas=1 -n shop-dev
```

(Scale-to-zero via `kubectl scale` fights with GitOps reconciliation if your CD tool enforces replica counts — coordinate the exclusion window with however your sync works, or use your CD tool's native schedule feature if it has one.)

**3. PVC cleanup policy.** A quarterly sweep of Bound-but-unmounted PVCs, plus a naming convention (`scratch-`, `tmp-`) with an agreed TTL. Deleting a PVC is irreversible, so the ritual is: list candidates, post in the team channel, wait a week, delete.

**4. Right-size, THEN let the platform buy reservations.** Committed-use discounts and reserved instances are the [platform team's lever](/operations/working-with-platform-team/), and they size those commitments off aggregate tenant requests. If everyone's requests carry 50% slack, the platform commits to — and pre-pays for — phantom capacity for one to three years. Your rightsizing quarter directly improves their purchasing math. This is the rare cost initiative where the tenant work and the platform work multiply instead of just adding.

## What NOT to do

**CPU limits as cost control.** Setting a low CPU limit doesn't reduce your reservation, your bill, or the node count — it just throttles your service. Requests drive cost; limits drive latency. A throttled pod costs exactly what an unthrottled pod with the same request costs, plus p99 latency. Throttling isn't savings; it's paying the same price for a worse product.

**Memory-limit roulette.** Shaving memory limits toward observed average usage to "reclaim" capacity. Memory usage isn't a nice smooth line — it's a line with a heap-growth spike hiding at the 30-day horizon. You save cents until the OOMKill, then you spend the savings on the incident. See the safety rule above; it exists because everyone tries this once.

**Per-request cost obsession before the big rocks.** Computing dollars-per-API-call to four decimals while a 500Gi orphaned PVC and a minReplicas-of-8 batch service sit in plain sight. The waste taxonomy above is ordered roughly by typical magnitude for a reason. Slack ratio first, replica floors second, storage third — micro-optimization never, until those are boring.

The whole discipline in one line: request what you measured, plus honest headroom, and re-measure quarterly. Everything else is queries and CronJobs.
