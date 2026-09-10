---
title: "Lab 11: Survive the Drain — Evictions, Budgets, and Who Killed My Pod"
description: Evict your own pod through the Eviction API under load, make a PodDisruptionBudget say no (429) and then yes, reproduce the crashlooping-pod jam and unjam it with one patch, watch a real kubectl drain block itself from the platform's seat, read the DisruptionTarget condition off a dying pod, and keep a Job from burning its retries — all on the one-node lab cluster.
keywords:
  - test a pod disruption budget without draining a node
  - kubectl create --raw eviction lab
  - cannot evict pod as it would violate the pod's disruption budget lab
  - unhealthypodevictionpolicy alwaysallow demo
  - kubectl drain single node pod-selector
  - disruptiontarget condition read from pod
  - podfailurepolicy disruptiontarget job lab
  - cordon node pending unschedulable lab
  - pdb allowed disruptions watch
sidebar:
  order: 13
---

Lab 8 made every pod death *clean*: preStop, grace, surge — a rollout, a pod kill, and a scale cycle survived under load with a 100 % report. It also shipped a PodDisruptionBudget "for evictions" with a promise that this lab would drill it. You can't drain your pods *to another node* here — but the thing a drain actually does to each pod is an **eviction**, an API call you can make yourself, against your own pods, and watch the budget answer. This lab is that call, in every form it takes: yes, no, no-because-of-a-broken-pod, and no-because-there's-nowhere-to-land. The one node isn't a limitation today; it's the sharpest version of every mechanism.

