---
title: Life of a Deployment
description: Trace kubectl apply end-to-end — API server, etcd, controllers, scheduler, kubelet, probes, and endpoints — and learn where each failure mode surfaces.
sidebar:
  order: 3
---

`kubectl apply -f deployment.yaml` returns in under a second. Your app is up thirty seconds later — or never. Everything in between is a relay race between components you met in [How Kubernetes Works](/start/how-kubernetes-works/), and each handoff is a place where things fail *with a distinctive signature*. Learn the signatures and you can diagnose most deploy failures in one `kubectl describe`.

Here's the race, start to finish.

```text
kubectl apply
     │
     ▼
[1] API server: authn → RBAC → admission webhooks → validation
     │
     ▼
[2] etcd: Deployment object persisted        ← "kubectl apply succeeded"
     │
     ▼
[3] Deployment controller: creates/updates ReplicaSet
     │
     ▼
[4] ReplicaSet controller: creates Pod objects (unscheduled)
     │
     ▼
[5] Scheduler: binds each Pod to a node
     │
     ▼
[6] Kubelet: pulls image → starts containers → runs probes
     │
     ▼
[7] Pod Ready → EndpointSlice updated → Service routes traffic  ← "app is up"
```

## Step 1–2: API server and etcd

The API server authenticates you, checks RBAC, runs the admission chain (mutating webhooks may inject sidecars or defaults; validating webhooks and policies may reject you outright), validates the schema, and writes the Deployment to etcd.

**Failure signatures here are synchronous** — `kubectl` itself prints the error and nothing was persisted:

```console
error: error validating "deployment.yaml": error validating data:
ValidationError(Deployment.spec.template.spec.containers[0]):
unknown field "imagePullPolic"
```

```console
Error from server (Forbidden): deployments.apps is forbidden:
User "jane" cannot create resource "deployments" in API group "apps"
in the namespace "payments"
```

```console
Error from server: admission webhook "validate.policy.example.com" denied
the request: containers must set resource limits
```

- Typo'd fields → fix the YAML; [YAML, Labels, and Namespaces](/start/yaml-labels-and-namespaces/) covers the classics.
- `Forbidden` → RBAC; see [RBAC Denied](/troubleshooting/rbac-denied/).
- Webhook denials → policy, covered in [Admission Webhooks](/controllers/admission-webhooks/).

Once `kubectl apply` prints `deployment.apps/my-app configured`, the API server's job is done. Everything after this is asynchronous — success or failure now surfaces in *statuses and events*, not in your terminal.

## Step 3: Deployment controller → ReplicaSet

The Deployment controller notices the new/changed Deployment and creates a ReplicaSet whose name embeds a hash of the pod template:

```console
$ kubectl get rs
NAME                  DESIRED   CURRENT   READY   AGE
my-app-7c9d8b6f5d     3         3         0       8s
my-app-5f6b7d9c44     1         1         1       9d    ← old RS, scaling down
```

On an update it doesn't touch the old ReplicaSet's pods directly — it scales the new RS up and the old one down according to your rollout strategy. That's why rollbacks are cheap: the old ReplicaSet is still there at 0 replicas, ready to scale back up. [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/) covers strategy, `maxSurge`/`maxUnavailable`, and `kubectl rollout undo`.

**Failure signature:** a rollout that never progresses. `kubectl rollout status deployment/my-app` hangs, and `kubectl describe deployment my-app` shows `ProgressDeadlineExceeded` in conditions. The Deployment isn't broken — something downstream is, so keep walking the chain.

## Step 4: ReplicaSet controller → Pods

The ReplicaSet controller creates Pod objects to match `replicas`. They exist in etcd but run nowhere yet — no node assigned.

**Failure signature:** pods never appear at all. Rare, and almost always a **ResourceQuota** rejection, visible only on the ReplicaSet's events:

```console
$ kubectl describe rs my-app-7c9d8b6f5d
Events:
  Warning  FailedCreate  replicaset-controller
  Error creating: pods "my-app-7c9d8b6f5d-" is forbidden:
  exceeded quota: team-quota, requested: limits.memory=2Gi,
  used: limits.memory=15Gi, limited: limits.memory=16Gi
```

