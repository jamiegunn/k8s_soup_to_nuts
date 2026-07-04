---
title: Authoring Best Practices
description: Principled rules for charts that survive their consumers — render determinism, stable labels, checksum rollouts, passthrough specs, loud failures, tests, and docs.
sidebar:
  order: 5
---

A chart is easy to write and hard to write well. The difference shows up months later, in someone else's pipeline: the upgrade that diffs forever, the Service that can't find its pods after a "harmless" label rename, the toleration that couldn't be set without forking. This article is the author's discipline, as a set of rules — each with the wrong version, the right version, and the reason. It assumes the [chart anatomy](/helm/chart-anatomy/) and [template language](/helm/template-language/) articles, and the values-API design half of [Values and Overrides](/helm/values-and-overrides/).

## Rule 1: Render deterministically

The same chart plus the same values must render the same manifests, byte for byte, every time. Anything else fights every diff-based tool you'll ever use — `helm diff`, CI golden files, and above all GitOps controllers, which reconcile by comparing rendered output ([GitOps for Tenants](/operations/gitops-for-tenants/)).

**Wrong** — a fresh password on every render:

```yaml
# templates/secret.yaml — regenerates on EVERY upgrade
stringData:
  password: {{ randAlphaNum 24 }}
```

Every `helm upgrade` rotates the password whether you wanted it or not; under Argo CD the app is *permanently* OutOfSync, and auto-sync rotates it continuously until something breaks. **Right** — look up the existing value, generate only on true first install, or demand it:

```yaml
# templates/secret.yaml — stable across renders
{{- $existing := lookup "v1" "Secret" .Release.Namespace (printf "%s-db" (include "web-service.fullname" .)) }}
stringData:
  password: {{ ($existing.data.password | b64dec) | default (randAlphaNum 24) | quote }}
```

Better still for most orgs: don't generate secrets in templates at all — `required "set auth.existingSecret" .Values.auth.existingSecret` and let [external secret machinery](/workloads/secrets/) own the material. Note `lookup` returns empty under `helm template` (no cluster), so charts relying on it need the `required` fallback for template-only pipelines.

The same rule bans `now` / timestamps in labels and annotations — with one deliberate exception: an explicit, consumer-triggered restart knob (`rollme: {{ .Values.forceRestart }}`) or the config checksum in Rule 3, both of which change only when something *meant* to change.

## Rule 2: Standard labels via helpers — and never touch selectorLabels

**Wrong** — labels written inline per template, with the version in the selector:

```yaml
# templates/deployment.yaml — three mistakes in eight lines
spec:
  selector:
    matchLabels:
      app: web-service
      version: {{ .Chart.AppVersion }}    # changes every release → immutable-field error
  template:
    metadata:
      labels:
        app: web-service                  # ad-hoc key, duplicated in service.yaml by hand
```

**Right** — ship the `app.kubernetes.io/*` set through two helpers with different stability contracts:

```yaml
# templates/_helpers.tpl
{{- define "web-service.selectorLabels" -}}
app.kubernetes.io/name: {{ include "web-service.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "web-service.labels" -}}
helm.sh/chart: {{ include "web-service.chart" . }}
{{ include "web-service.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
```

`labels` (the full set, including the version) goes on **metadata** of everything. `selectorLabels` (the stable subset) goes on the Deployment's `spec.selector.matchLabels`, the pod template, and the Service selector — and **never changes for the life of the chart**. `spec.selector` on a Deployment is immutable; add `app.kubernetes.io/version` to it (wrong: it changes every release) and the next upgrade fails with `field is immutable`, forcing a delete-and-recreate. See [labels and selectors](/start/yaml-labels-and-namespaces/) for the underlying mechanics.

## Rule 3: Checksums for config rollouts

