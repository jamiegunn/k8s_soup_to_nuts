---
title: GitHub Actions for K8s App Teams
description: The GitHub Actions foundations a Kubernetes app team actually needs — triggers, permissions, Artifactory auth, and the complete annotated build-test-push pipeline for orders-api.
keywords:
  - github actions workflow yaml for kubernetes
  - GITHUB_TOKEN permissions least privilege
  - pull_request_target secrets exfiltration
  - pin actions by commit sha
  - concurrency cancel-in-progress
  - oidc token id-token write artifactory
  - docker buildx cache type=gha
  - matrix build fail-fast
  - actions/upload-artifact if always
  - self-hosted runners actions-runner-controller arc
  - act run workflows locally
  - environment required reviewers prod approval gate
sidebar:
  order: 2
---

GitHub Actions documentation is vast because Actions can do anything. You don't need anything — you need one pipeline that builds `orders-api`, tests it, pushes an immutable image to Artifactory, and hands off to CD, without leaking credentials along the way. This article is that subset, in the order you'll hit it. The full reference lives at [docs.github.com/en/actions](https://docs.github.com/en/actions); the tool-agnostic pipeline shape this implements is [CI/CD Pipeline Design](/operations/cicd-pipeline-design/).

## Workflow anatomy, fast

A workflow is a YAML file in `.github/workflows/`, triggered by events, containing jobs (which run in parallel on separate runners unless you say otherwise), containing steps (which run in sequence on one runner). That's the whole model. What deserves your attention is *which* events, because for a k8s app team exactly four matter:

```yaml
on:
  pull_request:            # every push to an open PR — the pre-merge gate
  push:
    branches: [main]       # the merge commit — this is what builds the real artifact
    tags: ["v*.*.*"]       # release tags — adds the semver image tag
  workflow_dispatch:       # the "Run workflow" button — manual reruns, debugging
```

The mapping to [the pipeline contract](/operations/cicd-pipeline-design/): `pull_request` runs everything but publishes nothing; `push` to `main` builds the one immutable artifact; tag pushes decorate it with a semver tag; `workflow_dispatch` exists so that "rerun CI" never means "push an empty commit."

The second piece of anatomy worth learning on day one is **concurrency groups**, because without them a busy PR queues five builds of five superseded commits:

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```

One group per branch/PR: a new push to the same PR cancels the run for the commit nobody cares about anymore. The conditional matters — on `main` you do **not** cancel in progress, because every merge commit must produce its artifact; cancel a main build and you've got a merge with no image, which surfaces later as a [tag that doesn't exist when the cluster tries to pull it](/troubleshooting/imagepullbackoff/).

## Permissions done right

Every job receives a `GITHUB_TOKEN` — an automatically-minted, repo-scoped credential that expires when the job ends. Its default permissions are configurable org-wide, and on too many orgs the default is still write-everything. Treat it exactly like you treat a [ServiceAccount token](/workloads/serviceaccounts/): start from nothing, elevate per consumer.

```yaml
# Workflow-level baseline: the token can read the repo. Full stop.
permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    # inherits contents: read — building needs nothing more

  comment-coverage:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write   # this one job posts a PR comment; only this one job elevates
```

The per-job elevation pattern is the whole discipline: the workflow-level block sets the floor, and any job that needs more says so explicitly, in a diff a reviewer will see. Remember *why* this matters — every third-party action in a job can read that job's token. `permissions: contents: read` means a compromised action can read your code (which is public-ish anyway); `contents: write` means it can push to `main`.

:::caution[`pull_request_target` is a foot-gun, not a feature you're missing]
You'll eventually notice PRs from forks run with no secrets and a read-only token, and someone will suggest `pull_request_target`, which restores both. Understand what it does before typing it: it runs *with the base repo's secrets* while the PR author controls the code under test. If the workflow checks out the PR head (`ref: github.event.pull_request.head.sha`) and then runs anything the PR can influence — `mvn verify` executes build plugins and tests straight from the PR — an external contributor now executes arbitrary code with your Artifactory token. Nearly every "GitHub Actions secrets exfiltration" write-up starts here. The safe uses are narrow (labeling, PR triage that never checks out PR code). For an internal repo where all contributors push branches, you don't need it at all.
:::

## Secrets and auth to Artifactory

Your pipeline needs one external credential: something that lets it push to `acme.jfrog.io`. GitHub gives you three storage scopes, and the choice is about blast radius and ownership:

- **Organization secrets** — set once by the platform team, exposed to selected repos. This is where `ARTIFACTORY_USERNAME` / `ARTIFACTORY_TOKEN` belong in most orgs: the platform team owns the Artifactory account, rotates the token, and no app team ever handles the value.
- **Repository secrets** — per-repo, for the genuinely app-specific (a third-party API key your integration tests need).
- **Environment secrets** — attached to a named environment (`production`), released to a job only when that job declares `environment: production` — *and only after the environment's protection rules pass*.

That last clause is the prod gate. An environment with **required reviewers** turns "deploy to prod" into a job that pauses until a human approves it in the GitHub UI:

```yaml
  promote-prod:
    needs: [build]
    environment: production        # required reviewers + prod-scoped secrets live here
    runs-on: ubuntu-latest
    steps:
      - name: Open promotion PR against the GitOps repo
        run: ./scripts/bump-gitops.sh ${{ needs.build.outputs.digest }}
        env:
          GITOPS_TOKEN: ${{ secrets.GITOPS_TOKEN }}   # exists only in the production environment
```

This is [the pipeline contract's](/operations/cicd-pipeline-design/) "humans approve promotion" rule implemented in GitHub primitives — the approval gates the *reference to* an already-built artifact, never a rebuild.

Using the token is one step, and it's the same step whether the secret is org- or repo-scoped:

```yaml
      - name: Log in to Artifactory
        uses: docker/login-action@9780b0c442fbb1712d05a282a25f4290e40a990f # v3
        with:
          registry: acme.jfrog.io
          username: ${{ secrets.ARTIFACTORY_USERNAME }}
          password: ${{ secrets.ARTIFACTORY_TOKEN }}
```

**The OIDC upgrade.** The pattern above still parks a long-lived token in GitHub, and long-lived credentials are the thing [the secrets article](/workloads/secrets/) keeps telling you to stop creating. GitHub Actions can do better: every job can request a short-lived OIDC token (issued by `token.actions.githubusercontent.com`, carrying claims like repository, branch, and environment), and Artifactory supports OIDC integrations with **identity mappings** — rules like "a token from `acme/orders-api` on `refs/heads/main` may exchange for a 15-minute Artifactory token with push rights to `docker-local/orders-api/**`." The workflow needs `permissions: id-token: write` and an exchange step; no stored secret exists to leak or rotate, and the trust rule is auditable config instead of a value in a vault. Setting up the integration is platform-team work (see [jfrog.com/help](https://jfrog.com/help/) for the Artifactory side), which is exactly why it usually arrives via [the reusable workflow](/ci/reusable-workflows/) rather than per-repo effort. If your org offers it, prefer it; if not, the static-token pattern above is acceptable *if* the token is scoped to push-only on your image path and rotated. The philosophy — identity over shared secrets — is [Supply Chain Security's](/operations/supply-chain-security/) recurring theme.

## The build job for orders-api, annotated

Now the heart of the file. Each step below has a job to do and a way to get it subtly wrong; the annotations are the difference between copying YAML and owning it.

**Checkout, pinned by SHA.**

```yaml
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
```

The pin-by-SHA convention from [the overview](/ci/overview/) applies to every `uses:` line, but checkout is where to explain it once: this action runs first, with your token, in every job you have. A tag is a pointer someone else controls; a SHA is content-addressed. Pin it, comment the version, let Renovate bump it.

**Toolchain and dependency cache.**

```yaml
      - uses: actions/setup-java@3b6c050358614dd082e53cdbc55580431fc4e437 # v4
        with:
          distribution: temurin
          java-version: "21"
          cache: maven
```

`cache: maven` is `actions/cache` wired up for you: it caches `~/.m2/repository` with a key derived from the OS and a hash of every `pom.xml` in the repo. Unchanged poms → exact hit → Maven downloads nothing. Touch a pom → prefix-fallback restore of the old cache plus a delta download of whatever changed. What it does *not* cache is your build output — `target/` is rebuilt every run, which is what you want.

**Build and unit test.**

```yaml
      - name: Build and test
        run: mvn -B -ntp verify
```

`-B` (batch mode) and `-ntp` (no transfer progress) keep logs readable. `verify` runs the full lifecycle through unit *and* failsafe-bound integration tests — what runs at each phase, testcontainers, and the coverage question belong to [Testing in CI](/ci/testing-in-ci/); the pipeline's only concern is that a red test means no image, ever.

**Image tags, computed once.**

```yaml
      - id: meta
        uses: docker/metadata-action@8e5442c4ef9f78752691e2d8f8d19755c6f78e81 # v5
        with:
          images: acme.jfrog.io/docker-local/orders-api
          tags: |
            type=sha,format=long          # sha-<full-git-sha>: every main build, immutable
            type=semver,pattern={{version}}  # 1.4.2: only when the trigger is a v1.4.2 tag
            type=ref,event=pr             # pr-42: PR builds, never pushed
```

This is [the immutable-artifact contract](/operations/cicd-pipeline-design/) rendered as tag strategy. The git-SHA tag is the real name — one commit, one image, forever. The semver tag is a human-friendly alias added when you cut a release. There is deliberately no `latest`: a mutable tag in a deploy manifest is a lie waiting to be told, and when it's told, it's told as [ImagePullBackOff](/troubleshooting/imagepullbackoff/) or — worse — silently running the wrong code. Note the registry shape: `acme.jfrog.io/docker-local/…` — the first path segment is the Artifactory repository key ([why, and which key to pull from](/ci/artifactory/)).

**Build with BuildKit layer caching, push conditionally, capture the digest.**

```yaml
      - uses: docker/setup-buildx-action@6524bf65af31da8d45b59e8c27de4bd072b392f5 # v3

      - id: build
        uses: docker/build-push-action@471d1dc4e07e5cdedd4c2171150001c434f0b7a4 # v6
        with:
          context: app
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

`cache-from/to: type=gha` stores BuildKit layers in the GitHub Actions cache service, so [the Dockerfile layer-ordering work you did in Lab 1](/labs/lab-1-java-api/) (deps layer before source layer) pays off across runs on fresh runners, not just locally. `mode=max` exports intermediate stages too — worth it for a multi-stage JVM build. Know the ceiling: the Actions cache is ~10 GB per repo with LRU eviction, so a cache miss now and then is normal, not broken. `push:` is the PR/main fork in one expression — PRs build (proving the Dockerfile works) but publish nothing.

The step's `digest` output is the artifact's true identity — `sha256:…`, what the registry actually stores, immune even to tag mischief. Export it from the job so downstream jobs (chart publish, the GitOps bump) reference the digest, not a tag:

```yaml
    outputs:
      digest: ${{ steps.build.outputs.digest }}
```

## Matrix builds, artifacts, and wiring jobs together

**Matrix** is how you answer "will this build on Java 25 before we're forced to find out?" — run the test job across versions without duplicating YAML:

```yaml
  test:
    strategy:
      matrix:
        java: ["21", "25"]
      fail-fast: false      # let both finish; you want the full picture
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: actions/setup-java@3b6c050358614dd082e53cdbc55580431fc4e437 # v4
        with: { distribution: temurin, java-version: "${{ matrix.java }}", cache: maven }
      - run: mvn -B -ntp verify
```

Matrix the *tests*, not the image — the shipped artifact is built once, on one JVM, per the contract. The matrix is an early-warning system, and a natural companion to [tracking deprecations before they bite](/operations/api-deprecations/).

**Artifacts** are how run outputs outlive the runner — surefire reports, coverage HTML, a rendered chart:

```yaml
      - name: Upload test reports
        if: always()                    # especially when tests fail — that's when you need them
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: surefire-reports-${{ matrix.java }}
          path: app/target/surefire-reports/
          retention-days: 7             # default is 90; reports don't need 90
```

`if: always()` is the line people forget: by default a failed test step skips the upload, deleting the evidence exactly when you want it. And keep the distinction sharp — workflow artifacts are *debris*, useful for a week; the image in Artifactory is *the* artifact.

**Wiring**: `needs:` creates ordering and carries outputs. This is how the digest captured above reaches the job that uses it:

```yaml
  publish-chart:
    needs: build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: echo "chart will reference ${{ needs.build.outputs.digest }}"
```

Without `needs`, jobs race in parallel; with it, you get a DAG and a data channel. One trap: an output that references a skipped step evaluates to empty string, not an error — guard consumers with `if:` conditions that match the producer's.

## Runners: where your YAML actually executes

**Hosted runners** (`runs-on: ubuntu-latest`) are ephemeral VMs with a real Docker daemon — the fact that quietly makes everything in this section work. Docker present means `docker buildx` runs natively, **testcontainers** spins up real Postgres for your integration tests, and **k3d** can boot a disposable cluster to install your chart into ([Testing in CI](/ci/testing-in-ci/) leans hard on both). The VM is destroyed after the job: no state persists except what you put in caches and artifacts, which is a feature — every build starts from a provable zero.

**Self-hosted runners** earn one honest paragraph. Larger orgs run a runner fleet *inside* the platform cluster via **actions-runner-controller (ARC)** — runners as pods, scaled with queue depth. The platform team owns this, and should: runners execute arbitrary workflow code, so their images, their (lack of) privileges, and their network policy are security surface, not app-team hobby projects. What you get as a tenant: network position — runners sit next to Artifactory, so image pushes and Maven dependency pulls move at datacenter speed instead of traversing the internet, and on a GHE + private-Artifactory setup they may be the only runners that can reach it at all. What you give up: `ubuntu-latest`'s "everything preinstalled, destroyed after every job" guarantees. If your org offers labeled self-hosted runners, the reusable templates will already target them; if you're choosing yourself, start hosted and move for a reason, not for fashion.

## Debugging workflows

A failing workflow is a distributed-systems bug you can't SSH into, so build habits:

1. **Read the failing step first, bottom up.** The red ✗ tells you the step; the last ~50 lines of its log almost always contain the actual error. Resist scrolling from the top.
2. **Re-run with debug logging.** Re-run failed jobs and check *Enable debug logging* — or set repo variables `ACTIONS_STEP_DEBUG=true` / `ACTIONS_RUNNER_DEBUG=true` — and every step emits its internal decisions: cache key computations, expression evaluations, why `if:` skipped a step. Cache-miss mysteries die here.
3. **Reproduce the command, not the workflow.** `mvn -B -ntp verify` and `docker buildx build app/` run on your laptop. If they pass locally and fail in CI, diff the environments (JVM version, memory, missing service) before blaming the tool.
4. **`act` — with caveats.** [`act`](https://github.com/nektos/act) executes workflows locally in containers and is genuinely useful for iterating on YAML syntax and step wiring without a push-wait-fail loop. It is not the real environment: different runner images, no OIDC, no real secrets, no `environment:` gates, and Docker-in-Docker quirks. Trust it for structure, never for a final verdict.

The anti-habit: re-running without reading, and the retry that "fixes" it. A flaky pipeline teaches your team to ignore red, and ignoring red is how broken images reach Artifactory.

## The complete ci.yml for orders-api

Everything above, assembled. Behavior: on a PR, build and test only; on `main`, build, test, push to Artifactory, and expose the digest for the handoff job. This is also the file [Reusable Workflows](/ci/reusable-workflows/) will shrink to a dozen lines — read it as the "before" picture.

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]
    tags: ["v*.*.*"]
  workflow_dispatch:

# Baseline: the token can read code. Jobs elevate individually if they must.
permissions:
  contents: read

# Newest push wins on PRs; main never cancels (every merge commit gets its image).
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}

env:
  IMAGE: acme.jfrog.io/docker-local/orders-api

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      digest: ${{ steps.build.outputs.digest }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2

      - uses: actions/setup-java@3b6c050358614dd082e53cdbc55580431fc4e437 # v4
        with:
          distribution: temurin
          java-version: "21"
          cache: maven

      - name: Build and test
        run: mvn -B -ntp verify

      - name: Upload test reports
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: surefire-reports
          path: app/target/surefire-reports/
          retention-days: 7

      - id: meta
        uses: docker/metadata-action@8e5442c4ef9f78752691e2d8f8d19755c6f78e81 # v5
        with:
          images: ${{ env.IMAGE }}
          tags: |
            type=sha,format=long
            type=semver,pattern={{version}}
            type=ref,event=pr

      - uses: docker/setup-buildx-action@6524bf65af31da8d45b59e8c27de4bd072b392f5 # v3

      - name: Log in to Artifactory
        if: github.event_name != 'pull_request'
        uses: docker/login-action@9780b0c442fbb1712d05a282a25f4290e40a990f # v3
        with:
          registry: acme.jfrog.io
          username: ${{ secrets.ARTIFACTORY_USERNAME }}
          password: ${{ secrets.ARTIFACTORY_TOKEN }}

      - id: build
        uses: docker/build-push-action@471d1dc4e07e5cdedd4c2171150001c434f0b7a4 # v6
        with:
          context: app
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  # Placeholder for the handoff: publish the chart, then PR the GitOps repo.
  # Chart publishing details: /ci/artifactory/ — the handoff: /operations/gitops-for-tenants/
  handoff:
    needs: build
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - name: Record what shipped
        run: |
          echo "orders-api pushed as ${{ needs.build.outputs.digest }}"
          echo "next: bump the GitOps repo to this digest"
```

A push to `main` produces console output ending like this — the digest line is the one the rest of the delivery system cares about:

```console
#18 pushing manifest for acme.jfrog.io/docker-local/orders-api:sha-9f2c41d…
#18 pushing manifest sha256:7c1e88f0…: done
ImageID / Digest
  digest: sha256:7c1e88f0a4b52c9d…
```

One workflow, two personalities, no rebuilds, no mutable tags, no secrets exposed to PR builds. The machinery underneath this file — trigger semantics, `${{ }}` injection, OIDC done right, caching, and the ARC runners the platform team operates — gets its own treatment in the [GitHub Actions Deep Dive](/ci/github-actions-deep-dive/). Next: stop every repo in the org from maintaining its own copy of this file — [Reusable Workflows and Templates](/ci/reusable-workflows/).
