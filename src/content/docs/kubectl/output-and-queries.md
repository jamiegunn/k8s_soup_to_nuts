---
title: Output and Queries
description: Extract exactly the data you want from kubectl — JSONPath, custom-columns, sort-by, label and field selectors, and jq recipes for everything else.
keywords:
  - list all container images in namespace
  - jsonpath range items end newline tab
  - custom-columns and custom-columns-file
  - kubectl sort-by restart count
  - field label not supported field-selector
  - label selector in notin key exists
  - escaping dots in annotation keys jsonpath
  - kubectl get -o json pipe jq recipes
  - find containers without resource limits
  - output-watch-events added modified deleted
  - go-template when no jq available
  - group pods by node
sidebar:
  order: 3
---

The API server returns full JSON objects. The default table shows you six columns of it. Everything in between — "give me every image in the namespace", "which pods restarted overnight", "map pods to nodes" — is a query problem, and kubectl has three escalating tools for it: output flags, JSONPath/custom-columns, and (when those run out) `jq`. This article builds all three up from zero.

## The output flags you already half-know

```bash
kubectl get pods -o wide     # + node, IP, nominated node, readiness gates
kubectl get pod web -o yaml  # the whole object, as the server stores it
kubectl get pod web -o json  # same, as JSON — this is what jq eats
kubectl get pods -o name     # "pod/web-6d4cf56db6-x8rjp" — built for xargs
```

`-o yaml` is your ground truth. Every JSONPath expression below is just a path into that document — when a query returns nothing, `-o yaml` the object and find where the field actually lives. (Half of all JSONPath failures are guessed field names.)

## JSONPath from zero

Syntax essentials, in the order you'll need them:

```text
{.metadata.name}                 field access
{.spec.containers[0].image}      array index
{.spec.containers[*].image}      all elements
{range .items[*]} ... {end}      iterate a list, emit per item
{"\n"} {"\t"}                    literal newline / tab (quoted strings)
{.items[?(@.status.phase=="Running")]}   filter: @ = current element
```

Two structural facts to internalize:

1. **`kubectl get pods` returns a List** — your pods live under `.items[*]`. `kubectl get pod web` returns a single object — no `.items`. The same query needs different roots depending on which you ran.
2. **Bare `{.items[*].field}` prints values space-separated on one line.** For anything scriptable you want `range`/`end` with explicit `{"\n"}`.

Now the build-up. Eight real queries, each introducing one idea.

**1. All images in the namespace, one per line** (the classic):

```console
$ kubectl get pods -o jsonpath='{range .items[*]}{.spec.containers[*].image}{"\n"}{end}'
registry.example.com/team-a/web:1.42.0
registry.example.com/team-a/worker:1.42.0
redis:7.2-alpine
```

**2. Pod → node mapping** (multi-field lines: several paths per iteration, tab-separated):

```console
$ kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.nodeName}{"\n"}{end}'
web-6d4cf56db6-x8rjp    ip-10-40-3-112.ec2.internal
web-6d4cf56db6-zk4mn    ip-10-40-1-87.ec2.internal
worker-7f9b8c-p2v6l     ip-10-40-3-112.ec2.internal
```

**3. Restart counts** (status lives in a *parallel* array to spec — `containerStatuses`, not `containers`):

```bash
kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[*].restartCount}{"\n"}{end}'
```

**4. Container states — what's actually running vs waiting**:

```console
$ kubectl get pod web-6d4cf56db6-x8rjp -o jsonpath='{range .status.containerStatuses[*]}{.name}{"\t"}{.state}{"\n"}{end}'
web     {"running":{"startedAt":"2026-07-03T06:12:44Z"}}
sidecar {"waiting":{"message":"back-off 5m0s restarting failed container...","reason":"CrashLoopBackOff"}}
```

(Note: single pod, so the root is `.status`, not `.items[*]`.)

**5. PVC name → requested size**:

```bash
kubectl get pvc -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.resources.requests.storage}{"\n"}{end}'
```

**6. Filtering with `?(@...)`** — names of pods that are Running:

```bash
kubectl get pods -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\n"}{end}'
```

**7. The Ready condition** — filter *inside* a nested array. Conditions are a list; pick the one whose `type` is `Ready`:

```console
$ kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}'
web-6d4cf56db6-x8rjp    True
worker-7f9b8c-p2v6l     False
```