A ConfigMap change alone does not restart pods: the kubelet updates mounted files eventually, env vars never, and most apps read config once at startup ([Configuration](/workloads/configuration/) has the full behavior matrix). **Wrong** — ship the ConfigMap change and hope, or worse, tell consumers to `kubectl rollout restart` by hand after every values change. **Right** — hash the rendered ConfigMap into a pod-template annotation, so config changes change the pod template and trigger a rollout automatically:

```yaml
# templates/deployment.yaml
spec:
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
```

This re-renders `templates/configmap.yaml` and hashes the output — deterministic (Rule 1 compliant: it changes exactly when the config changes), and it works identically under GitOps. Full treatment of config-change rollout behavior in [Configuration](/workloads/configuration/). One checksum annotation per config source; hashing all templates together makes every chart tweak a restart.

## Rule 4: Don't re-model the pod spec

**Wrong** — inventing your own resource knobs:

```yaml
# values.yaml — the chart that couldn't set a toleration
cpuRequest: 100m
memoryLimit: 256Mi
dedicatedNodes: false     # sets ONE hardcoded toleration if true
```

This chart shipped, and a year later a consumer needed a second toleration for a GPU pool. The values API had no slot for it. They forked the chart, the fork drifted, and the platform team inherited both. **Right** — passthrough blocks, verbatim:

```yaml
# values.yaml
resources: {}
nodeSelector: {}
tolerations: []
affinity: {}
podSecurityContext: {}
securityContext: {}
```

```yaml
# templates/deployment.yaml
      {{- with .Values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
```

Consumers write exactly what the Kubernetes API takes (see [Resources and QoS](/workloads/resources-and-qos/)); your chart never lags the pod spec. And ship the escape hatches as standard equipment — `extraEnv`, `extraEnvFrom`, `extraVolumes`, `extraVolumeMounts`, `extraContainers` — each a verbatim `toYaml` append. They're the difference between "add three values lines" and "fork the chart" when someone needs a logging sidecar.

## Rule 5: Limit the logic soup

**Wrong** — the shape that appears in every aging internal chart eventually:

```yaml
{{- range $region := .Values.regions }}
{{- range $tier := $region.tiers }}
{{- if or (and $tier.enabled (not $region.legacy)) (eq (tpl $tier.nameTemplate $) "canary") }}
# ... 40 lines emitting a Deployment per region-tier, with tpl-rendered
# annotations whose VALUES contain more template syntax ...
{{- end }}
{{- end }}
{{- end }}
```

Nobody can predict what this renders without running it, `helm lint` is happy with all of it, and the bug reports arrive as "prod-eu-canary got the staging config." If your template needs loops inside loops, `tpl` calls evaluating strings that contain more template syntax, or a helper that takes a dict of dicts to decide which of four YAML shapes to emit — stop and reconsider. Helm is a text templater, not a programming language; past a modest complexity threshold every added conditional multiplies the untested render paths.

