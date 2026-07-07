---
title: Reusable Workflows and Templates
description: The paved-road CI pattern — platform-published golden workflows, the three GitHub reuse mechanisms, template versioning discipline, and what belongs in the template vs the caller.
keywords:
  - workflow_call reusable workflow
  - composite action shared steps
  - starter workflow template new repo
  - secrets inherit vs explicit passing
  - pinning template version @v2 vs @main
  - permissions can only shrink across boundary
  - copy-paste ci.yml rots
  - canary caller test template before retag
  - required workflows org rulesets
  - stop forking the pipeline template
  - deprecation window changelog for callers
  - composite run steps must declare a shell
sidebar:
  order: 3
---

The [previous article](/ci/github-actions/) ended with a complete, correct `ci.yml` for `orders-api` — about a hundred lines. Now imagine your org's fortieth Spring Boot service. Forty repos copy that file, and from the moment of the paste they diverge: repo 12 never picks up the buildx cache fix, repo 23's checkout pin is eighteen months stale, repo 31 quietly dropped the login `if:` guard and pushes images from PRs, and when the platform team migrates Artifactory auth to OIDC, "update CI" becomes forty pull requests into forty codebases with forty review queues. Copy-paste CI doesn't fail loudly; it *rots*, one repo at a time.

The org-scale fix is the same one you've already accepted for deployment manifests: **the platform team publishes golden templates; app teams call them.** You don't copy the platform's Helm chart scaffolding into your repo and fork it — you [consume charts and supply values](/helm/overview/). CI works the same way: the platform publishes a build-and-push workflow, your repo supplies the inputs (image name, chart dir, Java version), and a fix to the template is a fix for everyone on the next run. This is the paved road, applied to the pipeline itself.

## The three reuse mechanisms

