---
title: Triage Methodology
description: A systematic five-step method for Kubernetes incidents, with pod lifecycle states, exit codes decoded, and a worked example.
keywords:
  - how to diagnose a broken pod
  - kubernetes troubleshooting checklist
  - debugging methodology
  - pod lifecycle states explained
  - exit code meanings 137 139 143
  - what changed incident response
  - narrow the blast radius
  - kubectl describe pod
  - kubectl get events sort-by
  - when to escalate to platform
  - one pod or all replicas
sidebar:
  order: 2
---

Most Kubernetes debugging time is wasted on two mistakes: guessing before reading the actual error, and testing expensive hypotheses before cheap ones. This page is the method that avoids both. It's the same five steps every time, whether it's a crash loop at 2pm or a full outage at 2am.

## The five steps

### 1. What changed?

Incidents don't come from nowhere. Before touching kubectl, ask:

- Did we deploy? Check your pipeline history and `kubectl rollout history deployment/<name>`.
- Did config change? ConfigMap or Secret edits don't restart pods by themselves — a change made yesterday can bite on the first restart today. See [ConfigMap and Secret Rotation](/operations/configmap-secret-rotation/).
- Did the platform team do maintenance? Node upgrades, ingress changes, policy rollouts.
- Did traffic change? Marketing launch, batch job kickoff, a retry storm from a downstream.

```bash
# When did the current rollout happen?
kubectl rollout history deployment/api
# When were pods actually created?
kubectl get pods -o wide --sort-by=.metadata.creationTimestamp
```

If pods are older than the incident, the deploy probably isn't the cause. If they're younger, it probably is — and [rolling back](/workloads/rollouts-and-rollbacks/) may be the fastest mitigation while you diagnose.

### 2. Narrow the blast radius

One question with four axes:

- **One pod or all replicas?** One pod → node-local or data-dependent problem. All replicas → spec, config, image, or dependency.
- **One node?** `kubectl get pods -o wide` — if every broken pod shares a node, it's a [node problem](/troubleshooting/node-problems/), not your app.
- **One namespace or everywhere?** If a neighboring team is also down, it's cluster-scoped. Escalate early. (If `kubectl` itself hangs or errors before returning anything, the control plane may be the problem, not your app — [kubectl Can't Reach the Cluster](/troubleshooting/api-server-broken/).)
- **Since when?** Correlate with step 1. `kubectl get events --sort-by=.lastTimestamp` gives you the timeline.

### 3. Read the actual error — don't guess

Kubernetes almost always tells you what's wrong, verbatim, in one of three places:

```bash
kubectl describe pod <pod>                          # Events section, container states
kubectl logs <pod> --previous                       # the dying container's last words
kubectl get events --sort-by=.lastTimestamp         # namespace timeline
```

Read the message *literally*. "Insufficient cpu" means insufficient CPU — not memory, not quota. "manifest unknown" means the tag doesn't exist — not an auth problem. Half of all wasted debugging hours come from reading "0/12 nodes are available" and not reading the rest of the sentence.

### 4. Walk the layers

When the error isn't self-explanatory, work through the stack in order and find the first layer that's broken:

1. **Scheduling** — did the pod get a node? (`Pending` → [Pod Pending](/troubleshooting/pod-pending/))
2. **Image** — did the image pull? ([ImagePullBackOff](/troubleshooting/imagepullbackoff/))
3. **Container start** — does the process stay up? ([CrashLoopBackOff](/troubleshooting/crashloopbackoff/))
4. **Probes** — is the pod Ready? ([Health Checks](/workloads/health-checks/))
5. **Service** — do endpoints exist, do ports match? ([Service Unreachable](/troubleshooting/service-unreachable/))
6. **DNS / network path / ingress** — can clients actually reach it?

Everything below a broken layer is noise. Don't debug DNS when the pod is Pending.

### 5. Form a hypothesis, test the cheapest first

A good hypothesis is falsifiable in one command. Rank your tests by cost:

- Cheap: `describe`, `logs`, `kubectl get endpointslices`, label comparison — seconds, zero risk.
- Medium: `kubectl debug` ephemeral container, curl the pod IP, scale up one replica.
- Expensive: redeploy, rollback, restore from backup, wake up the platform team.

Test cheap first even when you're "sure" it's the expensive thing. You're wrong about a third of the time, and the cheap test takes ten seconds.

## Pod lifecycle states decoded

