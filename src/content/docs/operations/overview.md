---
title: Operations Overview
description: How to make live changes in production Kubernetes without getting clobbered by your own CI/CD pipeline.
sidebar:
  order: 1
---

It's 2:14 AM. Your service is throwing OOMKilled events, you've bumped the memory limit with `kubectl edit`, the pods are stable, and you go back to bed. At 9:00 AM a teammate merges an unrelated PR, the pipeline deploys, and the manifest in git — which still says the old limit — flattens your fix. By 9:05 you have an OOM storm and a much worse morning than the night you just survived.

That story, in some form, has happened on every team that runs Kubernetes. This section is about making sure it stops happening to yours.

## The core tension

You live between two truths that both matter:

1. **Production is live.** During an incident, the fastest safe fix wins. `kubectl scale`, `kubectl set image`, `kubectl edit` — these exist because sometimes you cannot wait 20 minutes for a pipeline run.
2. **The pipeline is the source of truth.** Whatever is in git (or your Helm values, or your Argo CD app) is what the cluster *will* look like after the next sync or deploy. The cluster's current state is a temporary opinion.

Every live change you make creates **drift**: a gap between what's running and what's declared. Drift is not automatically bad — it's how you survive incidents. *Unmanaged* drift is bad, because it gets silently reverted, or silently persists until nobody remembers why production doesn't match git.

The whole game is: **make live changes deliberately, record them immediately, and reconcile them fast.**

## The golden rules

These come up in every article in this section. Internalize them.

### 1. Every live change gets a ticket or PR — immediately, not "later"

Before you close the laptop after an emergency edit, open the PR that makes git match what you just did. Not tomorrow. Not "after standup." The half-life of your memory of a 2 AM change is about six hours, and the pipeline does not wait for you to remember.

```bash
# The last command of every incident:
git checkout -b hotfix/bump-payments-memory
# ... edit the manifest to match what you changed live ...
git commit -m "Bump payments memory limit to 2Gi (matches live emergency edit, INC-4821)"
git push && gh pr create --fill
```

If you genuinely can't PR it right now, at minimum annotate the resource so the change is discoverable:

```bash
kubectl annotate deployment payments \
  incident.example.com/live-edit="2026-07-03T02:14Z memory limit 1Gi->2Gi, INC-4821, @gunn"
```

### 2. Know your reconciler

Before you make a live change, you must know what will try to undo it and when:

| Your pipeline style | What happens to your live edit |
|---|---|
| CI runs `kubectl apply` on merge | Survives until the next deploy; then shared fields are overwritten |
| CI runs `helm upgrade` | Reverted on next deploy — Helm renders the full spec from chart + values |
| Argo CD / Flux with self-heal | Reverted **within minutes**, no human action required |
| Argo CD / Flux without self-heal | Marked OutOfSync; reverted on next sync |

If you don't know which of these you have, find out *before* your next incident. [Drift and CI/CD](/operations/drift-and-cicd/) covers each in detail, including how to identify a GitOps-managed resource from labels alone.

### 3. Prefer changes that self-heal

Given two ways to fix something live, pick the one that converges back to the declared state on its own:

- **Restart, don't mutate.** `kubectl rollout restart` changes nothing about the spec that matters; when it's done, you have zero drift. Compare that to editing an env var, which is drift until someone reconciles it.
- **Edit the controller, not the pod.** Anything you do to a Pod directly (labels, env via exec, killing a process) evaporates when the pod is replaced. Edit the Deployment and at least your change survives pod churn — even if it doesn't survive the pipeline.
- **Scale via HPA bounds, not raw replicas.** If an HPA manages the workload, `kubectl scale` is a suggestion the HPA will overrule. Raise `minReplicas` instead — and if the HPA itself is pipeline-managed, that's drift too. Know your reconciler.

:::tip[The one-sentence version]
A live change is a loan against your pipeline. The interest rate is "silent revert at the worst possible time." Pay it back with a PR before you sleep.
:::

## Changes ranked by drift risk

Not all live interventions are equal. Rank them and default to the lowest rung that fixes the problem:

| Risk | Change | Why |
|---|---|---|
| None | `kubectl rollout restart` | No meaningful spec change; converges to declared state on its own |
| None | Deleting one pod (with PDB headroom) | ReplicaSet rebuilds it from the template; nothing to reconcile |
| Low | `kubectl rollout undo` | Drifts only the image tag, and the next honest deploy fixes it forward |
| Medium | Scaling / HPA bounds | One integer of drift; usually harmless if it reverts, but PR it anyway |
| High | Editing resources, env, probes, images | Structural drift; a silent revert re-triggers the original incident |
| Highest | Anything done to a Pod directly | Doesn't even survive pod churn — evaporates before the pipeline gets a shot |

## Do this before your next incident

Ten minutes of homework, once, per service you own:

1. **Identify the reconciler.** Look at the resource itself for fingerprints:

```bash
kubectl get deployment payments -o yaml | grep -E 'argocd|fluxcd|helm.sh|app.kubernetes.io/managed-by'
```

`managed-by: Helm` means Helm pipelines; `argocd.argoproj.io/*` or `fluxcd.io/*` labels mean a GitOps reconciler that may revert you in minutes. No fingerprints usually means plain `kubectl apply` from CI.

2. **Time the hammer.** In staging, add a harmless annotation live and watch how long it survives. That number — minutes for self-healing GitOps, "until next deploy" for everything else — is your emergency-edit budget.

