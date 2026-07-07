---
title: How Kubernetes Works
description: The Kubernetes control plane from the app team's seat — API server, etcd, controllers, kubelet, and the reconciliation loop that explains everything.
sidebar:
  order: 2
---

You can operate applications on Kubernetes for years without knowing how the control plane works — right up until the moment you can't. When a rollout hangs, when a Service routes traffic to nothing, when a deleted pod comes back like a horror-movie villain, the explanation is always the same handful of components doing the same handful of things. Learn the machine once and every weird behavior becomes predictable.

## The one mental model that matters

Kubernetes is not a deployment tool that executes your commands. It's a **reconciliation engine**. You declare *desired state* ("3 replicas of this pod spec"), Kubernetes stores it, and a swarm of controllers works continuously to make *actual state* match. Forever. Without being asked twice.

This is why:

- A pod you `kubectl delete` gets recreated seconds later — the ReplicaSet controller noticed actual (2 pods) ≠ desired (3 pods) and fixed it.
- Manual edits to live objects get silently reverted when your CI/CD pipeline re-applies manifests — see [Drift and CI/CD](/operations/drift-and-cicd/).
- Nothing in Kubernetes "runs once". Everything is a loop: observe, compare, act, repeat.

When you're debugging, stop asking "what command failed?" and start asking "**which controller is stuck, and what is it waiting for?**" That reframe solves half of all incidents. The full story of control loops is in [Reconciliation](/controllers/reconciliation/).

## The cast of characters

```text
        CONTROL PLANE (platform team's turf)
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  │   ┌──────────┐      ┌────────────────────────┐   │
  │   │   etcd   │◄────►│       kube-apiserver   │◄──┼── kubectl, CI/CD,
  │   │ (truth)  │      │     (the ONLY door)    │   │   controllers, kubelets
  │   └──────────┘      └───────────▲────────────┘   │
  │                                 │                │
  │        ┌────────────────────────┼──────────┐     │
  │        │                        │          │     │
  │  ┌─────┴────────────┐   ┌───────┴───────┐  │     │
  │  │ kube-controller- │   │ kube-scheduler│  │     │
  │  │ manager          │   │ (places pods) │  │     │
  │  │ (the loops)      │   └───────────────┘  │     │
  │  └──────────────────┘                      │     │
  └──────────────────────────────────────────────────┘
                                  ▲
                 watch / report   │
        ┌─────────────────────────┼──────────────────┐
        │  WORKER NODES           │                   │
        │  ┌───────────┐   ┌──────┴────┐  ┌────────┐  │
        │  │ kube-proxy│   │  kubelet  │  │  your  │  │
        │  │ (Service  │   │ (runs the │──│  pods  │  │
        │  │  routing) │   │   pods)   │  └────────┘  │
        │  └───────────┘   └───────────┘              │
        └─────────────────────────────────────────────┘
```

### kube-apiserver — the front door (and the only door)

Every interaction with the cluster goes through the API server: your `kubectl`, your CI/CD pipeline, the scheduler, every controller, every kubelet. Nothing talks to etcd directly; nothing goes around the API server. It authenticates you, checks RBAC ("can this user create Deployments in namespace `payments`?"), runs admission webhooks that may mutate or reject your object, validates the schema, and then persists it.

For you this means: **if the API server accepted your object, your YAML was valid and you were authorized — full stop.** Whether the object ever becomes running pods is a separate question answered by controllers. A successful `kubectl apply` proves nothing about your app being up.

### etcd — the single source of truth

A distributed key-value store holding every object in the cluster: every Deployment, pod, ConfigMap, Secret, Event. `kubectl get` reads from here (via the API server). You will never touch etcd directly, and that's fine — the practical takeaway is that **the cluster's entire state is inspectable**. Anything a controller knows, you can query.

### kube-controller-manager — the loops

One binary running dozens of controllers: the Deployment controller, ReplicaSet controller, Job controller, EndpointSlice controller, and more. Each one watches the API server for objects of its kind and reconciles. The Deployment controller doesn't create pods — it creates ReplicaSets. The ReplicaSet controller creates pods. This chain of delegation is why `kubectl describe` on each layer shows different events, and why [Life of a Deployment](/start/life-of-a-deployment/) walks the chain step by step.

### kube-scheduler — the matchmaker

Watches for pods with no node assigned, scores every eligible node (enough free CPU/memory for the pod's *requests*? tolerates the node's taints? satisfies affinity rules?), and binds the pod to the winner. The scheduler only ever looks at **requests**, never actual usage — a node can be 90% busy and still accept your pod if the *requested* numbers fit. Pods stuck in `Pending` are scheduler territory; [Pod Pending](/troubleshooting/pod-pending/) covers the autopsy.

