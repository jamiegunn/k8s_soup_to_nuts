---
title: Emergency Playbooks
description: Copy-paste incident cards for the six most common production emergencies — bad deploy, traffic spike, poisoned pod, OOM storm, bad config, and state capture.
sidebar:
  order: 8
---

Print this page. Literally — or pin it in your on-call channel. At 2 AM you don't want theory; you want the commands in order. Each card follows the same shape: **trigger → immediate actions → verification → follow-up**. The follow-ups are not optional — every card ends in a PR, because every live change here creates drift that [your pipeline will otherwise clobber](/operations/drift-and-cicd/).

Throughout: replace `payments` / `shop` with your workload and namespace, and add `-n <namespace>` if your kubeconfig doesn't default correctly. Before any spec-changing action, remember the reconciler question — if Argo/Flux self-heal manages this resource, your change lasts minutes unless git changes too.

---

## Card A: Bad deploy going out right now

**Trigger:** Error rate climbing during/just after a rollout; new pods crashlooping; canary metrics red.

**Immediate actions:**

```bash
# 1. Freeze the rollout where it stands — stops further pod replacement
kubectl rollout pause deployment/payments

# 2. Look at what's actually happening
kubectl rollout status deployment/payments
kubectl get pods -l app=payments   # old vs new ReplicaSet hash in pod names

# 3a. If the new version is definitely bad: roll back
kubectl rollout undo deployment/payments
# (or to a specific revision: kubectl rollout history deployment/payments
#  then kubectl rollout undo deployment/payments --to-revision=N)

# 4. Resume so the undo can proceed (undo on a paused rollout waits for resume)
kubectl rollout resume deployment/payments
```

**Verification:**

```bash
kubectl rollout status deployment/payments          # completes cleanly
kubectl get pods -l app=payments                    # all Running/Ready, one RS hash
kubectl get deploy payments -o jsonpath='{.spec.template.spec.containers[0].image}'  # old image confirmed
# ...and your error-rate dashboard back to baseline
```

**Follow-up:** Tell CI/CD humans immediately — the bad version is still at HEAD, and the next merge redeploys it. Revert the commit or land the fix *before* anything else merges. Rollback mechanics in depth: [Rollouts and rollbacks](/workloads/rollouts-and-rollbacks/).

---

## Card B: Traffic spike

**Trigger:** Latency/queue depth climbing, CPU saturated across pods, HPA pinned at max (or absent).

**Immediate actions:**

```bash
# Is an HPA in charge? This decides which command works.
kubectl get hpa
NAME       REFERENCE             TARGETS    MINPODS  MAXPODS  REPLICAS
payments   Deployment/payments   91%/70%    3        10       10        # ← pinned at max

# HPA exists → raise its ceiling (and floor, to force immediate scale-out):
kubectl patch hpa payments --type merge -p '{"spec":{"maxReplicas":20,"minReplicas":10}}'

# No HPA → scale directly:
kubectl scale deployment/payments --replicas=16
```

**Verification:**

```bash
kubectl get pods -l app=payments | grep -c Running     # count climbing to target
kubectl get pods -l app=payments | grep Pending        # empty, or you have a capacity/quota problem
kubectl describe resourcequota                          # headroom check if Pending
kubectl top pod -l app=payments --containers            # per-pod load dropping
```

Pods stuck Pending → [Pod pending](/troubleshooting/pod-pending/); if it's quota or node capacity, that's a platform-team ask with this card's outputs attached.

**Follow-up:** PR the new HPA bounds (raw `kubectl scale` on an HPA-managed workload is reverted by the HPA within ~15s — the fix *must* land in the HPA, then in git). Then ask why the spike beat your autoscaling: [Autoscaling](/workloads/autoscaling/).

---

## Card C: One pod poisoned

**Trigger:** Exactly one replica misbehaving — errors from one pod name, one hot memory graph, one wedged consumer — while its siblings are fine.

**Immediate actions — isolate, don't kill.** Deleting it destroys your evidence. Instead, change its labels so the Service stops routing to it AND the ReplicaSet replaces it, while the pod itself stays alive for forensics:

