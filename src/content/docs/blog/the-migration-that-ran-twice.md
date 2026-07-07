---
title: "Field Notes: The Migration That Ran Twice"
description: A schema-migration Job died on a lock timeout, and Kubernetes helpfully retried it. The second run re-executed a rename against a half-migrated table, and at 11pm we were debating a database restore.
keywords:
  - lock wait timeout exceeded 1205
  - MariaDB non-transactional DDL
  - RENAME COLUMN non-idempotent
  - DROP COLUMN IF EXISTS data loss
  - backoffLimit 0 for migrations
  - expand/contract pattern
  - audit table roll-forward recovery
  - half-applied migration unrecorded
date: 2026-06-02
authors: editor
tags:
  - jobs
  - migrations
  - databases
  - ci-cd
excerpt: >-
  Our migration Job had backoffLimit 3, because retries are good, right? Then a lock timeout killed the first run halfway through a column rename, the retry ran the same non-idempotent SQL against a half-migrated table, and a "defensive" IF EXISTS guard quietly destroyed the only copy of the data. At 11pm we were choosing between a backup restore and a hand-written repair.
---

The most dangerous line in this incident was written months before it, by someone being careful:

```yaml
spec:
  backoffLimit: 3
```

Three retries on our schema-migration Job. It felt like diligence — pods get evicted, networks blip, why let a flake fail a deploy? Nobody asked the question that question begs: *retries of what, exactly?* Kubernetes will happily re-run whatever you give it. It does not know, and cannot know, whether running your program 1.5 times is the same as running it once.

## 21:40: a routine evening deploy

The deploy shipped `orders-api v3.14.0` plus migration `0087`, which renamed a column as part of a long-planned cleanup. The pipeline applied the migration Job and waited on it before rolling the Deployment — at least we'd gotten *that* much right. The Job, in full, because every field in it is about to matter:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate-0087
spec:
  backoffLimit: 3                  # <- the detonator
  activeDeadlineSeconds: 1200
  template:
    spec:
      restartPolicy: Never         # each retry = a brand-new pod, from the top
      containers:
        - name: migrate
          image: registry.corp/orders-api:v3.14.0
          command: ["/app/bin/migrate", "up"]
```

`restartPolicy: Never` plus `backoffLimit: 3` means: on failure, don't restart the container — create a *fresh pod* and run the whole command again, up to four executions total. For a stateless retry-safe task, lovely. For what `/app/bin/migrate up` was about to do, catastrophic. The migration, on MariaDB (where DDL is non-transactional — every ALTER commits immediately, no rollback):

```sql
-- 0087_normalize_order_status.sql
-- "defensive" guard so a re-run doesn't trip on leftovers:
ALTER TABLE orders DROP COLUMN IF EXISTS status_legacy;          -- (1)
ALTER TABLE orders RENAME COLUMN status TO status_legacy;        -- (2)
ALTER TABLE orders ADD COLUMN status VARCHAR(32) NOT NULL
  DEFAULT 'unknown';                                             -- (3)
UPDATE orders SET status = CASE status_legacy WHEN 'P' THEN 'paid'
  WHEN 'S' THEN 'shipped' /* ... */ END;                         -- (4)