### kubelet — the node agent

Runs on every node. Watches the API server for pods bound to *its* node, then makes them real: pulls images, starts containers via the container runtime, runs liveness/readiness probes, reports status back. When you read a pod's `status:` block or see `CrashLoopBackOff`, you're reading the kubelet's testimony. You'll never SSH to a node to talk to it — everything it knows surfaces through `kubectl describe pod` and events.

### kube-proxy — the Service plumbing

Also on every node. Programs the node's networking (iptables/IPVS/eBPF, depending on what your platform team chose) so that traffic to a Service's virtual IP gets distributed to healthy backend pods. When "the Service doesn't work", it's usually not kube-proxy — it's your labels or readiness probes. Details in [Services Deep Dive](/networking/services-deep-dive/).

:::note[You will never touch these components directly]
Control plane and node components are the platform team's to run, upgrade, and debug. Your window into all of them is the API: `kubectl get`, `describe`, and events. That window is bigger than it sounds — kubelet failures show up as pod events, scheduler failures as pod conditions, controller failures as object statuses.
:::

## Namespace scope vs cluster scope

Every Kubernetes object is either **namespaced** (lives inside a namespace, and your RBAC likely covers it) or **cluster-scoped** (exists once for the whole cluster, and you likely can't touch or even see it).

| Namespaced (yours) | Cluster-scoped (platform's) |
|---|---|
| Pods, Deployments, ReplicaSets, StatefulSets | Nodes |
| Services, Ingress resources, EndpointSlices | Namespaces themselves |
| ConfigMaps, Secrets | PersistentVolumes (PVs) |
| PersistentVolumeClaims (PVCs) | StorageClasses |
| ServiceAccounts, Roles, RoleBindings | ClusterRoles, ClusterRoleBindings |
| Jobs, CronJobs, HPAs, PDBs | [CustomResourceDefinitions](/controllers/crds-explained/) (CRDs) |
| NetworkPolicies | IngressClasses, PriorityClasses, webhooks |

Check any resource yourself:

```bash
kubectl api-resources --namespaced=true | head
kubectl api-resources --namespaced=false | head
```

Note the storage split: you create a PVC (namespaced claim), and a cluster-scoped PV gets bound to it. That's the ownership boundary made concrete — you ask, the platform provides. [Storage: PV and PVC](/stateful/storage-pv-pvc/) unpacks it.

## Watch reconciliation happen

Two terminals. In the first:

```bash
kubectl get pods -w
```

In the second, delete one of your pods:

```bash
kubectl delete pod my-app-7c9d8b6f5d-x2klp
```

First terminal:

```console
my-app-7c9d8b6f5d-x2klp   1/1   Running       0     2d
my-app-7c9d8b6f5d-x2klp   1/1   Terminating   0     2d
my-app-7c9d8b6f5d-jw8rn   0/1   Pending       0     0s
my-app-7c9d8b6f5d-jw8rn   0/1   ContainerCreating   0   0s
my-app-7c9d8b6f5d-jw8rn   1/1   Running       0     3s
```

Nobody ran a "restart" command. The ReplicaSet controller saw desired ≠ actual and acted. That's the whole system in five lines of output.

## Events: the system narrating itself

As every component does its work, it writes **Events** — small, namespaced objects saying what it did or why it couldn't. The scheduler explains failed placements, the kubelet reports image pulls and probe failures, controllers report scaling decisions. This is your window into components you can't otherwise touch:

```console
$ kubectl get events --sort-by=.lastTimestamp | tail -5
2m    Normal   Scheduled   pod/my-app-jw8rn   Successfully assigned payments/my-app-jw8rn to worker-4
2m    Normal   Pulling     pod/my-app-jw8rn   Pulling image "registry.example.com/my-app:2.4.1"
2m    Normal   Started     pod/my-app-jw8rn   Started container app
1m    Warning  Unhealthy   pod/my-app-jw8rn   Readiness probe failed: HTTP probe failed with statuscode: 503
```

Events expire after about an hour, so capture them early when things go sideways. [Events](/observability/events/) covers reading them systematically.

:::tip[The debugging corollary]
Because everything is level-triggered reconciliation, Kubernetes is self-healing *and* self-reverting. If you need a change to stick, change the desired state (the manifest in git), not the live object. Hand-edits are a loan the reconciler will call in — usually during your next deploy. See [Live Patching](/operations/live-patching/) for when hand-edits are justified anyway.
:::

## What to read next

[Life of a Deployment](/start/life-of-a-deployment/) traces one `kubectl apply` through every component you just met — the fastest way to make this model concrete.
