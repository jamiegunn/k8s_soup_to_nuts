---
title: Sidecars
description: When a helper container belongs in your pod, when it belongs elsewhere, and what every sidecar really costs at fleet scale.
keywords:
  - helper container decision framework
  - sidecar vs DaemonSet vs app
  - mutating admission webhook injection
  - Istio proxy injected container
  - resource cost multiplied by replicas
  - exceeded quota injected mesh proxy
  - native sidecar initContainers restartPolicy
  - log to stdout vs file shipping
  - per-pod identity and credentials
  - sidecar review checklist
sidebar:
  order: 1
---

If you haven't read [Init and Sidecar Containers](/workloads/init-and-sidecar-containers/), start there — it covers the mechanics: what containers in a pod share, init container semantics, and the one-field difference that makes a native sidecar. This section assumes that material and goes where the intro couldn't: the decision framework for whether a sidecar is the right tool at all, the exact lifecycle machinery, and production-ready recipes for the patterns that survive contact with real clusters.

Because here's the thing the pattern catalogs don't tell you: most sidecars you'll be tempted to write shouldn't exist. The ones that should exist are genuinely excellent. The skill is telling them apart *before* you've multiplied a bad decision by 60 replicas.

## What a sidecar is — and is not

A sidecar is a **helper container that shares its pod's network namespace, volumes, and lifecycle**. That sharing is the entire value proposition:

- It reaches the app on `127.0.0.1` with no Service, no DNS, no NetworkPolicy hop.
- It reads and writes the same `emptyDir` volumes — log files, rendered config, Unix sockets.
- It is scheduled with the app, scales with the app, and dies with the app. There is no "sidecar is up but app moved to another node" state to reason about.

A sidecar is **not** a second application that happens to live in the same pod. The test from the intro article bears repeating because it settles 90% of arguments: *does this container have exactly the same lifecycle as the app?* If it has its own release cadence, its own team, its own traffic from outside the pod, or would be meaningful running without the app — it's a separate Deployment, and cramming it into the pod couples two things that will now scale, deploy, and fail together.

The sidecar's job is always **subordinate**: it exists to serve the app container sitting next to it, and it serves exactly one replica of that app.

In the pod spec, a modern sidecar is an entry in `spec.initContainers` with `restartPolicy: Always` (a *native* sidecar — the mechanics are in the [intro article](/workloads/init-and-sidecar-containers/) and dissected in [Lifecycle and Ordering](/sidecars/lifecycle-and-ordering/)):

```yaml
spec:
  initContainers:
    - name: log-shipper            # helper: subordinate, same lifecycle as the app
      image: cr.fluentbit.io/fluent/fluent-bit:3.1.4
      restartPolicy: Always        # <- what makes it a sidecar, not an init step
      volumeMounts:
        - { name: app-logs, mountPath: /var/log/app, readOnly: true }
  containers:
    - name: app                    # the reason the pod exists
      image: registry.example.com/billing/legacy:7.2
      volumeMounts:
        - { name: app-logs, mountPath: /opt/app/logs }
  volumes:
    - name: app-logs
      emptyDir: { sizeLimit: 1Gi }
```

You'll still meet the older form — a second entry under `spec.containers` — in existing manifests and older injectors. It works, with sharp edges around startup ordering and Jobs that [Lifecycle and Ordering](/sidecars/lifecycle-and-ordering/) covers in detail.

## The decision framework

Every classic sidecar candidate has at least three competing homes: inside the app itself, a sidecar, a node-level DaemonSet, or the platform team's infrastructure. The right answer depends on isolation needs, per-pod state, and who owns the concern:

| Concern | In the app | Sidecar | DaemonSet | Platform / external |
|---|---|---|---|---|
| **Log shipping** | Log to stdout (default answer) | Only if app writes files it can't stop writing | Cluster log collector reads stdout — usually already exists | Managed log pipeline |
| **TLS termination / L7 proxy** | App speaks TLS itself (fine for simple cases) | Mesh proxy — per-pod identity and mTLS need per-pod placement | Doesn't work: no per-pod identity | Ingress/gateway for edge TLS |
| **Secrets fetching** | App calls vault API (adds SDK + retry logic to every app) | Init + native sidecar rendering to tmpfs — great when creds rotate | CSI secrets driver (if platform installed one) | External Secrets Operator writing to Secret objects |
| **Config reload** | App watches its own config file (best) | Reloader sidecar SIGHUPs a legacy app | No — config is per-workload | Rollout-on-change via checksum annotations |
| **Caching** | In-process cache (fastest, simplest) | Local cache proxy — only when per-pod isolation is the point | No — cache affinity breaks on reschedule | Shared Redis/Valkey/Memcached Deployment |
| **Metrics / trace forwarding** | App exports OTLP directly to a collector Service | Per-pod collector agent — heavy sampling, pod-local enrichment | Node-level collector agent (common) | Central collector gateway |

