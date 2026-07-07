---
title: "DaemonSets"
description: What the platform's per-node agents do to and for your pods, and the rare cases where an app team should run a DaemonSet of its own.
keywords:
  - one pod per node
  - daemonset not running on all nodes
  - desired less than current daemonset
  - kubectl drain ignore-daemonsets
  - fluent-bit node-exporter cilium kube-proxy
  - failures only on one node
  - daemonset tolerations taints
  - onupdate rolling update daemonset
  - node agent pod
  - allocatable vs capacity
sidebar:
  order: 20
---

A DaemonSet runs **one pod per eligible node**. That's the whole contract. There is no `replicas` field, no HPA hook, no scaling knob — the scale of a DaemonSet *is* the size of the cluster (or the labeled slice of it you scope to). When a node joins, the controller creates a pod for it; when a node is deleted, the pod goes with it. Membership is driven by node existence, not by a desired count you set.

That inversion is why DaemonSets are almost always node infrastructure, and node infrastructure is almost always the platform team's job. On a platform-managed cluster you interact with DaemonSets in two very different ways:

1. **Every day, invisibly**: a fleet of platform DaemonSets runs on every node underneath your pods, and their health *is* your networking, your logs, your DNS, and your volume mounts.
2. **Rarely, deliberately**: your team has a workload that is genuinely *about the node*, and you negotiate running your own.

This article covers both, in that order, because the first one is the one that pages you.

## How DaemonSet pods schedule (and why they survive what evicts you)

Since 1.12, DaemonSet pods go through the **default scheduler** like everything else — but the controller pre-binds each pod to its node by injecting a required node affinity naming exactly one node:

```yaml
# Auto-generated on every DaemonSet pod — you never write this
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
      - matchFields:
        - key: metadata.name
          operator: In
          values: ["worker-07"]
```

So the scheduler's filter/score machinery from [Scheduling](/workloads/scheduling/) still runs — resource requests are still checked, taints still apply — but the feasible set for each DS pod is one node. There's no placement decision, only an admission decision: *can this pod fit on this specific node or not*.

The controller also injects a set of **tolerations** onto every DaemonSet pod:

| Auto-added toleration | Effect |
|---|---|
| `node.kubernetes.io/not-ready`, `unreachable` (NoExecute, no expiry) | DS pods are never evicted when a node goes NotReady |
| `node.kubernetes.io/disk-pressure`, `memory-pressure`, `pid-pressure` (NoSchedule) | DS pods still schedule onto nodes under pressure |
| `node.kubernetes.io/unschedulable` (NoSchedule) | DS pods schedule onto cordoned nodes |
| `node.kubernetes.io/network-unavailable` (NoSchedule, hostNetwork pods) | The CNI agent can start before the network it provides exists |

This answers a question that confuses everyone the first time: during a node incident, `kubectl get pods -o wide` on the sick node shows *your* pods evicted or Terminating while the platform's DS pods sit there Running. That's by design. The log collector has to survive disk pressure to ship the logs explaining the disk pressure; the CNI agent has to tolerate a network-unavailable node because it's the thing that makes the network available. The full node-failure timeline is in [Node Problems](/troubleshooting/node-problems/).

:::note
The eviction immunity cuts both ways. If *you* run a DaemonSet, your pod also rides the node down — it will happily keep running on a node that's melting, which is correct for an agent and very wrong for anything serving traffic.
:::

## The platform's DaemonSets: the fleet under your pods

On a typical corporate on-prem cluster, if your RBAC allows cluster-wide reads of DaemonSets (many tenant setups permit this read-only — worth asking for), you'll see something like:

```console
$ kubectl get ds -A
NAMESPACE        NAME                     DESIRED   CURRENT   READY   UP-TO-DATE   AVAILABLE   NODE SELECTOR            AGE
kube-system      cilium                   24        24        24      24           24          <none>                   412d
kube-system      kube-proxy               24        24        24      24           24          kubernetes.io/os=linux   412d
kube-system      node-local-dns           24        24        24      24           24          <none>                   398d
logging          fluent-bit               24        24        23      24           23          <none>                   380d
monitoring       node-exporter            24        24        24     24            24          <none>                   401d
storage          ceph-csi-rbd-nodeplugin  24        24        24      24           24          <none>                   365d
metallb-system   speaker                  20        20        20      20           20          node-role!=infra         290d
security         falco                    24        24        24     24            24          <none>                   200d
```

What each one is doing to (and for) your workloads:

