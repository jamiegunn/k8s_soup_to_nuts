---
title: "Requests & Limits Knobs"
description: Every requests-and-limits dial in one reference — precise cgroup semantics, unit traps, CFS throttle math, sizing workflow, and copy-paste recipes per workload archetype.
keywords:
  - oomkilled exit code 137
  - why is my app throttled but cpu looks idle
  - cfs quota bandwidth throttling
  - container_cpu_cfs_throttled_periods_total
  - besteffort burstable guaranteed qos
  - memory 512m milli byte bug
  - limitrange default limits
  - resourcequota exceeded rollout wedge
  - in-place pod resize resizepolicy
  - hpa utilization target percentage of request
  - pod pending insufficient cpu
  - cpu request no limit
sidebar:
  order: 4
---

Requests and limits look like four numbers in a YAML block. They are actually four different control systems wearing one API: a scheduler filter, a proportional-share weight, a hard CPU throttle, and an OOM kill line. Tune them as if they were one thing and you get pods that are simultaneously over-provisioned and getting killed. This is the dial-by-dial reference; for the conceptual grounding, start at [Resources and QoS](/workloads/resources-and-qos/).

:::note[The resources family]
These pages share this territory, each with one job: [Resources and QoS](/workloads/resources-and-qos/) (concepts), [Sizing Walkthrough](/tuning/sizing-walkthrough/) (greenfield) and [Running Fleet](/tuning/brownfield-resources/) (brownfield), [Resource Tuning in Prod](/operations/resource-tuning-in-prod/) (changing live workloads safely), and [Cost and Rightsizing](/operations/cost-and-rightsizing/) (the money lens). Version-sensitive claims (in-place resize: beta since 1.33) are owned by the knobs page.
:::

## The four primary knobs

| Knob | Default | What it actually does | When to turn it | What to watch after |
|---|---|---|---|---|
| `resources.requests.cpu` | none (or LimitRange default) | Scheduler filter (pod only lands on a node with that much unallocated CPU) **and** cgroup `cpu.weight` — your proportional share when the node is contended. **Not a cap.** | Set to honest p95 usage. Raise if you're starved under node contention; lower if you're hoarding quota. | Node bin-packing (`kubectl describe node` allocated %), HPA behavior — utilization targets are % of this number |
| `resources.limits.cpu` | none (or LimitRange default) | CFS bandwidth quota: `limit × 100ms` of CPU time per 100ms period, summed across **all threads**. Exceed it and every thread stalls until the next period — even on an idle node. | Usually: don't. See [the throttling argument](#cpu-honest-request-no-limit). Set for batch, benchmarks, strict multi-tenant fairness. | `container_cpu_cfs_throttled_periods_total` ratio, p99 latency |
| `resources.requests.memory` | none (or LimitRange default) | Scheduler filter, plus input to node-pressure eviction ordering: pods using **more than their request** are evicted first when the kubelet reclaims memory. | Set equal to the memory limit (argued below). | Node allocatable headroom, eviction events |
| `resources.limits.memory` | none (or LimitRange default) | cgroup `memory.max`. Working set touches it → the kernel OOM-kills the container. No throttling, no grace, exit code 137. | p99 working set × 1.2–1.4. Raise on OOMKilled with legitimate growth; investigate before raising twice. | `container_memory_working_set_bytes` vs limit, restart count — see [OOMKilled](/troubleshooting/oomkilled/) |

All four in place, annotated with what each line is actually configuring:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
spec:
  template:
    spec:
      containers:
        - name: payments-api
          image: registry.example.com/payments-api:2.14.1
          resources:
            requests:
              cpu: 400m      # scheduler filter + cgroup cpu.weight (share under contention)
              memory: 1Gi    # scheduler filter + eviction-ordering input
            limits:
              memory: 1Gi    # cgroup memory.max — the OOM kill line
              # cpu: omitted on purpose — no CFS quota, no throttling (argued below)