Read the table columns left to right as a preference order for *most* rows: fix the app if you can, then consider whether the node or the platform already solves it, and reach for a sidecar when the concern is genuinely **per-pod** — per-pod identity, per-pod files, per-pod credentials, per-pod signals. The distinguishing feature of a legitimate sidecar is that a node-level or cluster-level equivalent either can't see what it needs (files inside your pod's `emptyDir`) or can't act at the right granularity (mTLS identity per workload, SIGHUP to one process).

A worked example, because the table is easy to nod at and hard to apply. Your team wants short-lived database credentials from Vault:

1. **In the app?** Means adding the Vault SDK, auth flow, renewal loop, and retry logic to four services in three languages. Possible; expensive; four implementations to keep correct.
2. **Platform?** Ask first — if the platform team runs the Vault CSI provider or External Secrets Operator, that's the answer and you write zero containers.
3. **DaemonSet?** No — credentials are per-*workload* identity, and a node agent can't render different creds into different pods' private volumes cleanly.
4. **Sidecar?** Per-pod credentials rendered to a per-pod tmpfs, renewed for exactly the pod's lifetime, one implementation shared by all four services. If step 2 came up empty, this is the legitimate sidecar — and it's [Recipe 3](/sidecars/recipes/).

Ten minutes of that walk — including actually asking the platform team — is the cheapest engineering you'll do all week. The most common failure is skipping straight to step 4 because a blog post had the YAML ready.

:::note[Who owns it matters as much as where it runs]
In a shared cluster, the platform team owns DaemonSets and cluster-level infrastructure; you own your pod spec. A sidecar is sometimes the *organizationally* correct answer even when a DaemonSet is technically cleaner — because you can ship a sidecar in your next release, and a DaemonSet change is a ticket, a review, and someone else's rollout window. Just be honest that you're paying a resource premium for autonomy.
:::

## The total-cost accounting

The single most under-appreciated fact about sidecars: **everything multiplies by replica count.** A sidecar looks cheap in the pod spec and expensive on the invoice.

Take a modest fluent-bit sidecar at `50m` CPU / `64Mi` memory requests, added to a Deployment with 40 replicas across 3 environments:

```text
50m  × 40 × 3 = 6 CPUs of requested capacity
64Mi × 40 × 3 = 7.5 Gi of requested memory
```

That's a whole node's worth of quota consumed by a helper — before the app has done anything. And requests are only the visible line item. Each sidecar also multiplies:

- **Image pulls.** Another image per pod, per node it lands on. A 200 MB sidecar image on a fresh node adds seconds to pod startup and load to your registry — and during a mass rescheduling event (node pool upgrade), every node pulls it at once.
- **Startup time.** Native sidecars start before your app, serially in init order. Two sidecars that each take 5 seconds to become ready add 10 seconds to every pod start, which is 10 seconds on your rollout duration per surge wave, and 10 seconds on your recovery time when a node dies.
- **Attack surface.** Every sidecar is another codebase with CVEs, another set of dependencies to scan, another container that holds your ServiceAccount token and pod network position. A sidecar you added in 2024 and forgot about is exactly the kind of thing that fails an audit in 2026.
- **Failure modes.** A pod is Ready only when *all* its containers are ready. Every sidecar you add is a new way for a perfectly healthy app to be pulled out of its Service endpoints — more on that fleet-wide failure mode in [Lifecycle and Ordering](/sidecars/lifecycle-and-ordering/).

Size sidecars with the same rigor as app containers — measured, not guessed. The methodology is in [Requests, Limits, and the Knobs That Matter](/tuning/requests-limits-knobs/), and each recipe in this section includes concrete sizing guidance. To see what your sidecars actually cost right now, ask the live pods rather than your manifests (which may not show injected containers):

```console
$ kubectl get pods -l app=orders -o jsonpath='{range .items[0].spec.initContainers[?(@.restartPolicy=="Always")]}{.name}{"\t"}{.resources.requests}{"\n"}{end}'
istio-proxy	{"cpu":"100m","memory":"128Mi"}
log-shipper	{"cpu":"50m","memory":"64Mi"}
$ kubectl top pod orders-7d4b9c-x2m4p --containers
POD                   NAME          CPU(cores)   MEMORY(bytes)
orders-7d4b9c-x2m4p   orders        212m         840Mi
orders-7d4b9c-x2m4p   istio-proxy   31m          92Mi
orders-7d4b9c-x2m4p   log-shipper   4m           38Mi
```

