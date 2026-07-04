---
title: "Lab 5: Break It, Then Fix It"
description: Six one-command breakages injected into your own lab stack — read each symptom cold, run the matching troubleshooting playbook, fix the cluster, and prove it whole again.
sidebar:
  order: 7
---

Every lab so far broke something on purpose, but always with the lab narrating over your shoulder. This one takes the narration away. Six times in a row you'll injure the stack with a single command, then face what an on-call engineer faces: a symptom, a cluster full of clues, and a playbook. The playbooks are this site's [troubleshooting section](/troubleshooting/triage-methodology/) — and the entire point of this lab is to run them against a real, broken cluster until the moves are muscle memory instead of reading.

**What you'll have at the end:** the same healthy stack you started with — plus six completed break-fix drills covering image pulls, missing Secrets, readiness failures, OOM kills, selector drift, and stuck init containers, each diagnosed by playbook rather than by peeking at the injection.

## Prerequisites

- [Lab 0](/labs/lab-0-cluster/) through [Lab 4](/labs/lab-4-ingress-end-to-end/) completed, **without** Lab 4's teardown: releases `orders` (image `orders-api:0.3.0`, 2 replicas) and `cache` in the `labs` namespace, ingress-nginx in its own namespace on NodePort 30080, and `http://orders.localtest.me:30080` answering. (If you did tear down, rerun Lab 4's install steps — the charts in `~/k8s-labs/` make it a ten-minute rebuild.)
- If you paused between sittings, revive everything (the last command should show `lima-k3s … Ready`):

```bash
limactl start docker && limactl start k3s
export DOCKER_HOST="unix://$HOME/.lima/docker/sock/docker.sock"
export KUBECONFIG="$HOME/.lima/k3s/copied-from-guest/kubeconfig.yaml"
kubectl get nodes
```

All commands run from `~/k8s-labs/`, with `kubectl` defaulting to the `labs` namespace. Keep two terminals open — one to watch, one to act.

## 1. The drill discipline

Every drill runs the same five moves, and the order is the lesson:

1. **Inject** — one command breaks something.
2. **Observe** — see the symptom the way a user or a dashboard would, *before* touching kubectl.
3. **Triage** — follow the matching playbook's first moves, literally. No guessing; [Triage Methodology](/troubleshooting/triage-methodology/) step 3 is "read the actual error", and each drill practices it.
4. **Fix** — the smallest correct repair.
5. **Verify** — prove the stack is whole before the next drill. Never stack breakages.

First, a baseline so "whole" has a definition:

```bash
kubectl get pods
curl -s -o /dev/null -w '%{http_code}\n' http://orders.localtest.me:30080/api/orders/1001
```

```console
NAME                           READY   STATUS    RESTARTS   AGE
cache-valkey-7d9c6b5f4-x2m8k   1/1     Running   0          3d
orders-api-7c9f6d8b5-k4mzn     1/1     Running   0          2d
orders-api-7c9f6d8b5-p8wlj     1/1     Running   0          2d
200
```

Three pods, all `1/1`, a `200` at the front door. That's the state every drill must end in.

## 2. Drill 1: the tag that never existed

The most common deploy failure in the wild is also the simplest: shipping an image tag that doesn't exist — a typo, or CI hasn't pushed yet.

**Inject:**

```bash
helm upgrade orders charts/orders-api --reuse-values --set image.tag=0.9.9-nope
```

```console
Release "orders" has been upgraded. Happy Helming!
```

**Observe** — note that Helm said *success*. Helm's job ended at the API server; the failure belongs to the kubelet, seconds later:

```bash
kubectl get pods
```

```console
NAME                           READY   STATUS             RESTARTS   AGE
orders-api-5f9d8c7b6-tq2xv     0/1     ImagePullBackOff   0          40s
orders-api-7c9f6d8b5-k4mzn     1/1     Running            0          2d
orders-api-7c9f6d8b5-p8wlj     1/1     Running            0          2d
```

Meanwhile `curl` still returns `200` — the rolling update won't kill ready pods until their replacements are ready, so the bad image is stranded at the gate while the old pods keep serving.

