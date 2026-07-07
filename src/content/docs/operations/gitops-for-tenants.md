---
title: GitOps for Tenants
description: Living with Argo CD or Flux when the platform team runs it — git is the API now, and this is the day-to-day driving manual.
keywords:
  - argo cd application
  - flux reconciler
  - outofsync
  - selfheal
  - prune deleted resource
  - sync waves and hooks
  - ignoredifferences hpa
  - kustomization crd
  - helmrelease
  - suspend resume reconciliation
  - my change merged but nothing happened
  - tracking-id annotation
sidebar:
  order: 10
---

Somewhere in the cluster — in a namespace you can't see — a reconciler is running a loop: fetch a git path at a revision, render it, compare it to your namespace, and make the namespace match. Continuously. Forever. That's GitOps from the tenant seat, and it changes your job description: **git is the API now**. `kubectl apply` is read-only — either literally (RBAC blocks writes) or by futility (self-heal reverts your edit in seconds). The full drift mechanics are in [Drift and CI/CD](/operations/drift-and-cicd/); this article is the day-to-day driving manual.

The reconciler itself is just a controller doing what all controllers do — see [Reconciliation](/controllers/reconciliation/) — but this one's desired state lives in a git repo instead of in the cluster.

:::tip[War story]
Prune semantics bit for real in the Field Note [The Prune That Ate Our ConfigMap](/blog/the-prune-that-ate-our-configmap/) — a hand-created resource in an Argo-managed namespace, deleted at 4pm on a Friday.
:::

## Recognizing the setup from your seat

You can identify the tool and often the source repo without any access beyond your namespace.

**Argo CD** stamps everything it manages:

```console
$ kubectl get deploy payments-api -o yaml | grep -A4 'labels:\|annotations:' | head -12
  annotations:
    argocd.argoproj.io/tracking-id: payments-prod:apps/Deployment:payments/payments-api
  labels:
    app.kubernetes.io/instance: payments-prod
```

`app.kubernetes.io/instance: payments-prod` is the Argo **Application** name. That Application object (which lives in the platform's `argocd` namespace, so you probably can't read it directly) contains the repo URL, path, and target revision feeding your namespace.

**Flux** uses its own label family:

```console
$ kubectl get deploy payments-api -o yaml | grep toolkit
    kustomize.toolkit.fluxcd.io/name: payments-prod
    kustomize.toolkit.fluxcd.io/namespace: flux-system
```

That names the Flux **Kustomization** resource managing you. For Helm-based Flux delivery you'll see `helm.toolkit.fluxcd.io/*` labels instead.

Either way, your first move as a tenant: ask platform for the spec of your Application/Kustomization — repo, path, branch/tag, sync interval, prune and self-heal settings. Get it in writing in your runbook. This is a standard, reasonable ask; see [Working with the platform team](/operations/working-with-platform-team/).

## The workflow that replaces kubectl apply

```text
edit manifests → PR → review → merge → reconciler notices → sync → verify
```

The step people underestimate is **"reconciler notices."** Two mechanisms:

- **Webhook**: git host pings the reconciler on push. Sync starts within seconds of merge.
- **Polling**: reconciler checks the repo on an interval. Argo defaults to ~3 minutes; Flux Kustomizations commonly poll git every 1–10 minutes per the `interval` field.

If your org's webhook is configured (and not silently broken — see the debugging checklist below), merges land fast. If it's polling, budget the interval into every "why isn't my change live yet" moment before you panic.

### Watching a sync land with only namespace access

Best case, platform granted you read on your Application:

```console
$ kubectl get application payments-prod -n argocd
NAME            SYNC STATUS   HEALTH STATUS
payments-prod   Synced        Healthy
```

No such luck? You can still see the sync arrive from inside your namespace:

```bash
# Deployment generation bumps when the reconciler writes a change
kubectl get deploy payments-api -o jsonpath='{.metadata.generation}{"\n"}'

# The tracking annotation / last-applied changes on sync
kubectl get deploy payments-api -o yaml | grep -m1 tracking-id

# Events show the rollout the sync triggered
kubectl get events --sort-by=.lastTimestamp | tail -20

# And the ultimate truth: the new image tag
kubectl get deploy payments-api -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

A watch loop on the image field is a perfectly good poor-man's sync monitor:

```bash
kubectl get deploy payments-api -w \
  -o custom-columns=GEN:.metadata.generation,IMAGE:'.spec.template.spec.containers[0].image'
