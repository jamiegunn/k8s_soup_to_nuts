---
title: "Lab 8: Deploying Under Load"
description: Run a fortio load generator inside the cluster, catch a rolling deploy dropping requests, then add preStop, grace, and surge settings to the chart until the same deploy is measurably zero-downtime.
keywords:
  - measure zero-downtime deployment under load
  - run a fortio load generator inside the cluster
  - catch a rollout dropping requests
  - prestop hook and termination grace period
  - maxunavailable and maxsurge rollout settings
  - poddisruptionbudget for evictions
  - connection refused during a rolling deploy
  - why scaling out did not spread traffic
  - keep-alive connections pin to pods
sidebar:
  order: 10
---

Lab 4's pod-kill drill ran five polite requests per second through nginx and saw zero failures — and hinted that you got a little lucky. This lab removes the luck. You'll put **real, sustained load** on `orders-api`, deploy a change in the middle of it, and *count* the requests that die. Then you'll fix the chart — preStop hook, termination grace, surge settings — and deploy again under the same load, and count zero. Zero-downtime deployment is usually asserted; today you measure it.

**What you'll have at the end:** a reusable in-cluster load-generator Job, a before/after pair of fortio reports (a burst of connection errors → a clean 100 %), a chart hardened with `preStop` + `terminationGracePeriodSeconds` + `maxUnavailable: 0` + a PodDisruptionBudget, a pod-kill and a scale drill survived under load — and the [Zero-Downtime Deployments](/architectures/zero-downtime/) checklist run against a cluster you own.

## Prerequisites

- [Lab 0](/labs/lab-0-cluster/) through [Lab 4](/labs/lab-4-ingress-end-to-end/) completed: the Lima VMs `docker` and `k3s`, releases `orders` (image `orders-api:0.3.0` — or `0.4.0` if you did [Lab 6](/labs/lab-6-observability/); either is fine, this lab never touches the app code) and `cache` in the `labs` namespace, 2 replicas. Labs [5](/labs/lab-5-break-and-fix/)–[7](/labs/lab-7-ci-locally/) are good company but change nothing this lab depends on.
- If you took Lab 4's full-teardown option, you need the stack back: rerun [Lab 0](/labs/lab-0-cluster/), then the build-and-install steps of Labs 1–3. (This lab hits the Service directly, so ingress-nginx is optional today — more on why in step 1.)
- If you paused between sittings, revive everything (the last command should show `lima-k3s … Ready`):

```bash
limactl start docker && limactl start k3s
export DOCKER_HOST="unix://$HOME/.lima/docker/sock/docker.sock"
export KUBECONFIG="$HOME/.lima/k3s/copied-from-guest/kubeconfig.yaml"
kubectl get nodes
```

All commands run from `~/k8s-labs/`, with `kubectl` defaulting to the `labs` namespace. Confirm you have two replicas before starting (`kubectl get deploy orders-api` should show `2/2`; if not, `helm upgrade orders charts/orders-api --reuse-values --set replicaCount=2`).

## 1. A load generator inside the cluster

You need something hammering the API continuously while you deploy. The obvious move — a load tool on your Mac aimed at `orders.localtest.me:30080` — has two problems. First, it would need a new host tool, and Lab 0's brew list is the whole toolbox. Second, and more interesting: traffic through ingress-nginx is the *wrong measurement*, because nginx quietly **retries** idempotent requests when an upstream connection fails (`proxy_next_upstream` is on by default). That retry is a genuinely good production behavior — and it's part of why Lab 4's curl loop looked so clean. Today you want to see the raw failures, not nginx's cover-up, so the load runs **inside the cluster, straight at the Service**.