- **CNI agent** (`cilium`, `calico-node`, `flannel`...) — programs your pod's network interface at creation. If it's down on a node, new pods there stick in `ContainerCreating` with CNI errors, and existing pods may lose connectivity.
- **kube-proxy** — programs the Service virtual-IP dataplane on each node. A broken kube-proxy means Services resolve but don't connect, from that node only. Full mechanics in [kube-proxy and the Dataplane](/routing/kube-proxy-and-the-dataplane/).
- **Log collector** (`fluent-bit`, `vector`, `promtail`) — tails every container's stdout from the node's disk and ships it to the log system. This is *why* your `stdout` shows up in the corporate log platform without you doing anything — see [Log Collection](/observability/log-collection/).
- **node-exporter / monitoring agents** — export node-level CPU, memory, disk, and network metrics that the dashboards in [Metrics](/observability/metrics/) are built on.
- **NodeLocal DNSCache** (`node-local-dns`) — a per-node DNS cache that intercepts your pods' lookups before they hit CoreDNS. Explained in [CoreDNS Deep Dive](/routing/coredns-deep-dive/).
- **CSI node plugins** — perform the actual mount of your PersistentVolumes onto the node when your pod lands there. Mount failures on one node usually trace here — see [CSI Drivers](/controllers/csi-drivers/).
- **MetalLB speaker** — announces LoadBalancer IPs from the nodes; see [MetalLB](/controllers/metallb/).
- **Security/runtime agents** (`falco`, EDR agents) — watch syscalls and container activity. Occasionally these are the answer to "why does my pod get killed when it execs curl."

### Effect one: they tax every node

Every one of these pods requests CPU and memory on *every node*, and the kubelet reserves more on top (`kube-reserved`, `system-reserved`). This is most of the gap you see between capacity and allocatable:

```console
$ kubectl describe node worker-07 | grep -A6 Allocatable
Allocatable:
  cpu:                15600m
  memory:             61Gi
  pods:               110
```

A "16-core" node offering 15.6 cores, minus the DS fleet's requests (commonly 0.5–1.5 cores and 1–2Gi per node), is what's actually left for you. When you're capacity-planning requests, that's the denominator — see [Resources and QoS](/workloads/resources-and-qos/).

### Effect two: when one breaks, it breaks a node-shaped hole

A Deployment failure breaks a *service*. A DaemonSet failure breaks a *node* — for everyone on it. The symptom signature is distinctive: something is wrong for a **subset of your replicas, and the subset is exactly the set of pods on one node**.

| You observe | Suspect DS on that node |
|---|---|
| Log gap for some replicas; kubectl logs fine | Log collector |
| DNS timeouts from pods on one node | NodeLocal DNSCache |
| Service connections fail from one node only | kube-proxy / CNI |
| Pod stuck ContainerCreating, `failed to mount volume` | CSI node plugin |
| Pod stuck ContainerCreating, `failed to set up sandbox` | CNI agent |

The diagnostic move is always the same: **correlate by node**.

```console
$ kubectl get pods -o wide | grep -v Running
NAME                     READY   STATUS              RESTARTS   AGE   IP       NODE
api-7d4b9c6f8-mm4qx      0/1     ContainerCreating   0          9m    <none>   worker-07
worker-6c9d5b7f4-t8znl   0/1     ContainerCreating   0          7m    <none>   worker-07
```

Two different workloads, one node: that's not your bug. Note it in the ticket ("all failures on worker-07, fluent-bit not Ready there per `kubectl get ds -A`") and hand it to the platform team — this is squarely their pager. Same-node correlation is the core pattern in [Node Problems](/troubleshooting/node-problems/), and the escalation path is in [Working with the Platform Team](/operations/working-with-platform-team/).

## When an app team legitimately wants a DaemonSet

The honest list is short:

- **A per-node agent tied to node-local state** — e.g. a cache warmer or content pre-loader that manages a hostPath dataset your pods read, or an agent that watches something only visible from the node.
- **App-specific hardware access** — a licensing dongle, a capture card, a specialty device on a subset of nodes that no platform component drives for you. (GPUs are usually already handled by a platform device plugin.)

The much longer list of things that *look* like DaemonSet use-cases but aren't:

| "I need a DaemonSet because..." | What you actually need |
|---|---|
| Ship my app's logs | The platform log DS already does; for special formats, a sidecar — [Sidecars](/sidecars/overview/), [Log Collection](/observability/log-collection/) |
| Run near my pods for latency | Pod affinity, not node saturation — [Scheduling](/workloads/scheduling/) |
| Per-node scheduled cleanup | A CronJob (possibly per-node via affinity), not a DS with a sleep loop |
| One replica per zone/node for HA | Deployment + `topologySpreadConstraints` — [Deployments Deep Dive](/workloads/deployments-deep-dive/) |
| Cache shared by all pods on a node | Often a Deployment sized to the cluster, or just the platform's node-local caches |