GitHub gives you three, and teams waste time using the wrong one. The docs live at [Reusing workflows](https://docs.github.com/en/actions/sharing-automations/reusing-workflows); here's the decision table:

| Mechanism | Unit of reuse | Runs as | Reach for it when |
| --- | --- | --- | --- |
| Reusable workflow (`workflow_call`) | Whole jobs, with their runners, permissions, and ordering | Jobs in the *caller's* run | You're sharing a pipeline stage or the whole pipeline — **the workhorse** |
| Composite action | A bundle of steps | Steps inside one of the caller's jobs | You're sharing a step sequence that appears mid-job (login, version stamping) |
| Starter workflow | A template file offered in the UI | Copied into the repo (then it's theirs) | Bootstrapping brand-new repos with a correct day-one `ci.yml` |

**Reusable workflows** are jobs behind a typed interface: the caller can't reorder your steps, skip your scan, or see your implementation — it passes inputs and secrets and gets outputs back. That opacity is the governance property, which is why the golden pipeline below is one of these.

**Composite actions** are for the step-sized repetition *inside* jobs the caller still owns. The canonical example — Artifactory login, published at `acme/platform-actions/artifactory-login/action.yml`, complete:

```yaml
# acme/platform-actions/artifactory-login/action.yml
name: artifactory-login
description: Log in to the org Artifactory Docker registry with a scoped token.

inputs:
  registry:
    description: Registry hostname
    required: false
    default: acme.jfrog.io
  username:
    description: Artifactory username or token ID
    required: true
  token:
    description: Artifactory access token (pass a secret, never a literal)
    required: true

runs:
  using: composite
  steps:
    - name: Docker login
      uses: docker/login-action@9780b0c442fbb1712d05a282a25f4290e40a990f # v3
      with:
        registry: ${{ inputs.registry }}
        username: ${{ inputs.username }}
        password: ${{ inputs.token }}
    - name: Confirm registry reachability
      shell: bash          # composite run-steps must declare a shell — a classic gotcha
      run: docker buildx imagetools inspect ${{ inputs.registry }}/docker-local/base-images/jre:21 > /dev/null
```

Callers write `uses: acme/platform-actions/artifactory-login@v2` with two `with:` lines, and when the org moves to OIDC the action's internals change while its interface doesn't. Note the boundary, though: composite actions can't set job-level things (permissions, runner, `environment:`) — the moment your shared logic needs those, it's a reusable workflow.

**Starter workflows** (templates in the org's `.github` repo, surfaced under the repo's *Actions → New workflow* UI) get one paragraph because that's what they merit: they make the *first* commit of a new repo's `ci.yml` correct, and nothing after. A starter that contains the whole pipeline recreates the copy-paste problem with better onboarding. The right starter is ten lines: a call to the reusable workflow — the starter bootstraps you onto the paved road instead of handing you a shovel.

## The golden workflow, complete

Here is the platform team's build-and-push template, living in `acme/platform-workflows/.github/workflows/java-build-push.yml`. It's the `orders-api` pipeline from [the previous article](/ci/github-actions/) generalized behind an interface — typed inputs, explicit secrets, declared outputs:

```yaml
# acme/platform-workflows/.github/workflows/java-build-push.yml
name: java-build-push

on:
  workflow_call:
    inputs:
      image-name:
        description: Image path under docker-local (e.g. orders-api)
        required: true
        type: string
      java-version:
        description: JVM for build and test
        required: false
        type: string
        default: "21"
      chart-dir:
        description: Helm chart directory; empty skips chart publishing
        required: false
        type: string
        default: ""
      push:
        description: Push image and chart (false for PR builds)
        required: false
        type: boolean
        default: false
    secrets:
      artifactory-username:
        required: true
      artifactory-token:
        required: true
    outputs:
      image-digest:
        description: Digest of the pushed image (empty when push=false)
        value: ${{ jobs.build.outputs.digest }}
      chart-version:
        description: Chart version published (empty when chart-dir unset)
        value: ${{ jobs.chart.outputs.version }}

permissions:
  contents: read

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
          java-version: ${{ inputs.java-version }}
          cache: maven

      - name: Build and test
        run: mvn -B -ntp verify

      - id: meta
        uses: docker/metadata-action@8e5442c4ef9f78752691e2d8f8d19755c6f78e81 # v5
        with:
          images: acme.jfrog.io/docker-local/${{ inputs.image-name }}
          tags: |
            type=sha,format=long
            type=semver,pattern={{version}}
            type=ref,event=pr

      - uses: docker/setup-buildx-action@6524bf65af31da8d45b59e8c27de4bd072b392f5 # v3

      - name: Log in to Artifactory
        if: inputs.push
        uses: docker/login-action@9780b0c442fbb1712d05a282a25f4290e40a990f # v3
        with:
          registry: acme.jfrog.io
          username: ${{ secrets.artifactory-username }}
          password: ${{ secrets.artifactory-token }}

      - id: build
        uses: docker/build-push-action@471d1dc4e07e5cdedd4c2171150001c434f0b7a4 # v6
        with:
          context: app
          push: ${{ inputs.push }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      # Platform-owned gate: images that fail scanning never reach Artifactory.
      # Callers cannot remove this step — that is the point.
      - name: Scan image
        if: inputs.push
        run: ./scripts/scan.sh acme.jfrog.io/docker-local/${{ inputs.image-name }}@${{ steps.build.outputs.digest }}

  chart:
    needs: build
    if: inputs.push && inputs.chart-dir != ''
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.publish.outputs.version }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - id: publish
        name: Lint, package, push chart
        run: |
          helm lint ${{ inputs.chart-dir }}
          ./scripts/publish-chart.sh ${{ inputs.chart-dir }}   # details: /ci/artifactory/
```

And the caller side — the entire `.github/workflows/ci.yml` in the `orders-api` repo, which is the whole point of this article made visible:

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
    tags: ["v*.*.*"]

permissions:
  contents: read

jobs:
  ci:
    uses: acme/platform-workflows/.github/workflows/java-build-push.yml@v2
    with:
      image-name: orders-api
      chart-dir: charts/orders-api
      push: ${{ github.event_name != 'pull_request' }}
    secrets:
      artifactory-username: ${{ secrets.ARTIFACTORY_USERNAME }}
      artifactory-token: ${{ secrets.ARTIFACTORY_TOKEN }}
```

A hundred lines became eighteen, and the eighteen contain only things `orders-api` genuinely decides: its name, its chart, its push policy. Every future improvement to caching, scanning, or auth ships in the template.

Two mechanics worth knowing before your first call. **Permissions can only shrink across the boundary** — the called workflow's jobs run with at most the caller's token permissions, so a caller pinned at `contents: read` can't be escalated by a template asking for more; if the template legitimately needs `id-token: write` for OIDC, the caller must grant it, visibly, in its own file. **Debugging reads differently**: the called workflow's jobs appear inside the *caller's* run (named `ci / build`, `ci / chart`), so logs are where you expect — but the YAML that produced them lives in the platform repo at whatever ref you pinned. When a template job fails, your first two questions are "which template version am I on?" (the `uses:` line) and "did the canary catch this?" (ask the platform team) — not "what did I change?", because usually you changed nothing.

:::note[`secrets: inherit` exists — prefer the explicit form anyway]
`secrets: inherit` forwards *every* secret the caller can see, and it's tempting because it makes the caller two lines shorter. Resist it. Explicit passing is a contract: the template declares what it needs, the caller shows exactly what it hands over, and a security review of either file answers "what can this pipeline touch?" without reading the other. With `inherit`, a template compromise gets your repo's *entire* secret set, including the ones CI never needed — and nobody can tell from the diff. The explicit form is four extra lines of auditability. Pay it.
:::

## Versioning the template

For orientation, the platform repo that makes all of this work is small and boring on purpose:

```console
acme/platform-workflows
├── .github/workflows/
│   ├── java-build-push.yml      # the golden workflow above
│   ├── chart-publish.yml        # standalone chart pipeline
│   └── canary.yml               # runs the canary caller on template PRs
├── CHANGELOG.md                 # callers are customers; treat them like it
└── docs/migrating-v1-to-v2.md   # every major gets one
```

(Composite actions live in a sibling `acme/platform-actions` repo because actions resolve by path within a repo, and separating them keeps each repo's tags meaningful.)

That `@v2` on the `uses:` line is a git ref in the *platform's* repo, and choosing which kind of ref to pin is a real decision:

- **`@v2` — a moving major tag, the sane default.** The platform team retags `v2` onto each backward-compatible release (`v2.4.1` → retag `v2`), exactly like major action tags work. Callers get fixes automatically; breaking changes require the platform to cut `v3` and callers to opt in. This trades a little supply-chain purity for org velocity, and inside your own org — where the template repo has protected branches and its own review — that trade is usually right.
- **`@<full-sha>` — maximum safety.** Nothing changes under you, ever. The cost: nothing changes under you, ever — you're back to forty repos needing bumps, so this only works paired with Renovate/Dependabot automating the PRs. Right choice for high-assurance repos; overkill as the org default when the template source is internal and protected.
- **`@main` — never.** The incident writes itself, and did, in some form, at every org that allowed it: platform engineer merges a "harmless" refactor to the template on a Thursday at 4:55 pm; it renames an output; every repo's next push — including the payments team's hotfix at 5:10 — fails on a nil digest; nobody in the app teams changed anything, so half the org debugs *their own* code first; the timeline in the postmortem is forty minutes of confusion caused by one unversioned dependency. `@main` means every template merge instantly deploys to all callers with no rollout, no window, no opt-in. Ban it in review.

Moving tags put obligations on the platform team, and this cuts both ways. The template needs a **CHANGELOG** that treats callers as customers; breaking changes get a new major, a migration note, and a **deprecation window** during which the old major still receives security fixes — announced with dates, exactly like [the Kubernetes API deprecations](/operations/api-deprecations/) you already plan around. In return, callers owe timely migration: a team still on `@v1` two majors later is running unmaintained pipeline code and has forfeited the right to be surprised.

The platform team also needs to **test template changes before retagging**, because the template's blast radius is every caller. The pattern that works is a **canary caller**: a real repo (a clone of `orders-api` is perfect — a genuine Maven build, Dockerfile, and chart) whose CI calls the template `@main`, running on every template PR and nightly. Template change → canary goes red → the bad release never gets tagged `v2.5.0`, and no app team ever sees it. Only after the canary is green does the release get tagged and the `v2` pointer moved.

## What belongs in the template vs the caller

The line to draw: **the template owns everything the org must be able to change without asking forty teams; the caller owns everything only the app team can know.**

| Template owns (platform decides) | Caller owns (app team decides) |
| --- | --- |
| Tool versions and action pins (JDK distro, buildx, checkout SHA) | Which Java version *this app* targets (via input) |
| Artifactory auth mechanism (token today, OIDC tomorrow) | Nothing — auth changes should be invisible to callers |
| Registry paths, tag strategy, the no-`latest` rule | Image name |
| Vulnerability scanning and provenance/signing ([Supply Chain Security](/operations/supply-chain-security/)) | Nothing — these are the non-negotiables |
| Chart lint/package/push mechanics | The chart itself and [its values](/helm/values-and-overrides/) |
| Caching strategy | App-specific test commands and services ([Testing in CI](/ci/testing-in-ci/)) |
| — | When to push, when to promote, [environment gates](/ci/github-actions/) |

For the 10% of repos with a genuinely unusual need, the escape hatch is a **new input**, negotiated with the platform team — `extra-maven-args`, `context-dir`, a `skip-chart` boolean. Inputs keep the exception visible, typed, and supported. The anti-pattern is **forking the template**: copy `java-build-push.yml` into your repo, tweak the one step, done in an afternoon. Six months later your fork has none of the fixes, its own drift, and — the real cost — you've silently exited the paved road: when the org-wide OIDC migration lands, every caller migrates automatically and your fork breaks alone, on a Friday, with the one person who understood it on holiday. If the template genuinely can't accommodate you, that's a feature request against the template, not a fork. (Sound familiar? It's the same economics as forking a Helm chart instead of overriding values — [same lesson](/helm/authoring-best-practices/), different artifact.)

## Governance, briefly

Calling the template is culture; some things shouldn't depend on culture. GitHub's org-level **rulesets and required workflows** let the platform team mandate that certain workflows run and pass on every push to protected branches across the org — the right home for the true non-negotiables, like "no image reaches Artifactory unscanned." Keep the mandatory set minimal: required workflows are a hammer, and an org that requires twelve of them has rebuilt Jenkins-with-extra-steps. Alongside enforcement, measure adoption: a scheduled job that greps every repo's workflows via the API for `platform-workflows/.*@v` and charts who's on `v2`, who's stranded on `v1`, and who's gone feral with a fork — that dashboard is what turns deprecation windows from a hope into a plan.

## Chart publishing, previewed

Everything above pushed an image; the same pattern packages and publishes the Helm chart. The golden workflow's `chart` job lints, packages, and pushes `charts/orders-api` to Artifactory's Helm repository, versioned by the chart's own `Chart.yaml` semver (which moves independently of the app's — [Chart Anatomy](/helm/chart-anatomy/) if that still feels odd), so that CD can install `orders-api-1.4.2` from a registry instead of a git checkout. Repo layout, OCI-vs-classic Helm repos, and version-bump automation are [the Artifactory article's](/ci/artifactory/) territory; how released charts behave over months of upgrades is [Helm lifecycle](/helm/lifecycle-and-operations/) territory.

## The maturity ladder

Where orgs actually land, in order, each rung fixing the previous rung's failure mode:

1. **Copy-paste `ci.yml`** — works day one, rots by month six; fixes don't propagate.
2. **Shared composite actions** — the login and version-stamping steps stop diverging, but every repo still owns (and breaks) its job structure.
3. **Reusable workflows with pinned majors** — app repos shrink to a dozen lines of intent; the platform ships pipeline improvements org-wide with a retag; a canary guards the retag.
4. **Required workflows for the non-negotiables** — scanning and provenance stop being opt-in; the paved road grows a guardrail.

Most orgs are healthiest at rung 3 with a *thin* rung 4. If you're at rung 1 with forty repos, don't leap — publish one composite action, prove the ownership model, then lift the whole job into `workflow_call`. Next in this section: the other half of the stack — [Artifactory as the artifact hub](/ci/artifactory/), where all of these pushes land.
