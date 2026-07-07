---
title: "Field Notes: The CronJob That Fired 137 Times"
description: We suspended a CronJob during an incident and unsuspended it three days later. The controller remembered every run we missed, and so did our partner's rate limiter.
keywords:
  - suspend true unsuspend catch-up
  - startingDeadlineSeconds
  - concurrencyPolicy Allow Forbid
  - missed runs backfill herd
  - too many missed start times
  - 100 missed runs cliff
  - backoffLimit retry multiplier
  - partner API rate limiter 429
date: 2026-01-20
authors: editor
tags:
  - cronjobs
  - jobs
  - scheduling
  - incident-response
excerpt: >-
  Suspending a CronJob during an incident felt like pressing pause. It was actually pressing "hold my calls" — and when we unsuspended it three days later, the controller tried to return every single one of them at once. 137 pods hammered a partner API before we understood what we'd asked for.
---

The command that started this incident was the most reasonable command anyone ran all week. During a Tuesday-morning data-quality incident — our partner's inventory API was returning stale payloads and we didn't want to sync garbage into our catalog — the on-call engineer paused the sync:

```console
$ kubectl patch cronjob partner-inventory-sync -p '{"spec":{"suspend":true}}'
cronjob.batch/partner-inventory-sync patched
```

Textbook. The incident doc even says "suspended the sync to stop ingesting bad data." What nobody wrote down was a mental model of what `suspend: true` actually means. We all assumed it meant *pause*: stop the clock, resume later, carry on. It does not mean pause. It means *stop starting jobs, but keep counting the ones you're missing*.

## Friday, 09:12: the unpause

The partner fixed their feed Wednesday. Nobody remembered the suspended CronJob until Friday morning, when a product manager asked why inventory was three days stale. An engineer found the suspend flag and flipped it back:

```console
$ kubectl patch cronjob partner-inventory-sync -p '{"spec":{"suspend":false}}'
cronjob.batch/partner-inventory-sync patched
```

The CronJob runs hourly (`0 * * * *`). Between Tuesday 09:00 and Friday 09:12, roughly 72 scheduled runs had come and gone. Our spec had two other properties that mattered enormously and that we had never consciously chosen:

```yaml
spec:
  schedule: "0 * * * *"
  concurrencyPolicy: Allow      # the default
  # startingDeadlineSeconds:    # unset — also the default
```

With `startingDeadlineSeconds` unset, there is no expiry on a missed run — the controller still considers it owed. The Kubernetes docs carry an explicit caution about exactly this: executions missed while suspended count as missed jobs, and when suspend flips back to false without a starting deadline, the missed jobs get scheduled. And with `concurrencyPolicy: Allow` — the default — nothing stops those jobs from running on top of each other.

At 09:12 the controller started paying down its debt.

## 09:12–09:55: the herd

Backfill jobs began stacking up. Each one did what the sync always does: pull the full inventory window from the partner API, page by page. One job doing that is fine. A dozen doing it concurrently tripped the partner's rate limiter, which started returning 429s. And here's where the second default kicked in: our Job template had the default `backoffLimit: 6`, so every job that failed on 429s spawned retry pods. Which generated more 429s. Which failed more jobs. Which spawned more retries.

By 09:50 the namespace looked like this:

```console
$ kubectl get jobs -l app.kubernetes.io/name=partner-inventory-sync | head
NAME                                COMPLETIONS   DURATION   AGE
partner-inventory-sync-29483712    0/1           38m        38m
partner-inventory-sync-29483713    0/1           37m        37m
partner-inventory-sync-29483714    1/1           4m         36m
partner-inventory-sync-29483715    0/1           35m        35m
...

$ kubectl get pods -l app.kubernetes.io/name=partner-inventory-sync --no-headers | wc -l
     137
```

One hundred and thirty-seven pods, between backfill jobs and their retry pods, all pointed at one partner endpoint. At 09:55 the partner's abuse protection did what abuse protection does: it banned our API key. Automated, 24-hour ban, appeal via support ticket. Our *live* hourly sync was now dead too — not because of anything in our cluster, but because our catch-up storm looked like an attack.

## 10:05: cleanup

Stopping the bleeding was two commands. First re-suspend the CronJob so the controller stops creating jobs, *then* delete the storm — order matters, or the controller backfills right behind your delete:

```console
$ kubectl patch cronjob partner-inventory-sync -p '{"spec":{"suspend":true}}'
$ kubectl delete jobs -l app.kubernetes.io/name=partner-inventory-sync
job.batch "partner-inventory-sync-29483712" deleted
job.batch "partner-inventory-sync-29483713" deleted
...
```

Deleting the Jobs cascades to their pods, so one labeled delete cleans the whole mess — this is the payoff for putting real labels on your `jobTemplate`, which we cover in [Jobs and CronJobs](/workloads/jobs-and-cronjobs/). The partner un-banned us Saturday after a very humble support ticket.

## The semantics nobody reads until they have to

The postmortem was mostly a group reading of the CronJob docs, out loud, with increasing dismay. The sharp edges, in order:

**1. A missed run is a debt, and `startingDeadlineSeconds` is the statute of limitations.** The controller tracks `lastScheduleTime` and knows which scheduled runs never happened — because the controller was down, because the job couldn't be created, or because *you suspended it*. If `startingDeadlineSeconds` is unset, a missed run never expires. Set it to, say, `300`, and a run that couldn't start within 5 minutes of its scheduled time is simply skipped, forever. For a sync that runs hourly and only cares about *current* state, skipping stale runs is exactly right — run 72 didn't need runs 1 through 71 to happen first.

**2. The 100-missed-runs cliff.** There's a guardrail here, but it's a strange one: if the controller counts more than 100 missed runs (with no deadline to trim the list), it gives up and refuses to schedule *anything*, emitting a warning like:

```text
Cannot determine if job needs to be started. Too many missed start times (> 100).
Set or decrease .spec.startingDeadlineSeconds or check clock skew.
```

We missed roughly 72 runs — under the cliff, so the backfill fired. Here's the unsettling arithmetic we did on the whiteboard: had the CronJob run every 30 minutes instead of hourly, or had we stayed suspended through the weekend, we'd have crossed 100 and gotten the *opposite* failure — a CronJob that silently never runs again until a human intervenes. Both sides of that cliff are incidents. One floods a partner; the other quietly stops syncing inventory and waits for someone to notice the staleness. There is no setting of "just resume normally" unless you configure one.

**3. `concurrencyPolicy: Allow` is the default, and it's almost never what a sync job wants.** Our sync is a full-state reconciliation — running two copies concurrently is at best wasteful and at worst a write-conflict generator. `Forbid` (skip a run if the previous one is still going) was the correct choice for us on day one; we just never made a choice at all. `Replace` (kill the old run, start the new) suits "only the latest matters" jobs. `Allow` suits genuinely independent workloads — which a catch-up herd aimed at one API key is not.

**4. The suspend itself was drift.** The `kubectl patch` lived only in the cluster; git still said `suspend: false`. We got lucky in one narrow sense — our pipeline didn't deploy that repo during the three-day window, or it would have "helpfully" unsuspended the job mid-incident and started the herd early, with the bad partner data still flowing. A live suspend needs to land in git like any other live fix; the [drift and CI/CD](/operations/drift-and-cicd/) guide is the longer version of that sermon.

:::note
The exact catch-up behavior on unsuspend has shifted across controller versions, but the contract you should design for hasn't: **the controller owes you nothing gentler than "missed runs may fire, possibly all at once, or past 100, not at all."** Set `startingDeadlineSeconds` and pick a `concurrencyPolicy` so the answer doesn't depend on which version of the controller your platform team is running this quarter.
:::

## The spec we run now

For the record, here's what `partner-inventory-sync` looks like after the postmortem — every line that was previously a default is now a decision:

```yaml
spec:
  schedule: "0 * * * *"
  concurrencyPolicy: Forbid        # a sync never runs on top of itself
  startingDeadlineSeconds: 300     # a run that can't start within 5m is skipped, not owed
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5        # keep enough failures to actually debug
  jobTemplate:
    metadata:
      labels:
        app.kubernetes.io/name: partner-inventory-sync   # one-command cleanup
    spec:
      backoffLimit: 2              # 429s must not multiply
      activeDeadlineSeconds: 1800  # a wedged sync dies before the next slot
```

None of these values are universal — they encode *our* answer to "what should happen to a missed run?" for *this* job. The point is that there now is an answer, in the spec, instead of in the controller's defaults.

## What we changed

- **Every CronJob in the org now sets `startingDeadlineSeconds` and an explicit `concurrencyPolicy`.** For syncs: `startingDeadlineSeconds: 300` and `concurrencyPolicy: Forbid` — a missed run is skipped, not owed, and runs never stack. The only CronJobs allowed to keep catch-up semantics are ones whose runs are genuinely independent *and* idempotent, and there's a comment in the manifest saying why.
- **Suspending a CronJob is now a runbook action with a paired resume step,** including "check how many runs will have been missed and decide whether you want them." The runbook's resume path for syncs is: keep it suspended, run one manual `kubectl create job --from=cronjob/partner-inventory-sync catch-up-$(date +%s)`, verify, then unsuspend. One controlled run beats seventy-two automatic ones.
- **We alert on long-suspended CronJobs.** `kube_cronjob_spec_suspend == 1` for more than 24 hours posts to the team channel — see [alerting](/observability/alerting/) for how we keep that a nudge rather than a page. The three-day forgotten suspend is exactly the failure this catches.
- **Job templates got sane retry budgets.** A job that talks to a rate-limited partner now has `backoffLimit: 2` and honors `Retry-After` in the client, so a 429 storm can't multiply itself. The default `backoffLimit: 6` turned 72 missed runs into 137 pods; retries are a multiplier, and you should know what you're multiplying.
- **Live suspends go to git.** Same rule as any 2am fix: the patch stabilizes the system, the PR makes it true. `suspend: true` sitting in the cluster while git says `false` is a time bomb with two fuses — the next deploy *and* the eventual unsuspend.

The lesson that stuck: a CronJob's schedule is not a clock, it's a ledger. Suspend doesn't stop the ledger — it stops the payments. Decide *in the spec*, on the calm day you write it, what should happen to the debt.
