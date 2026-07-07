---
title: Chart Anatomy
description: Every file in a Helm chart directory and what it's for — Chart.yaml dissected, dependencies and lock files, the crds/ trap, subchart mechanics, and versioning discipline.
sidebar:
  order: 2
---

A chart is just a directory with a contract: certain filenames mean certain things to Helm, and everything else is convention. This article walks that directory file by file, using one running example — `web-service`, a minimal internal chart for a stateless HTTP service — that [The Template Language](/helm/template-language/) and the rest of this section reuse. By the end you should be able to open any chart, including a 40-file vendor monster, and know where everything lives and why.

## The running example: `web-service`

```text
charts/web-service/
├── Chart.yaml              # identity: name, version, appVersion, dependencies
├── Chart.lock              # exact resolved dependency versions — commit it
├── values.yaml             # default values = the chart's documented API surface
├── values.schema.json      # JSON Schema; makes Helm reject bad/unknown values
├── .helmignore             # what to exclude when packaging (like .gitignore)
├── README.md               # for humans; helm show readme prints it
├── charts/                 # vendored dependency charts (from `helm dependency build`)
│   └── redis-19.6.2.tgz    #   pulled per Chart.lock, not hand-edited
├── crds/                   # plain CRD YAML — installed once, NEVER upgraded (see below)
└── templates/
    ├── _helpers.tpl        # named templates; underscore files render no output
    ├── deployment.yaml     # one file per resource kind, named after the kind
    ├── service.yaml
    ├── configmap.yaml
    ├── serviceaccount.yaml
    ├── hpa.yaml            # conditional: only renders if autoscaling enabled
    ├── NOTES.txt           # printed to the terminal after install/upgrade
    └── tests/
        └── test-connection.yaml   # `helm test` pods — see Lifecycle and Operations
```

Only `Chart.yaml` is mandatory. Everything else is either strongly conventional (`values.yaml`, `templates/`) or special-cased by name (`charts/`, `crds/`, `_*.tpl`, `NOTES.txt`, `tests/`). Let's take them in order of how often they hurt people.

## Chart.yaml, dissected

```yaml
# Chart.yaml
apiVersion: v2
name: web-service
description: Paved-road chart for stateless HTTP services
type: application
version: 1.4.1          # the CHART's version — bumps when templates/values change
appVersion: "2.7.0"     # the APP's version — pure metadata, default image tag at most
kubeVersion: ">=1.27.0-0"

dependencies:
  - name: redis
    version: "~19.6.0"          # a RANGE — see below before you copy this
    repository: https://charts.bitnami.com/bitnami
    condition: redis.enabled    # subchart only renders if this value is true
```

**`apiVersion: v2`** means "Helm 3 chart format" — dependencies live here instead of a separate `requirements.yaml`, and `type` and library charts exist. You'll still see `apiVersion: v1` on old charts; Helm 3 installs them, but write v2. (The format is fully specified at [helm.sh/docs/topics/charts](https://helm.sh/docs/topics/charts/).)

**`version` vs `appVersion`** is the single most common Chart.yaml confusion. `version` is the chart's own SemVer — it versions the *templates and values schema* and is what `helm search`, dependency ranges, and repositories key on. `appVersion` is a free-text label recording which version of the packaged application this chart ships by default. They move independently: fix a template typo and you bump `version` (1.4.0 → 1.4.1) while `appVersion` stays `2.7.0`; ship app 2.8.0 with untouched templates and it's the reverse.

The confusion bites when someone asks "which version is running?":

```console
$ helm ls -n payments
NAME  NAMESPACE  REVISION  STATUS    CHART              APP VERSION
web   payments   4         deployed  web-service-1.4.1  2.7.0
```

`APP VERSION` here is whatever the deployed chart's Chart.yaml *claimed* — if your pipeline overrode `image.tag` at install time (it almost certainly did), the column is stale metadata. The actual running version is the image tag on the live Deployment, full stop:

```bash
kubectl get deploy web -n payments \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
```

**`type: application`** (the default) is a deployable chart. **`type: library`** charts render nothing on their own — they exist purely to export named templates for other charts to `include`, which is how platform teams share helpers like standard labels across every team's chart. More in [The Template Language](/helm/template-language/); library charts can only be consumed as dependencies, never installed.

**`kubeVersion`** is a constraint checked at install time — useful for charts using APIs that only exist past some cluster version. Note the `-0` suffix in `>=1.27.0-0`: cloud vendors ship versions like `v1.27.4-gke.900`, which SemVer treats as a *pre-release* of 1.27.4 and excludes from plain `>=1.27.0`. The `-0` makes the range accept them. Every chart author gets bitten by this exactly once.

### The dependencies block: ranges, conditions, aliases

**Version ranges.** `version: "~19.6.0"` means "any 19.6.x"; `"^19.0.0"` means "any 19.x". Ranges are how package managers stay current — and how a `helm dependency update` run in CI pulls a subchart version you never tested. A subchart minor bump can change defaults, rename resources, or add a sidecar; from your users' perspective *your* chart changed behavior without a version bump. Treat ranges the way you treat them in `package.json`: fine *because* a lock file pins the resolution, dangerous without one. For internal dependencies, many teams skip ranges entirely and pin exact versions, taking bumps as deliberate PRs.

**`condition`** makes a subchart optional: `condition: redis.enabled` means the redis subchart renders only when the value `redis.enabled` is true. The convention of putting the flag *inside the subchart's own values subtree* is near-universal. **`tags`** are the coarse-grained version — several dependencies share a tag (`tags: [cache]`) and one value (`tags.cache: false`) toggles the group. When both are present, `condition` wins.

**`alias`** lets you run the same chart twice as two differently-named subcharts:

```yaml
dependencies:
  - name: redis
    version: "19.6.2"
    repository: https://charts.bitnami.com/bitnami
    alias: cache
    condition: cache.enabled
  - name: redis
    version: "19.6.2"
    repository: https://charts.bitnami.com/bitnami
    alias: queue
    condition: queue.enabled
```

Each alias gets its own values subtree (`cache:` and `queue:`) and its own resource names. Without `alias`, two copies of one chart would collide on both.

## values.yaml: the defaults are the documentation

`values.yaml` plays two roles at once: it supplies every default, and it *is* the de-facto reference manual — `helm show values` prints it verbatim, and it's the first thing a consumer reads. Write it accordingly. Here's `web-service`'s:

```yaml
# values.yaml
replicaCount: 1

image:
  repository: registry.example.com/payments/web
  tag: ""                  # empty string = fall back to .Chart.AppVersion
  pullPolicy: IfNotPresent

nameOverride: ""           # replaces the chart-name half of resource names
fullnameOverride: ""       # replaces resource names entirely

service:
  type: ClusterIP
  port: 80

resources:                 # passed through verbatim — any valid shape works
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    memory: 256Mi

autoscaling:
  enabled: false           # when true, hpa.yaml renders and replicaCount is ignored

podAnnotations: {}         # extension point: merged into the pod template
nodeSelector: {}
tolerations: []

redis:
  enabled: false           # the dependency condition from Chart.yaml
```

Two conventions worth copying: **every supported key appears, even when its default is empty** (`podAnnotations: {}` documents an extension point that would otherwise be invisible outside the templates), and **comments explain behavior, not syntax** — "when true, `replicaCount` is ignored" is the sentence that saves a support thread. How this tree merges with user overrides, and how `values.schema.json` enforces it, is the whole of [Values and Overrides](/helm/values-and-overrides/).

## charts/, Chart.lock, and the update/build distinction

The `dependencies:` block is a *declaration*. Two commands turn it into actual chart archives under `charts/`, and they are not interchangeable:

```bash
helm dependency update ./charts/web-service
# Re-RESOLVES every range against the repos, writes a new Chart.lock,
# downloads the resolved versions into charts/.

helm dependency build ./charts/web-service
# Reads the EXISTING Chart.lock and downloads exactly those versions.
# Fails if lock and Chart.yaml disagree. No re-resolution.
```

This is `npm install` vs `npm ci`, and the same rule follows: **commit `Chart.lock` to git, and use `dependency build` everywhere automated** — CI, GitOps repos, teammates' machines. `dependency update` is a deliberate act ("take the new subchart version"), reviewed as a PR whose diff is the lock file. The `.tgz` files under `charts/` are reproducible from the lock, so most teams gitignore them and let CI run `build`; vendoring them into git also works and buys you immunity from repository outages at the cost of binary blobs in history. Pick one; document it.

:::caution[The unresolved-dependency error]
`Error: found in Chart.yaml, but missing in charts/ directory: redis` means nobody ran `dependency build` after cloning. It's the Helm equivalent of forgetting `npm install`, and it's why any pipeline that packages or templates a chart with dependencies needs a `helm dependency build` step first.
:::

## crds/: install-once, and the honest bad news

Files in `crds/` are **plain YAML, not templates** — no `{{ }}` allowed — and Helm gives them exactly one behavior: on `helm install`, if the [CRD](/controllers/crds-explained/) doesn't exist, create it. That's the whole feature. On `helm upgrade`, files in `crds/` are **silently ignored**. On `helm uninstall`, they're left behind (which is correct — deleting a CRD deletes every custom resource of that type, cluster-wide).

The upgrade gap is the part to internalize: you bump a chart that ships CRDs, the operator's Deployment updates, and the CRDs stay at the old schema. The operator then rejects fields its new version needs, or worse, half-works. Helm's position is deliberate — CRD upgrades can be destructive and cluster-scoped, so it refuses to automate them — but the result is that **CRD lifecycle is your problem**. The workable options:

