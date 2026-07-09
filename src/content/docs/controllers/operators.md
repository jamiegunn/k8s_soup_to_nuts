---
title: Operators
description: What operators are, how to drive them through custom resources, and how to debug operator-managed apps when you can't read the operator's logs.
keywords:
  - operator pattern
  - custom resource spec status conditions
  - observedGeneration behind generation
  - reconcileerror event
  - operator hand-edit reverted
  - pause reconciliation annotation
  - operator lifecycle manager olm
  - cnpg hibernation spec paused
  - debugging operator without logs
  - conditions message ready false
sidebar:
  order: 4
---

An **operator** is a CRD (or several) plus a controller that encodes *operational knowledge* about one kind of software. The Postgres operator knows how to do a safe failover. The Kafka operator knows partition rebalancing. The [cert-manager](/controllers/cert-manager/) controller knows ACME renewal dances — and is the operator most app teams consume first, which makes it the worked example to keep in mind through the mechanics below. Things a senior admin would do at 3 a.m., written into a reconcile loop that never sleeps.

The formula:

```text
operator = custom resource types (the interface)
         + controller (the reconcile loop)
         + domain expertise (what the loop actually does)
```

You write a short CR — "I want a 3-node Postgres 16 cluster with backups to this bucket" — and the operator expands it into StatefulSets, Services, Secrets, PDBs, CronJobs, and keeps all of it correct through upgrades, failures, and scaling. See [Operators for State](/stateful/operators-for-state/) for the stateful-workload specifics; this article is about the general mechanics.

## Levels of operator maturity

The Operator Framework defines five capability levels; you'll meet operators at every one of them, and knowing the level sets your expectations:

| Level | Name | What it means for you |
|---|---|---|
| 1 | Basic install | CR creates the resources. Day-2 is on you. |
| 2 | Seamless upgrades | Bump a version field in the CR; the operator sequences the rolling upgrade safely. |
| 3 | Full lifecycle | Backup/restore, failover, reconfiguration via the CR. |
| 4 | Deep insights | Operator surfaces metrics, alerts, meaningful status conditions. |
| 5 | Auto-pilot | Auto-scaling, auto-tuning, auto-healing without human input. |

A level-1 operator is barely more than a Helm chart with a watch loop. A level-5 operator will *fight you* if you try to manage its children manually — which, as we'll see, is a feature.

## How operators get installed (not by you)

Three common channels, all requiring cluster rights:

- **Plain manifests / Helm chart** — CRDs + a Deployment for the controller + RBAC. The most common.
- **OLM (Operator Lifecycle Manager)** — the OperatorHub machinery, standard on OpenShift; Subscriptions, CSVs, catalog sources. Heavyweight but handles upgrades.
- **Vendor installers** — some ship their own bootstrap.

All of them create CRDs (cluster-scoped) and usually a controller Deployment in a namespace you can't see (`operators`, `openshift-operators`, vendor-named). That's platform-team territory — see [CRDs Explained](/controllers/crds-explained/) for how to phrase the installation request. Your world starts after installation:

```text
you                      platform-owned                     your namespace
────────────────────────────────────────────────────────────────────────────
write CR (spec)  ──▶  operator reconciles  ──▶  StatefulSets, Services,
read status/events ◀──  writes status       ◀──  Secrets, Pods it creates
```

**Spec in, status/conditions/events out.** That's the whole contract.

## Debugging when you can't read the operator's logs

The operator's pod lives in a namespace you can't access. Its logs might as well be on the moon. Here's the evidence chain that works anyway, in order:

### 1. Describe the CR — conditions first

```console
$ kubectl describe postgrescluster main-db
...
Status:
  Observed Generation:  4
  Conditions:
    Type:     Progressing
    Status:   False
    Reason:   PersistentVolumeClaimError
    Message:  cannot expand PVC "main-db-data-2": storageclass "fast-local"
              does not allow volume expansion
    Type:     Ready
    Status:   False
```

Well-built operators put the actual root cause in a condition message. Read every condition, not just `Ready` — the interesting one is usually the `False` condition with the longest message.

### 2. generation vs. observedGeneration

```console
$ kubectl get postgrescluster main-db \
    -o jsonpath='{.metadata.generation} {.status.observedGeneration}'
5 3
```

