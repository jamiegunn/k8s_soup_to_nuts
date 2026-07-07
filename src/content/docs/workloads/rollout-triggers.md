---
title: What Triggers a Rollout
description: The pod-template rule that decides when a Deployment rolls — which edits replace pods, which silently don't, how to force a rollout on config changes, and how to pause the trigger entirely.
keywords:
  - deployed but nothing rolled
  - why is everything restarting
  - configmap change no rollout
  - latest tag no-op deploy
  - kubectl rollout restart
  - kubectl rollout pause resume
  - paused deployment ignoring apply
  - checksum annotation config
  - rollme randalphanum helm
  - pod template hash trigger
  - apply is idempotent
sidebar:
  order: 4
---

The Deployment controller doesn't know what you *meant* to deploy. It watches exactly one thing: the pod template. If `spec.template` changed, every pod gets replaced. If it didn't, nothing happens — no matter how important the change felt. Nearly every rollout surprise, in both directions ("I deployed and nothing rolled" and "why is everything restarting?"), traces back to that one rule.

This article is about the *trigger*. How the replacement proceeds once it fires — surge, unavailability, `kubectl rollout status`, rollback — is [rollouts and rollbacks](/workloads/rollouts-and-rollbacks/).

## The one rule: the template is the trigger

Whenever anything under `spec.template` changes, the controller hashes the new template, creates a ReplicaSet for that hash, and rolls traffic over to it per your strategy — the full mechanics are in the [deployments deep dive](/workloads/deployments-deep-dive/). Whenever the template *doesn't* change, the controller does nothing, and `kubectl apply` is a clean no-op.

It doesn't matter which door the change came through — `kubectl apply` from your pipeline, `kubectl set image`, `kubectl edit`, a `patch`, a GitOps sync. The controller never sees the door. It sees the template.

Two corollaries worth internalizing:

1. **Apply is idempotent.** Re-applying the same manifest ten times produces zero rollouts. If your "deploy" pipeline ran green but nothing rolled, the template it applied was byte-for-byte what the cluster already had — usually a pipeline that rebuilt the same image tag.
2. **The trigger is dumb on purpose.** It can't tell a critical security patch from a typo fix in a label. Both roll the whole fleet. Anything you put in the template, you're agreeing to roll pods for.

## What rolls and what doesn't

| Change | Rollout? |
|---|---|
| Container image | **Yes** |
| `env` / `envFrom` (the *references*, e.g. adding a var or pointing at a different ConfigMap) | **Yes** |
| Resource requests/limits, probes, volumes, mounts | **Yes** |
| Labels or annotations on the **template** (`spec.template.metadata`) | **Yes** |
| Init containers, sidecars, `serviceAccountName`, affinity, tolerations | **Yes** |
| `replicas` | No — scaling reuses the current ReplicaSet |
| `strategy` (`maxSurge` / `maxUnavailable`), `minReadySeconds`, `progressDeadlineSeconds`, `revisionHistoryLimit` | No |
| Labels or annotations on the **Deployment** (`metadata`, not the template) | No |
| The **contents** of a ConfigMap or Secret the pods reference | No |

The "no" column hides two traps:

- **Strategy and timing edits land silently and take effect on the *next* rollout.** Change `maxUnavailable` from 0 to 50% today and nothing happens — until someone ships a routine image bump three weeks later and half the fleet vanishes mid-deploy. When you touch these knobs, review them as if they were running code, because next deploy they are. Tuning them well is the [rollout & shutdown knobs](/tuning/rollout-shutdown-knobs/) page.
- **Config contents are the famous gap.** You edit a ConfigMap, the pipeline applies it, everything is green, and the pods keep running with the old values — the ConfigMap isn't part of the template, only the *reference* to it is. This one gets its own section below.

## Triggering on purpose

**The normal path** is a new image tag flowing through your pipeline: build stamps a unique tag, manifest gets the new tag, template changes, fleet rolls. Boring is correct here.

:::caution[The `:latest` retag trap]
If your pipeline re-pushes to the *same* tag (`:latest`, `:prod`), the manifest doesn't change, so the template doesn't change, so **nothing rolls** — your deploy is a no-op no matter what's in the registry. Worse, the new code then arrives piecemeal over the following weeks as individual pods get rescheduled and pull the "same" tag with different contents. You end up running two versions at once with no rollout, no history, and no rollback target. One immutable tag per build (or a digest) makes the tag change *be* the trigger.
:::

**Rolling with no spec change** — you want fresh pods, same everything (stale connections, poisoned cache, picking up rotated config):

```console
$ kubectl rollout restart deploy/payments
```

This works *by* the template rule, not around it: it patches a `kubectl.kubernetes.io/restartedAt` timestamp annotation into the template, which is a template change, which triggers an ordinary rolling update with all the usual protections. The full treatment — including why this beats deleting pods — is [restarts without redeploy](/operations/restarts-without-redeploy/).

