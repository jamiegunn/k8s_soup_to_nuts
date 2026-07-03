---
title: "Field Notes: The Prune That Ate Our ConfigMap"
description: A ConfigMap hand-created during a hotfix lived happily in our Argo-managed namespace for six weeks. Then the platform team enabled prune, and Argo deleted it at 4pm on a Friday — correctly.
date: 2026-05-05
authors: editor
tags:
  - gitops
  - argocd
  - configmaps
  - drift
excerpt: >-
  For six weeks, a hand-made ConfigMap kept our payment routing alive, and nobody remembered it wasn't in git. Then the platform team turned on prune, Argo deleted it at 4:04pm on a Friday, and the app didn't even blink — until the weekend's first pod churn, when it boot-looped its way into our Sunday.
---

The deletion happened at 16:04 on a Friday. Nothing paged. Nothing paged Saturday either. The incident arrived at 02:47 Sunday morning, which is the second-worst time to learn how GitOps pruning works, the worst being never.

## Six weeks earlier: the hotfix

During a March incident, we needed to override payment-provider routing *now* — one provider was failing, and the routing rules live in a ConfigMap the app reads at startup. The on-call engineer did the fast, reasonable thing. Needing a new ConfigMap and not wanting to write YAML from scratch at the peak of an incident, she copied an existing one as a template:

```console
$ kubectl get configmap pricing-rules -o yaml > /tmp/routing.yaml
# edit: new name (payment-routing), new data, delete server-side fields
$ kubectl apply -f /tmp/routing.yaml
configmap/payment-routing created
$ kubectl set env deployment/payments-api --from=configmap/payment-routing
```

Incident resolved in twenty minutes. The Deployment change made it into git the following week during cleanup — someone PR'd the `envFrom` block properly. The ConfigMap itself did not. It sat in the cluster, referenced by a git-managed Deployment, defined nowhere but etcd. A load-bearing ghost.

There's a detail in that copy-paste that matters enormously later: `pricing-rules` is Argo-managed, so its YAML carried Argo's tracking label. The template edit fixed the name and the data, but nobody stripped the labels:

```yaml
metadata:
  name: payment-routing
  labels:
    app.kubernetes.io/instance: payments-prod   # Argo's tracking label, inherited
```

That one inherited line told Argo CD: *this resource belongs to the `payments-prod` Application.* Argo dutifully agreed — and immediately noticed it couldn't find `payment-routing` anywhere in git. From that day on, the Application showed `OutOfSync`, with the ConfigMap flagged as an extra resource that git didn't know about.

Why didn't anyone see that? Because our app had shown `OutOfSync` for *months* — the HPA writes `replicas`, a mutating webhook injects annotations, and our read-only Argo dashboard had been orange so long that orange had become the background color. A status that's always on is a status that's off.

## Friday, 16:04: the platform does exactly what it said it would

Six weeks later, the platform team rolled out a fleet-wide hygiene change they had announced in two emails and a town hall none of us connected to ourselves: enabling automated sync with pruning on tenant Applications.

```yaml
# The Application (platform-owned; we see it read-only)
syncPolicy:
  automated:
    prune: true
    selfHeal: true
```

Prune means: resources that Argo tracks as part of the app but that no longer exist in git get deleted on sync. That is the *entire point* of the feature — git is the source of truth, and anything tracked-but-not-in-git is, by definition, drift to be corrected. Our ConfigMap, wearing the tracking label it had inherited from a copy-paste, was tracked-but-not-in-git. At the next sync, 16:04 Friday, Argo pruned it. Correctly. By its lights, it had just cleaned up our namespace.

And here's why nothing paged: **deleting a ConfigMap does not touch running pods.** Env vars were resolved at container start; they live in process memory now. The pods sailed on, fully functional, powered by configuration that no longer existed. The app was a cartoon character who'd run off the cliff and hadn't looked down.

## Sunday, 02:47: pod churn looks down

Saturday night, the platform team did routine node maintenance — cordon, drain, the usual. Our pods got evicted and rescheduled, and the replacements tried to resolve their env vars:

```console
$ kubectl get pods -l app=payments-api
NAME                            READY   STATUS                       RESTARTS   AGE
payments-api-59c8d7f4b6-8mzkq   0/1     CreateContainerConfigError   0          3h
payments-api-59c8d7f4b6-p2vtx   0/1     CreateContainerConfigError   0          3h
payments-api-59c8d7f4b6-wr6hd   0/1     CreateContainerConfigError   0          2h

$ kubectl describe pod payments-api-59c8d7f4b6-8mzkq | tail -3
  Warning  Failed  2m (x412 over 3h)  kubelet
    Error: configmap "payment-routing" not found
```

Every drained pod was replaced by one that couldn't start. Capacity bled out node by node through the night until the survivors couldn't hold the load, and *that* finally paged. The on-call engineer's view at 02:47: pods failing to find a ConfigMap that, as far as anyone awake knew, had existed forever — and no deploy, no merge, no change of ours anywhere in the timeline. Our own [triage methodology](/troubleshooting/triage-methodology/) says "what changed?" and the honest answer appeared to be *nothing*.

