---
title: Hands-On Labs
description: Follow-along tutorials — stand up a k3s cluster in a Lima VM on your Mac, then ship a Java API through Helm, secrets, a Valkey backend, and ingress.
keywords:
  - where do the kubernetes labs start
  - what you build across the labs
  - lab prerequisites and host setup
  - how the lab sequence is ordered
  - how long the labs take to complete
  - references versus tutorials
  - do i need java or docker desktop for the labs
  - pause and resume the labs between sittings
  - teardown promise leaves no trace
sidebar:
  order: 1
---

Everything else on this site is a **reference**: you land on a page mid-incident, grab what you need, and leave. This section is different. The labs are **tutorials** — you start at Lab 0, type every command in order, and end with a working system you built yourself. References tell you how things work; labs make your fingers believe it.

If you've read [How Kubernetes Works](/start/how-kubernetes-works/) and thought "fine, but I want to *touch* it" — this is the place.

The distinction matters for how you read. In a reference article, skimming is a feature. In a lab, skipping a step breaks step twelve in a way that looks nothing like the step you skipped. So the deal is:

- **References** (the rest of the site): random access, skim freely, land anywhere.
- **Labs** (this section): sequential, every command typed, every output checked against the expected output shown.

You need no prior Kubernetes experience to start Lab 0, but the labs explain *what to type and why it worked*, not the full theory behind each object. Reading [How Kubernetes Works](/start/how-kubernetes-works/) first — even skimmed — will make every step land twice as hard.

## What you'll build

Across ten labs you'll stand up a real (if small) delivery pipeline on your Mac — then run it the way production gets run. The first five labs (0–4) build the system:

- A real single-node Kubernetes cluster — k3s in a Linux VM — no Docker Desktop, no cloud account, no admin ticket.
- `orders-api`, a Spring Boot 3.3 / Java 21 REST service, built entirely inside Docker (you don't need Java or Maven installed) and deployed with a Helm chart you author from scratch.
- Configuration and secrets injected every way Kubernetes offers, so you can feel the differences instead of memorizing them.
- A Valkey cache wired in as a backend service, found via DNS the way real services find each other.
- ingress-nginx routing `http://orders.localtest.me:30080` from your browser all the way to a pod.

The second arc (Labs 5–8) operates it:

- Failures injected on purpose — crash loops, broken probes, missing config — and diagnosed with the same triage loop you'd use on call.
- A monitoring stack with a dashboard you build and one alert that fires for a reason you caused.
- The build → import → deploy → verify → rollback loop you've been typing by hand, scripted into a CI pipeline that runs locally.
- Deploys under sustained load, with the request failures counted before the fix and proven zero after — zero-downtime mechanics measured, not asserted.

A final lab (9) revisits Valkey as the opposite of Lab 3's throwaway cache: a **datastore you keep** — StatefulSets, persistent volumes, async replication, a manual failover, and a backup/restore drill, authored as a second chart from an empty directory. It needs only Lab 0's cluster, so you can take it any time after the build arc.

A closing bridge page, [From the Lab to the Paved Road](/labs/from-lab-to-prod/), then maps everything you built onto the infrastructure your organization actually runs.

## Before you start: what the labs assume

Every lab assumes the same host setup, stated once here and repeated in each lab's Prerequisites:

- **macOS** with **Homebrew** installed and working.
- **Lima** installed (`brew install lima` if not; verify with `limactl --version`).
- Roughly **10 GB of free RAM** and ~15 GB of free disk for the two VMs, images, and cluster.
- **No Docker Desktop required** — and if you have it, the labs neither use nor conflict with it as long as it isn't fighting over `DOCKER_HOST` (Lab 0 covers this).
- **No Java, Maven, or any language toolchain.** The `orders-api` app builds inside a multi-stage Dockerfile; Docker is the only build tool.
- **No cluster-admin anxiety.** You are the admin of this cluster. If your day job is a locked-down namespace, enjoy the change of scenery — then read [Working Without Admin](/start/working-without-admin/) to map what you learn back to reality.

Everything else — `docker`, `kubectl`, `helm`, the VMs themselves — is installed in Lab 0.

## The lab stack, and why

The labs standardize on one toolchain so every command works verbatim:

| Layer | Tool | Why this one |
|---|---|---|
| Host | macOS + Homebrew | The section's stated assumption — commands are written for zsh on a Mac |
| Docker daemon | **Lima** (`template://docker`) | A free, lightweight Linux VM running dockerd; no Docker Desktop license, no conflicts with corporate policy. Same recipe as [Local Development](/start/local-development/) |
| Docker client | `brew install docker` (CLI only) | The client on your Mac talks to the daemon in the VM over a socket — a useful lesson in itself |
| Cluster | **k3s** (Lima `template://k3s`) | A real single-node Kubernetes distribution — packaged control plane + kubelet in one binary — running in its own Lima VM; the same distribution you'll meet in production edge and on-prem setups |
| Deployment | **Helm** for everything | Real pipelines ship charts, not loose YAML. You'll author one, not just install one — deep dive in [Helm](/helm/overview/) |

Three choices deserve a sentence of defense:

**Why a VM at all?** Docker needs a Linux kernel, and your Mac doesn't have one. Docker Desktop hides that fact behind licensing terms and a settings GUI; Lima gives you the same thing — a small Linux VM running `dockerd` — as a transparent, scriptable, free tool. When your `docker version` output shows a Darwin client talking to a Linux server, you'll understand your own machine better than most Docker Desktop users ever do. The full reasoning lives in [Local Development](/start/local-development/). The labs run **two** such VMs — one for dockerd, one for the cluster — each simple, each with exactly one job.

**Why k3s?** Because it isn't a simulator. k3s is a certified Kubernetes distribution that packages the entire control plane and the kubelet into a single binary — the same distribution running on production edge devices, in retail back rooms, and on physical on-prem racks. The cluster you break on your laptop is, component for component, one you may later be paged for.

**Why everything through Helm?** Because that's how software actually reaches clusters. CI pipelines package charts; platform teams install ingress controllers and databases from charts; your future production deploys will be `helm upgrade`, not `kubectl apply`. We deliberately do **not** use `kubectl apply -f` as the primary deployment method after Lab 0. The moment you have more than one manifest, you have a packaging problem, and Helm is how the industry solved it — see [Helm](/helm/overview/) for the deep dive. Learning it on a laptop, where mistakes cost nothing, is the cheapest Helm education you'll ever get.

## The lab sequence

The labs are strictly ordered — each builds on the artifacts of the previous one, with one exception: Lab 9 is self-contained and needs only Lab 0's cluster. Budget roughly **9–12 hours** for the full sequence (**4–6 hours** if you stop after the build arc, Labs 0–4), comfortably split across sittings (there's a pause/resume recipe in every lab). Rough per-lab timings: Lab 0 ≈ 30–45 min (mostly waiting on first-time downloads), Labs 1–2 ≈ 60–75 min each, Labs 3–8 ≈ 45–60 min each, Lab 9 ≈ 60–75 min.

