---
title: "Lab 7: The CI Pipeline, Run Locally"
description: Run the CI section's whole testing ladder on your laptop — unit tests in a Maven container, a values schema, helm-unittest, kubeconform, golden diffs, and an install test on your own k3s — then wire it into one ci-local.sh.
keywords:
  - run a ci pipeline locally without github
  - helm chart unit tests with helm-unittest
  - validate rendered manifests with kubeconform
  - values.schema.json catches value typos
  - golden file diff for helm templates
  - install test in a throwaway namespace
  - write a ci-local.sh script
  - the testing ladder on your laptop
  - run maven tests in a container
sidebar:
  order: 9
---

The [CI section](/ci/testing-in-ci/) of this site describes a testing ladder that runs on GitHub Actions runners. Here's the honest framing this lab is built on: **the runner is not the pipeline.** What makes CI trustworthy is the commands and their order, and every one of them runs on your laptop. No GitHub account, no YAML workflows, no waiting for a queue — you'll climb the same ladder by hand, rung by rung, using the same tools CI uses (mostly via Docker images, keeping these labs' no-local-toolchain rule intact), and finish by wiring it all into one script.

**What you'll have at the end:** a unit test suite for `orders-api` runnable in a Maven container, a `values.schema.json` that turns value typos into loud errors, a helm-unittest suite asserting your chart's wiring, kubeconform validating rendered manifests against your cluster's real version, a golden-file diff you've watched fail and deliberately updated, one full install-and-smoke cycle in a throwaway namespace on your own k3s — and `ci-local.sh`, the lab's artifact, which runs the whole ladder in one command.

## Prerequisites

- [Lab 0](/labs/lab-0-cluster/) through [Lab 4](/labs/lab-4-ingress-end-to-end/) completed: both Lima VMs, the `orders` and `cache` releases in `labs`, and the chart at `~/k8s-labs/charts/orders-api` with the ingress toggle from Lab 4. ([Lab 6](/labs/lab-6-observability/) is optional; two asides below note where it changes an output.)
- If you paused between sittings, revive everything:

```bash
limactl start docker && limactl start k3s
export DOCKER_HOST="unix://$HOME/.lima/docker/sock/docker.sock"
export KUBECONFIG="$HOME/.lima/k3s/copied-from-guest/kubeconfig.yaml"
kubectl get nodes
```

All commands run from `~/k8s-labs/`, with `kubectl` defaulting to the `labs` namespace.

## 1. Rung 1: app unit tests — in a container, like everything else

The app has no tests yet; CI with nothing to run is theater. First give it one honest test. Add the test starter to `app/pom.xml`, next to the existing dependencies (it brings JUnit 5, Mockito, and AssertJ, all version-managed by the Boot parent):

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-test</artifactId>
    <scope>test</scope>
</dependency>
```

New file `app/src/test/java/com/example/orders/OrderControllerTest.java` (the same `com.example.orders` package the app has used since Lab 1). It tests the controller as a plain object — no Spring context, no Redis, just a mock that always misses:

```java
package com.example.orders;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;

class OrderControllerTest {

    private OrderController controllerWithEmptyCache() {
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        @SuppressWarnings("unchecked")
        ValueOperations<String, String> ops = mock(ValueOperations.class);
        when(redis.opsForValue()).thenReturn(ops);   // ops.get(...) returns null: a cache miss
        return new OrderController(redis);
    }

    @Test
    void knownOrderIsServedLiveOnACacheMiss() {
        var response = controllerWithEmptyCache().byId("1001");
        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getBody())
            .containsEntry("item", "3x espresso beans")
            .containsEntry("source", "live");
    }

    @Test
    void unknownOrderIs404() {
        assertThat(controllerWithEmptyCache().byId("9999").getStatusCode().value()).isEqualTo(404);
    }
}
```

Now run it — and since these labs install no Java toolchain, the JDK and Maven arrive the same way they did in Lab 1's Dockerfile, as an image. The second volume mount persists Maven's dependency cache between runs, which is exactly what `actions/setup-java`'s `cache: maven` does on a runner:

```bash
docker run --rm -v "$PWD/app":/src -v "$HOME/.m2-labs":/root/.m2 -w /src \
  maven:3.9-eclipse-temurin-21 mvn -q test
