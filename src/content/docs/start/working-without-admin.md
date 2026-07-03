---
title: Working Without Admin
description: Operating effectively with namespace-scoped RBAC — discovering your permissions, spotting cluster-vs-app problems, and partnering with the platform team.
sidebar:
  order: 4
---

The first time namespace-scoped RBAC bites you, it feels like a bug. You run `kubectl get nodes` and get `Forbidden`. You try a tutorial that says "create a ClusterRole" and get `Forbidden`. You can't see the ingress controller's logs, can't list StorageClasses, can't even see other teams' namespaces.

None of that is a bug. It's the operating model — and once you internalize it, you'll spend less time fighting the fence and more time being effective inside it. There's a real upside, too: you can't take down the cluster, other teams can't take down your namespace, and the platform team can upgrade Kubernetes under you without a meeting.

## What you can typically do

Access varies by organization, but the common grant for an app team looks like:

**Usually allowed, in your namespace(s):**
- Full CRUD on Deployments, ReplicaSets, StatefulSets, Jobs, CronJobs
- Full CRUD on Services, ConfigMaps, Secrets, PVCs, ServiceAccounts, HPAs, PDBs
- Create/edit Ingress resources (the controller behind them is platform-owned)
- `get`/`list`/`watch`/`delete` on Pods; `logs`, `exec`, `port-forward` on your pods
- Read Events, EndpointSlices; often NetworkPolicies too

**Usually denied:**
- Anything cluster-scoped: Nodes, PersistentVolumes, StorageClasses, CRDs, ClusterRoles, other Namespaces
- Anything in namespaces that aren't yours (including `kube-system` — no CoreDNS or ingress-controller logs for you)
- Creating RBAC beyond what's delegated; DaemonSets; privileged/hostPath pods (blocked by admission policy even if RBAC would allow)
- `kubectl top nodes` (needs cluster scope; `kubectl top pods` in your namespace usually works)

## Discover your actual permissions

Don't guess — ask the API server. It answers truthfully in one second. First, confirm who the cluster thinks you are (on kubectl ≥ 1.28):

```bash
kubectl auth whoami
```

```console
ATTRIBUTES   VALUES
Username     jane@example.com
Groups       [team-payments system:authenticated]
```

Then list what that identity can do in your namespace:

```bash
kubectl auth can-i --list
```

```console
Resources                    Verbs
deployments.apps             [get list watch create update patch delete]
pods                         [get list watch delete]
pods/log                     [get]
pods/exec                    [create]
services                     [get list watch create update patch delete]
configmaps                   [get list watch create update patch delete]
...
```

Spot checks for specific actions:

```bash
kubectl auth can-i create deployments            # yes
kubectl auth can-i get nodes                     # no
kubectl auth can-i create pods/exec              # yes -> you can kubectl exec
kubectl auth can-i delete pods -n other-team     # no
```

:::tip[Run `auth can-i --list` on day one]
Save the output. When something fails with `Forbidden` six months from now, you'll know instantly whether your access changed or you're attempting something you never had. The full anatomy of RBAC errors is in [RBAC Denied](/troubleshooting/rbac-denied/).
:::

## Know your budget: quotas and limit ranges

Namespace-scoped access usually comes with namespace-scoped *budgets*. Two objects the platform team plants in your namespace govern how much you can run — and you can (and should) read them:

```bash
kubectl describe resourcequota
```

```console
Name:            team-quota
Resource         Used   Hard
--------         ----   ----
limits.cpu       14     20
limits.memory    15Gi   16Gi
pods             34     50
```

That `limits.memory 15Gi/16Gi` line is the answer to "why won't my new pod get created?" a week before it happens. Quota exhaustion doesn't fail your `kubectl apply` — it fails silently at the ReplicaSet layer during your next rollout, when the surge pod can't be created.

```bash
kubectl describe limitrange
```

LimitRanges set per-container defaults and ceilings. If your pods have resource limits you never wrote, this is where they came from. Check both objects before capacity planning and before escalating any "pods won't schedule" issue — quota problems are yours to fix (or to request a raise for), not a cluster fault.

## App problem or cluster problem?

The most valuable skill in this whole operating model is correctly routing a failure. Misroute it and you either burn hours debugging code that's fine, or file a platform ticket that bounces back with "works as designed".

