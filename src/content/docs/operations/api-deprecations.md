---
title: API Deprecations and Cluster Upgrades
description: Surviving Kubernetes version upgrades you don't control — detecting removed APIs before the platform's upgrade breaks your deploys, and handling the behavior changes that ride along.
keywords:
  - resource mapping not found
  - no matches for kind
  - extensions/v1beta1
  - policy/v1beta1 poddisruptionbudget
  - pluto
  - kubent
  - helm mapkubeapis
  - kubectl apply fails after upgrade
  - removed api version
  - dockershim removal
  - version skew
  - kind node image testing
sidebar:
  order: 12
---

The platform team upgrades the cluster on **their** schedule, driven by managed-Kubernetes support windows, not by your sprint plan. Here's the part that makes it your problem: when an API version your manifests use gets *removed* in the new release, the cluster upgrade succeeds, every running pod keeps running — and then your next `kubectl apply` fails. The workload didn't break. **Your ability to deploy broke**, at whatever moment you next needed to deploy, which by Murphy's law is during an incident.

The canonical morning-after, seen by thousands of teams at the 1.22 and 1.25 upgrades:

```console
$ kubectl apply -f ingress.yaml
error: resource mapping not found for name: "shop-web" namespace: "shop"
from "ingress.yaml": no matches for kind "Ingress" in version "extensions/v1beta1"
ensure CRDs are installed first
```

That "ensure [CRDs](/controllers/crds-explained/) are installed first" hint is actively misleading — nothing about CRDs is wrong. The API version simply no longer exists on this server. `policy/v1beta1` PodDisruptionBudgets did the same thing to people at 1.25.

The deprecation policy in one paragraph: **GA APIs (`v1`) are stable** — Kubernetes has never removed a GA API. Beta APIs (`v1beta1`, `v2beta1`...) are explicitly temporary: once a replacement goes GA, the beta version is deprecated and then removed a few releases later. Alpha APIs can vanish any release. So the exposure list is finite and knowable: it's every non-`v1` apiVersion in your repo.

## Removal mechanics: why `kubectl get` fools people

Three facts explain every confusing symptom in this space:

1. **Objects are stored version-agnostically.** etcd holds each object once, in the cluster's *storage version*. The apiVersion in your YAML is just the dialect you speak to the API server; it converts between all *served* versions on the fly.
2. **"Deprecated" means still served, with a warning.** Everything works; you're on notice.
3. **"Removed" means that dialect is gone.** Existing objects are untouched — they were never stored "in" the old version — but any *client* speaking the removed version gets an error: your manifests, your Helm charts, your CI's apply step, your operator's client library.

This is why the situation post-upgrade looks fine until you deploy:

```console
$ kubectl get ingress -n shop        # works — server returns networking.k8s.io/v1
NAME       CLASS   HOSTS            ADDRESS       PORTS   AGE
shop-web   nginx   shop.acme.dev    203.0.113.9   80,443  412d

$ kubectl apply -f ingress.yaml      # fails — your FILE still says extensions/v1beta1
error: resource mapping not found ...
```

`kubectl get ingress` asks for the resource by name and gets whatever version the server prefers. Your YAML file, written three years ago, still requests the dead dialect. The object outlived the API version that created it.

:::danger[Helm has a nastier variant]
Helm stores the *rendered manifests* of each release in its release secret. If a release was last deployed with `extensions/v1beta1` in it, then after the removal **helm upgrade fails and so does helm rollback** — Helm can't even read its own stored state against the new server. The escape hatch is the `mapkubeapis` plugin (`helm mapkubeapis shop-web -n shop`), which rewrites the stored release in place. Better: never get there — see the routine below.
:::

## Detection toolkit

### 1. The warnings the server is already sending you

Since 1.19, the API server returns deprecation warnings on every request that uses a deprecated version, and kubectl prints them:

```console
$ kubectl apply -f pdb.yaml
Warning: policy/v1beta1 PodDisruptionBudget is deprecated in v1.21+, unavailable in v1.25+; use policy/v1 PodDisruptionBudget
poddisruptionbudget.policy/shop-web configured
```

That line names the removal version. It's the cheapest signal you'll ever get, and most CI logs scroll it past unread. Grep your deploy logs for `^Warning:.*deprecated` — a five-minute audit that regularly finds the whole problem.

You can also diff what the server speaks before and after a staging upgrade:

```bash
kubectl api-versions | sort > api-versions-$(kubectl version -o json | jq -r .serverVersion.gitVersion).txt
diff api-versions-v1.27.txt api-versions-v1.31.txt
```

### 2. pluto — scan what's in git

Pluto scans static manifests and Helm releases for API versions that are deprecated or removed in a target version. This is the tool that belongs in CI:

```console
$ pluto detect-files -d ./deploy --target-versions k8s=v1.31.0
NAME                        KIND                    VERSION              REPLACEMENT          REMOVED   DEPRECATED
shop-web                    PodDisruptionBudget     policy/v1beta1       policy/v1            true      true
shop-metrics                HorizontalPodAutoscaler autoscaling/v2beta2  autoscaling/v2       true      true
```

`pluto detect-helm -n shop` does the same against live Helm release secrets — which catches the stored-release trap above, since your rendered chart output and what Helm stored can differ.

### 3. kubent — scan what's live, within your RBAC

kube-no-trouble inspects live objects (using the last-applied annotation and Helm secrets) and works fine namespace-scoped:

```console
$ kubent -c=false --target-version 1.31.0
6:02PM INF >>> Kube No Trouble `kubent` <<<
6:02PM INF Retrieved 47 resources from cluster
__________________________________________________________________________________________
>>> Deprecated APIs removed in 1.25 <<<
------------------------------------------------------------------------------------------
KIND                  NAMESPACE   NAME        API_VERSION      REPLACE_WITH   SINCE
PodDisruptionBudget   shop        shop-web    policy/v1beta1   policy/v1      1.21.0
```

(`-c=false` skips the cluster-scoped collectors your RBAC will deny anyway.) Pluto tells you about git; kubent tells you about the cluster; run both, because the delta between them is your [drift](/operations/drift-and-cicd/).

## Your pre-upgrade routine as a tenant

When the platform announces "1.31 on the 15th" — or better, when you *ask* rather than wait to be told:

1. **Get target version and date in writing.** Ask what the post-upgrade node OS/runtime versions will be too. This is a standing agenda item for your [platform team relationship](/operations/working-with-platform-team/), not a scramble.
2. **Read the changelog's "Urgent Upgrade Notes"** for every minor between current and target — skips compound. You are not reading 4,000 lines; you're grepping for the API groups and kinds you actually use (see the reading technique below).
3. **Scan manifests in CI, permanently.** A one-off pluto run rots the day after. A pipeline step doesn't:

```yaml
- name: API deprecation gate
  run: |
    pluto detect-files -d ./deploy \
      --target-versions k8s=v1.31.0 \
      --ignore-deprecations=false -o wide --v 3 || exit 1
```

   Bump `--target-versions` the moment the platform names the next target — months before the window.
4. **Test on the target version locally.** kind publishes node images for every release; spin up tomorrow's cluster today and apply your real manifests at it. Your [local development setup](/start/local-development/) probably already has everything but the image tag:

```bash
kind create cluster --name upgrade-test --image kindest/node:v1.31.9
kubectl apply --dry-run=server -k deploy/overlays/prod   # server-side validation against the NEW api surface
```

5. **Check your third-party dependencies.** Every operator, chart, and controller you install in your namespaces has its own compatibility matrix. cert-manager, external-secrets, your Kafka operator — verify the versions you run support the target, and upgrade the laggards *before* the window, not during it.

### The removals that actually hit app teams

For orientation, the greatest hits — if your repo is older than a couple of years, grep for these first:

| Removed in | You wrote | You need |
|---|---|---|
| 1.16 | `extensions/v1beta1` / `apps/v1beta*` Deployment, DaemonSet | `apps/v1` |
| 1.22 | `extensions/v1beta1`, `networking.k8s.io/v1beta1` Ingress | `networking.k8s.io/v1` (structurally different: `pathType` required, backend renamed) |
| 1.25 | `policy/v1beta1` PodDisruptionBudget | `policy/v1` |
| 1.25 | `batch/v1beta1` CronJob | `batch/v1` |
| 1.26 | `autoscaling/v2beta2` HorizontalPodAutoscaler | `autoscaling/v2` |
| 1.29 | `flowcontrol.apiserver.k8s.io/v1beta2` | `v1beta3`/`v1` (rarely tenant-owned) |

Note the pattern: most of these are one-line apiVersion swaps, but Ingress v1 and HPA v2 changed the *schema* too — which is exactly why you test with `--dry-run=server` against the target version instead of trusting sed.

## Beyond removals: behavior changes that bite tenants

API removals are loud. Behavior changes are quiet, and they ship in the same upgrade:

- **Features graduating and changing defaults.** Native sidecar containers (init containers with `restartPolicy: Always`) went beta-on-by-default in 1.29 — suddenly your service mesh's injection pattern changes. In-place pod resize graduating means resource edits stop implying restarts. Each graduation can change how your existing manifests *behave* without changing whether they *apply*.
- **Security defaults tightening.** `seccompDefault` on new node pools, Pod Security Admission labels moving from `warn` to `enforce` on your namespace — workloads that ran as root for years suddenly won't schedule. If your [pod security posture](/workloads/pod-security/) is already restricted-compliant, these upgrades are non-events; if not, the upgrade is when the debt comes due.
- **Runtime swaps.** The dockershim removal in 1.24 is the archetype: anything that assumed the Docker socket on nodes (some log shippers, DinD-style builds) broke on containerd nodes. Kernel and runtime versions ride along with node image upgrades whether or not the k8s minor changes.
- **New capabilities you actually want.** CronJob `timeZone` (GA 1.27) ended a decade of UTC arithmetic in schedule strings. Upgrades give as well as take — read for both.

Reading release notes efficiently: don't read them, *grep* them. Build the list of kinds and API groups from your own repo first, then search the changelog for only those:

```bash
# What API surface do we actually use?
grep -rh '^apiVersion:' deploy/ | sort -u
grep -rh '^kind:' deploy/ | sort -u
# Now grep each CHANGELOG-1.2x.md for those + "Urgent Upgrade Notes" + "Deprecation"
```

Ten minutes per minor version, and you'll catch what matters to *you* instead of drowning in kubelet flag renames.

## During the upgrade window

