---
title: Tips and Tricks
description: Shell setup, krew plugins, manifest scaffolding, kubectl wait, and the safety habits that keep prod incidents from starting at your keyboard.
sidebar:
  order: 4
---

No grand theory here — this is a stack of small, self-contained tricks. Each one saves seconds a dozen times a day or saves your bacon once a year. Steal freely.

## Shell setup

### `k` and completion that follows it

```bash
# ~/.zshrc (bash: swap in "source <(kubectl completion bash)" and use complete -o default -F __start_kubectl k)
alias k=kubectl
source <(kubectl completion zsh)
compdef k=kubectl        # completion works on the alias too
```

The alias without completion is half the trick — `k get po <TAB>` completing pod names is the actual payoff. Completion is context-aware: it queries the live cluster for names, so it also quietly confirms you're pointed where you think you are.

### One KUBECONFIG per terminal

Don't merge prod and non-prod into one `~/.kube/config`. Keep separate files and bind them per terminal:

```bash
# terminal 1 — staging work
export KUBECONFIG=~/.kube/staging.yaml
# terminal 2 — prod, deliberately
export KUBECONFIG=~/.kube/prod.yaml
```

Now `kubectl config use-context` in one terminal can't hijack the other, and closing the prod terminal ends prod access. This is the cheapest multi-cluster safety mechanism that exists. (How merging works and why it surprises people: [How kubectl Works](/kubectl/how-kubectl-works/).)

### Context and namespace in your prompt

