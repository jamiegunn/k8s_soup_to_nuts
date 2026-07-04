---
title: "Testing in CI: Units, Charts, and Ephemeral Clusters"
description: The testing ladder for a Kubernetes app and its chart — app unit tests, helm-unittest, kubeconform and golden files, and the honest case for (and against) a k3d cluster on the runner.
sidebar:
  order: 5
---

This site draws a hard line for CI on shared runners: **unit tests always; integration tests only if you build the thing you're integrating with on the runner.** No CI job gets network access to a real cluster, a real database, or a shared staging environment — those tests belong to CD and live in [CI/CD Pipeline Design](/operations/cicd-pipeline-design/). Everything below that line, though, is fair game, and there's more below the line than most teams exploit. For a Kubernetes app the artifact under test is really two artifacts — the `orders-api` image and the `orders-api` chart — and the chart deserves the same test discipline as the code.

## The ladder

```text
  cost/PR        rung                              catches                        can't catch
  ─────────────────────────────────────────────────────────────────────────────────────────────
  ~60-120s   1. app unit tests                 logic bugs, contract regressions   wiring, config
  ~5s        2. chart static (lint + schema)   malformed YAML, invalid values     bad rendered output
  ~10s       3. chart unit tests (helm-unittest) template logic, values wiring    schema-invalid output
  ~15s       4. rendered-manifest validation   API deprecations, schema errors,   whether it actually
                (kubeconform + golden diffs)     accidental template drift          installs and runs
  ─────────────────────────────────────────────────────────────────────────────────────────────
  ~3min      5. OPTIONAL: ephemeral cluster    install-ability, hooks, RBAC,      anything needing the
                (k3d install test)               probes actually passing            real platform
  ─────────────────────────────────────────────────────────────────────────────────────────────
             everything beyond → real environments, owned by CD
```

Each rung is cheap enough to run on every PR *because* of what it refuses to test. Rung 4 can prove your rendered Deployment is valid against Kubernetes 1.30's schema; it cannot prove the pod starts. Rung 5 can prove the pod starts on a vanilla cluster; it cannot prove your platform's NetworkPolicies, ingress class, or storage classes behave. Knowing what each rung *can't* catch is what keeps you from writing the wrong test at the wrong altitude.

## Rung 1: app unit tests

The Maven side is mostly plumbing you already have from [the build job](/ci/github-actions/) — same JDK setup, same dependency cache — so this section covers only what's test-specific.

Split unit from integration at the Maven level with the Surefire/Failsafe convention: `*Test.java` runs in `test` via Surefire (fast, no external processes), `*IT.java` runs in `verify` via Failsafe. That split is what lets the workflow choose its blast radius per trigger:

```yaml
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "21"
          cache: maven
      - name: Unit tests
        run: ./mvnw -B test
      - name: Integration-tagged tests (testcontainers)
        run: ./mvnw -B failsafe:integration-test failsafe:verify
      - name: Upload test reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: surefire-reports
          path: "**/target/*-reports/TEST-*.xml"
      - name: Publish test summary
        if: always()
        uses: dorny/test-reporter@v1
        with:
          name: JUnit results
          path: "**/target/*-reports/TEST-*.xml"
          reporter: java-junit
```

`if: always()` on the report steps is non-negotiable — the runs you most need reports for are the failing ones.

### Testcontainers, honestly

GitHub's hosted `ubuntu-latest` runners ship with a working Docker daemon, so Testcontainers *just works* — no service containers, no docker-in-docker contortions:

```java
@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
class OrderRepositoryIT {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine");

    @Autowired OrderRepository orders;

    @Test
    void findsUnshippedOrdersByCustomer() {
        orders.save(new Order("cust-42", OrderStatus.PLACED));
        orders.save(new Order("cust-42", OrderStatus.SHIPPED));

        assertThat(orders.findByCustomerIdAndStatusNot("cust-42", OrderStatus.SHIPPED))
            .hasSize(1);
    }
}
```

Call this what it is: an integration test wearing a unit costume. It boots a real Postgres, so it catches real SQL — the native query that H2 would have waved through — but it costs 20–40 s of container pull and startup per JVM fork and adds a flakiness surface (image pull hiccups, port races) that pure unit tests don't have. The honest policy:

- **Keep on every PR** while the suite is a handful of repository tests and total wall clock stays under ~90 s.
- **Gate to merge-to-main or nightly** once the testcontainers portion dominates PR feedback time — the Failsafe split above makes that a one-line workflow change, not a refactor.
- Give it a flakiness budget: a testcontainers test that fails spuriously more than ~1 in 200 runs gets fixed or quarantined (policy at the end of this article), never retried-into-green forever.