**Triage** — the [ImagePullBackOff playbook](/troubleshooting/imagepullbackoff/) opens with: *the pull error message tells you which failure mode you have — don't skip it.* Its first move:

```bash
kubectl describe pod orders-api-5f9d8c7b6-tq2xv | grep -A4 "Failed"
```

```console
  Warning  Failed  35s (x3 over 90s)  kubelet  Failed to pull image "orders-api:0.9.9-nope": failed to pull and unpack image "docker.io/library/orders-api:0.9.9-nope": failed to resolve reference "docker.io/library/orders-api:0.9.9-nope": pull access denied, repository does not exist or may require authorization
```

Two decodes, per the playbook's message table. First, `docker.io/library/` — you never mentioned Docker Hub; a bare image name defaults there. Your image only ever existed inside the node's containerd store (via `k3s ctr images import`), and only the tags you imported. `IfNotPresent` found no `0.9.9-nope` locally, so the kubelet went to the registry — where no such repository lives. Second, the registry's answer is the "that image doesn't exist" family: Docker Hub says `pull access denied / repository does not exist` for unknown repos; a registry where the repo exists but the *tag* doesn't says `manifest unknown`. Different strings, same row in the [decode table](/troubleshooting/imagepullbackoff/) and the [Error Index](/troubleshooting/error-index/): typo, unpushed build, or deleted tag.

**Fix** — this is a bad *release*, and Helm keeps every release you've ever shipped: run `helm history orders` and the injection sits at the top as the `deployed` revision, with everything before it `superseded` but retrievable. `helm rollback` with no revision number returns to the previous one (name a revision to jump further back):

```bash
helm rollback orders
kubectl rollout status deploy/orders-api
```

```console
Rollback was a success! Happy Helming!
deployment "orders-api" successfully rolled out
```

**Verify:** `kubectl get pods` shows two `orders-api` pods `1/1`, and the curl returns `200`.

**Lesson:** a bad tag can't hurt you mid-rollout — the stalled update is a feature — but it will hurt you at 3am when a node restart tries to re-pull; never leave a release pointing at an image that doesn't exist.

## 3. Drill 2: the vanished Secret

You met this failure in Lab 3 with the lab narrating every step. This time, run it as an incident — the goal is the lookup habit, not the answer.

**Inject:**

```bash
kubectl delete secret cache-auth
kubectl rollout restart deploy/orders-api
```

**Observe:**

```bash
kubectl get pods
```

```console
NAME                           READY   STATUS                       RESTARTS   AGE
orders-api-6d8f7c9b4-w9xkq     0/1     CreateContainerConfigError   0          20s
orders-api-7c9f6d8b5-k4mzn     1/1     Running                      0          2d
orders-api-7c9f6d8b5-p8wlj     1/1     Running                      0          2d
```

**Triage** — the habit to build here: take the **literal string** on your screen to the [Error Index](/troubleshooting/error-index/), which maps exact error text to the playbook that fixes it. `CreateContainerConfigError` lands in the "won't start" table: the kubelet couldn't *assemble* the container — an env var or volume references a ConfigMap or Secret that doesn't exist. Since the container never existed, there are no logs to read; `describe` is the only witness (which is why [Triage Methodology](/troubleshooting/triage-methodology/) puts `describe` before `logs`):

```bash
kubectl describe pod orders-api-6d8f7c9b4-w9xkq | tail -3
```

```console
  Warning  Failed  12s (x4 over 50s)  kubelet  Error: secret "cache-auth" not found
```

Read it literally: not "wrong password", not "permission denied" — the Secret is *gone*. Cross-check the claim: `kubectl get secret cache-auth` → `Error from server (NotFound)`.

**Fix** — recreate the dependency; no redeploy needed:

```bash
kubectl create secret generic cache-auth --from-literal=password=labs-cache-pw
kubectl rollout status deploy/orders-api
```

```console
deployment "orders-api" successfully rolled out
```

The kubelet retries container creation on a loop; the moment the Secret exists, the stuck pod assembles itself and the rollout completes on its own.

**Verify:** all pods `1/1`, curl returns `200`.

**Lesson:** the kubelet is a reconciliation loop — some failures need no redeploy at all, just the missing dependency restored, and `describe` tells you exactly which one.