- **Equal** → the operator has processed your latest spec; whatever's wrong is reported (or should be) in status.
- **observedGeneration behind, and staying behind** → the operator hasn't seen your change: it's down, wedged, or its watch on your namespace is broken. That's platform evidence, verbatim.
- **No observedGeneration at all, on a fresh CR** → nothing has *ever* reconciled it. Classic causes: operator not watching your namespace (scope config), or CR created before the operator was granted RBAC for it.

### 3. Events in your namespace

Operators emit Events attached to your CR and to the children they create:

```console
$ kubectl get events --sort-by=.lastTimestamp --field-selector involvedObject.name=main-db
LAST SEEN   TYPE      REASON              OBJECT                    MESSAGE
2m          Warning   ReconcileError      postgrescluster/main-db  failed to reconcile StatefulSet: ...
```

Events age out (typically after an hour), so capture them *during* the incident. More on event forensics in [Events](/observability/events/).

### 4. Inspect the children

The operator's output is ordinary objects in *your* namespace — StatefulSets, Pods, PVCs, Services. `kubectl describe` those like any other workload; a CR stuck "not Ready" is very often just a child pod in `Pending` or `CrashLoopBackOff` with a perfectly ordinary cause (see [Triage Methodology](/troubleshooting/triage-methodology/)).

:::tip[The escalation package]
If steps 1–4 don't resolve it, you now hold exactly what the platform team needs: CR YAML with full status, the generation mismatch (if any), the Events, and the state of the children. Attach all four to the ticket and ask for the operator's logs *for your CR's reconcile errors around timestamp X*. Specific asks get fast answers.
:::

## Don't hand-edit operator-owned children

The single most common operator-related "bug report": *"I fixed the StatefulSet the operator created, and my fix disappeared."*

Of course it did. The operator is a reconcile loop; the StatefulSet's desired state lives in *its* logic, derived from *your CR*. Your hand-edit is drift, and drift gets reverted — maybe in seconds, maybe on the operator's next full resync, maybe (worst case) at 2 a.m. during an unrelated failover, when the revert also triggers a rolling restart you didn't plan. This is [reconciliation](/controllers/reconciliation/) doing exactly its job.

The correct move is always to express the change through the CR. If the CR has no field for what you need, that's a real gap: check the operator's docs for override hooks (many expose `podTemplate` patches, extra env, resource overrides), and otherwise raise it with the platform team / vendor.

## Escape hatches and paused reconciliation

Sometimes you genuinely need the operator to stand down — an emergency data fix, a vendor-guided manual intervention. Mature operators provide a sanctioned pause:

```yaml
metadata:
  annotations:
    # convention varies per operator — check its docs. Examples in the wild:
    # cnpg.io/hibernation, stackgres.io/reconciliation-pause, etc.
    example-operator.io/paused: "true"
```

or a spec field (`spec.paused: true`, `spec.unmanaged: true`). While paused, hand-edits stick — and *nothing* self-heals, including things you want healed. Rules of engagement:

1. Announce it (ticket, channel) — a paused CR looks identical to a healthy one at a glance.
2. Keep the window short and put a reminder on unpausing.
3. Expect a reconcile storm on unpause: the operator will diff everything and converge, which may restart pods.

:::caution[No pause mechanism? Don't improvise one]
Scaling the operator Deployment to zero is the platform team's escape hatch, not yours — and it pauses reconciliation for *every* CR in the cluster, not just yours. If your operator has no per-CR pause and you need one, that's a request, not a workaround.
:::

## Operator health checklist

Pin this next to your terminal for any operator-managed app:

```bash
kubectl get <kind> <name> -o yaml | less        # full spec + status
kubectl describe <kind> <name>                  # conditions + events, human-readable
kubectl get <kind> <name> -o jsonpath='{.metadata.generation} {.status.observedGeneration}{"\n"}'
kubectl get events --sort-by=.lastTimestamp | tail -30
kubectl get all,pvc -l <operator's instance label>=<name>   # the children
```

If the CR's conditions are green, generations match, and the children are healthy — but the *application* misbehaves — you've cleanly ruled out the operator layer, and you're back to ordinary app debugging. That triage speed is the payoff for learning the contract.
