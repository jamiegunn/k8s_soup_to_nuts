---
title: Operators for Stateful Workloads
description: Why databases need operators, how to evaluate one before betting your data on it, and how installation works when you don't have cluster admin.
keywords:
  - cloudnativepg cnpg
  - crd controller admission webhook
  - reconciliation loop stuck
  - failover promotion fencing
  - kubectl explain crd
  - observedgeneration stale generation
  - pause reconciliation annotation
  - rbac can-i create cluster
  - failed calling webhook
  - operator maturity evaluation
  - platform team install crds
  - reconcilefailed events
sidebar:
  order: 8
---

A StatefulSet can keep a database's pods and volumes alive. It cannot promote a replica, take a consistent backup, or orchestrate a major-version upgrade — because those require knowing *what the software is*, not just that it's a container with a volume. Operators close that gap: they encode a domain expert's runbook as a controller.

## What an operator actually does for state

Take failover, the canonical example. A human DBA's runbook for a dead Postgres primary: confirm it's really dead (not slow, not partitioned), check which replica has the most WAL, promote it, repoint the other replicas, update the endpoint clients use, and make absolutely sure the old primary can't come back as a second writer. That's a dozen ordered, conditional steps with data loss on the failure paths.

An operator is that runbook running in a loop, executed the same way at 3 a.m. as at 3 p.m., with no adrenaline and no skipped steps. CloudNativePG does exactly this sequence in seconds; so does the RabbitMQ operator for its own domain, and Strimzi for Kafka's ("roll brokers one at a time, but only when the partition would stay in-sync"). The pattern generalizes:

- **Failover** — detection, fencing, promotion, endpoint repointing.
- **Backup orchestration** — *application-consistent* backups (WAL archiving, journal flushes), not just disk copies, plus retention and point-in-time restore.
- **Upgrades** — version-aware ordering: replicas first, then switchover, then old primary; refuse known-bad version jumps.
- **Configuration safety** — reject or fix parameter combinations that would break the cluster (the defaulting/validation below).

If you find yourself writing shell scripts in initContainers to do any of these, stop: you are writing a worse operator.

:::note[Operator vs Helm chart]
A Helm chart is a template engine: it stamps out manifests at install time and walks away. An operator watches continuously and *acts* — day 2 is the difference. A chart can install a Postgres StatefulSet; only a controller can notice the primary died at 3 a.m. and promote a replica. Charts are fine for delivering operators and for stateless apps; they are not an HA strategy for state.
:::

## Anatomy: CRD + controller + webhooks

An operator is three cooperating pieces:

1. **CRDs** — new API types (`Cluster`, `RabbitmqCluster`, `Kafka`) teaching the API server a vocabulary. Cluster-scoped objects. [CRDs Explained](/controllers/crds-explained/) covers the machinery.
2. **A controller** — a deployment (usually in its own namespace, e.g. `cnpg-system`) running the reconciliation loop: observe CRs, compare to reality, act. Same loop as every built-in controller — see [Reconciliation](/controllers/reconciliation/).
3. **Admission webhooks** — defaulting (you said `instances: 3`, it fills in sane probe settings) and validation (you tried to shrink storage → rejected at `kubectl apply` time with a real error message, not a broken cluster at 2 a.m.). These run at admission — [Admission Webhooks](/controllers/admission-webhooks/) explains why that also means a *down* operator webhook can block your applies.

You interact with piece zero: the **CR**, a namespaced YAML document in *your* namespace, versioned in *your* git repo, deployed by *your* pipeline. The declarative model survives intact — that's the entire elegance of the pattern.

Day to day, CRs behave like any other resource, which means your whole kubectl toolkit works on them:

```console
$ kubectl get clusters.postgresql.cnpg.io
NAME    AGE   INSTANCES   READY   STATUS                     PRIMARY
appdb   42d   3           3       Cluster in healthy state   appdb-1

$ kubectl explain cluster.spec.backup --api-version=postgresql.cnpg.io/v1
KIND:     Cluster
FIELD:    backup <Object>
DESCRIPTION:
     The configuration to be used for backups...

$ kubectl get cluster appdb -o yaml | yq '.status.conditions'
- type: Ready
  status: "True"
  reason: ClusterIsReady
```

`kubectl explain` against a CRD is criminally underused — it's the operator's API reference, served by your own cluster, guaranteed to match the installed version.

## Evaluating an operator before you bet data on it

Not all operators deserve your data. Work through this before committing:

**Maturity signals.** Release cadence and recency; how it handles the underlying software's new versions (did it support Postgres 17 within months, or is it stuck on 14?); real production adopters you can find; CNCF status or a company with skin in the game. A GitHub star count is not a maturity signal; an issue tracker full of unanswered data-loss reports is.

**CRD stability.** Is the API `v1`, or `v1alpha1` with breaking changes every minor release? Alpha CRDs mean every operator upgrade risks a migration of *your* manifests — and platform teams reasonably hate installing them on shared clusters.

**The backup/restore story.** Non-negotiable for state. Does it do application-consistent backups to object storage? Point-in-time recovery? Is *restore* a first-class operation (a `bootstrap`/`restore` stanza in the CR), or a wiki page of manual steps? Bonus points for restore-into-a-new-cluster, which makes [restore drills](/stateful/backup-and-dr/) cheap.

