---
title: "Field Notes: The Migration Job That Ran Twice"
description: A production outage caused by a non-idempotent database migration container, a retrying Job, and a schema that could not survive the same change being applied twice.
keywords:
  - non-idempotent database migration
  - readiness probe copied onto a Job
  - backoffLimit retry created second pod
  - column does not exist / already exists
  - ALTER TABLE ADD COLUMN IF NOT EXISTS
  - partial schema state backfill
  - gate app rollout on migration completion
  - restartPolicy Never one-shot Job
date: 2026-07-05
authors: editor
tags:
  - jobs
  - migrations
  - databases
  - debugging
sidebar:
  label: "Migration Job Ran Twice"
excerpt: We lost the deployment window because our migration container assumed the universe would be polite. A copied readiness probe killed the pod mid-run, triggering a non-idempotent retry that wedged the rollout.
---

*Not to be confused with [The Migration That Ran Twice](/blog/the-migration-that-ran-twice/) — a different incident, same shape: that one is a MariaDB lock-timeout retry where a destructive `DROP COLUMN IF EXISTS` rename ate data. This one is Postgres, a probe-killed Job, and a non-idempotent `ALTER TABLE` left mid-backfill.*

We did not lose the database because Kubernetes was flaky.

We lost the deployment window because our migration container assumed the universe would be polite: one pod, one run, one clean exit, one schema state. Kubernetes does not make that promise. [Jobs retry](/workloads/jobs-and-cronjobs/). Pods get rescheduled. Nodes drain. Containers restart after the process exits with a non-zero code. If your migration is not idempotent, the second run is not a backup plan. It is a loaded footgun with YAML indentation.

This happened during a routine `orders-api` rollout. The application Deployment was fine. The database was fine. The cluster was fine. The breakage lived in the narrow space between all three: a migration Job that ran once, partially succeeded, got retried on another node, and then tried to create schema objects that now existed but were not recorded as applied.

The pager message looked boring, which is usually how these things start.

```text
checkout error rate > 15% for 5m
orders-api p95 latency > 4s
deployment orders-api/prod rollout not progressing
```

The first bad sign was that new `orders-api` pods were starting, passing readiness for a few seconds, and then failing database-backed endpoints.

```bash
kubectl -n shop get pods -l app=orders-api -o wide
```

```console
NAME                          READY   STATUS             RESTARTS   AGE     IP            NODE
orders-api-7d9f6b5c4-x2lqp    0/1     CrashLoopBackOff   4          8m31s   10.42.18.77   worker-12
orders-api-7d9f6b5c4-kp8fm    0/1     CrashLoopBackOff   4          8m14s   10.42.22.41   worker-09
orders-api-689c8d45c9-ws6nr   1/1     Running            0          3h12m   10.42.19.12   worker-05
```

The old replica was still serving traffic. The new ones could not survive startup.

```bash
kubectl -n shop logs orders-api-7d9f6b5c4-x2lqp --previous --tail=80
```

```console
2026-07-05T03:18:42.087Z ERROR startup failed
org.postgresql.util.PSQLException: ERROR: column "tax_region" does not exist
  Position: 184
```

That was strange because the release notes said the migration added `orders.tax_region` before the app binary started using it. The app was not ahead of the database, at least not according to the plan.

The migration Job told a different story.

```bash
kubectl -n shop get jobs,pods -l app=orders-migrate -o wide
```

```console
NAME                       COMPLETIONS   DURATION   AGE
job.batch/orders-migrate   0/1           12m        12m

NAME                         READY   STATUS   RESTARTS   AGE   IP            NODE
pod/orders-migrate-t8l2w     0/1     Error    0          12m   10.42.21.8    worker-03
pod/orders-migrate-qn4pz     0/1     Error    0          10m   10.42.27.19   worker-15
```

Two pods. Same Job. Both failed. That is the shape of a retry.