```

The first run spends several near-silent minutes downloading Maven's world into `~/.m2-labs` (drop the `-q` if you want proof of life); the second takes seconds. And on success, `-q` prints *nothing* — silence is a pass, and the durable record is the report files, which is precisely why CI uploads them as artifacts instead of trusting scrollback:

```bash
cat app/target/surefire-reports/com.example.orders.OrderControllerTest.txt
```

```console
-------------------------------------------------------------------------------
Test set: com.example.orders.OrderControllerTest
-------------------------------------------------------------------------------
Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.412 s
```

Next to that `.txt` sits `TEST-*.xml` — the machine-readable version that CI's test-reporter actions parse into the checks UI ([Testing in CI](/ci/testing-in-ci/), rung 1). Same files, same layout; the runner adds nothing but upload steps.

:::note[Read-only file system?]
If Maven dies writing `target/`, your Lima `docker` VM mounted your home directory read-only. Fix once: `limactl edit docker`, set the `~` mount's `writable: true`, then `limactl stop docker && limactl start docker`. Image *builds* never noticed (the build context is copied, not mounted); bind mounts are the first thing that does.
:::

## 2. Rung 2: helm lint + a schema that bites

```bash
helm lint charts/orders-api --strict
```

```console
==> Linting charts/orders-api
1 chart(s) linted, 0 chart(s) failed
```

Two seconds, and worth exactly what it costs: lint failing means stop, lint passing means almost nothing — it checks that YAML parses and required fields exist, not that your values make sense. The static check that earns its keep is `values.schema.json`: once the chart ships one, **every** `helm lint`, `template`, `install`, and `upgrade` validates values against it, converting silent typos into loud failures ([Values and Overrides](/helm/values-and-overrides/) makes the full case).

New file `charts/orders-api/values.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "replicaCount": { "type": "integer", "minimum": 1 },
    "image": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "repository": { "type": "string" },
        "tag": { "type": "string" },
        "pullPolicy": { "enum": ["Always", "IfNotPresent", "Never"] }
      },
      "required": ["repository", "tag"]
    },
    "service": {
      "type": "object",
      "properties": { "port": { "type": "integer" } }
    },
    "managementPort": { "type": "integer" }
  },
  "required": ["image"]
}
```

Note what's deliberately *not* here: no `additionalProperties: false` at the root — the chart's other keys (`greeting`, `cache`, `ingress`, `probes`, and whatever Lab 6 added) pass through unmodeled, and umbrella charts injecting `global.*` wouldn't break. The strictness sits on the `image` leaf, where typos hurt most. Now prove it bites, twice:

```bash
helm lint charts/orders-api --strict --set replicaCount=two
```

```console
==> Linting charts/orders-api
[ERROR] templates/: values don't meet the specifications of the schema(s) in the following chart(s):
orders-api:
- replicaCount: Invalid type. Expected: integer, given: string

Error: 1 chart(s) linted, 1 chart(s) failed
```

```bash
helm template orders charts/orders-api --set image.pullpolicy=Never 2>&1 | tail -2
```

```console
orders-api:
- image: Additional property pullpolicy is not allowed
```

That second one is the important kill: before the schema, the lowercase `pullpolicy` would install *successfully*, render the default, and surface three days later as a mystery. Named error at render time beats silent default at runtime, every time.

## 3. Rung 3: chart unit tests with helm-unittest

[helm-unittest](https://github.com/helm-unittest/helm-unittest) renders templates with given values and asserts on the output — no cluster involved. It's normally a Helm plugin; true to this lab's rule, you'll run its Docker image instead. Tests live inside the chart, in `tests/`.

New file `charts/orders-api/tests/deployment_test.yaml`:

```yaml
suite: deployment
templates:
  - deployment.yaml

