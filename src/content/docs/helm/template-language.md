---
title: The Template Language
description: Go templates plus Sprig as actually used in charts — the dot and its rebinding, truthiness traps, whitespace control, the function toolkit, _helpers.tpl done right, and debugging renders.
keywords:
  - nil pointer evaluating interface
  - error converting yaml to json
  - toyaml nindent indentation
  - Sprig function library
  - the dot rebinding range with
  - replicas 0 falsy truthiness trap
  - whitespace control chomp
  - tpl function templates in values
  - lookup live cluster render
  - semvercompare capabilities kubeversion
  - _helpers.tpl fullname selectorlabels
  - helm template --debug --show-only
sidebar:
  order: 3
---

Helm templates are Go's `text/template` language plus the Sprig function library plus a handful of Helm-specific additions (`include`, `tpl`, `lookup`, `toYaml` and friends). That heritage explains both the power and the sharp edges: the engine generates *text*, not YAML — it has no idea what indentation means, no idea a `0` is a meaningful replica count, and no idea that the blank line it just emitted broke your Deployment. This article teaches the language the way you'll actually use it, building up the `web-service` chart from [Chart Anatomy](/helm/chart-anatomy/) one template at a time. The upstream reference is the [chart template guide](https://helm.sh/docs/chart_template_guide/); this is the field version.

## The data model: what's in scope

Every template renders against one root object. Its top-level members:

| Object | What's in it | Typical use |
|---|---|---|
| `.Values` | The merged values tree (defaults + your files + `--set`) | Everything configurable |
| `.Release` | `.Name`, `.Namespace`, `.Revision`, `.IsInstall`, `.IsUpgrade`, `.Service` | Naming, install-vs-upgrade conditionals |
| `.Chart` | Chart.yaml as an object: `.Name`, `.Version`, `.AppVersion` (capitalized!) | Labels, default image tag |
| `.Capabilities` | `.APIVersions`, `.KubeVersion` — what the *target cluster* supports | Compatibility conditionals |
| `.Files` | Access to non-template files in the chart | Bundling config files |
| `.Template` | `.Name`, `.BasePath` of the current file | Rare; debugging output |

`.Release.Name` and `.Release.Namespace` come from the `helm install`/`upgrade` command line, which is why the same chart installs twice in one namespace without collisions — every resource name should derive from the release name (the `fullname` helper below exists for exactly this).

**`.Capabilities`** answers "what can this cluster do," queried at render time against the real API server:

```yaml
{{- if .Capabilities.APIVersions.Has "autoscaling/v2" }}
apiVersion: autoscaling/v2
{{- else }}
apiVersion: autoscaling/v2beta2
{{- end }}
```

This is the compatibility-conditional pattern that lets one chart span cluster versions — pair it with `semverCompare` against `.Capabilities.KubeVersion.Version` (below) for version-gated features. Caveat that matters: `helm template` has no cluster, so `.Capabilities` is stubbed with defaults there — more in the debugging section.

**`.Files`** reads non-template files packaged in the chart — the clean way to ship a real config file instead of trapping it inside a template string:

```yaml
# templates/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "web-service.fullname" . }}-config
data:
  app.yaml: |-
{{ .Files.Get "config/app.yaml" | indent 4 }}
{{- range $path, $_ := .Files.Glob "config/rules/*.yaml" }}
  {{ base $path }}: |-
{{ $.Files.Get $path | indent 4 }}
{{- end }}
```

Files under `templates/` are not reachable this way (they're templates), and anything `.helmignore` excludes is invisible. Why you'd mount config as files at all is [Configuration](/workloads/configuration/) territory.

### The dot, rebinding, and `$`

`.` is not "the chart" — it's *the current context*, and several constructs **rebind** it. This is the number one source of template confusion, so here it is as a worked failure.

`range` rebinds the dot to each element. Inside the loop, `.Release` doesn't exist anymore:

```yaml
# templates/ingress.yaml — BROKEN
{{- range .Values.ingress.hosts }}
  - host: {{ .name }}
    backend:
      service:
        name: {{ include "web-service.fullname" . }}   # ← dot is a HOST here
{{- end }}
```

```console
$ helm template web ./charts/web-service
Error: template: web-service/templates/ingress.yaml:8:19: executing
"web-service/templates/ingress.yaml" at <include "web-service.fullname" .>:
error calling include: template: web-service/templates/_helpers.tpl:4:18:
executing "web-service.fullname" at <.Release.Name>: nil pointer evaluating
interface {}.Name
```

Read that error backwards: the helper asked the context for `.Release.Name`, but the context it was handed was one entry of `ingress.hosts` — a map with no `Release` key. Nil pointer.

The escape hatch is **`$`**, which is *always* bound to the root context no matter how deeply you're nested:

```yaml
# templates/ingress.yaml — FIXED
{{- range .Values.ingress.hosts }}
  - host: {{ .name }}
    backend:
      service:
        name: {{ include "web-service.fullname" $ }}   # $ = the root, always
{{- end }}
```

`with` rebinds the same way (that's its entire job), and `define` blocks get whatever context the caller passes. When any template misbehaves, your first question should be: *what is the dot right here?*

## Actions and control flow

### if/else and the truthiness trap

`if` treats as false: boolean `false`, numeric `0`, the empty string, `nil`, and empty collections. That list contains a landmine — **`0` is falsy** — and it detonates in the single most common template ever written:

```yaml
# BROKEN in exactly one case
{{- if .Values.replicas }}
  replicas: {{ .Values.replicas }}
{{- end }}
```

Set `replicas: 3` — fine. Omit it — fine. Set `replicas: 0` to deliberately scale a service to zero — the `if` sees falsy, **omits the field entirely**, and the API server defaults an omitted `replicas` to `1`. You asked for zero pods and got one; nobody errors anywhere. The fix is to test *presence*, not truthiness:

```yaml
{{- if not (kindIs "invalid" .Values.replicas) }}
  replicas: {{ .Values.replicas }}
{{- end }}
```

(`kindIs "invalid" x` is the "is it nil/unset" test; `hasKey .Values "replicas"` works too when you know the parent map exists.) The same bug family covers any legitimate falsy value: an intentionally empty string, `enabled: false` that you're echoing into config, port `0`. `else if` and `else` work as expected; comparison is via functions, not operators: `eq`, `ne`, `lt`, `gt`, `and`, `or`, `not` — prefix-style, `{{ if and .Values.a (eq .Values.b "x") }}`. Note `and`/`or` evaluate all arguments (no short-circuit), so `and (hasKey .Values "x") .Values.x.y` still explodes — nest the `if`s instead.

### range, with, variables

`range` iterates lists and maps. Over a map you can capture both key and value — and Helm's engine visits map keys in **sorted key order**, so renders are stable and diffs don't churn (a genuinely important property for the render-diff habit):

```yaml
# templates/configmap.yaml (excerpt)
data:
{{- range $key, $val := .Values.extraConfig }}
  {{ $key }}: {{ $val | quote }}
{{- end }}
```

`with` rebinds the dot to a value *if it's truthy*, skipping the block otherwise — scoping and existence check in one:

```yaml
{{- with .Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
{{- end }}
```

That idiom — `with` an optional map, `toYaml` the dot — is all over well-written charts: no `if`, no repetition of the path, nothing rendered when the value's absent. Just remember the dot inside is the *map*, so reach for `$` if you need the root.

Variables (`$name := value`) survive rebinding, which makes them the other answer to the dot problem, and the only answer when you need *two* loop contexts at once:

```yaml
{{- $root := . -}}
{{- range $env := .Values.environments }}
{{- range $svc := $root.Values.services }}
  {{ $env }}-{{ $svc.name }}: {{ include "web-service.fullname" $root }}
{{- end }}
{{- end }}
```

### define, template, include — use include, always

`define` creates a named template; two constructs invoke it. `template` is a *statement* from core Go templates: it can't participate in a pipeline, so its output can't be re-indented, which makes it nearly useless for YAML. `include` is Helm's function version of the same thing — it returns the rendered text as a string you can pipe:

```yaml
labels:
  {{- include "web-service.labels" . | nindent 4 }}     # works anywhere
  {{- template "web-service.labels" . }}                 # output indent is fixed
                                                         #   at definition time — wrong
                                                         #   the moment nesting differs
```

There's no situation where `template` beats `include` in a chart. Treat `template` as a keyword you *recognize* in old charts and never write.

## Whitespace control, mechanically

Every `{{ }}` action is replaced by its output — but the newline and indentation *around* the action are ordinary text and stay put. `{{-` eats all whitespace (spaces, tabs, newlines) immediately to the left; `-}}` eats to the right. That's the whole mechanism. The trap is that the damage is data-dependent — the template renders valid YAML with one values file and garbage with another.

Before, with a plausible-looking conditional:

```yaml
    spec:
      containers:
        - name: web
          {{ if .Values.securityContext }}
          securityContext:
            {{- toYaml .Values.securityContext | nindent 12 }}
          {{ end }}
          ports:
            - containerPort: 8080
```

With `securityContext` unset, the `{{ if }}` and `{{ end }}` lines each render as a line containing *only their leading spaces* — two blank-ish lines in the output. YAML shrugs at blank lines, so this "works." Set `securityContext: {runAsNonRoot: true}` and now the output has a stray whitespace-only line between `- name: web` and `securityContext:` — and depending on what else is in the block, you get either quietly weird YAML or:

```console
Error: YAML parse error on web-service/templates/deployment.yaml:
error converting YAML to JSON: yaml: line 31: did not find expected key
```

After — every control-flow action hugs its whitespace:

```yaml
    spec:
      containers:
        - name: web
          {{- with .Values.securityContext }}
          securityContext:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          ports:
            - containerPort: 8080
```

The working rule: **control-flow actions (`if`/`else`/`end`/`range`/`with`/`define`) always get `{{-`**, so the line they sit on vanishes entirely from the output; value-emitting actions keep their whitespace because that whitespace *is* the indentation. Be stingy with `-}}` on the right — it eats the newline your next line was counting on. And whenever you're unsure, don't reason about it: render it (`helm template`) and look.

## The function toolkit

Sprig ships ~200 functions; charts live on about twenty. The quick tier, then the ones that deserve dissection:

| Function | Example | What it does |
|---|---|---|
| `default` | `{{ .Values.image.tag \| default .Chart.AppVersion }}` | Fallback when nil/empty (careful: also fires on legit falsy values — the replicas trap again) |
| `required` | `{{ required "image.repository is required — set it in your values file" .Values.image.repository }}` | Hard-fail the render with *your* message. Write messages that name the key and the fix — authoring kindness that turns a 2 AM mystery into a 10-second fix |
| `quote` / `squote` | `tag: {{ .Values.image.tag \| quote }}` | Wrap in `"`/`'`. Quote anything YAML might misread: version-ish strings (`"1.20"` → float!), `"true"`, `"on"`, port strings |
| `printf` | `{{ printf "%s-%s" .Release.Name "cache" }}` | Go format strings; the clean way to build names |
| `ternary` | `{{ ternary "https" "http" .Values.tls.enabled }}` | Value-if-true / value-if-false (evaluates both — no side-effect tricks) |
| `coalesce` | `{{ coalesce .Values.host .Values.global.host "localhost" }}` | First non-empty of N |
| `dig` | `{{ dig "metrics" "port" 9090 .Values }}` | Deep lookup *with default*, no nil-pointer risk on missing intermediate keys |
| `hasKey` | `{{ if hasKey .Values.service "nodePort" }}` | Presence test on maps — the truthiness-safe conditional |
| `fromYaml` | `{{ $cfg := .Files.Get "config/app.yaml" \| fromYaml }}` | Parse YAML text into a map you can traverse |
| `semverCompare` | `{{ if semverCompare ">=1.29-0" .Capabilities.KubeVersion.Version }}` | Version-gate features on the target cluster (note the `-0` for vendor suffixes like `-gke.900`) |

### toYaml + nindent: THE idiom

The pattern you'll write most and should be able to defend in review:

```yaml
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
```

Dissected, right to left:

- **`toYaml .Values.resources`** serializes the values subtree to YAML text — a passthrough block. The chart doesn't enumerate `limits`/`requests` keys; whatever structure the user provides flows through. This is how one chart line supports every resources shape without a knob per field.
- **`| nindent 12`** indents *every line* of that text by 12 spaces **and prepends a newline**. Its sibling `indent 12` indents every line *except* it can't fix the first one's position — the first line lands wherever your `{{` happened to sit. `nindent`'s leading newline makes the output's indentation independent of the template's layout: all lines start fresh at column 12.
- **The leading `{{-`** eats the whitespace and newline between `resources:` and the action — which would otherwise combine with `nindent`'s own newline to leave a blank line and a stray-indent artifact. `{{-` + `nindent` are a matched pair: the action consumes the layout whitespace, `nindent` re-manufactures correct indentation from zero.

Count the indent from the *output's* structure: container fields sit at 10 in this Deployment, so children of `resources:` need 12. When you get it wrong, `helm template` shows you immediately — which is one more reason rendering is a reflex, not a ceremony.

### tpl: templates inside values

`tpl` renders a *string* as a template, against a context you supply. That means values themselves can contain template syntax — the power move for charts that want user-extensible strings:

```yaml
# values.yaml
podAnnotations:
  vault.example.com/role: "{{ .Release.Name }}-app"
  backup.example.com/target: "s3://backups/{{ .Release.Namespace }}/{{ .Chart.Name }}"
```

```yaml
# templates/deployment.yaml (excerpt)
  template:
    metadata:
      annotations:
        {{- range $key, $val := .Values.podAnnotations }}
        {{ $key }}: {{ tpl $val $ | quote }}
        {{- end }}
```

Rendered with release `web` in namespace `payments`:

```yaml
      annotations:
        backup.example.com/target: "s3://backups/payments/web-service"
        vault.example.com/role: "web-app"
```

Consumers get release-aware annotations without the chart growing a knob per annotation. The cost is real, though: errors from inside a `tpl` string report positions *within the string*, not a file and line — `template: web-service/templates/deployment.yaml:24:22: executing ... error calling tpl: ... :1:12` tells you almost nothing — and every `tpl` call re-parses at render time, which big charts feel. Use it at designed extension points (annotations, config blobs, URLs); a chart where every value passes through `tpl` has reinvented an inner templating language nobody can debug.

### sha256sum: the checksum-annotation pattern

Deployments only roll pods when the *pod template* changes — editing a ConfigMap changes nothing a Deployment watches, so pods keep running with stale config (the problem [Configuration](/workloads/configuration/) covers at length). The chart-side fix is to hash the rendered config into a pod annotation:

```yaml
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
```

Config change → different rendered ConfigMap → different hash → pod template diff → rolling restart, automatically, atomically with the config. This is Kustomize's `configMapGenerator` hash trick ([Helm and Kustomize](/operations/helm-and-kustomize/)) rebuilt in three template functions.

### b64enc and Secrets: proceed carefully

```yaml
data:
  api-key: {{ .Values.apiKey | b64enc | quote }}
```

Mechanically fine; operationally a trap. A value that renders into a Secret has now existed in a values file (committed by someone, eventually), in the release Secret Helm stores (full manifests, every revision), and in every `helm get manifest` output. Charts you author should prefer the `existingSecret` pattern — accept a Secret *name* and let real secret machinery populate it. The full argument and the alternatives live in [Secrets](/workloads/secrets/).

### lookup: reads the live cluster — use rarely

`lookup "v1" "Secret" "payments" "web-tls"` queries the API server *during rendering* and returns the live object (or an empty map). Classic use: generate a password on first install, then keep it stable across upgrades by looking up the existing Secret. Now the fine print, which is most of the story:

- In `helm template` and `helm install --dry-run`, there's no cluster call — **`lookup` returns empty**, and your template takes the not-found branch. Your local render and your real install differ by design. (`--dry-run=server` fixes this; see debugging below.)
- GitOps controllers render before they apply — Argo CD's diff phase uses template-style rendering, so a `lookup`-dependent chart shows **permanent spurious diffs** or takes the wrong branch entirely. If your platform runs GitOps ([GitOps for Tenants](/operations/gitops-for-tenants/)), `lookup` is close to forbidden.
- The render now needs cluster RBAC and stops being a pure function of chart + values — the property every debugging technique in this article relies on.

A chart that *requires* `lookup` to render correctly has coupled rendering to cluster state; that's occasionally justified (the keep-the-generated-password trick) and usually a design smell.

## Named templates done right: _helpers.tpl

Every serious chart carries the same helper quartet. Here's `web-service`'s, dissected — this is the file `helm create` scaffolds, and it's worth understanding rather than cargo-culting:

```yaml
{{/* templates/_helpers.tpl */}}

{{- define "web-service.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "web-service.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "web-service.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}

{{- define "web-service.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 -}}
{{- end }}

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

Notes that matter:

- **`fullname` is the naming root.** `nameOverride` swaps the chart-name half; `fullnameOverride` replaces the whole thing (how consumers pin exact resource names). The `trunc 63` is not decoration — label values and many name fields cap at 63 characters, and a long release name plus a long chart name blows it at install time with a validation error. Name math lives here, once, so every resource agrees.
- **`selectorLabels` vs `labels` is a deliberate split, not duplication.** A Deployment's `spec.selector` and a Service's selector must be **stable for the life of the object** — Deployment selectors are immutable, and every upgrade must keep matching the same pods. So selectors get the minimal stable pair (`name` + `instance`) and nothing else. The full `labels` set adds things that *change on every chart bump* (`helm.sh/chart` embeds the version; `app.kubernetes.io/version` tracks the app). Merge those into a selector and your first chart upgrade fails with `field is immutable`. The split is the fix, and it's why templates use them asymmetrically:

```yaml
# templates/deployment.yaml — the asymmetry in action
metadata:
  labels:
    {{- include "web-service.labels" . | nindent 4 }}        # rich, may change
spec:
  selector:
    matchLabels:
      {{- include "web-service.selectorLabels" . | nindent 6 }}  # minimal, frozen
  template:
    metadata:
      labels:
        {{- include "web-service.labels" . | nindent 8 }}    # superset matches selector
```

Why selectors are forever is covered in [YAML, Labels, and Namespaces](/start/yaml-labels-and-namespaces/) and [Deployments Deep Dive](/workloads/deployments-deep-dive/); the helper split is the chart-shaped answer.

**Passing richer context.** `include` takes exactly one context argument. When a helper needs the root *and* extra parameters, build a `dict`:

```yaml
{{- define "web-service.containerPort" -}}
- name: {{ .name }}
  containerPort: {{ .port }}
  protocol: {{ .root.Values.service.protocol | default "TCP" }}
{{- end }}

{{/* call site: */}}
        ports:
          {{- include "web-service.containerPort" (dict "root" $ "name" "http" "port" 8080) | nindent 10 }}
```

Passing `"root" $` explicitly is the convention — inside the helper, `.root` is the whole world and the other keys are your parameters. This scales into **library charts**: a `type: library` dependency that exports helpers like these so every team's chart shares one labels/naming implementation ([Chart Anatomy](/helm/chart-anatomy/) covers wiring one in; the golden-chart endgame is the [golden service architecture](/architectures/golden-service/)).

## Debugging templates

The tools, in the order you reach for them:

```bash
# 1. Render everything, no cluster needed. Your default.
helm template web ./charts/web-service -f values-prod.yaml

# 2. Just the file you're fighting:
helm template web ./charts/web-service -f values-prod.yaml \
  --show-only templates/deployment.yaml

# 3. Structural sanity + common mistakes:
helm lint ./charts/web-service -f values-prod.yaml

# 4. When the template won't even render, --debug prints
#    the BROKEN output up to the failure instead of nothing:
helm template web ./charts/web-service -f values-prod.yaml --debug

# 5. The truth for lookup/.Capabilities — renders against the real API server,
#    validates against real schemas, applies nothing:
helm install web ./charts/web-service -f values-prod.yaml \
  --dry-run=server --namespace payments
```

That last distinction matters more than it looks: plain `helm template` stubs `.Capabilities` with defaults and returns empty for every `lookup`, so a chart using either renders *differently* offline than at install. `--dry-run=server` is the only pre-apply render that tells the truth for those charts — and the reason `lookup`-heavy charts and GitOps don't mix (above).

### The error-message decoder

| Error | Actual meaning | Fix |
|---|---|---|
| `...deployment.yaml:12:24: nil pointer evaluating interface {}.tag` | The template walked a values path that doesn't exist — `.Values.image` is nil so `.tag` dereferenced nothing. **Or** the dot got rebound (range/with) and the path is relative to the wrong context | Add the value, guard with `default`/`required`/`with`, or use `$` |
| `YAML parse error ... line 31: did not find expected key` | The *rendered output* is invalid YAML — almost always whitespace/indent from a control-flow action or an `indent` that should be `nindent` | Render with `--debug`, read the output around the reported line |
| `error validating data: ... ValidationError(Deployment.spec.replicas): invalid type for ... expected "integer"` | A value rendered as the wrong YAML type — usually over-quoting a number, or YAML reading `tag: 1.20` as a float where a string was needed | `quote` strings deliberately; don't quote integers; check with `--show-only` |
| `error calling include: template: no template "web-service.fullnme"` | Typo in a template name — `include` resolves names at render time, not parse time | Fix the name; grep the chart for the `define` |
| `execution error at (web-service/templates/deployment.yaml:8:11): image.repository is required — set it in your values file` | A `required` fired. This is the *good* error — someone wrote you a message | Do what it says |

The one orientation rule that makes all of these tractable: **the file:line in a template error points into the *template source*; the line in a YAML parse error points into the *rendered output*.** Template errors → open the `.yaml` in `templates/`. YAML errors → render with `--debug` (or `--show-only` the file) and count lines in the *output*. Confusing the two coordinate systems is how people stare at line 31 of a 25-line template.

### The render-diff habit

Debugging renders locally is half the loop; the other half is diffing the render against reality before anything applies:

```bash
helm template web ./charts/web-service -f values-prod.yaml \
  --namespace payments | kubectl diff -f -
```

This is the same habit [Helm and Kustomize](/operations/helm-and-kustomize/) drills for consumers, and as an author it's how you review your own template change as a *manifest* change: edit template → render-diff → the diff is exactly what your PR reviewer (and your cluster) will see. Wire the render into CI so every chart PR shows its rendered diff — [CI/CD Pipeline Design](/operations/cicd-pipeline-design/) shows where that gate sits — and template errors become build failures instead of deploy failures.

Next: the other half of every render is the values tree feeding it — merge order, override precedence, schemas, and designing values people can use, in [Values and Overrides](/helm/values-and-overrides/).