```

Two asymmetries to internalize, because everything downstream follows from them:

- **CPU is compressible.** Starving a container of CPU makes it slow. So CPU requests are a soft guarantee (weight under contention) and CPU limits are an *optional* hard cap you usually don't want.
- **Memory is incompressible.** You can't make a process "use memory slower." So memory limits are enforced by killing, and memory requests are a promise the scheduler takes literally when placing you.

:::note[Under the hood: cgroup v2 is the enforcer]
Every value in the `resources` block ends up as a file in the container's [cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html) directory. The kubelet turns `requests.cpu` into `cpu.weight` (millicores become the legacy v1 `cpu.shares` value of `milliCPU × 1024 / 1000`, then get mapped onto v2's 1–10000 weight scale), writes `limits.cpu` as a quota/period pair into `cpu.max`, and writes `limits.memory` into `memory.max`. Two consequences fall straight out of the kernel semantics. First, `cpu.weight` is *proportional*: per the [CFS scheduler design](https://docs.kernel.org/scheduler/sched-design-CFS.html), weights only arbitrate when runnable tasks outnumber CPUs — on an uncontended node your weight is irrelevant and you can burn every idle cycle. Second, `cpu.max` and `memory.max` are *absolute*: the kernel enforces them regardless of how bored the rest of the node is.
:::

### Units, and the classic unit bugs

CPU is measured in cores; `1000m` (millicores) = `1` core. Memory is measured in bytes with binary (`Ki`, `Mi`, `Gi`) or decimal (`K`, `M`, `G`) suffixes.

| You wrote | You meant | What Kubernetes read | Outcome |
|---|---|---|---|
| `cpu: 100` | `100m` | 100 **cores** | Pod Pending forever — no node has 100 cores free |
| `cpu: 0.5` | `500m` | 500m (fine) | Works, but mixing decimal and `m` styles across services invites the bug above |
| `memory: 512m` | `512Mi` | 512 **milli**bytes → 0.512 bytes, rounded to `512e-3` | Instant OOMKill or rejected pod. Lowercase `m` on memory is *always* a bug |
| `memory: 512M` | `512Mi` | 512,000,000 bytes | ~488Mi — 5% less than you wanted. Subtle until a JVM heap sized to 512Mi meets it |
| `memory: 1e3Mi` | `1000Mi` | invalid | API rejection at least fails loudly |

:::caution[The half-megabyte disaster]
`memory: 512m` is valid YAML, a valid Kubernetes quantity, and completely wrong. `m` is the milli- SI prefix on *any* resource, so this is 0.512 bytes of memory. The API server accepts it. Your container OOMs on the first `malloc`. Lint for lowercase `m` on memory fields in CI — it's a one-line regex that has paid for itself at every shop I've seen it deployed.
:::

## The derived knob: QoS class

You never set QoS directly — the combination of the four knobs above produces it, and it changes real runtime behavior. Full treatment in [Resources and QoS](/workloads/resources-and-qos/).

| QoS class | You get it when | What it changes |
|---|---|---|
| `Guaranteed` | Every container: requests == limits for **both** CPU and memory | Evicted last under node pressure; top-level cgroup placement; eligible for static CPU-manager core pinning (integer CPU, if the platform enables `static` policy); most restrictive in-place-resize rules |
| `Burstable` | At least one request or limit set, but not fully Guaranteed | Evicted after BestEffort, ordered by usage-over-request; the sane default for most services |
| `BestEffort` | No requests, no limits, anywhere in the pod | First against the wall on node pressure; scheduler places it blind. Almost never what you want in prod |

Check what you actually got — the API server computes it, and injected sidecars change the answer:

```bash
kubectl get pod payments-api-7d9f6b5c4-x2lqp -o jsonpath='{.status.qosClass}'
```

Three practical consequences people miss:

- **One container ruins it for the pod.** A sidecar with no resources block drops the whole pod out of Guaranteed. Audit every container, including injected ones.
- **Guaranteed + integer CPU + static CPU manager = pinned cores.** On platforms that enable it, `cpu: 2` (not `2100m`) in a Guaranteed pod gets dedicated cores. That's a feature for latency-critical work and a surprise for everyone else — ask your platform team what the CPU manager policy is.
- **QoS is immutable in place.** In-place resize (below) can change values but not the resulting QoS class; a resize that would change the class is rejected.

## Recommended defaults, argued

### Memory: request = limit

Set `requests.memory == limits.memory`. The argument: memory is incompressible, so overcommitting it is a bet that pods on the same node won't peak together. When the bet loses, the kubelet evicts pods using more than their request — which, if your request is below your limit, can be *you*, behaving normally, within your limit. Request = limit means the scheduler reserved everything you're allowed to use; there is no "the node ran out but I was under my limit" failure mode. The cost is bin-packing efficiency, and that cost is the platform team's to optimize, not yours to donate unreliability for.

:::note[Under the hood: what "OOM-killed" actually means]
`limits.memory` is the cgroup's `memory.max`. When a process in the container faults in a page and the kernel can't charge it to the cgroup without crossing that line, the kernel first tries to reclaim — dropping the cgroup's page cache, swapping if allowed. Only when reclaim can't free enough does the [cgroup-scoped OOM killer](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory) fire, pick a victim *inside* the cgroup, and SIGKILL it — that's the exit code 137, and it's why there's no grace period: the process never gets a signal it can handle. On cgroup v2 the kubelet sets `memory.oom.group=1` (since Kubernetes 1.28), so the kill takes the container's *entire* cgroup — every process in it — rather than a single victim. Victim selection is biased by each process's `oom_score_adj` (see [proc(5)](https://man7.org/linux/man-pages/man5/proc.5.html)), which the kubelet sets per QoS class — Guaranteed pods get −997, Burstable pods a value scaled by how far usage exceeds request — so when the *node* itself runs out, lower-QoS neighbors die first. The ground truth for "was I OOM-killed?" is the `oom_kill` counter in the cgroup's `memory.events` file; the `OOMKilled` reason in `kubectl describe pod` is downstream of that counter.
:::

### CPU: honest request, no limit

Set `requests.cpu` to real p95 usage and omit `limits.cpu`. The argument:

- The request already guarantees your share under contention via `cpu.weight`. A limit adds nothing to your protection — it only caps your bursts.
- CFS throttling punishes you **even on an idle node**. Spare cycles the node would happily give you are refused because your 100ms allowance is spent (worked example below).
- Latency cost lands exactly where it hurts: cold starts, GC pauses, request spikes — the moments you most want to burst.

The honest counter-argument: on a multi-tenant node, a limitless pod can eat every idle cycle, and neighbors with lazy requests get squeezed. That's real — but the correct fix is *honest requests everywhere* (weights then divide contention fairly), not caps that waste idle CPU. Where the platform can't enforce honest requests, they'll often enforce limits instead:

:::note[Your platform team may have already decided]
Many clusters carry a LimitRange that stamps a default CPU limit onto any container that doesn't set one. Check with `kubectl describe limitrange -n <ns>`. If a default limit appears on your pods, you didn't opt out by omitting the field — you opted *in* to the default. Negotiating an exemption or a saner default is a platform conversation: see [Working with the platform team](/operations/working-with-platform-team/).
:::

### When CPU limits are right

- **Noisy batch:** a Job that will consume any core it can find, sharing nodes with latency-sensitive services. Cap it; nobody cares if the batch takes 40 minutes instead of 35.
- **Strict fairness / chargeback:** multi-tenant platforms billing by allocation want consumption to match it.
- **Benchmarking and capacity tests:** you want reproducible CPU conditions, not "whatever the node had free that day."

### The LimitRange reality check

What a stamping LimitRange looks like from your side of the fence:

```yaml
# kubectl get limitrange -n payments -o yaml (abridged) — platform-owned, read-only to you
apiVersion: v1
kind: LimitRange
metadata:
  name: ns-defaults
