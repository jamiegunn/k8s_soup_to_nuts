---
title: kubectl Mastery
description: Why kubectl is an API client, not a magic wand — and a map of the deep dives that will make every command make sense.
keywords:
  - kubectl is a fancy curl
  - kubectl is an API client
  - forbidden cannot list resource pods rbac
  - kubectl proxy curl api server
  - pods vs pods/exec subresource rbac
  - get vs list verb difference
  - kubectl command maps to http request
  - cluster state is the only state no undo
  - scaffold cronjob dry-run
  - kubectl wait rollout status ready
  - self-assessment kubectl skills
sidebar:
  order: 1
---

The [kubectl survival kit](/start/kubectl-survival-kit/) covers the daily 20%: get, describe, logs, exec, apply. If you only ever learn that, you'll be fine — right up until the day a command hangs for thirty seconds, or returns something forbidden you *know* you should be allowed to see, or you need the image of every container in the namespace and you're clicking through `describe` output pod by pod like it's 2015.

This section is the deep end. Three articles, each self-contained, each answering a different flavor of "kubectl, but properly":

## The map

| Article | What it answers | Read it when |
|---|---|---|
| [How kubectl Actually Works](/kubectl/how-kubectl-works/) | What happens between pressing Enter and seeing output: kubeconfig, auth plugins, API discovery, verbosity levels, server-side vs client-side. | kubectl is slow, weird, or lying to you — or ideally, *before* that. |
| [Output and Queries](/kubectl/output-and-queries/) | Getting exactly the data you want: JSONPath from zero to real, custom-columns, sort-by, label and field selectors, and when to pipe to `jq`. | You're eyeballing `describe` output for the fourth pod in a row. |
| [Tips and Tricks](/kubectl/tips-and-tricks/) | Shell setup, krew plugins that need no cluster install, manifest scaffolding, `kubectl wait`, and prod safety habits. | Today. It's the fastest payoff of the three. |

Read them in order the first time — the second and third assume the mental model the first one builds. After that they're references; each section stands alone.

## Self-assessment: can you do these 8 things without a search engine?

Be honest — nobody's grading you, but the gaps predict exactly which incident will hurt. Each item maps to a section in this chapter.

**1. Explain what file kubectl read to decide which cluster to talk to** — and what happens when `KUBECONFIG` lists three files that all define a context named `dev`.

*Why it matters:* the answer ("first file in the list wins, silently") is behind a whole genre of deployed-to-the-wrong-cluster stories. Covered in [How kubectl Works](/kubectl/how-kubectl-works/).

**2. Show the exact HTTP request kubectl sent** for `kubectl get pods`, including the URL and response code — no proxy, no tcpdump.

*Why it matters:* this is one flag (`-v=6`), and it converts every vague kubectl complaint into a concrete, actionable fact.

**3. Predict the URL** for `kubectl get deploy my-app -n team-a` before running it.

*Why it matters:* if you said something containing `/apis/apps/v1/namespaces/team-a/deployments/my-app`, you understand API discovery, and RBAC error messages will never confuse you again.

**4. List the image of every container in the namespace, one per line**, using only kubectl — no grep, no awk.

*Why it matters:* "what is actually running right now?" is the first question in half of all incidents. [Output and Queries](/kubectl/output-and-queries/) builds this from scratch.

**5. Find every pod that has restarted more than 3 times**, sorted worst-first.

*Why it matters:* restart counts are the cheapest health signal you have, and the data is already in every `get pods` response — you just have to know how to ask.

**6. Explain the difference between `--dry-run=client` and `--dry-run=server`** — which one catches a bad field name, which one catches an admission-webhook rejection, and which one needs cluster connectivity.

*Why it matters:* the gap between the two is exactly the gap between "worked on my machine" and "rejected by CI."

**7. Scaffold a complete, valid CronJob manifest in under 15 seconds** without opening a browser or copying from an old repo.

*Why it matters:* copied YAML carries copied mistakes. Generators produce correct, current-apiVersion skeletons every time. [Tips and Tricks](/kubectl/tips-and-tricks/).

**8. Block a CI script until a Deployment's new pods are actually Ready**, with a timeout and a non-zero exit code on failure — no `sleep 30` allowed.

*Why it matters:* every `sleep` in a deploy script is a race condition with a lucky streak, and the luck runs out during the demo.

Scored 8/8? Skim the articles anyway — the war stories in the margins are where the value is. Scored 4 or less? Good. That's exactly who this section is for, and none of the eight takes more than ten minutes to learn.

## The philosophy: kubectl is an API client

Here is the single most useful mental model in this entire guide:

> **kubectl is a fancy `curl`.** Every command is an HTTP request to the Kubernetes API server. Nothing more.

There is no side channel, no SSH into nodes, no privileged backdoor, no state on your laptop that the cluster cares about. When you run `kubectl get pods`, kubectl:

1. Reads your kubeconfig to find the server URL and your credentials.
2. Sends `GET https://<api-server>/api/v1/namespaces/<ns>/pods`.
3. Pretty-prints the JSON that comes back.

You can watch it do exactly that:

```console
$ kubectl get pods -v=6 2>&1 | grep round_trippers
I0703 09:14:22.101884   41233 round_trippers.go:553] GET https://api.prod.example.com:6443/api/v1/namespaces/team-a/pods?limit=500 200 OK in 87 milliseconds
```