:::tip[Describe the right layer]
Events don't bubble up. Deployment events live on the Deployment, pod-creation failures on the ReplicaSet, scheduling and image failures on the Pod. If `describe` on one layer looks clean, go one layer down. Or cast a wide net: `kubectl get events --sort-by=.lastTimestamp`.
:::

## Step 5: Scheduler binds the pod

The scheduler filters nodes (enough unreserved CPU/memory for the pod's *requests*, tolerations match taints, affinity satisfied), scores the survivors, and binds the pod.

**Failure signature: `Pending`.** The pod exists, has no node, and its events say exactly why:

```console
Warning  FailedScheduling  default-scheduler
0/12 nodes are available: 8 Insufficient memory,
4 node(s) had untolerated taint {dedicated: ingest}.
```

Whether that's your oversized requests or the cluster genuinely out of room determines whose problem it is — [Pod Pending](/troubleshooting/pod-pending/) has the decision tree, and [Resources and QoS](/workloads/resources-and-qos/) explains requests versus limits.

## Step 6: Kubelet makes it real

The kubelet on the chosen node pulls the image, creates the containers, and starts your process. The pod walks through `ContainerCreating` → `Running`. This step has the richest failure menu:

| What you see | What it means | Deep dive |
|---|---|---|
| `ErrImagePull` / `ImagePullBackOff` | Bad image name/tag, or registry auth failure | [ImagePullBackOff](/troubleshooting/imagepullbackoff/) |
| `CreateContainerConfigError` | Referenced ConfigMap/Secret key doesn't exist | [Configuration](/workloads/configuration/) |
| `CrashLoopBackOff` | Container starts, exits, restarts, with growing backoff | [CrashLoopBackOff](/troubleshooting/crashloopbackoff/) |
| `OOMKilled` (in last state) | Container exceeded its memory limit | [OOMKilled](/troubleshooting/oomkilled/) |
| Stuck in `ContainerCreating` | Usually a volume that can't attach/mount | [Storage: PV and PVC](/stateful/storage-pv-pvc/) |

All of these surface in one place:

```bash
kubectl describe pod my-app-7c9d8b6f5d-x2klp
kubectl logs my-app-7c9d8b6f5d-x2klp --previous   # last crashed container's output
```

## Step 7: Probes pass, endpoints update, traffic flows

`Running` is not `Ready`. The kubelet now runs your **readiness probe**, and only when it passes does the pod's `Ready` condition go true. The EndpointSlice controller watches for that and adds the pod's IP to the Service's endpoints; kube-proxy (or your CNI) picks up the change on every node. *This* is the moment traffic arrives.

**Failure signature: `Running` but `0/1 READY`, and a Service with no backends.**

```console
$ kubectl get pods
NAME                      READY   STATUS    RESTARTS   AGE
my-app-7c9d8b6f5d-x2klp   0/1     Running   0          4m

$ kubectl get endpointslices -l kubernetes.io/service-name=my-app
NAME           ADDRESSTYPE   PORTS   ENDPOINTS   AGE
my-app-abc12   IPv4          8080    <none>      9d
```

A failing readiness probe (wrong path, wrong port, app slow to warm up — JVM folks, see [JVM in Containers](/java/jvm-in-containers/)) keeps you out of rotation indefinitely while the pod looks superficially fine. Probe design is its own art: [Health Checks](/workloads/health-checks/). And if endpoints are populated but traffic still doesn't arrive, work through [Service Unreachable](/troubleshooting/service-unreachable/).

## The 60-second post-deploy check

Run this after every deploy until it's muscle memory:

```bash
kubectl rollout status deployment/my-app          # blocks until done or stuck
kubectl get pods -l app.kubernetes.io/name=my-app # READY n/n?
kubectl get events --sort-by=.lastTimestamp | tail -15
kubectl get endpointslices -l kubernetes.io/service-name=my-app  # backends present?
```

If `rollout status` completes, pods are `n/n READY`, events are quiet, and endpoints are populated — you're actually live, not just applied. Anything less, the failure signatures above tell you which article to open.