spec:
  limits:
    - type: Container
      default:            # stamped onto containers that omit LIMITS
        cpu: 500m
        memory: 512Mi
      defaultRequest:     # stamped onto containers that omit REQUESTS
        cpu: 100m
        memory: 256Mi
      max:                # pods asking for more are REJECTED at admission
        cpu: "4"
        memory: 8Gi
```

With this in place, "I omitted the CPU limit" actually means "I chose `500m`" — the exact throttle trap the next section quantifies. If the default hurts your service class, that's an exemption request, not a workaround: [Working with the platform team](/operations/working-with-platform-team/).

## CFS mechanics: why `500m` destroys your p99

A CPU limit of `500m` becomes a CFS bandwidth quota of **50ms of CPU time per 100ms period**, shared across all threads in the container. Now run a typical web service with 4 worker threads that all wake for a burst of requests:

```text
Period budget:        50ms per 100ms window (limit 500m)
Burst:                4 threads running concurrently
Budget burn rate:     4 threads × 1ms wall = 4ms of quota per 1ms
Quota exhausted at:   50ms ÷ 4 = 12.5ms into the period
Stall:                87.5ms — every thread frozen until the next period
```

Any request in flight when the freeze hits eats up to 87.5ms of pure stall — often across *multiple consecutive periods* for anything non-trivial. Meanwhile your CPU usage graph shows 50ms used per 100ms period at worst, and the burst was brief, so the 5-minute average reads a comfortable **40%**. Average utilization is innocent; p99 latency is a crime scene. This is the single most common "we have latency spikes but CPU looks fine" root cause.

:::note[Under the hood: how the quota actually drains]
[CFS bandwidth control](https://docs.kernel.org/scheduler/sched-bwc.html) keeps a global runtime pool per cgroup, refilled to the full quota at the start of each period. As your threads run, each CPU's runqueue draws runtime from that pool in slices (5ms by default) — which is why four concurrent threads drain a 50ms quota four times faster than the wall clock: every running thread burns quota simultaneously. When the pool and the local slices are gone, the whole task group is dequeued — *throttled* — and nothing in the container runs until the period timer refills the pool. The kernel does have a `burst` setting that lets a cgroup bank unused quota from previous periods to absorb exactly this kind of spike, but Kubernetes doesn't expose it through the `resources` API, so on a stock cluster the math above is the math you live with.
:::

You can't see throttling in usage metrics. You see it here:

```promql
# Fraction of enforcement periods in which the container was throttled.
# Above ~0.05 (5%) on a latency-sensitive service is a problem; above 0.25 is a fire.
sum by (namespace, pod, container) (
  rate(container_cpu_cfs_throttled_periods_total{container!=""}[5m])
)
/
sum by (namespace, pod, container) (
  rate(container_cpu_cfs_periods_total{container!=""}[5m])
)
```

More resource queries, including throttled-seconds and working-set variants, live in [PromQL for resources](/observability/promql-for-resources/). If you have node access, the kernel offers a second opinion: the cgroup's `cpu.pressure` file — [pressure stall information (PSI)](https://docs.kernel.org/accounting/psi.html) — reports the share of wall-clock time the container's tasks spent stalled waiting for CPU, which is the throttle ratio's question answered from the scheduler's side.

## Second-order knobs

| Knob | Default | What it actually does | When to turn it | What to watch after |
|---|---|---|---|---|
| Init container resources | inherits LimitRange defaults | Pod's effective request = **max**(any single init container, **sum** of app + restartable sidecar containers), per resource. A fat init container can dominate scheduling | Migration/warmup init steps that need more than steady state | Effective pod request via `kubectl describe pod`; see [Init and sidecar containers](/workloads/init-and-sidecar-containers/) |
| Sidecar (restartable init) resources | none | Counted in the *sum* alongside app containers for the pod's whole life — and an unsized sidecar demotes pod QoS | Every injected mesh/log sidecar; give it a small honest block | Pod QoS class, per-container working set |
| `requests/limits.ephemeral-storage` | none | Caps writable-layer + `emptyDir` + log usage. Exceed the limit → pod **evicted** (not restarted in place). The forgotten eviction trigger | Anything writing scratch files, unbounded logs, on-disk caches | `Evicted` pods with `ephemeral-storage` in the message |
| `limits.hugepages-<size>` | none | Pre-reserved huge pages (must equal request; needs app support and node config) | Databases/DPDK-class workloads only, coordinated with the platform team | Hugepage allocation on target nodes |
| `resizePolicy` + in-place resize | beta and on by default since 1.33 — check the feature-gate status for your version; policy `NotRequired` (default) or `RestartContainer` | `kubectl patch ... --subresource=resize` changes CPU/memory without pod recreation. CPU resizes apply live; memory *decreases* and any container with `resizePolicy: RestartContainer` restart the container. QoS class can't change | Iterative tuning without rollout churn — huge for memory-limit experiments | `pod.status.resize`, container restart count |
| LimitRange (platform-owned) | cluster-specific | Silently stamps default requests/limits onto containers that omit them, and rejects pods outside min/max. Your "no CPU limit" decision may not survive admission | You don't turn it — you *read* it: `kubectl describe limitrange -n <ns>` before trusting any omitted field | Actual values on running pods vs your manifest |
| ResourceQuota (platform-owned) | cluster-specific | Caps the namespace's **sum of requests/limits**. Headroom math: `per-pod request × (replicas + maxSurge)` must fit, or rollouts wedge with Pending pods | Read it before scaling up or raising requests: `kubectl describe quota -n <ns>` | `kubectl get events` for `exceeded quota`; see [Pod Pending](/troubleshooting/pod-pending/) |

### In-place resize in practice (beta since 1.33)

Worth its own snippet, because it changes the tuning loop from "every experiment is a rollout" to "every experiment is a patch":

```bash
# Bump CPU request live — no pod recreation, no connection drops
kubectl patch pod payments-api-7d9f6b5c4-x2lqp --subresource=resize \
  --patch '{"spec":{"containers":[{"name":"payments-api",
    "resources":{"requests":{"cpu":"600m"}}}]}}'