[kube-ps1](https://github.com/jonmosco/kube-ps1) puts `(⎈ prod-team-a:team-a)` in your prompt. Install it, then go one further — **make prod scream**:

```bash
# after kube-ps1 setup, color the segment red when the context matches prod
kube_ps1_color() {
  case "$(kubectl config current-context 2>/dev/null)" in
    *prod*) echo "%F{red}%B" ;;   # red + bold
    *)      echo "%F{cyan}"  ;;
  esac
}
KUBE_PS1_SYMBOL_COLOR=""
PROMPT='$(kube_ps1_color)$(kube_ps1)%f%b $ '
```

A red prompt has stopped more wrong-cluster deletes than any policy document. If you do nothing else from this article, do this.

## krew: plugins for people without cluster admin

[krew](https://krew.sigs.k8s.io/) is kubectl's plugin manager. Key fact for this guide's audience: **plugins are client-side binaries** — installing one touches nothing in the cluster and needs no approval from anyone. They speak the same API with your same credentials, so RBAC still bounds what they can *see*, but installation is entirely your business.

Worth having:

| Plugin | What it does |
|---|---|
| `ctx` / `ns` | Switch context / namespace in two keystrokes, with fuzzy matching. The pair you'll use hourly. |
| `stern` | Tail logs across many pods at once (`stern web` follows every `web-*` pod, color-coded). Fills the biggest hole in `kubectl logs` — see [Logging Fundamentals](/observability/logging-fundamentals/). |
| `tree` | Show ownership hierarchy: Deployment → ReplicaSets → Pods. Instantly answers "which RS owns this pod?" |
| `neat` | Strip `managedFields`, `status`, defaulted noise from `-o yaml` — turns 300 lines into the 40 you wrote. |
| `view-secret` | Decode secret keys without the `base64 -d` dance. (Needs `get` on secrets — you may or may not have it.) |
| `access-matrix` | Table of what your identity can do per resource. The self-service answer to "what am I allowed to touch?" |
| `sniff` | Packet capture from a pod. Powerful, but needs privileged pod creation — in most locked-down setups this is platform-team territory. Know it exists; don't expect it to run. |

```bash
kubectl krew install ctx ns stern tree neat view-secret access-matrix
kubectl neat get pod web-6d4cf56db6-x8rjp -o yaml   # readable YAML, finally
```

## Scaffolding: never write boilerplate YAML again

`--dry-run=client -o yaml` turns every `create`/`run` generator into a manifest printer:

```bash
kubectl create deployment web --image=registry.example.com/team-a/web:1.42.0 \
  --replicas=3 --dry-run=client -o yaml > deploy.yaml
kubectl create cronjob nightly --image=busybox --schedule="0 3 * * *" \
  --dry-run=client -o yaml > cronjob.yaml
kubectl create configmap app-config --from-file=config/ --dry-run=client -o yaml
kubectl create service clusterip web --tcp=80:8080 --dry-run=client -o yaml
```

Correct apiVersion, correct structure, no browser, no copy-paste from a three-year-old repo. Scaffold, then edit.

Three relatives of the same idea:

```bash
# 1. Run a CronJob NOW instead of waiting for the schedule (the debugging classic)
kubectl create job nightly-manual-1 --from=cronjob/nightly

# 2. Throwaway debug pod: interactive, and garbage-collects itself on exit
kubectl run tmp-debug --rm -it --restart=Never --image=busybox:1.36 -- sh

# 3. Heredoc apply — tiny test manifests without touching the filesystem
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: quick-test
data:
  key: value
EOF
```

That `--rm -it --restart=Never` trio is worth memorizing exactly — `--restart=Never` makes it a bare Pod (not a Deployment), `--rm` deletes it when the shell exits. More debug-pod patterns in the [Debugging Toolbox](/troubleshooting/debugging-toolbox/); what to actually *do* once you're at that busybox prompt is [The BusyBox Toolkit](/troubleshooting/busybox/).

## `explain --recursive`: offline API docs

```console
$ kubectl explain deployment.spec.strategy
KIND:       Deployment
VERSION:    apps/v1
FIELD:      strategy <DeploymentStrategy>
DESCRIPTION:
     The deployment strategy to use to replace existing pods with new ones.
...

$ kubectl explain pod.spec.affinity --recursive | head -8
FIELDS:
  nodeAffinity  <NodeAffinity>
    preferredDuringSchedulingIgnoredDuringExecution       <[]PreferredSchedulingTerm>
      preference        <NodeSelectorTerm>
        matchExpressions        <[]NodeSelectorRequirement>
...
```

`--recursive` prints the entire field tree — the answer to "what's the exact nesting under `affinity` again?" without leaving the terminal. Crucially, it reads *your server's* schema, so it never describes fields your cluster version doesn't have — and it **works for CRDs too**: `kubectl explain application.spec` documents whatever the platform team installed, straight from the CRD's schema. See [CRDs Explained](/controllers/crds-explained/).

## `kubectl diff` — always, before apply

```console
$ kubectl diff -f deploy.yaml
--- /LIVE/apps.v1.Deployment.team-a.web
+++ /MERGED/apps.v1.Deployment.team-a.web
@@ -47,7 +47,7 @@
       containers:
       - image: registry.example.com/team-a/web:1.42.0
+      - image: registry.example.com/team-a/web:1.43.0
```

Exit code 0 = no changes, 1 = differences, >1 = error — scriptable as a CI gate. `diff` runs the server's merge logic against live state, so it also exposes **drift**: if the diff shows changes you didn't make, someone has been live-editing what CI owns ([Drift and CI/CD](/operations/drift-and-cicd/)). Applying without diffing is how "deploy the new image" quietly also reverts last week's hotfix.

## `kubectl wait`: kill your sleeps

Every `sleep 30 && kubectl ...` in a script is a race condition with a lucky streak. `wait` blocks on actual state:

```bash
kubectl wait --for=condition=Ready pod -l app=web --timeout=120s
kubectl wait --for=condition=Available deployment/web --timeout=180s
kubectl wait --for=delete pod/tmp-debug --timeout=60s
kubectl wait --for=condition=Complete job/nightly-manual-1 --timeout=15m
# arbitrary field, not just conditions:
kubectl wait --for=jsonpath='{.status.readyReplicas}'=3 deployment/web --timeout=120s
```

Non-zero exit on timeout, so `&&` chains and CI steps fail correctly. For deployments specifically, prefer the purpose-built version — it follows the rollout and reports *why* it's stuck:

```bash
kubectl rollout status deployment/web --watch --timeout=300s
```

That line belongs in every deploy pipeline; without it, CI reports success the moment manifests are *accepted*, not when pods are *running*. Details in [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/).

## Bulk operations with selectors

Mutating verbs take `-l` too — precise batch operations without a bash loop:

```bash
kubectl scale deployment -l team=payments --replicas=0        # scale down a whole slice
kubectl label pods -l app=web audit=2026-q3                   # tag many at once
kubectl annotate deployments -l app=web kubernetes.io/change-cause="bump to 1.43.0"
kubectl delete pods -l app=web,release=canary                 # exactly the canaries, nothing else
kubectl rollout restart deployment -l team=payments           # restart everything you own
```

Selector-based deletes are *safer* than name-based ones — the selector states intent, and there's no shell glob involved (see safety habits below).

## `--field-manager`: sign your CI's writes

Every write records who made it. Give your pipeline a real name:

```bash
kubectl apply -f manifests/ --server-side --field-manager=team-a-ci
```

Now `kubectl get deploy web --show-managed-fields -o yaml` shows which fields `team-a-ci` owns versus what some human's `kubectl-edit` touched — turning "who changed this?" from archaeology into a lookup, and making server-side apply conflicts (`conflict with "kubectl-edit"...`) actually mean something. Full story in [Drift and CI/CD](/operations/drift-and-cicd/).

## Second terminal: events during every deploy

```bash
kubectl get events -w --field-selector=type=Warning
```

Run that in a side terminal while your deploy rolls. Failed scheduling, image pull errors, failed probes, OOM kills — they all surface here minutes before they're obvious anywhere else. It's the closest thing kubectl has to a tail of the cluster's inner monologue. Why events work this way: [Events](/observability/events/).

## Safety habits

Habits, not tools — the point is doing them *every time*.

**`--context` on every prod command.** Explicit beats ambient:

```bash
kubectl --context prod -n team-a rollout status deployment/web
```

The command is now self-documenting, safe to paste from your history, and immune to whatever `current-context` happens to be. Bonus: `alias kprod='kubectl --context prod -n team-a'` makes the safe form the *short* form.

**Never bare `kubectl delete` with shell globs.** `kubectl delete pod web-*` looks scoped — but if the glob matches a local file, or matches nothing and your shell passes it through literally, you get behavior you didn't sign up for. Resolve first, review, then delete:

```bash
kubectl get pods -l app=web -o name     # look at exactly what matched
kubectl get pods -l app=web -o name | xargs kubectl delete
```

**Backup before mutate.** Before any `edit`, `patch`, or `scale` on something that matters:

```bash
kubectl get deploy web -o yaml > /tmp/web.$(date +%s).yaml
```

Two seconds of typing buys you a guaranteed rollback path even when `rollout undo` can't help (it won't restore labels, annotations, or things that aren't Deployments). This habit is load-bearing for everything in [Live Patching](/operations/live-patching/).

:::danger[The three-question pre-flight]
Before any mutating command in prod: **Which context?** (it's in the prompt — you set that up, right?) **What will it match?** (run the `get` form of the same selector first.) **How do I undo it?** (if the answer is "uh", stop and take the `-o yaml` backup.) Thirty seconds, every time, forever.
:::

## Muscle-memory drills

Ten commands to practice until your fingers know them. If any requires a search engine, drill it this week:

1. `kubectl config get-contexts` → `kubectl ctx` — know where you are, switch deliberately.
2. `kubectl create deployment x --image=nginx --dry-run=client -o yaml` — scaffold anything.
3. `kubectl run tmp --rm -it --restart=Never --image=busybox -- sh` — throwaway debug pod.
4. `kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.nodeName}{"\n"}{end}'` — JSONPath under pressure.
5. `kubectl get pods --sort-by=.metadata.creationTimestamp` — what changed recently.
6. `kubectl diff -f deploy.yaml` — before every apply, no exceptions.
7. `kubectl rollout status deployment/web --watch` and `kubectl rollout undo deployment/web` — the deploy pair.
8. `kubectl wait --for=condition=Ready pod -l app=web --timeout=120s` — delete a sleep from a script today.
9. `kubectl get events -w --field-selector=type=Warning` — the deploy-day side terminal.
10. `kubectl auth can-i --list` — know your own permissions before you hit the wall ([RBAC Denied](/troubleshooting/rbac-denied/)).

Run the drill list once a week for a month. After that, it's just how you type.