**What you'll have at the end:** an `orders-api` chart whose PDB is `maxUnavailable: 1` + `AlwaysAllow` with a derivation comment; a self-eviction you ran through the Eviction API under fortio load with a clean report; a budget you made say **no** (HTTP 429) and then yes; the crashloop jam reproduced and unjammed with one `kubectl patch`; a blocked `kubectl drain` you watched retry from the platform's seat, on your own cluster, until its timeout; a `DisruptionTarget` condition read off a dying pod; a Job that survived an eviction without spending a retry; and the [maintenance-window runbook](/disruption/platform-contract/#the-maintenance-window-runbook) run once against a cluster you own.

## Prerequisites

- [Lab 0](/labs/lab-0-cluster/) through [Lab 4](/labs/lab-4-ingress-end-to-end/) and [Lab 8](/labs/lab-8-deploy-under-load/) completed: release `orders` in the `labs` namespace at 2 replicas, with Lab 8's chart hardening in place — `preStopSeconds: 5`, `terminationGracePeriodSeconds: 40`, `strategy.maxUnavailable: 0`, and `pdb.enabled: true` with `pdb.minAvailable: 1` — plus `~/k8s-labs/loadgen-job.yaml`. [Lab 10](/labs/lab-10-autoscaling/) is optional: one beat in step 4 uses its HPA, and step 9 uses its monitoring stack; both say what to do if you skipped it.
- If you paused between sittings, revive everything (the last command should show `lima-k3s … Ready`):

```bash
limactl start docker && limactl start k3s
export DOCKER_HOST="unix://$HOME/.lima/docker/sock/docker.sock"
export KUBECONFIG="$HOME/.lima/k3s/copied-from-guest/kubeconfig.yaml"
kubectl get nodes
```

All commands run from `~/k8s-labs/`, with `kubectl` defaulting to the `labs` namespace. You are cluster-admin here, so nothing on this page needs the [seat markers](/disruption/overview/#who-owns-what) the reference pages carry — but each step says which seat it would be in production, because that's the thing to take away.

## 1. Preflight — the quick start's gate, run for real

The [15-Minute Safe PDB](/disruption/quick-start/) opens with four checks. Run them against the real thing:

```bash
kubectl get deploy orders-api -o jsonpath='{.spec.replicas}{"\n"}'
kubectl get deploy orders-api -o jsonpath='{.spec.template.spec.containers[0].readinessProbe.httpGet.path}{"\n"}'
kubectl get pdb
kubectl auth can-i create pods/eviction
```

```console
2
/actuator/health/readiness
NAME         MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
orders-api   1               N/A               1                     9d
yes
```

Two replicas, an honest readiness probe, a budget that currently permits one disruption, and — the check that matters most today — you may create evictions. In production that last `yes` is the one ask on this page a tenant might have to make ([the RBAC ask](/disruption/platform-contract/#the-one-time-rbac-ask)); the built-in `edit` role includes it, and you're admin here.

If `kubectl get pdb` shows nothing, Lab 8's `pdb.enabled` didn't land: `helm upgrade orders charts/orders-api --reuse-values --set pdb.enabled=true`. If the replica count isn't 2 (Lab 10's HPA may still own it): `helm upgrade orders charts/orders-api --reuse-values --set autoscaling.enabled=false --set replicaCount=2`.

## 2. Read the budget the way the controller does

`kubectl get pdb` shows one number. The status block shows the arithmetic behind it:

```bash
kubectl get pdb orders-api -o yaml | sed -n '/^status:/,$p'
```

```yaml
status:
  conditions:
  - lastTransitionTime: "2026-09-10T02:30:36Z"
    message: ""
    observedGeneration: 1
    reason: SufficientPods
    status: "True"
    type: DisruptionAllowed
  currentHealthy: 2
  desiredHealthy: 1
  disruptionsAllowed: 1
  expectedPods: 2
  observedGeneration: 1
```

Read it bottom-up. `expectedPods: 2` is, for *this* shape, a headcount of the pods the selector matches — an integer `minAvailable` is the one case where the controller counts pods rather than reading the Deployment's replica count; once the chart switches to `maxUnavailable` in step 4 it reads the Deployment's `.spec.replicas` instead, which is how it later follows the HPA. `desiredHealthy: 1` is your `minAvailable`. `currentHealthy: 2` is the pods that are Ready right now. `disruptionsAllowed: 1` is the subtraction — and it's the *only* number the Eviction API will read. The condition says the same thing in words: `SufficientPods`. Every field is explained in [the reference](/disruption/pod-disruption-budgets/#the-status-block-field-by-field); you'll watch all of them move in the next three steps.

## 3. The self-eviction drill, under load

Start Lab 8's load in terminal A (the same 150-second run as always):

```bash
kubectl delete job loadgen --ignore-not-found
kubectl apply -f loadgen-job.yaml
```

In terminal C, start watching the budget *before* you touch anything, so you see it move:

```bash
kubectl get pdb -w
```

In terminal B, write the request a drain makes for each pod. The body names the pod; the URL is the pod's `eviction` subresource. Chain the condition read onto the eviction: Lab 8's pod dies in about seven seconds (a five-second preStop, then Tomcat closes at once — Lab 8 left `server.shutdown: graceful` as an exercise), so the condition you're about to read is gone almost as soon as it appears:

```bash
POD=$(kubectl get pods -l app.kubernetes.io/name=orders-api -o jsonpath='{.items[0].metadata.name}')
cat > eviction.json <<EOF
{
  "apiVersion": "policy/v1",
  "kind": "Eviction",
  "metadata": {
    "name": "$POD",
    "namespace": "labs"
  }
}
EOF
kubectl create --raw /api/v1/namespaces/labs/pods/$POD/eviction -f eviction.json && echo && \
  kubectl get pod $POD -o jsonpath='{.status.conditions[?(@.type=="DisruptionTarget")]}{"\n"}'
```

```console
{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Success","code":201}
{"lastProbeTime":null,"lastTransitionTime":"2026-09-10T02:31:52Z","message":"Eviction API: evicting","reason":"EvictionByEvictionAPI","status":"True","type":"DisruptionTarget"}
```

`201` is the budget saying yes. The second line is the condition the API server stamped on the pod in the same instant: `EvictionByEvictionAPI` — the pod knows it was evicted, not deleted. This condition is the first thing a tenant can read to answer "who killed my pod?", and [the decoder](/disruption/anatomy-of-a-drain/#the-decoder-who-killed-my-pod) lists every value it can hold. Terminal C, meanwhile:

```console
NAME         MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
orders-api   1               N/A               1                     9d
orders-api   1               N/A               0                     9d
orders-api   1               N/A               1                     9d
```

The dip to `0` lasts as long as the replacement takes to pass its readiness probe — about 45 seconds for the Spring Boot app. During that window, a drain's *next* eviction of an `orders-api` pod would get a 429. That's the whole mechanism of a budget: it doesn't slow the eviction it granted; it refuses the one after, until the fleet is whole again.

For contrast, wait for the fleet to be whole, then delete the *other* pod the ordinary way and look for the same condition — chained the same way, for the same reason:

```bash
kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=orders-api --timeout=90s
OTHER=$(kubectl get pods -l app.kubernetes.io/name=orders-api -o name | grep -v "$POD" | head -1 | cut -d/ -f2)
kubectl delete pod $OTHER --wait=false && \
  kubectl get pod $OTHER -o jsonpath='{.status.conditions[?(@.type=="DisruptionTarget")]}{"\n"}'
```

```console
pod/orders-api-6b7fd9cb95-br65w condition met
pod/orders-api-6b7fd9cb95-swccg condition met
pod "orders-api-6b7fd9cb95-swccg" deleted from labs namespace

```

Empty. A plain delete never asks the budget and never leaves a trace; a drain asks and signs its work. (The `wait` matters for the report, too: deleting the only Ready pod while the first replacement is still warming would leave fortio with nobody to talk to.) When the load run ends, read the report exactly as in Lab 8:

```bash
kubectl logs job/loadgen | grep -E "^Code|Total"
```

```console
Code 200 : 7500 (100.0 %)
```

Clean — and notice *why*. An eviction is a deletion with a bouncer in front. The bouncer decided *whether* (the budget); Lab 8's preStop sleep and grace period decided *how*. Neither would have saved the report alone.

## 4. Make the budget say no

Now the case the platform team keeps meeting. Raise the floor to the replica count:

```bash
helm upgrade orders charts/orders-api --reuse-values --set pdb.minAvailable=2
kubectl get pdb
```

```console
NAME         MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
orders-api   2               N/A               0                     9d
```

`ALLOWED DISRUPTIONS 0` with both pods Ready — a budget that permits nothing on a perfectly healthy day. Evict:

```bash
POD=$(kubectl get pods -l app.kubernetes.io/name=orders-api --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
sed -i '' "s/\"name\": \".*\"/\"name\": \"$POD\"/" eviction.json
kubectl create --raw /api/v1/namespaces/labs/pods/$POD/eviction -f eviction.json
```

```console
Error from server (TooManyRequests): Cannot evict pod as it would violate the pod's disruption budget.
```

That single line is what the platform team saw for six hours in [the Field Note](/blog/the-pdb-that-blocked-the-drain/), retried every five seconds. kubectl prints only the message; the response body carries the arithmetic, and it's worth seeing once:

```bash
kubectl create --raw /api/v1/namespaces/labs/pods/$POD/eviction -f eviction.json -v=9 2>&1 | grep -A2 "Response Body"
```

```console
I0910 02:32:45.779568   10273 create.go:114] "Response Body" body=<
	{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Failure","message":"Cannot evict pod as it would violate the pod's disruption budget.","reason":"TooManyRequests","details":{"causes":[{"reason":"DisruptionBudget","message":"The disruption budget orders-api needs 2 healthy pods and has 2 currently"}]},"code":429}
 >
```

`needs 2 … has 2` — `desiredHealthy` and `currentHealthy`, whose difference is the zero you saw. Percentages don't rescue you either; they round *up*:

```bash
helm upgrade orders charts/orders-api --reuse-values --set pdb.minAvailable=80%
kubectl get pdb orders-api -o custom-columns=NAME:.metadata.name,MIN:.spec.minAvailable,EXPECTED:.status.expectedPods,DESIRED:.status.desiredHealthy,ALLOWED:.status.disruptionsAllowed
```

```console
NAME         MIN   EXPECTED   DESIRED   ALLOWED
orders-api   80%   2          2         0
```

80 % of 2 is 1.6, rounded up to 2. Still nothing. [The arithmetic](/disruption/pod-disruption-budgets/#the-arithmetic) has the full table.

**Fix the shape, not the number.** A floor collides with the replica count; a ceiling on the *missing* doesn't. Teach the chart both shapes plus the policy you'll meet in the next step. Replace `charts/orders-api/templates/pdb.yaml`:

```yaml
{{- if .Values.pdb.enabled }}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "orders-api.fullname" . }}
spec:
  {{- if .Values.pdb.minAvailable }}
  minAvailable: {{ .Values.pdb.minAvailable }}
  {{- else }}
  maxUnavailable: {{ .Values.pdb.maxUnavailable }}
  {{- end }}
  unhealthyPodEvictionPolicy: {{ .Values.pdb.unhealthyPodEvictionPolicy }}
  selector:
    matchLabels:
      {{- include "orders-api.selectorLabels" . | nindent 6 }}
{{- end }}
```

And replace the `pdb:` block in `charts/orders-api/values.yaml`:

```yaml
pdb:
  enabled: true
  maxUnavailable: 1
  # derivation (level c — provisional, lab): one of two may be missing; one pod carries
  # 50 qps with room to spare. Holds at 2 replicas and at Lab 10's ceiling of 5.
  # minAvailable rejected: a floor equal to the replica count permits nothing (step 4).
  minAvailable: ""                          # empty on purpose — see the derivation
  unhealthyPodEvictionPolicy: AlwaysAllow   # stateless: let the platform remove broken pods (step 5)
```

The chart gained new keys, so this upgrade starts from the new defaults (Lab 10's `--reset-then-reuse-values` lesson — plain `--reuse-values` would never see `maxUnavailable`). One more wrinkle: `--reset-then-reuse-values` re-applies every `--set` you've ever made to this release, including the `80%` from a minute ago, and that would win the template's `if`. Clear it explicitly:

```bash
helm upgrade orders charts/orders-api --reset-then-reuse-values --set pdb.minAvailable=""
kubectl get pdb
```

```console
NAME         MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
orders-api   N/A             1                 1                     9d
```

Evict again with the same command as before — `201`. The shape is now in the chart, where the next reviewer can read the derivation comment, which is the whole point of [the review checklist](/disruption/platform-contract/#the-pdb-review-checklist).

:::note[If you did Lab 10: watch expectedPods follow the HPA]
Turn the HPA back on for a minute — `helm upgrade orders charts/orders-api --reuse-values --set autoscaling.enabled=true` — and run the `custom-columns` command above while `kubectl get hpa -w` settles. `EXPECTED` tracks whatever the HPA decides, because the controller reads the Deployment's replica count through the scale subresource. With `maxUnavailable: 1`, `ALLOWED` stays at 1 whether the HPA sits at its floor of 2 or its ceiling of 5; with the `minAvailable: 2` you just removed, it would read 0 every time the HPA scaled down to 2 — at 3 a.m., when the drains come. That is [the 3 a.m. problem](/disruption/pod-disruption-budgets/#pdb-and-hpa-the-3-am-problem) in one column. Turn it back off before continuing: `--set autoscaling.enabled=false --set replicaCount=2`.
:::

## 5. The crashloop jam, deterministically

The default `unhealthyPodEvictionPolicy` has a rule that jams drains for hours: a Running-but-not-Ready pod may be evicted *only while the budget is currently met*. To reproduce it you need a pod whose readiness you control by hand. Create `~/k8s-labs/budget-demo.yaml` — a Deployment whose readiness probe is a file, plus a deliberately over-strict budget with the default policy spelled out:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: budget-demo
spec:
  replicas: 2
  selector:
    matchLabels:
      app: budget-demo
  template:
    metadata:
      labels:
        app: budget-demo
    spec:
      terminationGracePeriodSeconds: 5
      containers:
        - name: demo
          image: busybox:1.37
          command: ["sh", "-c", "touch /tmp/ready; sleep infinity"]
          readinessProbe:
            exec:
              command: ["cat", "/tmp/ready"]   # Ready exactly while the file exists
            periodSeconds: 2
            failureThreshold: 1
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: budget-demo
spec:
  minAvailable: 2                               # the permits-nothing trap, on purpose
  unhealthyPodEvictionPolicy: IfHealthyBudget   # the default, made explicit
  selector:
    matchLabels:
      app: budget-demo
```

```bash
kubectl apply -f budget-demo.yaml
sleep 10
kubectl get pods -l app=budget-demo
kubectl get pdb budget-demo
```

```console
NAME                           READY   STATUS    RESTARTS   AGE
budget-demo-77756468fc-hmqgt   1/1     Running   0          12s
budget-demo-77756468fc-v4dhp   1/1     Running   0          12s
NAME          MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
budget-demo   2               N/A               0                     13s
```

Both Ready, zero allowed. Now break one pod's readiness by hand and watch the budget go into deficit:

```bash
A=$(kubectl get pods -l app=budget-demo -o jsonpath='{.items[0].metadata.name}')
B=$(kubectl get pods -l app=budget-demo -o jsonpath='{.items[1].metadata.name}')
kubectl exec $A -- rm /tmp/ready
sleep 6
kubectl get pods -l app=budget-demo
kubectl get pdb budget-demo -o custom-columns=NAME:.metadata.name,POLICY:.spec.unhealthyPodEvictionPolicy,CURRENT:.status.currentHealthy,DESIRED:.status.desiredHealthy,ALLOWED:.status.disruptionsAllowed
```

```console
NAME                           READY   STATUS    RESTARTS   AGE
budget-demo-77756468fc-hmqgt   0/1     Running   0          19s
budget-demo-77756468fc-v4dhp   1/1     Running   0          19s
NAME          POLICY            CURRENT   DESIRED   ALLOWED
budget-demo   IfHealthyBudget   1         2         0
```

`CURRENT 1 < DESIRED 2`. Try to evict the **broken** pod — the one that serves nothing:

```bash
echo "{\"apiVersion\":\"policy/v1\",\"kind\":\"Eviction\",\"metadata\":{\"name\":\"$A\",\"namespace\":\"labs\"}}" > ev-demo.json
kubectl create --raw /api/v1/namespaces/labs/pods/$A/eviction -f ev-demo.json
```

```console
Error from server (TooManyRequests): Cannot evict pod as it would violate the pod's disruption budget.
```

That's the jam. The platform team can't remove a pod that has served nothing for the last minute, because the budget is in deficit and the default policy protects *every* pod while it is. In production this is a crashlooping pod from a bad rollout holding a node hostage. One field ends it:

```bash
kubectl patch pdb budget-demo --type merge -p '{"spec":{"unhealthyPodEvictionPolicy":"AlwaysAllow"}}'
kubectl create --raw /api/v1/namespaces/labs/pods/$A/eviction -f ev-demo.json
```

```console
poddisruptionbudget.policy/budget-demo patched
{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Success","code":201}
```

The broken pod goes; its replacement starts, touches `/tmp/ready`, and is Ready in seconds. Now try the **healthy** pod:

```bash
echo "{\"apiVersion\":\"policy/v1\",\"kind\":\"Eviction\",\"metadata\":{\"name\":\"$B\",\"namespace\":\"labs\"}}" > ev-demo.json
kubectl create --raw /api/v1/namespaces/labs/pods/$B/eviction -f ev-demo.json
```

```console
Error from server (TooManyRequests): Cannot evict pod as it would violate the pod's disruption budget.
```

Still protected — `AlwaysAllow` only releases pods that aren't Ready; the budget (`minAvailable: 2` of 2, still a permits-nothing shape) guards the healthy ones exactly as before. Four commands, and you've seen the whole argument for `AlwaysAllow` on stateless workloads, plus the reason [the stateful page](/disruption/stateful-and-quorum/) keeps the default for quorum members: a not-Ready member there is usually mid-resync, not broken.

## 6. Cordon — the landing half, on one node

Everything so far was about *whether* a pod may go. A drain has a second half: the replacement has to land somewhere. Cordon the only node and see what that half looks like when the answer is "nowhere":

```bash
kubectl cordon lima-k3s
kubectl get nodes
kubectl get node lima-k3s -o jsonpath='{.spec.taints}{"\n"}'
```

```console
node/lima-k3s cordoned
NAME       STATUS                     ROLES                  AGE   VERSION
lima-k3s   Ready,SchedulingDisabled   control-plane,master   62d   v1.31.5+k3s1
[{"effect":"NoSchedule","key":"node.kubernetes.io/unschedulable","timeAdded":"2026-09-10T02:33:48Z"}]
```

`SchedulingDisabled` is the cordon; the taint is what the scheduler actually honors. Nothing died. Now start a rollout, which needs to create a surge pod:

```bash
kubectl rollout restart deploy/orders-api
sleep 8
kubectl get pods -l app.kubernetes.io/name=orders-api
```

```console
NAME                          READY   STATUS    RESTARTS   AGE
orders-api-5f6f4fb9b7-fdsr2   0/1     Pending   0          9s
orders-api-6b7fd9cb95-8tq2m   1/1     Running   0          6m41s
orders-api-6b7fd9cb95-p4wzc   1/1     Running   0          7m03s
```

```bash
kubectl describe pod $(kubectl get pods -l app.kubernetes.io/name=orders-api --field-selector=status.phase=Pending -o jsonpath='{.items[0].metadata.name}') | tail -3
```

```console
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  9s    default-scheduler  0/1 nodes are available: 1 node(s) were unschedulable. no new claims to deallocate, preemption: 0/1 nodes are available: 1 Preemption is not helpful for scheduling.
```

`1 node(s) were unschedulable` — the cordon, from the pod's point of view. In production that line arrives mixed with the *other* reasons the survivors can't take you (`Insufficient memory`, anti-affinity, a pinned volume), and [the FailedScheduling decoder](/disruption/where-pods-land/#the-failedscheduling-decoder) reads them apart. Note the two old pods are untouched: with `maxUnavailable: 0` the rollout won't delete an old pod until the surge pod is Ready, and it never will be. Uncordon and watch it resolve:

```bash
kubectl uncordon lima-k3s
kubectl rollout status deploy/orders-api
```

```console
node/lima-k3s uncordoned
Waiting for deployment "orders-api" rollout to finish: 1 out of 2 new replicas have been updated...
Waiting for deployment "orders-api" rollout to finish: 1 old replicas are pending termination...
deployment "orders-api" successfully rolled out
```

Cordon is *no new pods here*. Drain is *and evict the old ones* — next.

## 7. A blocked drain, from the platform's seat

You can't drain your pods to another node, but you *can* run the real command against the only node and restrict it to your pods with `--pod-selector`, and the result is the most instructive stalemate in the section. Terminal C first, watching the budget and the pods:

```bash
kubectl get pdb orders-api -w
```

Terminal B:

```bash
kubectl drain lima-k3s --pod-selector app.kubernetes.io/name=orders-api --timeout=45s
```

```console
node/lima-k3s cordoned
evicting pod labs/orders-api-5f6f4fb9b7-fxdtf
evicting pod labs/orders-api-5f6f4fb9b7-fdsr2
error when evicting pods/"orders-api-5f6f4fb9b7-fxdtf" -n "labs" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.
evicting pod labs/orders-api-5f6f4fb9b7-fxdtf
error when evicting pods/"orders-api-5f6f4fb9b7-fxdtf" -n "labs" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.
pod/orders-api-5f6f4fb9b7-fdsr2 evicted
evicting pod labs/orders-api-5f6f4fb9b7-fxdtf
error when evicting pods/"orders-api-5f6f4fb9b7-fxdtf" -n "labs" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.
evicting pod labs/orders-api-5f6f4fb9b7-fxdtf
error when evicting pods/"orders-api-5f6f4fb9b7-fxdtf" -n "labs" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.
evicting pod labs/orders-api-5f6f4fb9b7-fxdtf
error when evicting pods/"orders-api-5f6f4fb9b7-fxdtf" -n "labs" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.
evicting pod labs/orders-api-5f6f4fb9b7-fxdtf
error when evicting pods/"orders-api-5f6f4fb9b7-fxdtf" -n "labs" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.
evicting pod labs/orders-api-5f6f4fb9b7-fxdtf
There are pending pods in node "lima-k3s" when an error occurred: error when evicting pods/"orders-api-5f6f4fb9b7-fxdtf" -n "labs": global timeout reached: 45s
pod/orders-api-5f6f4fb9b7-fxdtf
error: unable to drain node "lima-k3s" due to error: error when evicting pods/"orders-api-5f6f4fb9b7-fxdtf" -n "labs": global timeout reached: 45s, continuing command...
There are pending nodes to be drained:
 lima-k3s
error when evicting pods/"orders-api-5f6f4fb9b7-fxdtf" -n "labs": global timeout reached: 45s
```

Read it as the platform engineer does. The drain cordoned the node, then fired *both* evictions at once. The first was granted (`pod/…fdsr2 evicted`); the second got a 429 on the very first try — because the instant the first was granted, `ALLOWED` dropped to 0 — and the drain retried it every five seconds until its timeout. Terminal C over the same 45 seconds:

```console
NAME         MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
orders-api   N/A             1                 1                     9d
orders-api   N/A             1                 0                     9d
```

…and it never came back, because:

```bash
kubectl get pods -l app.kubernetes.io/name=orders-api
```

```console
NAME                          READY   STATUS    RESTARTS   AGE
orders-api-5f6f4fb9b7-fxdtf   1/1     Running   0          3m
orders-api-5f6f4fb9b7-qx8kp   0/1     Pending   0          44s
```

The evicted pod's replacement is `Pending` — the node is cordoned and there is no other node. `currentHealthy` is 1, `desiredHealthy` is 1, the budget permits nothing more, and the drain is waiting for a replacement that has nowhere to land *because the drain removed the room*. **The drain blocked itself.** This is [the stalemate the reference page describes](/disruption/where-pods-land/#there-is-nowhere-to-land) — and the Kubernetes documentation's own [three-node drain walkthrough](https://kubernetes.io/docs/concepts/workloads/pods/disruptions/) — in miniature, and it's what every "the drain is stuck on your namespace" message means when your budget is correct: the survivors are full.

Two things to notice about the ending. `--timeout=45s` produced the *platform-side* failure text — `global timeout reached` and `There are pending nodes to be drained` — which is what their tooling logs when it gives up; the default timeout is zero, meaning forever, and no automation uses it. And the node is still cordoned; a real drain that times out leaves it that way. Uncordon, and watch the stalemate dissolve without any further action from you:

```bash
kubectl uncordon lima-k3s
sleep 50
kubectl get pods -l app.kubernetes.io/name=orders-api
kubectl get pdb orders-api
```

```console
node/lima-k3s uncordoned
NAME                          READY   STATUS    RESTARTS   AGE
orders-api-5f6f4fb9b7-fxdtf   1/1     Running   0          4m
orders-api-5f6f4fb9b7-qx8kp   1/1     Running   0          94s
NAME         MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
orders-api   N/A             1                 1                     9d
```

The Pending pod scheduled, passed readiness, `currentHealthy` returned to 2, and the budget permits one again. On a production cluster the survivors have room and the second eviction proceeds a minute after the first — *if* the survivors have room. "Uncordon" is spelled "capacity" there, and [Where Your Pods Land](/disruption/where-pods-land/) is the checklist.

## 8. Jobs — stop burning retries

A Job pod that gets evicted fails, and by default that failure counts against `backoffLimit` as if your code had crashed. Create `~/k8s-labs/evictable-job.yaml` — two Jobs that differ by one rule:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: evictable
spec:
  backoffLimit: 0                     # no retries for real failures — makes the effect visible
  podFailurePolicy:
    rules:
      - action: Ignore                # a disruption doesn't count; the Job just runs a fresh pod
        onPodConditions:
          - type: DisruptionTarget
  template:
    spec:
      restartPolicy: Never            # required for podFailurePolicy
      terminationGracePeriodSeconds: 5
      containers:
        - name: work
          image: busybox:1.37
          command: ["sh", "-c", "trap 'exit 143' TERM; sleep 300 & wait"]
---
apiVersion: batch/v1
kind: Job
metadata:
  name: fragile
spec:
  backoffLimit: 0                     # same Job, no podFailurePolicy
  template:
    spec:
      restartPolicy: Never
      terminationGracePeriodSeconds: 5
      containers:
        - name: work
          image: busybox:1.37
          command: ["sh", "-c", "trap 'exit 143' TERM; sleep 300 & wait"]
```

```bash
kubectl apply -f evictable-job.yaml
sleep 8
for J in evictable fragile; do
  P=$(kubectl get pods -l batch.kubernetes.io/job-name=$J -o jsonpath='{.items[0].metadata.name}')
  echo "{\"apiVersion\":\"policy/v1\",\"kind\":\"Eviction\",\"metadata\":{\"name\":\"$P\",\"namespace\":\"labs\"}}" > ev-$J.json
  kubectl create --raw /api/v1/namespaces/labs/pods/$P/eviction -f ev-$J.json; echo
done
sleep 15
kubectl get jobs
kubectl get pods -l 'batch.kubernetes.io/job-name in (evictable,fragile)'
```

```console
{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Success","code":201}
{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Success","code":201}
NAME        STATUS    COMPLETIONS   DURATION   AGE
evictable   Running   0/1           25s        25s
fragile     Failed    0/1           25s        25s
NAME              READY   STATUS    RESTARTS   AGE
evictable-znrvh   1/1     Running   0          14s
```

Both evictions were granted (no PDB on Job pods — and there shouldn't be one). `evictable` is running again on a fresh pod, its failure count untouched; `fragile` is `Failed` with `BackoffLimitExceeded`, having spent its only retry on a disruption:

```bash
kubectl get job fragile -o jsonpath='{.status.conditions[?(@.type=="Failed")].reason}{"\n"}'
```

```console
BackoffLimitExceeded
```

One rule, and a drain across every node in the cluster can no longer fail your nightly batch. The rest of Job resilience — checkpointing on SIGTERM so the retry resumes instead of restarting — is [Graceful Shutdown's](/workloads/graceful-shutdown/#shutdown--everything-else) and [Jobs and CronJobs'](/workloads/jobs-and-cronjobs/).

## 9. A metric and an alert (optional — needs a monitoring stack)

Lab 10's step 6 installed a trimmed kube-prometheus-stack that includes kube-state-metrics, and its step 13 tore it down. Bringing it back takes about three minutes. If you did Lab 10, `~/k8s-labs/values-monitoring-lab10.yaml` and the Helm repo are already there; if you skipped it, create the values file first — it's Lab 6's stack with everything this step doesn't need switched off:

```yaml
# ~/k8s-labs/values-monitoring-lab10.yaml — skip if you did Lab 10
kubeEtcd: {enabled: false}
kubeControllerManager: {enabled: false}
kubeScheduler: {enabled: false}
kubeProxy: {enabled: false}
alertmanager: {enabled: false}
grafana: {enabled: false}
prometheus:
  prometheusSpec:
    retention: 2d
    resources:
      requests: {cpu: 200m, memory: 512Mi}
```

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  -f values-monitoring-lab10.yaml --wait --timeout 10m
kubectl -n monitoring port-forward svc/prometheus-operated 9090 >/dev/null & PROM_PID=$!
```

Open `http://localhost:9090/graph` and query the budget:

```promql
kube_poddisruptionbudget_status_pod_disruptions_allowed{namespace="labs"}
```

Two series — `orders-api` at `1`, `budget-demo` at `0` (its `minAvailable: 2` shape still permits nothing; that's the trap you left in place on purpose). Now the alert that would have paged *you* instead of the platform team. Create `~/k8s-labs/pdb-alert.yaml`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: labs-disruption
  namespace: labs
  labels:
    release: monitoring            # Lab 6's lesson: the operator only picks up rules with this label
spec:
  groups:
    - name: disruption
      rules:
        - alert: PDBPermitsNothing
          expr: kube_poddisruptionbudget_status_pod_disruptions_allowed{namespace="labs"} == 0
          for: 2m                  # lab pacing — production uses 30m
          labels:
            severity: warning
          annotations:
            summary: "PDB {{ $labels.poddisruptionbudget }} has permitted no evictions"
            runbook: "/disruption/pod-disruption-budgets/#unjamming-a-blocked-drain-right-now"
```

```bash
kubectl apply -f pdb-alert.yaml
```

Within about three minutes `http://localhost:9090/alerts` shows `PDBPermitsNothing` **firing** for `budget-demo`. Fix its shape the way step 4 fixed `orders-api`'s:

```bash
kubectl patch pdb budget-demo --type json -p '[{"op":"remove","path":"/spec/minAvailable"},{"op":"add","path":"/spec/maxUnavailable","value":1}]'
```

…and watch the alert go **inactive** on the next evaluation. That loop — budget at zero, a page, a ten-minute fix — is the difference between the six-hour Field Note and a log line. The production version of the rule, with `for: 30m` and two companions, is on [the contract page](/disruption/platform-contract/#alerts-and-dashboards).

## 10. The window runbook, run once

The [maintenance-window runbook](/disruption/platform-contract/#the-maintenance-window-runbook) is what a tenant runs around every platform window. Run its *before* and *after* halves against this cluster, so the first time isn't a real window. One piece of housekeeping first: if you skipped step 9, `budget-demo` still carries the permits-nothing shape you left in place on purpose — give it the same fix step 9 applied, or the first check below fails honestly:

```bash
kubectl patch pdb budget-demo --type json -p '[{"op":"remove","path":"/spec/minAvailable"},{"op":"add","path":"/spec/maxUnavailable","value":1}]'
```

Now the runbook:

```bash
# Before
kubectl get pdb                                                        # no ALLOWED DISRUPTIONS 0
kubectl rollout status deploy/orders-api --timeout=5s                  # no rollout in progress
kubectl get pods -o wide                                               # spread (one node here — n/a)
# After (against everything this lab evicted)
kubectl get pods --field-selector=status.phase=Failed                  # nothing left Failed by a kubelet
kubectl get events --field-selector reason=Killing | wc -l             # one Killing per death you caused
kubectl logs job/loadgen | grep -E "^Code"                             # the report from step 3
```

```console
NAME          MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
budget-demo   N/A             1                 1                     14m
orders-api    N/A             1                 1                     9d
deployment "orders-api" successfully rolled out
NAME                          READY   STATUS    RESTARTS   AGE   IP           NODE       NOMINATED NODE   READINESS GATES
budget-demo-77756468fc-mgjwv  1/1     Running   0          13m   10.42.0.37   lima-k3s   <none>           <none>
budget-demo-77756468fc-v4dhp  1/1     Running   0          14m   10.42.0.35   lima-k3s   <none>           <none>
orders-api-5f6f4fb9b7-fxdtf   1/1     Running   0          8m    10.42.0.40   lima-k3s   <none>           <none>
orders-api-5f6f4fb9b7-qx8kp   1/1     Running   0          6m    10.42.0.41   lima-k3s   <none>           <none>
No resources found in labs namespace.
10
Code 200 : 7500 (100.0 %)
```

Read the *after* half the way the reference page does: an evicted pod's object is gone, so its exit code isn't readable afterward — the evidence that each death was clean is the report that stayed at 100 % while it happened, the absence of `Failed` pods (only a kubelet leaves those behind), and one `Killing` event per death you caused (the count depends on how many drills you ran; the point is that you can account for every one). Every eviction on this page terminated cleanly because Lab 8's shutdown settings made each death clean and this lab only decided *which* deaths were allowed. The *during* half — three watch terminals — is what you ran by hand in steps 3 and 7.

## 11. Teardown

Keep the chart's new PDB shape; remove the demonstrations:

```bash
kubectl delete -f budget-demo.yaml -f evictable-job.yaml
kubectl delete job loadgen --ignore-not-found
[ -f pdb-alert.yaml ] && kubectl delete -f pdb-alert.yaml --ignore-not-found   # only if you did step 9
rm -f eviction.json ev-demo.json ev-evictable.json ev-fragile.json
kubectl uncordon lima-k3s
kubectl get pdb
```

```console
NAME         MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
orders-api   N/A             1                 1                     9d
```

If you reinstalled the monitoring stack in step 9, `kill $PROM_PID` and `helm uninstall monitoring -n monitoring` (the CRDs stay, as Lab 6 explained). What survives for [From the Lab to the Paved Road](/labs/from-lab-to-prod/): the chart's two-shape PDB template with its derivation comment and `AlwaysAllow` — the production pattern — and the muscle memory for `kubectl create --raw …/eviction`, which is how you'll test every budget you ever ship without asking anyone to drain a node.

## Where you are now

You've made the call a drain makes, and heard every answer it can give: `201`, the budget spent for exactly one startup; `429`, with the arithmetic in the response body and the same line the platform team pastes into their message; `429` again for a pod that served nothing, until one field released it; and a drain that granted one eviction and then blocked itself on a replacement with nowhere to land. You read the condition that says who killed a pod, and you kept a Job from spending a retry on a disruption.

What the lab deliberately left out is the part with people in it. Lab 8 made each death clean; this lab decided which deaths are allowed and when; production adds the nodes the replacements land on ([Where Your Pods Land](/disruption/where-pods-land/)), the numbers derived from what you promised users at both ends of the day ([the canonical PDB table](/disruption/pod-disruption-budgets/#the-canonical-pdb-table)), the workloads where one eviction is a role moving rather than a pod replaced ([stateful and quorum](/disruption/stateful-and-quorum/)), and the platform team whose drain timeout, grace override, and calendar you now know to ask for ([the contract](/disruption/platform-contract/)). The budget is the same object you just patched. The number, in production, is earned.