**8. Escaping dots in keys** — annotation and label keys contain dots, which JSONPath reads as path separators. Escape them with `\.`:

```bash
kubectl get pod web-6d4cf56db6-x8rjp \
  -o jsonpath='{.metadata.annotations.kubectl\.kubernetes\.io/last-applied-configuration}'
```

(In zsh/bash single quotes, `\.` passes through as-is. This one bites everyone the first time.)

:::caution[Where kubectl JSONPath ends]
kubectl's JSONPath dialect has **no logic**: no `&&`/`||` across different fields, no arithmetic, no "does this key exist" test, no sorting. Filters compare one field against one literal, full stop. When your query outgrows that, don't fight it — jump to `jq` below. Knowing when to bail is part of mastery.
:::

## custom-columns: the readable alternative

Same path language, table output, headers included — better for humans and for sharing in an incident channel:

```console
$ kubectl get pods -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeName,RESTARTS:.status.containerStatuses[*].restartCount,IMAGE:.spec.containers[*].image'
NAME                   NODE                          RESTARTS   IMAGE
web-6d4cf56db6-x8rjp   ip-10-40-3-112.ec2.internal   0          registry.example.com/team-a/web:1.42.0
worker-7f9b8c-p2v6l    ip-10-40-3-112.ec2.internal   14         registry.example.com/team-a/worker:1.42.0
```

Note: no `.items[*]` prefix — custom-columns iterates the list for you. For a query you run daily, put it in a file and check it into your repo:

```text
# podinfo.cols
NAME          RESTARTS                                  NODE            READY
metadata.name status.containerStatuses[*].restartCount  spec.nodeName   status.conditions[?(@.type=="Ready")].status
```

```bash
kubectl get pods -o custom-columns-file=podinfo.cols
```

## sort-by

`--sort-by` takes a JSONPath and works with any output format:

```bash
kubectl get pods --sort-by=.metadata.creationTimestamp            # oldest first — "what changed recently?" read from the bottom
kubectl get pods --sort-by='.status.containerStatuses[0].restartCount'   # crashiest last
kubectl get events --sort-by=.lastTimestamp                        # the only sane way to read events
```

That last one should be reflex — raw `kubectl get events` ordering is close to useless. More in [Events](/observability/events/).

## Label selectors, properly

Beyond `-l app=web` there's a whole expression language:

```bash
kubectl get pods -l app=web                          # equality
kubectl get pods -l app!=web                         # inequality
kubectl get pods -l 'environment in (staging,qa)'    # set membership
kubectl get pods -l 'tier notin (frontend)'          # set exclusion
kubectl get pods -l release                          # key exists
kubectl get pods -l '!release'                       # key absent (quote the !)
kubectl get pods -l 'app=web,tier!=canary,release'   # comma = AND (no OR exists)
```

Selectors work on every namespaced resource and on mutating verbs too — `kubectl delete pod -l app=web,release=canary` is precise in a way glob-based deletion never is. Labeling discipline pays off exactly here; see [YAML, Labels, and Namespaces](/start/yaml-labels-and-namespaces/).

## Field selectors: narrower, but server-side

`--field-selector` filters on *object fields* — but only the handful the API server indexes. For pods, realistically: `status.phase`, `spec.nodeName`, `metadata.name`, `metadata.namespace`, `status.podIP`. For events: `involvedObject.name`, `reason`, `type`. Everything else returns `field label not supported`.

```bash
kubectl get pods --field-selector=status.phase=Failed              # the cleanup classic
kubectl get pods --field-selector=spec.nodeName=ip-10-40-3-112.ec2.internal -l app=web   # combine with -l freely
kubectl get events --field-selector=involvedObject.name=web-6d4cf56db6-x8rjp
```

Why bother when jq can filter anything? Field selectors filter **on the server** — on a namespace with thousands of pods, that's the difference between shipping 40 MB of JSON to your laptop and shipping 200 KB.

## When to give up on JSONPath: jq

Rule of thumb: one field with maybe one filter → JSONPath. Grouping, counting, existence tests, multi-condition logic → `-o json | jq`. Six recipes that earn their keep:

**Group pods by node:**

```bash
kubectl get pods -o json | jq -r 'reduce .items[] as $p ({}; .[$p.spec.nodeName] += [$p.metadata.name])'
```

**Find containers without resource limits** (the pre-quota-audit — JSONPath cannot do "field is missing"):