```

## Argo CD specifics a tenant meets

### Sync status vs health status

These are orthogonal, and conflating them wastes triage time:

| | Meaning | Examples |
|---|---|---|
| **Sync status** | Does live match git? | `Synced`, `OutOfSync` |
| **Health status** | Is the workload actually OK? | `Healthy`, `Progressing`, `Degraded`, `Missing`, `Suspended` |

`Synced` + `Degraded` = your manifests applied fine and your app is broken — that's a you-problem, start at [triage methodology](/troubleshooting/triage-methodology/). `OutOfSync` + `Healthy` = git moved ahead (or someone edited live) and nothing has applied yet. `Missing` = the resource is in git but not in the cluster — often a failed sync or a pruned resource.

### Sync waves and hooks

Argo applies resources in **waves** (`argocd.argoproj.io/sync-wave: "-1"` runs before wave 0) and supports **hooks** — the classic being a PreSync database migration Job:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: payments-migrate
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: registry.example.com/payments/api:2026.07.03-a1b2c3d
          command: ["./migrate", "up"]
```

:::caution[A stuck hook wedges the whole app]
The sync does not proceed past a PreSync hook until the Job completes. Migration Job crash-looping? **Nothing else in the Application updates** — not the Deployment, not the ConfigMap fix you merged to unbreak the migration. You'll see the Application stuck `Progressing` and a Job in your namespace with failing pods. Fix: make the hook's fix land (the `BeforeHookCreation` delete policy means the next sync attempt replaces the Job), or ask platform to terminate the sync. Always set `backoffLimit` and `activeDeadlineSeconds` on hook Jobs so failure is fast and visible instead of eternal.
:::

### Sync policy: automated, prune, selfHeal

Three flags on the Application decide how aggressive the reconciler is:

- **automated**: syncs on git change without a human clicking Sync. Without it, merges sit `OutOfSync` until someone syncs manually.
- **prune**: deletes live resources that aren't in git. This is why the ConfigMap you created by hand *inside the managed path* vanished on the next sync — Argo saw an object with its tracking label pattern in a managed namespace and no counterpart in git, and pruned it. It wasn't a bug. It was the contract.
- **selfHeal**: reverts live drift back to git even with *no* git change. Typical detection is within seconds to the ~3-minute refresh; your `kubectl edit` lifespan is exactly that window. Full analysis in [Drift and CI/CD](/operations/drift-and-cicd/).

### ignoreDifferences: ending the HPA tug-of-war

The classic fight: git says `replicas: 3`, the HorizontalPodAutoscaler scaled you to 8, Argo marks you `OutOfSync` (and with selfHeal, scales you back down — then the HPA scales you up — forever). The fix is platform-side configuration on the Application:

```yaml
spec:
  ignoreDifferences:
    - group: apps
      kind: Deployment
      name: payments-api
      jsonPointers:
        - /spec/replicas
```

(Better still: remove `replicas` from your manifest entirely when an HPA owns it.) You can't set `ignoreDifferences` yourself — it lives on the Application — so this is a named, specific platform ask. Same pattern applies to any controller-managed field: cert-manager-injected caBundles, webhook-injected sidecars, defaulted fields on [CRDs](/controllers/crds-explained/).

## Flux specifics, briefly

Same mental model, different nouns:

- A **Kustomization** (the Flux CRD, not the kustomize file) has `interval` (how often to reconcile), `prune: true/false` (same vanishing-resource semantics as Argo), and `path`/`sourceRef` pointing at a GitRepository.
- A **HelmRelease** renders a chart with values that come *from git* — your values change is a PR like everything else, and Flux runs the `helm upgrade` for you. Chart-consumption skills from [Helm and Kustomize](/operations/helm-and-kustomize/) apply directly.
- **suspend/resume** is the platform-side pause button: `flux suspend kustomization payments-prod` stops reconciliation entirely until resumed. This is what you ask for when you need the reconciler to stand still during an incident.