**Escape hatches.** The question that separates good operators from handcuffs: *when the operator is wrong, can you take over?* Look for: a documented way to pause reconciliation (annotation or CR field), fencing/hibernation controls, the ability to `exec` into the database pod and run native tooling, and — worst case — documented steps to detach the data volumes and run without the operator. CloudNativePG, for example, has all of these:

```bash
# Stop the operator from touching this cluster while you investigate
kubectl annotate cluster appdb cnpg.io/reconciliationLoop=disabled

# Fence a specific instance (shuts down postgres, keeps pod for forensics)
kubectl cnpg fencing on appdb appdb-2
```

If the answer to "what if we uninstall it?" is "your CRs and everything they own get garbage-collected," understand the deletion semantics *before* prod — test what happens to PVCs when a CR is deleted, in a scratch namespace, with data you can afford to lose.

**Observability.** Prometheus metrics for the managed system, meaningful `status` conditions on the CR, events you can read with `kubectl describe`.

**Restricted-cluster fit.** Does it run with a restricted Pod Security profile (no privileged containers, no hostPath)? Can the controller watch only selected namespaces if platform requires it? Operators that demand cluster-wide `*` verbs on core resources will face — and deserve — platform pushback.

## Installing in a cluster where you're not admin

Here's the reality this whole guide assumes: **CRDs are cluster-scoped, so you cannot install an operator yourself.** Neither the CRDs, nor (usually) the operator's ClusterRoles, nor its webhooks. This is a platform team request — and that's genuinely fine, because one operator install serves every team on the cluster.

Make the request concrete. A good template:

> We want to run PostgreSQL via CloudNativePG. Requesting: operator vX.Y (link to release), installed via your preferred method (manifest/Helm/OLM). It adds N CRDs (list), runs in its own namespace, and needs [RBAC summary from the docs]. We'll create only namespaced `Cluster`/`Pooler`/`ScheduledBackup` CRs in our namespaces. Security notes: [image provenance, webhook TLS, any hostPath/privileged requirements — good operators need none].

Then confirm your own access. Platform installing the CRDs doesn't automatically grant you rights to create CRs — that's a Role/RoleBinding in your namespace:

```console
$ kubectl auth can-i create clusters.postgresql.cnpg.io -n myapp
yes
$ kubectl auth can-i create scheduledbackups.postgresql.cnpg.io -n myapp
no
```

If any answer is `no`, the fix is a small namespaced Role the platform team can review in thirty seconds — offer it pre-written:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: cnpg-user
  namespace: myapp
rules:
  - apiGroups: ["postgresql.cnpg.io"]
    resources: ["clusters", "poolers", "scheduledbackups", "backups"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["postgresql.cnpg.io"]
    resources: ["clusters/status"]
    verbs: ["get"]
```

See [RBAC Denied](/troubleshooting/rbac-denied/) for how to diagnose and frame these requests in general. The general division of labor (they own CRDs and controllers, you own CRs) is covered in [Operators](/controllers/operators/) and [Working Without Admin](/start/working-without-admin/).

:::caution[Operator upgrades are platform changes that affect you]
When platform upgrades the operator, *your* databases may restart (new operand images, changed pod specs). Ask to be in the loop on operator upgrades — ideally staged through non-prod first — and pin operand versions in your CRs (`imageName`) so an operator upgrade doesn't silently bump your Postgres minor version at 2 p.m. on a Friday.
:::

## When the operator misbehaves and you can't see it

The operator runs in a namespace you probably can't read. When your CR is stuck, debug from your side of the fence:

1. **The CR's status** — good operators write their state of mind here:

   ```console
   $ kubectl get cluster appdb -o jsonpath='{.status.conditions}' | jq
   $ kubectl describe cluster appdb        # events at the bottom
   ```

2. **Events in your namespace** — operators emit events on the objects they manage:

   ```console
   $ kubectl get events --sort-by=.lastTimestamp | tail -5
   4m    Warning   ReconcileFailed   cluster/appdb    while reconciling PVC: PVC
         data-appdb-2 storage request cannot be decreased from 100Gi to 50Gi
   2m    Normal    CreatingInstance  cluster/appdb    Creating instance appdb-3
   ```

   Half your "operator is stuck" mysteries are answered right here — the operator is *telling you* what it refuses to do and why. More in [Events](/observability/events/).
3. **The managed pods** — their logs and describe output are yours: is the operator failing, or is Postgres itself unhappy?
4. **Check whether anything is reconciling at all** — bump a harmless CR field (a label) and watch `metadata.generation` vs `status.observedGeneration`. If `observedGeneration` never catches up, the controller isn't processing you: it's down, wedged, or its webhook is broken (symptom: your `kubectl apply` fails with `failed calling webhook`).
5. **Then escalate with specifics**: "The cnpg controller hasn't reconciled our `Cluster/appdb` since 14:02 — observedGeneration is stale and applies time out on the mutating webhook. Can you check the operator logs in `cnpg-system`?" That message gets action; "the database is broken" gets a triage queue.

Escalation paths and how to build this kind of working relationship: [Working with the Platform Team](/operations/working-with-platform-team/).

One preparation makes all of this dramatically easier: run the same operator in a kind/minikube cluster on your laptop, where you *are* admin and *can* read the operator logs. An hour of watching how it reconciles, what it logs, and how it reacts to a killed pod builds the mental model you'll be debugging blind against in production.
