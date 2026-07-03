---
title: "Field Notes: The Deployment That Unfixed Itself"
description: A 2am kubectl edit saved the night. A 9am pipeline run silently reverted it, and nobody connected the dots until peak traffic.
date: 2026-03-05
authors: editor
tags:
  - drift
  - ci-cd
  - memory
  - availability
excerpt: An engineer bumped a memory limit at 2am and went back to bed a hero. Seven hours later, a routine deploy of an unrelated change quietly reverted the fix, and we spent an hour of an OOM storm not connecting the dots — because who reads resource limits in a diff of image tags?
---

There are two incidents in this story. The first one was handled well. The second one was caused by how well we handled the first one.

## Incident one: 2:07am, handled in nine minutes

`checkout-svc` started OOMKilling at 2:07 on a Thursday morning. A marketing email had gone out to a much bigger list than anyone told us about, cache entries per session grew, and pods were hitting their 1Gi memory limit and dying in rotation. The on-call engineer — sharp, experienced, doing exactly what the runbook implied — made the obvious move:

```console
$ kubectl edit deployment checkout-svc
# resources.limits.memory: 1Gi -> 2Gi
deployment.apps/checkout-svc edited
```

Rollout completed at 2:16. OOMKills stopped. Latency recovered. She watched it for twenty minutes, posted a summary in the incident channel — *"bumped memory limit to 2Gi, stable, will make a ticket tomorrow"* — and went back to bed. Nine minutes of live surgery. Genuinely good incident response, minus one detail we'll get to.

## Incident two: 9:14am, not handled in nine minutes

At 9:03, a teammate merged a one-line PR to `checkout-svc`: a log message tweak. The pipeline did what it does every day — rendered the manifests from git and applied them. The manifest in git still said `memory: 1Gi`, because the 2am fix lived only in the cluster. `kubectl apply` saw a field it manages differing from the desired state and dutifully corrected it.

At 9:14 the rollout finished. New pods, new image tag, old limit. Nothing alarmed. Morning traffic was still light; the pods fit in 1Gi with room to spare.

At 11:40, peak traffic arrived, and the OOM storm came back — except now it looked like a *new* incident. Different on-call, no context that the limit had ever been raised, and one massively misleading clue: **the last change to the service was a log-line PR at 9am**. So that's where everyone dug. We reverted the log change (no effect). We stared at the diff (one string literal). We theorized about the logging library allocating differently. Forty minutes in, someone said the sentence that should be framed on a wall:

> "The deploy diff was just an image tag. Nobody looks at resource limits in a diff of image tags — the pipeline doesn't even print them."

It took until 12:35 for someone to read the 2am incident channel scrollback, compare it against `kubectl get deploy checkout-svc -o yaml`, and find `memory: 1Gi` sitting there like nothing had happened. Re-applied 2Gi (this time via an emergency PR *and* a live patch, in that order), stable by 12:50. Total customer-facing damage: about 70 minutes of elevated 5xx at the highest-traffic point of the day, versus zero at 2am.

## The forensics: managedFields remembers

In the postmortem, we wanted the timeline to be airtight — who changed the limit, when, and what erased it. The cluster had already told us, in a place almost nobody reads:

```console
$ kubectl get deployment checkout-svc --show-managed-fields -o yaml
```

```yaml
managedFields:
  - manager: kubectl-edit
    operation: Update
    time: "2026-02-26T02:14:51Z"
    fieldsV1:
      f:spec:
        f:template:
          f:spec:
            f:containers:
              k:{"name":"checkout-svc"}:
                f:resources:
                  f:limits:
                    f:memory: {}
  - manager: argocd-controller
    operation: Apply
    time: "2026-02-26T09:14:02Z"
    ...
```

Every apply and edit stamps the fields it touched with a manager name and a timestamp. There was the 2:14 `kubectl-edit` claiming ownership of `f:memory`, and there was the 9:14 pipeline apply taking it back. This is the single most useful drift-forensics tool that nobody knows exists; we've since written it into the [drift and CI/CD](/operations/drift-and-cicd/) guide. (One caveat: managedFields shows *current* ownership, not full history — we could reconstruct this one because the pipeline's server-side apply left both entries visible. For real history you want an audit log.)

## Why this failure mode is so nasty

The revert is invisible at every point where a human might catch it:

1. **The 2am engineer** did communicate — but a Slack message is not a reconciliation source. The system of record disagreed with her, and the system of record wins every deploy.
2. **The 9am PR author** changed one log line. Their diff was honest. The *effective* diff — what actually changed in the cluster — included a resource limit they never touched.
3. **The pipeline** was working exactly as designed. GitOps reverting drift is the feature. The bug was that a fix was classified as drift.
4. **The 11:40 responder** followed the strongest heuristic in incident response — "what changed last?" — and it pointed at the wrong change, because the *real* change (the revert) appears in no PR, no changelog, and no deploy notification.

That last one deserves emphasis. The runbook step "check recent deploys" actively misled us for 40 minutes. When the cluster can differ from git, "recent deploys" is not the list of recent changes; it's the list of recent changes *someone admitted to*.

## What the 2am fix should have looked like

To be concrete, because "put it in git first" sounds like it means "wait for CI at 2am," and it doesn't. The live patch was correct — apply it, stabilize the system. The missing part was fifteen additional minutes before sign-off:

```console
# 1. The live fix (exactly what she did — this part was right)
$ kubectl patch deployment checkout-svc --type=json -p='[
    {"op":"replace",
     "path":"/spec/template/spec/containers/0/resources/limits/memory",
     "value":"2Gi"}]'

# 2. Leave a marker on the object itself, where the next responder will look
$ kubectl annotate deployment checkout-svc \
    incident.corp/live-patch="2026-02-26 memory 1Gi->2Gi INC-4412, PR pending"

# 3. Make the same change in git and open the PR before logging off
$ git checkout -b hotfix/checkout-svc-memory
$ sed -i '' 's/memory: 1Gi/memory: 2Gi/' k8s/checkout-svc/deployment.yaml
$ git commit -am "checkout-svc: raise memory limit to 2Gi (INC-4412)"
$ gh pr create --fill --label emergency
```

Step 2 is the underrated one. Annotations survive on the live object; the 11:40 responder ran `kubectl describe deployment checkout-svc` in the first five minutes and would have read the marker immediately — except the marker would have been *gone*, reverted by the same apply that reverted the limit. Which is exactly why step 3 is not optional: git is the only shelf the pipeline can't sweep clean. The annotation buys you discoverability *until* the next deploy; the PR buys you survival *through* it.

And here's what the pipeline's pre-apply diff would have shown on the log-line PR, had we had it then:

```diff
$ kubectl diff -f rendered/checkout-svc/deployment.yaml
-        image: registry.corp/checkout-svc:v2.41.0
+        image: registry.corp/checkout-svc:v2.41.1
         resources:
           limits:
-            memory: "2Gi"
+            memory: "1Gi"
```

Two lines nobody wrote, in a PR about a log message. That diff is the entire incident, visible seven hours early, at 9am instead of 11:40, in review instead of in production.

## What we changed

- **Rule zero, now in the on-call charter: a live fix isn't done until it's in git.** You don't have to wake up a reviewer at 2am — we allow self-merged emergency PRs with a mandatory next-day review — but the PR gets opened *before you go back to bed*. The [live patching playbook](/operations/live-patching/) now ends with a literal checkbox: "change is merged, or a revert is acceptable."
- **The pipeline runs `kubectl diff` before `apply` and posts the full server-side diff on the PR.** The log-line PR would have shown `-memory: 2Gi / +memory: 1Gi` in review. Nobody has to remember to look at limits; the diff makes the invisible change visible.
- **Reverting drift now requires acknowledgment on high-blast-radius fields.** If the pre-apply diff touches `resources`, `replicas`, or probe config and the PR doesn't, the pipeline pauses for a human click. Drift correction is still the default — we just stopped letting it be *silent*.
- **A drift detector compares live state to git every 15 minutes** and pages nobody — it posts to the team channel. The 2am edit would have shown up as a friendly "cluster differs from git in checkout-svc: resources.limits.memory" message by 2:30, turning tomorrow's ticket into an artifact nobody could forget.
- **The OOM runbook gained a first-five-minutes step:** compare the live spec against git (`kubectl diff -f rendered/`) before theorizing about the workload. See [OOMKilled troubleshooting](/troubleshooting/oomkilled/) — "was the limit what you think it was?" is now question one.

The uncomfortable summary: our GitOps pipeline didn't fail. It executed a rollback we didn't know we'd scheduled. Every `kubectl edit` in a GitOps shop is a time bomb with the fuse set to your next unrelated deploy — and the next deploy is always sooner than the ticket you promised to file tomorrow.
