---
title: "Artifactory: Images, Charts, and Dependency Persistence"
description: Artifactory from the app-team seat — the local/remote/virtual repository model, Docker and Helm publishing, Renovate against a private registry, dependency persistence, and the failure decoder for 401s, 403s, and vanished artifacts.
keywords:
  - jfrog private docker registry
  - 401 unauthorized on docker push
  - 403 forbidden pulling image in cluster
  - manifest unknown image disappeared
  - 429 too many requests docker hub rate limit
  - imagepullsecrets errimagepull
  - helm push oci chart registry
  - index.yaml chart not found after upload
  - xray cve policy block download
  - renovate against private registry
  - retention cleanup policy deleted my tag
  - maven mirrorof settings.xml dependency cache
sidebar:
  order: 4
---

Your org runs Artifactory so that every artifact your pipeline produces or consumes — Docker images, Helm charts, Maven jars, npm packages — flows through one system with one auth model, one retention policy, and one audit trail. From the app-team seat you don't administer it; you publish to it, pull from it, and occasionally file a ticket when something 403s. This article is the working knowledge you need for all three, using the `orders-api` image and chart from [the build job article](/ci/github-actions/) as the running example.

## The repository model: local, remote, virtual

Every confusing thing about Artifactory becomes obvious once you internalize its three repository types. They repeat for *every* artifact format — Docker, Helm, Maven, npm, PyPI, all of them:

```text
                         ┌─────────────────────────────────┐
   your tools point ───▶ │  docker  (VIRTUAL)              │
   HERE and only here    │                                 │
                         │  ┌───────────────────────────┐  │
   your CI pushes ─────────▶│ docker-local  (LOCAL)     │  │  what YOUR org publishes
                         │  └───────────────────────────┘  │
                         │  ┌───────────────────────────┐  │
                         │  │ docker-remote (REMOTE)    │──────▶ proxies Docker Hub,
                         │  └───────────────────────────┘  │     caches what it fetches
                         └─────────────────────────────────┘
```

- **Local** repositories hold what your org publishes. `docker-local` contains `orders-api` images your CI pushed. Nothing arrives here except by an authenticated push.
- **Remote** repositories are caching proxies of an upstream: `docker-remote` fronts Docker Hub, `maven-remote` fronts Maven Central. The first request for an artifact fetches it upstream and stores a copy; every subsequent request is served from Artifactory's disk.
- **Virtual** repositories aggregate locals and remotes behind one URL. When you pull `eclipse-temurin:21-jre` through the `docker` virtual, Artifactory checks `docker-local` first, then falls through to `docker-remote`. Your tools get one endpoint; the admins get to rearrange the plumbing behind it without breaking you.

The rule of thumb that resolves 90 % of "which URL do I use" confusion:

> **Pull from the virtual. Push to the local.** (Some orgs configure a *default deployment repository* on the virtual so pushes to the virtual land in the local — ask, don't assume.)

The pattern repeats verbatim for Maven (`libs-release-local` / `maven-remote` / `libs-release`), npm (`npm-local` / `npm-remote` / `npm`), and Helm. Once you've seen the triad once, you've seen all of Artifactory.

## Artifactory as your Docker registry

The image reference the rest of this site uses is:

```text
<org>.jfrog.io/docker-local/orders-api:1.4.0
```

Note the repository name is the first path segment on the JFrog cloud URL — `docker-local` for pushes, `docker` (the virtual) for pulls of anything that might come from upstream.

### What proxying Docker Hub buys you

Pointing your Dockerfiles and clusters at `docker-remote` (via the virtual) instead of Docker Hub directly gets you three things:

1. **Rate-limit immunity.** Docker Hub throttles anonymous and free-tier pulls. A cluster of 40 nodes all pulling `postgres:16` after a node pool upgrade will hit that limit; Artifactory serves the cached copy and only Artifactory's own (authenticated, infrequent) upstream fetches count against the quota.
2. **Persistence.** Once an upstream image is cached, it stays cached even if the upstream tag is deleted, retagged, or the whole repository vanishes. This is not hypothetical: base images get yanked. If `orders-api` was built `FROM eclipse-temurin:21.0.2_13-jre` and that tag disappears from Docker Hub, your rebuilds keep working because Artifactory still has the blobs. (Persistence protects *availability*, not *identity* — a mutable tag can still be re-pushed upstream with different content. For identity, pin digests; see [Supply Chain Security](/operations/supply-chain-security/).)
3. **One choke point for scanning and policy** — covered under Xray below.

:::note[The base-image-deleted story]
A team we know built against `FROM some-vendor/runtime:3.2` for a year. The vendor deleted their Docker Hub org during an acquisition. Every team pulling direct from Hub lost the ability to rebuild — including hotfix rebuilds of images already in prod. The one org pulling through an Artifactory remote repo rebuilt without noticing anything had happened, then calmly migrated on their own schedule. Proxy everything. Pin digests anyway.
:::

### Pulling in the cluster: imagePullSecrets

Your platform-managed cluster pulls `orders-api` from Artifactory, which requires registry credentials in every namespace that runs it:

```bash
kubectl create secret docker-registry artifactory-pull \
  --namespace orders \
  --docker-server=<org>.jfrog.io \
  --docker-username=svc-orders-pull \
  --docker-password="$ARTIFACTORY_PULL_TOKEN"
```

and in the pod spec (the chart wires this through `.Values.imagePullSecrets`):

```yaml
spec:
  imagePullSecrets:
    - name: artifactory-pull
```

Most platform teams inject this secret into tenant namespaces automatically — check before creating your own. If pulls fail with `ErrImagePull`/`ImagePullBackOff`, work the decoder in [ImagePullBackOff](/troubleshooting/imagepullbackoff/); for how the secret itself should be managed rather than hand-created, see [Secrets](/workloads/secrets/).

### Pushing from CI

The full build job lives in [GitHub Actions: the build job](/ci/github-actions/); the Artifactory-relevant core is just this:

```yaml
      - name: Log in to Artifactory
        uses: docker/login-action@v3
        with:
          registry: <org>.jfrog.io
          username: ${{ vars.ARTIFACTORY_CI_USER }}
          password: ${{ secrets.ARTIFACTORY_CI_TOKEN }}

      - name: Push
        run: docker push <org>.jfrog.io/docker-local/orders-api:${{ github.ref_name }}
```

The token behind `ARTIFACTORY_CI_TOKEN` must have **deploy** permission on `docker-local` specifically. Read-everything tokens are common defaults and produce the classic 401-on-push (decoder table below).

### Retention: why your image disappeared

Local Docker repos accumulate garbage at CI speed — every PR build, every `sha-` tag. Admins configure retention rules (Artifactory *cleanup policies*), typically something like:

| Tag pattern | Kept |
|---|---|
| Semver release tags (`1.4.0`) | forever, or N years |
| `main-<sha>` builds | 90 days |
| `pr-*` / `dev-*` tags | 14 days |

So when a colleague says "my image disappeared from Artifactory," the answer is almost never gremlins and almost always: it was a dev tag, retention ran, the manifest was deleted, and the pull now returns `manifest unknown`. If a *release* tag disappeared, that's a real incident — but check the pattern first. Anything running in a long-lived environment must be on a retained tag pattern (better: a digest), never on `pr-123`.

## Helm charts in Artifactory

Two flavors coexist, and your org probably has both because they adopted Helm before OCI support matured.

### Flavor 1: the classic Helm repo (`helm-local`)

A repository type `helm` local repo, consumed via `helm repo add` against the matching virtual:

```bash
helm repo add org https://<org>.jfrog.io/artifactory/api/helm/helm \
  --username svc-orders-pull --password "$ARTIFACTORY_PULL_TOKEN"
helm repo update
helm search repo org/orders-api
```

Publishing is a plain HTTP upload of the packaged chart:

```bash
curl -u "svc-ci:$ARTIFACTORY_CI_TOKEN" \
  -T orders-api-1.4.0.tgz \
  "https://<org>.jfrog.io/artifactory/helm-local/orders-api-1.4.0.tgz"
```

:::caution[The index.yaml refresh gotcha]
Classic Helm repos are driven by a generated `index.yaml`. Artifactory recalculates it asynchronously after an upload (and the virtual repo's merged index is cached separately, default 600 s). So the sequence *push chart → immediately `helm repo update` → "chart not found"* is normal, not broken. Wait, or have an admin lower the virtual's index cache period, or — better — use OCI, which has no index at all.
:::

### Flavor 2: OCI charts (the modern default)

Since Helm 3.8, charts are first-class OCI artifacts and can live in a Docker-type repo. Same auth, same retention machinery, no index.yaml. This is what new setups should use:

```bash
helm registry login <org>.jfrog.io -u svc-ci -p "$ARTIFACTORY_CI_TOKEN"
helm push orders-api-1.4.0.tgz oci://<org>.jfrog.io/helm-local
```

```text
Pushed: <org>.jfrog.io/helm-local/orders-api:1.4.0
Digest: sha256:9f2c4e1a7b3d5f60c8e2a4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6
```

Note the tag is the chart version — no `helm repo add`, no index refresh delay, and consumers can pin the digest. Installation and day-2 operations against OCI refs are covered in [Lifecycle and Operations](/helm/lifecycle-and-operations/); Helm's own reference is at [helm.sh/docs](https://helm.sh/docs/).

### The chart release workflow, end to end

The discipline underneath all of this: **the chart version in `Chart.yaml` is the chart's API version**. Consumers pin it, Renovate diffs it, GitOps references it — so it must be bumped deliberately, never reused, and derived from one source of truth. On this site that source is the git tag (see [Chart Anatomy](/helm/chart-anatomy/) for the version/appVersion split).

```yaml
# .github/workflows/chart-release.yml
name: chart-release
on:
  push:
    tags: ["chart-v*"]          # chart-v1.4.0

permissions:
  contents: read

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: azure/setup-helm@v4
        with:
          version: v3.15.2

      - name: Derive version from tag
        id: ver
        run: echo "version=${GITHUB_REF_NAME#chart-v}" >> "$GITHUB_OUTPUT"

      - name: Lint and test
        run: |
          helm lint charts/orders-api --strict
          helm unittest charts/orders-api   # see /ci/testing-in-ci/

      - name: Package with version from the tag
        run: |
          helm package charts/orders-api \
            --version "${{ steps.ver.outputs.version }}" \
            --app-version "${{ steps.ver.outputs.version }}"

      - name: Push to Artifactory (OCI)
        run: |
          helm registry login <org>.jfrog.io \
            -u "${{ vars.ARTIFACTORY_CI_USER }}" \
            -p "${{ secrets.ARTIFACTORY_CI_TOKEN }}"
          helm push "orders-api-${{ steps.ver.outputs.version }}.tgz" \
            oci://<org>.jfrog.io/helm-local
```

Passing `--version` at package time from the tag means `Chart.yaml`'s committed version never silently drifts from what was published, and you can't publish the same version twice from two branches (Artifactory Docker repos should be set immutable-tag for `helm-local`; ask for it). The lint/unittest rung is expanded in [Testing in CI](/ci/testing-in-ci/).

On the consumption side:

```bash
# ad hoc / local
helm install orders-api oci://<org>.jfrog.io/helm-local/orders-api --version 1.4.0

# GitOps (Argo CD Application excerpt)
source:
  repoURL: <org>.jfrog.io/helm-local
  chart: orders-api
  targetRevision: 1.4.0
```

How the GitOps controller authenticates to Artifactory and where `targetRevision` bumps come from is the subject of [GitOps for Tenants](/operations/gitops-for-tenants/).

### Chart updates flowing back: Renovate against Artifactory

Publishing versions is half the loop; the other half is machines noticing them. Renovate (or Dependabot, with less private-registry flexibility) watches Artifactory and opens PRs when new chart or image versions appear:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "hostRules": [
    {
      "matchHost": "<org>.jfrog.io",
      "username": "svc-renovate",
      "password": "{{ secrets.ARTIFACTORY_RENOVATE_TOKEN }}"
    }
  ],
  "packageRules": [
    {
      "matchDatasources": ["docker"],
      "matchPackageNames": ["<org>.jfrog.io/docker-local/orders-api"],
      "groupName": "orders-api image"
    },
    {
      "matchDatasources": ["helm", "docker"],
      "matchPackageNames": ["orders-api"],
      "registryUrls": ["https://<org>.jfrog.io/artifactory/api/helm/helm"]
    }
  ]
}
```

(OCI charts resolve through the `docker` datasource — one more reason the flavors matter.)

The pattern worth stealing: make the update PR show the **rendered diff**, not just the version bump. A small workflow step runs `helm template` at the old and new chart versions with your real values files and posts the manifest diff as a PR comment. A chart bump that changes one line of `Chart.yaml` but rewrites your PodSpec is exactly the thing you want reviewers to see — how values interact with chart defaults across versions is [Values and Overrides](/helm/values-and-overrides/) territory.

## Dependency persistence: the quiet superpower

The remote-repo pattern applies to build dependencies too, and it's the least appreciated thing Artifactory does. Point Maven at the org virtual instead of Central:

```xml
<!-- ci/settings.xml — used by mvn -s ci/settings.xml in the build job -->
<settings>
  <mirrors>
    <mirror>
      <id>artifactory</id>
      <name>Org Artifactory</name>
      <url>https://<org>.jfrog.io/artifactory/libs-release</url>
      <mirrorOf>*</mirrorOf>
    </mirror>
  </mirrors>
  <servers>
    <server>
      <id>artifactory</id>
      <username>${env.ARTIFACTORY_CI_USER}</username>
      <password>${env.ARTIFACTORY_CI_TOKEN}</password>
    </server>
  </servers>
</settings>
```

`mirrorOf: *` means *every* dependency resolution goes through Artifactory. The first build populates the cache; from then on, your builds keep working when Maven Central has an outage, when a transitive dependency is unpublished (npm's left-pad, but it happens on every ecosystem), or when a corporate proxy change breaks direct internet access from runners. Reproducible builds of old releases — the hotfix-a-two-year-old-version scenario — depend on this cache existing. Same story for npm (`.npmrc` registry pointing at the `npm` virtual) and pip.

### Build-info and promotion, briefly

Artifactory's JFrog CLI can attach *build-info* (what was built, from which commit, with which dependencies) to published artifacts, and admins often model environments as repos: CI publishes to `docker-dev-local`, and passing artifacts get **promoted** — a server-side move/copy, no rebuild — to `docker-prod-local`. The point is the immutable-artifact principle: the bytes that ran in staging are byte-identical to the bytes that reach prod. Where promotion fits in the pipeline shape is covered in [CI/CD Pipeline Design](/operations/cicd-pipeline-design/); whether your org uses repo-promotion or plain tag discipline, the principle is the same.

### Xray, honestly

If your org licenses Xray, it scans artifacts for CVEs and license violations and can **gate** in two places: on push (your CI upload fails policy) or on download (your build or cluster pull gets an HTTP 403 with an Xray policy message in the body). The app-team experience of the second is disorienting — the artifact *exists*, you can see it in the UI, but pulls fail. Read the response body, not just the status code: an Xray block names the policy and the CVE. Your options are: upgrade the dependency, or request a time-boxed policy waiver from whoever owns the policy. Don't burn an afternoon debugging credentials that were never the problem. Bigger picture in [Supply Chain Security](/operations/supply-chain-security/); product docs at [jfrog.com/help](https://jfrog.com/help/).

## The failure decoder

| Symptom | Almost always | Fix |
|---|---|---|
| `401 Unauthorized` on `docker push` / `helm push` | Token lacks **deploy** permission on the local repo, or you're pushing to the virtual without a default deployment repo configured | Push to `docker-local`/`helm-local` explicitly; ask admins to add deploy perms for the CI token's group |
| `403 Forbidden` pulling in-cluster (`ImagePullBackOff`) | `imagePullSecret` credentials are scoped to a different repo, expired token, or an Xray download block | `kubectl get events` for the exact error; recreate the secret; check the response body for an Xray policy name — see [ImagePullBackOff](/troubleshooting/imagepullbackoff/) |
| Chart pushed successfully but `helm search repo` / install can't find it | Virtual repo doesn't include the local you pushed to, or (classic repos) index.yaml not yet recalculated | Verify the virtual's included repositories with admins; wait out / lower the index cache period; OCI avoids this class entirely |
| `manifest unknown` pulling a tag that worked last month | Retention/cleanup policy deleted it — it was a dev-pattern tag | Rebuild from the commit, and stop deploying long-lived environments from ephemeral tags |
| `429 Too Many Requests` on base image pulls | You're pulling straight from Docker Hub, bypassing the remote repo | Change `FROM` lines and pod images to go through `<org>.jfrog.io/docker` |

## What to ask the Artifactory admins for

New service onboarding goes fastest when the request is precise. The template:

```text
Service: orders-api (team: orders)

Repositories (confirm existing or create):
  - docker-local        push access for CI      (image: orders-api)
  - helm-local (OCI)    push access for CI      (chart: orders-api)
  - docker / helm / libs-release virtuals: read access

Tokens (scoped access tokens, not user passwords):
  - svc-orders-ci:    deploy on docker-local + helm-local, read on virtuals
                      (stored as GitHub Actions secret, see /ci/github-actions/)
  - svc-orders-pull:  read-only on docker virtual
                      (used for the namespace imagePullSecret)
  - expiry policy? rotation process?

Retention:
  - which cleanup policies apply to docker-local?
  - request: release tags (semver) exempt from cleanup

Policy:
  - is Xray gating on push, download, or both, for these repos?
  - waiver process and SLA?
```

Ten minutes writing this saves the multi-day ticket ping-pong of discovering each item by hitting its failure mode in the decoder table above. With publishing squared away, the next article climbs the [testing ladder](/ci/testing-in-ci/) that runs before anything gets pushed at all.
