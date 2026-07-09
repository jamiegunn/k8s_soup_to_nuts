---
title: GPUs and AI Workloads
description: Running GPU workloads as a tenant — extended resources and their strict rules, MIG vs time-slicing, the two failure modes (Pending forever and the startup-probe problem), a complete model-serving Deployment, and GPU etiquette in a shared cluster.
keywords:
  - nvidia.com/gpu
  - insufficient nvidia.com/gpu pending
  - gpu pod stuck pending
  - untolerated taint gpu
  - cuda out of memory neighbor
  - time-slicing mig
  - dev shm 64mi nccl error
  - model load startup probe restart loop
  - dcgm exporter gpu utilization
  - kueue job queue
  - vllm triton model serving
sidebar:
  order: 20
---

GPUs in Kubernetes are simultaneously simpler and stricter than everything else you schedule. Simpler: there's one line of YAML. Stricter: that line follows rules that CPU and memory don't, the failure modes are more expensive, and in a shared cluster the etiquette matters because a hoarded GPU is $2–10 an hour of someone else's blocked work.

This article is the tenant view. The platform team installs the NVIDIA drivers, the device plugin or GPU operator, the MIG configuration, and the monitoring stack. You consume the result. Knowing where that line sits is half the skill.

## How GPU scheduling actually works