```bash
# 1. Identify the culprit precisely
kubectl get pods -l app=payments -o wide

# 2. Pull it out of the Service and the ReplicaSet in one move:
#    remove the selector label, add a quarantine marker
kubectl label pod payments-7d4b9c5f6-x2k1p app- quarantine=inc-4821
```

What just happened: the Service's endpoints drop the pod (no more traffic to it), and the ReplicaSet — which selects on `app=payments` — no longer counts it, so it **immediately creates a healthy replacement**. Capacity restored, patient preserved.

```bash
# 3. Forensics on the quarantined pod at your leisure
kubectl logs payments-7d4b9c5f6-x2k1p --previous
kubectl exec payments-7d4b9c5f6-x2k1p -- jcmd 1 Thread.print > /tmp/inc-4821-threads.txt
kubectl debug payments-7d4b9c5f6-x2k1p -it --image=busybox --target=payments
```

**Verification:**

```bash
kubectl get endpoints payments -o yaml | grep -c ip:   # back to full replica count, culprit absent
kubectl get pods -l quarantine=inc-4821                # quarantined pod still Running
```

**Follow-up:** When forensics are done (JVM apps: [thread dumps](/java/thread-dumps-jre-only/) and heap dumps first), `kubectl delete pod payments-7d4b9c5f6-x2k1p`. No spec drift was created — this card is drift-free. File the root-cause ticket: one poisoned pod usually means input-dependent state, and it will happen again.

:::caution
The quarantined pod still passes probes and still runs — it may still consume from queues or hold locks even without Service traffic. If it's a queue consumer, stop the consumption (exec in, or accept killing it after a quick dump).
:::

---

## Card D: OOM storm

**Trigger:** Pods restarting fleet-wide with `OOMKilled` in `kubectl describe`; restart counts climbing in lockstep.

**Immediate actions:**

```bash
# 1. Confirm it's actually OOM
kubectl get pods -l app=payments   # RESTARTS column climbing
kubectl describe pod payments-7d4b9c5f6-x2k1p | grep -A3 'Last State'
    Last State:  Terminated
      Reason:    OOMKilled
      Exit Code: 137

# 2. Bump the limit live (Deployment-level → rolling update with the new limit)
kubectl patch deployment payments -p \
  '{"spec":{"template":{"spec":{"containers":[{"name":"payments","resources":{"limits":{"memory":"2Gi"}}}]}}}}'

kubectl rollout status deployment/payments
```

JVM app? The container limit and the heap ceiling move together — if the app pins `-Xmx`, bumping only the container limit changes nothing. See [Resource tuning in prod](/operations/resource-tuning-in-prod/) before step 2.

**Verification:**

```bash
kubectl get pods -l app=payments        # restarts stopped, all Ready
kubectl top pod -l app=payments         # working set comfortably under new limit
kubectl get events --field-selector reason=OOMKilling -w   # silence
```

**Follow-up — this is the card the horror story is about:** the limit you just set exists only in the cluster. The next deploy reverts it and re-runs this incident at peak traffic. **Open the PR mirroring the new limit before you stand down** — [Drift and CI/CD](/operations/drift-and-cicd/) tells that story with timestamps. Then root-cause the memory growth: [OOMKilled](/troubleshooting/oomkilled/).

---

## Card E: Bad config value shipped

**Trigger:** Behavior broke right after a config-only change (ConfigMap/Secret update, with or without a restart).

**Immediate actions:**

```bash
# 1. What changed, and how is it consumed? (decides whether a revert needs a restart)
kubectl get configmap payments-config -o yaml
kubectl get deploy payments -o yaml | grep -B3 -E 'configMapKeyRef|envFrom|subPath'

# 2. Revert the ConfigMap to the last good values
#    Best source: git. From the last good commit:
git show HEAD~1:manifests/payments-configmap.yaml | kubectl apply -f -

# 3. Make the revert take effect — restart unless you *know* the app hot-reloads
kubectl rollout restart deployment/payments
kubectl rollout status deployment/payments
```