And you can bypass kubectl entirely to prove there's nothing special about it:

```console
$ kubectl proxy --port=8001 &
$ curl -s localhost:8001/api/v1/namespaces/team-a/pods | head -4
{
  "kind": "PodList",
  "apiVersion": "v1",
  "metadata": {
```

Same data. kubectl's entire job is assembling that request and formatting that response.

### Why this model pays rent

**Every error becomes legible.** A `Forbidden` isn't kubectl being moody — it's [RBAC denying a specific verb on a specific resource](/troubleshooting/rbac-denied/):

```console
$ kubectl get pods -n team-b
Error from server (Forbidden): pods is forbidden: User "alice" cannot list resource "pods" in API group "" in the namespace "team-b"
```

Read as coordinates — verb `list`, resource `pods`, group core, namespace `team-b` — that message *is* the access request you need to file, phrased in the exact vocabulary your platform team's RBAC manifests use.

**Every command becomes predictable.** Once you know `get deploy` maps to a GET on `/apis/apps/v1/...`, the verb zoo collapses into REST:

| kubectl | HTTP |
|---|---|
| `get deploy web` | `GET .../deployments/web` |
| `get deploy` | `GET .../deployments` (different RBAC verb: `list`!) |
| `delete deploy web` | `DELETE .../deployments/web` |
| `edit deploy web` | `GET`, open editor, then `PATCH` |
| `apply -f ...` | `PATCH` with a merge content-type (or `POST` if new) |
| `logs`, `exec` | `GET`/`POST` on pod *subresources* — which is why they're separate RBAC grants |

That last row explains a classic confusion: you can `get` a pod but not `exec` into it, because `pods` and `pods/exec` are different resources to the API. The model predicted it.

**Nothing is kubectl-exclusive, and nothing is your laptop's fault.** Anything kubectl does, your CI pipeline, a Go client, or a `curl` with the right token can do. And anything kubectl *can't* do isn't a client limitation — it's an API or RBAC boundary, which tells you whose problem it is and what to write in the ticket.

### The corollary: the cluster state is the only state

Because kubectl is stateless, there is no "kubectl remembers." No undo buffer, no local record of what you deleted, no history of what a resource looked like before your patch (Deployments keep rollout history *server-side*; most other resources keep nothing — hence the backup-before-mutate habit in [Tips and Tricks](/kubectl/tips-and-tricks/)). If you need a paper trail, you create it: `-o yaml` snapshots, annotations, and a CI pipeline that is the source of truth. This is also the deep reason live edits and pipelines fight each other — two clients writing to the same API with no coordination. That war has its own article: [Drift and CI/CD](/operations/drift-and-cicd/).

:::note[Where your permissions end]
Everything in this section works within namespace-scoped access. Where a technique needs cluster-scoped rights — reading node objects, listing across all namespaces, hitting raw endpoints like `/healthz` — we say so explicitly, so you know when a failure is your syntax and when it's your RBAC. See [Working Without Admin](/start/working-without-admin/) for the general survival posture.
:::

## Quiz answer key

Check yourself, then go read the article that explains *why* each answer works — the one-liner is the least interesting part.

**1. Which config, and who wins?**

```bash
kubectl config view --minify         # exactly what the current context resolves to
echo "$KUBECONFIG"                   # merge order; earlier files win name conflicts
```

**2. See the actual HTTP request:**

```bash
kubectl get pods -v=6 2>&1 | grep round_trippers
# GET https://api.../api/v1/namespaces/team-a/pods?limit=500 200 OK in 87 milliseconds
```

**3. The URL for a namespaced, non-core resource:**

```text
/apis/<group>/<version>/namespaces/<ns>/<resource>/<name>
/apis/apps/v1/namespaces/team-a/deployments/my-app
```

**4. Every image, one per line:**

```bash
kubectl get pods -o jsonpath='{range .items[*]}{.spec.containers[*].image}{"\n"}{end}'
```

**5. Restart leaderboard:**

```bash
kubectl get pods --sort-by='.status.containerStatuses[0].restartCount' \
  -o custom-columns='NAME:.metadata.name,RESTARTS:.status.containerStatuses[*].restartCount'
# worst offenders print last; filtering ">3" precisely is a jq job — see the article
```

**6. Dry-run split, in one breath:** `client` = local parse and basic structure checks, no network, catches typos; `server` = full API pipeline (validation, defaulting, admission webhooks) with nothing persisted, needs connectivity and the same RBAC as a real write. The webhook rejection only shows up with `server`.

**7. Scaffold a CronJob:**

```bash
kubectl create cronjob nightly --image=busybox --schedule="0 3 * * *" \
  --dry-run=client -o yaml > cronjob.yaml
```

**8. Block CI until Ready, with timeout and honest exit code:**

```bash
kubectl rollout status deployment/web --watch --timeout=300s
# or, for arbitrary pods:
kubectl wait --for=condition=Ready pod -l app=web --timeout=120s
```

If any answer surprised you, that's your reading order sorted.

## One habit to start today

Before reading any further: next time a kubectl command surprises you — too slow, wrong result, weird error — rerun it with `-v=6`. That single flag turns "kubectl is broken" into "the API returned 403 on this exact URL," and the second statement is one you can actually act on.

The rest of this section builds on that reflex. Start with [How kubectl Actually Works](/kubectl/how-kubectl-works/).