# Watch the kubelet apply it
kubectl get pod payments-api-7d9f6b5c4-x2lqp \
  -o jsonpath='{.status.containerStatuses[0].resources}'
```

The restart rules, per container, via `resizePolicy`:

```yaml
containers:
  - name: payments-api
    resizePolicy:
      - resourceName: cpu
        restartPolicy: NotRequired      # CPU changes apply live
      - resourceName: memory
        restartPolicy: RestartContainer # JVMs can't shrink a live heap; restart to re-read the limit
```

CPU changes are genuinely live. Memory is where you choose: a runtime that sizes itself once at startup (the JVM) needs `RestartContainer` to actually honor a new limit; a runtime that allocates lazily can take `NotRequired`. Either way, patches are experiments — the number that works still has to land in Git (see anti-patterns).

:::caution[LimitRange defaults are invisible in your manifest]
The most confusing tuning sessions start with a manifest that omits limits and a running pod that has them. Nothing in your Git repo shows where `cpu: 500m` came from — a LimitRange stamped it at admission. Always compare `kubectl get pod -o yaml` against your manifest before reasoning about behavior.
:::

## Interaction math

**Requests × scheduling.** The scheduler bin-packs on *requests*, never usage. Request `2` cores while using `200m` and you occupy 2 cores of every node's ledger; ten such pods fill a 20-core node that's 90% idle. Your dashboards look innocent — the *cluster* is starved, other teams' pods go Pending, and the autoscaler buys nodes nobody uses. Over-requesting is an externality: you pay nothing, everyone else pays. Details in [Scheduling](/workloads/scheduling/).

**Requests × HPA.** HPA CPU utilization targets are a percentage **of the request**: `target 70%` on `request 1000m` scales at 700m of usage. Halve the request and the same traffic now reads as 140% utilization — you just retuned your autoscaler to double replicas without touching the HPA object. Change requests and HPA targets *together*, deliberately: [Autoscaling](/workloads/autoscaling/).

**Limits × JVM.** The memory limit and the JVM's heap flags are one handshake, tuned as a pair — the percentage derivation and the non-heap budget live in [JVM memory knobs](/tuning/jvm-memory-knobs/).

**Rolling updates × quota.** A Deployment with `maxSurge: 25%` briefly runs extra pods, and each one counts against ResourceQuota at full request. Budget `requests × (replicas + surge)`, not `requests × replicas`. Concretely:

```text
Namespace quota:      requests.memory = 16Gi
payments-api:         8 replicas × 1Gi request           =  8Gi
maxSurge 25%:         +2 pods during rollout             = 10Gi peak
worker:               4 replicas × 1.5Gi                 =  6Gi  (surge +1 → 7.5Gi peak)
Peak if both roll:    10Gi + 7.5Gi = 17.5Gi  >  16Gi     → second rollout WEDGES
```

Neither service alone breaks the budget; two rollouts overlapping do — and CI has a talent for triggering exactly that. The stuck pods show `exceeded quota` in events, one of the classic shapes in [Pod Pending](/troubleshooting/pod-pending/).

## Sizing workflow

The full narrative walkthrough is [Sizing walkthrough](/tuning/sizing-walkthrough/); here is the condensed loop:

1. **Collect 7 days** of `container_memory_working_set_bytes` (p95 and p99, per container) and CPU usage rate (p95). Seven days catches weekly patterns; one day doesn't. The two anchor queries:

   ```promql
   # p99 memory working set over 7 days, per container
   quantile_over_time(0.99,
     container_memory_working_set_bytes{namespace="payments", container="payments-api"}[7d])

   # p95 CPU usage over 7 days (cores)
   quantile_over_time(0.95,
     rate(container_cpu_usage_seconds_total{namespace="payments", container="payments-api"}[5m])[7d:5m])
   ```

   Variants (per-pod max, restart-aware, recording rules) in [PromQL for resources](/observability/promql-for-resources/).
2. **Memory limit = p99 working set × 1.2–1.4.** The multiplier is your growth-vs-OOM trade: 1.2 for stable services you retune often, 1.4 for anything with caches or growth. Round to a clean number.
3. **Memory request = memory limit.** (Argued above.)
4. **CPU request ≈ p95 usage,** rounded up to a clean value. No CPU limit unless you're in the batch/fairness/benchmark cases.
5. **Deploy, wait a full traffic cycle, re-measure.** One knob per change. Rollout mechanics, canary-first ordering, and rollback discipline: [Resource tuning in prod](/operations/resource-tuning-in-prod/).

:::note[Under the hood: working set vs. "memory used"]
The raw cgroup counter, `memory.current`, charges every page the container touches — anonymous memory (heap, stacks) *and* file-backed page cache from every file it reads or writes. Cache is reclaimable: under pressure the kernel drops it rather than OOM-killing anyone. That's why a service with a 400Mi heap can show 1.9Gi "used" after streaming a few large files — most of it is cache the kernel would hand back on demand, not memory the process needs. `container_memory_working_set_bytes` is usage minus the `inactive_file` portion (cache the kernel considers cold and readily reclaimable), which is why it — not raw usage — is the number that correlates with real OOM risk and the one to size limits from.
:::

Worked example — `payments-api`, 7 days of data:

| Measured | Value | Knob | Setting | Why |
|---|---|---|---|---|
| p99 working set | 720Mi | `limits.memory` | `1Gi` | 720 × 1.3 ≈ 936Mi → round to 1Gi |
| — | — | `requests.memory` | `1Gi` | = limit, no overcommit exposure |
| p95 CPU usage | 380m | `requests.cpu` | `400m` | honest p95, clean number |
| p99 CPU burst | 1400m | `limits.cpu` | *(omitted)* | bursts are exactly what we don't want throttled |
| Throttle ratio (before) | 0.31 | — | — | the previous `500m` limit was the p99 problem |

**When not to trust percentiles:** spiky batch workloads (p95 of a mostly-idle week says nothing about the nightly run — size for the run), cold caches (working set a week after deploy ≠ working set an hour after), and monthly/quarterly jobs your 7-day window never saw. For those, size from a deliberate test run, not history.

## Recipes

**Latency-sensitive API** — no CPU limit; bursts absorb spikes, request guarantees the floor:

```yaml
resources:
  requests:
    cpu: 400m
    memory: 1Gi
  limits:
    memory: 1Gi