## Forensics with read-only access

We don't own the cluster, Argo, or the audit log, so the forensics had to work with tenant-grade access. Kubernetes events were already gone (short TTL — a deletion from Friday is long expired by Sunday). What we did have was read-only access to our Argo Application, and Argo remembers:

```console
$ argocd app history payments-prod | tail -3
ID   DATE                          REVISION
81   2026-04-29 16:03:41 +0000     a41c9e2
82   2026-05-01 16:04:12 +0000     a41c9e2   # same revision — policy change, not a commit
```

A sync on Friday at 16:04 with *no new git revision* — the fingerprint of a sync-policy change rather than a deploy. The sync's resource details listed `configmap/payment-routing` with the result **pruned**. There was our deletion: timestamped, attributed, and entirely legitimate. The postmortem timeline wrote itself; the uncomfortable part was the column that said "acting as designed" next to every actor except us.

The fix was deliberately *not* `kubectl create configmap` — we'd been burned once by exactly that reflex. The ConfigMap went into the repo, PR'd with an emergency review at 03:30, and Argo synced it back into existence. Pods went `Running` within a minute. Total time from page to resolution: about an hour. Total time the failure had been armed and waiting: six weeks.

:::caution
In a pruning GitOps namespace, `kubectl create` isn't a shortcut — it's a countdown. Anything the controller tracks that git doesn't contain will be deleted at a time chosen by someone else's config change. And if you create it by copying a managed resource's YAML, the inherited tracking label is what signs the death warrant.
:::

## What the hotfix should have looked like

For the record, because "everything through the repo" sounds like "wait 40 minutes for CI during an incident," and it doesn't have to mean that. The live fix was fine; it was the *landing* that was missed:

```console
# 1. Create the object live — from a clean manifest, not from copied live YAML
$ cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: payment-routing        # note: no labels we didn't choose
data:
  routing.json: |
    {"primary": "provider-b", "fallback": "provider-c"}
EOF

# 2. Before the incident is closed: same manifest into git, PR opened
$ cp routing.yaml deploy/payments/configmap-payment-routing.yaml
$ git commit -am "payments: add payment-routing override (INC-2291)" && gh pr create --fill --label emergency
```

Step 1 keeps the fast path fast — and starting from a clean manifest means no inherited tracking label, so even an untracked interim object is invisible to prune rather than doomed by it. Step 2 is what makes the fix *permanent*: once merged, Argo adopts the resource as tracked-and-in-git, and pruning becomes its bodyguard instead of its executioner. The gap between those two steps is the vulnerable window; ours lasted six weeks.

## What we changed

- **Rule zero got an extension: a live fix isn't done until *every object it created or modified* is in git.** Our hotfix checklist previously said "PR your changes"; the Deployment made it, the ConfigMap didn't, and the checklist now demands an explicit inventory — `kubectl get all,cm,secret` diffed against the repo — before an incident is closed. The workflow is written up against [GitOps for tenants](/operations/gitops-for-tenants/).
- **We stopped copying live YAML as a template.** `kubectl get -o yaml` output carries tracking labels, instance labels, and server-side fields that mean things to controllers. Templates come from the repo, where those fields don't exist. One inherited label was the difference between "untracked clutter Argo ignores" and "tracked drift Argo deletes."
- **We fixed our always-orange dashboard.** The perpetual `OutOfSync` from HPA-managed replicas is now handled with `ignoreDifferences` (a platform ticket — it's their Application object), so sync status is quiet by default. The six-week-long warning about `payment-routing` was on screen the entire time; we'd just trained ourselves not to see it. A weekly drift review now walks whatever [drift detection](/operations/drift-and-cicd/) reports, and the report being empty is the goal, not the assumption.
- **Platform-side policy changes now land in our on-call context.** We asked the platform team to include tenant-visible behavior changes (like enabling prune) in a machine-readable changelog our on-call tooling surfaces next to "recent deploys." Sunday's responder asked "what changed?" and got "nothing" because *our* changes were the only ones in view. The prune rollout was a production change to our namespace that appeared in none of our timelines.
- **Config lifecycle went into the repo docs:** every ConfigMap the app references must exist in git, and references use `optional: false` deliberately — we *want* pods to fail loudly at churn time rather than silently run without routing rules. The failure mode was survivable precisely because it was loud; the changes above are about making it early instead of late.

The lesson, as we wrote it for the next team: in a GitOps namespace, git isn't a deployment mechanism — it's a *survival whitelist*. The controller's job is to make the cluster look exactly like the repo, and it will eventually get around to every discrepancy, including the ones keeping you alive. Our ConfigMap didn't die because something went wrong. It died because everything finally went right, six weeks after we told the system, with one copied label, that it shouldn't exist.
