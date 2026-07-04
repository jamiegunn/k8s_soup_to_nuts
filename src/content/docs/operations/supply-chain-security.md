---
title: Image and Supply-Chain Security
description: Securing the images you ship — base image strategy, digest pinning, CI scanning, SBOMs, and signing, with an honest split between what you own and what the platform enforces.
sidebar:
  order: 11
---

Every container image you ship is an executable you compiled from other people's code, pulled over the network, by a build system you probably didn't write. Supply-chain security sounds like a compliance topic until you realize the practical version of it: **you are one `FROM` line away from running someone else's code in production.** The good news for an app team: unlike CNI plugins or admission policy, the image pipeline is *yours*, end to end. This is one of the few security domains where you don't have to file a ticket with the platform team to fix things.

:::tip[War story]
Mutable tags bit for real in the Field Note [The Image That Changed Under Us](/blog/the-image-that-changed-under-us/) — two digests, one tag, one ReplicaSet.
:::

## The threat model, in plain terms

Skip the diagrams. Here are the four incident shapes that actually happen to app teams:

1. **The typosquat.** Someone on the team writes `FROM pyhton:3.12` or pulls `node-sass` lookalikes from a public registry. Public registries host malicious images with names one edit away from the real thing, and they get millions of pulls. Your build succeeds. The image works. It also mines crypto or exfiltrates environment variables — which, per [how secrets reach your pods](/workloads/secrets/), often contain credentials.
2. **The compromised upstream.** A legitimate image or package gets a malicious release pushed (event-stream, ua-parser-js, the xz backdoor). You didn't do anything wrong; you just rebuilt on a bad day.
3. **The vulnerable transitive layer.** Your Dockerfile is three lines. The base image beneath it is 400 MB of Debian userland, and one of those packages has the CVE-of-the-week. You never asked for `libwebp`, but you ship it, and now it's your pager.
4. **The tag that drifted under you.** You deploy `myapp-base:1.4`. Six weeks later a node is recycled, kubelet re-pulls the tag, and `1.4` now points at a different image than the one you tested — because tags are mutable and someone re-pushed. Same manifest, different bits, "nothing changed" in git. This one produces the most confusing incidents because drift detection sees no drift: the *spec* is identical.

Everything in this article is a countermeasure to one of those four.

## Base image strategy: minimal beats patched-fat

The single highest-leverage decision is what goes on your `FROM` line. A smaller image isn't just faster to pull — it's fewer packages for a scanner to flag and fewer binaries for an attacker to live off.

| Base | Size ballpark | Shell? | Package manager? | Notes |
|---|---|---|---|---|
| `ubuntu` / `debian` | 70–120 MB | yes | yes | Familiar, huge CVE surface, apt available at runtime (bad) |
| `alpine` | ~8 MB | yes | yes | musl libc — fine for Go/static, **historically painful for JVMs** |
| `gcr.io/distroless/*` | 2–40 MB | no | no | No shell, no apt. Debugging requires ephemeral containers |
| Chainguard / Wolfi | varies | optional | no (prod variants) | glibc-compatible, rebuilt daily, near-zero CVE count on release day |

Two practitioner notes on that table:

- **Alpine and the JVM.** musl's threading and DNS behavior differ from glibc, and while modern Temurin musl builds exist, you're volunteering for a less-traveled path. If you run Java, prefer a glibc distroless (`gcr.io/distroless/java21`) or a Wolfi-based JRE image — and get the [container-aware JVM flags](/java/jvm-in-containers/) right regardless of libc.
- **"No shell" is a feature.** When a scanner or attacker can't `apk add curl` inside your running container, an entire class of post-exploitation dies. Use `kubectl debug` with an ephemeral container when you genuinely need tools.

### The golden base image pattern

At org scale, the right move is a **golden base**: the platform or security team publishes `registry.internal/base/jre21:stable`, pre-hardened, scanned, rebuilt on a weekly cadence (or on CVE publication). You `FROM` it. Your responsibility shrinks to your application layer; their responsibility is the OS layer, on a rebuild schedule you inherit for free.

If your org has one, use it — this is one of the best deals the [platform team](/operations/working-with-platform-team/) will ever offer you. If it doesn't, ask for one; until then, pick a public minimal base and pin it by digest (next section).

### Multi-stage builds: toolchains never ship