The tool is **fortio** (Istio's load generator — a single static binary with an image on Docker Hub), and the vehicle is a Kubernetes **Job**: a pod that runs to completion and keeps its logs around for reading. Create `~/k8s-labs/loadgen-job.yaml`:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: loadgen
spec:
  backoffLimit: 0            # a failed run should fail visibly, not retry
  template:
    metadata:
      labels:
        app: loadgen
    spec:
      restartPolicy: Never
      containers:
        - name: fortio
          image: fortio/fortio:1.69.4
          args:
            - load
            - -qps=50        # 50 requests/second, paced
            - -c=8           # over 8 concurrent connections
            - -t=150s        # for 2.5 minutes — room to deploy mid-run
            - -timeout=2s
            - http://orders-api.labs.svc:8080/api/orders/1001
```

50 qps for 150 seconds is 7,500 requests — small by production standards, but plenty to catch a rollout in the act. The URL is the Service's cluster DNS name from Lab 3, on the Service port 8080, hitting the cache-backed endpoint you built there.

Jobs are one-shot, and most of a Job's spec is immutable — so every run in this lab uses the same incantation: delete the old Job, apply a fresh one, follow the logs. Do the first run now, with **no deploy** — proving the harness reports a clean 100 % when nothing is happening is the control every experiment needs:

```bash
kubectl delete job loadgen --ignore-not-found
kubectl apply -f loadgen-job.yaml
kubectl wait --for=condition=ready pod -l app=loadgen
kubectl logs -f job/loadgen
```

Two and a half minutes later, the tail of the log is your report:

```console
Fortio 1.69.4 running at 50 queries per second, 4->4 procs, for 2m30s: http://orders-api.labs.svc:8080/api/orders/1001
Starting at 50 qps with 8 thread(s) [gomax 4] : exactly 7500, 937 calls each (total 7496 + 4)
Ended after 2m30.004s : 7500 calls. qps=49.999
Aggregated Function Time : count 7500 avg 0.0029 …
# target 50% 0.0026
# target 99% 0.0081
Code 200 : 7500 (100.0 %)
All done 7500 calls (plus 0 warmup) 2.9 ms avg, 50.0 qps
```

`Code 200 : 7500 (100.0 %)` is the baseline truth: at steady state, nothing drops. The two numbers worth keeping in your head for later comparison are that **100.0 %** and the **p99** (`# target 99%` — about 8 ms here).

:::note[First run pulls an image]
`fortio/fortio` comes from Docker Hub, and unlike `orders-api` — which you streamed into containerd by hand in Lab 1 — the kubelet pulls this one itself, over the internet. The first run sits in `ContainerCreating` for the duration of the pull; later runs start instantly.
:::

## 2. Baseline: catch a deploy dropping requests

Now deploy something mid-load and watch what breaks. It should be a **no-op change** — same image, same config — so that anything that fails, failed because of the *rollout mechanics*, not the change. The standard chart idiom for "roll the pods, change nothing" is a pod annotation you can bump at will. Your chart doesn't have one yet, so add it: in `charts/orders-api/templates/deployment.yaml`, extend the pod template's annotations (the block that has held `checksum/config` since Lab 2) to read:

```yaml
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
        {{- with .Values.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
```

And append the default to `charts/orders-api/values.yaml`:

```yaml
podAnnotations: {}
```

With the default empty, the rendered pod template is byte-identical to before — upgrade now and nothing rolls, which is itself worth seeing once (`helm upgrade orders charts/orders-api --reuse-values` — Helm records a new revision; `kubectl get pods` shows the same pods, undisturbed, because the Deployment's pod template didn't change).

Now the experiment. **Terminal A** — start the load and watch it:

```bash
kubectl delete job loadgen --ignore-not-found
kubectl apply -f loadgen-job.yaml
kubectl wait --for=condition=ready pod -l app=loadgen
kubectl logs -f job/loadgen
```

**Terminal B** — once requests are flowing, trigger the rollout by bumping the annotation:

```bash
helm upgrade orders charts/orders-api --reuse-values --set-string podAnnotations.rollme=r1
kubectl rollout status deploy/orders-api
```

(Any new value rolls the pods; `r2`, `r3`… on later runs, or `--set-string podAnnotations.rollme=run-$RANDOM` if you'd rather not count.) Back in terminal A, warnings scroll past as old pods die, and the final report has grown a line it didn't have before:

```console
16:41:52.113 r23 [WRN] http_client.go:1104> Connection error, err="dial tcp 10.42.0.31:8080: connect: connection refused"
…
Ended after 2m30.011s : 7500 calls. qps=49.996
Error cases : count 23 avg 0.00072 …
Code 200 : 7477 (99.7 %)
Code -1 : 23 (0.3 %)
All done 7500 calls (plus 0 warmup) 3.1 ms avg, 50.0 qps
```

**Code -1** is fortio's bucket for requests that never got an HTTP status at all — the TCP connection was refused or reset. Twenty-three real requests died, and the *shape* of the failure tells you exactly where: a **refused connection to a pod IP** means traffic was still being routed to a pod whose process had already stopped listening. That's the shutdown race, and it's worth stating precisely, because the fix targets each clause: when a pod begins terminating, two things start **in parallel** — the kubelet sends the container SIGTERM, and the endpoints controller removes the pod's IP from the Service, which every node's kube-proxy then has to act on. Nothing sequences them. Your Spring Boot app honors SIGTERM promptly and closes its listener in milliseconds; the routing update takes longer; every request routed into that gap gets `connection refused`. The full anatomy is in [Graceful Shutdown](/workloads/graceful-shutdown/).

You can see the choreography after the fact in the event stream ([Events](/observability/events/) is the decoder ring):

```bash
kubectl get events --sort-by=.lastTimestamp | tail -8
```

```console
2m    Normal   Scheduled   pod/orders-api-7b8d4c9f66-p4k2m   Successfully assigned labs/orders-api-7b8d4c9f66-p4k2m to lima-k3s
2m    Normal   Started     pod/orders-api-7b8d4c9f66-p4k2m   Started container orders-api
2m    Normal   Killing     pod/orders-api-6f7c9d5b44-x2x8n   Stopping container orders-api
90s   Normal   Scheduled   pod/orders-api-7b8d4c9f66-q9d7w   Successfully assigned labs/orders-api-7b8d4c9f66-q9d7w to lima-k3s
90s   Normal   Started     pod/orders-api-7b8d4c9f66-q9d7w   Started container orders-api
90s   Normal   Killing     pod/orders-api-6f7c9d5b44-w7k3m   Stopping container orders-api
```

Note the *order*: each new pod starts (and turns Ready — the probes from Lab 1 doing their job, see [Health Checks](/workloads/health-checks/)) **before** an old one is killed. The Deployment's sequencing is already correct. The errors happen entirely inside each `Killing` — after the kill decision, during the routing gap.

:::note[Got 100 % on the baseline?]
Possible, and worth understanding rather than shrugging at. This cluster is one node, so the routing update has exactly one kube-proxy to reach — the gap can be a few milliseconds, and 50 qps may thread it. Widen the window and rerun: raise the pressure (`-qps=200`, `-c=16` in the Job) so more requests are in flight during the gap. The other lever is the app: a service that takes seconds to shut down (in-flight work, connection draining, a slower framework) holds the race open far longer — which is exactly why production clusters, with dozens of nodes' worth of kube-proxy propagation and slower apps, see this constantly even when your laptop occasionally doesn't. The point of the fix isn't your 0.3 % — it's that the mechanism is unsound until the gap is closed by design.
:::

## 3. The fix: three values and a hook

The race has two clauses, so the fix has two halves — plus one setting that isn't about the race at all but belongs in the same commit.

**Half one: keep serving while the routing drains.** A `preStop` hook runs *before* SIGTERM is sent, while the pod keeps serving — but endpoint removal starts immediately. So `preStop: sleep 5` turns "SIGTERM races the routing update" into "the routing update gets a five-second head start." **Half two: give shutdown room.** `terminationGracePeriodSeconds` is the total budget from "start terminating" to SIGKILL, and the preStop hook spends from it. The whole contract in one line: **preStop sleep + real shutdown time ≤ terminationGracePeriodSeconds** — the default 30 minus your 5 leaves 25, which is fine today, but 40 buys headroom for the day the app drains real work on the way down. The knob-by-knob tuning table is [Rollout & Shutdown Knobs](/tuning/rollout-shutdown-knobs/).

**The third setting:** pin the rollout's capacity math. `maxUnavailable: 0, maxSurge: 1` means "never dip below desired replicas; build the new pod first, kill the old one after." At 2 replicas the default `25 %` *happens* to round to exactly these numbers — which is why step 2's sequencing was already correct — but at 4 replicas, 25 % rounds to 1 unavailable and the accident expires. Settings you rely on get pinned ([Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/) covers the rounding rules).

Append to `charts/orders-api/values.yaml`:

```yaml
strategy:
  maxUnavailable: 0
  maxSurge: 1
terminationGracePeriodSeconds: 40
preStopSeconds: 5
pdb:
  enabled: true
  minAvailable: 1
```

Three edits in `charts/orders-api/templates/deployment.yaml`. Under `spec:`, next to `replicas`:

```yaml
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: {{ .Values.strategy.maxUnavailable }}
      maxSurge: {{ .Values.strategy.maxSurge }}
```

In the pod spec, above `containers:`:

```yaml
      terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds }}
```

And on the container, after `resources`:

```yaml
          lifecycle:
            preStop:
              exec:
                command: ["sleep", "{{ .Values.preStopSeconds }}"]
```

One new template, `charts/orders-api/templates/pdb.yaml` — the fourth setting, riding along:

```yaml
{{- if .Values.pdb.enabled }}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "orders-api.fullname" . }}
spec:
  minAvailable: {{ .Values.pdb.minAvailable }}
  selector:
    matchLabels:
      {{- include "orders-api.selectorLabels" . | nindent 6 }}
{{- end }}
```

Be honest about what the PDB does and doesn't do: it does **not** protect against rollouts (that's the strategy block's job) or `kubectl delete pod` (nothing protects against that). It protects against **evictions** — node drains during upgrades, autoscaler consolidation — by refusing to evict below `minAvailable`. On a one-node lab you can't stage a meaningful drain, but every production checklist wants the PDB present, so it ships with the same commit.

Render, read, ship — *without* load running, deliberately:

```bash
helm template orders charts/orders-api | grep -B1 -A3 "preStop\|terminationGrace\|rollingUpdate"
helm upgrade orders charts/orders-api --reuse-values
kubectl rollout status deploy/orders-api
kubectl get pdb
```

```console
NAME         MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
orders-api   1               N/A               1                     15s
```

Why no load on this one? Because this rollout **kills old-spec pods** — pods created before the fix, with no preStop hook. The termination behavior lives in the dying pod's spec, not the new one's, so measuring this deploy would test the old behavior with the new label on it. The first rollout that both *has* the fix on both sides is the next one.

## 4. Measure again — the payoff

Same experiment, new machinery. Terminal A:

```bash
kubectl delete job loadgen --ignore-not-found
kubectl apply -f loadgen-job.yaml
kubectl wait --for=condition=ready pod -l app=loadgen
kubectl logs -f job/loadgen
```

Terminal B, once requests are flowing:

```bash
helm upgrade orders charts/orders-api --reuse-values --set-string podAnnotations.rollme=r2
kubectl rollout status deploy/orders-api
```

The rollout takes noticeably longer this time — each old pod lingers `Terminating` for its five-second sleep — and terminal A scrolls no warnings at all:

```console
Ended after 2m30.007s : 7500 calls. qps=49.998
Aggregated Function Time : count 7500 avg 0.0031 …
# target 50% 0.0027
# target 99% 0.0094
Code 200 : 7500 (100.0 %)
All done 7500 calls (plus 0 warmup) 3.1 ms avg, 50.0 qps
```

Side by side, the whole lab in one table:

| | Baseline (`rollme=r1`) | Fixed (`rollme=r2`) |
|---|---|---|
| Total requests | 7,500 | 7,500 |
| `Code 200` | 7,477 (99.7 %) | **7,500 (100.0 %)** |
| `Code -1` (connection refused/reset) | 23 | **0** |
| p99 latency | ~8 ms | ~9 ms |
| Rollout wall time | ~35 s | ~50 s |

Read the bottom two rows as the price tag: zero downtime cost you about a millisecond of p99 (surge pods warming up) and fifteen seconds of rollout time (the sleeps). That trade — a slower deploy for an invisible one — is the trade every production platform makes, and now you've paid it with your own hands rather than a config you copied.

:::note[The app-side half you didn't do]
The preStop sleep closes the *routing* gap; it doesn't make the app itself drain gracefully. Spring Boot has a switch for that — `server.shutdown: graceful` plus a timeout — which makes Tomcat stop accepting new connections but finish in-flight requests on SIGTERM. At 3 ms per request this lab can't tell the difference, but a real service with 2-second requests absolutely can. That's an `application.yaml` change, a rebuild to `orders-api:0.4.0`, and the same measure-again loop — a worthy solo exercise. The full app-and-platform contract is in [Graceful Shutdown](/workloads/graceful-shutdown/).
:::

## 5. The pod-kill drill, replayed under real load

Lab 4's drill, but with 50 qps of witnesses instead of five. Start a fresh load run (terminal A, same incantation as always), then kill a pod mid-flight:

```bash
kubectl get pods -l app.kubernetes.io/name=orders-api
kubectl delete pod <one-of-the-orders-api-pod-names>
```

Watch the pod sit `Terminating` for its five-second sleep — still serving the whole time — while the Deployment schedules a replacement and the survivor absorbs the rest. The fortio report at the end:

```console
Code 200 : 7500 (100.0 %)
```

An unplanned single-pod death now looks identical to a planned rollout: routing drains before the listener closes. This is the drill worth internalizing, because pods die for reasons no deploy pipeline schedules — node pressure, OOM kills, a colleague's fat finger — and the same three chart settings cover all of them.

## 6. Scale out, scale in — under load

One more class of pod churn: capacity changes. For this drill you want a longer window — edit `loadgen-job.yaml` and set `-t=300s`, then start a fresh run in terminal A. In terminal B, double the fleet:

```bash
helm upgrade orders charts/orders-api --reuse-values --set replicaCount=4
kubectl rollout status deploy/orders-api
```

Scale-up is the easy direction — new pods appear, nothing terminates, fortio never blinks. But give the new pods a minute, then ask the bundled metrics-server where the traffic actually went:

```bash
kubectl top pods -l app.kubernetes.io/name=orders-api
```

```console
NAME                          CPU(cores)   MEMORY(bytes)
orders-api-7b8d4c9f66-p4k2m   87m          412Mi
orders-api-7b8d4c9f66-q9d7w   85m          409Mi
orders-api-7b8d4c9f66-mv2ls   3m           301Mi
orders-api-7b8d4c9f66-zk8fh   2m           298Mi
```

(Don't compare those memory numbers against Lab 6's ~290Mi and worry — a JVM's working set sits anywhere in that 290–410Mi range depending on load history; under sustained traffic the hot pods drift high. The signal here is the *split*, not the absolute.)

Two hot pods, two idle ones — you doubled capacity and gained almost nothing. That's not a bug: fortio opened 8 **keep-alive connections** at startup, Service load balancing happens at *connection* time, and established connections stay pinned to their pods. New pods only help clients that open new connections. This is the single most common "we scaled out and nothing improved" surprise in production — gRPC and HTTP/2 clients, connection pools, and message consumers all behave exactly like fortio here. The escape hatches (connection lifetimes, client-side balancing, meshes) live in [Long-Lived Connections](/networking/long-lived-connections/). See the counterfactual yourself if you like: add `-keepalive=false` to the Job's args on a later run and `kubectl top` shows four evenly warm pods.

Now the direction that kills pods — scale back in, while the load still runs:

```bash
helm upgrade orders charts/orders-api --reuse-values --set replicaCount=2
```

Two pods terminate mid-traffic — including, most likely, one holding live keep-alive connections. The preStop sleep drains the routing, the grace period lets in-flight work finish, fortio re-establishes its dropped connections on the survivors, and the report stays clean:

```console
Code 200 : 15000 (100.0 %)
```

Rollout, pod death, scale-in: three different triggers, one termination path, one fix covering all three.

One last piece of housekeeping. The load generator is a *completed* Job, and completed Jobs — pod, logs, and all — sit around until someone deletes them:

```bash
kubectl delete job loadgen --ignore-not-found
```

```console
job.batch "loadgen" deleted
```

(Keep `loadgen-job.yaml` on disk — the harness reruns any time you want to re-measure.)

## 7. The graduation: run the production checklist

What you've built this lab is [Zero-Downtime Deployments](/architectures/zero-downtime/)' proof harness in miniature — their load generator is bigger and their cluster has more nodes, but the loop (measure → fix → measure) and the knobs are the same. So graduate properly: open that page's checklist and score your lab cluster against it, line by line.

| Checklist item | Where you earned it |
|---|---|
| Readiness distinct from liveness, on a management port | Lab 1 |
| New pods Ready before old ones die (`maxUnavailable: 0`, surge) | Step 3, pinned instead of accidental |
| preStop delay covering endpoint propagation | Step 3 |
| Grace period ≥ preStop + real shutdown time | Step 3 (5 + shutdown ≤ 40) |
| PodDisruptionBudget for evictions | Step 3, honestly untestable on one node |
| App-level graceful shutdown (`server.shutdown: graceful`) | **The open item** — step 4's exercise |
| Proven under load, not asserted | Steps 2 and 4 — your before/after table |

Six of seven, with the seventh scoped and understood, is a better position than most production services are in — most have the settings and have never run step 2 against them.

## Where to go next

You're one lab page from the end of the sequence — [From the Lab to the Paved Road](/labs/from-lab-to-prod/) maps everything you've built onto real org infrastructure. The reference threads this lab leaves in your hands:

- **[Zero-Downtime Deployments](/architectures/zero-downtime/)** — this lab at production scale: multi-node propagation, connection draining, and the full proof-loop methodology.
- **[Graceful Shutdown](/workloads/graceful-shutdown/)** — the termination lifecycle in full: preStop, SIGTERM, grace, SIGKILL, and the app's side of the contract.
- **[Rollout & Shutdown Knobs](/tuning/rollout-shutdown-knobs/)** — every number you set in step 3, with the tuning ranges and the failure mode each one guards.
- **[Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/)** — surge math, rollout history, and what `kubectl rollout undo` actually replays.
- **[Long-Lived Connections](/networking/long-lived-connections/)** — step 6's pinned-connections surprise, and what to do about it when the client is gRPC instead of fortio.
- **[Events](/observability/events/)** — the `Killing`/`Scheduled`/`Started` stream you read in step 2, decoded fully.

When you're done for the day, the usual pause keeps everything (`limactl stop docker && limactl stop k3s`); the full teardown recipe is in [Lab 4](/labs/lab-4-ingress-end-to-end/) and the [overview](/labs/overview/) — but consider keeping the cluster until you've read the bridge page.

:::caution
**Troubleshooting box**

- **`field is immutable` when re-applying the Job** — Jobs can't be updated in place; you skipped the delete. Always the pair: `kubectl delete job loadgen --ignore-not-found` then `kubectl apply -f loadgen-job.yaml`.
- **Loadgen stuck in `ContainerCreating`** — first-time image pull from Docker Hub (see step 1's note). `kubectl describe pod -l app=loadgen` shows `Pulling image`; wait it out. If it shows `ErrImagePull`, the k3s VM has no internet route — check the VM is healthy with `limactl list`.
- **The load finished before you deployed** — the 150-second window closed while you were typing in terminal B. Rerun the Job and have the `helm upgrade` command staged and ready before you start it.
- **Errors *after* the fix** — first verify the fix actually landed on the running pods: `kubectl get pod -l app.kubernetes.io/name=orders-api -o yaml | grep -c "preStop\|terminationGracePeriodSeconds: 40"` should be nonzero, and `helm get manifest orders | grep -A4 rollingUpdate` should show `maxUnavailable: 0`. If the settings are live and errors persist, check the errors' *code*: `Code 503` (a real HTTP status) isn't the shutdown race at all — it's readiness failing, which is Lab 4 step 4's diagnosis, starting from `kubectl get endpointslices -l kubernetes.io/service-name=orders-api`.
- **`kubectl top` says `metrics not available yet`** — metrics-server samples on a ~60-second cadence; new pods take a minute to appear. Ask again shortly.
- **Everything is slow and fans are loud** — 4 replicas of a JVM plus fortio plus Valkey is a real bite out of the k3s VM's 4 GiB. Scale back to 2 replicas between drills, and check for `Insufficient memory` events if pods go `Pending`.
:::

## Where you are now

Release `orders` deploys with a pinned surge strategy, a preStop drain, a 40-second grace budget, and a PDB — and you have the fortio reports proving what those settings buy: 23 dropped requests before, zero after, across a rollout, a pod kill, and a scale cycle. More than the settings, you own the *method*: put load on it, change it, count the failures. That loop works on any cluster, at any scale, and most engineers never run it. Next and last: [From the Lab to the Paved Road](/labs/from-lab-to-prod/), where everything in `~/k8s-labs/` gets mapped onto the infrastructure your organization actually runs.
