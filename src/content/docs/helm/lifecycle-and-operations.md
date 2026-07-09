---
title: Release Lifecycle and Operations
description: What Helm actually does at install, upgrade, and rollback — release state, the three-way merge, hooks, stuck releases, tests, distribution, and the operator's toolbox.
keywords:
  - another operation is in progress
  - pending-upgrade stuck release
  - three-way merge patch
  - helm rollback
  - helm hooks pre-upgrade post-install
  - sh.helm.release secret
  - helm history revision
  - --atomic --wait --force
  - helm test smoke test
  - mapkubeapis plugin
  - oci registry helm push cosign
  - helm diff plugin preflight
  - uninstall keeps pvc crds
sidebar:
  order: 6
---

`helm install` returns in seconds, and everything interesting happens inside them. Helm renders your templates, records a release, and negotiates with the cluster about what changes — and every operational surprise (the field that reverted, the upgrade that hung, the rollback that didn't roll back the database) traces to one of those steps. This article is what actually happens, in order, with the triage moves for when it doesn't.

Prerequisites: [Chart Anatomy](/helm/chart-anatomy/) for the `web-service` example and [Values and Overrides](/helm/values-and-overrides/) for how the inputs are assembled.

## A release is state — and it lives in a Secret

Helm has no server-side component anymore; its memory is **release records stored in the cluster**, by default as Secrets in the release's namespace:

```console
$ kubectl -n shop get secrets -l owner=helm
NAME                          TYPE                 DATA   AGE
sh.helm.release.v1.web.v1     helm.sh/release.v1   1      42d
sh.helm.release.v1.web.v2     helm.sh/release.v1   1      12d
sh.helm.release.v1.web.v3     helm.sh/release.v1   1      2d
```

One Secret per revision, named `sh.helm.release.v1.<name>.v<N>`, kept up to `--history-max` (default 10; older revisions are pruned). Each contains the complete state of that revision — the chart itself, the user-supplied values, the rendered manifest, hooks, and status. It's double-base64'd and gzipped; the decode recipe worth keeping in your notes:

```console
$ kubectl -n shop get secret sh.helm.release.v1.web.v3 \
    -o jsonpath='{.data.release}' | base64 -d | base64 -d | gunzip | jq keys
[
  "chart",
  "config",
  "info",
  "manifest",
  "name",
  "namespace",
  "version"
]
```

`config` is your values, `manifest` is the rendered YAML that revision applied. You'll rarely need the raw decode — `helm get values` and `helm get manifest` read the same data politely — but knowing where the state lives explains a lot: RBAC on these Secrets is RBAC on Helm history, deleting them makes Helm forget the release (see the stuck-release section for when that's a weapon), and anyone who can read them can read every value you ever passed. One more reason [secrets don't go in values](/workloads/secrets/).

A release also carries a **status** — `deployed`, `failed`, `superseded` (an old revision), `uninstalled`, and the `pending-install`/`pending-upgrade`/`pending-rollback` trio that means an operation is (or died) in flight. `helm history` shows the trail:

```console
$ helm -n shop history web
REVISION  UPDATED                   STATUS      CHART              APP VERSION  DESCRIPTION
1         Wed May 21 09:12:44 2026  superseded  web-service-1.2.0  1.2.0        Install complete
2         Fri Jun 20 15:03:11 2026  superseded  web-service-1.3.1  1.3.1        Upgrade complete
3         Wed Jul  1 10:44:52 2026  deployed    web-service-1.4.0  1.4.0        Upgrade complete
```

## Install and upgrade mechanics

Every `helm upgrade` runs the same sequence:

1. **Render** — templates + merged values → manifests (client-side).
2. **Validate** — manifests are checked against the cluster's OpenAPI schema.
3. **Diff and patch** — a **three-way strategic merge** per resource: the *previous revision's manifest*, the *live object*, and the *new manifest*.
4. **Record** — a new release Secret, status `deployed`.

Step 3 is the one that produces surprises, because the old manifest — not just the live state — participates. The rules fall out of comparing the three:

- Field in old manifest, changed in new manifest → **set to new value** (normal upgrade).
- Field in old manifest, *absent* from new manifest → **deleted** from the live object.
- Field *never in any manifest*, added live by `kubectl edit` or a controller → **left alone**.
- Field in both manifests unchanged, but edited live → **reverted** to the manifest value.

Worked example: someone hotfixed prod with `kubectl -n shop edit deploy/web` and made two edits — bumped `replicas` from 3 to 6, and added a `nodeSelector` the chart never sets. Your next `helm upgrade` ships only an image tag change. Result: `replicas` **snaps back to 3** (the chart declares it, live differs, chart wins) while the `nodeSelector` **survives** (no manifest ever mentioned it, so the patch doesn't touch it). Both outcomes are correct and both have paged someone. The full drift story — including how GitOps controllers tighten this loop — is in [Drift and CI/CD](/operations/drift-and-cicd/).

:::note[Server-side apply and Helm]
Helm's client-side three-way merge predates Kubernetes server-side apply and doesn't use it (as of Helm 3.x). If another controller uses SSA field ownership on the same objects, you can see ownership tug-of-war in `metadata.managedFields` — worth knowing when a field keeps flipping between two values on a schedule.
:::

The flags that change the experience:

- `--wait` — after applying, Helm waits until Deployments have their minimum replicas **ready** (readiness probes passing), Services have endpoints, PVCs are bound. A wrong readiness probe means `--wait` times out on a perfectly running app; a generous probe means `--wait` passes while the app is still warming. It's your probes' honesty, measured.
- `--timeout` — how long that wait lasts (default `5m0s`). Size it to your slowest honest rollout, not to "make the error go away."
- `--atomic` — `--wait` plus automatic rollback to the previous revision on failure. The right default for CI: pipelines end green-and-deployed or red-and-reverted, never "partially applied, see you in triage." See [CI/CD Pipeline Design](/operations/cicd-pipeline-design/).
- `--force` — honesty section: it does not "try harder." It **deletes and recreates** resources that can't be patched (immutable field changes, usually). That is downtime, dressed as a flag. If you're reaching for it, first ask why the patch fails — often it's a changed selector, which is a chart bug ([Authoring Best Practices](/helm/authoring-best-practices/), Rule 2).

## Hooks: jobs with opinions about ordering

Any templated resource becomes a hook via annotation, and hooks run *around* the main apply rather than in it:

```yaml
# templates/migrate-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "web-service.fullname" . }}-migrate
  annotations:
    "helm.sh/hook": pre-install,pre-upgrade
    "helm.sh/hook-weight": "0"
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: {{ .Values.image.repository }}:{{ .Values.image.tag }}
          args: ["migrate", "up"]
```

The hook points: `pre-install`, `post-install`, `pre-upgrade`, `post-upgrade`, `pre-rollback`, `post-rollback`, `pre-delete`, `post-delete`, plus `test`. Weights order hooks within a point, ascending, and Helm waits for each weight class to finish before starting the next — so a two-phase startup is just two annotations:

```yaml
"helm.sh/hook-weight": "-5"   # wait-for-db Job runs first
"helm.sh/hook-weight": "0"    # migrate Job runs after it succeeds
```

Delete policies matter more than they look: `before-hook-creation` (delete the previous run before creating the new one — almost always wanted, since Jobs are immutable), `hook-succeeded`, `hook-failed`. The combination above keeps failed Jobs around for log-reading and cleans up successes.

The failure mode is structural: **a stuck hook is a stuck release**. Helm waits for `pre-upgrade` hooks to complete before touching your Deployment, so a migration Job that hangs (locked table, unreachable DB, image typo) hangs the whole `helm upgrade` until timeout, after which the release lands in `failed` — with the *old* pods still running, which is the good news. The triage sequence:

```console
$ helm -n shop status web
NAME: web
STATUS: pending-upgrade        # or failed, after the timeout
$ helm -n shop history web
REVISION  STATUS           DESCRIPTION
3         deployed         Upgrade complete
4         pending-upgrade  Preparing upgrade
$ kubectl -n shop get jobs,pods -l app.kubernetes.io/instance=web
$ kubectl -n shop logs job/web-web-service-migrate
Error: migration 20260701_add_index: timeout acquiring lock on "orders"
```

Hook pod logs are the answer to "why is my upgrade hung" often enough that they belong in your standard sweep — general method in [Triage Methodology](/troubleshooting/triage-methodology/).

:::caution[Hooks under GitOps are not your hooks]
Argo CD does not run Helm hooks by default — it renders charts with `helm template` and syncs the output, so your `pre-upgrade` migration Job either doesn't run or needs mapping to Argo's own sync-hook annotations (`argocd.argoproj.io/hook`). Flux's helm-controller *does* execute Helm hooks natively. If your chart's correctness depends on a hook, say so in the README, and know which controller your platform runs — [GitOps for Tenants](/operations/gitops-for-tenants/).
:::

## Rollback, truthfully

`helm rollback web 3` does not restore a snapshot. It takes revision 3's **chart and values**, re-renders them, and applies the result through the same three-way merge as any upgrade — producing a **new revision** (5, if you were on 4):

```console
$ helm -n shop rollback web 3
Rollback was a success! Happy Helming!
$ helm -n shop history web
REVISION  STATUS      DESCRIPTION
3         superseded  Upgrade complete
4         failed      Upgrade "web" failed: timed out waiting for condition
5         deployed    Rollback to 3
```

Consequences of "re-render and merge," not "time machine": live drift interacts with the rollback exactly as with an upgrade; hooks fire again (`pre-rollback`/`post-rollback`, and note your `pre-upgrade` migration does *not* magically reverse); and **nothing outside the manifests rolls back** — the database schema that revision 4's migration hook altered is still altered. Application rollback and data rollback are different problems, and only one of them is Helm's ([CI/CD Pipeline Design](/operations/cicd-pipeline-design/) covers pairing them).

**The stuck-state page**: `Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress` means a previous operation died mid-flight (CI job killed, network drop) and left the latest release Secret in `pending-upgrade`. Options, safest first: wait out a possibly-still-running operation; `helm rollback` to the last `deployed` revision (usually works and clears the state); and the last resort — delete the pending revision's release Secret:

```bash
kubectl -n shop delete secret sh.helm.release.v1.web.v4
```

This makes Helm forget revision 4 ever started. The risk is real: if the dead operation *did* apply some manifests, cluster state now differs from what Helm's history claims, and the next upgrade's three-way merge is computing against a lie — follow it with `helm diff` and a careful upgrade. Related repair tool: the `mapkubeapis` plugin rewrites release records that reference API versions your cluster has since removed (the "current release manifest contains removed kubernetes api(s)" error) — background in [API Deprecations](/operations/api-deprecations/).

## Helm tests: smoke tests as chart equipment

A `test` hook is a pod that runs on demand and passes by exiting 0:

```yaml
# templates/tests/smoke.yaml
apiVersion: v1
kind: Pod
metadata:
  name: {{ include "web-service.fullname" . }}-smoke
  annotations:
    "helm.sh/hook": test
spec:
  restartPolicy: Never
  containers:
    - name: smoke
      image: curlimages/curl:8.8.0
      args: ["-fsS", "http://{{ include "web-service.fullname" . }}:{{ .Values.service.port }}/healthz"]
```

```console
$ helm -n shop test web
NAME: web
...
TEST SUITE:     web-web-service-smoke
Last Started:   Thu Jul  2 14:31:07 2026
Phase:          Succeeded
```

Cheap, in-cluster, exercises the Service path (not just the pod) — run it after every CI install and after any manual upgrade you're nervous about. On failure, `--logs` prints the test pod's output inline, which is usually the whole diagnosis. Test pods follow hook delete policies too; give them `before-hook-creation` or reruns collide with the previous pod's corpse.

## Distribution: repos, OCI, and pinning

Two ways charts travel. **Classic repos** are HTTP servers with an `index.yaml`: `helm repo add`, `helm repo update`, install by `repo/chart`. Still everywhere, and still how you consume most third-party charts. **OCI registries** are the modern default for internal charts — the same registry that holds your images holds your charts, with the same auth, replication, and retention:

```console
$ helm package ./web-service
Successfully packaged chart and saved it to: web-service-1.4.0.tgz
$ helm push web-service-1.4.0.tgz oci://registry.internal/charts
Pushed: registry.internal/charts/web-service:1.4.0
$ helm install web oci://registry.internal/charts/web-service --version 1.4.0
```

No `repo add`, no index. And because an OCI chart is a standard artifact, **cosign signs it like any image** — signature and verification in admission, superseding the older GPG provenance-file flow for most orgs. The chain-of-custody argument lives in [Supply Chain Security](/operations/supply-chain-security/).

For consuming third-party charts, mirror them into your own registry rather than pulling from upstream at deploy time — upstream repos disappear, rename, and re-tag, and your 3am rollback should not depend on someone else's hosting.

Pin versions in CI. `--version 1.4.0`, exactly — never a floating range in prod, never unversioned `latest`-ish installs. A chart version change is a code change; it goes through the same PR-diff-review path as everything else ([CI/CD Pipeline Design](/operations/cicd-pipeline-design/)). GitOps [CRDs](/controllers/crds-explained/) encode the same rule: `spec.chart.version` in a HelmRelease is a pin, and Renovate bumps it via PR.

## The operator's toolbox

Start every "what is Helm doing in this cluster" question with the census:

```console
$ helm list -A
NAME            NAMESPACE   REVISION  UPDATED               STATUS    CHART                  APP VERSION
web             shop        3         2026-07-01 10:44:52   deployed  web-service-1.4.0      1.4.0
worker          shop        7         2026-06-28 16:02:19   deployed  web-worker-2.1.3       2.1.3
ingress-nginx   ingress     14        2026-06-30 08:15:40   deployed  ingress-nginx-4.10.1   1.10.1
external-dns    platform    22        2026-06-25 11:31:06   failed    external-dns-1.14.5    0.14.2
```

That `failed` in someone else's namespace is exactly the kind of thing you want to know about *before* filing a ticket that says "DNS is broken." The rest of the kit:

| Command | What it answers |
|---|---|
| `helm list -A` | What releases exist, where, in what status — your namespace reality check |
| `helm -n NS status web` | Current revision, status, notes — first stop on any Helm page |
| `helm -n NS history web` | The revision trail: what changed when, what failed |
| `helm -n NS get values web` | What the installer supplied (add `-a` for the full merge) — drift forensics |
| `helm -n NS get manifest web` | Exactly what this revision applied — diff it against `kubectl get -o yaml` |
| `helm diff upgrade web ./chart -f values-prod.yaml` | The pre-flight: what *would* change (plugin) |
| `helm template ./chart --validate` | Render plus server-side schema check, applies nothing |

The `diff` plugin deserves its plug — it's the upgrade pre-flight that turns "let's see what happens" into a review step:

```console
$ helm diff upgrade web ./web-service -f values-prod.yaml
shop, web-web-service, Deployment (apps) has changed:
  ...
-         image: registry.internal/web-service:1.4.2
+         image: registry.internal/web-service:1.5.0
-       checksum/config: 8f4e2a91...
+       checksum/config: 1c7d0b52...
```

Two resources changed, both expected — ship it. Twelve resources changed on a "tag bump" — stop and read.

## Uninstall: the survivor list

```console
$ helm -n shop uninstall web
release "web" uninstalled
$ kubectl -n shop get pvc
NAME               STATUS   VOLUME                                     CAPACITY   AGE
data-web-redis-0   Bound    pvc-8c1f4a02-77e3-4b9a-9c1d-2f60d1a9e441   8Gi        42d
```

`helm uninstall` deletes what the release's manifest created, and keeps more than people expect:

- **PVCs created by StatefulSet `volumeClaimTemplates`** — they were created by the StatefulSet controller, not by your manifest, so Helm doesn't own them. Your data politely refuses to be garbage-collected; delete PVCs explicitly when you truly mean it.
- **CRDs** installed from the chart's `crds/` directory — deliberately never touched on upgrade *or* uninstall, because deleting a CRD deletes every custom resource of that kind cluster-wide.
- **Hook resources** whose delete-policy didn't fire (a failed Job without `hook-failed` in its policy sticks around).
- Anything annotated `helm.sh/resource-policy: keep`.
- The release history itself, unless you pass `--keep-history` — without it, the release Secrets go too, and `helm rollback` after uninstall is off the table.

Namespaces Helm *created* via `--create-namespace` are also kept. If your mental model is "uninstall = everything gone," audit with `kubectl get all,pvc,secrets -n shop` afterward — the leftovers are exactly the ones that cost money or hold data.

## Chartifying the golden service

If you followed the [golden service build](/architectures/golden-service/), you already have the manifests a chart would emit: Deployment, Service, ConfigMap, HPA, PDB, ServiceAccount, NetworkPolicy. Chartifying them is mechanical — each becomes a template, the per-environment numbers (replicas, resources, hosts) become values with the delta-file layout from [Values and Overrides](/helm/values-and-overrides/), the labels move into the helper pair, and the config checksum annotation wires ConfigMap changes to rollouts. The result is, more or less, the `web-service` chart from [Chart Anatomy](/helm/chart-anatomy/) — which is not a coincidence; that chart is what a paved-road service looks like after this section is applied to it.

## What to remember

- A release is Secrets in the namespace — chart, values, and manifest per revision. `helm get` reads them; deleting them makes Helm forget.
- Upgrades are render → validate → **three-way merge** (old manifest, live, new). Chart-declared fields snap back; never-declared live additions survive.
- `--atomic` for CI, `--wait` measures your probes, `--force` means recreate means downtime.
- Hooks run around the apply; a hung hook is a hung release, and the hook pod's logs are the answer. Argo CD ignores Helm hooks by default.
- Rollback re-renders old chart+values as a *new* revision — manifests only; your database doesn't come along.
- Pin chart versions, push OCI, sign with cosign, pre-flight every upgrade with `helm diff`.
- Uninstall keeps PVCs, CRDs, and `keep`-annotated resources — audit before assuming clean.

Reference for everything flag-level: the official docs at [helm.sh/docs](https://helm.sh/docs/) — start with `helm help upgrade` locally, it's the same text and always matches your binary.
