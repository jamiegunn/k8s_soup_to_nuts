---
title: CI with GitHub & Artifactory
description: The concrete CI stack — GitHub Actions as the engine, Artifactory as the artifact hub — mapped onto the tool-agnostic pipeline reference, with a clear division of labor between platform and app teams.
keywords:
  - github actions and artifactory ci stack
  - platform team vs app team responsibilities
  - immutable artifact promoted through environments
  - ci hands off to cd pull request
  - github enterprise private artifactory runners
  - no runner matching labels queue times
  - pipeline green but cluster runs old code
  - pin actions by commit sha not tag
  - docker-local docker-remote virtual repository key
  - who owns what in a paved road pipeline
  - orders-api spring boot java 21 example
sidebar:
  order: 1
---

[CI/CD Pipeline Design](/operations/cicd-pipeline-design/) is the shape: one immutable artifact promoted through environments, config varying per environment, manifests in git, humans approving promotion rather than construction. Deliberately, it names no vendors. This section is the stack: what that shape looks like when your org runs **GitHub** (cloud or GitHub Enterprise) for source and CI, and **JFrog Artifactory** as the place every build artifact lives — container images, Helm charts, and the proxied Maven dependencies your builds pull through.

If the reference article and this section ever disagree, the reference wins. Nothing here changes the contract; it just fills in the `uses:` lines.

## What to have read first

This section assumes three things and doesn't re-teach them:

- **The pipeline shape.** [CI/CD Pipeline Design](/operations/cicd-pipeline-design/) — the contract (immutable artifacts, per-env config, git as the source of truth, humans approve promotion) that every workflow here implements. If a snippet in this section seems arbitrary, the reason is almost always in that article.
- **The app.** [Lab 1](/labs/lab-1-java-api/) built `orders-api` by hand — Maven build, multi-stage Dockerfile, Helm chart from scratch. This section automates that exact sequence, so the manual version is the mental model for every automated step.
- **The chart-consumer mindset.** [Helm Deep Dive](/helm/overview/) — because the platform/app split in CI mirrors the chart author/consumer split, and the reusable-workflows article leans on that analogy hard.

And to set expectations for what this section is *not*: it's not a general GitHub Actions tutorial (the [official docs](https://docs.github.com/en/actions) cover the long tail), and it's not the CD story — nothing in these four articles runs `kubectl apply` or `helm upgrade` against a real cluster. The pipeline ends at the artifact and the git commit; [GitOps for Tenants](/operations/gitops-for-tenants/) picks up from there.

## Who owns what

On a platform-managed cluster you don't own the cluster, and in a platform-managed CI setup you don't own most of the pipeline either. The split that works — the same paved-road split described in [the golden service](/architectures/golden-service/) — looks like this:

| Concern | Platform / DevEx team | App team (you) |
| --- | --- | --- |
| Reusable workflow templates (build, push, scan, chart publish) | Owns, versions, and publishes them | Calls them from a thin `ci.yml` |
| Artifactory instance, repos, retention, permissions | Owns | Consumes: pushes to `docker-local`, pulls through virtual repos |
| Runners (hosted entitlements, self-hosted in-cluster fleet) | Owns | Selects via `runs-on` |
| Org-wide policy (required scans, required workflows, OIDC trust) | Owns | Complies — and gets it for free via the templates |
| The app's workflow file, triggers, and when-to-deploy policy | — | Owns |
| Tests: unit, integration, testcontainers, chart render checks | — | Owns |
| The Helm chart and its values files | — | Owns ([Helm Deep Dive](/helm/overview/)) |
| Handoff to CD: bumping the image tag in the GitOps repo | Owns the mechanism | Owns the merge |

Keep this table in your head while reading the section. When an article says "the platform team configures X," that's not hand-waving — it's the boundary. Your job is the right-hand column done well, plus knowing enough about the left-hand column to file good tickets and read failures correctly.

Failures split along the same line, and knowing which side you're on saves the first thirty minutes of every incident:

| Symptom | Usually whose problem |
| --- | --- |
| Tests fail, image won't build, chart won't lint | Yours — reproduce locally first |
| `401`/`403` pushing to Artifactory, OIDC exchange rejected | Platform — token scope, identity mapping |
| Runner queue times, "no runner matching labels" | Platform — fleet capacity, labels |
| Pipeline green but cluster runs old code | Neither CI party — look at CD ([drift](/operations/drift-and-cicd/)) |
| Template job broke and you changed nothing | Platform — check the template version you pin |

## The section map

| Article | What it covers |
| --- | --- |
| [GitHub Actions for K8s App Teams](/ci/github-actions/) | Workflow anatomy, permissions and secrets, auth to Artifactory, the complete annotated build for `orders-api` |
| [Reusable Workflows and Templates](/ci/reusable-workflows/) | The paved-road pattern: platform-published golden workflows, how to call them, how they're versioned |
| [Artifactory as the Artifact Hub](/ci/artifactory/) | Repo types (local/remote/virtual), image and chart publishing, dependency proxying, retention |
| [Testing in CI](/ci/testing-in-ci/) | Unit vs integration in the pipeline, testcontainers, ephemeral clusters (k3d), chart testing |