```

Note statement (1). The author had once seen a migration fail on a leftover column from an aborted run, so this one was made "rerunnable." Hold that thought.

At 21:41 the Job's first pod ran: (1) no-op, (2) committed, (3) committed — and (4) slammed into a nightly analytics job holding row locks on `orders`:

```text
ERROR 1205 (HY000): Lock wait timeout exceeded; try restarting transaction
```

The runner exited 1. Our runner records the migration as applied only after the *last* statement succeeds, so `0087` was now half-applied and unrecorded: the real data lived in `status_legacy`, and `status` was a brand-new column full of `'unknown'`.

At 21:44, support started seeing tickets — the *old* code was still serving traffic, reading a `status` column that had been yanked out from under it and replaced with defaults. Every order in the UI: status unknown. The fulfillment queue (`WHERE status = 'shipped'` and friends): empty. A half-applied rename breaks the *currently running* version instantly; you don't need to deploy anything to have an incident.

## 22:06: Kubernetes helps

Then the line from the top of this post did its work. `backoffLimit: 3`, `restartPolicy: Never`: the Job controller saw a failed pod and created a fresh one, which ran `0087` again, from the top, against a table that was no longer the table the script was written for:

- **(1) `DROP COLUMN IF EXISTS status_legacy`** — the guard found a leftover, exactly as designed, and dropped it. That "leftover" was the original `status` data for every order in the system. Committed. Gone.
- **(2) `RENAME COLUMN status TO status_legacy`** — the rename ran for the second time, and succeeded, because its source column existed again: the *empty* `status` created by attempt one. The non-idempotent step applied twice, each time grabbing whatever wore the right name.
- **(3)** added another fresh `status`. **(4)** hit the same analytics locks and died with the same 1205.

Attempts three and four repeated the ritual at 22:19 and 22:31 — each one dropping the previous attempt's debris, renaming an empty column, failing on the lock. Then the Job hit its backoff limit and went `Failed`, and the pipeline wedged with the Deployment un-rolled:

```console
$ kubectl get pods -l job-name=db-migrate-0087
NAME                     READY   STATUS   RESTARTS   AGE
db-migrate-0087-4nk8w    0/1     Error    0          63m
db-migrate-0087-8pzql    0/1     Error    0          38m
db-migrate-0087-hj2mr    0/1     Error    0          25m
db-migrate-0087-vw6ts    0/1     Error    0          13m
```

Four pods, four executions, one script that was only ever safe to run once. The bitter detail found in the postmortem: **without the guard, attempt two would have failed instantly** — `RENAME` to an existing name is a hard error — leaving the data intact in `status_legacy` and the fix a five-minute manual `UPDATE`. Statement (1) wasn't idempotence. It was *half* of idempotence: it made re-runs *proceed* without making them *safe*, which converted an automatic retry into an automatic destroyer. A migration that fails loudly when the world isn't as expected is worth infinitely more than one that shrugs and continues.

## 23:00: the decision

By 23:00 we knew the shape of it: original `status` values destroyed at 22:06, deploy wedged, old code limping on defaults. Two doors:

**Restore from backup.** Last snapshot 03:00, plus binlog replay to ~21:41. Hours of work, write-downtime for the whole restore, and every order placed since the snapshot at risk of subtle reconciliation pain. The kind of option that's technically sound and operationally radioactive at 11pm with a tired team.

**Roll forward.** We had one enormous piece of luck that we've since decided to stop calling luck: `order_events`, an append-only audit table, recorded every status transition. The current status of any order was derivable. So we wrote migration `0088` by hand, at 23:20, with four people reviewing every line: kill the analytics session (a favor from the DBA on-call), rebuild `status_legacy` from the latest event per order, re-run the mapping into `status`, verify the status distribution against yesterday's numbers, and mark `0087` as applied. It ran — once, watched, with the Job's `backoffLimit` set to `0` and hands hovering — at 00:12, clean. Fulfillment queues refilled. The deploy finished at 00:40.

We chose roll-forward because we could *prove* the repair correct row-by-row against the audit table. Without `order_events`, we'd have been restoring a production database over the phone at midnight.

## How 0087 should have shipped

The postmortem rewrote the migration the way it ships today, as three releases instead of one statement barrage — the expand/contract pattern:

```text
Release N   (expand):   ADD COLUMN status_v2; app dual-writes both columns.
Backfill    (its own job): batched, resumable, idempotent by construction —
                           each batch: "set status_v2 where status_v2 IS NULL".
                           Killed halfway? Run it again. Nothing to destroy.
Release N+1 (migrate):  app reads status_v2, still writes both.
Release N+2 (contract): stop writing old column; a later 008x drops it.
```

Notice what's gone: there is no moment where the running code's column disappears, no statement whose second execution differs from its first, and no step where a retry needs to be forbidden — because every step is either a pure addition or an idempotent fill. The lock-timeout that started this whole incident? Under expand/contract it kills a backfill batch, which resumes five minutes later, and nobody's evening is interesting.

## What we changed

- **Migration Jobs get `backoffLimit: 0`, permanently.** A failed migration is a stop-the-line event for a human, never a retry. If a step is genuinely flake-prone, the *step* gets made safe to re-run and proves it; the platform's retry loop is not where that guarantee lives. Our Job template in [Jobs and CronJobs](/workloads/jobs-and-cronjobs/) terms: `restartPolicy: Never`, `backoffLimit: 0`, and alerting on `Failed` — the Job is a detonator, so it clicks exactly once.
- **Idempotence is now a tested property, not a vibe.** Every migration runs twice in CI against a copy of the schema — once clean, once against its own half-applied wreckage (we kill it mid-run at each statement boundary). `IF EXISTS` guards that make a re-run *proceed* without making it *correct* are rejected in review by name, with this incident as the citation.
- **Migrations became a separately gated pipeline step**, not a passenger on the deploy. The migration runs first, alone, in a window checked against long-running DB sessions (`lock_wait_timeout` set low so *we* fail fast instead of holding locks), a human or automated check verifies the outcome, and only then does the rollout start. The design is in [CI/CD pipeline design](/operations/cicd-pipeline-design/); "deploy" and "migrate" sharing a trigger was the coupling that put a schema change and peak analytics in the same minute.
- **Expand/contract replaced big-bang renames.** The rename broke the *running* version at 21:42, before any retry did anything. The pattern now: release N adds the new column and dual-writes; a backfill runs as its own boring, resumable, idempotent job; release N+1 reads the new column; release N+2 drops the old one. Every step is compatible with the code running on both sides of it, which also makes [rollbacks](/workloads/rollouts-and-rollbacks/) an option again — you can't roll back an app whose database has moved on without it.
- **The audit table got promoted from "nice to have" to "recovery infrastructure."** Roll-forward was only possible because order state was reconstructible. That property is now a requirement for any table a migration touches destructively — if we can't rebuild it, the migration plan has to say "backup restore is the rollback" out loud, in review, where it sounds as bad as it is.

The summary we put at the top of the postmortem: Kubernetes did nothing wrong. A Job retried, exactly as configured; a script ran, exactly as written. The failure was that we handed an at-least-once execution system a task that was only correct exactly-once, and then "hardened" the task just enough that running it twice destroyed data *quietly* instead of failing loudly. Retries aren't a safety feature. They're an amplifier for whatever your job already is.