## 4. Drill 3: 503s at the front door

Lab 4 broke readiness while you watched from the inside. This time start where real incidents start: at the edge, with a status code and nothing else. First, get a user's-eye view running in your watch terminal:

```bash
while true; do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://orders.localtest.me:30080/api/orders/1001)
  echo "$(date '+%H:%M:%S') $code"
  sleep 0.5
done
```

**Inject** (in your action terminal — the values key is the probe block from Lab 1; adjust if yours differs):

```bash
helm upgrade orders charts/orders-api --reuse-values --set probes.readiness.path=/nope
```

**Observe** — within a couple of minutes the loop degrades from `200` to `503`. That number alone is a diagnosis waiting to be read.

**Triage** — the [front-door 5xx playbook](/troubleshooting/front-door-5xx/) opens with two facts: *a 5xx is evidence, not absence* — something answered, so DNS, TCP, and routing all work — and exactly one proxy in the chain *minted* the error. Its first move is fingerprinting who:

```bash
curl -sv http://orders.localtest.me:30080/api/orders/1001 2>&1 | tail -7
```

```console
< HTTP/1.1 503 Service Unavailable
<html>
<head><title>503 Service Unavailable</title></head>
<center><h1>503 Service Unavailable</h1></center>
<hr><center>nginx</center>
```

Bare HTML with the `<hr><center>nginx</center>` footer: ingress-nginx wrote this, not your app. The bisect verdict: everything up to nginx works; the break is nginx → Service → pods. That hands you to [Service Unreachable](/troubleshooting/service-unreachable/), which walks the chain **client → DNS → Service → endpoints → pod** in likelihood order. Hop 1: *are the pods Ready?*

```bash
kubectl get pods -l app.kubernetes.io/name=orders-api
kubectl get endpoints orders-api
```

```console
NAME                         READY   STATUS    RESTARTS   AGE
orders-api-9b8d7f6c5-mq2vx   0/1     Running   0          2m
orders-api-9b8d7f6c5-sl8dn   0/1     Running   0          2m
NAME         ENDPOINTS   AGE
orders-api   <none>      3d
```

`Running` but `0/1 READY` — the playbook's exact words: a NotReady pod is *deliberately removed from the Service*; all replicas NotReady means zero endpoints means every request fails "even though everything is running". The playbook says stop here — everything downstream is fine — and ask why the probe fails: `kubectl describe pod orders-api-9b8d7f6c5-mq2vx | grep -A2 Unhealthy` answers `Readiness probe failed: HTTP probe failed with statuscode: 404`. A 404 from your own app: the probe is asking for a path that doesn't exist. Probe theory — what readiness should check and what it must never check — is [Health Checks](/workloads/health-checks/).

**Fix:**

```bash
helm rollback orders
kubectl get endpoints orders-api
```

```console
Rollback was a success! Happy Helming!
NAME         ENDPOINTS                         AGE
orders-api   10.42.0.19:8080,10.42.0.23:8080   3d
```

**Verify:** the loop returns to `200`s. Leave it running — drill 5 wants it. **Lesson:** a readiness probe change is a traffic change — "no healthy upstream" at the edge is usually a probe story, not an nginx story, and the endpoints list is where the two meet.

## 5. Drill 4: death by 64Mi

Before breaking anything, look at the ceiling from inside the container — the two cgroup files that decide this drill's outcome ([Linux Inside the Pod](/troubleshooting/linux-inside-the-pod/) is the field guide to these):

```bash
kubectl exec deploy/orders-api -- cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.current
```

```console
536870912
201326592
```

The limit (512Mi, from your chart) and the JVM's current working set (~192Mi). Now confiscate the headroom.

**Inject** — both values, because the API server rejects a pod whose request exceeds its limit:

```bash
helm upgrade orders charts/orders-api --reuse-values \
  --set resources.requests.memory=64Mi --set resources.limits.memory=64Mi
```

**Observe:**

```bash
kubectl get pods -w
```

```console
orders-api-4c7d9f8b6-zl5nq   0/1   Running            0     15s
orders-api-4c7d9f8b6-zl5nq   0/1   OOMKilled          0     24s
orders-api-4c7d9f8b6-zl5nq   0/1   CrashLoopBackOff   1     36s
```