- Apply CRDs out-of-band before upgrading the chart (`kubectl apply -f crds/` or the project's published CRD manifest) — the most common answer, and what most operator projects document.
- Put templated CRDs in `templates/` instead, so upgrades touch them — you gain upgrade behavior but lose install-ordering guarantees and inherit the delete-danger yourself. Some big charts do this behind a `crds.install` flag.
- Let a GitOps controller own CRDs as a separate, earlier sync wave ([GitOps for Tenants](/operations/gitops-for-tenants/)).

On shared platform clusters this is usually academic in the good way: CRDs are cluster-scoped, you likely don't have RBAC to install them, and the platform team owns them. If you're consuming a chart with a `crds/` directory, that's a conversation to have before install, not after ([working with your platform team](/operations/working-with-platform-team/) territory).

## .helmignore, values.schema.json, README

**`.helmignore`** works like `.gitignore` for `helm package`: patterns listed there don't ship in the `.tgz`. Default sensible entries: `.git/`, editor droppings, `*.md~`, test fixtures. It matters more than it looks — `helm package` on a directory containing a 200 MB `node_modules/` ships a 200 MB chart, and `.Files.Glob` in templates can accidentally slurp files you never meant to publish.

**`values.schema.json`** is a JSON Schema for the values tree. When present, Helm validates merged values on install, upgrade, *and* `helm template` — turning the "misspelled key silently ignored" trap from [Helm and Kustomize](/operations/helm-and-kustomize/) into a hard error at render time. It's the single highest-leverage file a chart author can add, and it gets full treatment in [Values and Overrides](/helm/values-and-overrides/).

**`README.md`** is surfaced by `helm show readme` — for an internal chart, this is where the values table and upgrade notes live.

## templates/: the conventions that keep charts readable

Nothing in `templates/` is magic except two filename rules. Everything else is convention — but the conventions are what make a stranger's chart navigable, so follow them:

- **One file per resource kind, named after the kind**: `deployment.yaml`, `service.yaml`, `hpa.yaml`. A reader looking for the Service knows where it is without grepping. Multi-document files (`---` separators) are legal and render fine, but they hide resources from skimmers.
- **`_helpers.tpl` — convention, not magic.** The actual rule is: *files beginning with an underscore produce no rendered output*. Helm parses them for `define` blocks and discards any other text. You could name it `_anything.tpl` or spread helpers across `_labels.tpl` and `_naming.tpl` in a big chart; `_helpers.tpl` is just the name everyone expects. The standard helper set (fullname, labels, selectorLabels) is dissected in [The Template Language](/helm/template-language/).
- **`NOTES.txt`** is a template whose *rendered output is printed to the terminal* after install/upgrade instead of being applied to the cluster. Good NOTES tell the installer what just happened and what to do next, using real values — `web-service`'s:

  ```text
  {{ .Chart.Name }} {{ .Chart.Version }} deployed as release "{{ .Release.Name }}".

  Watch the rollout:
    kubectl rollout status deploy/{{ include "web-service.fullname" . }} -n {{ .Release.Namespace }}
  Smoke-test the release:
    helm test {{ .Release.Name }} -n {{ .Release.Namespace }}
  {{- if not .Values.autoscaling.enabled }}

  Running with a fixed replicaCount of {{ .Values.replicaCount }}. Set
  autoscaling.enabled=true for an HPA.
  {{- end }}
  ```

  It's the chart's post-install README, and empty or boilerplate NOTES are a missed handoff.
- **`templates/tests/`** holds Pod manifests annotated `helm.sh/hook: test`; `helm test <release>` runs them against the live release — a smoke test that the Service actually answers. Covered properly in [Lifecycle and Operations](/helm/lifecycle-and-operations/).

## Subchart mechanics: who sees what

When Helm renders a chart with dependencies, parent and children render **together into one flat manifest stream, in one release**. There is no "install the subchart first" — one `helm install`, one revision, one rollback unit. The interesting part is values visibility, and the rule is strict:

**A subchart sees exactly two things: its own values subtree, promoted to its root — and `global`.** It cannot see its parent's values, its siblings' values, or anything else.

Concretely, with the parent's values file:

```yaml
# web-service/values.yaml (parent)
image:
  repository: registry.example.com/payments/web
  tag: "2.7.0"

redis:                      # everything under the dependency's name (or alias)
  enabled: true             #   is handed to the redis subchart AS ITS ROOT
  image:
    repository: registry.example.com/mirrors/redis   # parent overriding child image
    tag: "7.2.5"
  master:
    resourcesPreset: small

global:                     # visible to parent AND all subcharts as .Values.global
  imagePullSecrets:
    - name: regcred
```

Inside the redis subchart's templates, `.Values.image.repository` is `registry.example.com/mirrors/redis` — the subchart has no idea it's been overridden, no idea a parent exists, and no access to the parent's `.Values.image`. That's the whole trick for pointing a vendored subchart at your internal registry mirror: find the child's values key, set it under the child's name in the parent's values. `global` is the one shared channel — use it for genuinely cluster-wide facts (pull secrets, registry hostname, environment name) and nothing else, because every subchart of every dependency sees it.

Two consequences worth knowing before they surprise you:

- The parent's `values.yaml` can bake in child overrides (as above), and *installers* can too (`-f`, `--set redis.master.resourcesPreset=large`) — it all merges into the same tree. Merge order details in [Values and Overrides](/helm/values-and-overrides/).
- Subchart resource names derive from the release name plus the *subchart's* name (`web-redis-master`), not the parent's — relevant when you're grepping a render for who created what.

## Dependencies vs chart monorepo vs umbrella charts

Three ways to structure "we have several related charts," and the trade-offs are real:

| | Dependencies (`Chart.yaml`) | Monorepo of independent charts | Umbrella chart |
|---|---|---|---|
| Shape | App chart pulls in what it needs (redis, a library chart) | `charts/` dir in git, one chart per service, released separately | One near-empty parent whose only content is N dependencies |
| Releases | One release per app | One release per service | **One release for everything** |
| Upgrade blast radius | App + its deps together | Per service — smallest | Entire system at once |
| Rollback | App-level | Per service | All-or-nothing |
| Version coupling | Lock file pins deps | None — charts drift independently | Parent version pins the world |
| Values | One tree, subtree per dep | One tree per service | One giant tree, subtree per service |
| Best for | An app with genuine runtime deps | Teams owning separate services | Demo/dev environments; appliances shipped as a unit |

The umbrella pattern deserves the honest version, because it looks like free composition: one `helm install` brings up the whole platform, one values file configures everything. The costs arrive on day 30 — *one release* means every upgrade is a coupled upgrade (bumping service A's subchart re-renders B through F, and any of them can diff), rollback rolls back everyone, a single stuck `pending-upgrade` freezes all deployments, and the values file grows toward a thousand lines with six teams editing it. Umbrellas are great for "install our product's twelve components on your cluster" appliances and throwaway environments; for a team of services with independent deploy cadences, independent releases per service — wired together by a GitOps app-of-apps or plain pipeline ordering ([GitOps for Tenants](/operations/gitops-for-tenants/), [CI/CD Pipeline Design](/operations/cicd-pipeline-design/)) — will hurt less.

## Versioning discipline: values are the API

Because Helm ignores unknown values keys, a renamed or restructured value doesn't error for your consumers — it silently reverts them to defaults. That makes the values schema the chart's public API, and the chart `version` field is SemVer *on that API*:

| Bump | When | Example |
|---|---|---|
| **Patch** (1.4.0 → 1.4.1) | Template fix, no values change | Fix a wrong `nindent`, correct a label |
| **Minor** (1.4.1 → 1.5.0) | New values, defaults preserve old behavior | Add `podDisruptionBudget.enabled: false` |
| **Major** (1.5.0 → 2.0.0) | **Any breaking values change** | Rename `replicas` → `replicaCount`; change a default that alters behavior; remove a key; resource renames that force recreation |

The major-bump row is where discipline pays: renaming a values key is exactly as breaking as renaming a function in a library, except the failure is silent, so the version number is the *only* warning your consumers get. Ship majors with a migration note in the README ("`replicas` is now `replicaCount`; the old key is ignored"). If you can afford it, honor the old key for one major with a deprecation warning via `fail`/`required` tricks — [Authoring Best Practices](/helm/authoring-best-practices/) shows the pattern, and [Values and Overrides](/helm/values-and-overrides/) covers the consumer side of surviving these bumps.

**`appVersion` is pure metadata.** Nothing in Helm's resolution, upgrade, or dependency machinery reads it. Its only conventional job is serving as the default image tag (`tag: {{ .Values.image.tag | default .Chart.AppVersion }}`) and populating the `app.kubernetes.io/version` label. If your pipeline injects image tags at deploy time — the normal setup, per [CI/CD Pipeline Design](/operations/cicd-pipeline-design/) — `appVersion` is a comment. Keep it roughly honest, don't build process on it.

:::caution[The "nothing changed but the version" upgrade that changes everything]
A chart patch bump with a dependency *range* can still deploy a different system: `~19.6.0` resolved to 19.6.2 last month and 19.6.5 today. If a "no-op" chart upgrade produced a surprising diff, check `Chart.lock` first — the diff between old and new lock files is the real changelog. This is why the lock file lives in git and why `helm dependency build`, never `update`, runs in automation.
:::

## Where to go next

You can now read any chart's skeleton. The two deep dives from here: [The Template Language](/helm/template-language/) for everything inside `templates/` (using this same `web-service` chart), and [Values and Overrides](/helm/values-and-overrides/) for the values tree those templates consume. If you're evaluating a third-party chart right now, the reading order that works: `Chart.yaml` (deps and their ranges), `values.yaml` (the API), then templates only where a value's effect is unclear.
