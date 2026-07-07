---
title: Learning Paths
description: Curated reading tracks through the site — new-to-K8s, Java and .NET onboarding, on-call prep, shipping to prod, and running stateful services.
keywords:
  - where do i start on this site
  - how this guide is organized
  - reading track for people new to kubernetes
  - java developer onboarding path
  - dotnet developer onboarding path
  - on-call and pager preparation track
  - shipping to production checklist track
  - running stateful services track
  - which pages to read in order
---

This site has ~180 pages. Nobody should read it front to back, and nobody should land mid-topic without the prerequisites. Pick the track that matches your situation, read the steps **in order**, and use the checkpoint to know when you're done.

Time estimates assume reading plus trying things against a real (dev) namespace. If you only read, halve them — and retain half as much.

**A few rules of thumb:**

- Track 1 is the prerequisite for everything else. If you can't yet explain what a Deployment does, start there regardless of your role.
- Tracks combine. A Java developer joining on-call does 1 → 2 → 4; a tech lead preparing a prod launch does 1 → 5, dipping into 2 or 3 for their stack.
- Skim what you know, but don't skip the checkpoints — they're the honest test of whether skipping was safe.
- Every track ends before the site does. When you finish one, the section overview pages are the map to the rest.

## 1. New to deploying on Kubernetes

**Who it's for:** you've built and shipped apps, but Kubernetes is new — someone handed you a namespace and a kubeconfig and said "deploy it."
**Time:** about a week, an hour or two a day.

1. [Overview](/start/overview/) — what this site assumes and how a platform-managed cluster changes the game.
2. [How Kubernetes Works](/start/how-kubernetes-works/) — the mental model (desired state, controllers) everything else builds on.
3. [Working Without Admin](/start/working-without-admin/) — what you can and can't do as a namespace tenant, so nothing later surprises you.
4. [YAML, Labels & Namespaces](/start/yaml-labels-and-namespaces/) — the grammar every manifest uses.
5. [kubectl Survival Kit](/start/kubectl-survival-kit/) — the dozen commands you'll run daily.
6. [Life of a Deployment](/start/life-of-a-deployment/) — follow one `kubectl apply` from YAML to running pods.
7. [Deployments Deep Dive](/workloads/deployments-deep-dive/) — the workload type you'll actually use 90% of the time.
8. [What Triggers a Rollout](/workloads/rollout-triggers/) — which changes replace your pods and which silently don't; saves you the two classic deploy surprises.
9. [Health Checks](/workloads/health-checks/) — probes are the contract between your app and the cluster.
10. [Resources & QoS](/workloads/resources-and-qos/) — requests and limits, before they bite you.
11. [Configuration](/workloads/configuration/) — ConfigMaps, env vars, and where secrets fit.
12. [Triage Methodology](/troubleshooting/triage-methodology/) — your first broken pod, diagnosed in the right order.
13. [Error Message Index](/troubleshooting/error-index/) — bookmark it; you'll use it more than any other page.

**You're done when you can:** deploy an app from scratch with probes and resource requests, roll it back after a bad change, and diagnose a `CrashLoopBackOff` or `Pending` pod without asking for help.

## 2. Java team onboarding

**Who it's for:** Java/Spring developers whose app now runs in a container with a memory limit — and who need dumps, GC data, and debugging back.
**Time:** 2–3 days. Do track 1 first if Kubernetes itself is new.

