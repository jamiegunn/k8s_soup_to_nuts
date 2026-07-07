---
title: Helm and Kustomize
description: Driving the two manifest machines you'll meet in a paved-road pipeline — Kustomize overlays and Helm charts, from the consumer and author seat.
sidebar:
  order: 9
---

Raw YAML works for one service in one environment. Add a second environment and you're copy-pasting files that differ by a replica count and an image tag; add a third and the copies drift apart silently until prod is running config nobody remembers writing. The ecosystem produced two mainstream answers: **templating** (Helm — generate YAML from templates plus values) and **patching** (Kustomize — take real YAML and layer modifications on top). Most orgs use one or both, and your CI/CD pipeline has already chosen. You don't get to relitigate the choice; you get to drive the machine you have, well.

This article is that driving manual. Kustomize first, because it ships inside kubectl and you already have it.

:::tip[There's a whole section on Helm]
This article is the survival guide for both tools. For the full Helm treatment — [chart anatomy](/helm/chart-anatomy/), [the template language](/helm/template-language/), [values and override precedence](/helm/values-and-overrides/), [authoring best practices](/helm/authoring-best-practices/), and [release lifecycle](/helm/lifecycle-and-operations/) — see the [Helm Deep Dive](/helm/overview/) section.
:::

## Kustomize: patching, not templating

Kustomize's core bet: the base manifests are **plain, valid YAML** you can read and apply as-is, and environments are expressed as patches on top. No `{{ }}` anywhere.

### base/overlays layout

```text
deploy/
├── base/
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   ├── service.yaml
│   └── configmap.yaml
└── overlays/
    ├── dev/
    │   ├── kustomization.yaml
    │   └── replicas-patch.yaml
    └── prod/
        ├── kustomization.yaml
        ├── replicas-patch.yaml
        └── resources-patch.yaml
```

The base `kustomization.yaml` is a manifest of manifests:

```yaml
# deploy/base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
  - configmap.yaml
```

A prod overlay references the base and stacks changes:

```yaml
# deploy/overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: payments-prod
resources:
  - ../../base
patches:
  - path: replicas-patch.yaml
  - path: resources-patch.yaml
images:
  - name: registry.example.com/payments/api
    newTag: "2026.07.03-a1b2c3d"
configMapGenerator:
  - name: payments-config
    behavior: replace
    files:
      - config.yaml
```

Render it without touching the cluster:

```bash
kubectl kustomize deploy/overlays/prod | less
# apply is the same path:
kubectl apply -k deploy/overlays/prod
```

### Strategic-merge vs JSON6902 patches

A **strategic-merge patch** is a partial object; Kustomize merges it into the target using the same schema-aware logic as `kubectl apply` (lists of containers merge by `name`, etc.):

```yaml
# replicas-patch.yaml — strategic merge
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
spec:
  replicas: 6
  template:
    spec:
      containers:
        - name: api          # matched by name, fields merged in
          resources:
            requests:
              memory: 1Gi
```

A **JSON6902 patch** is a list of surgical operations against paths:

```yaml
patches:
  - target:
      kind: Deployment
      name: payments-api
    patch: |-
      - op: remove
        path: /spec/template/spec/containers/0/livenessProbe
      - op: replace
        path: /spec/template/spec/tolerations/0/value
        value: spot
```

When to use which: **strategic merge for 90% of cases** — it's readable and survives reordering. Reach for JSON6902 when you need to *remove* a field (strategic merge can only do that with `$patch: delete` directives, which are uglier), patch by list *index* in lists that don't merge by key, or target a [CRD](/controllers/crds-explained/) whose schema Kustomize doesn't know (strategic merge falls back to dumb replace-the-list behavior on unknown types — a classic "why did my other env var disappear" moment).

### configMapGenerator and the content hash

```yaml
configMapGenerator:
  - name: payments-config
    files:
      - config.yaml
secretGenerator:
  - name: payments-tls
    files:
      - tls.crt
      - tls.key
```

The generated object gets a **content-hash suffix**: `payments-config-7g2f9kb4tm`. Every reference to `payments-config` *within the same kustomization* is rewritten to the hashed name. Change `config.yaml`, and the hash changes, the Deployment's pod template changes, and you get an automatic rolling restart on config change — solving the "I updated the ConfigMap and nothing happened" problem covered in [Configuration](/workloads/configuration/) for free.

:::caution[The hash-rewrite gotcha]
Name rewriting only happens for resources **inside the kustomization build**. A CronJob in a different kustomization, an operator-managed resource, or anything referencing `payments-config` by literal name will point at a ConfigMap that no longer exists under that name. Symptoms: `CreateContainerConfigError`, `configmap "payments-config" not found`. Either pull the consumer into the same build, or disable the suffix for that generator with `options: {disableNameSuffixHash: true}` — and accept you're back to manual restarts.
:::

Also note old hashed ConfigMaps aren't garbage-collected by `apply -k` alone; they accumulate until something prunes them. Mildly annoying, occasionally confusing during debugging.

### The images transformer: how CI bumps tags

Your pipeline almost certainly does this on every build:

```bash
cd deploy/overlays/prod
kustomize edit set image registry.example.com/payments/api:2026.07.03-a1b2c3d
```

That rewrites the `images:` block in kustomization.yaml — a one-line, machine-safe diff, which is exactly why pipelines love it. If you're wondering where the tag in prod comes from, look there first, not in deployment.yaml (which probably says `:latest` or a placeholder in the base).

### namePrefix and commonLabels footguns

`namePrefix: prod-` renames every resource *and* rewrites references — mostly. It can miss references in CRDs and annotation strings it doesn't understand.

`commonLabels` is the sharper knife: it injects labels into `metadata.labels`, pod templates, **and selectors** — Deployment `spec.selector`, Service selectors. And `spec.selector` on a Deployment is **immutable**:

```console
$ kubectl apply -k deploy/overlays/prod
The Deployment "prod-payments-api" is invalid: spec.selector: Invalid value:
... field is immutable
```

Adding or changing `commonLabels` on an already-deployed app means delete-and-recreate the Deployment (an outage) or don't do it. Modern Kustomize offers `labels:` with `includeSelectors: false` — use that for anything you might ever want to change (team, cost-center, version-ish labels). Reserve selector-affecting labels for day one. See [YAML, Labels, and Namespaces](/start/yaml-labels-and-namespaces/) for why selectors are forever.

### The build-and-diff debugging workflow

Never debug an overlay by applying it. Render, then diff:

```bash
# What does prod actually render to?
kubectl kustomize deploy/overlays/prod > /tmp/prod.yaml

# How does it differ from what's live?
kubectl kustomize deploy/overlays/prod | kubectl diff -f -

# How does prod differ from dev?
diff <(kubectl kustomize deploy/overlays/dev) <(kubectl kustomize deploy/overlays/prod)
```

"Works in dev overlay, broken in prod" is almost always visible in that last diff: a patch that targets a name the prod overlay changed, a generator with different `behavior:`, a JSON6902 index that's off because prod adds a sidecar.

## Helm: two seats, different games

You'll meet Helm from two seats: consuming charts someone else wrote (Postgres, ingress-nginx, your platform team's internal chart) and authoring a small chart of your own. The skills barely overlap.

