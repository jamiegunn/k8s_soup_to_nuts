---
title: Drift and CI/CD
description: What happens to your emergency kubectl edits when the pipeline runs — apply, replace, Helm, and GitOps compared, with a will-it-stick decision matrix.
sidebar:
  order: 3
---

You made a live change during an incident. The only question that matters now is: **what happens when the pipeline runs?** The answer depends entirely on *how* your pipeline deploys, and the failure mode — a silent revert of your fix — is nastier than most outages, because it re-triggers the original incident at a time when nobody is watching for it.

This article is the map. Know which pipeline style you have before you need this at 2 AM.

## What drift actually is

**Drift** is any difference between the declared state (git, Helm values, the rendered manifests your CD tool holds) and the live state in the cluster. It has exactly two sources:

1. **You** (or a teammate, or an operator/controller) changed the cluster outside the pipeline.
2. **The pipeline** changed and nobody deployed yet — git is ahead of the cluster.

Case 2 resolves itself on the next deploy. Case 1 is the dangerous one, and it resolves itself too — by destroying your change. Drift isn't a sin; *unreconciled* drift is. The rest of this article is about knowing when and how the reconciliation hammer falls.

## The four pipeline styles and how they treat your edits

### 1. Plain `kubectl apply` pipelines

CI checks out the repo and runs `kubectl apply -f manifests/` on merge. Client-side apply does a **three-way merge** between (a) the last-applied-configuration annotation, (b) the live object, and (c) the manifest in the repo. The consequences are subtle and worth spelling out:

- **Fields the manifest sets, which you changed live: overwritten.** You bumped `memory: 1Gi` to `2Gi`; the manifest says `1Gi`; the next apply puts it back to `1Gi`. This is the classic clobber.
- **Fields you *added* live, which the manifest never mentions: they survive.** You added an env var `DEBUG_REFUNDS=true` and the manifest's env list doesn't include it — three-way merge sees it wasn't in last-applied and isn't being removed by the new manifest, so it stays. Same for an annotation, a toleration, sometimes a whole sidecar.
- **Fields that were in last-applied and are now removed from the manifest: deleted.** Apply prunes fields it used to own.

That second bullet sounds like a safety feature. It's actually the most treacherous behavior of the four styles, because it teaches you that live edits "stick" — right up until you make one that touches a managed field. Survival depends on the *field*, not on your intent.

:::caution[Server-side apply changes the rules]
Pipelines using `kubectl apply --server-side` merge based on managedFields ownership instead of the annotation. Your `kubectl edit` transfers field ownership to `kubectl-edit`; the pipeline's next apply then hits a **conflict** on that field and — if it runs with `--force-conflicts`, which most pipelines do to avoid getting stuck — takes the field back and overwrites you. Net effect for shared fields: same clobber, but at least `kubectl get -o yaml --show-managed-fields` shows the whole custody battle.
:::

### 2. `kubectl replace` pipelines

Rare, but they exist (often in older Jenkins jobs): `kubectl replace -f` or `kubectl apply --force`. There is no merge. The entire object is swapped for the file in git. **Every live change is gone**, added fields included. At least it's honest.

### 3. Helm pipelines

CI runs `helm upgrade payments ./chart -f values-prod.yaml`. Helm renders the templates into complete manifests and applies them, using its own three-way merge against the *previous release's* rendered manifests. In practice, for anything the chart templates:

- **Anything not derivable from chart + values does not survive an upgrade.** Your live memory bump isn't in `values-prod.yaml`, so the rendered manifest still says `1Gi`, and the upgrade sets it back.
- Fields you added that the chart never templates *can* survive Helm's three-way merge — same caveat as style 1, same treachery.
- `helm rollback` is even harsher: it targets the stored release manifest wholesale.

The operational habit that matters: with Helm, **the fix goes in values, not in the cluster**. If you must fix live, your follow-up PR edits `values-prod.yaml` (or the chart), and until it merges, every `helm upgrade` — including ones triggered by unrelated changes — reverts you.

Check what Helm thinks the object should look like, and diff it against reality:

```bash
helm get manifest payments -n shop | kubectl diff -f -
```

### 4. GitOps reconcilers (Argo CD, Flux)

A controller *continuously* compares live state to git and can correct differences on its own — no human deploy required. Two knobs decide your fate:

- **Argo CD** with `syncPolicy.automated.selfHeal: true` reverts your live edit on the next reconciliation loop — typically **within about 3 minutes**, often faster. Without selfHeal, the app goes `OutOfSync` and your edit survives until the next sync (a git push, or a human clicking Sync).
- **Flux** (kustomize-controller / helm-controller) reconciles on an interval — commonly 1–10 minutes — and reverts drift on managed fields by default.

With a self-healing reconciler, **live patching alone is not a viable incident tactic.** Your fix lasts minutes. Your real options during an incident:

1. **Make git the fix** — merge the hotfix and let the reconciler deploy it. This is the intended path and it's often fast (Argo picks up the commit in seconds if webhooks are configured).
2. **Pause reconciliation first, then patch** — if you have Argo/Flux API access: disable auto-sync or suspend the Kustomization. If you don't (common in the platform-team-owns-Argo world), this is a request to the platform team — a scripted, two-line ask you should have pre-agreed. See [Working with the platform team](/operations/working-with-platform-team/).

**Spotting a GitOps-managed resource without UI access.** You may not have Argo CD credentials, but the resource itself carries fingerprints:

```bash
kubectl get deployment payments -o yaml | grep -E 'argocd|flux|kustomize.toolkit|helm.toolkit'
```

```yaml
  labels:
    app.kubernetes.io/instance: payments-prod        # Argo's default tracking label
  annotations:
    argocd.argoproj.io/tracking-id: payments-prod:apps/Deployment:shop/payments
  # Flux equivalents:
  labels:
    kustomize.toolkit.fluxcd.io/name: payments
    kustomize.toolkit.fluxcd.io/namespace: flux-system
```

Also check managedFields: a manager named `argocd-controller` or `kustomize-controller` on your Deployment means a robot owns it. If you see those fingerprints, assume **minutes, not hours**, before any live edit is reverted — and test it: make a harmless annotation edit and see how long it lasts.

## The decision matrix: will my emergency edit stick?

| Pipeline style | Changed a field the pipeline sets | Added a field the pipeline never sets | Reverted when? |
|---|---|---|---|
| `kubectl apply` (client-side) | **Clobbered** | Usually survives | Next deploy |
| `kubectl apply --server-side --force-conflicts` | **Clobbered** | Usually survives | Next deploy |
| `kubectl replace` / `--force` | **Clobbered** | **Clobbered** | Next deploy |
| `helm upgrade` | **Clobbered** | Often survives (untemplated fields) | Next deploy of *anything* in the release |
| Argo CD / Flux, self-heal on | **Clobbered** | Usually clobbered (Argo diffs the full desired object) | **Minutes** |
| Argo CD / Flux, self-heal off | Survives until sync, then clobbered | Varies | Next sync |

Read the matrix pessimistically. "Usually survives" is not a plan; it's a description of why you'll be surprised someday.

## Safe patterns

**Make git the fix, ASAP.** Not a pattern so much as the law. The PR that matches live state is part of the incident response, not the cleanup. Until it merges, set a tripwire: a note in the deploy channel, a hold label on the pipeline if you have one, an annotation on the resource.

**Scale via HPA `minReplicas`, not `replicas`.** If an HPA owns the workload, raw `kubectl scale` is undone by the HPA within seconds — a reconciler even faster than Argo. Raising `minReplicas` cooperates with the autoscaler instead of fighting it. (The HPA object is probably pipeline-managed too, so it's still drift — but it's drift that *holds* until the next deploy rather than 15 seconds.) See [Autoscaling](/workloads/autoscaling/).

**Parking values in unmanaged fields — rarely safe, sometimes necessary.** The three-way-merge styles let added fields survive. Teams exploit this: an env var the manifest never mentions, an annotation namespace the chart doesn't template. It works until someone refactors the manifest to set that field, or the team migrates to GitOps and every parked value evaporates in one sync. If you do this, it must be *documented drift*: annotate the resource, open a ticket, and treat it as a loan like any other.