```console
$ kubectl get pods -o json | jq -r '.items[] | .metadata.name as $pod | .spec.containers[] | select(.resources.limits == null) | "\($pod)/\(.name)"'
worker-7f9b8c-p2v6l/worker
worker-7f9b8c-p2v6l/sidecar
```

**Images by count** (what's actually deployed, deduplicated):

```bash
kubectl get pods -o json \
  | jq -r '[.items[].spec.containers[].image] | group_by(.) | map({image: .[0], count: length}) | sort_by(-.count)[] | "\(.count)\t\(.image)"'
```

**Pod conditions as a table:**

```bash
kubectl get pods -o json \
  | jq -r '.items[] | .metadata.name as $n | .status.conditions[] | [$n, .type, .status, .reason // "-"] | @tsv' | column -t
```

**Pods not fully ready, with the reason** (multi-field logic):

```bash
kubectl get pods -o json | jq -r '.items[]
  | select([.status.containerStatuses[]? | .ready] | all | not)
  | "\(.metadata.name): \([.status.containerStatuses[] | select(.ready|not) | .state | keys[0]] | join(","))"'
```

**Restart leaderboard across all containers:**

```bash
kubectl get pods -o json \
  | jq -r '.items[] | {p: .metadata.name, r: ([.status.containerStatuses[]?.restartCount] | add // 0)} | select(.r > 0) | "\(.r)\t\(.p)"' | sort -rn
```

These belong in your [debugging toolbox](/troubleshooting/debugging-toolbox/) — alias the ones you use twice.

:::note[go-template exists too]
`-o go-template` is kubectl's third query language — Go template syntax with `if`/`else`, `len`, variables. It can express logic JSONPath can't *without* leaving kubectl (useful on locked-down bastion hosts with no jq). If you have jq available, jq is easier to write, read, and debug; keep go-template in your back pocket for jq-less environments.
:::

## Scripting pipelines: `-o name` and `--no-headers`

```bash
# -o name emits type/name — the format other kubectl commands accept
kubectl get pods -l app=web -o name | xargs -I{} kubectl annotate {} audit/checked=true

# --no-headers for awk-friendly tables
kubectl get pods --no-headers | awk '$3=="CrashLoopBackOff" {print $1}'

# both: quiet existence check
[ -n "$(kubectl get pods -l app=web -o name --no-headers 2>/dev/null)" ] && echo "pods exist"
```

`-o name` beats parsing the NAME column: it's unambiguous (`pod/web` vs `deployment/web`) and stable across kubectl versions, while human-table column layouts are not a compatibility promise.

## Watching: `-w` and watch events

```bash
kubectl get pods -w                      # initial list, then a new line per change
kubectl get pods -w --output-watch-events   # prefixes each line with ADDED/MODIFIED/DELETED
```

```console
$ kubectl get pods -w --output-watch-events -l app=web
EVENT      NAME                   READY   STATUS              RESTARTS   AGE
ADDED      web-6d4cf56db6-x8rjp   1/1     Running             0          2d
ADDED      web-79c4d7f7b4-m2wlp   0/1     ContainerCreating   0          1s
MODIFIED   web-79c4d7f7b4-m2wlp   1/1     Running             0          6s
MODIFIED   web-6d4cf56db6-x8rjp   1/1     Terminating         0          2d
DELETED    web-6d4cf56db6-x8rjp   0/1     Terminating         0          2d
```

`--output-watch-events` matters because plain `-w` can't distinguish "pod modified" from "pod deleted and replaced" — during a rollout that's exactly the distinction you care about ([Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/)). `-w` combines with `-o` too: `kubectl get pods -w -o custom-columns=...` gives you a live feed of exactly your columns. One caveat for scripts: watches are dropped by the server periodically (connection timeouts, API server restarts) — a `-w` pipe into a long-running script needs a retry loop around it.

## Choosing the tool

| Need | Reach for |
|---|---|
| One field, quick look | `-o jsonpath='{...}'` |
| Human-readable multi-column, repeated daily | `custom-columns(-file)` |
| Ordering | `--sort-by` |
| Subsetting by labels/phase/node | `-l`, `--field-selector` (server-side) |
| Logic, grouping, missing-field tests | `-o json \| jq` |
| No jq on the box | `-o go-template` |
| Feeding other commands | `-o name`, `--no-headers` |