### Seat one: consuming a chart

A chart is a template package; **values** are your inputs. Job one is discovering what knobs exist:

```bash
helm show values bitnami/postgresql > default-values.yaml   # all knobs, with defaults
helm show readme bitnami/postgresql | less
```

Keep one values file per environment, containing *only* your deviations from defaults:

```yaml
# values-prod.yaml
primary:
  resources:
    requests:
      memory: 2Gi
  persistence:
    size: 100Gi
auth:
  existingSecret: pg-credentials   # see /workloads/secrets/
```

Before anything touches the cluster, render and diff — this is the single most valuable Helm habit:

```bash
helm template payments-db bitnami/postgresql -f values-prod.yaml \
  --namespace payments-prod | kubectl diff -f -
```

:::danger[Values not in the chart are silently ignored]
Helm does not validate that your values keys exist in the chart. Typo `resource:` for `resources:`, or nest a key one level too shallow, and Helm renders happily with the default — no warning, no error. Your prod database quietly runs with 256Mi requests. Defense: `helm template ... | grep -A3 resources:` after every values change, and prefer charts that ship a `values.schema.json` (then Helm *will* reject unknown/invalid keys). This trap has bitten every team exactly once, expensively.
:::

**Upgrades and rollbacks.** Every `helm upgrade` creates a numbered release revision stored in a Secret in the namespace:

```console
$ helm history payments-db
REVISION  UPDATED                   STATUS      CHART               DESCRIPTION
7         Thu Jul  2 14:11:02 2026  superseded  postgresql-15.5.20  Upgrade complete
8         Fri Jul  3 09:30:41 2026  deployed    postgresql-16.0.1   Upgrade complete

$ helm rollback payments-db 7
```

`helm rollback` re-applies revision 7's rendered manifests as a *new* revision 9 — it does not touch data, PVCs, or anything the chart's hooks created outside Helm's tracking. For plain Deployments, [rollouts and rollbacks](/workloads/rollouts-and-rollbacks/) semantics still apply underneath.