| State | What it actually means | First move |
|---|---|---|
| `Pending` | No node accepted the pod yet — scheduling or volume binding | `describe` → [Pod Pending](/troubleshooting/pod-pending/) |
| `ContainerCreating` | Scheduled; pulling image, mounting volumes, setting up network. Normal for seconds; stuck = volume/secret/CNI problem | `describe`, look for `FailedMount` |
| `Running` but `0/1 READY` | Process is up; readiness probe failing. No Service traffic reaches it | `describe`, check probe events; `logs` |
| `CrashLoopBackOff` | Container keeps exiting; kubelet is waiting between restarts | `logs --previous` → [CrashLoopBackOff](/troubleshooting/crashloopbackoff/) |
| `Terminating` | Deletion requested; waiting on graceful shutdown (or a finalizer, or a dead node) | Stuck >grace period → [Node Problems](/troubleshooting/node-problems/) |
| `Unknown` | The node stopped reporting. The pod may or may not still be running | Node-level issue; escalate with evidence |
| `Evicted` / `Failed` | Kubelet kicked the pod off the node (resource pressure) | `describe` shows the reason → [Node Problems](/troubleshooting/node-problems/) |

## Exit codes decoded

`kubectl describe pod` shows the last container exit code under `Last State: Terminated`.

| Exit code | Meaning | Typical cause |
|---|---|---|
| `0` | Clean exit | Fine for Jobs; for a Deployment it means your process finished — wrong command, or the app daemonized and PID 1 exited |
| `1` (or app-specific 2–127) | Application error | Crash on boot: bad config, unreachable DB, unhandled exception. The reason is in `logs --previous` |
| `137` | SIGKILL (128+9) | OOMKilled if `Reason: OOMKilled`; otherwise eviction or a kill after the termination grace period expired → [OOMKilled](/troubleshooting/oomkilled/) |
| `139` | SIGSEGV (128+11) | Segfault — native code bug, corrupt library, occasionally bad glibc/musl mismatch in the image |
| `143` | SIGTERM (128+15) | Graceful shutdown request honored. Normal during rollouts and drains. Repeated 143s outside a rollout = liveness probe kills or drains |

:::note[137 is not always OOM]
Exit 137 means "killed with SIGKILL". Only `Reason: OOMKilled` confirms memory. The same code shows up when a pod ignores SIGTERM until the grace period expires, or when the kubelet evicts it. Check the reason before you double the memory limit.
:::

## Worked example: the Friday checkout outage

**Symptom:** alerts fire — checkout API 503s, 40% error rate.

**Step 1 — what changed?** Pipeline shows a deploy of `checkout` 22 minutes ago. Suspicious but not proven.

**Step 2 — blast radius:**

```console
$ kubectl get pods -l app=checkout -o wide
NAME                        READY   STATUS             RESTARTS     AGE   NODE
checkout-6f9d8c7b5-4kxwp    1/1     Running            0            3d    worker-04
checkout-6f9d8c7b5-9pmtz    1/1     Running            0            3d    worker-11
checkout-84c5d9f6b-2rlqn    0/1     CrashLoopBackOff   8 (2m ago)   22m   worker-07
checkout-84c5d9f6b-x8vjd    0/1     CrashLoopBackOff   8 (1m ago)   22m   worker-02
```

Two ReplicaSets: old pods healthy, all *new* pods crash-looping on *different* nodes. It's the new revision, not a node. The rollout is stuck halfway — `maxUnavailable` let it take capacity down to two pods, hence the 503s under load.

**Step 3 — read the error:**

```console
$ kubectl logs checkout-84c5d9f6b-2rlqn --previous | tail -3
Loading configuration...
FATAL: required environment variable PAYMENT_API_KEY is not set
exiting with code 1
```

No guessing needed. Exit 1, missing env var.

**Step 4/5 — hypothesis:** the new revision references a Secret key that doesn't exist. Cheapest test:

```console
$ kubectl get secret checkout-secrets -o jsonpath='{.data}' | tr ',' '\n' | cut -d'"' -f2
DATABASE_URL
PAYMENT_API_TOKEN
```

The Secret has `PAYMENT_API_TOKEN`; the new deployment asks for `PAYMENT_API_KEY`. Rename mismatch between the manifest and the secret rotation done earlier that week.

**Mitigation:** `kubectl rollout undo deployment/checkout` restores service in under a minute. **Fix:** correct the key name in the manifest, redeploy through the pipeline. Total time with the method: ~6 minutes. Without it, this is the incident where someone spends an hour debugging the payment provider.

## When to escalate to platform

Escalate when the first broken layer is one you can't see or touch: nodes NotReady, CNI/DNS infrastructure, ingress controller behavior, quota/capacity, RBAC grants. Don't escalate with "checkout is down." Attach:

- Timeline: when it started, what changed on your side (or explicitly "nothing deployed since X").
- `kubectl describe pod` output for one representative pod.
- `kubectl get events --sort-by=.lastTimestamp` output.
- `kubectl get pods -o wide` showing the node pattern (or lack of one).
- What you've already ruled out, with the commands you used.

That package turns a ping-pong ticket into a ten-minute fix. More on the working relationship in [Working with the Platform Team](/operations/working-with-platform-team/).

:::tip[Mitigate first, diagnose second]
If a rollback or a scale-up restores service, do it, *then* investigate at leisure. Capture `logs --previous`, `describe` output, and events before you destroy the evidence — a rollback deletes the broken pods.
:::
