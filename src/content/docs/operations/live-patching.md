---
title: Live Patching
description: The emergency kubectl toolkit — scale, set image, edit, and the three patch flavors — plus how to record what you did so it survives the morning.
keywords:
  - kubectl scale replicas
  - kubectl set image hotfix
  - json patch rfc 6902
  - managedfields who changed what
  - last-applied-configuration annotation
  - server-side apply conflict force
  - hpa fighting manual scale
  - kubectl set env feature flag
  - the object has been modified
  - 2 am incident hotfix image
  - kubectl annotate incident logbook
sidebar:
  order: 2
---

When production is on fire, you change it with kubectl and reconcile with git later. This article is the toolkit for the first half of that sentence. [Drift and CI/CD](/operations/drift-and-cicd/) is the second half — read both, because a live patch you can't reconcile is a time bomb.

Every command here works with namespace-scoped access. Nothing requires cluster-admin.

## The toolkit, fastest to most surgical

### kubectl scale — change replica count

```bash
kubectl scale deployment payments --replicas=8
deployment.apps/payments scaled
```

Instant, low-risk, no pod-template change so nothing rolls — new pods just appear (or old ones terminate). Two caveats:

- If an **HPA** targets this Deployment, it will fight you. It reconciles `replicas` toward its own calculation on its next sync (~15s). Raise the HPA's `minReplicas` instead:

```bash
kubectl patch hpa payments --type merge -p '{"spec":{"minReplicas":8}}'
```

- Scaling up needs quota and schedulable capacity. If new pods sit Pending, check [Pod Pending](/troubleshooting/pod-pending/) before assuming the scale "didn't work."

### kubectl set image — swap the container image

```bash
kubectl set image deployment/payments payments=registry.example.com/payments:1.4.2-hotfix1
deployment.apps/payments image updated
```

This is a pod-template change, so it triggers a full rolling update — respecting `maxSurge`, `maxUnavailable`, and readiness probes. It's the canonical hotfix command: you built an emergency image, now you're putting it live. Watch it land:

```bash
kubectl rollout status deployment/payments
Waiting for deployment "payments" rollout to finish: 2 out of 6 new replicas have been updated...
deployment "payments" successfully rolled out
```

The container name (`payments=` before the image) matters when a pod has sidecars — check with `kubectl get deploy payments -o jsonpath='{.spec.template.spec.containers[*].name}'`.

### kubectl edit — the full-YAML scalpel

```bash
kubectl edit deployment payments
```

Opens the live object in `$EDITOR`; save-and-quit submits it. Good when you need to change several things at once or you're not sure of the exact field path. Two dangers:

- **You can change anything**, including things you didn't mean to touch. Deleted a probe line by accident? That's now live.
- **It's unrecordable by nature.** There's no command-line history of *what* you changed. If you use `edit` during an incident, copy the before/after into the incident channel immediately.

:::caution
`kubectl edit` on a resource with a conflict (someone else changed it while your editor was open) fails with `the object has been modified`. Re-open and re-apply your change — don't paste your whole stale buffer over theirs.
:::