:::caution[Pull your test images through Artifactory]
`postgres:16-alpine` in the example above comes from Docker Hub, and 200 PR builds a month is exactly the traffic that hits Hub rate limits. Configure Testcontainers' registry prefix (`testcontainers.properties`: `hub.image.name.prefix=<org>.jfrog.io/docker-remote/`) so test images ride the same cache as everything else — see [the Artifactory article](/ci/artifactory/).
:::

## Rung 2: chart static tests

`helm lint charts/orders-api --strict` takes two seconds, so run it — but be honest about what it is: a YAML-parses-and-required-fields-exist check plus a few heuristics. It will catch a chart with no `Chart.yaml` version and a template that renders unparseable YAML. It will happily bless a Deployment whose image is `{{ .Values.imag.tag }}` rendering to `:latest`. Lint passing means almost nothing; lint failing means stop.

The static check that actually earns its keep is `values.schema.json`. If the chart ships one (it should — see [Values and Overrides](/helm/values-and-overrides/)), every `helm template`, `lint`, and `install` validates values against it, so `replicas: "two"` or a typo'd `resouces:` block dies in CI with a named error instead of surfacing as a weird rollout three articles later. Schema validation runs implicitly in every rung below; you don't need a separate step, you need the schema to exist and be strict (`"additionalProperties": false`).

## Rung 3: chart unit tests with helm-unittest

[helm-unittest](https://github.com/helm-unittest/helm-unittest) is a Helm plugin that renders your templates with given values and asserts on the output — no cluster, no API server, pure text-in/text-out, ~1 s for a whole suite. It's the tool that makes the template logic from [The Template Language](/helm/template-language/) testable, and it's how the rules in [Authoring Best Practices](/helm/authoring-best-practices/) stop being review comments and start being CI failures.

Tests live in the chart under `tests/`:

```yaml
# charts/orders-api/tests/deployment_test.yaml
suite: deployment
templates:
  - deployment.yaml

tests:
  - it: wires image repository and tag from values
    set:
      image.repository: <org>.jfrog.io/docker-local/orders-api
      image.tag: "1.4.0"
    asserts:
      - equal:
          path: spec.template.spec.containers[0].image
          value: <org>.jfrog.io/docker-local/orders-api:1.4.0

  - it: defaults image tag to appVersion when tag is empty
    set:
      image.tag: ""
    asserts:
      - matchRegex:
          path: spec.template.spec.containers[0].image
          pattern: ":1\\.4\\.0$"   # Chart.yaml appVersion

  - it: points probes at the actuator endpoints
    asserts:
      - equal:
          path: spec.template.spec.containers[0].readinessProbe.httpGet.path
          value: /actuator/health/readiness
      - equal:
          path: spec.template.spec.containers[0].livenessProbe.httpGet.path
          value: /actuator/health/liveness

  - it: carries the config checksum annotation so config changes roll pods
    asserts:
      - exists:
          path: spec.template.metadata.annotations["checksum/config"]

  - it: passes resources through verbatim
    set:
      resources:
        requests: { cpu: 250m, memory: 512Mi }
        limits: { memory: 512Mi }
    asserts:
      - equal:
          path: spec.template.spec.containers[0].resources.requests.cpu
          value: 250m
      - equal:
          path: spec.template.spec.containers[0].resources.limits.memory
          value: 512Mi
```

```bash
helm plugin install https://github.com/helm-unittest/helm-unittest
helm unittest charts/orders-api
```

```text
### Chart [ orders-api ] charts/orders-api

 PASS  deployment	charts/orders-api/tests/deployment_test.yaml

Charts:      1 passed, 1 total
Test Suites: 1 passed, 1 total
Tests:       5 passed, 5 total
Snapshot:    0 passed, 0 total
Time:        112.7ms
```

Notice what these tests target: the *values wiring* — the chart's public API. Not "the Deployment has a spec" (helm's job) but "when a consumer sets `image.tag`, it lands where they think it does." Those are the regressions template refactors actually cause.

helm-unittest also does **snapshot testing** (`matchSnapshot` asserts): the first run records the full rendered output under `tests/__snapshot__/`, later runs diff against it, and `helm unittest -u` re-records. Snapshots are great for "nothing changed that I didn't intend" coverage of templates you rarely touch — and they rot in the predictable way: once a team gets used to running `-u` and committing whatever appears, the snapshot stops being a test and becomes a changelog nobody reads. Use a few targeted snapshots plus explicit asserts, not snapshot-everything.

The CI step:

```yaml
  chart-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: azure/setup-helm@v4
        with:
          version: v3.15.2
      - run: helm plugin install https://github.com/helm-unittest/helm-unittest --version 0.5.2
      - run: helm lint charts/orders-api --strict
      - run: helm unittest charts/orders-api
```

## Rung 4: rendered-manifest validation

helm-unittest checks the values you asserted on; this rung checks that the *whole* rendered output is a set of valid Kubernetes objects for the versions you actually run.

### kubeconform against pinned versions

[kubeconform](https://github.com/yannh/kubeconform) validates manifests against Kubernetes OpenAPI schemas, offline, per version:

```yaml
      - name: Validate rendered manifests against cluster versions
        run: |
          curl -sSL https://github.com/yannh/kubeconform/releases/download/v0.6.7/kubeconform-linux-amd64.tar.gz \
            | tar xz kubeconform
          for v in 1.29.0 1.30.0; do
            helm template orders-api charts/orders-api \
              --values charts/orders-api/ci/prod-values.yaml \
            | ./kubeconform -strict -summary \
                -kubernetes-version "$v" \
                -schema-location default \
                -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceVersion}}.json'
          done
```

```text
Summary: 6 resources found parsing stdin - Valid: 6, Invalid: 0, Errors: 0, Skipped: 0
```

Pin the version list to *your platform's* current and next Kubernetes version — this is your automated [API deprecations](/operations/api-deprecations/) gate: the day your chart renders `policy/v1beta1` against a 1.30 schema, this step fails, months before the platform upgrade would have failed it for real.

Two caveats. Kubeconform only knows core APIs; CRDs (ServiceMonitor, ExternalSecret, your platform's tenancy CRDs) need the extra `-schema-location` pointing at the community CRDs-catalog as above, or they're unvalidatable. And for CRDs not in any catalog, choose deliberately between `-ignore-missing-schemas` (silent skip — record that you chose blindness) and failing.

### Golden-file diffs

The cheapest high-signal chart test there is: render against fixed values, diff against a committed known-good rendering.

```bash
#!/usr/bin/env bash
# hack/check-goldens.sh
set -euo pipefail
for values in charts/orders-api/ci/*-values.yaml; do
  name=$(basename "$values" -values.yaml)
  helm template orders-api charts/orders-api --values "$values" \
    > "/tmp/golden-$name.yaml"
  diff -u "charts/orders-api/ci/golden/$name.yaml" "/tmp/golden-$name.yaml" || {
    echo "::error::Rendered output drifted from golden file for '$name'."
    echo "If intentional, run: hack/update-goldens.sh and commit the diff."
    exit 1
  }
done
```

What this catches that nothing else does: *accidental* template drift — the helper refactor that silently dropped a label from the Service, the dependency bump that changed a default. The rendered diff shows up **in the PR diff** (via `hack/update-goldens.sh`, the same loop with `>` instead of `diff`), so reviewers review manifests, not template code. The ritual matters: goldens are only useful while "regenerate and commit" is a conscious act accompanied by reading the diff. Same rot mode as snapshots; same cure.

## Rung 5 (optional): the ephemeral cluster

Everything above operates on rendered text. Text can't tell you whether the chart *installs* — whether hooks run in order, whether the ServiceAccount/RBAC objects are sufficient for the pod to start, whether your probe paths return 200 on the image you just built, whether `helm upgrade` from the previous release version succeeds. If your chart has hooks, RBAC, initContainers, or migrations, this rung earns its runner-minutes.

And if it doesn't — if `orders-api`'s chart is one Deployment, one Service, one ConfigMap — **skip this rung**. Rungs 3–4 already cover ~all of its failure modes, and a k3d job that can't fail differently from kubeconform is compliance theater at three minutes per PR.

The complete job, using [k3d](https://k3d.io/) (k3s in Docker; cluster-up in ~30 s on `ubuntu-latest`):

```yaml
  install-test:
    runs-on: ubuntu-latest
    needs: [unit-tests, chart-tests]
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - name: Create cluster
        uses: AbsaOSS/k3d-action@v2
        with:
          cluster-name: ci
          args: --agents 0 --wait

      - name: Build candidate image
        run: docker build -t orders-api:ci .

      - name: Import image into cluster        # no registry round-trip needed
        run: k3d image import orders-api:ci --cluster ci

      - name: Install chart
        run: |
          helm install orders-api charts/orders-api \
            --set image.repository=orders-api \
            --set image.tag=ci \
            --set image.pullPolicy=Never \
            --wait --timeout 3m

      - name: Verify rollout
        run: kubectl rollout status deploy/orders-api --timeout=120s

      - name: Smoke test through the Service
        run: |
          kubectl port-forward svc/orders-api 8080:80 &
          sleep 3
          curl --fail --silent http://localhost:8080/actuator/health | tee /dev/stderr \
            | grep -q '"status":"UP"'

      - name: Run helm test hooks
        run: helm test orders-api --logs

      - name: Dump diagnostics
        if: failure()
        run: |
          mkdir -p diag
          kubectl get events --sort-by=.lastTimestamp > diag/events.txt
          kubectl get all -o wide                      > diag/resources.txt
          kubectl describe pods                        > diag/describe.txt
          kubectl logs -l app.kubernetes.io/name=orders-api --tail=-1 --prefix \
            > diag/logs.txt 2>&1 || true
      - name: Upload diagnostics
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: k3d-diagnostics
          path: diag/
```

Points that separate a useful job from a flaky one:

- `k3d image import` sidesteps pushing the candidate image to Artifactory just to pull it back; `pullPolicy=Never` makes any accidental registry dependency fail loudly.
- `--wait` plus explicit `rollout status` means "installed" means *running*, not "objects accepted."
- `helm test` runs the chart's test hooks in-cluster — the same hooks described in [Lifecycle and Operations](/helm/lifecycle-and-operations/) — so chart consumers and CI exercise identical smoke checks.
- The diagnostics dump on failure is the whole difference between "k3d job red, re-run it" culture and actually fixing things. A red install test with no events/describe/logs artifact is a coin flip; with them it's a five-minute read.
- No teardown step: the runner is destroyed after the job. Ephemeral means ephemeral.

If the choreography feels familiar, it should — it's [Lab 1](/labs/lab-1-java-api/) and the [local development loop](/start/local-development/) with the human removed. That's a feature: when this job fails, you can reproduce it on your laptop with the same five commands.

:::note[Runner-minute math]
This job costs ~3 minutes. At 200 PR pushes/month that's 600 runner-minutes — trivial on free public-repo runners, ~$5/month on private-repo hosted runners, real money multiplied across 40 repos on larger runners. The math rarely says "never"; it says *gate it*: run rungs 1–4 on every push, run the k3d job on `pull_request` ready-for-review, merge queues, or paths-filtered to `charts/**` and `src/**` changes.
:::

## What CI doesn't test

Be explicit about this list, because an unwritten one becomes "we thought CI covered it":

- **Real ingress, DNS, and TLS** — your platform's ingress class and cert issuance don't exist in k3d (which ships Traefik, which is not your platform). Tested by the post-deploy smoke stage in CD against the dev environment ([CI/CD Pipeline Design](/operations/cicd-pipeline-design/)).
- **Storage classes and StatefulSet behavior** — k3d's `local-path` provisioner proves nothing about your platform's CSI. Tested in dev/staging.
- **NetworkPolicies** — they only mean what your CNI enforces; k3s's default CNI will not match the platform's. Tested where the platform team runs conformance, and in staging.
- **Load and soak tests** — a 2-vCPU shared runner produces performance numbers that are worse than useless because they look like data. Run these against a dedicated environment, off the PR path.
- **Anything requiring platform credentials** — if the test needs a real cluster's kubeconfig, it's a CD concern by this site's rule, full stop.

One paragraph on flaky tests, because every ladder grows them: a test that fails intermittently without a code change gets **quarantined the same day** — moved to a non-blocking job with an issue assigned — not retried indefinitely. Auto-retry-until-green (`re-run failed jobs` culture) converts your test suite from a signal into a slot machine, and it always starts with tolerating exactly one flaky test. Quarantine is honest: the test still runs, its failures are visible, and it can't hold merges hostage while it's sick.

## The assembled test stage

Putting the ladder into `ci.yml` (build/push jobs from [the build article](/ci/github-actions/) omitted):

```yaml
jobs:
  unit-tests:        # rung 1 — ~2 min
    ...
  chart-tests:       # rungs 2-4: lint, unittest, kubeconform, goldens — ~30 s
    ...
  install-test:      # rung 5 — ~3 min, gated
    needs: [unit-tests, chart-tests]
    if: github.event.pull_request.draft == false
    ...
```

```text
  unit-tests ──────┐
                   ├──▶ install-test ──▶ (build & push on merge)
  chart-tests ─────┘
```

`unit-tests` and `chart-tests` share no dependencies, so they run in parallel; wall clock for the PR is max(2 min, 30 s) + 3 min ≈ **5 minutes** — the target this site treats as the ceiling for PR feedback. When the suite outgrows it, the answer is moving work rightward on the trigger axis (merge queue, main, nightly), not deleting rungs. Everything after the merge — the environments where the untestable list above finally gets tested — is where [CI/CD Pipeline Design](/operations/cicd-pipeline-design/) picks up.