Compilers, npm, Maven, and their caches belong in a build stage that gets thrown away. The classic secure JVM production image:

```dockerfile
# ---- build stage: full JDK + Maven, never ships ----
FROM registry.internal/base/jdk21-maven:stable AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -B dependency:go-offline
COPY src ./src
RUN mvn -B package -DskipTests

# ---- runtime stage: JRE only, non-root, digest-pinned ----
FROM registry.internal/base/jre21:stable@sha256:9f2a4e1c8b7d...
COPY --from=build /src/target/app.jar /app/app.jar
USER 65532:65532
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75.0", "-jar", "/app/app.jar"]
```

The final image contains a JRE and your jar. No Maven, no `git`, no shell history, no `~/.m2` with your Nexus credentials in `settings.xml` — a real leak vector we'll revisit below.

## Pinning and provenance: tags lie, digests don't

A tag is a mutable pointer. A digest is the content hash of the image itself. `myapp:1.4` can change; `myapp@sha256:2c1f...` cannot — if the bytes change, the digest changes.

```yaml
# In your Deployment spec — tag kept for humans, digest is what's enforced
image: registry.internal/team/myapp:1.4.2@sha256:2c1f9a07e4b8d3f6a1e5c9b2d8f4a7e3c6b1d9f2a5e8c4b7d1f6a3e9c2b5d8f4
```

When both are present, the runtime ignores the tag and pulls by digest. This kills threat #4 dead: what you tested is what runs, forever, regardless of registry-side shenanigans.

Nobody maintains digests by hand. Your pipeline resolves tag→digest at build/render time:

```bash
# Resolve without pulling
$ crane digest registry.internal/team/myapp:1.4.2
sha256:2c1f9a07e4b8d3f6a1e5c9b2d8f4a7e3c6b1d9f2a5e8c4b7d1f6a3e9c2b5d8f4

# Kustomize: pin it into the overlay
$ kustomize edit set image myapp=registry.internal/team/myapp@sha256:2c1f9a07...
```

Helm pipelines do the same by templating `image.digest` into values at release time. Where this step lives in your render flow is a [Helm/Kustomize pipeline design question](/operations/helm-and-kustomize/) — the invariant is that **git ends up holding a digest, not a floating tag**.

:::tip[imagePullPolicy stops mattering]
Half the folk wisdom about `imagePullPolicy: Always` exists to paper over mutable tags ("re-pull so we get the *real* latest"). With digest pinning, `IfNotPresent` is safe and faster: the digest either matches the cache or it doesn't. The one legitimate `Always` use case left is `:latest` in dev — which shouldn't exist in prod manifests anyway.
:::

### The registry boundary

The other half of provenance is *where* images come from. The org pattern: a **private registry with a pull-through mirror** of the public registries you allow. Builds and clusters pull only from `registry.internal`; the mirror caches upstream, applies allowlists, and survives Docker Hub rate limits and outages. If your platform runs one, point every `FROM` and every manifest at it. The credential plumbing — pull secrets, service account `imagePullSecrets` — is exactly the machinery covered in [ImagePullBackOff](/troubleshooting/imagepullbackoff/), because that's where it breaks when misconfigured.

## Scanning in CI: trivy and the noise problem

Trivy is the default answer: one binary, scans images, filesystems, and IaC config, no server required.

```bash
$ trivy image --severity HIGH,CRITICAL registry.internal/team/myapp:1.4.2

myapp:1.4.2 (debian 12.5)
=========================
Total: 3 (HIGH: 2, CRITICAL: 1)

┌────────────┬────────────────┬──────────┬────────┬───────────────────┬───────────────┐
│  Library   │ Vulnerability  │ Severity │ Status │ Installed Version │ Fixed Version │
├────────────┼────────────────┼──────────┼────────┼───────────────────┼───────────────┤
│ libexpat1  │ CVE-2024-45491 │ CRITICAL │ fixed  │ 2.5.0-1           │ 2.5.0-1+deb12u1 │
│ openssl    │ CVE-2024-6119  │ HIGH     │ fixed  │ 3.0.13-1          │ 3.0.14-1      │
│ zlib1g     │ CVE-2023-45853 │ HIGH     │ will_not_fix │ 1.2.13.dfsg-1 │             │
└────────────┴────────────────┴──────────┴────────┴───────────────────┴───────────────┘
```