The tell: a DaemonSet's replica count changes when the *platform* adds nodes, with zero regard for your load. If your ideal count is "10, wherever," you want a Deployment with spread constraints. If your ideal count is "one on each of *those nodes*, because of what's on the node," you want a DaemonSet.

## Why it's a platform conversation even when you're right

Even a justified app DaemonSet trips over things you don't own:

- **It lands on nodes you've never touched** — including pools tainted against general workloads (`workload=batch:NoSchedule`, GPU pools, infra nodes). Either you add tolerations (which you must justify per-taint) or your DS shows desired < node count and someone asks why.
- **It usually wants host access.** hostPath, hostNetwork, hostPID, privileged — the classic DS toolkit — are all forbidden under the `restricted` Pod Security level most tenant namespaces run. If your DS needs them, you need a namespace exemption, which is a security review, not a YAML change — see [Pod Security](/workloads/pod-security/).
- **The multiplication argument.** `100m` CPU and `128Mi` sounds free. On 24 nodes it's 2.4 cores and 3Gi reserved *forever*, growing automatically with every node the platform adds — capacity they pay for whether your agent is busy or idle.
- **It behaves differently during maintenance.** Drains skip DS pods (below), so the platform's runbooks need to know your agent exists and what it does when the node under it is being rebuilt.

So the sequence is: make the case first. A good request names the node scope (labels), the tolerations and why, the host access and why, the per-node resource cost times node count, and what breaks if the pod is down during maintenance. Template and etiquette in [Working with the Platform Team](/operations/working-with-platform-team/).

## The sanctioned DaemonSet, annotated

Assume approval: a cache-warmer agent for the ten nodes labeled for your data tier.

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: shard-warmer
  namespace: team-orders
spec:
  selector:
    matchLabels:
      app: shard-warmer
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 10%      # default is 1 — one node at a time
  template:
    metadata:
      labels:
        app: shard-warmer
    spec:
      # Scope it. A DaemonSet runs on every MATCHING node —
      # if you need 10 nodes, select 10 nodes, not the fleet.
      nodeSelector:
        team-orders/data-tier: "true"
      tolerations:
      - key: workload            # ONLY the taint on your approved pool.
        operator: Equal          # Never `operator: Exists` with no key —
        value: data              # that tolerates everything, everywhere.
        effect: NoSchedule
      # priorityClassName: system-node-critical  <- NOT yours to take.
      # That tier preempts other pods to keep CNI/CSI alive. Use your
      # team's normal class, or omit.
      containers:
      - name: warmer
        image: registry.corp.example/orders/shard-warmer:2.4.1
        resources:               # Multiplied by node count. Keep it tiny,
          requests:              # and make it Guaranteed (requests==limits)
            cpu: 50m             # so node pressure never evicts an agent
            memory: 96Mi         # that's supposed to outlive pressure.
          limits:
            cpu: 50m
            memory: 96Mi
        volumeMounts:
        - name: shard-cache
          mountPath: /cache
      volumes:
      - name: shard-cache
        hostPath:                # The PSA exemption you negotiated.
          path: /var/data/shard-cache
          type: DirectoryOrCreate
