---
title: Values and Overrides
description: The precedence chain, merge semantics, --set traps, environment values-file architecture, and how to design a values API that survives its consumers.
keywords:
  - values precedence order
  - --set type coercion big number
  - lists replace maps deep-merge
  - helm get values -a
  - values.schema.json additionalproperties
  - null deletes default key
  - global subchart values plumbing
  - --set-string --set-json --set-file
  - silently ignored values typo
  - per-environment delta values files
  - escape dots in --set annotations
  - helm show values third-party chart
sidebar:
  order: 4
---

Values are the chart's **public API**. Everything a consumer can legitimately change about a release flows through them, and every mistake in how they're layered, merged, or typed shows up as a production diff nobody expected. If [the template language](/helm/template-language/) is the chart's implementation, values are its function signature — and like any API, they have precedence rules, type coercion traps, and versioning obligations. This article covers all of it, from both seats: consuming someone else's values API and designing your own.

We'll keep using the `web-service` chart from [Chart Anatomy](/helm/chart-anatomy/) throughout.

## The precedence chain

There are four layers, and each one beats everything before it:

1. The chart's own `values.yaml` (defaults, lowest priority)
2. A parent chart's overrides of a subchart (when the chart is a dependency)
3. `-f`/`--values` files, **in the order given on the command line** — later files win
4. `--set`, `--set-string`, `--set-file`, `--set-json` — last flag wins, and this layer beats all files

One worked example, one key, overridden at every layer. The `web-service` chart ships:

```yaml
# charts/web-service/values.yaml
replicaCount: 1
```

A parent umbrella chart that includes `web-service` as a dependency overrides it:

```yaml
# umbrella-chart/values.yaml
web-service:
  replicaCount: 2
```

Then the install command layers files and flags:

```bash
helm install shop ./umbrella-chart \
  -f values-base.yaml \        # web-service.replicaCount: 3
  -f values-prod.yaml \        # web-service.replicaCount: 4
  --set web-service.replicaCount=5
```

Result: `replicaCount` is **5**. Drop the `--set` and it's 4 (`values-prod.yaml`, the later `-f`). Drop that file and it's 3. Drop both files and it's 2 (parent override). Only a bare `helm install shop ./umbrella-chart` gives you the chart's own default of 1.

Verify what actually landed — this is the single most useful debugging command in this article:

```console
$ helm get values shop
USER-SUPPLIED VALUES:
web-service:
  replicaCount: 5
```

`helm get values` shows only what *you* supplied; add `-a`/`--all` to see the fully merged result including chart defaults. When prod is doing something weird, `helm get values -a` is forensics — see [Drift and CI/CD](/operations/drift-and-cicd/) for how release state and cluster state diverge.

## Merge semantics: maps deep-merge, lists replace

This is the number-one surprise in all of Helm, so it gets its own section.

**Maps deep-merge.** Overriding one key inside a map leaves its siblings intact:

```yaml
# chart default
image:
  repository: registry.internal/web-service
  tag: "1.4.2"
  pullPolicy: IfNotPresent
```

```yaml
# values-prod.yaml
image:
  tag: "1.5.0"
```

Merged result: `repository` and `pullPolicy` survive, only `tag` changes. This is what everyone expects.

**Lists replace wholesale.** There is no merging, appending, or index-matching. The chart defaults:

```yaml
# chart default
env:
  - name: LOG_LEVEL
    value: info
  - name: HTTP_PORT
    value: "8080"
  - name: CACHE_TTL
    value: "300"
```

You want to change just `LOG_LEVEL` in dev:

```yaml
# values-dev.yaml — WRONG expectation, correct behavior
env:
  - name: LOG_LEVEL
    value: debug
```

The rendered pod now has **one** environment variable. `HTTP_PORT` and `CACHE_TTL` are gone — the entire list was replaced by your one-element list. The app crashes on a missing port, and the error message says nothing about Helm.

:::danger[Lists replace, always]
Any list in values — `env`, `tolerations`, `ingress.hosts`, `extraVolumes` — is all-or-nothing. To override one element, you must restate the whole list. There is no `--set env[0].value=debug`-only-touches-index-0 safety net either: `--set` array indexing writes into a copy of *your supplied values*, not a merge with defaults.
:::

**The map-keyed workaround.** Chart authors can sidestep this by modeling collections as maps instead of lists, then converting in the template:

```yaml
# values.yaml — map keyed by variable name
env:
  LOG_LEVEL: info
  HTTP_PORT: "8080"
  CACHE_TTL: "300"
```

```yaml
# templates/deployment.yaml (inside the container spec)
env:
  {{- range $name, $value := .Values.env }}
  - name: {{ $name }}
    value: {{ $value | quote }}
  {{- end }}
```

Now `--set env.LOG_LEVEL=debug` deep-merges like any map key and the other two survive. The trade-off: you lose list-only features (`valueFrom`, ordering), which is why mature charts offer both — a map for simple vars and an `extraEnv` list passed through verbatim.

**Deleting a default with `null`.** Setting a key to `null` in an override removes it from the merged result:

```bash
helm upgrade web ./web-service --set resources.limits.cpu=null
```

drops the CPU limit that `values.yaml` defaulted (a legitimate move — see [CPU limits](/tuning/requests-limits-knobs/)). In a values file, `resources: {limits: {cpu: null}}` does the same. Where `null` fails you: it deletes *keys from the values merge*, not elements from lists (whole-list replacement again), and if the template does `{{ .Values.foo | default "x" }}` the deletion just re-triggers the default. `null` also can't remove a key a *subchart's own* values.yaml defines unless you address it through the parent (`subchart.key: null`).

## `--set` grammar and its traps

`--set` looks like a convenience and behaves like a small, hostile parser. The grammar:

```bash
--set key=value                      # simple
--set a.b.c=value                    # nested maps via dots
--set list={a,b,c}                   # whole list
--set list[0].name=foo               # element field by index
--set key1=v1,key2=v2                # multiple pairs, comma-separated
```

The traps, in the order they will bite you:

**Dots in key names.** Ingress annotations are the classic. `--set ingress.annotations.nginx.ingress.kubernetes.io/proxy-body-size=10m` creates a nested map five levels deep. You must escape the literal dots:

```bash
--set-string 'ingress.annotations.nginx\.ingress\.kubernetes\.io/proxy-body-size=10m'
```

**Commas in values** split into multiple assignments unless escaped (`value\,with\,commas`) — CORS origin lists and Kafka broker strings are the usual victims.

**Type coercion.** `--set` guesses types, and its guesses have consequences:

```bash
--set enabled=false          # boolean false
--set tag=1.30               # float 1.3 — trailing zero GONE
--set port=8080              # integer
--set userId=1234567890123456789   # parsed as float, rendered 1.2345678901234568e+18
```

That last one is the big-number horror: YAML integers beyond float precision get mangled silently, and the first you hear of it is an API validation error — or worse, a wrong-but-valid value. The fixes: `--set-string tag=1.30` forces string; `--set-json 'userId=1234567890123456789'` preserves JSON types exactly; `--set-file caBundle=./ca.pem` reads a value from a file (multiline certs, long scripts).

:::caution[When to give up on --set: almost always in CI]
`--set` is for `helm template` experiments at your terminal. In a pipeline, every value belongs in a reviewed, committed values file — files have no escaping rules, no type guessing, and they diff in the PR. A pipeline full of `--set` flags is configuration that exists only in CI logs. See [CI/CD Pipeline Design](/operations/cicd-pipeline-design/).
:::

## Subchart and global plumbing

When your chart declares dependencies (in `Chart.yaml` — see [Chart Anatomy](/helm/chart-anatomy/)), the parent's values file addresses each subchart by its **name as a top-level key**:

```yaml
# parent values.yaml
web-service:            # everything under here becomes the subchart's .Values
  replicaCount: 3
postgresql:
  auth:
    database: shop
global:                 # visible to parent AND all subcharts as .Values.global
  imageRegistry: registry.internal
  environment: prod
```

The subchart sees `web-service.replicaCount` simply as `.Values.replicaCount` — it never knows it's embedded. `global.*` is the one shared channel; use it for genuinely cross-cutting facts (registry, environment name) and nothing else, because every chart in the tree can read it and none can tell where a value came from.

For structured sharing there's `import-values` in the dependency declaration — a child `exports:` block the parent can pull from, or explicit `child`/`parent` path mappings. It's occasionally the right tool for lifting a subchart's computed defaults into the parent's namespace; most teams never need it, and `global` plus explicit per-subchart keys covers the rest.