tests:
  - it: wires the image tag from values
    set:
      image.tag: "9.9.9"
    asserts:
      - equal:
          path: spec.template.spec.containers[0].image
          value: orders-api:9.9.9

  - it: points the probes at the actuator on the management port
    asserts:
      - equal:
          path: spec.template.spec.containers[0].readinessProbe.httpGet.path
          value: /actuator/health/readiness
      - equal:
          path: spec.template.spec.containers[0].readinessProbe.httpGet.port
          value: management
      - equal:
          path: spec.template.spec.containers[0].livenessProbe.httpGet.path
          value: /actuator/health/liveness
```

Notice the altitude: these assert the chart's **public API** — "when a consumer sets `image.tag`, it lands in the container image" and "the probes point where Lab 1 promised" — not "the Deployment has a spec" (Helm's job). Values wiring is what template refactors actually break, which is why [Authoring Best Practices](/helm/authoring-best-practices/) puts these tests in every chart's pyramid. Run the suite, mounting `~/k8s-labs` at the image's working directory:

```bash
docker run --rm -v "$PWD":/apps helmunittest/helm-unittest charts/orders-api
```

```console
### Chart [ orders-api ] charts/orders-api

 PASS  deployment	charts/orders-api/tests/deployment_test.yaml

Charts:      1 passed, 1 total
Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
Snapshot:    0 passed, 0 total
Time:        98.2ms
```

Under 100 ms for the suite — the cheapest regression net in this whole lab. (The image bundles a pinned Helm plus the plugin; in real CI you'd pin its tag — they're named `<helm-version>-<plugin-version>` — rather than ride latest.) Sanity-check that the tests can fail: change `9.9.9` to `9.9.8` in the `value:` line, rerun, watch the diff-style failure, change it back.

## 4. Rung 4: kubeconform on the rendered output

helm-unittest checks the paths you asserted; [kubeconform](https://github.com/yannh/kubeconform) checks that *everything* the chart renders is a schema-valid Kubernetes object — offline, against a pinned API version. Pin the Kubernetes version to what your cluster actually runs (`kubectl get nodes` said `v1.31.x`) — and pin the image tag too, per the labs' standing rule (`latest-alpine` exists, and `latest` is how surprises ship):

```bash
helm template orders charts/orders-api \
  | docker run -i --rm ghcr.io/yannh/kubeconform:v0.6.7-alpine \
      -strict -summary -kubernetes-version 1.31.0
```

```console
Summary: 5 resources found parsing stdin - Valid: 5, Invalid: 0, Errors: 0, Skipped: 0
```

Five resources: the Deployment, Service, ConfigMap, Secret, and Ingress your chart has accumulated since Lab 1. The quiet superpower is the version flag: in CI this runs in a loop over your platform's *current and next* Kubernetes versions, so the day your chart renders an API that the next version removes, this rung fails months before the cluster upgrade would have — the automated [API deprecations](/operations/api-deprecations/) gate.

:::note[Did Lab 6? One resource is a stranger here]
With `metrics.enabled: true` the render includes a ServiceMonitor, and kubeconform errors on it: `could not find schema for ServiceMonitor`. [CRDs](/controllers/crds-explained/) aren't core APIs — no CRD, no schema. Either add the community catalog (`-schema-location default -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceVersion}}.json'`) for `Valid: 6`, or pass `-ignore-missing-schemas` and record that you chose blindness for that one kind — the same trade-off [Testing in CI](/ci/testing-in-ci/) spells out.
:::

## 5. Rung 4½: the golden-file diff

The cheapest high-signal chart test there is: render against fixed values, commit the result, diff on every change. Cut the first golden:

```bash
mkdir -p golden
helm template orders charts/orders-api > golden/default.yaml
helm template orders charts/orders-api | diff -u golden/default.yaml - && echo "golden: clean"
```