The JVM never survives Spring Boot startup inside 64Mi. `Ctrl-C` the watch.

**Triage** — the [OOMKilled playbook](/troubleshooting/oomkilled/)'s first move is *confirm it was actually OOM*, because the loop status alone doesn't say:

```bash
kubectl describe pod orders-api-4c7d9f8b6-zl5nq | grep -B2 -A5 "Last State"
```

```console
    Last State:     Terminated
      Reason:       OOMKilled
      Exit Code:    137
    Restart Count:  3
```

The playbook's warning is worth committing to memory: **exit 137 alone does not mean OOM** — 137 is SIGKILL, and three different actors send it. `Reason: OOMKilled` = the container hit its memory limit (this page). Pod `Failed`/`Evicted` = node pressure, a different mechanism ([Node Problems](/troubleshooting/node-problems/)). Exit 137 during a rollout or drain = the app ignored SIGTERM and got killed after the grace period — a [graceful shutdown](/workloads/graceful-shutdown/) bug, not a memory one. Here the reason says it plainly. One more clue, from the [CrashLoopBackOff](/troubleshooting/crashloopbackoff/) discipline of reading the dying container's last words: `kubectl logs orders-api-4c7d9f8b6-zl5nq --previous` shows the Spring banner, some startup lines — then nothing. No error, no stack trace. The kernel's OOM killer is instant and unlogged from the app's point of view: *your logs just stop.* That silence plus `Reason: OOMKilled` is the whole signature. (A new pod's `/sys/fs/cgroup/memory.max` now reads `67108864` — 64Mi — if you're quick enough to exec during a `Running` window.)

**Fix** — right-size back. This time no rollback; a plain upgrade with no `--reuse-values` re-reads `values.yaml`, where the real numbers (384Mi request, 512Mi limit) still live:

```bash
helm upgrade orders charts/orders-api
kubectl rollout status deploy/orders-api
```

`--set` overrides only persist as long as you keep passing `--reuse-values` — your values file is the durable truth, which is exactly why the labs kept it that way.

**Verify:** `memory.max` reads `536870912` again, curl loop shows `200`. **Lesson:** the cgroup counts *everything* the process touches — heap, metaspace, thread stacks, buffers — so size limits from the observed working set plus headroom, never from the heap number alone.

## 6. Drill 5: the selector that matches nothing

Everything so far broke a *pod*. This one breaks the wiring between healthy pods and their Service — the number-one cause of "service down but pods green".

**Inject** — hand-edit the Helm-managed Service to select a label no pod carries:

```bash
kubectl patch svc orders-api -p '{"spec":{"selector":{"app.kubernetes.io/name":"payments-api"}}}'
```

**Observe** — the curl loop drops to `503` again. But this time:

```bash
kubectl get pods -l app.kubernetes.io/name=orders-api
kubectl get endpoints orders-api
```

```console
NAME                         READY   STATUS    RESTARTS   AGE
orders-api-7c9f6d8b5-k4mzn   1/1     Running   0          25m
orders-api-7c9f6d8b5-p8wlj   1/1     Running   0          24m
NAME         ENDPOINTS   AGE
orders-api   <none>      3d
```

Compare with drill 3: same `503`, same empty endpoints — but the pods are `1/1 READY`. Hop 1 of [Service Unreachable](/troubleshooting/service-unreachable/) passes, which sends you to Hop 2, the one the playbook calls **the #1 cause**: *does the selector actually match the labels?* A Service that selects nothing still resolves in DNS and still accepts connections — it just has nowhere to send them.

**Triage** — the playbook's label-compare drill, verbatim:

```bash
kubectl get svc orders-api -o jsonpath='{.spec.selector}'; echo
kubectl get pods --show-labels | grep orders-api
```

```console
{"app.kubernetes.io/instance":"orders","app.kubernetes.io/name":"payments-api"}
orders-api-7c9f6d8b5-k4mzn   1/1   Running   0   25m   app.kubernetes.io/instance=orders,app.kubernetes.io/name=orders-api,pod-template-hash=7c9f6d8b5
```