## Values-file architecture for environments

The pattern that survives contact with three environments and two years of drift:

```text
deploy/
├── values.yaml           # in the chart: safe, boring defaults — must install cleanly
├── values-dev.yaml       # deltas only: debug logging, 1 replica, dev ingress host
├── values-stage.yaml     # deltas only
└── values-prod.yaml      # deltas only: real replica count, prod host, tighter resources
```

```bash
helm upgrade --install web ./web-service -f deploy/values-prod.yaml
```

The rule is **deltas only**. Each environment file contains exactly what differs from the chart defaults — usually 15 lines, not 150. The anti-pattern is full copies: someone copies `values.yaml` to `values-prod.yaml` "to be explicit," then a default changes in the chart and prod silently keeps the stale copy of every key it never meant to pin. Six months later nobody can say which prod values are deliberate. Small delta files make every line a decision.

**Secrets do not go in values files.** Not base64'd, not "just for dev," not in a private repo. Values files end up in Git, in CI logs, in `helm get values` output readable by anyone with release access. Use External Secrets or SOPS-encrypted sources as covered in [Secrets](/workloads/secrets/); the `helm-secrets` plugin (SOPS-encrypted values files decrypted at install time) is the established middle path if your pipeline runs `helm` directly. Charts should accept a `existingSecret:` name, not secret material.

**GitOps mapping.** Under Flux or Argo CD you don't run `helm upgrade` at all — the same architecture maps onto the controller's [CRD](/controllers/crds-explained/):

```yaml
# Flux HelmRelease — values inline plus valuesFrom a ConfigMap/Secret
spec:
  values:
    replicaCount: 4
  valuesFrom:
    - kind: ConfigMap
      name: web-service-prod-values
```

Argo CD's `Application` has the equivalent `helm.values` / `helm.valueFiles`. Same precedence thinking applies — `valuesFrom` sources merge in list order, inline `values` wins. See [GitOps for Tenants](/operations/gitops-for-tenants/) for the full model, and [Drift and CI/CD](/operations/drift-and-cicd/) for what happens when someone `helm upgrade --set`s around the controller (spoiler: the controller puts it back).

## Designing a values API when authoring

Everything above is the consumer seat. Now the author seat: your values shape **is an API**, and consumers will write automation against it.

**Naming.** camelCase keys (`replicaCount`, not `replica_count`), singular nouns for maps (`image:`, `service:`), plural for lists (`tolerations:`). Match the conventions of the big community charts — your consumers already have muscle memory from bitnami-style layouts.

**Shape stability is semver.** Renaming a key, changing a scalar to a map, or changing a default in a behavior-visible way is a **breaking change → major version bump** of the chart, with the migration documented in the CHANGELOG. Chart version discipline lives in [Chart Anatomy](/helm/chart-anatomy/); the point here is that values shape is the thing being versioned.

**Required vs. defaulted.** Fail loud on business configuration, default the plumbing:

```yaml
# templates/deployment.yaml
image: {{ required "image.repository is required — set it in your values file" .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
```

There is no safe default for "which database does this talk to," so don't invent one. There *is* a safe default for `terminationGracePeriodSeconds`, so provide it.

**`enabled:` flags for optional blocks.** Every optional resource gets a boolean gate with a settled name:

```yaml
ingress:
  enabled: false
serviceAccount:
  create: true
autoscaling:
  enabled: false
```

**Passthrough blocks — don't re-model the pod spec.** For `resources`, `affinity`, `nodeSelector`, `tolerations`, and security contexts, take the Kubernetes structure verbatim and emit it with `toYaml`:

```yaml
# values.yaml
resources: {}
tolerations: []
affinity: {}
```

```yaml
# templates/deployment.yaml
{{- with .Values.resources }}
resources:
  {{- toYaml . | nindent 10 }}
{{- end }}
```

Consumers paste in exactly what the Kubernetes docs (and [Resources and QoS](/workloads/resources-and-qos/), [Requests and Limits](/tuning/requests-limits-knobs/)) show, no chart-specific translation. Inventing `cpuLimit: 500m` style flat knobs means you'll forever be adding fields the pod spec already had.