From your seat, a cluster upgrade is mostly a **node-pool rolling replacement**: control plane first (a brief API-server blip your running pods don't feel; your CI might see a few refused connections), then nodes are cordoned, drained, and replaced. Drains evict your pods — which means the upgrade window is a live-fire test of your PodDisruptionBudgets, replica counts, anti-affinity, and graceful shutdown handling. If you've done the [high-availability homework](/workloads/high-availability/), a node drain is invisible; if not, the platform's upgrade *is* your outage, and it'll be attributed to you.

Watch during the window:

```bash
kubectl get pods -n shop -o wide -w        # evictions + where pods land (mixed old/new nodes)
kubectl get events -n shop --sort-by=.lastTimestamp | grep -Ei 'evict|drain|fail'
```

The signature pattern to know: **works on old nodes, crashes on new nodes.** Mid-upgrade, your replicas span both node generations; if only the pods on fresh nodes fail, the delta is the node — kernel, containerd version, node OS image — not your code. Gather evidence before the old nodes disappear:

```bash
kubectl get pods -n shop -o custom-columns='POD:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase'
kubectl get node <new-node> -o jsonpath='{.status.nodeInfo}' | jq .
```

Pods-to-nodes mapping plus both nodes' `nodeInfo` (kernelVersion, containerRuntimeVersion, osImage) is exactly the evidence the platform team needs, and it turns "your upgrade broke us" into a five-minute confirmation instead of a cross-team argument.

## Client-side skew: it's not just YAML

The manifests are only one client. After the server jumps versions:

- **Your CI's kubectl.** The support window is **±1 minor** from the server. A pinned kubectl 1.27 binary talking to a 1.31 server is four versions of skew — it mostly works until it very confusingly doesn't (new fields silently dropped in client-side validation, subcommand behavior changes). kubectl is [just an API client](/kubectl/how-kubectl-works/); version the binary in your pipeline images alongside the cluster, one PR per upgrade cycle.
- **Client libraries in your apps.** Anything in your namespaces that calls the API — a fabric8-based Java operator, a client-go informer, a Python cronjob using the dynamic client — compiles against generated types for specific API versions. Check each library's compatibility matrix against the target and bump before the window.
- **The blind spot: who's calling deprecated APIs at runtime?** You can't always grep for it (dynamic clients, vendored operators). The API server can: it exports `apiserver_requested_deprecated_apis` metrics and audit annotations identifying deprecated-API callers by user agent. That's control-plane telemetry only the platform can read — so make it a standing ask: *"before each upgrade, send tenants their entries from the deprecated-API report."* Platform teams generally love this request; it's one PromQL query for them and it prevents their upgrade from breaking you.

## Worked example: one repo, 1.27 → 1.31, two cycles

Real shape of the work for a `shop` app repo (Deployment, HPA, CronJobs, PDB, an Ingress, a Helm-installed Redis), platform running upgrades roughly every nine months.

**Cycle 1 (1.27 → 1.29), announced with 10 weeks' notice.** Pluto against `k8s=v1.29.0`: clean on removals, but flags `autoscaling/v2beta2` HPA as long-deprecated (removed back in 1.26 — the file only "worked" because the last apply predated it; the *stored object* was fine, per the mechanics above, but any re-apply would have failed even on 1.27!). kubent confirms live state matches. Findings became two PRs, merged eight weeks before the window:

- PR 1: `autoscaling/v2beta2` → `autoscaling/v2` (field rename: `targetAverageUtilization` → `target.averageUtilization`), tested with `kubectl apply --dry-run=server` on a `kindest/node:v1.29.8` cluster.
- PR 2: add the pluto CI gate + pin CI's kubectl to 1.28 (spans old and new server).

Upgrade day: nothing. One CronJob PR followed opportunistically — `timeZone: "America/New_York"` replacing the UTC-offset comment math.

**Cycle 2 (1.29 → 1.31).** The pluto gate had *already* failed a PR two months earlier when someone copy-pasted a `policy/v1beta1` PDB from an old runbook — the gate earning its keep between upgrades, which is the actual point. Pre-window checks: bump pluto's target to 1.31, kind smoke test on `v1.31.9`, verify the Redis chart's supported matrix (it needed one minor chart bump), kubectl in CI to 1.30. The platform's deprecated-API report (the standing ask) showed one hit: an old fabric8 5.x client in a batch job — bumped to a current release.

Upgrade day: a node-pool roll the dashboards barely registered, because the PDB and preStop hooks were already right.

**Why the repo now stays evergreen:** Renovate opens PRs for chart versions and CI tool pins; the pluto gate blocks deprecated API versions from ever landing; the target-version bump is a one-line PR the day the platform names the next release. Every one of those changes flows to the cluster through the normal [GitOps pipeline](/operations/gitops-for-tenants/) — no upgrade-eve heroics, just ordinary PRs, two months early.

:::tip[The whole strategy in one sentence]
Make "what API versions do we use?" a question your CI answers on every commit, not a question you answer in a panic the morning after the platform's upgrade.
:::