Read in order the first time. After that, [GitHub Actions](/ci/github-actions/) is the one you'll come back to.

If you're on a team that already has a platform-provided pipeline and you just want to understand the thing you're calling, read [Reusable Workflows](/ci/reusable-workflows/) first, then backfill with [GitHub Actions](/ci/github-actions/) when you need to reason about what's inside the template.

## The flow, end to end

This is [the reference pipeline](/operations/cicd-pipeline-design/) with the stack's names written in:

```console
 pull request opened
        │
        ▼
   PR checks: build + unit/integration tests, lint,
   helm template renders clean          (no artifacts published)
        │
        ▼ review approved, merge to main
        │
   build + test again on the merge commit
        │
        ├──▶ push image ──────────▶ acme.jfrog.io/docker-local/orders-api:sha-<git-sha>
        │                            (immutable, digest recorded)
        │
        └──▶ package + publish chart ──▶ acme.jfrog.io/helm-local  (on chart version bump)
                     │
                     ▼
   hand off to CD: open a PR bumping the image tag / chart version
   in the GitOps repo — CI's authority ends here
                     │
                     ▼
   Argo CD / Flux reconciles the cluster from git
   (see GitOps for Tenants — the CD half of the story)
```

Read it as two lanes with the merge button between them:

1. **The PR lane proves; it never publishes.** Every push to an open PR runs the same build and tests that `main` will run — including building the image, so a broken Dockerfile fails in review, not after merge — but nothing leaves the runner. No image push, no chart publish, no secrets exposed to code that hasn't been reviewed yet.
2. **The main lane publishes; humans already approved.** The merge commit is built once, tagged with its git SHA, pushed to Artifactory, and its digest recorded. From here on nothing is ever rebuilt — dev, staging, and prod all receive *references* to this one artifact.

Two things to internalize beyond the lanes. First, **CI never touches the cluster.** The pipeline's last act is writing to Artifactory and to git; reconciliation belongs to [GitOps for Tenants](/operations/gitops-for-tenants/), and keeping those two worlds from fighting is the subject of [Drift and CI/CD](/operations/drift-and-cicd/). Second, **the boundary between CI and CD is a pull request.** The handoff artifact is a one-line diff in the GitOps repo — new image digest or chart version — which means promotion is reviewable, revertable, and leaves the same audit trail as any other change.

## Conventions used throughout this section

**The running example is `orders-api`** — the Spring Boot 3.3 / Java 21 service you built by hand in [Lab 1](/labs/lab-1-java-api/), with its Maven build, multi-stage Dockerfile, and the Helm chart you authored from an empty directory. Everything in this section automates what you did manually there. The fictional org is `acme`; its Artifactory lives at `acme.jfrog.io`.

**Actions are pinned by commit SHA, not by tag.** A tag like `@v4` is a moving pointer that the action's owner (or someone who compromises their account) can repoint at arbitrary code that runs with your credentials. Snippets look like:

```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
```

The comment carries the human-readable version; the SHA carries the guarantee. [Supply Chain Security](/operations/supply-chain-security/) explains why this matters more in CI than almost anywhere else — CI is where your credentials and your code meet third-party code.

:::note[The SHAs in these articles are illustrative]
Except where noted, don't copy the pins from these pages verbatim — resolve the current release SHA from each action's Releases page, or better, let Dependabot or Renovate manage the pins so they're both frozen *and* updated. A stale pin is safe but eventually misses fixes; an unpinned tag is neither.
:::

**`GITHUB_TOKEN` runs least-privilege.** Every workflow in this section starts from `permissions: contents: read` and elevates per job only when a job genuinely needs more. The default token is a credential handed to every step, including third-party actions — scope it like you'd scope a [ServiceAccount](/workloads/serviceaccounts/).

**Cloud and Enterprise are treated as one, until they aren't.** Everything here works identically on github.com and GitHub Enterprise. Where the two genuinely diverge — hosted runner availability, whether runners can reach a private Artifactory at all, org-level policy features — the articles say so inline rather than maintaining two parallel tracks. If your org is on GHE Server behind a firewall, pay particular attention to the self-hosted runners discussion in [the GitHub Actions article](/ci/github-actions/): network position stops being an optimization and becomes a requirement.

**Registry paths follow Artifactory's shape.** Image references look like `acme.jfrog.io/docker-local/orders-api:sha-abc123…` — that first path segment is an Artifactory *repository key*, not a Docker Hub-style org name. Why there are several of them (`docker-local`, `docker-remote`, a `docker` virtual that fronts both) is [the Artifactory article's](/ci/artifactory/) opening topic.

With the map and the conventions in place, start with [GitHub Actions for K8s App Teams](/ci/github-actions/) — the foundations everything else in the section builds on.