1. [Java Overview](/java/overview/) — the map of what changes for the JVM on Kubernetes.
2. [JVM in Containers](/java/jvm-in-containers/) — container-aware ergonomics, heap sizing vs. the memory limit; the single most important page in this track.
3. [Thread Dumps (JRE-only)](/java/thread-dumps-jre-only/) — get a thread dump from a stripped-down image with no JDK tools.
4. [Heap Dumps (JRE-only)](/java/heap-dumps-jre-only/) — the same, for heap dumps; pair with the previous page.
5. [Getting Dumps Out](/java/getting-dumps-out/) — a dump inside a pod is useless; move it to your laptop.
6. [Memory Leaks & OOM](/java/memory-leaks-and-oom/) — `OutOfMemoryError` vs. `OOMKilled`, and how to tell which one you have.
7. [Spring Boot](/java/spring-boot/) — probes via [Actuator](/java/actuator/), graceful shutdown, lifecycle wiring.
8. [JVM–Kubernetes Coupling](/java/jvm-kubernetes-coupling/) — the map of which JVM flag interacts with which Kubernetes knob.
9. [JVM Memory Knobs](/tuning/jvm-memory-knobs/) — set heap, Metaspace, and the limit as one coherent budget.
10. [Sizing Walkthrough](/tuning/sizing-walkthrough/) — do the numbers once end-to-end on a real service.

**You're done when you can:** explain your pod's memory budget (heap + non-heap + headroom = limit), pull a thread and heap dump from a JRE-only production pod, and tell an `OOMKilled` from a `java.lang.OutOfMemoryError` in under a minute.

## 3. .NET team onboarding

**Who it's for:** .NET/ASP.NET Core developers moving services onto the cluster — same story as the Java track, CLR edition.
**Time:** 1–2 days. Do track 1 first if Kubernetes itself is new.

1. [.NET Overview](/dotnet/overview/) — what's different about the CLR on Kubernetes.
2. [.NET in Containers](/dotnet/dotnet-in-containers/) — GC modes, heap limits, and how the runtime reads cgroups.
3. [ASP.NET Core on K8s](/dotnet/aspnetcore-on-k8s/) — Kestrel, forwarded headers behind ingress, graceful shutdown.
4. [Operational Endpoints](/dotnet/operational-endpoints/) — health check endpoints wired to liveness and readiness probes.
5. [Diagnostics](/dotnet/diagnostics/) — `dotnet-counters`, `dotnet-dump`, `dotnet-trace` inside a pod.
6. [Health Check Knobs](/tuning/health-check-knobs/) — tune probe timing to your app's real startup and latency.
7. [Requests & Limits Knobs](/tuning/requests-limits-knobs/) — right-size CPU and memory for the CLR.
8. [Sizing Walkthrough](/tuning/sizing-walkthrough/) — apply it once end-to-end.

**You're done when you can:** capture a dump from a running pod with `dotnet-dump`, explain how Server GC interacts with your CPU limit, and wire ASP.NET Core health checks to probes that pass a rolling restart cleanly.

## 4. Carrying the pager

**Who it's for:** you're joining the on-call rotation for services on the cluster. You need diagnosis speed at 3 a.m., not architecture theory.
**Time:** 2 days of reading, then a game-day drill.

1. [Triage Methodology](/troubleshooting/triage-methodology/) — the fixed order of questions that finds the failing layer fast.
2. [Troubleshooting Overview](/troubleshooting/overview/) — the map of symptom playbooks; skim so you know what exists.
3. [Error Message Index](/troubleshooting/error-index/) — paste the error, get the playbook. Bookmark it.
4. Read the big four playbooks: [Pod Pending](/troubleshooting/pod-pending/), [CrashLoopBackOff](/troubleshooting/crashloopbackoff/), [OOMKilled](/troubleshooting/oomkilled/), [Service Unreachable](/troubleshooting/service-unreachable/) — these cover most pages you'll ever get.
5. [Debugging Toolbox](/troubleshooting/debugging-toolbox/) — ephemeral containers and `kubectl debug` for distroless pods.
6. [Busybox](/troubleshooting/busybox/) — the minimal-tools cheatsheet for when the toolbox isn't available.
7. [Events](/observability/events/) — the cluster's own account of what happened, and how to read it before it expires.
8. [PromQL for Resources](/observability/promql-for-resources/) — the five queries that answer "is it CPU, memory, or restarts?"
9. [Emergency Playbooks](/operations/emergency-playbooks/) — pre-written moves for rollback, scale-out, and stop-the-bleeding.
10. [Working with the Platform Team](/operations/working-with-platform-team/) — know what's yours to fix and how to escalate the rest with the right evidence.

