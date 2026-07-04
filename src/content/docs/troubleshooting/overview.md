---
title: Troubleshooting Overview
description: Symptom-to-playbook lookup table and the 60-second first-response commands for Kubernetes incidents.
sidebar:
  order: 1
---

You're here because something is broken. This page gets you to the right playbook fast. If you have 60 seconds, run the four commands below first — they answer most "what is actually happening" questions before you start guessing.

## The 60-second first response

Run these in order, in the affected namespace. Copy the output somewhere — you'll want it later for the ticket or the postmortem.

:::note[Check your namespace first]
Every command below is namespace-scoped. Ten seconds spent on `kubectl config view --minify | grep namespace` — or just adding an explicit `-n <namespace>` to everything — prevents the classic mid-incident detour of debugging an empty namespace. More kubectl reflexes in [kubectl Survival Kit](/start/kubectl-survival-kit/).
:::

```bash
# 1. What state is everything in?
kubectl get pods -o wide

# 2. What does Kubernetes say about the sick pod?
kubectl describe pod <pod-name>

# 3. What happened recently, in order?
kubectl get events --sort-by=.lastTimestamp

# 4. What did the container say before it died?
kubectl logs <pod-name> --previous
```

What each one buys you:

| Command | What it tells you |
|---|---|
| `get pods -o wide` | Status, restart counts, age, which node each pod landed on. `-o wide` matters: if every broken pod is on the same node, that's your answer. |
| `describe pod` | The `Events` section at the bottom is the single most information-dense place in Kubernetes. Scheduling failures, probe failures, image pull errors, OOM kills — they all show up here. |
| `get events --sort-by=.lastTimestamp` | Namespace-wide timeline. Catches things `describe` misses because the pod was already replaced. |
| `logs --previous` | The last words of the *previous* container instance. For crash loops, the current container often hasn't logged anything yet — the crash evidence is in the previous one. |

:::tip[Events expire]
Events are kept for about an hour by default. If the incident started earlier, the smoking gun may already be gone — another reason to capture output immediately. Your cluster may ship events to a log backend; see [Events](/observability/events/).
:::

## Symptom → playbook lookup

Find your symptom, go to the playbook. When in doubt, start with [Triage Methodology](/troubleshooting/triage-methodology/).

### Pod won't start

| Symptom | Status you'll see | Playbook |
|---|---|---|
| Pod sits in `Pending` forever | `Pending` | [Pod Pending](/troubleshooting/pod-pending/) |
| Pod stuck creating, volume/secret errors in events | `ContainerCreating` | [Pod Pending](/troubleshooting/pod-pending/) (volumes) or [CrashLoopBackOff](/troubleshooting/crashloopbackoff/) (config) |
| Image can't be pulled | `ErrImagePull`, `ImagePullBackOff` | [ImagePullBackOff](/troubleshooting/imagepullbackoff/) |
| Container starts, dies, restarts, repeat | `CrashLoopBackOff`, `Error` | [CrashLoopBackOff](/troubleshooting/crashloopbackoff/) |
| Init container failing | `Init:Error`, `Init:CrashLoopBackOff` | [CrashLoopBackOff](/troubleshooting/crashloopbackoff/) |

### Pod runs but misbehaves

| Symptom | What you'll see | Playbook |
|---|---|---|
| Killed with exit code 137 | `OOMKilled` in `describe` | [OOMKilled](/troubleshooting/oomkilled/) |
| Running but `READY 0/1` | Readiness probe failing | [Service Unreachable](/troubleshooting/service-unreachable/) and [Health Checks](/workloads/health-checks/) |
| Restarts climbing but pod looks fine now | Restart count > 0, events show probe kills | [CrashLoopBackOff](/troubleshooting/crashloopbackoff/) (liveness section) |
| Pod `Evicted` | `Status: Failed`, `Reason: Evicted` | [Node Problems](/troubleshooting/node-problems/) |
| Slow, high latency, CPU pegged | Throttling, no crash | [Performance Analysis](/observability/performance-analysis/) |

### Traffic problems

| Symptom | Playbook |
|---|---|
| "The service is down" / connection refused / timeouts | [Service Unreachable](/troubleshooting/service-unreachable/) |
| DNS lookup failures (`no such host`) | [Service Unreachable](/troubleshooting/service-unreachable/), then [DNS](/networking/dns/) |
| Ingress returning 502/503/504 | [Service Unreachable](/troubleshooting/service-unreachable/) (ingress section) |
| Works from one pod but not another | [Network Policies](/networking/network-policies/) |

### Cluster-side weirdness

| Symptom | Playbook |
|---|---|
| Pods stuck `Terminating` or `Unknown`, mass rescheduling | [Node Problems](/troubleshooting/node-problems/) |
| Pods evicted with ephemeral-storage messages | [Node Problems](/troubleshooting/node-problems/) |
| `Error from server (Forbidden)` on any kubectl command | [RBAC Denied](/troubleshooting/rbac-denied/) |
| Your app's in-cluster API calls getting 403 | [RBAC Denied](/troubleshooting/rbac-denied/) |