```console
golden: clean
```

Now cause the kind of drift this exists to catch. In `charts/orders-api/templates/_helpers.tpl`, add one line to the `orders-api.labels` block — a perfectly reasonable-looking improvement:

```yaml
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
```

```bash
helm template orders charts/orders-api | diff -u golden/default.yaml -
```

```console
--- golden/default.yaml
+++ -
@@ -8,6 +8,7 @@
   labels:
     helm.sh/chart: orders-api-0.1.0
     app.kubernetes.io/managed-by: Helm
+    app.kubernetes.io/version: "0.1.0"
     app.kubernetes.io/name: orders-api
     app.kubernetes.io/instance: orders
```

The diff fails — and that's it doing its job. Read what it says: the label appears in the Deployment and Service **metadata**, and *not* in the Deployment's `selector` — because Lab 1 split `selectorLabels` from `labels` for exactly this day. Had you added the line to `selectorLabels` instead, this diff would be showing you a change to an **immutable** field that breaks the next `helm upgrade` — caught here, in text, for free.

The change is intentional, so perform the ritual — and the ritual is the whole tool: *read the diff, then* update:

```bash
helm template orders charts/orders-api > golden/default.yaml
```

In CI this pair is `check-goldens.sh` and `update-goldens.sh`, and the regenerated golden lands in the PR diff so reviewers review *manifests*, not template code ([Testing in CI](/ci/testing-in-ci/), rung 4). Goldens rot the moment "regenerate and commit" becomes reflex instead of a conscious act — same failure mode as snapshot tests, same cure.

## 6. Rung 5: the install test — on the cluster you already have

CI's top rung installs the chart on an **ephemeral k3d cluster** created and destroyed inside the job, because a shared runner gets no network path to real clusters. You have something better sitting right here: a real k3s. Same move, different isolation — a throwaway *namespace* instead of a throwaway *cluster*:

```bash
kubectl create namespace ci-test
kubectl create secret generic cache-auth -n ci-test --from-literal=password=ci-test-pw
helm install cache-ci charts/valkey -n ci-test --wait --timeout 2m
helm install orders-ci charts/orders-api -n ci-test \
  --set ingress.enabled=false --wait --timeout 2m
```

```console
namespace/ci-test created
secret/cache-auth created
NAME: cache-ci
STATUS: deployed
NAME: orders-ci
STATUS: deployed
```