```

Design notes worth internalizing:

- **Guaranteed QoS is not gold-plating here.** DS pods tolerate pressure taints, so they *schedule onto* stressed nodes — but a Burstable pod can still be *evicted* by the kubelet under memory pressure. Guaranteed pods are last in line. Agents should be Guaranteed; see [Resources and QoS](/workloads/resources-and-qos/).
- **If the node needs prep** (create directories, pre-pull a dataset, tune something), do it in an init container in the DS pod rather than a separate mechanism — the pattern and its ordering guarantees are in [Init and Sidecar Containers](/workloads/init-and-sidecar-containers/).
- **No PodDisruptionBudget.** `kubectl drain` doesn't evict DaemonSet pods at all — operators pass `--ignore-daemonsets` and your DS pod keeps running until the node itself reboots or is deleted, then comes back when the node does. A PDB on a DS is dead weight. The corollary: your agent gets **no graceful eviction** during maintenance beyond the node's own shutdown, so it must tolerate abrupt death and cold restarts.

### updateStrategy, dissected

- **`RollingUpdate` + `maxUnavailable`** (default strategy, default `1`): the controller deletes one node's pod, waits for the replacement to go Ready, moves on. Safe and *slow* — on a 200-node fleet with a 30-second startup that's an hour and a half per rollout. Use a percentage (`10%`) once you trust the workload.
- **`maxSurge`** (stable since 1.25): start the new pod *before* killing the old one, so the node never lacks an agent. The catch: two instances briefly coexist on one node, so it's incompatible with fixed `hostPort`s, exclusive locks on host files, or anything singleton-per-node. `maxUnavailable` must be 0 when surging.
- **`OnDelete`**: the controller updates nothing until *you* delete each pod. This is the coordinated-manual-roll strategy — canary one node, soak, script the rest. Sounds primitive; is actually the right call for agents where a bad version can hurt the node.

## Operating and debugging your DaemonSet

Rollouts use the same verbs as Deployments:

```console
$ kubectl rollout status ds/shard-warmer
Waiting for daemon set "shard-warmer" rollout to finish: 7 out of 10 new pods have been updated...
Waiting for daemon set "shard-warmer" rollout to finish: 9 of 10 updated pods are available...
daemon set "shard-warmer" successfully rolled out

$ kubectl rollout undo ds/shard-warmer     # history and rollback work too
```

**Finding the pod for a given node** — the question you'll ask constantly, because DS debugging is always "what's happening on *that* node":

```console
$ kubectl get pods -o wide --field-selector spec.nodeName=worker-07 -l app=shard-warmer
NAME                READY   STATUS    RESTARTS   AGE   IP            NODE
shard-warmer-b6xk4  1/1     Running   0          3d    10.42.7.114   worker-07
```

**DESIRED < node count, or Pending on some nodes** — the DS controller's math tells you where to look:

```console
$ kubectl get ds shard-warmer
NAME           DESIRED   CURRENT   READY   UP-TO-DATE   AVAILABLE   NODE SELECTOR                  AGE
shard-warmer   10        10        8       10           8           team-orders/data-tier=true     14d
```

- **DESIRED lower than you expect** → nodes don't match your `nodeSelector`, or carry a taint you don't tolerate. The controller doesn't even create pods for those nodes — nothing goes Pending, it's just silently absent. Check node labels/taints.
- **DESIRED right, some pods Pending** → the pod was created for the node but can't fit: that specific node is out of allocatable CPU/memory for your requests. Because of the auto node-affinity there is no "somewhere else" — the scheduler event reads `0/24 nodes are available: 23 node(s) didn't match Pod's node affinity, 1 Insufficient memory` and the fix is freeing space on *that node* or shrinking requests. Full decode in [Pod Pending](/troubleshooting/pod-pending/).
- **READY below CURRENT** → the pods exist and are crashing; normal `kubectl logs` / `describe` triage, one node at a time.

**Version skew is normal, plan for it.** A slow RollingUpdate (or OnDelete mid-roll) means v2.4.1 on some nodes and v2.4.0 on others for hours. If your app pods talk to the node-local agent, that interface needs to tolerate one version of skew — the same discipline as any rolling deploy, sharpened because the roll is per-*node* and can stall on one bad node while the rest of the fleet has moved on.

:::caution
A stuck DS rollout blocks silently: with `maxUnavailable: 1`, one node whose new pod won't go Ready halts the entire remaining rollout. `kubectl rollout status` will hang there — always follow up with `kubectl get pods -l app=<ds> -o wide` to find which node is the cork.
:::

## The decision table

| You need... | Reach for |
|---|---|
| Your app's logs/metrics shipped | Nothing — platform DS already does it; sidecar only for exotic formats |
| A helper alongside *each of your pods* | Sidecar container — [Sidecars](/sidecars/overview/) |
| N replicas spread for availability | Deployment + topologySpread — [Deployments Deep Dive](/workloads/deployments-deep-dive/) |
| Pods co-located near something | Affinity — [Scheduling](/workloads/scheduling/) |
| Per-node work on a schedule | CronJob |
| A cluster-wide agent (security, mesh, storage) | A platform ask — [Working with the Platform Team](/operations/working-with-platform-team/) |
| An agent bound to node-local state or hardware, on your nodes | A DaemonSet — scoped, tolerating only what you must, Guaranteed, and pre-negotiated |

The one-line rule: **a DaemonSet is node infrastructure — if your workload isn't about the node, it isn't a DaemonSet.** If the word "node" doesn't appear in your one-sentence description of the workload, close this page and open [Deployments Deep Dive](/workloads/deployments-deep-dive/).