**Escape hatches every chart needs.** `extraEnv`, `extraEnvFrom`, `extraVolumes`, `extraVolumeMounts` — verbatim lists appended after the chart's own entries. They cost ten template lines and save consumers from forking your chart the first time they need a sidecar cert mount you didn't anticipate.

## `values.schema.json`, properly

A JSON Schema at the chart root is validated automatically on `helm install`, `helm upgrade`, `helm lint`, and `helm template` — against the **final merged values**, after all files and flags. A real one for `web-service`:

```json
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["image"],
  "properties": {
    "replicaCount": { "type": "integer", "minimum": 1 },
    "image": {
      "type": "object",
      "required": ["repository"],
      "additionalProperties": false,
      "properties": {
        "repository": { "type": "string", "minLength": 1 },
        "tag": { "type": "string" },
        "pullPolicy": { "type": "string", "enum": ["Always", "IfNotPresent", "Never"] }
      }
    },
    "service": {
      "type": "object",
      "properties": {
        "type": { "type": "string", "enum": ["ClusterIP", "NodePort", "LoadBalancer"] },
        "port": { "type": "integer", "minimum": 1, "maximum": 65535 }
      }
    },
    "ingress": {
      "type": "object",
      "properties": {
        "enabled": { "type": "boolean" },
        "hosts": { "type": "array", "items": { "type": "string" } }
      }
    },
    "resources": { "type": "object" },
    "extraEnv": { "type": "array" }
  }
}
```

What it catches at install time: wrong types (`replicaCount: "three"`), missing required keys, out-of-range values, invalid enum members — all before anything renders, with an error naming the offending path. What it can't catch: cross-field logic ("if ingress.enabled then hosts must be non-empty" is expressible but painful; use `fail` in templates instead), values that are well-typed but wrong for your cluster, and anything about the *rendered* manifests.

The `additionalProperties: false` trade-off: set it and typos like `image.pullpolicy` become hard errors — enormously valuable. But it also rejects forward-compatible extra keys and can break umbrella charts that pass `global.*` through, so most charts apply it selectively to leaf objects (like `image` above) rather than at the root. Note `resources` deliberately stays a free-form `object` — it's a passthrough, so don't re-model it in the schema either.

Keep schema and docs generated from one source where you can — `helm-docs` reads values.yaml comments into the README table, and a schema that disagrees with either is worse than no schema. Regenerate both in CI when `values.yaml` changes.

## Discovering a third-party chart's real API

The README is marketing; the values file is the contract. Start with:

```console
$ helm show values ingress-nginx/ingress-nginx > upstream-values.yaml
$ wc -l upstream-values.yaml
    1023 upstream-values.yaml
```

That's the complete, current, commented API for the exact version you'll install (`--version 4.10.1` to pin it). Grep it before believing any blog post — READMEs document the popular 10% and lag behind the values file routinely.

:::danger[Values you didn't set — and values that don't exist]
Helm ignores unknown values **silently** unless the chart ships a schema, and most don't. `--set controller.replicaCounts=3` (note the typo) installs successfully, renders the default replica count, and no tool complains — `helm lint` validates the chart, not your values, and won't save you. Before trusting an override, prove it does something: `helm template . -f your-values.yaml | grep -A2 replicas`. If the rendered output didn't change, your key doesn't exist.
:::

For your own charts, this is the strongest argument for shipping `values.schema.json` with `additionalProperties: false` on leaf objects: you convert your consumers' silent typos into loud install-time failures. Your future self, consuming your own chart at 2am, will be among the beneficiaries.

## What to remember

- Precedence: chart defaults < parent overrides < `-f` files in order < `--set` family, last flag wins. `helm get values -a` shows the truth.
- Maps deep-merge; **lists replace wholesale**. Model overridable collections as maps; restate whole lists otherwise. `null` deletes a defaulted key.
- `--set` guesses types and mangles big numbers; escape dots in annotation keys; in CI, use files — always.
- Environments = base defaults + small delta files. Full copies drift. Secrets go through [external mechanisms](/workloads/secrets/), never values files.
- Authoring: camelCase, `enabled:` gates, `required` for business config, verbatim passthroughs plus `extra*` escape hatches, and a `values.schema.json` so typos fail loudly.

Next: [Authoring Best Practices](/helm/authoring-best-practices/) for the rest of the author's discipline, and [Release Lifecycle and Operations](/helm/lifecycle-and-operations/) for what happens after `helm install` returns.
