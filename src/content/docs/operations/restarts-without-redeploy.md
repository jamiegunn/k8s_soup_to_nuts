---
title: Restarts Without Redeploy
description: How kubectl rollout restart actually works, when deleting pods is fine, how to avoid restart storms, and why "it needed a restart" still needs a root cause.
keywords:
  - kubectl rollout restart
  - restartedat annotation
  - delete pod replacement replicaset
  - poddisruptionbudget eviction budget
  - restart storm thundering herd
  - statefulset restart reverse ordinal
  - turn it off and on again
  - memory leak fresh heap
  - cronjob manual rerun
  - startupprobe crashloopbackoff
  - cold start cache spike
sidebar:
  order: 5
---

"Turn it off and on again" is a legitimate Kubernetes operation — arguably *the* most common production intervention. Done right, it's also the safest: a restart changes no spec fields that matter, so it leaves **zero drift** for your pipeline to clobber. This article covers doing it right.

## kubectl rollout restart: the canonical safe restart

```bash
kubectl rollout restart deployment/payments
deployment.apps/payments restarted

kubectl rollout status deployment/payments
Waiting for deployment "payments" rollout to finish: 3 of 6 updated replicas are available...
deployment "payments" successfully rolled out
```

**What it actually does** — worth knowing precisely, because "restart" is doing a lot of work in that name. The command patches one annotation into the pod template:

```yaml
spec:
  template:
    metadata:
      annotations:
        kubectl.kubernetes.io/restartedAt: "2026-07-03T09:41:22Z"
```

A pod-template change means the Deployment controller performs an ordinary rolling update. So — does it create a new ReplicaSet? **Yes, technically** (the template hash changed), but it's the *same template* in every way you care about: same image, same env, same resources. What you get is new pods, created and drained under the full protection of the rollout machinery:

- `maxSurge` / `maxUnavailable` govern the pace — you never drop below your availability floor.
- Readiness probes gate traffic — a new pod serves nothing until it's ready ([Health checks](/workloads/health-checks/)).
- `terminationGracePeriodSeconds` and preStop hooks give old pods a clean drain.
- PodDisruptionBudgets are respected implicitly, because the controller replaces pods at the configured pace rather than evicting them.

Works identically for DaemonSets and StatefulSets (`kubectl rollout restart statefulset/valkey` — pods restart in reverse ordinal order, honoring the update strategy).

**Drift note:** the `restartedAt` annotation is technically a template change your pipeline doesn't know about, but every mainstream CD tool (Argo CD included) ignores or tolerates it, and the next real deploy overwrites the template anyway. Effectively drift-free — which is why the [overview's](/operations/overview/) golden rule says *prefer changes that self-heal*, and restart is the archetype.

### Watching a restart land

Don't fire-and-forget. A restart that wedges halfway is a degraded fleet, and the two usual wedges are failing readiness on the new pods and PDB/quota pressure blocking surge:

```bash
kubectl rollout restart deployment/payments
kubectl get pods -l app=payments -w
NAME                        READY   STATUS        RESTARTS   AGE
payments-6f8d9b7c4-old1     1/1     Running       0          3d
payments-84c7f5d9b-new1     0/1     Running       0          8s      # new RS hash, warming up
payments-84c7f5d9b-new1     1/1     Running       0          31s     # Ready → next old pod drains
payments-6f8d9b7c4-old1     1/1     Terminating   0          3d
```

If new pods never go `1/1`, the restart just found a latent problem — a config that no longer parses, a dependency that changed under you, an image that got garbage-collected from the registry. That's valuable information, and it's exactly why restarting through the rollout machinery beats mass-deleting pods: the old, working pods are still serving while you investigate. `kubectl rollout undo` won't help here (the template is effectively identical); fix the underlying issue or, if the new pods are failing on something transient, `kubectl rollout restart` again once it clears.

## Deleting individual pods

Sometimes you want to restart *one* pod: the single wedged replica, the one with a poisoned cache, the memory hog.

```bash
kubectl delete pod payments-7d4b9c5f6-x2k1p
pod "payments-7d4b9c5f6-x2k1p" deleted
```

The ReplicaSet notices it's one short and creates a replacement immediately — that's [reconciliation](/controllers/reconciliation/) doing its job. For **Deployments** this is safe-ish, with caveats:

- **You momentarily run n-1.** Delete respects grace periods but not your rollout strategy. On a 2-replica service, that's a 50% capacity dip; on a 20-replica one, noise. Wait for the replacement to be Ready before deleting the next.
- **Only ever delete by exact pod name.** `kubectl delete pod -l app=payments` restarts *everything at once*, ungated — that's an outage, not a restart.

For **StatefulSets, order matters.** Ordinals carry meaning (ordinal 0 is often primary, or holds the raft leader). Deleting `valkey-0` casually can trigger failover, split-brain windows, or election churn. Prefer `kubectl rollout restart statefulset/...` (reverse-ordinal, one at a time, waits for Ready), and if you must delete one pod, know its role first — see [StatefulSets fundamentals](/stateful/statefulsets-fundamentals/).

**Drain-style single-pod restart.** For extra safety on the individual delete, mimic what a node drain does — use the eviction API so PDBs are consulted:

```bash
# Evict rather than delete: refused if it would violate a PDB
kubectl delete pod payments-7d4b9c5f6-x2k1p --dry-run=server   # sanity: name is right
kubectl get pdb                                                 # is there budget?
NAME       MIN AVAILABLE   ALLOWED DISRUPTIONS   AGE
payments   2               1                     90d
```

`ALLOWED DISRUPTIONS: 1` means you can take one pod right now without breaching the budget. If it's `0`, the fleet is already degraded — deleting a pod anyway is how a wobble becomes an outage. (Plain `kubectl delete pod` bypasses PDBs entirely; the PDB check is you doing manually what eviction does automatically. If your RBAC includes `pods/eviction`, `kubectl drain`-style tooling can do it for you, but per-pod eviction via kubectl requires the API — checking the PDB by hand is the practical equivalent.)

### What about Jobs and CronJobs?

There's no `rollout restart` for Jobs — a Job's pod template is immutable and its lifecycle is run-to-completion, not run-forever. Your options are different in kind:

```bash
# Re-run a CronJob's logic right now, without waiting for the schedule
kubectl create job payments-recon-manual-0703 --from=cronjob/payments-recon

# A wedged Job: delete it (finalizers permitting) and let the next schedule —
# or your manual re-run — take over. There is no "restart in place."
kubectl delete job payments-recon-28374651
```

Make sure the job is idempotent before manual re-runs; details in [Jobs and CronJobs](/workloads/jobs-and-cronjobs/).

## What a restart fixes — and what it doesn't

Restarts genuinely fix real problems, because they reset *accumulated state*:

- **Memory leaks / heap fragmentation** — fresh process, fresh heap. (If it's a JVM, capture a [heap dump](/java/heap-dumps-jre-only/) *before* restarting, or the evidence dies with the pod.)
- **Wedged connection pools** — connections to a database that failed over an hour ago, DNS pinned to a dead endpoint, TCP connections black-holed by a network blip. Restart = reconnect from scratch.
- **Config re-read** — apps that only load config at startup pick up updated ConfigMaps ([ConfigMap and Secret rotation](/operations/configmap-secret-rotation/)).
- **Deadlocks, stuck threads, runaway executors** — anything where the process is alive enough to pass liveness probes but internally seized.

What a restart does **not** fix:

- **Anything driven by input.** Bad data, a poison-pill message being redelivered from the queue, a request-of-death from a client on a retry loop. The pod restarts, the same input arrives, it wedges again — now on a schedule.
- **Capacity problems.** Under-provisioned CPU/memory comes right back; restarting an OOMKilling pod is just choosing when it dies ([OOMKilled](/troubleshooting/oomkilled/)).
- **Anything outside the pod.** Node pressure, a full PVC, an upstream outage, a misconfigured Service.
- **State in volumes.** A corrupt file on a PVC survives every restart by design.

:::caution["It needed a restart" is a symptom, not a diagnosis]
If a restart fixed it, something *accumulated* — and it will accumulate again. Every restart-fix deserves a follow-up ticket: what leaked, what wedged, what wasn't re-reading config? Take the diagnostics before you restart (thread dump, heap dump, `kubectl describe`, logs — the [triage snapshot script](/operations/emergency-playbooks/) exists for this), because a restart is evidence destruction. Teams that skip this end up with a CronJob that restarts the service nightly, which is a memory leak with a pension.
:::

## Restart storms and thundering herds

The dangerous restarts aren't the ones you plan — they're the correlated ones. A whole fleet starting simultaneously produces:

- **Cold-start load spikes**: empty caches, JIT warm-up, connection-pool ramp — every pod is at its slowest exactly when it gets its share of full traffic.
- **Dependency hammering**: 50 pods opening 20 DB connections each within the same second, or all fetching the same config service, can knock over the dependency — which fails the probes, which restarts pods, which... that's the storm.
- **Startup-order dependencies**: if `payments` needs `pricing` up first, a simultaneous restart of both is a coin flip. (Fix the app to retry with backoff; ordering restarts by hand is a workaround, not a solution.)

Defenses:

- **Let the rollout machinery stagger for you.** `rollout restart` with a sane `maxUnavailable` (e.g. `25%` or `1`) *is* a staggered restart. Don't defeat it with `kubectl delete pod -l ...`.
- **Stagger across services yourself.** Restarting five services? One at a time, `rollout status` between each.
- **Startup probes** (`startupProbe`) keep slow-starting apps from being liveness-killed mid-warmup — the classic accelerant that turns a slow restart into a [CrashLoopBackOff](/troubleshooting/crashloopbackoff/) storm.
- **Jitter scheduled restarts.** If you must restart on a schedule (see the pension note above), never at :00 on the hour, and never every service at once.

## Quick reference

```bash
# The safe default: staggered, probe-gated, PDB-friendly, drift-free
kubectl rollout restart deployment/NAME && kubectl rollout status deployment/NAME

# One pod only (Deployments; check PDB budget first)
kubectl get pdb
kubectl delete pod POD_NAME

# StatefulSets: reverse-ordinal, one at a time
kubectl rollout restart statefulset/NAME

# Never do this in production
kubectl delete pod -l app=NAME        # simultaneous restart of everything
```

Restart is the intervention with the best risk-to-drift ratio in your entire toolkit: no spec change, no pipeline conflict, full rollout protections. Just capture your evidence first, and file the ticket for *why* it needed one.
