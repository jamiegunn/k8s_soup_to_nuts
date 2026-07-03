---
title: kubectl Survival Kit
description: The 20% of kubectl that handles 95% of daily work — contexts, get/describe/logs/exec, selectors, jsonpath, rollout, debug, and a quick-reference table.
sidebar:
  order: 5
---

kubectl has dozens of subcommands and hundreds of flags. You need about fifteen of them, wielded well. This is the set that gets an app team through deploys, debugging, and incidents — every command here works with namespace-scoped access.

## Point it at the right place first

More production incidents start with "wrong cluster, wrong namespace" than anyone admits. Know where you're pointed:

```bash
kubectl config current-context                    # which cluster/user am I?
kubectl config get-contexts                       # what else is in my kubeconfig?
kubectl config use-context prod-east              # switch cluster
kubectl config set-context --current --namespace=payments   # default namespace
```

Install [`kubens` and `kubectx`](https://github.com/ahmetb/kubectx) if you juggle multiple namespaces or clusters — `kubens payments` beats the `set-context` incantation every time. And put the context+namespace in your shell prompt (`kube-ps1` or your prompt framework's builtin); it's the cheapest incident prevention you'll ever install.

:::danger[Verify before you delete]
Before any destructive command, run `kubectl config current-context`. Muscle memory does not distinguish staging from prod. Yours especially.
:::

## The core loop: get → describe → logs → exec

**`get`** answers "what exists and what state is it in":

```bash
kubectl get pods                                  # the reflex
kubectl get pods -o wide                          # + node, pod IP
kubectl get pods -w                               # watch changes live
kubectl get deploy,rs,pods                        # several kinds at once
kubectl get all                                   # common kinds (not actually all)
```

**`describe`** answers "why is it in that state" — status, conditions, and crucially **events** at the bottom. It's the single highest-value debugging command in Kubernetes:

```bash
kubectl describe pod my-app-7c9d8b6f5d-x2klp
```

**`logs`** — the flags that matter:

```bash
kubectl logs my-app-7c9d8b6f5d-x2klp                       # current container
kubectl logs my-app-7c9d8b6f5d-x2klp --previous            # the one that crashed
kubectl logs my-app-7c9d8b6f5d-x2klp -c istio-proxy        # specific container
kubectl logs -f deploy/my-app                              # follow, any pod of the deploy
kubectl logs deploy/my-app --since=10m --timestamps
kubectl logs -l app.kubernetes.io/name=my-app --prefix     # all matching pods
```

`--previous` is the one people forget: in a `CrashLoopBackOff`, the *current* container hasn't logged anything yet — the evidence is in the previous one.

**`exec`** — a shell (or one command) inside your running container:

```bash
kubectl exec -it my-app-7c9d8b6f5d-x2klp -- sh             # or bash if present
kubectl exec my-app-7c9d8b6f5d-x2klp -- env | sort         # one-shot
kubectl exec my-app-7c9d8b6f5d-x2klp -c app -- ls /config  # pick container
```

Minimal and distroless images may have no shell at all — that's what `kubectl debug` is for (below).

## port-forward, top, events

```bash
kubectl port-forward svc/my-app 8080:80        # localhost:8080 -> service port 80
kubectl port-forward pod/my-app-x2klp 5005:5005  # e.g. JVM debug port
```

Traffic goes through the API server — fine for debugging and admin UIs, wrong for load tests. Java teams live on this for [remote debugging](/java/remote-debugging/).

```bash
kubectl top pods                               # actual CPU/mem usage now
kubectl top pods --containers                  # per container
```

`top pods` shows *usage*; compare against *requests/limits* from `kubectl describe` to spot pods flirting with their memory limit. (`top nodes` typically needs cluster scope you don't have.)

```bash
kubectl get events --sort-by=.lastTimestamp | tail -20
kubectl get events --field-selector involvedObject.name=my-app-x2klp
kubectl get events --field-selector type=Warning -w      # live warning feed
```

Events expire after roughly an hour — capture them early in an incident. More in [Events](/observability/events/).

## Selectors: label and field

Label selectors (`-l`) are how you operate on "all pods of my app" instead of copy-pasting generated names:

```bash
kubectl get pods -l app.kubernetes.io/name=my-app
kubectl get pods -l 'app.kubernetes.io/name=my-app,app.kubernetes.io/component!=worker'
kubectl delete pods -l app.kubernetes.io/name=my-app     # they'll be recreated — cheap restart
```

Field selectors filter on object fields instead of labels:

```bash
kubectl get pods --field-selector status.phase=Failed
kubectl get pods --field-selector spec.nodeName=worker-7   # everything mine on that node
kubectl get pods --field-selector status.phase!=Running
```

Good labels make all of this work; [YAML, Labels, and Namespaces](/start/yaml-labels-and-namespaces/) covers the conventions.

## Reading the full object: -o yaml and -o jsonpath

`describe` is a curated summary. `-o yaml` is the whole truth, including everything defaulting and mutating webhooks added behind your back:

```bash
kubectl get deploy my-app -o yaml
kubectl get pod my-app-x2klp -o yaml | less
```

`-o jsonpath` extracts exactly one thing — invaluable in scripts and incident channels:

```bash
kubectl get deploy my-app -o jsonpath='{.spec.template.spec.containers[0].image}'
kubectl get pod my-app-x2klp -o jsonpath='{.status.podIP}'
kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\n"}{end}'
```

For anything more complex, pipe `-o json` into `jq` and keep your sanity.

## explain, diff, rollout

```bash
kubectl explain deployment.spec.strategy            # built-in field docs, offline
kubectl explain pod.spec.containers.resources --recursive
```

`explain` answers "what fields exist and what do they mean" without leaving the terminal — faster than the website, and always matching *your* cluster's API version.

```bash
kubectl diff -f deployment.yaml     # what would apply change? exit 1 = differences
```

Run `diff` before `apply` in anything resembling prod. It's also the fastest drift detector: if `diff` against your git manifest isn't empty, someone live-patched.

```bash
kubectl rollout status deploy/my-app        # block until rollout completes or stalls
kubectl rollout restart deploy/my-app       # rolling restart, no manifest change
kubectl rollout undo deploy/my-app          # back to previous ReplicaSet
kubectl rollout history deploy/my-app
```

`rollout restart` is the correct way to bounce an app (picks up rotated Secrets, clears wedged state) — details in [Restarts Without Redeploy](/operations/restarts-without-redeploy/), and the full rollout story in [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/).

## cp and debug — with caveats

```bash
kubectl cp my-app-x2klp:/tmp/heap.hprof ./heap.hprof
```

:::caution[kubectl cp requires tar in the image]
`kubectl cp` is a wrapper around `kubectl exec ... tar`. Distroless and minimal images often have no `tar`, and it fails with `exec: "tar": executable file not found`. Workarounds — `kubectl exec ... cat` redirection, ephemeral containers, sidecars — are covered in [Getting Dumps Out](/java/getting-dumps-out/).
:::

```bash
kubectl debug -it my-app-x2klp --image=busybox --target=app
```

`kubectl debug` attaches an **ephemeral container** to a running pod: your own toolbox image (busybox, netshoot) sharing the pod's network — and with `--target`, the target container's process namespace. It's the answer to "there's no shell in the image" and the centerpiece of the [Debugging Toolbox](/troubleshooting/debugging-toolbox/). Note: it may be disabled by policy in some clusters — if so, that's a platform team conversation.

## Quick reference

| Task | Command |
|---|---|
| Where am I pointed? | `kubectl config current-context` |
| Set default namespace | `kubectl config set-context --current --namespace=NS` |
| List my pods, with nodes | `kubectl get pods -o wide` |
| Why is this pod unhappy? | `kubectl describe pod POD` |
| Crashed container's logs | `kubectl logs POD --previous` |
| Follow app logs | `kubectl logs -f deploy/NAME` |
| Shell into container | `kubectl exec -it POD -- sh` |
| Tunnel to a service | `kubectl port-forward svc/NAME 8080:80` |
| Live CPU/memory | `kubectl top pods --containers` |
| Recent trouble in namespace | `kubectl get events --sort-by=.lastTimestamp \| tail -20` |
| All pods of my app | `kubectl get pods -l app.kubernetes.io/name=NAME` |
| Full object as stored | `kubectl get RES NAME -o yaml` |
| Extract one field | `kubectl get RES NAME -o jsonpath='{.spec...}'` |
| Field docs | `kubectl explain RES.spec.FIELD` |
| Preview a change | `kubectl diff -f file.yaml` |
| Wait for a deploy | `kubectl rollout status deploy/NAME` |
| Rolling restart | `kubectl rollout restart deploy/NAME` |
| Roll back | `kubectl rollout undo deploy/NAME` |
| Copy file out (needs tar) | `kubectl cp POD:/path ./local` |
| Toolbox into shell-less pod | `kubectl debug -it POD --image=busybox --target=CTR` |
| What am I allowed to do? | `kubectl auth can-i --list` |

Print it, or better: use each one once today. Fifteen commands, deliberately practiced, cover almost every day you'll have with Kubernetes — and the [triage methodology](/troubleshooting/triage-methodology/) sequences them for the bad days.
