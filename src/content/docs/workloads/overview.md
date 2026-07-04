---
title: Workloads Overview
description: How Deployments, ReplicaSets, and Pods fit together, and a map of the workloads section so you can find the article you actually need.
sidebar:
  order: 1
---

Everything you run in Kubernetes eventually becomes a Pod. But you almost never create Pods directly — you create a higher-level object and let controllers do the work. Understanding that hierarchy is the difference between "my app is broken" and "my Deployment's new ReplicaSet can't schedule pods because the resource requests changed."

## The workload hierarchy

For a typical stateless service, three objects are in play:

```text
Deployment  (your intent: "run 3 replicas of image v1.42, roll updates gradually")
    └── ReplicaSet  (one per pod-template revision: "keep exactly 3 pods of this template alive")
            └── Pod  (the actual running thing: containers, volumes, an IP)
```

You edit the **Deployment**. The Deployment controller stamps out a **ReplicaSet** for each unique pod template it has seen, and orchestrates scaling the new one up while scaling the old one down. Each ReplicaSet's only job is to keep its pod count at the desired number — it creates and deletes **Pods** to make that true.

This is why:

- Deleting a Pod is almost always safe and self-healing — the ReplicaSet replaces it in seconds. (This is what `kubectl rollout restart` exploits.)
- Deleting a ReplicaSet is usually pointless — the Deployment recreates it.
- Editing a Pod directly is futile for anything owned by a Deployment — your change lives until the next restart, then vanishes. That's drift; see [live patching](/operations/live-patching/) before you're tempted.

You can see the whole chain with owner references:

```console
$ kubectl get pod payments-7d9f8b6c4d-x2kfp -o jsonpath='{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}'
ReplicaSet/payments-7d9f8b6c4d

$ kubectl get rs payments-7d9f8b6c4d -o jsonpath='{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}'
Deployment/payments
```

## Not everything is a Deployment

| Controller | Use it for | Covered in |
|---|---|---|
| **Deployment** | Stateless services, APIs, web frontends — anything where replicas are interchangeable | This section |
| **StatefulSet** | Databases, queues, anything needing stable identity or per-pod storage | [Stateful workloads](/stateful/statefulsets-fundamentals/) |
| **Job / CronJob** | Run-to-completion work: migrations, batch processing, scheduled tasks | [Jobs and CronJobs](/workloads/jobs-and-cronjobs/) |
| **DaemonSet** | One pod per node (log shippers, node agents) | [DaemonSets](/workloads/daemonsets/) — usually platform territory, but worth understanding |

:::note
DaemonSets typically need node-level privileges and tolerations the platform team controls. If you think you need one, [talk to your platform team](/operations/working-with-platform-team/) first — there's often a namespace-scoped alternative.
:::

## What's in this section