The honest alternatives, in order of preference: **generate values upstream** (a 20-line script in CI producing a plain values file beats 200 lines of template cleverness — [CI/CD Pipeline Design](/operations/cicd-pipeline-design/)); **accept two charts** (if `web-service` and `web-worker` share 60% of a template riddled with `if .Values.isWorker`, they're two charts, possibly sharing a library — Rule 11); or **post-render with Kustomize** for the environment-specific surgery that doesn't belong in the chart at all ([Helm and Kustomize](/operations/helm-and-kustomize/) covers `helm template | kustomize`).

## Rule 6: Fail loud and early

A chart that renders something wrong is worse than a chart that refuses to render. The toolkit, cheapest first:

```yaml
# required — with a message that tells the reader what to DO
host: {{ required "ingress.hosts[0] is required when ingress.enabled=true — set it in your environment values file" (first .Values.ingress.hosts) }}

# fail — for invalid combinations no single 'required' can express
{{- if and .Values.autoscaling.enabled (gt (int .Values.replicaCount) 1) }}
{{- fail "set either autoscaling.enabled or replicaCount, not both — the HPA will fight the fixed count" }}
{{- end }}
```

Plus `values.schema.json` for types, enums, and typo rejection before templates even run ([Values and Overrides](/helm/values-and-overrides/) has the full example). And for API versions, gate on the cluster instead of silently emitting the wrong thing:

```yaml
{{- if .Capabilities.APIVersions.Has "autoscaling/v2" }}
apiVersion: autoscaling/v2
{{- else }}
{{- fail "this chart requires autoscaling/v2 (Kubernetes >= 1.23)" }}
{{- end }}
```

`semverCompare ">=1.23-0" .Capabilities.KubeVersion.Version` is the sibling gate (the `-0` suffix matters — it makes pre-release cluster versions like `1.29.1-gke.100` match). A chart that emits `policy/v1beta1` on a modern cluster fails at apply time with a confusing error three tools downstream; a chart that `fail`s names the actual problem. Background in [API Deprecations](/operations/api-deprecations/).

:::caution[Capabilities under `helm template`]
Without a live cluster, `.Capabilities` reports Helm's defaults, not your cluster's reality. GitOps controllers and CI template steps hit this constantly — pass `--kube-version` and `--api-versions` explicitly in those pipelines, or your gates test the wrong cluster.
:::

## Rule 7: NOTES.txt that helps at 2am

`NOTES.txt` renders after every install/upgrade. Wrong: a paragraph of thanks and a wall of boilerplate. Right: how to reach the app and what to run next, computed from the actual values:

```yaml
# templates/NOTES.txt
{{ .Chart.Name }} {{ .Chart.Version }} deployed as {{ .Release.Name }}.

{{- if .Values.ingress.enabled }}
URL: https://{{ (first .Values.ingress.hosts) }}
{{- else }}
No ingress. Reach it with:
  kubectl -n {{ .Release.Namespace }} port-forward svc/{{ include "web-service.fullname" . }} 8080:{{ .Values.service.port }}
{{- end }}

Check rollout:  kubectl -n {{ .Release.Namespace }} rollout status deploy/{{ include "web-service.fullname" . }}
Smoke test:     helm test {{ .Release.Name }} -n {{ .Release.Namespace }}
```

## Rule 8: The chart testing pyramid

Four layers, cheap to expensive, all in CI:

1. **`helm lint`** — structure and template parse errors. Seconds, catches the least, still table stakes.
2. **`helm unittest`** (the community plugin) — assertion and snapshot tests for helpers and edge values, no cluster needed:

```yaml
# tests/deployment_test.yaml
suite: deployment
templates: [deployment.yaml]
tests:
  - it: renders tolerations verbatim
    set:
      tolerations:
        - key: dedicated
          operator: Equal
          value: gpu
          effect: NoSchedule
    asserts:
      - equal:
          path: spec.template.spec.tolerations[0].key
          value: dedicated
  - it: fails without image.repository
    set:
      image: {}
    asserts:
      - failedTemplate: {}
```

3. **Golden-file diffs** — `helm template` with each environment's values, diffed against committed expected output. Any rendered change appears in the PR diff, reviewable like code:

```bash
#!/usr/bin/env bash
# ci/golden.sh — regenerate with UPDATE=1 when a change is intentional
set -euo pipefail
for env in dev stage prod; do
  helm template web ./web-service -f "deploy/values-${env}.yaml" \
    --kube-version 1.30.0 > "/tmp/rendered-${env}.yaml"
  if [[ "${UPDATE:-}" == "1" ]]; then
    cp "/tmp/rendered-${env}.yaml" "tests/golden/${env}.yaml"
  else
    diff -u "tests/golden/${env}.yaml" "/tmp/rendered-${env}.yaml" \
      || { echo "rendered output changed for ${env} — review, then UPDATE=1 to accept"; exit 1; }
  fi
done
```

4. **A real install** — `kind` cluster in CI, `helm install --wait`, `helm test`, teardown. Slowest, and the only layer that catches "renders fine, doesn't run." Pipeline wiring in [CI/CD Pipeline Design](/operations/cicd-pipeline-design/).

## Rule 9: Docs and changelog discipline

Your values are an API ([Values and Overrides](/helm/values-and-overrides/)), so document them like one. Generate the README values table with `helm-docs` — it reads the comments already in `values.yaml`, so the table can't drift from the file:

```yaml
# values.yaml — helm-docs conventions
# -- Number of pod replicas. Ignored when autoscaling.enabled is true.
replicaCount: 1

image:
  # -- Image repository. Required — no default.
  repository: ""
  # -- Image tag. Defaults to the chart's appVersion.
  tag: ""
```

`helm-docs` turns those `# --` comments into the README table on every run; wire it as a pre-commit hook or a CI check that fails when the README is stale. Hand-maintained tables always drift; delete yours.

Keep a `CHANGELOG.md` per chart, and be honest about semver: new optional value = minor, renamed or reshaped value = **major**, with the migration written down. The consumer reading your changelog is deciding whether the upgrade is a five-minute bump or an afternoon; give them the answer in one line.

## Rule 10: Security defaults that survive review

- **Image by digest, as a passthrough**: support `image.digest`, render `{{ .Values.image.repository }}@{{ .Values.image.digest }}` when set, tag otherwise. CI resolves and pins the digest; the chart just carries it. Why digests: [Supply Chain Security](/operations/supply-chain-security/).
- **No secret material in committed values files** — accept `existingSecret` names and let [external mechanisms](/workloads/secrets/) own the bytes. Rule 1's `lookup` pattern covers the generate-once case.
- **`imagePullSecrets` plumbing** — the boring block every private-registry consumer needs:

```yaml
      {{- with .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
```

- **Restrictive `securityContext` defaults** in `values.yaml` (runAsNonRoot, no privilege escalation, dropped capabilities) — as *values*, so consumers can loosen them visibly rather than the chart hardcoding either extreme.

## Rule 11: Library charts, honestly

When five internal charts copy-paste the same `_helpers.tpl`, a **library chart** (`type: library` in `Chart.yaml`) centralizes the helpers — labels, fullname, checksum idiom, the passthrough blocks — and each app chart declares it as a dependency and `include`s its defines. It renders nothing itself; it only exports templates.

When it beats copy-paste: three-plus consuming charts, a platform team that owns the library, and helpers that genuinely must stay in lockstep (the label contract, org security defaults). The honest cost: **versioning**. Every library change ships to consumers only when each chart bumps its dependency, so you now maintain semver discipline on templates, and a breaking helper change fans out as coordinated PRs across every consumer. For two charts, copy-paste is cheaper and everyone knows it. If your org has a paved-road chart, this is how it's built — see the [golden service](/architectures/golden-service/) for what such a chart typically encodes.

## The ten rules

:::tip[The summary box]
1. **Render deterministically** — no `randAlphaNum`, no timestamps; `lookup`-or-`required` for secrets.
2. **Standard labels via helpers** — full `labels` on metadata, stable `selectorLabels` on selectors, and never change the latter.
3. **Checksum annotations** roll pods when config changes — and only then.
4. **Pass the pod spec through** — `resources`/`affinity`/`tolerations`/`securityContext` verbatim, plus `extra*` escape hatches.
5. **Cap the template logic** — generate values upstream or split the chart before writing loops-of-loops.
6. **Fail loud** — `required` with actionable messages, `fail` for bad combinations, schema for types, capability gates for API versions.
7. **NOTES.txt tells the 2am operator** how to reach the app and what to run next.
8. **Test the pyramid** — lint, unittest, golden diffs, kind install.
9. **Generate the docs, keep the changelog** — values are an API; version them like one.
10. **Secure by default, visibly overridable** — digests, existingSecret, imagePullSecrets, restrictive contexts in values.
:::

With the chart authored, the remaining question is what Helm actually *does* with it at install, upgrade, and rollback time — [Release Lifecycle and Operations](/helm/lifecycle-and-operations/) is that story.