**Batching several edits into one rollout** — image, resources, and an env var changing together shouldn't roll the fleet three times. Either apply them as one manifest change (what a pipeline does naturally), or pause the trigger while you stack imperative edits — see below.

## The config gap: making ConfigMap changes roll

Since config contents don't touch the template, a config-only change needs to be *made into* a template change. Three standard ways, in ascending order of machinery:

- **Checksum annotation** — template an annotation with a hash of the config, so config edits change the template: `checksum/config: {{ ... | sha256sum }}` in Helm, or computed in CI and patched in.
- **Name-versioned config** — Kustomize's `configMapGenerator` appends a content hash to the ConfigMap *name* and rewrites every reference; new name → new template → rollout. Same idea as immutable, versioned ConfigMaps done by hand.
- **Reloader** — a controller that watches ConfigMaps/Secrets and triggers a rollout restart on your behalf, if your platform team offers it.

All three are covered properly, with the trade-offs, in [ConfigMap & Secret rotation](/operations/configmap-secret-rotation/). The anti-pattern is having *none* of them: config changes then activate at random, one pod at a time, whenever something happens to restart — weeks after anyone validated the change.

## Rollouts you didn't mean to trigger

The inverse failure: everything in the template rolls pods, including things people assume are cosmetic.

- **Build metadata stamped into the template.** A `deployedAt` timestamp or CI build-ID annotation inside `spec.template.metadata` means *every pipeline run* rolls the entire fleet, even when nothing else changed. If you want build info attached, put it on the Deployment's own `metadata` (doesn't roll) or accept that pods roll on every run — deliberately, not accidentally.
- **Helm's `rollme: {{ randAlphaNum 5 }}` trick.** Some charts template a random value into the pod template so every `helm upgrade` restarts pods. That's a legitimate blunt instrument for the config gap, but inherit a chart that does it and you'll wonder why value-only tweaks bounce production. Grep your chart for it.
- **"Just adding a label" to the template.** Adding `version:` or team labels for dashboards is fine and normal — but it's a real rollout. Ship it with a release, not as a Friday-afternoon tidy-up. (And never add it to the *selector* — that's [immutable](/workloads/deployments-deep-dive/).)
- **GitOps auto-sync.** With ArgoCD or Flux auto-syncing, *merging* is the trigger; the roll starts whenever the controller next syncs, not when you press anything. Fine — that's the point — but it also means a template-touching change merged "to deploy later" deploys now, and a 3 a.m. `kubectl rollout undo` gets re-reverted at the next sync. Know your sync policy; the drift story is in [drift and CI/CD](/operations/drift-and-cicd/).

## Freezing the trigger: pause and resume

`kubectl rollout pause` (or `spec.paused: true` in the manifest) disconnects the trigger. Template changes still land on the Deployment object, but no new ReplicaSet is created and nothing rolls until you resume — at which point all accumulated changes ship as **one** rollout:

```console
$ kubectl rollout pause deploy/payments
$ kubectl set image deploy/payments payments=registry.example.com/checkout/payments:1.42.1
$ kubectl set resources deploy/payments -c payments --requests=cpu=500m
$ kubectl rollout resume deploy/payments
```

Pause is also the mid-flight freeze: a rollout looks wrong, `kubectl rollout pause`, and the fleet holds its current mixed state while you investigate instead of marching on. Scaling still works while paused — `replicas` isn't the trigger.

:::danger[A forgotten pause is a silent deploy blackhole]
A paused Deployment accepts every apply and rolls none of them. Your pipeline stays green, `kubectl get deploy` looks normal, and pods quietly run code from three releases ago. Pausing also suspends the `progressDeadlineSeconds` clock, so nothing ever flags the stall. If a Deployment seems to ignore deploys, check the trigger before anything else:

```console
$ kubectl get deploy payments -o jsonpath='{.spec.paused}'
true
```

And if GitOps manages the object, pause via `spec.paused: true` **in git** — an imperative pause is drift that auto-sync may simply undo.
:::

## Quick reference

| You want to… | Do this |
|---|---|
| Roll new code | Change the image to a unique tag/digest; let the template change trigger it |
| Roll with zero spec changes | `kubectl rollout restart` |
| Roll when config changes | Checksum annotation, name-versioned ConfigMaps, or Reloader |
| Ship several edits as one rollout | One manifest change, or `pause` → edit → `resume` |
| Change surge/timing *without* rolling now | Just apply it — takes effect on the next rollout (review accordingly) |
| Stop a rollout mid-flight | `kubectl rollout pause`, then fix forward or [roll back](/workloads/rollouts-and-rollbacks/) |
| Stop deploys entirely during a freeze window | `spec.paused: true` in git — and a calendar reminder to unset it |

From here: [rollouts and rollbacks](/workloads/rollouts-and-rollbacks/) for driving the roll itself, and [rollout & shutdown knobs](/tuning/rollout-shutdown-knobs/) for tuning every dial on it.