**Chart version bumps are code changes.** A chart upgrade can rename resources, change defaults, or restructure the values schema entirely. Read the chart's CHANGELOG/upgrade notes before bumping — major versions of popular charts routinely require values migration, and "same values file, new chart version" is how you discover a key was renamed and silently ignored (see above).

### Seat two: authoring a small internal chart

```text
charts/payments-api/
├── Chart.yaml
├── values.yaml            # sane defaults = the documentation
├── values.schema.json     # reject typos at install time
└── templates/
    ├── _helpers.tpl
    ├── deployment.yaml
    ├── service.yaml
    └── configmap.yaml
```

Keep helpers boring:

```yaml
{{/* _helpers.tpl */}}
{{- define "payments-api.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
```

And templates close to real YAML:

```yaml
# templates/deployment.yaml (excerpt)
spec:
  replicas: {{ .Values.replicaCount }}
  template:
    spec:
      containers:
        - name: api
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
```

The cardinal rule of chart authoring: **avoid logic soup**. One level of `if`, `toYaml`-passthrough blocks for resources/affinity/tolerations, `range` over a simple list at most. If you find yourself writing loops of loops, `tpl` calls rendering values as templates, or conditionals three levels deep — you didn't want Helm's templating, you wanted Kustomize overlays or a real generator program emitting YAML. Charts that grow logic soup become unreviewable, and unreviewable manifests are how surprises reach prod.

## Honest comparison, and why it's often "both"

| | Kustomize | Helm |
|---|---|---|
| Model | Patch real YAML | Template + values |
| Ships with kubectl | Yes (`-k`) | No, separate binary |
| Base is valid YAML you can apply | Yes | No (templates aren't YAML) |
| Third-party software distribution | Weak | The de-facto standard |
| Per-env variation | Excellent (overlays) | Good (values files) |
| Input validation | None | values.schema.json (if the author bothered) |
| Rollback/release tracking | None (git is your history) | Built in (`helm history`/`rollback`) |
| Failure mode at scale | Patch spaghetti across overlays | Logic soup in templates |

They compose. The standard pattern for "we consume a vendor chart but need one change the chart doesn't expose" is Helm's **post-renderer**: Helm renders, then pipes the manifests through your command before applying.

```bash
# kustomize-post-render.sh — helm feeds rendered manifests on stdin
#!/usr/bin/env bash
cat > post-render/all.yaml
kustomize build post-render
```

```yaml
# post-render/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - all.yaml
patches:
  - path: add-toleration.yaml   # the thing the chart never exposed
```

```bash
helm upgrade payments-db bitnami/postgresql -f values-prod.yaml \
  --post-renderer ./kustomize-post-render.sh
```

Argo CD and Flux both support Helm-plus-Kustomize natively — if your platform runs GitOps, ask before rolling your own (see [GitOps for tenants](/operations/gitops-for-tenants/)).

## Live edits, drift, and secrets

Both tools change what happens to your emergency `kubectl edit`. Short version — the full story is in [Drift and CI/CD](/operations/drift-and-cicd/):

- **Helm upgrade** does a three-way merge (previous rendered manifest, live object, new rendered manifest). Live edits to fields the chart doesn't render can survive an upgrade; edits to rendered fields get clobbered. `helm upgrade` also *won't run at all* if a previous release is stuck in `pending-upgrade` — a wedged state you fix with `helm rollback`.
- **`kubectl apply -k`** behaves exactly like plain apply: three-way merge against last-applied. Your live edit to a Kustomize-managed field dies on the next pipeline run.

**Secrets**: `secretGenerator` puts secret material in your repo unless you feed it from files excluded from git — usually the wrong tool for real secrets. Helm values files with passwords in them get committed by someone, eventually. Prefer `existingSecret`-style chart values pointing at a Secret managed by External Secrets or SOPS, per [Secrets](/workloads/secrets/).

## Debugging rendered-manifest problems

The mental split: is the problem in **rendering** (wrong YAML produced) or in **applying** (right YAML, cluster rejected or reconciled it away)? Render-side tools:

```bash
# Helm: what did the release actually apply, with what inputs?
helm get manifest payments-db | less
helm get values payments-db            # only your overrides
helm get values payments-db --all      # merged with chart defaults
helm template ... --debug              # renders even semi-broken templates

# Kustomize: render and inspect
kubectl kustomize deploy/overlays/prod | grep -n -A5 'kind: Deployment'
```

For "works in dev, broken in prod": diff the *rendered outputs*, not the sources. Two overlays or two values files can look nearly identical while rendering wildly different manifests (a patch whose target selector matches in one env only, a values key that's defaulted in one file). `diff <(render dev) <(render prod)` turns an hour of squinting into thirty seconds of reading. If rendering is clean and the cluster still misbehaves, you've left this article's territory — start at [triage methodology](/troubleshooting/triage-methodology/).