When you have more than thirty seconds, prefer the calmer variant: export the object to a file, edit the file, `kubectl diff` it, then apply — the [export → edit → re-apply round trip](/kubectl/tips-and-tricks/#the-round-trip-export-edit-re-apply). Same drift consequences, but you see a reviewable diff *before* anything goes live, and you're left with a file to paste into the incident channel instead of an unrecorded edit.

### kubectl patch — surgical and scriptable

Three flavors. Knowing which to reach for is the difference between a clean patch and a mangled object.

**Strategic merge patch (the default).** You provide a fragment; Kubernetes merges it using per-field rules from the API schema. Lists of containers merge by `name`, so you can update one container without restating the others:

```bash
kubectl patch deployment payments -p '{
  "spec": {"template": {"spec": {"containers": [
    {"name": "payments", "resources": {"limits": {"memory": "2Gi"}}}
  ]}}}
}'
```

This is the workhorse. It shines when you're setting or updating fields on built-in resources.

**JSON patch (`--type json`).** An ordered list of operations (RFC 6902): `add`, `remove`, `replace`, `test`. It shines when you need to **delete** a field or operate on a list by index — things strategic merge can't express cleanly:

```bash
# Remove a bad env var (index 3 of the env list — verify the index first!)
kubectl patch deployment payments --type json -p '[
  {"op": "remove", "path": "/spec/template/spec/containers/0/env/3"}
]'
```

The `test` op makes it safe against races — the patch fails unless the field currently holds the value you expect:

```bash
kubectl patch deployment payments --type json -p '[
  {"op": "test", "path": "/spec/template/spec/containers/0/image",
   "value": "registry.example.com/payments:1.4.2"},
  {"op": "replace", "path": "/spec/template/spec/containers/0/image",
   "value": "registry.example.com/payments:1.4.2-hotfix1"}
]'
```

**Merge patch (`--type merge`).** Plain RFC 7386 merge: objects merge, but **lists are replaced wholesale**. Required for custom resources ([CRDs](/controllers/crds-explained/) have no strategic-merge schema), fine for scalar fields, dangerous for container lists — if you merge-patch `containers` you replace the entire array. When in doubt on a Deployment, use strategic; on a CR, use merge with a fragment that doesn't touch lists you don't fully restate.

**Server-side apply (`kubectl apply --server-side`).** Not a patch flavor of `kubectl patch`, but the same family: you submit a full or partial object and the API server merges it, tracking which *manager* owns which field. Mostly this is what your pipeline does; during incidents its relevance is forensic (see managedFields below) and for conflict semantics — if you `--server-side` apply a field your pipeline's manager owns, you get a conflict unless you `--force-conflicts`, which transfers ownership to you. That ownership transfer is itself a form of drift: some CD tools will then treat the field as "not theirs."

### kubectl set env — env vars without the YAML

```bash
kubectl set env deployment/payments FEATURE_RISKY_CACHE=false
deployment.apps/payments env updated

# Remove a var:
kubectl set env deployment/payments FEATURE_RISKY_CACHE-
```

Pod-template change → rolling restart. Handy for feature-flag style kills when the flag lives in an env var. Also works for re-pointing at a different ConfigMap: `kubectl set env deployment/payments --from=configmap/payments-config-v2`.

### kubectl annotate / label — metadata, and sometimes traffic

```bash
kubectl annotate deployment payments incident.example.com/note="INC-4821 hotfix image live"
kubectl label pod payments-7d4b9c-x2k1p quarantine=true app-
```

Annotations are your incident logbook (no restart, no behavior change). Labels can be load-bearing: removing a pod's `app` label pulls it out of the Service's endpoints **and** out of the ReplicaSet's ownership — the RS spawns a replacement while your poisoned pod stays alive for forensics. That trick is a full incident card in [Emergency playbooks](/operations/emergency-playbooks/).

## Forensics: proving who changed what

After (or during) an incident, you need to answer "who set this field, and when?" Two artifacts help.

**`last-applied-configuration`.** If anything ever ran client-side `kubectl apply` on the object, this annotation holds the full JSON of the last applied manifest:

```bash
kubectl get deployment payments -o jsonpath='{.metadata.annotations.kubectl\.kubernetes\.io/last-applied-configuration}' | jq .
```

Diff it against the live spec and you see exactly what has been changed *outside* apply — i.e., your live edits.

**managedFields.** The API server records, per field, which manager last set it and when. Hidden by default; ask for it:

```bash
kubectl get deployment payments -o yaml --show-managed-fields
```

```yaml
managedFields:
- manager: argocd-controller
  operation: Apply
  time: "2026-07-02T21:40:11Z"
  ...
- manager: kubectl-patch
  operation: Update
  time: "2026-07-03T02:14:37Z"
  fieldsV1:
    f:spec:
      f:template:
        f:spec:
          f:containers:
            k:{"name":"payments"}:
              f:resources:
                f:limits:
                  f:memory: {}
```

That second entry is a signed confession: at 02:14 someone used `kubectl patch` to change the memory limit. `manager` names like `kubectl-edit`, `kubectl-patch`, `kubectl-scale`, `helm`, `argocd-controller`, and your pipeline's service account tell the story. When someone asks "did the pipeline revert it or did a human change it back?" — managedFields answers.

## Worked incident: the 2 AM hotfix image

**02:03** — Pager: `payments` returning 500s on refunds. Logs show an NPE introduced in `1.4.2`, shipped yesterday afternoon.

**02:06** — First instinct: roll back. `kubectl rollout undo deployment/payments` would work (see [Rollouts and rollbacks](/workloads/rollouts-and-rollbacks/)) — but `1.4.1` lacks a schema migration that already ran. Roll-forward it is.

**02:20** — One-line fix committed to a branch, CI builds `1.4.2-hotfix1` and pushes it to the registry. (You use CI to *build* — you just skip waiting for its deploy stage.)

**02:24** — Set it live and watch:

```bash
kubectl set image deployment/payments payments=registry.example.com/payments:1.4.2-hotfix1
kubectl rollout status deployment/payments --timeout=5m
```

**02:31** — Rollout done, error rate at zero. Now the discipline part, *before* sleep:

```bash
kubectl annotate deployment payments \
  incident.example.com/live-edit="02:24Z image 1.4.2->1.4.2-hotfix1 INC-4821 @gunn"
gh pr create --title "Payments 1.4.2-hotfix1 — refund NPE (INC-4821)" \
  --body "Matches live state set at 02:24 UTC. Merge before any other payments deploy."
```

**02:38** — PR open, incident channel updated with the exact commands run. Sleep.

If the deploy branch is protected and no reviewer is awake, that's fine — the PR *existing* is what protects you. Anyone who deploys `payments` in the morning sees it. If your CD is GitOps with self-heal, you can't even wait for morning: the reconciler will revert your `set image` within minutes, so merging (or pausing the sync) is part of the incident itself — see [Drift and CI/CD](/operations/drift-and-cicd/).

## Changes that don't survive pod restarts

Everything above targets the **Deployment** (or StatefulSet). That's deliberate. If you instead touch a **Pod** directly, your change lives exactly as long as that pod does:

| Live action on a Pod | Survives pod replacement? |
|---|---|
| `kubectl exec` — edit a file, tweak a runtime flag, kill a thread | No |
| `kubectl label/annotate pod ...` | No |
| Ephemeral debug container (`kubectl debug`) | No |
| `kubectl edit pod` (most spec fields are immutable anyway) | No |
| Any edit to the Deployment's pod template | Yes — until the pipeline says otherwise |

Pods are cattle: the ReplicaSet will replace them on eviction, node drain, OOM kill, or your own rollout — and the replacement is stamped from the template, not from your patched pod. Exec-level tinkering is fine for *diagnosis* (see [Debugging toolbox](/troubleshooting/debugging-toolbox/)), but never let it be the fix of record. If the fix only exists inside one pod, you haven't fixed anything; you've hidden a relapse.

:::danger[The two-layer trap]
There are two layers that can eat your change: the **ReplicaSet** eats pod-level changes (within minutes-to-days, whenever the pod churns), and the **pipeline** eats Deployment-level changes (on the next deploy or sync). Patching the Deployment only clears the first layer. Clearing the second is the subject of [Drift and CI/CD](/operations/drift-and-cicd/).
:::

## Quick reference

```bash
kubectl scale deployment/NAME --replicas=N          # replicas only, no rollout
kubectl set image deployment/NAME CONT=IMAGE        # rolling update
kubectl set env deployment/NAME KEY=VAL             # rolling update
kubectl edit deployment/NAME                        # anything, unrecorded — copy your diff out
kubectl patch deployment/NAME -p '{...}'            # strategic merge (built-ins)
kubectl patch deployment/NAME --type json -p '[..]' # remove fields, test-and-set
kubectl patch CR/NAME --type merge -p '{...}'       # custom resources
kubectl get deployment/NAME -o yaml --show-managed-fields   # who changed what, when
```

Then: annotate, PR, sleep. In that order.
