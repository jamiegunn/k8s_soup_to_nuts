---
title: CI/CD Pipeline Design
description: The reference build-to-deploy pipeline for a Kubernetes app — immutable artifacts, per-env config, validation gates, safe rollouts, and rollback that doesn't lie.
sidebar:
  order: 13
---

Every Kubernetes deployment pipeline that works well looks roughly the same, and every one that pages you at 2 AM violates one of a small set of rules. This article is the reference shape. Snippets are GitHub Actions flavored because they're compact, but nothing here is GitHub-specific — the same stages port directly to GitLab CI, Jenkins, Tekton, or a shell script in a container. The shape is what matters.

:::tip[Running GitHub + Artifactory?]
This article is deliberately tool-agnostic. The [CI with GitHub & Artifactory](/ci/overview/) section implements this exact shape on that stack: [workflow foundations](/ci/github-actions/), [reusable templates](/ci/reusable-workflows/), [Artifactory as the artifact hub](/ci/artifactory/), and [the testing ladder](/ci/testing-in-ci/).
:::

## The pipeline contract

Four rules. Everything else in this article is implementation detail.

1. **One immutable artifact, promoted through environments.** You build the image once, on merge to main. That exact image — same digest — goes to dev, then staging, then prod. You never rebuild "for prod." A rebuild is a different artifact: different base image pull, different dependency resolution, different timestamp. If you rebuild per environment, you have never tested what you ship.
2. **Config varies per environment; the artifact does not.** Replicas, resource limits, feature flags, endpoints — all of that lives in per-env overlays or values files, not in the image.
3. **Manifests live in git.** The cluster's desired state is reviewable, diffable, and revertable. Anything applied outside git is [drift waiting to be destroyed](/operations/drift-and-cicd/).
4. **Humans approve promotion, not construction.** Nobody hand-builds artifacts or hand-edits manifests on the way to prod. The human decision is "does the thing that passed staging go to prod now?" — a merge button, not a terminal.