Flux has no UI by default and its status lives in CRD conditions: if you're granted read, `kubectl get kustomization -n flux-system payments-prod` shows `READY` and a human-readable last-error message that is usually the entire answer.

## Emergencies under GitOps

**The revert commit is your rollback**, and it's genuinely fast: `git revert <merge-sha>`, merge (with whatever expedited-review path your org has for incidents), and the reconciler applies the previous state within the sync interval. No artifact rebuild, no pipeline rerun — git history *is* the deployment history. For most incidents this beats fighting the reconciler.

When you truly must `kubectl edit` NOW — the fix can't wait one sync interval, or the sync itself is what's broken:

1. **Pause first.** Ask platform to disable selfHeal / suspend the Kustomization / set a sync window for your app. An unpaused reconciler will revert your fix mid-incident, which re-triggers the outage — the worst possible timing.
2. **Make the live edit** (see [Live patching](/operations/live-patching/) for the mechanics).
3. **Open the PR immediately** — the same change, in git, before you leave the incident channel. The pause ends; git must already agree with the cluster when it does.

This pause-edit-PR sequence belongs in your [emergency playbooks](/operations/emergency-playbooks/), including the platform contact who can pause syncs at 3 AM.

## Environment promotion

Two patterns you'll encounter:

- **Directory per environment** (`envs/dev/`, `envs/staging/`, `envs/prod/` on one branch): promotion is a PR that copies/bumps a tag or overlay value from one directory to another. One branch, one history, trivially diffable environments (`diff envs/staging envs/prod`), no merge-order pain.
- **Branch per environment** (`dev`/`staging`/`prod` branches): promotion is a merge between branches. Sounds natural, decays badly — branches accumulate env-specific commits, merges stop being clean, and "what's actually different between staging and prod" requires archaeology.

Dir-per-env wins. If your org uses branch-per-env, drive carefully and never commit directly to an env branch. **Preview environments** — a per-PR namespace spun up from the PR's revision (Argo ApplicationSets, Flux + templates) — are a platform feature worth asking about, not something you can build tenant-side.

## What to ask platform for

A concrete shopping list — all standard capabilities, all reasonable asks:

1. **Read access to your Application/Kustomization status** (Argo projects support per-tenant RBAC; Flux CRDs can be read-granted). Debugging blind is miserable.
2. **Notifications on sync failure** — Argo's notification engine or Flux alerts to your team's Slack channel. A failed sync you don't know about is drift you don't know about.
3. **Your sync topology in writing**: repo, path, revision, interval, webhook-or-polling, prune/selfHeal flags.
4. **ignoreDifferences** wherever a controller legitimately owns a field (HPA replicas above all).
5. **A documented pause procedure** for incidents, with out-of-hours contacts.

## Debugging "my change merged but nothing happened"

Run the checklist in order; each step eliminates a layer.

```text
1. Right repo/path/branch?   Your PR merged to main, but the Application tracks
                             a tag, or a different path, or release-* branches.
                             Verify against the spec from platform.
2. Reconciler noticed?       Webhook dead → you're on polling; wait out the
                             interval before concluding anything. Check when the
                             tracking annotation/generation last changed.
3. Sync failed?              Application OutOfSync with a sync error, or Flux
                             Kustomization READY=False. Invalid YAML, failed
                             kustomize build, immutable-field conflict. Status
                             message names the resource — this is why you asked
                             for read access.
4. Hook stuck?               A PreSync Job in your namespace crash-looping blocks
                             everything behind it. kubectl get jobs; check logs.
5. Resource pruned/excluded? Your new file isn't referenced by the kustomization,
                             matches an exclusion, or landed outside the tracked
                             path. Renders locally: kubectl kustomize <path> —
                             is your resource in the output?
6. Synced but not rolled?    Sync applied, pods didn't change: your change didn't
                             touch the pod template (ConfigMap edit without a hash
                             suffix or restart — see /workloads/configuration/),
                             or the rollout is stuck on probes/quota.
```

Step 6 is the boundary: once the manifests have demonstrably applied, you're out of GitOps territory and into an ordinary rollout problem — [Deployments deep dive](/workloads/deployments-deep-dive/) takes it from there.