**You're done when you can:** go from page to identified failing layer in five minutes using triage + the error index, exec/debug into a distroless pod, and execute a rollback from the emergency playbook without looking up syntax.

## 5. Locking down and shipping to prod

**Who it's for:** your service works in dev; now it has to survive a production readiness review — security posture, least privilege, and a repeatable pipeline.
**Time:** 3–4 days, including the review against the golden service.

1. [Pod Security](/workloads/pod-security/) — non-root, read-only rootfs, dropped capabilities, and the `restricted` profile your namespace probably enforces.
2. [ServiceAccounts](/workloads/serviceaccounts/) — a dedicated identity per workload, with token automounting off unless needed.
3. [Secrets](/workloads/secrets/) — how to consume secrets without leaking them into logs, env dumps, or git.
4. [Network Policies](/networking/network-policies/) — default-deny and the explicit allows your service actually needs.
5. [High Availability](/workloads/high-availability/) — replicas, PodDisruptionBudgets, and spread so maintenance doesn't take you down.
6. [Golden Service](/architectures/golden-service/) — the fully-assembled reference; diff your manifests against it.
7. [Helm & Kustomize](/operations/helm-and-kustomize/) — package the result so it's reproducible across environments.
8. [CI/CD Pipeline Design](/operations/cicd-pipeline-design/) — the pipeline that ships it, with drift kept out ([Drift & CI/CD](/operations/drift-and-cicd/)).
9. [Supply Chain Security](/operations/supply-chain-security/) — image provenance, scanning, and pinning.

**You're done when you can:** pass a manifest diff against the golden service with no findings, explain every RBAC rule and network allow your app holds, and ship a change to prod through the pipeline with zero manual `kubectl apply`.

## 6. Running state

**Who it's for:** your team owns a database, cache, or message queue **inside** the cluster — not just an app pointing at managed services.
**Time:** about a week, plus a scheduled restore drill.

1. [Stateful Overview](/stateful/overview/) — should this even run in-cluster? Decide deliberately.
2. [StatefulSets Fundamentals](/stateful/statefulsets-fundamentals/) — stable identity, ordered rollout, and why Deployments don't cut it here.
3. [Storage: PV & PVC](/stateful/storage-pv-pvc/) — the storage lifecycle your data depends on.
4. [Operators for State](/stateful/operators-for-state/) — why real databases are run by operators, and what that means for you day-2.
5. Pick your build and read it end to end:
   - Cache: [Valkey & Redis](/stateful/valkey-and-redis/) → [Valkey Shared VIP](/architectures/valkey-shared-vip/)
   - Relational: [PostgreSQL](/stateful/postgresql/) → [PostgreSQL HA](/architectures/postgresql-ha/) (or [Oracle](/stateful/oracle/))
   - Messaging: [Message Queues](/stateful/message-queues/) → [RabbitMQ](/architectures/rabbitmq/), [IBM MQ](/architectures/ibm-mq/), or [Kafka with Strimzi](/architectures/kafka-strimzi/)
6. [Long-Lived Connections](/networking/long-lived-connections/) — stateful clients hold connections; learn how the network kills them.
7. [Backup & DR](/stateful/backup-and-dr/) — backups you haven't restored are hopes, not backups. Schedule the drill.
8. [Volume Failures](/troubleshooting/volume-failures/) — the failure modes you'll actually see: Multi-Attach, FailedMount, stuck PVCs.

**You're done when you can:** explain what happens to your data when a node dies mid-write, perform a restore from backup into a scratch namespace and verify the data, and survive a single-replica failure with no client-visible outage.

## Not on a track?

- Hunting a specific error string → [Error Message Index](/troubleshooting/error-index/)
- Hunting a specific task ("how do I rotate a secret?") → [Solutions Index](/start/solutions-index/)
- Just browsing → each section's overview page ([Workloads](/workloads/overview/), [Networking](/networking/overview/), [Observability](/observability/overview/), …) is the guided tour.