### You need to poke around

| Need | Playbook |
|---|---|
| Shell into a container with no shell (distroless) | [Debugging Toolbox](/troubleshooting/debugging-toolbox/) |
| I have an exact error string and want the right playbook | [Error Message Index](/troubleshooting/error-index/) |
| I'm exec'd into a pod — what do I run and how do I read it? | [Linux Inside the Pod](/troubleshooting/linux-inside-the-pod/) |
| No shell in the image / need tools in a locked-down pod | [The BusyBox Toolkit](/troubleshooting/busybox/) and [Debugging Toolbox](/troubleshooting/debugging-toolbox/) |
| Debug a container that crashes before you can exec | [Debugging Toolbox](/troubleshooting/debugging-toolbox/) (`--copy-to`) |
| Network tools (curl, dig, tcpdump) next to your pod | [Debugging Toolbox](/troubleshooting/debugging-toolbox/) |
| PVC Pending / FailedMount / Multi-Attach / volume full | [Volume and Storage Failures](/troubleshooting/volume-failures/) |

## Reading pod status at a glance

`kubectl get pods` compresses a lot into the `STATUS` column. Quick decoder:

```console
NAME                        READY   STATUS             RESTARTS      AGE
api-7d4b9c6f8-2xkqp         1/1     Running            0             2d
api-7d4b9c6f8-9wlmn         0/1     CrashLoopBackOff   6 (45s ago)   8m
api-7d4b9c6f8-kj2rp         0/1     Pending            0             8m
worker-5f6d8b9c7-xv4tz      0/1     ImagePullBackOff   0             8m
batch-job-p8s7d             0/1     Completed          0             1h
old-api-6c5d7e8f9-mn3op     1/1     Terminating        0             3d
```

- `READY 0/1` with `Running` — the container is up but failing its readiness probe. It receives no Service traffic.
- `RESTARTS 6 (45s ago)` — the parenthetical is when the last restart happened. Recent restarts on an "old" pod mean an ongoing problem, not a startup hiccup.
- `Completed` on a Job pod is normal. `Completed` on a Deployment pod is not — check the container command.
- Two different `pod-template-hash` suffixes among your pods (e.g. `7d4b9c6f8` and `84c5d9f6b`) mean a rollout is in flight or stuck — old and new revisions coexist, and only one of them may be broken.

Restart counts deserve one more note: `RESTARTS 0` on a pod that is 4 minutes old, when the incident started an hour ago, means the *pod itself* was recently replaced — check whether a Deployment rollout or an eviction created it, because the original evidence died with its predecessor.

## Capture an evidence bundle in one paste

Before you change anything — and especially before a rollback destroys the broken pods — snapshot the state. One block, paste it into the incident channel:

```bash
NS=payments; APP=api
{
  date -u
  kubectl -n $NS get pods -l app=$APP -o wide
  kubectl -n $NS get events --sort-by=.lastTimestamp | tail -30
  for p in $(kubectl -n $NS get pods -l app=$APP -o name); do
    echo "==== $p ===="
    kubectl -n $NS describe $p | grep -A12 "Last State\|Conditions:"
    kubectl -n $NS logs $p --previous --tail=40 2>/dev/null
  done
} > incident-$(date -u +%Y%m%dT%H%M%S).txt
```

Thirty seconds now saves the "does anyone still have the describe output?" scramble during the postmortem — and it's exactly the package a platform escalation needs.

:::caution[Don't fix the symptom on the pod]
Pods owned by a Deployment are cattle. Deleting a broken pod gets you a fresh one — which is a legitimate diagnostic step ("does a new pod work?") — but if the replacement breaks the same way, the problem is in the spec, the config, the image, or the cluster. Fix it there, through your pipeline. See [Drift and CI/CD](/operations/drift-and-cicd/).
:::

## What you can and can't fix from your seat

This guide assumes you own your namespace, not the cluster. Rough division of labor:

**Yours:** manifests, images, resource requests/limits, probes, ConfigMaps/Secrets, Service selectors and ports, PDBs, application logs and behavior.

**Platform's:** nodes, kubelet, CNI, ingress controllers, DNS infrastructure, ResourceQuotas, RBAC grants, storage classes, cluster capacity.

Every playbook in this section flags the handoff point. When you hit it, escalate with evidence — [Working with the Platform Team](/operations/working-with-platform-team/) covers what a good escalation looks like, and [Triage Methodology](/troubleshooting/triage-methodology/) covers what to collect before you do.

One habit ties this whole section together: **read the actual error before forming a theory.** Kubernetes states its complaints verbatim in `describe` output and events. The playbooks here are mostly organized decodings of those messages — start from the message, and you'll usually land on the right fix in one hop.