:::note[What a namespace-level developer can see]
You do not need node SSH or `cluster-admin` to prove a Job retried. The Job controller records pod creation in the namespace, and `kubectl get pods -l ...` plus `kubectl describe job ...` usually gives you enough evidence to separate application failure from scheduler or node behavior.
:::

## The First Ten Minutes

When a migration-backed rollout goes bad, I want three facts before I touch anything:

1. Did the migration Job run more than once?
2. Did any run partially change schema state?
3. Are new application pods depending on schema that is not actually present?

Start with the Job, not the Deployment. The Deployment is usually just where the pain becomes visible.

```bash
kubectl -n shop describe job orders-migrate
```

```console
Name:             orders-migrate
Namespace:        shop
Selector:         batch.kubernetes.io/controller-uid=ad9ef5d8-f31b-4f7e-8b50-1d70e5e3df5a
Parallelism:      1
Completions:      1
Start Time:       Sun, 05 Jul 2026 03:06:17 +0000
Pods Statuses:    0 Active / 0 Succeeded / 2 Failed

Events:
  Type    Reason            Age   From            Message
  ----    ------            ----  ----            -------
  Normal  SuccessfulCreate  12m   job-controller  Created pod: orders-migrate-t8l2w
  Normal  SuccessfulCreate  10m   job-controller  Created pod: orders-migrate-qn4pz
```

Then pull logs from every failed pod, not just the most recent one.

```bash
kubectl -n shop logs orders-migrate-t8l2w --timestamps
kubectl -n shop logs orders-migrate-qn4pz --timestamps
```

First pod:

```console
2026-07-05T03:06:31.014Z starting migration bundle 2026.07.05.1
2026-07-05T03:06:31.538Z applying 2026070501_add_tax_region.sql
2026-07-05T03:06:32.201Z ALTER TABLE orders ADD COLUMN tax_region text
2026-07-05T03:06:32.844Z backfilling orders.tax_region from customer_address
2026-07-05T03:08:59.991Z connection reset by peer
2026-07-05T03:09:00.003Z migration process exiting with code 1
```

Second pod:

```console
2026-07-05T03:09:14.109Z starting migration bundle 2026.07.05.1
2026-07-05T03:09:14.514Z applying 2026070501_add_tax_region.sql
2026-07-05T03:09:14.902Z ERROR: column "tax_region" of relation "orders" already exists
2026-07-05T03:09:14.903Z migration process exiting with code 1
```

That is the whole incident in four lines. The first run applied at least the `ALTER TABLE`, then died during the backfill before the migration framework recorded success. The Job retried. The second run hit a non-idempotent `ALTER TABLE` and failed immediately. The schema was left between worlds: column present, data incomplete, migration history absent.

The application expected the complete world.

:::caution
A failed migration pod does not mean the database rolled back. DDL behavior depends on the database engine, the statement, and whether the migration tool wrapped the change in a transaction. PostgreSQL can run many DDL statements transactionally. MySQL and Oracle have sharper edges. Even in PostgreSQL, a migration that commits DDL and then performs a long backfill outside the same transaction can leave durable partial state.
:::

## The Hidden Trigger

The immediate question was why the first pod died. From our namespace, all we could see was a connection reset and a failed container. We could not SSH into `worker-03`, read kubelet logs, or inspect the node's container runtime.

That is normal. This guide is written from the seat you actually sit in.

We collected the facts a platform team could act on:

```bash
kubectl -n shop get pod orders-migrate-t8l2w -o yaml > orders-migrate-t8l2w.yaml
kubectl -n shop describe pod orders-migrate-t8l2w > orders-migrate-t8l2w.describe.txt
kubectl -n shop get events --sort-by=.lastTimestamp | grep -E 'orders-migrate|worker-03'
```

The pod describe output had the clue.

```console
Events:
  Type     Reason     Age   From               Message
  ----     ------     ----  ----               -------
  Normal   Scheduled  14m   default-scheduler  Successfully assigned shop/orders-migrate-t8l2w to worker-03
  Normal   Pulled     14m   kubelet            Container image "registry.example.com/orders/migrate:2026.07.05.1" already present on machine
  Normal   Started    14m   kubelet            Started container migrate
  Warning  Unhealthy  12m   kubelet            Readiness probe failed: connection refused
  Warning  Killing    12m   kubelet            Stopping container migrate
```