GPUs are **extended resources** — the [official scheduling-GPUs docs](https://kubernetes.io/docs/tasks/manage-gpus/scheduling-gpus/) are short because the model is short. A device plugin on each GPU node advertises `nvidia.com/gpu: 4` (or similar) as node capacity, and your pod claims some:

```yaml
resources:
  limits:
    nvidia.com/gpu: 1
```

Three rules, all different from CPU/memory, all enforced:

1. **Requests must equal limits.** You can specify just the limit (the request defaults to match) but you cannot request less than you limit. There is no burstable GPU.
2. **No fractions.** `nvidia.com/gpu: 0.5` is rejected. Integers only. (Fractional-*looking* access exists — MIG and time-slicing below — but it's expressed as different resource names or inflated counts, never as decimals.)
3. **No overcommit.** Unlike CPU, the scheduler will never place more GPU claims on a node than physically exist. A node with 4 GPUs runs at most 4 one-GPU pods, even if all four are idle.

The consequence of rules 1–3 combined: a GPU pod holds its GPU **exclusively, fully reserved, for the pod's entire lifetime** — including the ten minutes it spends pulling an image and the six hours a notebook sits idle. This is the root of every cost conversation later in this article. The [requests-and-QoS model](/workloads/resources-and-qos/) you know still governs the CPU/memory side of the pod; the GPU side is this stricter parallel system.

### Discovering what exists

The device plugin is invisible to you, but its effects aren't. Node labels (set by GPU Feature Discovery, which the platform's GPU operator typically runs) tell you what hardware is behind the resource name:

```console
$ kubectl get nodes -L nvidia.com/gpu.product -L nvidia.com/gpu.count -l nvidia.com/gpu.present=true
NAME             STATUS   ROLES    AGE   VERSION   GPU.PRODUCT            GPU.COUNT
gpu-node-a-1     Ready    <none>   90d   v1.30.2   NVIDIA-A100-SXM4-80GB  8
gpu-node-a-2     Ready    <none>   90d   v1.30.2   NVIDIA-A100-SXM4-80GB  8
gpu-node-l4-1    Ready    <none>   30d   v1.30.2   NVIDIA-L4              4
```

And `kubectl describe node` shows the allocatable resource names and current claims — on a MIG-partitioned node, this is where you learn the actual menu of things you can request:

```console
$ kubectl describe node gpu-node-a-1 | grep -A8 'Allocatable'
Allocatable:
  cpu:                        94
  memory:                     1056480Ki
  nvidia.com/mig-1g.10gb:     14
  nvidia.com/mig-3g.40gb:     4
  nvidia.com/gpu:             0    # whole-GPU resource zeroed out on MIG nodes
```

If your RBAC can't list nodes, that's fine — it becomes the first of the platform questions to ask before your first GPU deploy:

- Which GPU models exist, and under which resource names? (`nvidia.com/gpu`? `nvidia.com/mig-3g.40gb`?)
- Is there a GPU quota on my namespace?
- What taints are on the GPU pools, and what tolerations/nodeSelectors should I carry?
- Are the GPUs shared (time-slicing/MPS) or exclusive?

## The sharing spectrum, honestly

Because whole GPUs can't be overcommitted, platforms deploy sharing mechanisms. **You don't choose between these — the platform configures them per node pool.** But you absolutely need to know which one you're on, because they have wildly different isolation guarantees:

| Mode | What you request | Isolation | Honest description |
|---|---|---|---|
| Whole GPU | `nvidia.com/gpu: 1` | Full | The device is yours. |
| MIG slice | `nvidia.com/mig-1g.10gb: 1` | Hardware-partitioned | A real fraction — dedicated compute slices and memory (e.g. 1/7 of an A100's compute, 10GB VRAM). Predictable performance. You just request the slice name that exists. |
| Time-slicing | `nvidia.com/gpu: 1` (but node advertises more GPUs than it has) | **None** | The device plugin advertises, say, 4 "GPUs" per physical GPU and contexts take turns. No memory isolation — a neighbor's OOM can kill your process; a neighbor's big kernel stalls yours. Fine for bursty dev/inference; the noisy-neighbor problem is real and unmeasurable from inside your pod. |
| MPS | `nvidia.com/gpu: 1` (platform-configured) | Partial | Concurrent kernels with memory limits per client, better than time-slicing, still shared failure domain. |

:::caution[Know which one you're on]
The cruelest property of time-slicing is that it's *invisible in your manifest* — you request `nvidia.com/gpu: 1` and may get a fourth of a physical device with zero isolation. If your latency is mysteriously bimodal or your process dies with CUDA OOM while "using 1 GPU," ask [the platform team](/operations/working-with-platform-team/) which sharing mode the pool runs before you spend a week profiling your own code.
:::

## The two failure modes that define GPU pods

### Failure mode A: Pending forever

GPU pods get stuck Pending more than any other pod type, and the [general Pending playbook](/troubleshooting/pod-pending/) applies with GPU-specific decoding:

```console
$ kubectl describe pod llm-server-7d9f8b6c5-x2vlp
...
Events:
  Type     Reason            Age    From               Message
  ----     ------            ----   ----               -------
  Warning  FailedScheduling  2m14s  default-scheduler  0/12 nodes are available:
    8 Insufficient nvidia.com/gpu, 4 node(s) had untolerated taint
    {nvidia.com/gpu: present}. preemption: 0/12 nodes are available...
```

Read that message like a census, not an error. It's telling you two different stories:

- **"8 Insufficient nvidia.com/gpu"** — eight GPU-capable nodes exist but their GPUs are all claimed (or you asked for 2 and every node has at most 1 free). GPUs free up when pods *end*, so this either resolves when a batch job finishes or never resolves because serving pods hold everything 24/7. Check `kubectl describe node | grep -A5 'Allocated resources'` on a GPU node if you can, or ask.
- **"untolerated taint"** — platforms taint GPU pools so ordinary pods don't waste expensive nodes. Your GPU pod must carry the matching toleration — [taints and tolerations mechanics here](/workloads/scheduling/):

```yaml
tolerations:
- key: nvidia.com/gpu
  operator: Exists
  effect: NoSchedule
nodeSelector:
  nvidia.com/gpu.product: NVIDIA-L4   # pin the model when it matters
```

The third Pending cause is quota: `kubectl describe resourcequota -n your-ns` — GPU quotas show up as `requests.nvidia.com/gpu`. Quota-blocked pods often fail at *creation* with a `403 Forbidden ... exceeded quota` rather than sitting Pending, so check your CI logs too.

### Failure mode B: the startup-probe problem

A 40GB model takes minutes to get from disk into VRAM. A default-tuned probe budget kills the pod at 30 seconds, forever, in a loop — each restart re-pays the full load time, and from the outside it looks like "the GPU service is broken" when actually it never once got to finish starting. This is the single most common self-inflicted GPU outage.

The fix is a `startupProbe` sized by arithmetic, not vibes — the [probe-tuning math lives here](/tuning/health-check-knobs/), and the GPU version is:

1. Measure the real cold-start once: time from container start to first successful inference. Say 4 minutes.
2. Budget **2× measured** (registry slowness, storage contention, one-time CUDA JIT): 8 minutes.
3. `failureThreshold × periodSeconds ≥ budget`: e.g. `failureThreshold: 48, periodSeconds: 10`.

### Getting the model TO the pod

Half of that startup time is fetching weights. Three strategies, no universally right answer:

| Strategy | Startup | Ops burden | Watch out for |
|---|---|---|---|
| Baked into image | Slow first pull per node (a 40GB+ image), fast after (node cache) | Image rebuild per model version; registry storage costs | Pull timeouts; some registries choke on giant layers; every node upgrade re-pulls |
| PVC with weights | Fast (mount, not copy) | Someone must populate/version the volume | Needs **RWX** [storage class](/stateful/storage-pv-pvc/) for multi-replica serving — not every platform offers one; RWO limits you to one node |
| Init container from object storage | Medium (download at pod start, at network speed) | Simple, versioned by URL | Pay the download on *every* pod start; egress costs; needs an emptyDir big enough for the weights |

For serving fleets, PVC-RWX (or a read-only PV pre-populated by a Job) is usually the sweet spot; for one-off training Jobs, init-container download is fine.

## The model-serving pod shape

A complete, annotated Deployment for a vLLM/Triton-style server. Every non-obvious line exists because of a real failure mode:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: llm-server
  namespace: ml-inference
spec:
  replicas: 2
  selector:
    matchLabels: { app: llm-server }
  strategy:
    rollingUpdate:
      maxSurge: 1        # surge needs a FREE GPU somewhere — if the pool is full,
      maxUnavailable: 0  # your rollout Pending-deadlocks; consider maxUnavailable: 1 instead
  template:
    metadata:
      labels: { app: llm-server }
    spec:
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
      nodeSelector:
        nvidia.com/gpu.product: NVIDIA-A100-SXM4-80GB
      terminationGracePeriodSeconds: 120   # in-flight generations take tens of seconds
      containers:
      - name: server
        image: vllm/vllm-openai:v0.5.4
        args: ["--model", "/models/llama-3-70b-awq", "--max-model-len", "8192"]
        ports:
        - containerPort: 8000
        resources:
          limits:
            nvidia.com/gpu: 1
            cpu: "8"          # tokenization, batching, HTTP are all CPU —
            memory: 32Gi      # a GPU pod with 500m CPU bottlenecks on the CPU side
          requests:
            cpu: "8"
            memory: 32Gi
        volumeMounts:
        - name: models
          mountPath: /models
          readOnly: true
        - name: dshm
          mountPath: /dev/shm   # NCCL / dataloader IPC lives here; the container
        startupProbe:            # default /dev/shm is 64Mi and fails cryptically
          httpGet: { path: /health, port: 8000 }
          periodSeconds: 10
          failureThreshold: 48   # 8-minute budget = 2x measured 4-min model load
        readinessProbe:
          httpGet: { path: /health, port: 8000 }  # must mean "model loaded and can
          periodSeconds: 10                        # infer", not "HTTP port open" —
          failureThreshold: 3                      # else you serve 503s during load
        livenessProbe:
          httpGet: { path: /health, port: 8000 }
          periodSeconds: 30
          failureThreshold: 4    # generous: a liveness kill re-pays the whole model load
      volumes:
      - name: models
        persistentVolumeClaim:
          claimName: llama-weights   # RWX, pre-populated
      - name: dshm
        emptyDir:
          medium: Memory
          sizeLimit: 8Gi   # sizeLimit or a runaway dataloader eats node RAM
```

Three lines people miss until they've been burned:

- **`/dev/shm`**: containers default to 64Mi of shared memory. PyTorch dataloaders and NCCL fail with misleading errors (`unhandled system error`, bus errors) without the `medium: Memory` emptyDir. The `sizeLimit` matters — it counts against your pod's memory.
- **Probes that mean "model loaded"**: point readiness at an endpoint that only succeeds after weights are in VRAM (vLLM's `/health` behaves this way; verify yours does). The general probe semantics you already know apply, with the stakes multiplied by the reload cost.
- **Graceful shutdown**: a long generation in flight when SIGTERM arrives should finish, not be severed mid-token. Serving frameworks drain on SIGTERM if `terminationGracePeriodSeconds` gives them room; the default 30s often doesn't.

## Batch and training-adjacent work

Fine-tuning, evals, and batch inference belong in [Jobs](/workloads/jobs-and-cronjobs/), with the same GPU limit, toleration, and /dev/shm patterns as above. Two batch-specific realities:

**Queueing.** When 5 teams share 16 GPUs, first-come-first-served means whoever's CI fired first wins and everyone else's Jobs pile up Pending. **Kueue** is the emerging standard answer, and the honest one-paragraph version is: the platform installs it and defines quotas/queues per team; you add one label to your Job and set `suspend: true`; your Job then *waits its turn* and is started by Kueue when capacity within your team's quota is free, instead of dog-piling the scheduler. The tenant-side diff is tiny:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: finetune-llama-run42
  labels:
    kueue.x-k8s.io/queue-name: ml-team-queue   # your team's LocalQueue, from the platform
spec:
  suspend: true          # Kueue unsuspends when your quota has room
  backoffLimit: 6        # generous — see preemption note below
  template:
    spec: {}             # ... GPU limit, toleration, /dev/shm as usual
```

If your platform runs Kueue, use it — a labeled Job that waits 20 minutes beats an unlabeled one that Pending-camps a GPU rollout.

**`backoffLimit` vs preemption.** Some queue configs preempt lower-priority running Jobs to admit higher-priority ones. A preempted pod counts as a failure against a plain Job's `backoffLimit` — set it high enough (or rely on Kueue's requeueing) that being preempted twice doesn't mark your training run permanently Failed. And checkpoint to a PVC or object storage: preemption-tolerant jobs are resumable jobs.

## Observability: proving you use what you hold

The platform's GPU operator almost always ships the **DCGM exporter**, which publishes per-GPU metrics with pod attribution into the same Prometheus you already use for [everything else](/observability/metrics/):

```promql
# GPU compute utilization per pod (%)
avg by (exported_namespace, exported_pod) (DCGM_FI_DEV_GPU_UTIL)

# VRAM in use per pod (GB)
sum by (exported_namespace, exported_pod) (DCGM_FI_DEV_FB_USED) / 1024

# The cost-conversation query: pods holding a GPU at <10% average util over a week
avg_over_time(DCGM_FI_DEV_GPU_UTIL[7d]) < 10
```

That last one matters because of the exclusivity rule from the top of this article: **a pod at 5% GPU utilization still holds 100% of the GPU, 24/7.** Unlike CPU, there is no reclaiming the slack — nobody else can be scheduled onto your claimed device. When the cost review finds a serving pod averaging 5% util, the conversation isn't "reduce your request" (you can't request 0.05 GPU) — it's "move to a MIG slice that matches your actual footprint" or "make it a queued batch Job that releases the device."

**Autoscaling honesty:** HPA on DCGM metrics via an adapter is *possible*, but scaling GPU serving on GPU-util is scaling your most expensive, slowest-starting pods on a lagging signal — each scale-up waits minutes for a model load, if a free GPU even exists. Queue-depth or request-concurrency [metrics work better for serving](/workloads/autoscaling/), and for batch the right "autoscaler" is a queue (Kueue) rather than replicas at all. Get the batch path queued first; make HPA the second project.

## Etiquette and anti-patterns

A short list, because in shared-GPU clusters etiquette *is* engineering:

- **Idle holds.** The notebook/dev pod that claims a GPU and sits for a week is the classic. GPUs release on pod *termination* — build the habit (or the CronJob) of scaling dev GPU pods to zero at the end of the day. Some platforms run idle-reapers; don't make them.
- **Fractional wishes.** Don't request a whole A100 because `0.5` isn't valid and then use a tenth of it — ask what MIG slice names exist and request the one that fits. `kubectl describe node` on a MIG node shows the menu (`nvidia.com/mig-1g.10gb`, `mig-3g.40gb`, ...).
- **Copy-pasted CPU manifests.** A GPU Deployment cloned from a CPU service is missing the toleration (→ Pending forever), the /dev/shm volume (→ cryptic NCCL failures), and the startup probe budget (→ restart loop). All three are silent in review and loud in production.
- **Assuming the model is yours to profile alone.** On time-sliced pools, your latency data includes your neighbors. Establish which sharing mode you're on before drawing performance conclusions.

The one-line summary: GPUs are integers you hold exclusively — so hold exactly the slice you need, tolerate the taint, budget the probe for the model load, and let go the moment you're done.