```

**JVM service** — limit and heap are a pair; flags in [JVM memory knobs](/tuning/jvm-memory-knobs/):

```yaml
resources:
  requests:
    cpu: 500m
    memory: 2Gi
  limits:
    memory: 2Gi
# pair with: -XX:MaxRAMPercentage=65 (leave room for metaspace, threads, direct buffers)
```

**Batch Job** — CPU limit is fine here; throughput work doesn't feel throttle latency, neighbors do feel the noise:

```yaml
resources:
  requests:
    cpu: "2"
    memory: 4Gi
  limits:
    cpu: "2"
    memory: 4Gi
```

**Sidecar** — tiny but honest; an unsized sidecar demotes pod QoS and dodges the scheduler:

```yaml
resources:
  requests:
    cpu: 50m
    memory: 64Mi
  limits:
    memory: 64Mi
```

**No data yet** — a deliberate over-provision with a mandatory revisit; walk the real process in [Sizing walkthrough](/tuning/sizing-walkthrough/):

```yaml
# STARTER BLOCK — revisit after 7 days of metrics. Do not let this ship to steady state.
resources:
  requests:
    cpu: 250m
    memory: 512Mi
  limits:
    memory: 512Mi
```

## Anti-patterns

| Anti-pattern | What actually happens | Fix |
|---|---|---|
| Limits set, requests omitted | Kubernetes defaults request = limit. Congratulations: accidental Guaranteed with a CPU limit you never chose, throttling included | Set requests explicitly; omit the CPU limit deliberately |
| Request ≫ usage, forever | Quota hoarding. Scheduler ledger full, nodes idle, other teams Pending, cluster autoscaler buys ghost capacity | Re-size to p95 quarterly; the throttle/OOM risk you're insuring against is cheaper than the hoard |
| Memory limit > node allocatable | Schedules nowhere — or worse, only on the one big node pool, and scale-up strands Pending pods when that pool is full | Know your node shapes; keep pod limits well under allocatable |
| Copying blocks between services | The gRPC gateway inherits the batch worker's `cpu: "4"` request; nobody remembers why; nobody dares change it | Every value traces to a measurement with a date on it |
| 1000x unit typos (`cpu: 100`, `memory: 512m`) | Pending forever, or OOM at byte one | CI lint on resource quantities; reject lowercase `m` on memory |
| Tuning live without git | `kubectl edit` in an incident, never backported; next deploy silently reverts the fix, incident #2 | In-place resize for the experiment, PR for the result — process in [Resource tuning in prod](/operations/resource-tuning-in-prod/) |

The knobs are few; the interactions are the job. When a pod won't schedule, start at [Pod Pending](/troubleshooting/pod-pending/); when it schedules and dies, start at [OOMKilled](/troubleshooting/oomkilled/); when it runs and it's slow, start with the throttle ratio above.