There should not have been a [readiness probe](/workloads/health-checks/) on this Job. Someone had copied the application container spec into the migration manifest and left the probes in place. The process was doing a long backfill and intentionally did not expose HTTP. The kubelet treated that as failed health, terminated the container, and the Job controller did exactly what it was configured to do: create another pod.

Kubernetes was innocent. Our manifest was guilty.

:::tip[War story]
The worst migration bugs often hide in reused Deployment templates. Probes, sidecars, lifecycle hooks, and environment variables that make sense for a long-running web process can be actively harmful for a one-shot migration process. A Job is not a tiny Deployment. Treat it as its own workload.
:::

## What Made It Worse

The Job had a few choices that each looked harmless in review.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: orders-migrate
  namespace: shop
spec:
  backoffLimit: 6
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: registry.example.com/orders/migrate:2026.07.05.1
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8080
            periodSeconds: 10
            failureThreshold: 12
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: orders-db
                  key: url
```

`restartPolicy: Never` meant a failed pod stayed visible, which helped debugging. But `backoffLimit: 6` meant Kubernetes was allowed to try the migration up to seven times total. That is reasonable for a network-copy worker. It is reckless for a non-idempotent schema writer.

The readiness probe was the direct kill switch. The missing idempotency was the blast radius.

The migration SQL looked like this:

```sql
ALTER TABLE orders ADD COLUMN tax_region text;

UPDATE orders o
SET tax_region = ca.tax_region
FROM customer_address ca
WHERE ca.customer_id = o.customer_id;

ALTER TABLE orders ALTER COLUMN tax_region SET NOT NULL;
```

There are three production problems packed into that file:

- `ADD COLUMN` was not guarded with `IF NOT EXISTS`.
- The backfill had no progress marker, batch boundary, or resume behavior.
- The final `SET NOT NULL` assumed the backfill completed perfectly.

Idempotency does not mean "ignore all errors and keep moving." It means each step can safely observe the current state and converge it toward the intended state. If the column exists, verify its type. If the backfill partially ran, continue from remaining rows. If the constraint is already present, confirm it matches the expected definition.

:::danger
Do not paper over failed migrations by manually inserting rows into the migration history table unless you have independently verified every schema object, constraint, index, trigger, and data backfill side effect. Marking a migration as applied is a production data contract, not a way to make CI green.
:::

## Stabilize First

At 3:00 AM, the goal is not to design the perfect migration framework. The goal is to stop making the database worse.

First, suspend or scale down anything that can keep retrying the broken migration. For a Job, you can suspend it if your cluster supports `spec.suspend` for Jobs.

```bash
kubectl -n shop patch job orders-migrate --type=merge -p '{"spec":{"suspend":true}}'
```

```console
job.batch/orders-migrate patched
```

If `suspend` is not available or your platform policy blocks patching Jobs, delete the Job after preserving evidence.

```bash
kubectl -n shop get job orders-migrate -o yaml > orders-migrate.job.yaml
kubectl -n shop get pods -l app=orders-migrate -o yaml > orders-migrate.pods.yaml
kubectl -n shop delete job orders-migrate
```

```console
job.batch "orders-migrate" deleted
```

:::caution
Deleting the Job does not undo database changes. It only stops Kubernetes from creating more migration pods. If your Job uses finalizers or an external controller such as Argo CD, Helm, or Flux, check whether it will be recreated automatically.
:::

Then stop rolling new app pods that depend on the incomplete schema. If the old ReplicaSet still works, pin traffic there by [undoing the rollout](/workloads/rollouts-and-rollbacks/) or scaling the new Deployment down, depending on your release controller.

```bash
kubectl -n shop rollout undo deployment/orders-api
kubectl -n shop rollout status deployment/orders-api --timeout=90s
```

```console
deployment "orders-api" rolled back
deployment "orders-api" successfully rolled out
```

Watch the boring metrics while you do this:

- HTTP 5xx rate for the new and old ReplicaSets separately.
- Database connection pool saturation.
- Database lock waits and long-running transactions.
- Job pod creation count.
- New application pod restart rate.

For PostgreSQL, the database team checked locks and the partial schema state from their side. From a restricted namespace, we could still verify the app-level symptom by using the same database client image our migration used, passing the connection string in from our own shell. Note that `kubectl run` has no `--env-from` flag — it only takes repeatable `--env=` — and `$DATABASE_URL` has to expand inside the pod, not the local shell, so the query runs through an inner `sh -c`. Your policies may differ.

```bash
kubectl -n shop run orders-db-check \
  --rm -it \
  --restart=Never \
  --image=registry.example.com/platform/psql:16 \
  --env="DATABASE_URL=$DATABASE_URL" \
  --command -- sh -c 'psql "$DATABASE_URL" -c "select count(*) filter (where tax_region is null) as missing_tax_region from orders;"'