1. **[Deployments deep dive](/workloads/deployments-deep-dive/)** — the spec field by field: the selector/labels contract, replicas, revision history, and how Deployments, ReplicaSets, and Pods relate on the wire.
2. **[Rollouts and rollbacks](/workloads/rollouts-and-rollbacks/)** — RollingUpdate vs Recreate, maxSurge/maxUnavailable tuning, `kubectl rollout`, and canary/blue-green patterns you can build with nothing but labels.
3. **[High availability](/workloads/high-availability/)** — PodDisruptionBudgets, anti-affinity, topology spread, and graceful shutdown so node drains don't take you down.
4. **[Autoscaling](/workloads/autoscaling/)** — HPA v2 done right, stabilization windows, and the classic misconfigurations that cause replica thrash.
5. **[Health checks](/workloads/health-checks/)** — startup vs readiness vs liveness, precisely, plus the footguns that turn probes into outage generators.
6. **[Resources and QoS](/workloads/resources-and-qos/)** — requests vs limits, QoS classes, CPU throttling, and how to size honestly.
7. **[Configuration](/workloads/configuration/)** — ConfigMaps and Secrets, env vs volumes, update propagation, and forcing rollouts on config change.
8. **[Environment variables](/workloads/environment-variables/)** — every env source, precedence and collision rules, `$(VAR)` expansion, and JVM flag-injection patterns.
9. **[Config as files](/workloads/config-files-and-volumes/)** — volume mount mechanics, `subPath` traps, projected volumes, and file permissions.
10. **[Secrets](/workloads/secrets/)** — types, why files beat env, and keeping secrets out of git (Sealed Secrets, SOPS, External Secrets).
11. **[Jobs and CronJobs](/workloads/jobs-and-cronjobs/)** — run-to-completion semantics, retry behavior, schedules, and missed-run gotchas.
12. **[Init and sidecar containers](/workloads/init-and-sidecar-containers/)** — multi-container pods: init semantics, native sidecars, and the patterns that justify them.
13. **[Pod security](/workloads/pod-security/)** — securityContext, Pod Security Standards, and hardening that doesn't break the app.
14. **[ServiceAccounts](/workloads/serviceaccounts/)** — workload identity: pods calling the Kubernetes API and cloud services without long-lived keys.
15. **[Scheduling](/workloads/scheduling/)** — nodeSelector, affinity, taints and tolerations, topology spread, and priority — where pods land and why.
16. **[GPUs and AI workloads](/workloads/gpu-and-ai-workloads/)** — requesting accelerators you don't manage, model-load vs startup-probe budgets, and queue etiquette on shared GPUs.
17. **[DaemonSets](/workloads/daemonsets/)** — the per-node fleet running under your pods, how it affects you, and the rare cases where you run your own.

## Which article do I need?

| Symptom or question | Go to |
|---|---|
| "What does this Deployment YAML field actually do?" | [Deployments deep dive](/workloads/deployments-deep-dive/) |
| "My deploy is stuck / I need to roll back" | [Rollouts and rollbacks](/workloads/rollouts-and-rollbacks/) |
| "A node drain / cluster upgrade caused an outage" | [High availability](/workloads/high-availability/) |
| "Replicas keep bouncing up and down" | [Autoscaling](/workloads/autoscaling/) |
| "Pods restart under load but the app was fine" | [Health checks](/workloads/health-checks/) |
| "Pods are OOMKilled / CPU-starved / won't schedule" | [Resources and QoS](/workloads/resources-and-qos/) |
| "I changed a ConfigMap and nothing happened" | [Configuration](/workloads/configuration/) |
| "My nightly job didn't run / ran twice" | [Jobs and CronJobs](/workloads/jobs-and-cronjobs/) |
| "Why is this env var not what I set?" | [Environment variables](/workloads/environment-variables/) |
| "Deployment applied but pods never appear" | [Pod security](/workloads/pod-security/) |
| "My pod gets 403 calling the API / cloud" | [ServiceAccounts](/workloads/serviceaccounts/) |
| "Pod is Pending / CrashLoopBackOff right now" | [Troubleshooting section](/troubleshooting/triage-methodology/) |

## The three objects, one command

```console
$ kubectl get deploy,rs,pods -l app=payments
NAME                       READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/payments   3/3     3            3           42d

NAME                                  DESIRED   CURRENT   READY   AGE
replicaset.apps/payments-7d9f8b6c4d   3         3         3       2d
replicaset.apps/payments-6b5c7f9d8e   0         0         0       9d

NAME                            READY   STATUS    RESTARTS   AGE
pod/payments-7d9f8b6c4d-x2kfp   1/1     Running   0          2d
pod/payments-7d9f8b6c4d-9qwlm   1/1     Running   0          2d
pod/payments-7d9f8b6c4d-tk4vz   1/1     Running   0          2d
```

One Deployment, two ReplicaSets (the old one scaled to zero after the last rollout), three Pods whose names carry the ReplicaSet's hash. When something looks wrong, run `kubectl describe` on the level that's unhealthy and read the Events at the bottom — that's the fastest path to a diagnosis. More on that in the [kubectl survival kit](/start/kubectl-survival-kit/).

:::tip
Old ReplicaSets scaled to zero are normal — they're your rollback history, kept per `revisionHistoryLimit`. Don't delete them by hand.
:::