`payments-api` vs `orders-api` — no match, no endpoints. And the playbook's definitive cross-check — feed the Service's selector to a pod query:

```bash
kubectl get pods -l app.kubernetes.io/name=payments-api
```

```console
No resources found in labs namespace.
```

There's your outage, in one line.

**Fix** — you could patch the selector back by hand. Do this instead, and watch closely:

```bash
helm upgrade orders charts/orders-api
kubectl get endpoints orders-api
```

```console
NAME         ENDPOINTS                         AGE
orders-api   10.42.0.19:8080,10.42.0.23:8080   3d
```

Nothing in the chart changed — so why did the upgrade fix it? Because Helm applies a **three-way merge**: it compares the rendered manifest against the *live* object, not just against the previous release, and reasserts every field the chart owns. Your `kubectl patch` was drift, and drift on Helm-managed resources lives on borrowed time — the next routine upgrade silently repairs it (or, if the drift was your hotfix, silently *reverts* it, which is the scarier direction). Same lesson as `kubectl scale` in Lab 3, now with an outage attached. Note also what *didn't* happen: no pod restarted — Service changes take effect instantly through the endpoints controller.

**Verify:** loop shows `200`. **Lesson:** the chart is the source of truth; hand-edits to Helm-owned objects are either bugs waiting to be healed or fixes waiting to be clobbered.

## 7. Drill 6: stuck at Init

Lab 3 gave `orders-api` an initContainer that waits for the cache before the app boots. Time to see what that gate looks like when it can't open.

**Inject** — point the cache hostname at a Service that doesn't exist in this cluster (a config value copied from the wrong environment — a classic):

```bash
helm upgrade orders charts/orders-api --reuse-values --set cache.host=cache-valkey-prod
```

**Observe:**

```bash
kubectl get pods
```

```console
NAME                           READY   STATUS     RESTARTS   AGE
orders-api-6b5c8d7f9-vx3jq     0/1     Init:0/1   0          60s
orders-api-8a4e6f7d2-k4mzn     1/1     Running    0          20m
orders-api-8a4e6f7d2-p8wlj     1/1     Running    0          19m
```

`Init:0/1` — a status you haven't triaged before: the pod is stuck *before its app container exists*, waiting on init container 0 of 1. Naturally, the obvious command fails in an instructive way: `kubectl logs orders-api-6b5c8d7f9-vx3jq` answers `container "orders-api" ... is waiting to start: PodInitializing`.

**Triage** — logs are *per container*, and `kubectl logs` defaults to the app container, which hasn't started. Ask for the init container by name (`kubectl describe pod` lists them under `Init Containers:`, with `wait-for-cache` in state `Running` — running, not failing, which is why there's no error event to find):

```bash
kubectl logs orders-api-6b5c8d7f9-vx3jq -c wait-for-cache --tail=4
```

```console
nc: bad address 'cache-valkey-prod'
waiting for cache
nc: bad address 'cache-valkey-prod'
waiting for cache
```

Decode: `bad address` is [busybox](/troubleshooting/busybox/) `nc` saying DNS lookup failed — no Service named `cache-valkey-prod` exists in this namespace, so the `until nc -z …` loop will spin forever, and the pod will sit in `Init:0/1` until someone reads exactly this log. Appreciate what the gate bought you: without it, the app would have booted with `SPRING_DATA_REDIS_HOST` pointing at nothing and quietly served `"source":"live"` forever — degraded, slow, and invisible. The initContainer converted a silent degradation into a loud, unmissable stall, while the rolling update kept traffic on the old pods the whole time.

**Fix and verify** — roll back, then prove the whole chain, cache included:

```bash
helm rollback orders && kubectl rollout status deploy/orders-api
curl -s http://orders.localtest.me:30080/api/orders/1003
curl -s http://orders.localtest.me:30080/api/orders/1003
```

```console
deployment "orders-api" successfully rolled out
{"id":"1003","item":"2x filter papers","source":"live"}
{"id":"1003","item":"2x filter papers","source":"cache"}
```

`live` then `cache`: ingress, Service, pod, DNS, Valkey — every hop healthy. Stop your curl loop with `Ctrl-C`; the drills are done.

