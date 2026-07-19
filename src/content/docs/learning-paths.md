---
title: Learning Paths
description: Curated reading tracks through the site — new-to-K8s, Java and .NET onboarding, on-call prep, shipping to prod, running stateful services, and the Linux under it all.
keywords:
  - where do i start on this site
  - how this guide is organized
  - reading track for people new to kubernetes
  - java developer onboarding path
  - dotnet developer onboarding path
  - on-call and pager preparation track
  - shipping to production checklist track
  - running stateful services track
  - ckad exam preparation study track
  - which pages to read in order
---

This site has ~240 pages. Nobody should read it front to back, and nobody should land mid-topic without the prerequisites. Pick the track that matches your situation, read the steps **in order**, and use the checkpoint to know when you're done.

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
3. [The Three Doors](/start/three-doors/) — the model for thinking about *any* workload: cost (requests/limits), truth (health checks), and response (scaling) as one loop. The rest of this track is you walking through these three doors.
4. [Working Without Admin](/start/working-without-admin/) — what you can and can't do as a namespace tenant, so nothing later surprises you.
5. [YAML, Labels & Namespaces](/start/yaml-labels-and-namespaces/) — the grammar every manifest uses.
6. [kubectl Survival Kit](/start/kubectl-survival-kit/) — the dozen commands you'll run daily.
7. [Life of a Deployment](/start/life-of-a-deployment/) — follow one `kubectl apply` from YAML to running pods.
8. [Deployments Deep Dive](/workloads/deployments-deep-dive/) — the workload type you'll actually use 90% of the time.
9. [What Triggers a Rollout](/workloads/rollout-triggers/) — which changes replace your pods and which silently don't; saves you the two classic deploy surprises.
10. [Health Checks](/workloads/health-checks/) — probes are the contract between your app and the cluster (Door 2).
11. [Resources & QoS](/workloads/resources-and-qos/) — requests and limits, before they bite you (Door 1).
12. [Configuration](/workloads/configuration/) — ConfigMaps, env vars, and where secrets fit.
13. [Triage Methodology](/troubleshooting/triage-methodology/) — your first broken pod, diagnosed in the right order.
14. [Error Message Index](/troubleshooting/error-index/) — bookmark it; you'll use it more than any other page.

**You're done when you can:** deploy an app from scratch with probes and resource requests, roll it back after a bad change, and diagnose a `CrashLoopBackOff` or `Pending` pod without asking for help.

## 2. Java team onboarding

**Who it's for:** Java/Spring developers whose app now runs in a container with a memory limit — and who need dumps, GC data, and debugging back.
**Time:** 2–3 days. Do track 1 first if Kubernetes itself is new.