:::note[You don't own the cluster]
This article assumes the tenant position: you have namespace-scoped credentials, the platform team owns the cluster, RBAC, and the ingress/CRD layer. Your pipeline deploys into *your namespaces* with a least-privilege identity (section at the end). Everything here works within that boundary.
:::

## The stages, in order

### 1. Build and unit test

Nothing k8s-specific here, but it gates everything: no green tests, no image.

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make test lint
```

### 2. Image build — multi-stage, cached

Multi-stage Dockerfiles keep build toolchains out of the runtime image; layer caching keeps CI fast. Build once, here, and nowhere else.

```yaml
  build:
    needs: test
    steps:
      - uses: docker/build-push-action@v6
        with:
          push: false
          load: true
          tags: registry.example.com/team/orders:${{ github.sha }}
          cache-from: type=registry,ref=registry.example.com/team/orders:buildcache
          cache-to: type=registry,ref=registry.example.com/team/orders:buildcache,mode=max
```

### 3. Scan before push

Scan the built image for known CVEs and fail on what your org has agreed is blocking. Don't push first and scan later — an image in the registry is an image someone will deploy. This stage is the enforcement point for everything in [Supply Chain Security](/operations/supply-chain-security/): vulnerability scan, SBOM generation, signing.

```yaml
      - run: trivy image --exit-code 1 --severity CRITICAL,HIGH \
          registry.example.com/team/orders:${{ github.sha }}
```

### 4. Push with an immutable tag

Tag with the git SHA, or `semver+sha` if humans need readable versions:

```bash
docker push registry.example.com/team/orders:${GIT_SHA}
# or: orders:1.14.2-g3f9c1a2
```

Never deploy `:latest`, and never reuse a tag. Mutable tags are the root cause of the classic "it worked yesterday" incident: a node with the old image cached runs one thing, a freshly scheduled pod pulls the new content under the same tag and runs another. Now two pods behind the same Service run different code and you can't tell from the manifest, because the manifest didn't change. `imagePullPolicy` behavior differs by tag too — `:latest` defaults to `Always`, everything else to `IfNotPresent` — so a mutable tag doesn't even fail consistently.

The gold standard is deploying by **digest**: resolve the tag once at push time and carry the digest through the pipeline.

```bash
DIGEST=$(crane digest registry.example.com/team/orders:${GIT_SHA})
# registry.example.com/team/orders@sha256:4f8a... — this can never mean anything else
```

A tag is a pointer; a digest is the content. Pin the digest in your manifests and "what exactly is running in prod?" has a one-line answer.

### 5. Render manifests per environment

The image reference gets stamped into the environment's manifests — a Kustomize overlay or a Helm values file, your call (trade-offs in [Helm and Kustomize](/operations/helm-and-kustomize/)):

```bash
# Kustomize
cd deploy/envs/dev
kustomize edit set image orders=registry.example.com/team/orders@${DIGEST}

# or Helm
helm template orders ./chart -f deploy/envs/dev/values.yaml \
  --set image.digest=${DIGEST} > rendered.yaml
```

Render to plain YAML in CI even if you deploy with Helm — a rendered manifest is something you can diff, validate, and archive as the record of what was deployed.

### 6. Validate before anything touches the cluster

Three cheap gates that catch the majority of "deploy succeeded, app broken" incidents:

```bash
# Schema validation, no cluster needed
kubeconform -strict -summary rendered.yaml

# Deprecated/removed API detection — fail before the platform team upgrades under you
pluto detect-files -d deploy/ --target-versions k8s=v1.33.0

# The cluster's own opinion: admission webhooks, quotas, RBAC, unknown fields
kubectl apply --dry-run=server -f rendered.yaml
```

`kubeconform` catches typos and schema errors offline. `pluto` catches manifests that will stop applying after the next cluster upgrade — as a tenant you don't control when that happens, so gate on it continuously ([API Deprecations](/operations/api-deprecations/)). Server dry-run is the only one that exercises the real admission chain, including policy webhooks the platform team runs.

### 7. Deploy

Two respectable shapes:

- **Push:** the pipeline runs `kubectl apply -f rendered.yaml` or `helm upgrade --install` with a namespace-scoped kubeconfig.
- **GitOps handoff:** the pipeline's last act is a commit — it updates the image digest in the env directory and pushes. Argo CD or Flux, run by the platform team, reconciles it into the cluster. The pipeline never holds cluster credentials at all. See [GitOps for Tenants](/operations/gitops-for-tenants/) for how this works when you don't own the controller.

Either is fine. What's not fine is both at once for the same resources — pick one writer per object or they'll fight.

### 8. Verify — deployment is not done at apply

`kubectl apply` returning 0 means the API server accepted YAML. It says nothing about whether pods started. Always wait on the rollout, and capture forensics on failure:

```yaml
      - name: Wait for rollout
        run: |
          kubectl -n orders-dev rollout status deploy/orders --timeout=300s

      - name: Smoke test
        run: |
          kubectl -n orders-dev create job smoke-${GITHUB_SHA::7} \
            --image=registry.example.com/team/orders@${DIGEST} -- ./smoke-test
          kubectl -n orders-dev wait --for=condition=complete \
            job/smoke-${GITHUB_SHA::7} --timeout=120s

      - name: Capture evidence on failure
        if: failure()
        run: |
          kubectl -n orders-dev get events --sort-by=.lastTimestamp | tail -40
          kubectl -n orders-dev get pods -l app=orders -o wide
          kubectl -n orders-dev logs deploy/orders --tail=100 --all-containers || true
```

`rollout status` exits non-zero if the rollout stalls past `progressDeadlineSeconds` — that exit code is your pipeline's red/green signal. The smoke test runs *inside the cluster* as a Job (real DNS, real NetworkPolicy, real service account) rather than curling from a runner outside; for internal-only services it's the only honest test. The failure step is non-negotiable: pipeline logs that show events and pod state turn "deploy failed, who knows why" into a five-minute diagnosis ([Events](/observability/events/) is the decoder ring).

### 9. Notify

Post the result where humans look: env, image digest, git SHA, rollout outcome, link to the run. On failure, include the captured events. The point isn't ceremony — it's that "what's deployed where" should be answerable from chat history without cluster access.

## Environments and promotion

Lay the repo out dir-per-env:

```text
deploy/
  base/                 # shared manifests / chart
  envs/
    dev/     kustomization.yaml   # image: orders@sha256:4f8a...
    staging/ kustomization.yaml   # image: orders@sha256:4f8a...
    prod/    kustomization.yaml   # image: orders@sha256:1c2d...  <- older, promoted last week
```

**Promotion is a PR that copies the tested digest forward.** No rebuild, no re-render logic, no new artifact — the diff is one line changing the image reference in `envs/prod/`. The review question is exactly "this digest passed staging; ship it?" and the git history of that file *is* your deployment history for the environment.

- **Dev:** auto-deploy on merge to main. Nobody approves dev.
- **Staging:** auto-deploy or auto-PR, your appetite.
- **Prod:** gated — PR approval, or a pipeline environment gate. A human clicks; a human never constructs.

:::tip[Preview environments per PR]
If the platform team supports it, spin a namespace per pull request: `orders-pr-1423`, deployed with the PR's image, torn down on merge/close plus a TTL cleanup CronJob for orphans (runners die, hooks get missed). It's the highest-leverage upgrade to review quality most teams can make — reviewers click a URL instead of imagining behavior. Quota-cap the namespaces or the platform team will cap them for you. Pairs well with a solid [local development](/start/local-development/) story for the inner loop.
:::

## Database migrations in the pipeline

Three placements, honest trade-offs:

| Approach | Pros | Cons |
|---|---|---|
| **Pipeline step** (runner connects to DB) | Simple; ordered; logs in CI | Runner needs DB network access + credentials; skipped if someone deploys outside the pipeline |
| **Init container** on the app pod | Can't run app without migrating | Runs per-*pod*: N replicas race for the migration lock; surge pods stall on it; restarts re-run it; timeouts fight `progressDeadlineSeconds` |
| **Job before deploy** (pipeline creates a Job, waits for completion, then applies the Deployment) | Runs exactly once, in-cluster network/creds, ordered before rollout | More pipeline code; needs idempotent re-run and cleanup (`ttlSecondsAfterFinished`) |

The Job-before-deploy pattern is the default recommendation: run a Job with the *new* image executing `migrate up`, `kubectl wait --for=condition=complete`, and only then roll the Deployment. Init containers look elegant and bite you the first time HPA scales during a rollout.

The placement matters less than the rule that makes all of them safe:

:::caution[Backward-compatible migrations first — expand/contract]
During a rolling update, **old pods run old code against the new schema** — for minutes normally, for hours if the rollout stalls. Every migration must be compatible with the previous app version. Adding a column: fine. Renaming one: expand (add new column, dual-write in code), migrate data, then contract (drop old column) in a *later* release. Destructive changes ship at least one release after the code stopped depending on the old shape. Teams that skip this rule get outages precisely during deploys, which is the worst possible time.
:::

## Rollback design

**Default: roll forward via `git revert`.** Revert the promotion commit (or the offending change), let the pipeline run. You get the same validation gates, an audit trail, and — critically — git and the cluster stay in agreement, so the next deploy doesn't resurrect the bad version as [drift reconciliation](/operations/drift-and-cicd/) would.

**`kubectl rollout undo` is acceptable** as an emergency stopgap: prod is down, the pipeline takes eight minutes, undo takes ten seconds. Fine — but it creates drift the moment it completes, so the git revert must follow *immediately*, or the next pipeline run redeploys the broken version. Undo is a tourniquet, not treatment. Details in [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/).

**Keep last-known-good discoverable.** In a dir-per-env layout it's `git log -- deploy/envs/prod/` — the previous digest is the previous commit. Some teams also maintain a moving `orders:prod-stable` tag or an annotation on the Deployment. Whatever the mechanism, the on-call engineer must be able to answer "what do I roll back *to*?" in under a minute without archaeology.

**DB migrations make naive rollback lie.** If release N ran a migration, redeploying release N−1's image doesn't restore release N−1 — it runs old code against the new schema. If you followed expand/contract, that's exactly the combination you already proved safe during the rolling update, and rollback works. If you didn't, "rollback" is a second, differently-shaped outage. Down-migrations in an emergency are how you lose data; the expand/contract discipline exists so you never need them.

## Safety rails baked into the manifests

The pipeline can only fail loudly if the Deployment is configured to fail loudly:

```yaml
apiVersion: apps/v1
kind: Deployment
spec:
  progressDeadlineSeconds: 300   # stalled rollout -> Progressing=False -> rollout status exits 1
  minReadySeconds: 15            # pod must stay Ready 15s before counting -- a soak against crash-on-first-request
  strategy:
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
```

- **`progressDeadlineSeconds`** is what converts a hung rollout into a non-zero exit from `kubectl rollout status`. Without it (the default is 600s — fine, but be deliberate), a deploy that never becomes ready blocks your pipeline until the CI timeout and reports nothing useful.
- **`minReadySeconds`** stops the "readiness passed once, pod counted, crashed on first real request, rollout marched on" failure. It's a soak timer, not a substitute for real [health checks](/workloads/health-checks/) — a readiness probe that actually exercises dependencies is what makes all of this machinery honest.
- **`maxUnavailable: 0`** keeps capacity flat during deploys; pair with a PodDisruptionBudget.

Rollout mechanics are stateless-Deployment-flavored here; the same "wait and gate on status" applies to StatefulSets and DaemonSets with different flags.

## Anti-patterns, ranked by damage

1. **Rebuilding images per environment.** Prod runs an artifact that has never been tested anywhere. The entire promotion model is void.
2. **Mutable tags (`:latest`, `:prod`, reused `:v1.2`).** Unreproducible incidents, split-brain replica sets, "nothing changed but everything changed."
3. **`kubectl apply` from laptops, "just this once."** Untracked change, no review, silently reverted (or silently kept) by the next pipeline run. If it needs to happen in an emergency, it needs a follow-up commit within the hour.
4. **Pipeline runs with cluster-admin.** A leaked CI token is now a leaked cluster. Your platform team should refuse this; if they don't, refuse it yourself (next section).
5. **Secrets pasted into pipeline variables and templated into manifests.** They end up in rendered YAML artifacts, run logs, and `last-applied` annotations. Use External Secrets / sealed secrets / a vault sidecar — the pipeline should reference secrets, never contain them.
6. **No drift detection.** Live state diverges and nobody knows until a deploy "mysteriously" changes behavior. Cheapest fix — a nightly CI job:

```bash
kubectl diff -f rendered.yaml && echo "clean" || notify-slack "drift detected in prod: review before next deploy"
```

(`kubectl diff` exits 1 when differences exist — that's the signal, not an error.)

## The RBAC your pipeline actually needs

Ask the platform team for a dedicated ServiceAccount (or OIDC-federated identity — better, since there's no long-lived token to leak) per environment, bound to a Role scoped to **your namespace only**, roughly:

```yaml
kind: Role
rules:
  - apiGroups: ["", "apps", "batch"]
    resources: ["deployments", "services", "configmaps", "secrets",
                "jobs", "serviceaccounts", "pods", "pods/log", "events"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  # deliberately absent: delete on most things, anything cluster-scoped,
  # RBAC resources, nodes, other namespaces
```

Separate identities for dev and prod, so a compromised dev pipeline can't touch prod. If you're on the GitOps handoff model, the pipeline needs *no* cluster credentials — only git push rights to the env directory — which is the strongest argument for that model.

## The whole pipeline on one page

1. Unit tests and lint pass — or nothing else happens.
2. Build the image once, multi-stage, cached.
3. Scan (CVEs, SBOM, sign); fail closed.
4. Push with an immutable tag; resolve and record the digest.
5. Render per-env manifests (overlay/values) with the digest pinned.
6. Validate: `kubeconform` → `pluto` → `kubectl apply --dry-run=server`.
7. Deploy: apply/helm with namespace-scoped identity, or commit the digest for GitOps.
8. `kubectl rollout status --timeout` — the exit code is the verdict.
9. Smoke test as an in-cluster Job; on any failure, dump events, pod state, logs.
10. Notify with env + digest + outcome.
11. Promote by PR: copy the tested digest to the next env directory. Auto dev, gated prod.
12. Migrations: Job-before-deploy, expand/contract only, old code must work on new schema.
13. Rollback: git revert first; `rollout undo` only as a stopgap with an immediate follow-up commit.
14. Manifests carry `progressDeadlineSeconds` and `minReadySeconds`; probes are real.
15. Nightly `kubectl diff` job catches drift before it catches you.

If your pipeline does these fifteen things, deploys become boring. That's the goal.