```

```console
 missing_tax_region
--------------------
             184921
(1 row)
```

That number explained why the new app was failing. The column existed, but the data contract was not satisfied.

:::note[Restricted namespace reality]
Many teams cannot launch arbitrary database clients from production namespaces. If you cannot, ask the platform or database team for a read-only check using the exact SQL you want run, the namespace, the Job name, the migration image digest, and the timestamps from the failed pods. A good ticket has commands and evidence, not vibes.
:::

## Recovery

The recovery path was deliberately boring:

1. Keep the application rolled back to the last version that did not require `orders.tax_region`.
2. Stop the retrying migration Job.
3. Verify the partial schema state with the database team.
4. Ship a new migration image that could resume safely.
5. Run the fixed migration once with retries disabled.
6. Deploy the application after the schema contract was true.

The fixed migration did not pretend the first run never happened. It treated the database as the source of truth.

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_region text;

UPDATE orders o
SET tax_region = ca.tax_region
FROM customer_address ca
WHERE ca.customer_id = o.customer_id
  AND o.tax_region IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM orders WHERE tax_region IS NULL) THEN
    RAISE EXCEPTION 'orders.tax_region backfill incomplete';
  END IF;
END $$;

ALTER TABLE orders ALTER COLUMN tax_region SET NOT NULL;
```

The replacement Job removed probes and limited retries.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: orders-migrate-20260705-resume
  namespace: shop
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 86400
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: registry.example.com/orders/migrate:2026.07.05.2
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: orders-db
                  key: url
```

Then we watched it like it owed us money.

```bash
kubectl -n shop logs -f job/orders-migrate-20260705-resume
```

```console
2026-07-05T04:02:18.441Z starting migration bundle 2026.07.05.2
2026-07-05T04:02:18.902Z column orders.tax_region already exists, verifying type
2026-07-05T04:02:19.114Z backfilling remaining rows where tax_region is null
2026-07-05T04:06:47.552Z remaining rows with tax_region is null: 0
2026-07-05T04:06:48.031Z enforcing NOT NULL constraint
2026-07-05T04:06:48.620Z migration completed
```

```bash
kubectl -n shop get job orders-migrate-20260705-resume
```

```console
NAME                             COMPLETIONS   DURATION   AGE
orders-migrate-20260705-resume   1/1           4m31s      6m
```

Only after that did we roll the application forward again.

```bash
kubectl -n shop set image deployment/orders-api \
  orders-api=registry.example.com/orders/api:2026.07.05.1

kubectl -n shop rollout status deployment/orders-api --timeout=3m
```

```console
deployment "orders-api" successfully rolled out
```

## Prevention That Actually Helps

The follow-up was not "be more careful." That is not an engineering control. We made these changes instead.

### Make migration Jobs boring

Migration Jobs do not get web probes, service mesh sidecars by default, or copied Deployment lifecycle hooks.

```yaml
spec:
  backoffLimit: 0
  template:
    metadata:
      annotations:
        sidecar.istio.io/inject: "false"
    spec:
      restartPolicy: Never