If the config is versioned (immutable ConfigMaps, `-v42`/`-v43` names, or kustomize hash suffixes), step 2 is even cleaner: point the Deployment back at the previous name — that's a pod-template change, so no separate restart needed. Note `kubectl rollout undo` **won't** help for a ConfigMap edit: the Deployment revision history only tracks pod-template changes, and an in-place ConfigMap edit isn't one.

**Verification:**

```bash
kubectl exec deploy/payments -- cat /etc/payments/timeout-ms   # old value live in the pod
# env-consumed: kubectl exec deploy/payments -- printenv PAYMENTS_TIMEOUT_MS
```

...plus the behavior itself back to normal.

**Follow-up:** Revert or fix the config in git (if the bad value came *through* the pipeline, git still holds it — your live revert is drift until the git revert lands). Propagation rules, the subPath trap, and the checksum-restart pattern: [ConfigMap and Secret rotation](/operations/configmap-secret-rotation/).

---

## Card F: Triage snapshot — capture state before it self-heals

**Trigger:** Any incident. Run this **first**, before you fix anything. Kubernetes is aggressively self-healing, which also means aggressively *evidence-destroying*: events expire in ~1 hour, restarted pods lose their previous filesystem, replaced pods lose everything.

```bash
#!/usr/bin/env bash
# snapshot.sh NAMESPACE [INCIDENT_ID] — namespace triage snapshot, tenant-RBAC only
set -uo pipefail
NS="${1:?usage: snapshot.sh NAMESPACE [INCIDENT_ID]}"
INC="${2:-inc-$(date -u +%Y%m%dT%H%M%SZ)}"
DIR="./${INC}-${NS}"
mkdir -p "$DIR"/{describe,logs,logs-previous}
echo "Snapshotting namespace '$NS' into $DIR"

kubectl -n "$NS" get events --sort-by=.lastTimestamp -o wide > "$DIR/events.txt"
kubectl -n "$NS" get all,cm,pdb,hpa,ingress,endpoints -o wide  > "$DIR/inventory.txt"
kubectl -n "$NS" get pods -o yaml --show-managed-fields       > "$DIR/pods-full.yaml"
kubectl -n "$NS" get deploy,sts,ds -o yaml --show-managed-fields > "$DIR/controllers-full.yaml"
kubectl -n "$NS" top pod --containers > "$DIR/top.txt" 2>/dev/null

for pod in $(kubectl -n "$NS" get pods -o name); do
  name="${pod#pod/}"
  kubectl -n "$NS" describe "$pod" > "$DIR/describe/$name.txt"
  kubectl -n "$NS" logs "$pod" --all-containers --tail=2000 \
    > "$DIR/logs/$name.log" 2>/dev/null
  kubectl -n "$NS" logs "$pod" --all-containers --tail=2000 --previous \
    > "$DIR/logs-previous/$name.log" 2>/dev/null || rm -f "$DIR/logs-previous/$name.log"
done

tar czf "${DIR}.tar.gz" "$DIR" && echo "Wrote ${DIR}.tar.gz — attach to the incident ticket."
```

Runs in ~30 seconds on a typical namespace, needs nothing beyond standard tenant RBAC, and captures the four things you will otherwise lose: **events** (gone in an hour), **`--previous` logs** (gone on the next restart), **describe output** (state/restart-reason gone when pods are replaced), and **managedFields** (your who-changed-what forensic record — see [Live patching](/operations/live-patching/)). Keep it in your team repo; run it by reflex.

**Follow-up:** attach the tarball to the ticket *before* the fix, so the postmortem argues from data instead of memory. Reading the captured events well: [Events](/observability/events/); overall approach: [Triage methodology](/troubleshooting/triage-methodology/).

---

## The universal footer

Whatever card you ran, the incident isn't over until:

1. **Git matches live.** Every spec change above (Cards A, B, D, E) has a PR open or merged.
2. **The annotation trail exists**: `kubectl annotate deploy/payments incident.example.com/live-edit="<when> <what> <ticket> <who>"`.
3. **The snapshot is attached** to the ticket.
4. **The root-cause question is assigned** — a restart or a bumped limit is treatment, not diagnosis.

Cards get you through the night. The footer keeps the night from repeating.