| Lab | Title | What you'll learn | Deep dives |
|---|---|---|---|
| 0 | [A Cluster on Your Mac](/labs/lab-0-cluster/) | Two Lima VMs — dockerd for builds, k3s as the cluster — `KUBECONFIG` wiring, namespace + context setup, smoke tests | [Local Development](/start/local-development/), [How Kubernetes Works](/start/how-kubernetes-works/), [kubectl Survival Kit](/start/kubectl-survival-kit/) |
| 1 | [Ship a Java API with Helm](/labs/lab-1-java-api/) | Multi-stage Dockerfile (Maven build → JRE runtime), streaming the image into k3s's containerd, authoring `charts/orders-api` from scratch, install/upgrade/rollback | [Helm Chart Anatomy](/helm/chart-anatomy/), [Template Language](/helm/template-language/), [Java on K8s](/java/overview/) |
| 2 | [Secrets & Config, Every Way](/labs/lab-2-config-and-secrets/) | env vars, `envFrom`, ConfigMap/Secret volume mounts, Spring property binding, what a rollout looks like when config changes | [Values and Overrides](/helm/values-and-overrides/), [YAML, Labels, and Namespaces](/start/yaml-labels-and-namespaces/) |
| 3 | [Wire In a Backend](/labs/lab-3-backend-service/) | Valkey via Helm (release `cache`), Services and cluster DNS, readiness gating on a dependency, connection config through the chart | [Valkey architecture](/architectures/valkey-shared-vip/), [Service Unreachable](/troubleshooting/service-unreachable/) |
| 4 | [Ingress & End to End](/labs/lab-4-ingress-end-to-end/) | ingress-nginx on a NodePort (alongside k3s's bundled Traefik), host-based routing, `orders.localtest.me:30080` in a real browser, tracing a request hop by hop | [Routing](/routing/overview/), [Front Door architecture](/architectures/front-door/) |
| 5 | [Break It, Then Fix It](/labs/lab-5-break-and-fix/) | Injected failures — crash loops, bad probes, broken DNS, missing Secrets — each diagnosed with the triage playbooks instead of guesswork | [Triage Methodology](/troubleshooting/triage-methodology/), [Service Unreachable](/troubleshooting/service-unreachable/) |
| 6 | [Metrics, Dashboards, and One Real Alert](/labs/lab-6-observability/) | A monitoring stack via Helm, actuator metrics scraped from `orders-api`, a dashboard you assemble, and one alert that fires for a reason you caused | [Metrics](/observability/metrics/), [Alerting](/observability/alerting/) |
| 7 | [The CI Pipeline, Run Locally](/labs/lab-7-ci-locally/) | The build → tag → import → `helm upgrade` → verify → rollback loop from Labs 1–4, scripted end to end and run on your Mac like a pipeline stage | [CI/CD Pipeline Design](/operations/cicd-pipeline-design/), [Release Lifecycle and Operations](/helm/lifecycle-and-operations/) |
| 8 | [Deploying Under Load](/labs/lab-8-deploy-under-load/) | An in-cluster fortio load generator, a rollout caught dropping requests, then preStop + grace + surge settings proven zero-downtime by before/after measurement | [Zero-Downtime Deployments](/architectures/zero-downtime/), [Graceful Shutdown](/workloads/graceful-shutdown/), [Rollout & Shutdown Knobs](/tuning/rollout-shutdown-knobs/) |
| 9 | [Valkey the Hard Way](/labs/lab-9-valkey/) | A second chart from an empty directory: primary + replica StatefulSets on PVCs, async replication verified both ways, a role-aware readiness probe, manual promotion, and a backup/restore drill (needs only Lab 0) | [Valkey with a Shared VIP](/architectures/valkey-shared-vip/), [Valkey and Redis](/stateful/valkey-and-redis/) |
| — | [From the Lab to the Paved Road](/labs/from-lab-to-prod/) | The bridge to real org infrastructure: registries, CD systems, locked-down namespaces — what changes at work, and what you already know | [Working Without Admin](/start/working-without-admin/), [Reference Architectures](/architectures/overview/) |

You create the cluster **once** in Lab 0 and keep it for the whole sequence — k3s needs no pre-provisioning for Lab 4's ingress; NodePorts and Lima's automatic port forwarding cover it. One scheduling note: Lab 4 ends with an *optional* full teardown for people stopping there — if you're continuing to Lab 5, take the pause recipe instead and keep the stack.

## Conventions used in every lab

- **Copy-paste blocks.** Every `bash` block is meant to be run as-is, in order. No placeholders to fill in unless explicitly flagged.
- **Expected output follows every meaningful command**, in a `console` block. Trivial differences (IDs, timestamps, version patch numbers) will vary; structure and status lines should match. If they don't, stop and check the lab's troubleshooting box before continuing.
- **One directory for everything:** `~/k8s-labs/`. By the end of the sequence it looks like this:

```console
~/k8s-labs/
├── app/                    # Java source + Dockerfile (Lab 1)
└── charts/
    └── orders-api/         # the Helm chart you author (Lab 1+)
```

- **Versions are pinned.** `orders-api:0.1.0` in Lab 1, bumped per lab (`0.2.0`, `0.3.0`, …); `valkey/valkey:8`; `busybox:1.37`; Spring Boot 3.3 on Java 21. Pinning is a habit worth building — `latest` is how surprises ship.
- **Prerequisites are explicit** at the top of each lab, and each lab states *what you'll have at the end* so you know when you're done.
- **Deep-dive links throughout.** Labs teach the mechanics; when a step touches something with real depth (probes, RBAC, chart templating), there's a link to the reference article. Follow them later — don't break the flow mid-lab.
- **Troubleshooting boxes** near the end of each lab cover the failure modes we've actually seen (a stopped Lima VM, an unset `DOCKER_HOST` or `KUBECONFIG`, a RAM squeeze). Check there first when output doesn't match.

## When something goes wrong anyway

Labs are where breaking things is cheap, so treat every mismatch as a free debugging rep instead of a setback:

1. Reread the last command you ran — the majority of lab failures are a skipped step or a command run from the wrong directory.
2. Check the lab's troubleshooting box.
3. Apply the [triage methodology](/troubleshooting/triage-methodology/) — the same `describe`/`logs`/`events` loop you'd use in production works identically here, and this is precisely the low-stakes place to practice it.
4. Nuclear option: the teardown command below plus a rerun of Lab 0 takes under fifteen minutes. There is no state worth protecting on this cluster. Delete freely.

## An honest note about scope

These labs teach **mechanics**: how images get into a cluster, how a chart becomes running pods, how a request finds a container. What they deliberately don't teach is production judgment — resource sizing, HA topologies, security hardening, upgrade strategy, multi-tenancy. A k3s cluster on a laptop has one node, no cloud load balancer, and nobody paging you at 3 a.m.

When you're ready to think about production, the reference sections and especially the [Reference Architectures](/architectures/overview/) pick up exactly where the labs stop. A good pattern: finish the labs, then reread the [Golden Service](/architectures/golden-service/) architecture — you'll recognize every building block, now assembled with production stakes.

## The teardown promise

Nothing in these labs escapes containment. The entire footprint is two Lima VMs — the cluster lives wholly inside one of them — and the `~/k8s-labs/` directory. When you're done — or want a clean slate — this removes every trace:

```bash
limactl delete -f k3s && limactl delete -f docker && rm -rf ~/k8s-labs
```

Each lab also has a lighter **pause** recipe (`limactl stop docker && limactl stop k3s`) that preserves everything for your next sitting.

## Start here

Open a terminal and head to [Lab 0: A Cluster on Your Mac](/labs/lab-0-cluster/). Twenty minutes from now you'll have a Kubernetes cluster you can break with impunity — which is the whole point.