```

`backoffLimit: 0` is not magic. It just means Kubernetes will not automatically create a second pod after the first failed pod. If the migration is safe to retry, a human or release controller can make that decision with the logs in hand.

### Put idempotency in the migration, not the runbook

Every migration that changes durable state should survive three realities:

- The statement already ran.
- The statement partially ran.
- The migration history row was not written.

For schema changes, prefer guards and verification:

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_region text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'orders'
      AND column_name = 'tax_region'
      AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'orders.tax_region missing or wrong type';
  END IF;
END $$;
```

For backfills, make progress observable and resumable. A ten-million-row update with no batch marker is not a migration; it is a suspense novel.

### Gate app rollout on migration success

If your release system can express dependencies, make the application rollout wait for the migration Job to complete. If it cannot, make the pipeline check it explicitly.

```bash
kubectl -n shop wait \
  --for=condition=complete \
  --timeout=10m \
  job/orders-migrate-20260705-resume
```

```console
job.batch/orders-migrate-20260705-resume condition met
```

Also check for failed pods, because a completed Job with earlier failed attempts can still be evidence of a migration that got lucky.

```bash
kubectl -n shop get pods -l job-name=orders-migrate-20260705-resume \
  -o custom-columns=NAME:.metadata.name,PHASE:.status.phase,NODE:.spec.nodeName,EXIT:.status.containerStatuses[0].state.terminated.exitCode
```

```console
NAME                                    PHASE       NODE        EXIT
orders-migrate-20260705-resume-zm8tc    Succeeded   worker-07   0
```

### Ask the platform team for the right controls

Namespace-level developers usually cannot enforce cluster-wide admission policy, inspect kubelet logs, or change CSI and node behavior. That is fine. Ask for controls with evidence attached.

Good platform tickets from this incident were specific:

- Add an admission warning when a `batch/v1 Job` includes `readinessProbe` or `livenessProbe`.
- Add a policy template for migration Jobs with `backoffLimit: 0`, `restartPolicy: Never`, and `ttlSecondsAfterFinished`.
- Expose Job retry count, failed pod count, and pod replacement events in the namespace dashboard.
- Document whether the service mesh is injected into Jobs by default and how app teams opt out.

Bad platform tickets would have been vague:

- Kubernetes killed our migration.
- Jobs are unsafe.
- Need cluster-admin to debug production.

The difference matters. Platform teams can act on concrete guardrails.

## The Checklist We Kept

Before running a database migration from Kubernetes now, we check this list:

- The migration can run twice without corrupting schema state.
- Backfills are resumable and scoped with observable progress.
- The Job has no HTTP probes copied from the app Deployment.
- `backoffLimit` is intentionally chosen, usually `0` for schema writers.
- The migration image prints each step, duration, and final verification query.
- The application rollout waits for the migration Job to complete.
- Rollback is defined as either application-only rollback, forward-fix migration, or database restore. Nobody says "rollback" without naming which one.

:::tip
The key production habit is to assume your migration pod can die after any line. Node drain, eviction, probe kill, image pull error, database failover, expired token, and plain old process crash all lead to the same question: what happens if Kubernetes starts it again?
:::

## The Root Cause

The root cause was not that Kubernetes retried a failed Job. That was expected controller behavior.

The root cause was a non-idempotent migration packaged as a retryable Kubernetes Job, with a copied readiness probe that killed the first run mid-backfill. The retry exposed the bug. The incomplete schema broke the next application version.

The fix was not one thing. It was a chain:

- Remove inappropriate probes from one-shot migration Jobs.
- Stop automatic retries for migrations that are not proven retry-safe.
- Make migrations converge from partial state.
- Gate application rollout on verified migration completion.
- Give the platform team precise admission-policy and observability asks.

That is the lesson I still trust: Kubernetes will eventually do the thing your manifest says it is allowed to do. Your database migration needs to survive that, not merely hope it happens during a quiet minute.
