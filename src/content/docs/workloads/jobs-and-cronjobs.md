---
title: Jobs and CronJobs
description: Run-to-completion workloads — Job retry and parallelism semantics, CronJob scheduling and missed-run behavior, and debugging jobs that failed at 3 a.m.
sidebar:
  order: 13
---

Deployments answer "keep this running forever." Jobs answer the other question: "run this until it succeeds, then stop." Migrations, batch imports, report generation, cleanup tasks. The semantics look simple and hide a surprising number of sharp edges — mostly around retries and schedules.

:::tip[War stories]
Two Field Notes live in this territory: [The CronJob That Fired 137 Times](/blog/the-cronjob-that-fired-137-times/) (missed-run backfill) and [The Migration That Ran Twice](/blog/the-migration-that-ran-twice/) (non-idempotent Job retries).
:::

## Job anatomy

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate-1042
spec:
  completions: 1
  parallelism: 1
  backoffLimit: 3
  activeDeadlineSeconds: 900
  ttlSecondsAfterFinished: 86400
  template:
    spec:
      restartPolicy: Never          # required: Never or OnFailure, not Always
      containers:
        - name: migrate
          image: registry.example.com/checkout/payments:1.42.0
          command: ["./migrate", "--target", "latest"]
          resources:
            requests: { cpu: 250m, memory: 256Mi }
            limits: { memory: 256Mi }
```

Field by field:

- **completions** — how many pods must exit 0 for the Job to succeed. Default 1.
- **parallelism** — how many pods may run at once. `completions: 50, parallelism: 5` is a work-crunching pool; `completions: 1` (or unset) with `parallelism: 1` is the ordinary "run this once" case. For queue-consumer patterns there's also `completionMode: Indexed`, which gives each pod a stable index for sharding.
- **backoffLimit** — retries before the Job is marked Failed. Default **6**, with exponential backoff between attempts (10s, 20s, 40s... capped at 6m). A failing migration with the default gets seven total attempts over ~10+ minutes. Set it consciously: `0` for anything non-idempotent-ish, higher for flaky-network batch work.
- **activeDeadlineSeconds** — wall-clock kill switch for the whole Job, retries included. Without it, a hung pod (deadlocked process, unreachable dependency) runs *forever*. Every production Job should have one. Note it trumps `backoffLimit` — deadline exceeded means Failed, immediately, and running pods are killed.
- **ttlSecondsAfterFinished** — auto-delete the Job (and its pods, and their logs!) N seconds after it finishes. Without a TTL, finished Jobs accumulate until someone cleans up or an object-count [ResourceQuota](/workloads/resources-and-qos/) starts rejecting new pods. A day or two is a good balance: long enough to debug last night's failure, short enough not to hoard.

:::caution[Retries mean your job WILL run more than once]
Between `backoffLimit`, node failures, and evictions, exactly-once execution does not exist here. Any Job that isn't idempotent — that can't tolerate running twice, or dying halfway and starting over — is a data-corruption ticket in waiting. Migrations need transactional/versioned runners (Flyway, Liquibase, migrate); batch writers need upserts or dedup keys. Design for at-least-once, always.
:::

:::note[Migrations: Job or pipeline step?]
Whether a DB migration should run as a Job at all — versus a gated pipeline step, with expand/contract schema changes so old and new code coexist — is a release-design decision. [CI/CD pipeline design](/operations/cicd-pipeline-design/) weighs the two shapes.
:::

## restartPolicy interplay

The pod's `restartPolicy` and the Job's `backoffLimit` are two retry loops layered on each other:

- **`restartPolicy: Never`** — a failed container fails its pod; the Job controller creates a **new pod** for the retry. You accumulate failed pods, one per attempt — which is exactly what you want for debugging, because **each attempt's logs survive** in its own dead pod.
- **`restartPolicy: OnFailure`** — the kubelet restarts the container **in place**, same pod. Tidier (one pod), but each restart wipes the previous container's logs (only `kubectl logs --previous` for the immediately-prior attempt survives), and a pod stuck restarting can look alive while going nowhere.

My default is `Never` for anything you'll debug at 3 a.m. Disk-cheap failed pods with intact logs beat tidiness. (`Always` is rejected outright for Jobs — a Job whose pod restarts forever could never complete.)

## CronJob anatomy

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-reconciliation
spec:
  schedule: "30 2 * * *"
  timeZone: "Europe/London"
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 600
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      activeDeadlineSeconds: 3600
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: reconcile
              image: registry.example.com/checkout/reconciler:2.7.1
```

A CronJob is a Job factory on a cron schedule — everything from the previous sections applies to the Jobs it stamps out.

**schedule** — standard five-field cron. **timeZone** takes an IANA name; without it, the schedule runs in the *controller manager's* timezone, which is almost always UTC but is technically the platform team's business. Set `timeZone` explicitly and stop guessing — DST transitions have eaten more "why did the 2:30 job run at 3:30" tickets than I can count.

**concurrencyPolicy** — what happens if the previous run is still going when the next tick fires:

- `Allow` (default) — start another Job anyway. Overlapping runs. Rarely what you want.
- `Forbid` — skip this tick entirely. Right for anything non-reentrant (reconciliation, imports).
- `Replace` — kill the running Job, start fresh. Right for "only the latest matters" work.

The default being `Allow` is a trap: a job that normally takes 5 minutes hits a slow night, takes 90, and suddenly you have three copies hammering the same database. If you haven't thought about overlap, set `Forbid`.

**startingDeadlineSeconds and missed-run semantics** — when the controller can't start a run on time (controller restart, `Forbid` skips, suspended CronJob), it later checks how stale the missed tick is. With `startingDeadlineSeconds: 600`, a run up to 10 minutes late still starts; older is skipped and counted as missed. Unset means "since the last scheduled time" is used. And the famous hard edge: **if more than 100 runs are missed** (with no deadline set, or within the deadline window), the controller gives up, stops scheduling entirely, and emits a `TooManyMissedTimes` event. A `@every-minute` CronJob suspended for two hours hits this; the fix is deleting/recreating or briefly editing the object. If a CronJob has silently stopped firing, check for exactly this event.

:::note
One scheduled run may very occasionally fire twice, and runs can be skipped — the controller's own docs say so. Same conclusion as before: idempotent jobs, and alerting on *outcomes* (did tonight's data land?) rather than on "did the CronJob run."
:::

## Debugging failed Jobs

Work top-down: CronJob → Job → pods → logs.

```console
$ kubectl get cronjob nightly-reconciliation
NAME                     SCHEDULE     TIMEZONE        SUSPEND   ACTIVE   LAST SCHEDULE   AGE
nightly-reconciliation   30 2 * * *   Europe/London   False     0        7h              90d

$ kubectl get jobs --sort-by=.metadata.creationTimestamp | tail -3
NAME                              STATUS     COMPLETIONS   DURATION   AGE
nightly-reconciliation-29197850   Complete   1/1           4m12s      2d7h
nightly-reconciliation-29199290   Complete   1/1           3m58s      31h
nightly-reconciliation-29200730   Failed     0/1           15m        7h

$ kubectl describe job nightly-reconciliation-29200730 | grep -A5 Conditions
Conditions:
  Type     Status  Reason                Message
  ----     ------  ------                -------
  Failed   True    BackoffLimitExceeded  Job has reached the specified backoff limit

$ kubectl get pods -l job-name=nightly-reconciliation-29200730
NAME                                    READY   STATUS   RESTARTS   AGE
nightly-reconciliation-29200730-8xk2p   0/1     Error    0          7h
nightly-reconciliation-29200730-mq4jd   0/1     Error    0          7h
nightly-reconciliation-29200730-zt7wn   0/1     Error    0          7h

$ kubectl logs nightly-reconciliation-29200730-zt7wn
FATAL: connection to db-replica.internal:5432 timed out after 30s
```

Notes from the field:

- The `job-name` label is your friend — it's stamped on every pod a Job creates.
- `Reason: DeadlineExceeded` vs `BackoffLimitExceeded` tells you *hung* vs *crashing* before you read a single log line.
- If the pod never ran at all (`Pending`, or no pods exist), it's a scheduling/quota/admission problem, not your code — check the Job's events for `FailedCreate` (quota rejections land there; see [pod-pending](/troubleshooting/pod-pending/)).
- To re-run a failed CronJob run *right now* without waiting for the schedule:

```console
$ kubectl create job --from=cronjob/nightly-reconciliation manual-rerun-$(date +%s)
```

- Remember `ttlSecondsAfterFinished` and history limits are deleting your evidence on a timer. If overnight failures keep evaporating before you see them, lengthen the TTL or ship job logs to your [log collection](/observability/log-collection/) pipeline where they outlive the pod.

## Don't use CronJobs as a poor man's queue

The pattern shows up everywhere: work items land in a table (or bucket, or topic), and a `*/1 * * * *` CronJob polls and processes them. It works in the demo and degrades in production, because CronJobs give you none of the things a queue consumer needs:

- **Latency floor of the schedule** — p50 30s, p99 nearly a minute, and users feel it.
- **No backpressure** — the schedule fires at the same rate whether the backlog is 3 items or 300,000. Deep backlogs meet `concurrencyPolicy: Forbid` and fall further behind; with `Allow`, they meet each other.
- **Missed-run semantics** — the 100-missed-runs cliff and skip rules above now apply to your *data pipeline*.
- **Per-minute pod churn** — image pull, container start, runtime init, TLS handshakes to the DB, 60 times an hour, forever. The overhead often exceeds the work.

Better shapes: a small always-on consumer **Deployment** that polls in a loop (all the [health-check](/workloads/health-checks/) and [HA](/workloads/high-availability/) machinery applies), a real broker from the [message queues](/stateful/message-queues/) menu, or KEDA scaling consumers on queue depth ([autoscaling](/workloads/autoscaling/)) if load is bursty. Keep CronJobs for what they're for: genuinely periodic work where "roughly on schedule, at least once" is the actual requirement.