Three deliberate choices in those four lines. The **secret first**: your chart consumes `cache-auth` but doesn't create it — a hand-made dependency from Lab 3 that render-level rungs can never see, and the install rung surfaces instantly (skip it and the pods sit in `CreateContainerConfigError`; that discovery is this rung's entire value). The **cache too**: `orders-api`'s initContainer gates on `cache-valkey` answering, so a hermetic install needs the whole dependency closure — which is why CI installs *everything* the app needs, from the same charts. And **`ingress.enabled=false`**: the edge isn't under test (it's on [Testing in CI](/ci/testing-in-ci/)'s explicit can't-test list), and a second Ingress claiming `orders.localtest.me` would fight the real one in `labs`.

`--wait` already proved the probes pass; now smoke it like CI would:

```bash
kubectl port-forward -n ci-test svc/orders-api 8088:8080 >/dev/null & PF_PID=$!
sleep 2
curl -s http://localhost:8088/api/orders/1001
curl -s http://localhost:8088/api/orders/1001
kill $PF_PID
```

```console
{"id":"1001","item":"3x espresso beans","source":"live"}
{"id":"1001","item":"3x espresso beans","source":"cache"}
```

`live` then `cache` — and that first `live` is quiet proof of isolation: this environment's Valkey started cold, untouched by the warm cache sitting in `labs`. Two complete copies of the system, one cluster, zero interference (the `fullnameOverride` collision Lab 1 warned about applies *within* a namespace; across namespaces, names are free). Then do what ephemeral means:

```bash
helm uninstall orders-ci cache-ci -n ci-test
kubectl delete namespace ci-test
```

:::note[Namespace vs cluster, honestly]
CI's k3d cluster is stronger isolation than your namespace: it also catches charts that depend on cluster-scoped leftovers (CRDs, priority classes) and starts from a genuinely empty world every run. The namespace version is the same *move* — install from scratch, wait, smoke, destroy — with one shortcut you should know you're taking. If you did Lab 6 and then deleted the monitoring CRDs, this install fails on the ServiceMonitor unless you add `--set metrics.enabled=false`; a k3d run would have failed the same way, which is rather the point.
:::

## 7. Wire it into one script: `ci-local.sh`

Every rung above is a command with an exit code, which means the pipeline is just a script. `~/k8s-labs/ci-local.sh` — the lab's artifact:

```bash
#!/usr/bin/env bash
# ci-local.sh — the CI testing ladder, runnable on this laptop.
# Same commands CI runs; only the runner is missing.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Rung 1: app unit tests"
docker run --rm -v "$PWD/app":/src -v "$HOME/.m2-labs":/root/.m2 -w /src \
  maven:3.9-eclipse-temurin-21 mvn -q test

echo "==> Rung 2: chart lint + values schema"
helm lint charts/orders-api --strict

echo "==> Rung 3: chart unit tests"
docker run --rm -v "$PWD":/apps helmunittest/helm-unittest charts/orders-api

echo "==> Rung 4: rendered-manifest validation"
helm template orders charts/orders-api \
  | docker run -i --rm ghcr.io/yannh/kubeconform:v0.6.7-alpine \
      -strict -summary -kubernetes-version 1.31.0

echo "==> Rung 4.5: golden diff"
helm template orders charts/orders-api | diff -u golden/default.yaml - \
  || { echo "Golden drifted. If intentional: helm template orders charts/orders-api > golden/default.yaml"; exit 1; }

echo "==> Rung 5: install test in namespace ci-test"
trap 'helm uninstall orders-ci cache-ci -n ci-test >/dev/null 2>&1 || true
      kubectl delete namespace ci-test --ignore-not-found >/dev/null' EXIT
kubectl create namespace ci-test
kubectl create secret generic cache-auth -n ci-test --from-literal=password=ci-test-pw
helm install cache-ci charts/valkey -n ci-test --wait --timeout 2m >/dev/null
helm install orders-ci charts/orders-api -n ci-test --set ingress.enabled=false \
  --wait --timeout 2m >/dev/null
kubectl port-forward -n ci-test svc/orders-api 8088:8080 >/dev/null & PF=$!
sleep 2
curl -sf http://localhost:8088/api/orders/1001 | grep -q '"item"'
kill "$PF"

echo "ALL GREEN"
```

`set -euo pipefail` is what turns a list of commands into a pipeline: any rung failing stops the run with a nonzero exit, exactly as a red job stops a workflow — and the `trap` is the CI cleanup step that runs even when a middle rung dies, so a failed run never leaves `ci-test` behind. Make it real:

```bash
chmod +x ci-local.sh && ./ci-local.sh
```

```console
==> Rung 1: app unit tests
==> Rung 2: chart lint + values schema
==> Linting charts/orders-api
1 chart(s) linted, 0 chart(s) failed
==> Rung 3: chart unit tests
Tests:       2 passed, 2 total
==> Rung 4: rendered-manifest validation
Summary: 5 resources found parsing stdin - Valid: 5, Invalid: 0, Errors: 0, Skipped: 0
==> Rung 4.5: golden diff
==> Rung 5: install test in namespace ci-test
ALL GREEN
```

Two to four minutes end to end, most of it rung 5 — the same wall-clock shape as the real pipeline, for the same reason. Run it before you'd open a PR; that's the habit the whole lab is smuggling in.

## 8. The map back to real CI

One table, from what your fingers just did to where the same command lives in the CI section:

| You ran | CI runs | Where it's specified |
|---|---|---|
| `docker run maven ... mvn test` + read surefire | `unit-tests` job: `setup-java` (cached), `mvn -B test`, report upload with `if: always()` | [Testing in CI](/ci/testing-in-ci/) rung 1, [The Build Job](/ci/github-actions/) |
| `helm lint --strict` + schema errors | first steps of the `chart-tests` job | [Testing in CI](/ci/testing-in-ci/) rung 2 |
| helm-unittest in Docker | `helm plugin install` + `helm unittest` in `chart-tests` | [Testing in CI](/ci/testing-in-ci/) rung 3 |
| `helm template \| kubeconform` | same pipe, looped over pinned cluster versions | [Testing in CI](/ci/testing-in-ci/) rung 4 |
| golden render + `diff -u` + conscious update | `check-goldens.sh` / `update-goldens.sh`, diff reviewed in the PR | [Testing in CI](/ci/testing-in-ci/) rung 4 |
| namespace install + smoke + teardown | `install-test` job on ephemeral k3d, gated to ready-for-review | [Testing in CI](/ci/testing-in-ci/) rung 5 |
| `ci-local.sh` | the assembled workflow — and, at org scale, the shared workflow every repo calls | [The Build Job](/ci/github-actions/), [Reusable Workflows](/ci/reusable-workflows/) |

The last row is the one that changes how your first week at a new job feels. An org's "golden workflow" — the [reusable workflow](/ci/reusable-workflows/) forty repos invoke with six lines of YAML — looks intimidating precisely because it's all plumbing: triggers, permissions, caches, matrices, secrets. Strip the plumbing and what remains is this script. When you read that workflow, you've already run every stage by hand.

## Troubleshooting

:::caution[When output doesn't match]
**Rung 1 dies with `Read-only file system`** — the Lima `docker` VM's home mount isn't writable; see the aside in step 1.

**Rung 1 re-downloads everything each run** — the `~/.m2-labs` mount is missing or misspelled in your command. The cache directory is the whole difference between 4 minutes and 20 seconds.

**helm-unittest: `chart not found` or an empty run** — the mount and the path must agree: `-v "$PWD":/apps` mounts `~/k8s-labs`, so the argument is the relative path `charts/orders-api`. Run from `~/k8s-labs`, not from inside the chart.

**kubeconform: `could not find schema for ServiceMonitor`** — Lab 6's CRD in the render; the aside in step 4 has both fixes.

**Install test wedges at `--wait`** — go look, don't guess: `kubectl get pods -n ci-test`. `CreateContainerConfigError` means the `cache-auth` secret step was skipped; `Init:0/1` forever means the cache release isn't up (did `cache-ci` install?); `ImagePullBackOff` means the image tag in `values.yaml` was never imported into k3s — Lab 1's pipe, still not optional.

**`bind: address already in use` on 8088** — a stale port-forward from an earlier attempt: `pkill -f "port-forward.*8088"`.

**The script passed but left `ci-test` behind** — you ran the steps by hand and interrupted them; the trap only guards the script. `helm uninstall orders-ci cache-ci -n ci-test; kubectl delete ns ci-test`.
:::

## Where you are now

On disk, `~/k8s-labs` now holds a tested system, not just a running one: an app with a unit suite, a chart with a schema, a test suite, and a golden rendering, plus `ci-local.sh` tying every rung together — run it any time you touch the app or the chart. Nothing new is left running in the cluster; `ci-test` came and went, which was its job.

You've now done by hand everything a CI pipeline would do to this codebase, in the order it would do it, with the same commands. The reference threads that pick up from here: [Testing in CI](/ci/testing-in-ci/) for the ladder's full reasoning (including the rungs' *can't-catch* columns, which matter more than what they catch), [The Build Job](/ci/github-actions/) for the plumbing that wraps these commands in triggers and caches, and [Reusable Workflows](/ci/reusable-workflows/) for how one team's version of `ci-local.sh` becomes forty repos' pipeline. The commands won't need learning twice — that was the deal.