**Lesson:** `Init:*` statuses mean the app never even started — triage the init container by name with `logs -c`, because the default container has nothing to say.

## 8. Six drills, one method

Look back at what you actually typed. Every drill, regardless of the failure, was the same walk:

**symptom → events → describe → logs → playbook.**

The symptom names a suspect (`503` vs `ImagePullBackOff` vs `Init:0/1`), `kubectl get events --sort-by=.lastTimestamp` gives the timeline ([Events](/observability/events/) is the deep dive on that stream), `describe` holds the verbatim error, `logs` (with `--previous` and `-c` when needed) holds the app's side of the story, and the playbook turns the evidence into a ranked cause list. That walk is [Triage Methodology](/troubleshooting/triage-methodology/), and you've now run it six times without guessing once — because the cluster told you what was wrong, verbatim, every single time.

| Drill | Status you saw | The telling evidence | Playbook |
|---|---|---|---|
| Bad tag | `ImagePullBackOff` | `describe` → pull error text | [ImagePullBackOff](/troubleshooting/imagepullbackoff/) |
| Missing Secret | `CreateContainerConfigError` | `describe` → `secret … not found` | [Error Index](/troubleshooting/error-index/) |
| Broken readiness | `503`, pods `0/1` | nginx fingerprint → empty endpoints | [Front-door 5xx](/troubleshooting/front-door-5xx/), [Service Unreachable](/troubleshooting/service-unreachable/) |
| Memory limit | `OOMKilled`, exit 137 | `Last State` + logs that just stop | [OOMKilled](/troubleshooting/oomkilled/) |
| Selector drift | `503`, pods `1/1` | selector vs labels mismatch | [Service Unreachable](/troubleshooting/service-unreachable/) |
| Dead dependency | `Init:0/1` | `logs -c wait-for-cache` | [Triage Methodology](/troubleshooting/triage-methodology/) |

## 9. Design your own breakage

The drills you invent teach more than the ones you're given. Each of these is one command against your stack; predict the symptom *before* you inject, then triage by the book:

- `--set probes.liveness.path=/nope` — how does a liveness break differ from drill 3's readiness break, and why is it worse? ([Health Checks](/workloads/health-checks/))
- Recreate `cache-auth` with the key `pass` instead of `password`, then roll — same status as drill 2, different message. ([Error Index](/troubleshooting/error-index/))
- `kubectl scale deploy/cache-valkey --replicas=0` — nothing pages and every response says `"source":"live"`. Is silent degradation a feature or a bug here, and what would make it visible?
- `--set resources.requests.cpu=64` — a request no node can satisfy. New status, new playbook. ([Error Index](/troubleshooting/error-index/), then follow its pointer)
- `--set image.pullPolicy=Always` — nothing breaks *now*. When does it, and why? (Drill 1's lesson, delayed.)
- `kubectl delete ingress orders-api` — a `404` with an nginx fingerprint instead of a `503`. Why the different code? ([Front-door 5xx](/troubleshooting/front-door-5xx/), Lab 4's troubleshooting box)

:::caution
**If a drill leaves you wedged**

Order of escalation, cheapest first: `helm rollback orders` undoes the last release; `helm upgrade orders charts/orders-api` (no `--reuse-values`) reasserts your `values.yaml` truth and heals hand-drift; `helm history orders` shows where you are if you've lost count. Nuclear option, under two minutes: `helm uninstall orders && helm install orders charts/orders-api` — the Secret `cache-auth` and the `cache` release survive it. Nothing in this lab can damage the cluster itself.
:::

## Where you are now

The same stack you started with — and a fundamentally different relationship to it breaking. You've practiced the site's playbooks the way they're meant to be used: symptom first, evidence second, fix third, and a one-line verification before walking away. This discipline scales past the lab: every reference architecture on this site — [The Golden Service](/architectures/golden-service/), [Zero-Downtime Deployments](/architectures/zero-downtime/), [Valkey with a Shared VIP](/architectures/valkey-shared-vip/) — ends with a *verification plan*, and those plans are exactly these drills at production scale: inject, observe, triage, fix, verify. Teams that run them on purpose call them game days. You've just held your first one, solo, on a cluster that fits on your lap.