A shipper requesting 50m and using 4m across 120 pods is roughly 5.5 CPUs of stranded quota — the kind of gap that's invisible per pod and decisive at fleet scale.

:::caution[The quota surprise]
Sidecar requests count in your namespace ResourceQuota. Teams routinely discover this when a rollout fails with `exceeded quota` after adding an "invisible" injected mesh proxy: 100m × 60 replicas of proxy is 6 CPUs of quota you never budgeted, and during a rolling update the surge pods need it *on top of* the existing ones.
:::

## How sidecars arrive in your pods

There are exactly two delivery mechanisms, and knowing which one produced a given container changes how you debug it.

**You wrote it.** The sidecar is in your manifest, versioned in your repo, deployed by your CI/CD. You choose the image, the resources, the probes. Everything in [Sidecar Recipes](/sidecars/recipes/) is this kind. When it breaks, the fix is a commit.

**A mutating admission webhook injected it.** You applied a pod spec with one container; the API server persisted a pod with three. Service meshes work this way — label the namespace, and every new pod gets a proxy container and often an init container you never wrote (see [Service Mesh](/networking/service-mesh/) and [Admission Webhooks](/controllers/admission-webhooks/)). Consequences you own even though you didn't write the YAML:

- `kubectl get pod -o yaml` is the truth; your manifest is a request. When quota math, startup order, or traffic behavior stops making sense, diff the live pod against what you applied.
- Injected containers change on the *injector's* schedule. A mesh upgrade by the platform team changes the proxy image in your pods on their next restart — your app can break from a release you didn't do. Pin down with the platform team how injection template changes are communicated.
- Injection happens at pod **creation**. Existing pods keep their old sidecar until restarted, so after an injector change your Deployment can run two different proxy versions across replicas mid-rollout. That's normal; know it's normal before you page anyone.

```console
$ kubectl get pod orders-7d4b9c-x2m4p -o jsonpath='{range .spec.containers[*]}{.name}{"\n"}{end}'
istio-proxy
orders
$ # You wrote one container. The webhook wrote the other.
```

Injectors usually leave fingerprints — annotations on the pod (`sidecar.istio.io/status` lists exactly what was added) and a label on the namespace that opted you in:

```console
$ kubectl get namespace shop -o jsonpath='{.metadata.labels}'
{"istio-injection":"enabled","kubernetes.io/metadata.name":"shop"}
```

If a container's provenance is unclear, that annotation-vs-your-repo diff answers it in seconds — and it's the first thing to check when a pod has a container nobody on the team recognizes.

## Before you add one: the review checklist

The questions to answer in the PR description for any new hand-written sidecar — every one maps to a section above or an article below:

1. Why can't the app do this itself, and why doesn't the platform or a node agent already do it? (Decision framework — show your walk through the table.)
2. What are the measured requests, and what do they total across all replicas and environments? (Total cost; [/tuning/requests-limits-knobs/](/tuning/requests-limits-knobs/).)
3. Should this sidecar's failure make the pod NotReady, and does its probe configuration match that answer? (The fleet-wide readiness trap — [Lifecycle and Ordering](/sidecars/lifecycle-and-ordering/).)
4. Does the pod's `terminationGracePeriodSeconds` cover the app's drain *plus* this sidecar's shutdown work? (Shared budget — same article.)
5. Who bumps this image when its next CVE lands, and how will they remember it exists?

A sidecar that survives those five questions is probably one of the good ones.

## What's in this section

| Article | What it covers |
|---|---|
| [Lifecycle and Ordering](/sidecars/lifecycle-and-ordering/) | The deep mechanics: native sidecar startup/termination semantics, probes as ordering levers, the shared grace-period budget, resource accounting, and debugging multi-container pods |
| [Sidecar Recipes](/sidecars/recipes/) | Five production-ready patterns with complete YAML, sizing, and failure modes — plus the anti-recipes to refuse |

And once more for the road: the fundamentals — init containers, what pod containers share, `restartPolicy: Always`, the `-c` flag you'll type a hundred times — live in [Init and Sidecar Containers](/workloads/init-and-sidecar-containers/). This section stands on that article; it doesn't replace it.