## Reconciliation: why "fixing" pods never sticks

Every controller in this hierarchy runs the same loop: observe actual state, compare to desired state, act to close the gap. Forever. This has practical consequences you'll hit in week one:

- **Kill a pod, get a pod.** The ReplicaSet notices the count is 2 instead of 3 and creates a replacement within seconds. Great for resilience; also means "I deleted the bad pod" is a restart, not a fix.
- **Hand-edits to owned objects get reverted.** Scale a ReplicaSet directly and the Deployment scales it right back. Change a pod's image with `kubectl edit` and it survives only until the ReplicaSet replaces that pod.
- **The manifest in git is the only durable truth** — assuming your pipeline applies it. Anything you change imperatively (`kubectl scale`, `kubectl set image`, `kubectl edit`) lives on borrowed time until the next apply. This tension has its own article: [drift and CI/CD](/operations/drift-and-cicd/).

Internalize the loop and half of Kubernetes' "weird" behavior becomes obvious. The other half is in the [troubleshooting section](/troubleshooting/overview/).

## Labels: the glue you must get right

Nothing in the hierarchy is connected by name — it's all label selectors. The Deployment finds its pods by labels. The Service routes to pods by labels. Your monitoring queries filter by labels. A minimal, consistent scheme pays for itself daily:

```yaml
metadata:
  labels:
    app: payments                    # the selector key — stable, minimal
    app.kubernetes.io/name: payments # standard well-known labels, for tooling
    app.kubernetes.io/part-of: checkout
    version: 1.42.0                  # informational — NEVER in a selector
```

The one rule that outranks the rest: **selector labels are a contract, informational labels are decoration.** Selectors (on Deployments and Services) should be small and permanent; everything else — version, build, team, cost-center — goes on the template as extra labels that tooling can filter on. Why the distinction is load-bearing is covered in [deployments deep dive](/workloads/deployments-deep-dive/), and the broader conventions live in [YAML, labels, and namespaces](/start/yaml-labels-and-namespaces/).

## What you can and can't do here

A quick reality check for this guide's audience — you own the namespace, not the cluster:

| Yours to control | Platform team's domain |
|---|---|
| Deployments, ReplicaSets, Pods, Jobs, CronJobs in your namespaces | Nodes, kubelet flags, container runtime |
| Resource requests/limits, probes, affinity, PDBs for your apps | ResourceQuotas and LimitRanges imposed on you |
| HPAs targeting your Deployments | Metrics adapters, VPA/KEDA installation, PriorityClasses |
| Your Services and (usually) Ingress resources | Ingress controllers, CNI, cluster DNS |

Several articles in this section touch the boundary — PDBs that block node drains, quotas that block rollout surge, priority classes you reference but don't define. When you hit the line, the move is a data-backed request, not a workaround; [working with the platform team](/operations/working-with-platform-team/) covers how to make those conversations short.

## Suggested reading order

If you're new to running workloads here, read in sidebar order — each article builds on the last: the Deployment object itself, then how it rolls, then how it survives disruption, scales, reports health, consumes resources, and takes configuration, ending with the run-to-completion cousins.

If you're not new, treat this section as a reference and jump via the symptom table above. The two articles I'd push on *every* team regardless of experience:

- **[Health checks](/workloads/health-checks/)** — because probe misconfigurations are the single most common self-inflicted outage we see, and they hide for months before firing.
- **[High availability](/workloads/high-availability/)** — because the defaults (1 replica, no PDB, no spread, no graceful shutdown) all fail the same night the platform team schedules a cluster upgrade.

Everything in this section assumes stateless workloads. The moment your pods need stable identity, ordered startup, or storage that survives them, stop and read the [stateful section](/stateful/overview/) — Deployments are actively the wrong tool there, and the failure modes are data loss rather than downtime.

:::tip[One habit to build now]
End every deploy-related investigation with `kubectl get events --sort-by=.lastTimestamp | tail -20`. The controllers narrate everything they do — and fail to do — in events, and reading that narration beats guessing every time.
:::