1. [Java Overview](/java/overview/) — the map of what changes for the JVM on Kubernetes.
2. [JVM in Containers](/java/jvm-in-containers/) — container-aware ergonomics, heap sizing vs. the memory limit; the single most important page in this track. (Want the kernel's side of this story? [cgroups](/foundations/cgroups/), [Virtual Memory](/foundations/virtual-memory/), and [CPU Scheduling and the CFS](/foundations/cpu-scheduling-and-cfs/) explain what the JVM is adapting *to*.)
3. [Thread Dumps (JRE-only)](/java/thread-dumps-jre-only/) — get a thread dump from a stripped-down image with no JDK tools.
4. [Heap Dumps (JRE-only)](/java/heap-dumps-jre-only/) — the same, for heap dumps; pair with the previous page.
5. [Getting Dumps Out](/java/getting-dumps-out/) — a dump inside a pod is useless; move it to your laptop.
6. [Memory Leaks & OOM](/java/memory-leaks-and-oom/) — `OutOfMemoryError` vs. `OOMKilled`, and how to tell which one you have.
7. [JVM Native Crashes & hs_err_pid](/java/jvm-crashes/) — the third failure mode: a native crash with no stack trace, and preserving the fatal error log before the restart eats it.
8. [Spring Boot](/java/spring-boot/) — probes via [Actuator](/java/actuator/), graceful shutdown, lifecycle wiring.
9. [JVM–Kubernetes Coupling](/java/jvm-kubernetes-coupling/) — the map of which JVM flag interacts with which Kubernetes knob.
10. [JVM Memory Knobs](/tuning/jvm-memory-knobs/) — set heap, Metaspace, and the limit as one coherent budget.
11. [Sizing Walkthrough](/tuning/sizing-walkthrough/) — do the numbers once end-to-end on a real service.

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
5. [DNS Resolution Failures](/troubleshooting/dns-failures/) — the symptom-first playbook for `no such host`, intermittent 5-second stalls, and "it resolves in netshoot but not in my app"; DNS sits under half the "network is flaky" pages.
6. [HPA Not Scaling](/troubleshooting/hpa-not-scaling/) — when the autoscaler won't add pods (or won't stop), walked from `kubectl describe hpa` outward.
7. [kubectl Can't Reach the Cluster](/troubleshooting/api-server-broken/) — the pager skill for when your own tooling is the thing that's down: kubeconfig, context, token, and control-plane reachability.
8. [Debugging Toolbox](/troubleshooting/debugging-toolbox/) — ephemeral containers and `kubectl debug` for distroless pods.
9. [Busybox](/troubleshooting/busybox/) — the minimal-tools cheatsheet for when the toolbox isn't available.
10. Optional but compounding: [Processes, Signals, and PID 1](/foundations/processes-and-signals/), [TCP: What a Connection Actually Is](/foundations/tcp-connections/), and [DNS Resolution on Linux](/foundations/dns-resolution/) — the three Foundations pages that turn the most 3 a.m. symptoms from mysteries into mechanisms.
10. [Events](/observability/events/) — the cluster's own account of what happened, and how to read it before it expires.
11. [PromQL for Resources](/observability/promql-for-resources/) — the five queries that answer "is it CPU, memory, or restarts?"
12. [Emergency Playbooks](/operations/emergency-playbooks/) — pre-written moves for rollback, scale-out, and stop-the-bleeding.
13. [Working with the Platform Team](/operations/working-with-platform-team/) — know what's yours to fix and how to escalate the rest with the right evidence.

**You're done when you can:** go from page to identified failing layer in five minutes using triage + the error index, exec/debug into a distroless pod, and execute a rollback from the emergency playbook without looking up syntax.

## 5. Locking down and shipping to prod

**Who it's for:** your service works in dev; now it has to survive a production readiness review — security posture, least privilege, and a repeatable pipeline.
**Time:** 3–4 days, including the review against the golden service.

1. [Pod Security](/workloads/pod-security/) — non-root, read-only rootfs, dropped capabilities, and the `restricted` profile your namespace probably enforces. (What each dropped capability and seccomp profile actually switches off in the kernel: [Capabilities, seccomp, and LSMs](/foundations/security-primitives/).)
2. [ServiceAccounts](/workloads/serviceaccounts/) — a dedicated identity per workload, with token automounting off unless needed.
3. [Secrets](/workloads/secrets/) — how to consume secrets without leaking them into logs, env dumps, or git.
4. [Network Policies](/networking/network-policies/) — default-deny and the explicit allows your service actually needs.
5. [cert-manager](/controllers/cert-manager/) — automate TLS: request a serving cert into a Secret and let renewal stop being a pager event, so the green padlock survives the readiness review. (Chains, trust stores, and the handshake itself: [TLS: Handshakes, Certificates, and mTLS](/foundations/tls/).)
6. [High Availability](/workloads/high-availability/) — replicas, PodDisruptionBudgets, and spread so maintenance doesn't take you down.
7. [Golden Service](/architectures/golden-service/) — the fully-assembled reference; diff your manifests against it.
8. [Helm & Kustomize](/operations/helm-and-kustomize/) — package the result so it's reproducible across environments.
9. [CI/CD Pipeline Design](/operations/cicd-pipeline-design/) — the pipeline that ships it, with drift kept out ([Drift & CI/CD](/operations/drift-and-cicd/)).
10. [Supply Chain Security](/operations/supply-chain-security/) — image provenance, scanning, and pinning. (Why a digest is a guarantee and a tag is a hope: [Hashing](/foundations/hashing/).)

**You're done when you can:** pass a manifest diff against the golden service with no findings, explain every RBAC rule and network allow your app holds, and ship a change to prod through the pipeline with zero manual `kubectl apply`.

## 6. Running state

**Who it's for:** your team owns a database, cache, or message queue **inside** the cluster — not just an app pointing at managed services.
**Time:** about a week, plus a scheduled restore drill.

1. [Stateful Overview](/stateful/overview/) — should this even run in-cluster? Decide deliberately.
2. [StatefulSets Fundamentals](/stateful/statefulsets-fundamentals/) — stable identity, ordered rollout, and why Deployments don't cut it here.
3. [Storage: PV & PVC](/stateful/storage-pv-pvc/) — the storage lifecycle your data depends on.
4. [Operators for State](/stateful/operators-for-state/) — why real databases are run by operators, and what that means for you day-2.
5. Pick your build and read it end to end:
   - Cache: [Valkey & Redis](/stateful/valkey-and-redis/) → [Valkey Shared VIP](/architectures/valkey-shared-vip/) (going deep on storage? [Longhorn Under Valkey](/architectures/valkey-longhorn-deep-dive/))
   - Relational: [PostgreSQL](/stateful/postgresql/) → [PostgreSQL HA](/architectures/postgresql-ha/) (or [Oracle](/stateful/oracle/))
   - Messaging: [Message Queues](/stateful/message-queues/) → [RabbitMQ](/architectures/rabbitmq/), [IBM MQ](/architectures/ibm-mq/), or [Kafka with Strimzi](/architectures/kafka-strimzi/)
6. [Long-Lived Connections](/networking/long-lived-connections/) — stateful clients hold connections; learn how the network kills them. (The theory pair: [TCP](/foundations/tcp-connections/) for the connection itself, [HTTP](/networking/http/) for why gRPC and h2 pin to one backend.)
7. [Backup & DR](/stateful/backup-and-dr/) — backups you haven't restored are hopes, not backups. Schedule the drill.
8. [Volume Failures](/troubleshooting/volume-failures/) — the failure modes you'll actually see: Multi-Attach, FailedMount, stuck PVCs.

**You're done when you can:** explain what happens to your data when a node dies mid-write, perform a restore from backup into a scratch namespace and verify the data, and survive a single-replica failure with no client-visible outage.

## 7. Passing the CKAD

**Who it's for:** you want the Certified Kubernetes Application Developer credential — and you want one plan, not forty browser tabs.
**Time:** four weeks at about an hour a day (or two weeks if you already deploy to Kubernetes weekly).

This track has its own section with a full day-by-day plan; the short version:

1. [The Survival Guide](/ckad/overview/) — what the exam is, how it's scored, and the three skills that decide it.
2. [The Five Domains, Mapped](/ckad/exam-domains/) — the curriculum decoded into tasks, routed to the pages that teach each piece.
3. [The Speed System](/ckad/speed-system/) + [Vim for the CKAD](/kubectl/vim-for-ckad/) — the mechanics that make two hours enough.
4. [The Four-Week Study Plan](/ckad/study-plan/) — the actual schedule, built on [Labs 0–5](/labs/overview/).
5. [Timed Drills](/ckad/drills/) — thirteen exam-style tasks with par times; your readiness meter.

**You're done when you can:** score ≥10/13 on the drills within par, and your second [killer.sh](https://killer.sh/) session comes back comfortably above passing.

## 8. Autoscaling your service

**Who it's for:** your team runs Spring Boot services on the shared cluster and wants them to scale themselves — safely, with numbers you can defend in review.
**Time:** half a day of reading; the measurement and load test add a day spread over two weeks.

1. [Autoscaling, Explained From Zero](/autoscaling/overview/) — the feedback loop, the fixed-pool reality, and the maturity ladder to locate yourself on.
2. [The No-Assumptions Checklist](/autoscaling/prerequisites/) — ten preconditions, each with a proof command; run it against your real deployment.
3. [Rationalize the App and the Chart](/autoscaling/classify-your-app/) — is it even safe to run twice? Which archetype is it? Is the chart ready?
4. [The 15-Minute Conservative HPA](/autoscaling/quick-start/) — the first safe win, plus the watch-it-for-a-week queries.
5. [Start With the User: SLOs](/autoscaling/slos-for-scaling/) — turn user behavior into the thresholds' reason for existing.
6. [Know Your Traffic](/autoscaling/load-profile/) — measure steady state, low state, and peak; derive the floor and ceiling.
7. Your archetype's reference architecture: [Oracle-backed API](/autoscaling/rest-api-oracle/), [MQ/RabbitMQ consumers](/autoscaling/messaging-consumers/), or [web + worker](/autoscaling/web-worker-and-caches/).
8. [Capacity and Governance](/autoscaling/capacity-and-governance/) — the review checklist your PR will face, and the ledger your ceiling joins.
9. [Lab 10](/labs/lab-10-autoscaling/) — feel all of it on a laptop: HPA under load, the capacity wall, and a queue-depth HPA fed through a metrics pipeline you build by hand.

**You're done when you can:** show a derivation comment for every number in your autoscaling values, name the external ceiling and its owner, and demo a load test where scale-up, the ceiling, and scale-down all behaved as the math predicted.

## 9. Understanding the machine

**Who it's for:** you can deploy, debug, and ship — and now you want to know what's actually happening. The senior-engineer track: every Kubernetes abstraction traced down to the Linux primitive that implements it.
**Time:** two to three weeks at an article a day. Nothing here is required for any other track; everything here makes every other track easier.

1. [Kubernetes Is Linux](/troubleshooting/kubernetes-is-linux/) — the survey that maps every concept to its primitive. Read it first; it's the trailhead the whole Foundations section expands.
2. [Foundations: Start Here](/foundations/overview/) — the map of the twenty deep dives and the symptom table for jumping in anywhere.
3. The anatomy of what you ship, in course order: [Processes & Signals](/foundations/processes-and-signals/) → [stdio & File Descriptors](/foundations/stdio-and-file-descriptors/) → [Namespaces](/foundations/namespaces/) → [cgroups](/foundations/cgroups/) → [Virtual Memory](/foundations/virtual-memory/) → [CPU Scheduling & the CFS](/foundations/cpu-scheduling-and-cfs/). **A container is a process; everything else is arrangements.**
4. The wire: [Linux Networking](/foundations/linux-networking/) → [TCP](/foundations/tcp-connections/) → [Firewalls & netfilter](/foundations/firewalls-and-netfilter/) → [DNS Resolution](/foundations/dns-resolution/) → [TLS](/foundations/tls/) → [HTTP](/networking/http/) — the last one living with its Networking siblings, and explaining along the way why gRPC load balancing breaks.
5. The trust and the disk: [SSH](/foundations/ssh/) → [Hashing](/foundations/hashing/) → [Security Primitives](/foundations/security-primitives/) → [Storage & Filesystems](/foundations/storage-and-filesystems/) → [Linkers, libc & ELF](/foundations/linkers-libc-and-elf/).
6. The system around it: [Time](/foundations/time/) → [eBPF](/foundations/ebpf/) → [systemd & the Node](/foundations/systemd-and-the-node/) → [API Machinery](/controllers/api-machinery/) (under Controllers — the watch/informer/leader-election machinery that makes the control plane itself tick).
7. Re-read [Linux Inside the Pod](/troubleshooting/linux-inside-the-pod/) — it should now read not as a list of magic file paths but as the obvious places to look.

**You're done when you can:** explain a pod as namespaces + cgroups + overlayfs + handcuffs without notes, trace a request from TCP handshake through netfilter to your process's fd table, and — the real test — diagnose a novel symptom by reasoning about the mechanism instead of pattern-matching an error string.

## Not on a track?

- Hunting a specific error string → [Error Message Index](/troubleshooting/error-index/)
- Hunting a specific task ("how do I rotate a secret?") → [Solutions Index](/start/solutions-index/)
- Just browsing → each section's overview page ([Workloads](/workloads/overview/), [Networking](/networking/overview/), [Observability](/observability/overview/), …) is the guided tour.