3. **Find the manifest.** Know exactly which file in which repo produces this Deployment. During an incident, "where do I PR this?" should take zero seconds. Pin the answer somewhere greppable — an annotation works:

```bash
kubectl annotate deployment payments \
  docs.example.com/source="github.com/acme/shop-deploy/manifests/payments.yaml"
```

(Argo CD's tracking annotations and Helm's release metadata often answer this already — check before adding your own.)

4. **Bookmark the playbooks.** [Emergency playbooks](/operations/emergency-playbooks/) is designed to be open in a tab at 2 AM.

## What's in this section

| Article | What it covers |
|---|---|
| [Live patching](/operations/live-patching/) | The emergency toolkit: `scale`, `set image`, `edit`, `patch` (all three flavors), plus how to prove afterward who changed what |
| [Drift and CI/CD](/operations/drift-and-cicd/) | The flagship. How each pipeline style treats your live edits, the will-it-stick decision matrix, and detecting drift before it bites |
| [ConfigMap and Secret rotation](/operations/configmap-secret-rotation/) | Updating config without a full redeploy — including the subPath trap and the checksum-annotation pattern |
| [Restarts without redeploy](/operations/restarts-without-redeploy/) | `kubectl rollout restart` mechanics, pod deletion, restart storms, and why "it needed a restart" isn't a root cause |
| [Resource tuning in prod](/operations/resource-tuning-in-prod/) | Changing requests/limits safely: it's a rolling restart, so plan it; evidence-gathering first; in-place resize on newer clusters |
| [Working with the platform team](/operations/working-with-platform-team/) | The org interface: what's theirs vs yours, writing requests that get fast yeses, RBAC asks, upgrade readiness |
| [Emergency playbooks](/operations/emergency-playbooks/) | Copy-paste incident cards: bad deploy, traffic spike, poisoned pod, OOM storm, bad config, and a triage snapshot script |
| [Helm and Kustomize](/operations/helm-and-kustomize/) | Driving the manifest machines your pipeline already uses: overlays, patches, values files, and rendered-manifest debugging |
| [GitOps for tenants](/operations/gitops-for-tenants/) | Living with Argo CD or Flux when the platform runs it: the PR-driven workflow, sync mechanics, and emergencies under GitOps |
| [Image and supply-chain security](/operations/supply-chain-security/) | Base images, digest pinning, CI scanning, SBOMs, and signing — securing what you ship |
| [API deprecations and cluster upgrades](/operations/api-deprecations/) | Surviving upgrades you don't control: detection with pluto/kubent, the pre-upgrade routine, and behavior changes that bite |

## The vocabulary this section uses

Four terms recur constantly; here's exactly what they mean in these pages:

- **Drift** — any difference between what your source of truth declares (git, Helm values) and what's live in the cluster. Live edits create it; deploys and reconcilers destroy it (usually by destroying your edit).
- **Reconciler** — anything that actively pushes live state back toward declared state. Your CI/CD pipeline is a slow, human-triggered reconciler. Argo CD and Flux are fast, automatic ones. The HPA is a reconciler for one field (`replicas`). The ReplicaSet is a reconciler for pods. Every live change you make is a bet about which reconcilers will notice and when.
- **Self-heal** — a reconciler configured to correct drift *without* a human clicking anything. Argo CD's `selfHeal: true` is the canonical example. On a self-healing system, an unmerged live edit has a lifespan measured in minutes.
- **Clobber** — the silent revert of your live change by a deploy or sync. The word is informal; the incident it causes is not.

## A 60-second mental rehearsal

Next time you're about to run `kubectl edit` on production, narrate this to yourself:

1. *What reconcilers watch this resource?* (Pipeline? GitOps? HPA? An operator?)
2. *When will the fastest one run next?* That's my deadline for making git match.
3. *Am I editing the right layer?* (Deployment, not Pod — pod-level changes don't even survive churn.)
4. *Could a restart or rollback fix this instead?* Those are drift-free or drift-cheap.
5. *Where's the manifest, and what's my PR going to say?*

If you can answer all five in under a minute, make the edit. If you can't answer the first two, you're not making an emergency fix — you're planting one.

## Prerequisites

This section assumes you're comfortable with the material in [Working without admin](/start/working-without-admin/) — you have namespace-scoped access, you can't touch nodes or cluster-scoped resources, and a platform team owns everything below your namespace boundary. It also leans on [Deployments](/workloads/deployments-deep-dive/) mechanics: rolling updates, ReplicaSets, and what counts as a pod-template change.

If you only read two articles here, read [Live patching](/operations/live-patching/) and [Drift and CI/CD](/operations/drift-and-cicd/). They're two halves of the same skill: making the change, and making the change stick.

:::note[A word on culture]
Everything in this section assumes a team where "I edited prod live" is a normal sentence said out loud in the incident channel, not a confession. If your culture punishes disclosed live edits, you'll get undisclosed ones instead — and undisclosed drift is the kind that reruns incidents at 9:05 AM. The rules here (ticket immediately, know your reconciler, prefer self-healing changes) only work when following them is cheaper, socially and procedurally, than hiding. Make the honest path the easy path: a pinned PR template for "match live state," a standing agreement that incident-time edits are pre-authorized, and a blameless review of every drift event. The tooling in the rest of this section is the easy 20%; this paragraph is the hard 80%.
:::