**Looks like a cluster problem, is actually yours:**

| Symptom | Actual cause |
|---|---|
| "The scheduler is broken, pod stuck Pending" | Your memory request exceeds any node's allocatable, or namespace quota is exhausted |
| "The network is down, Service unreachable" | Service selector doesn't match pod labels, or readiness probe failing → zero endpoints |
| "The node keeps killing my pod" | Your container exceeds its own memory limit — `OOMKilled` is per-container, see [OOMKilled](/troubleshooting/oomkilled/) |
| "DNS is broken" | Typo in the service name, or wrong namespace in the FQDN |
| "The registry is down" | Image tag doesn't exist, or your `imagePullSecret` expired |

**Looks like your problem, is actually the cluster:**

| Symptom | Actual cause |
|---|---|
| Pods evicted with your app logs looking clean | Node pressure (disk/memory) — see [Node Problems](/troubleshooting/node-problems/) |
| All pods on one node unreachable, others fine | Node or CNI issue on that node |
| Every team's deploys failing admission at once | A broken cluster-wide admission webhook |
| PVC stuck `Pending` with a valid StorageClass name | CSI driver or storage backend trouble |
| Intermittent 502s through ingress with healthy pods | Ingress controller or load balancer, not your app |

The tell: **scope**. One pod misbehaving is you. Every pod on one *node* misbehaving is the node. Every *team* misbehaving is the control plane or a shared controller. Even without access to `kube-system`, you can read the scope from your own namespace: `kubectl get pods -o wide` shows which nodes your pods landed on, and pod events quote the kubelet and scheduler verbatim. The [Triage Methodology](/troubleshooting/triage-methodology/) turns this into a repeatable drill.

## Working with the platform team

You'll interact with them in two modes: requests (quota bumps, new namespaces, DNS entries, StorageClass questions) and escalations (you've hit something only they can see or fix). In both, the currency is **evidence**.

A good escalation looks like:

```text
Namespace: payments
Since: ~14:20 UTC
Symptom: 3 pods on node worker-7 went NotReady simultaneously;
         replacements scheduled on other nodes are healthy.
Evidence:
  - kubectl get pods -o wide output (attached) showing node correlation
  - Pod events: "NodeNotReady" from node-controller
What we ruled out: no deploy in this window, no config change,
  identical pods healthy on worker-3 and worker-9.
Ask: can you check worker-7's kubelet/health?
```

That gets acted on in minutes. "The cluster seems slow, can you look?" gets a ticket in a queue. Collect the evidence *before* you page anyone — every troubleshooting article here ends with exactly which outputs to attach when escalating. More patterns (including what to ask for in read-only extra access, like `get` on Nodes and Events cluster-wide) in [Working with the Platform Team](/operations/working-with-platform-team/).

:::caution[Don't work around the fence]
When you hit a permission wall, the tempting hacks — running your workload in a teammate's broader namespace, wiring a CI service-account token into your laptop, asking someone with admin to "just apply this for me" — all end badly, usually in an audit or an outage attributed to your team. Ask for the access or the action through the front door. Platform teams grant narrowly-scoped, well-justified requests far more readily than most app teams assume.
:::

## The paved-road CI/CD contract

Most platform teams run a "paved road": git is the source of truth, the pipeline (or a GitOps controller like Argo CD or Flux) applies your manifests, and your personal kubectl access exists for *reading, debugging, and emergencies* — not routine deploys.

The implicit contract:

1. **Changes go through git.** Your live edits will be overwritten on the next sync — by design. See [Drift and CI/CD](/operations/drift-and-cicd/).
2. **Live edits are for incidents**, and you reconcile them back to git immediately after. [Live Patching](/operations/live-patching/) covers doing this without making things worse.
3. **The pipeline's service account has more rights than you do.** If a manifest deploys fine via CI but you can't `kubectl apply` it by hand, that's the contract working, not broken.
4. **Emergency read/exec access is your safety net.** `kubectl logs`, `describe`, `exec`, and `port-forward` are the tools you keep; the [kubectl Survival Kit](/start/kubectl-survival-kit/) is built around exactly this scope.

Teams that fight this model spend their time in drift-related mystery outages. Teams that embrace it get boring deploys — and boring deploys are the entire point.