Wire it as a gate, not a report nobody reads:

```yaml
# CI step — fail the build on fixable HIGH/CRITICAL
- name: Scan image
  run: |
    trivy image --exit-code 1 \
      --severity HIGH,CRITICAL \
      --ignore-unfixed \
      --ignorefile .trivyignore \
      "$IMAGE"
```

Also worth knowing: `trivy fs .` scans your lockfiles pre-build, `trivy config .` catches Dockerfile/manifest misconfigurations (running as root, `:latest` tags). Grype is a solid alternative scanner, and syft (same vendor) is the SBOM generator you'll meet in a moment.

### The noise problem — don't train people to ignore red

The failure mode of CI scanning isn't missed CVEs; it's a permanently red pipeline that everyone learns to override. Two flags in that CI snippet are doing policy work:

- `--ignore-unfixed`: a CVE with no available fix in a base layer is not actionable by you today. Blocking your deploy on it accomplishes nothing except normalizing the override button. (This is the pragmatic core of what VEX formalizes — a vendor statement that "this CVE doesn't affect this product as shipped.")
- `.trivyignore` **with justification discipline**: every entry gets a comment, an owner, and an expiry review. An unexplained ignore file is just a slower way of turning the scanner off.

```text
# .trivyignore
# CVE-2023-45853 — zlib minizip; code path not compiled into our zlib build.
#   Debian marks will_not_fix. Owner: @gunn. Review: 2026-10-01.
CVE-2023-45853
```

:::caution
The correct response to base-layer CVE noise is usually not a longer ignore file — it's a smaller base image. Every entry you add to `.trivyignore` for an OS package is an argument for distroless or a golden base with a rebuild cadence.
:::

## SBOMs: the honest section

A Software Bill of Materials is a machine-readable inventory of everything in your image — packages, versions, licenses — in SPDX or CycloneDX format. Generating one takes ten seconds:

```bash
$ syft registry.internal/team/myapp:1.4.2 -o cyclonedx-json > sbom.cdx.json
 ✔ Cataloged contents  ...  187 packages
```

Who actually asks for SBOMs: compliance, customers with regulatory exposure (US federal, finance, increasingly EU under CRA), and *future you* on the day the next log4shell drops and someone asks "which of our 40 services ships log4j-core 2.14?" — a question an SBOM archive answers in one `jq` query instead of forty rebuild-and-scan cycles.

The practical publication pattern is attaching the SBOM to the image in the registry via OCI referrers, typically `cosign attest --type cyclonedx --predicate sbom.cdx.json "$IMAGE@$DIGEST"`. Generate it in CI, attach it, move on. You don't need an SBOM strategy offsite; you need the artifact to exist and be findable when someone asks.

## Signing and verification: your half and theirs

Signing answers "did our CI actually build this image?" — which blocks anyone (including a compromised laptop with registry credentials) from injecting an image your cluster will run. The modern path is **cosign keyless**: no key files to leak, the signature is bound to your CI's OIDC identity and logged in a transparency log.

```yaml
# GitHub Actions example — the OIDC token *is* the identity
permissions:
  id-token: write
  packages: write
steps:
  - name: Sign image
    run: cosign sign --yes "$IMAGE@$DIGEST"
```

Verification prints the identity the signature is bound to:

```console
$ cosign verify \
    --certificate-identity-regexp 'https://github.com/acme/myapp/.github/workflows/.*' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "$IMAGE@$DIGEST"
Verification for registry.internal/team/myapp@sha256:2c1f... --
The following checks were performed on each of these signatures:
  - The cosign claims were validated
  - The claims were present in the transparency log
  - The code-signing certificate was verified using trusted certificate authority certificates
```

Here's the ownership split, stated plainly: **you sign; the platform verifies.** Enforcement at deploy time is an admission-control job — Kyverno `verifyImages` rules or sigstore's policy-controller, both cluster-scoped policy engines the platform team operates. You can't (and shouldn't be able to) install those from a namespace.

What *is* yours is knowing the failure mode. When enforcement is on and you push an unsigned or wrongly-signed image, your rollout doesn't crash — it never starts, and the error arrives as a webhook denial:

```console
$ kubectl -n shop describe rs myapp-7f9c4b8d6f | grep -A2 FailedCreate
  Warning  FailedCreate  12s  replicaset-controller  Error creating: admission webhook
  "mutate.kyverno.svc-fail" denied the request: resource Pod/shop/myapp-... was blocked
  due to the following policies: verify-image-signature: image not verified
```

That error shape — a create that's rejected before a pod ever exists — is [admission webhook territory](/controllers/admission-webhooks/); recognizing it saves you an hour of staring at a Deployment that shows `0/3` with no pods and no pull errors.

## Runtime-adjacent hygiene that's entirely yours

**No secrets in layers — ever, including deleted ones.** Every `RUN` line is a permanent layer. This Dockerfile leaks a token *forever*, despite the cleanup:

```dockerfile
COPY .npmrc /root/.npmrc          # contains //registry.npmjs.org/:_authToken=...
RUN npm ci && rm /root/.npmrc     # the rm creates a NEW layer; the old one still holds the file
```

Anyone with pull access can spelunk it:

```console
$ docker history --no-trunc myapp:1.4.2 | grep npmrc
<missing>  COPY .npmrc /root/.npmrc  # buildkit
$ docker save myapp:1.4.2 | tar -xO --wildcards '*/layer.tar' | tar -tv | grep npmrc
-rw-r--r--  0 root root  87 ... root/.npmrc
```

Use BuildKit secret mounts (`RUN --mount=type=secret,id=npmrc ...`) so credentials exist only during the build step and never land in a layer. Runtime credentials belong in Kubernetes Secrets, not in the image at all.

The rest of the hygiene list:

- **`.dockerignore`**: at minimum `.git`, `.env*`, `node_modules`, credentials files, and your CI configs. A missing `.dockerignore` plus `COPY . .` is how `.git` directories with credential remotes end up in prod images.
- **`USER` in the Dockerfile**: run as a fixed non-root UID (`USER 65532:65532`). Your pod spec should also declare `runAsNonRoot: true` — the Dockerfile makes it true, the [pod security context](/workloads/pod-security/) makes it enforced, and under restricted Pod Security admission an image that only runs as root simply won't schedule.
- **Rebuild-on-base-update automation**: an image built in January is January's CVE posture in June, even if your code never changed. Renovate and Dependabot both bump `FROM` lines (and digest pins) via PR:

```json
// renovate.json — keeps FROM digests fresh automatically
{
  "extends": ["config:recommended", ":pinDigests"],
  "packageRules": [
    { "matchDatasources": ["docker"], "matchUpdateTypes": ["digest"], "automerge": true }
  ]
}
```

Digest-pinning without rebuild automation is how teams freeze themselves onto a vulnerable base "for stability." Pin **and** automate the bump — the pin gives you provenance, the bot gives you currency, and CI scanning gates the merge.

## The maturity checklist

Honest sequencing, with the platform-dependency flags where they belong:

**Crawl — this sprint, zero platform involvement:**
- [ ] Digest-pin every image reference in your manifests; pipeline resolves tag→digest
- [ ] `trivy image` gate in CI: fail on fixable HIGH/CRITICAL, `.trivyignore` entries require justification + owner + review date
- [ ] `.dockerignore` exists; `docker history` audit for baked secrets on your current prod images

**Walk — this quarter, mostly yours:**
- [ ] Move to a minimal or golden base (distroless/Wolfi, or the org base if the platform publishes one — *ask*)
- [ ] Multi-stage builds everywhere; production images have no toolchain, no shell where feasible
- [ ] Non-root `USER` in every Dockerfile, matching `runAsNonRoot` in pod specs
- [ ] Renovate/Dependabot on `FROM` lines and digest pins, automerged behind the scan gate

**Run — needs platform cooperation, flagged honestly:**
- [ ] Cosign keyless signing in CI *(yours)* + admission-time verification *(theirs — Kyverno/policy-controller is cluster policy; bring them the certificate-identity patterns your CI produces)*
- [ ] SBOM generated and attached per image *(yours)*; org-wide SBOM query/archive *(usually a security-team platform)*
- [ ] Registry allowlisting so only `registry.internal` images admit *(theirs; your part is having already migrated every reference)*

The crawl tier alone eliminates threats #1 and #4 and catches most of #3 before it ships. Don't wait for the platform team to build the run tier before doing the parts that are yours today.