**Prefer self-healing changes.** A [rollout restart](/operations/restarts-without-redeploy/) leaves zero drift. `rollout undo` leaves drift only in the image tag, which the next honest deploy fixes in the right direction. Structural edits (resources, env, probes) are maximum-drift changes — budget the PR time before you make them.

## The horror story, properly told

**Tuesday 02:10** — `payments` OOMKilled every few minutes under a batch-job memory spike. On-call bumps the limit live:

```bash
kubectl patch deployment payments -p \
  '{"spec":{"template":{"spec":{"containers":[{"name":"payments","resources":{"limits":{"memory":"2Gi"}}}]}}}}'
```

Pods roll, stabilize. On-call writes "bumped payments mem limit, will PR tomorrow" in the incident channel and sleeps. No PR. No annotation.

**Tuesday 09:00** — A teammate merges a copy change to the checkout page. The monorepo pipeline runs `helm upgrade` on the whole release. The rendered manifest says `memory: 1Gi`, because `values-prod.yaml` never changed. The Deployment's pod template changes back → rolling update → every pod restarts with the old limit.

**Tuesday 09:05** — The batch job from last night? Still running. OOM storm, this time at peak morning traffic. The deploy that caused it touched *checkout copy*, so the first twenty minutes of the new incident are spent staring at the wrong diff. Eventually someone runs:

```bash
kubectl get deploy payments -o yaml --show-managed-fields | grep -B2 -A6 kubectl-patch
```

...and finds the 02:14 patch that no longer exists in the live object — the tombstone of the reverted fix.

Total cost: two incidents, one of them at peak, plus an hour of misdirected diagnosis. Price of prevention: a five-minute PR at 02:30. The 9:05 storm wasn't caused by the memory spike; it was caused by **unreconciled drift**. See the [OOM storm card](/operations/emergency-playbooks/) for the drill, and [OOMKilled](/troubleshooting/oomkilled/) for the memory forensics.

## Detecting drift before it bites

Don't wait for the deploy to discover drift — hunt it.

**`kubectl diff` in CI (or cron).** The single highest-value guard. Before the pipeline applies, diff and surface the result:

```bash
kubectl diff -f manifests/ ; rc=$?
# rc=0: no drift. rc=1: drift found. rc>1: error.
```

```console
$ kubectl diff -f manifests/payments.yaml
-        resources:
-          limits:
-            memory: 2Gi
+        resources:
+          limits:
+            memory: 1Gi
```

Read that diff carefully: it shows the apply **would change live 2Gi back to 1Gi**. A pipeline that posts this diff to the PR — or better, requires an explicit ack when the diff includes fields changed by a non-pipeline manager — turns silent clobbers into visible decisions. Helm teams get the same via `helm diff upgrade` (plugin) or the `helm get manifest | kubectl diff -f -` trick above.

**A nightly drift report.** A CronJob (or CI schedule) running `kubectl diff` against main and posting non-empty output to the team channel means drift is caught within a day, not at the next deploy. Ten lines of shell, saves incidents.

**GitOps teams get this for free** — `OutOfSync` *is* the drift report. If you can't see the Argo UI, ask the platform team to route Argo's sync-status notifications for your apps to your channel. It's a cheap ask with a fast yes.

:::tip[The morning-after habit]
If you were paged overnight, your first command at your desk is `kubectl diff` against main for every resource you touched. Either the diff is empty (you already reconciled — well done) or it's your to-do list.
:::

## Summary

- Drift is a loan; the pipeline is the collector. Know your pipeline style and you know the repayment date — next deploy for apply/Helm, **minutes** for self-healing GitOps.
- Changed managed fields always get clobbered. Added unmanaged fields sometimes survive — never rely on it.
- The PR is part of the incident, not the cleanup. File it before you sleep, and leave an annotation trail ([Live patching](/operations/live-patching/) shows how).
- `kubectl diff` in CI turns silent reverts into visible diffs. It's the cheapest insurance in this entire guide.
