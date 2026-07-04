---
title: Start Here
description: What this field guide covers, who it's for, and how to navigate it when you own the apps but not the cluster.
sidebar:
  order: 1
---

You deploy applications to Kubernetes. You don't run Kubernetes. That distinction shapes every page of this site.

Somewhere in your organization there's a platform team (maybe called SRE, infrastructure, cloud engineering, or "the Kubernetes team") that owns the nodes, the network plugin, the ingress controllers, RBAC policy, and everything cluster-scoped. You get a namespace — maybe a few — a kubeconfig scoped to it, and a CI/CD pipeline that turns your manifests into running pods. That's the deal, and it's a good deal. But most Kubernetes documentation assumes you're cluster-admin, and it will happily tell you to `ssh` into a node or edit a DaemonSet you can't even see.

This guide doesn't do that. Everything here works from the seat you actually sit in.

## The operating model

The split of responsibilities looks roughly like this in most organizations:

| You own | Platform team owns |
|---|---|
| Deployments, ReplicaSets, Pods | Nodes, node pools, OS patching |
| Services, your Ingress *resources* | Ingress *controllers*, load balancers |
| ConfigMaps, Secrets in your namespace | Cluster-wide secrets management, KMS |
| PVCs (claims) | StorageClasses, CSI drivers, the actual disks |
| Resource requests/limits on your pods | ResourceQuotas, LimitRanges, cluster capacity |
| Your app's NetworkPolicies (usually) | CNI plugin, cluster network architecture |
| HPAs for your workloads | Metrics server, cluster autoscaler |
| Your ServiceAccounts | Roles, ClusterRoles, RBAC bindings |

When something breaks, the first triage question is often *which side of this table does the failure live on?* A pod stuck in `Pending` because you asked for 16Gi of memory is your problem. A pod stuck in `Pending` because every node has a disk-pressure taint is theirs — but you'll be the one who notices first, and you need to bring them evidence, not vibes. [Working Without Admin](/start/working-without-admin/) covers that boundary in detail, and the troubleshooting section shows you how to tell the difference case by case.

:::note[The one rule of this site]
If an instruction requires node SSH or cluster-admin, we say so explicitly and tell you what to ask your platform team for. If you see advice elsewhere that starts with "on the node, run...", that's your cue that the article wasn't written for you.
:::

## Who this is for

- **Application developers** shipping services to a namespace someone else provisioned.
- **Dev/ops or app-ops engineers** who carry the pager for the app but not the cluster.
- **Java teams specifically** — there's a whole section on JVM-in-container pain, because getting a heap dump out of a distroless JRE-only image at 3 a.m. is a rite of passage nobody should improvise.

You should be comfortable with a terminal and have `kubectl` access to at least one namespace. You do not need prior Kubernetes-internals knowledge; the next two articles build the mental model.

## How the site is organized

Each section stands alone and opens with its own overview:

- **Start** (you are here) — the mental model and the daily toolkit. Read [How Kubernetes Works](/start/how-kubernetes-works/) and [Life of a Deployment](/start/life-of-a-deployment/) first; they pay for everything else.
- **[kubectl Mastery](/kubectl/overview/)** — beyond the survival kit: how kubectl actually talks to the API, output and query wizardry, and the tricks that make you fast.
- **[Workloads](/workloads/overview/)** — Deployments, rollouts, autoscaling, health checks, resources and QoS, Jobs. The bread and butter.
- **[Java on Kubernetes](/java/overview/)** — JVM memory in cgroups, thread and heap dumps with a JRE-only image, remote debugging, GC tuning.
- **[Stateful Workloads](/stateful/overview/)** — StatefulSets, storage, and running (or connecting to) PostgreSQL, Valkey/Redis, Oracle, and message queues.
- **[Networking](/networking/overview/)** — Services, DNS, Ingress, NetworkPolicies, and how to debug "it can't reach the thing".
- **[Controllers & Operators](/controllers/overview/)** — reconciliation, CRDs, and the controllers your platform team runs that affect you (MetalLB, F5 CIS, CSI drivers, admission webhooks).
- **[Observability](/observability/overview/)** — logs, metrics, events, tracing: knowing what your app is doing without exec-ing into it.
- **[Troubleshooting](/troubleshooting/overview/)** — a triage methodology plus one article per infamous failure mode (`CrashLoopBackOff`, `ImagePullBackOff`, `OOMKilled`, ...).
- **[Operations](/operations/overview/)** — day-2 reality: live patching vs GitOps drift, secret rotation, emergency playbooks, and working with your platform team.

## Where to go for common needs

| You need to... | Go to |
|---|---|
| Learn the core mental model | [How Kubernetes Works](/start/how-kubernetes-works/) |
| Find the right article for any task | [How Do I…? Solutions Index](/start/solutions-index/) |
| Follow a curated reading track | [Learning Paths](/learning-paths/) |
| Understand what happens when you `kubectl apply` | [Life of a Deployment](/start/life-of-a-deployment/) |
| Find out what you're allowed to do | [Working Without Admin](/start/working-without-admin/) |
| Understand the permission model itself | [RBAC Explained](/start/rbac-explained/) |
| Get the daily kubectl commands | [kubectl Survival Kit](/start/kubectl-survival-kit/) |
| Go deeper on kubectl | [kubectl Mastery](/kubectl/overview/) |
| Stop fighting YAML and labels | [YAML, Labels, and Namespaces](/start/yaml-labels-and-namespaces/) |
| Run Kubernetes on your laptop | [Local Development](/start/local-development/) |
| Fix a pod that won't start | Troubleshooting section, starting at the triage methodology |
| Ship a zero-downtime deploy | Workloads: rollouts, health checks, high availability |
| Pull a heap dump from a locked-down JVM pod | Java section |

## Before you start: a two-minute access check

Everything in this guide assumes a working, namespace-scoped kubectl. Verify yours now so the first time you test it isn't during an incident:

```bash
kubectl version                      # client and server versions
kubectl config current-context      # which cluster you're talking to
kubectl get pods                     # can you list pods in your namespace?
kubectl auth can-i --list | head -20 # what you're actually allowed to do
```

Expected output for the last one looks something like:

```console
Resources          Verbs
deployments.apps   [get list watch create update patch delete]
pods               [get list watch delete]
pods/log           [get]
pods/exec          [create]
services           [get list watch create update patch delete]
```

If `kubectl get pods` returns `Forbidden` or you're staring at someone else's namespace, sort that out with your platform team first — [Working Without Admin](/start/working-without-admin/) explains what a typical grant looks like and how to ask for what's missing.

## How to read it

If you're new to Kubernetes: read this Start section in order — it's six articles and roughly an afternoon. [How Kubernetes Works](/start/how-kubernetes-works/) gives you the reconciliation mental model, [Life of a Deployment](/start/life-of-a-deployment/) makes it concrete, and the remaining three equip you for daily work. After that, read the [Workloads overview](/workloads/overview/) before you write your first production Deployment.

If you've been running apps on Kubernetes for a while: skim [kubectl Survival Kit](/start/kubectl-survival-kit/) for tricks you may have missed, then jump straight to whatever's on fire. Every troubleshooting article is written to be entered cold, mid-incident: symptom at the top, diagnosis steps in order, escalation criteria at the bottom.

One habit to build from day one: when something surprises you, run `kubectl describe` on the object and `kubectl get events` in the namespace *before* you form a theory. Kubernetes almost always tells you what's wrong; it just tells you in a place you weren't looking.

## The vocabulary you'll see everywhere

Ten terms carry most Kubernetes conversations. Skim now; the linked articles make each one concrete:

| Term | One-line meaning |
|---|---|
| **Pod** | The unit of deployment: one or more containers sharing a network identity. You almost never create pods directly. |
| **Deployment** | "Run N replicas of this pod spec, and roll updates gradually." Your default workload type. |
| **ReplicaSet** | The layer a Deployment uses to keep exactly N pods alive. You read it, never write it. |
| **Service** | A stable virtual IP and DNS name in front of an ever-changing set of pods. |
| **Ingress** | HTTP(S) routing rules from outside the cluster to your Services. |
| **Namespace** | Your fenced-off scope: names, RBAC, and quotas live inside it. |
| **ConfigMap / Secret** | Configuration and credentials, mounted into pods as env vars or files. |
| **Label / selector** | Key-value tags and the queries that match them — the glue binding Deployments, pods, and Services. |
| **Reconciliation** | The loop at the heart of everything: controllers continuously push actual state toward desired state. |
| **kubelet** | The per-node agent that actually starts your containers and runs your health probes. |

If half of those are fuzzy, that's expected — it's what the next two articles are for.

## Conventions used throughout

- **Commands are namespace-scoped.** Examples omit `-n <namespace>` and assume your context's default namespace is set (the survival kit shows how). When a command genuinely crosses namespaces, we say so.
- **Names are placeholders with a pattern.** `my-app` is the app, `my-app-7c9d8b6f5d-x2klp` is a generated pod name — yours will differ, the shape won't.
- **Console blocks show realistic output**, sometimes trimmed with `...`. If your output differs wildly from the example, that difference is usually the clue.
- **Asides carry the hard-won stuff.** `:::tip` is a shortcut, `:::caution` is a way people get burned, `:::danger` is a way people cause outages. Don't skip them.
- **"Ask your platform team" is a real instruction**, not a shrug. When you see it, the article tells you what to ask for and what evidence to attach.

## A suggested first week

If you've just been handed a namespace, this sequence turns it from foreign territory into home ground:

1. **Day 1** — run the access check above; set your default namespace; read [How Kubernetes Works](/start/how-kubernetes-works/) and [Life of a Deployment](/start/life-of-a-deployment/).
2. **Day 2** — inventory what's already running: `kubectl get all`, `kubectl get configmaps,secrets,pvc`, and `kubectl describe resourcequota`. Map every object to the manifest in git that produced it. Anything unaccounted for is a question for your team.
3. **Day 3** — work through the [kubectl Survival Kit](/start/kubectl-survival-kit/) hands-on against a non-production namespace: describe a pod, follow logs, exec in, port-forward to a service.
4. **Day 4** — break something on purpose in staging: scale a Deployment down, delete a pod, deploy an image tag that doesn't exist. Watch how each failure surfaces in events and statuses. Practicing diagnosis when nothing is at stake is what makes it fast when something is.
5. **Day 5** — find out how deploys actually reach the cluster (which pipeline, which trigger, who can approve), and where logs and metrics land. Bookmark your platform team's request process.

Half a day of this beats weeks of learning each piece mid-incident.

## What this guide is not

- **Not a cluster administration guide.** No kubeadm, no etcd backups, no CNI selection. If you also run the cluster, you need more than this site.
- **Not a certification course.** Coverage is driven by what app teams hit in production, not by an exam blueprint — you'll find more here about heap dumps and `CrashLoopBackOff` than about writing schedulers.
- **Not tied to one vendor.** Examples work on any conformant Kubernetes — EKS, AKS, GKE, OpenShift, on-prem. Where a platform-specific behavior matters (load balancers, storage), we flag it as a question for your platform team.

## Next

Start with [How Kubernetes Works](/start/how-kubernetes-works/). It's one article, one diagram, and one mental model — reconciliation — and twenty minutes there saves you hours everywhere else on this site.

If you're reading this because something is broken *right now*: skip ahead to the [Troubleshooting overview](/troubleshooting/overview/), follow the triage steps, and come back for the fundamentals when the fire's out. The guide will still be here.
