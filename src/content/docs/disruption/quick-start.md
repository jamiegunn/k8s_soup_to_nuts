---
title: The 15-Minute Safe PDB
description: The smallest PodDisruptionBudget that can't hurt anyone — you or the platform team — with a four-check gate, the recipe annotated line by line, how to read kubectl get pdb, and a sixty-second self-eviction drill that proves it works without draining a node.
keywords:
  - quick pdb for a deployment
  - safe default pod disruption budget
  - how do i test a pdb without draining a node
  - evict my own pod kubectl
  - pdb by friday platform team asked
  - simplest poddisruptionbudget helm
  - kubectl create --raw eviction
sidebar:
  order: 2
---

You are here if: the platform team asked every namespace to have a PodDisruptionBudget by Friday; or your pods got moved during patching and something dropped, and you want the minimum that stops it happening again; or you've never written a PDB and want the first one to be right.

Here is the smallest budget that can't hurt anyone — not you, not the team draining the node — and the honest list of what it doesn't do. Fifteen minutes if the gate passes. If the gate fails, it found the thing that would have made your first drain worse, not better.

## The gate: four checks, one command each

A PDB makes evictions *sequential*. Only the things below make each eviction *clean* — and a budget on an app that can't survive one eviction just makes the drain slower. Every command uses `payments-api` in namespace `payments`; substitute your names.

**1. At least two replicas — and if an HPA owns the count, at least two at the floor.** One replica means every drain is an outage with paperwork.

```bash
# seat: tenant
kubectl get deployment payments-api -n payments -o jsonpath='{.spec.replicas}{"\n"}'
kubectl get hpa payments-api -n payments -o jsonpath='{.spec.minReplicas}{"\n"}'
```

```console
3
2
```

Read the *second* number if it exists: the HPA's floor is where the drain will find you at 3 a.m. Below 2 on either → [High Availability](/workloads/high-availability/) first; the fix is a replica, not a budget.

**2. A readiness probe that tells the truth.** The budget counts *Ready* pods — a probe that passes before the app can serve makes the budget count a pod that isn't there.

```bash
# seat: tenant
kubectl get deployment payments-api -n payments -o jsonpath='{.spec.template.spec.containers[0].readinessProbe.httpGet.path}{"\n"}'
```

```console
/actuator/health/readiness
```

Empty output means no probe → [Health Check Design](/tuning/health-check-design/) before anything else.

**3. The first three lines of the shutdown audit pass.** Exec-form entrypoint, a SIGTERM handler proven with `kill -TERM 1`, a preStop present. An eviction is a deletion with a bouncer in front; the bouncer decides *whether*, and [Graceful Shutdown](/workloads/graceful-shutdown/#the-shutdown-audit) decides *how*. Tick those three boxes there, then come back.

**4. You're allowed to create the object.**

```bash
# seat: tenant
kubectl auth can-i create poddisruptionbudgets -n payments
```

```console
yes
```

`no` → the PDB is namespace-scoped and this is an easy ask ([the request format](/operations/working-with-platform-team/#writing-requests-that-get-fast-yeses)).

## The recipe

Two files in the chart. Every line's reason is on the line.

```yaml
# charts/payments-api/values.yaml
pdb:
  enabled: true
  maxUnavailable: 1
  # derivation (level c — provisional): "we believe one pod may be missing at any time."
  # TODO: derive from the SLO at the HPA floor AND ceiling — /disruption/pod-disruption-budgets/#the-canonical-pdb-table
  minAvailable: ""                         # empty ON PURPOSE — see "why not minAvailable" below
  unhealthyPodEvictionPolicy: AlwaysAllow  # let the platform remove a pod that's already broken;
                                           # the budget still protects the healthy ones
```

```yaml
# charts/payments-api/templates/pdb.yaml
{{- if .Values.pdb.enabled }}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "payments-api.fullname" . }}
  labels:
    {{- include "payments-api.labels" . | nindent 4 }}
spec:
  {{- if .Values.pdb.minAvailable }}
  minAvailable: {{ .Values.pdb.minAvailable }}
  {{- else }}
  maxUnavailable: {{ .Values.pdb.maxUnavailable }}     # a CEILING on the missing: "never more than 1 gone"
  {{- end }}
  unhealthyPodEvictionPolicy: {{ .Values.pdb.unhealthyPodEvictionPolicy }}
  selector:
    matchLabels:
      {{- include "payments-api.selectorLabels" . | nindent 6 }}   # the SAME helper the Deployment uses:
                                                                    # copied labels drift; helpers don't
{{- end }}
```

**Why `maxUnavailable: 1` and not `minAvailable`.** `maxUnavailable: 1` says "at most one of my pods may be missing," and it means that at *every* replica count — at your HPA floor of 2 it permits one eviction, and at your ceiling of 16 it still permits exactly one. `minAvailable: 2` says "keep 2," which at the 3 a.m. floor of 2 permits **zero**, and the drain waits until the platform's timeout expires and someone gets paged. [The 3 a.m. problem](/disruption/pod-disruption-budgets/#pdb-and-hpa-the-3-am-problem) has the full table; the short version is that a ceiling on the missing follows the HPA and a floor doesn't.

**Why `AlwaysAllow`.** Under the default, a crashlooping pod can block a drain for as long as you're short of healthy pods — the platform can't even remove the pod that's already down. `AlwaysAllow` lets broken pods go; healthy ones stay protected. The trade (a slow-starting replacement might be evicted mid-startup) is [worked on the PDB page](/disruption/pod-disruption-budgets/#unhealthypodevictionpolicy-letting-the-broken-ones-go) and is the right one for anything stateless.

Ship it:

```bash
# seat: tenant
helm upgrade payments-api charts/payments-api -n payments --reuse-values --set pdb.enabled=true
```

```console
Release "payments-api" has been upgraded. Happy Helming!
NAME: payments-api
NAMESPACE: payments
STATUS: deployed
REVISION: 42
```

No pods roll — the pod template didn't change; only a new object appeared.

## Read the proof

The first time you look at a PDB, read every column:

```bash
# seat: tenant
kubectl get pdb payments-api -n payments
```

```console
NAME           MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
payments-api   N/A             1                 1                     8s
```

- **`MIN AVAILABLE` / `MAX UNAVAILABLE`** — the shape you wrote. Exactly one of them is set; the other reads `N/A`.
- **`ALLOWED DISRUPTIONS`** — the only number the Eviction API reads: how many of your pods the platform may take *right now*. The controller computes it continuously as `healthy pods − the pods your shape requires`. You never set it.
- **The one rule:** `ALLOWED DISRUPTIONS 0` on a healthy day means you shipped a drain-blocker. With this recipe at two Ready pods it reads `1`; if it reads `0`, a pod isn't Ready, or the selector matched nothing — `kubectl describe pdb payments-api -n payments` says which.

## The self-eviction drill

Sixty seconds, and it's the reason this page exists: you don't need anyone to drain a node to prove your budget. The Eviction API is the same call a drain makes, and you can make it against your own pod.

```bash
# seat: tenant — needs create on pods/eviction (bundled in the built-in `edit` role)
cat > eviction.json <<'EOF'
{
  "apiVersion": "policy/v1",
  "kind": "Eviction",
  "metadata": {
    "name": "payments-api-7c9d4f6b8-k2xvn",
    "namespace": "payments"
  }
}
EOF
kubectl create --raw /api/v1/namespaces/payments/pods/payments-api-7c9d4f6b8-k2xvn/eviction -f eviction.json
```

```console
{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Success","code":201}
```

`201` is the budget saying yes — the same answer a drain gets. In a second terminal, watch the budget spend itself and recover:

```bash
# seat: tenant
kubectl get pdb payments-api -n payments -w
```

```console
NAME           MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
payments-api   N/A             1                 1                     2m
payments-api   N/A             1                 0                     2m     ← granted: spent the instant the eviction is allowed
payments-api   N/A             1                 1                     3m     ← recovered: the replacement passed readiness (~45 s)
```

That dip is your replacement's startup time — the window during which a drain's *next* eviction of your pods would get a 429. You just did, to one pod, exactly what a node drain does to all of them. If your error dashboard stayed flat during it, your [shutdown](/workloads/graceful-shutdown/) is clean; if it didn't, the budget worked and the shutdown didn't — two different pages.

**If the API answers `403 Forbidden`:** you don't have `create` on `pods/eviction`. The ask is [pre-written](/disruption/platform-contract/#the-one-time-rbac-ask). Until it lands, the budget is still correct; you just can't drill it yourself.

:::caution[What this deliberately doesn't do]
- **It doesn't check whether the replacement can land.** A drain removes a node; your pod has to fit on the others, under your own anti-affinity, spread, volume, and quota rules. → [Where Your Pods Land](/disruption/where-pods-land/)
- **The number isn't derived from users.** `1` is a provisional guess that happens to be right for most stateless services. Whether it holds at your lunch peak is arithmetic you haven't done. → [The canonical PDB table](/disruption/pod-disruption-budgets/#the-canonical-pdb-table)
- **It's wrong for StatefulSets and quorums.** Databases, caches, brokers: one member at a time, per role, and the operator may already own the budget. → [Draining Stateful and Quorum Workloads](/disruption/stateful-and-quorum/)
- **Nobody gets told when the budget hits zero.** A silent zero is the six-hour drain. → [Alerts](/disruption/platform-contract/#alerts-and-dashboards)
- **It does nothing against what doesn't ask.** Node shutdown, node pressure, taints, node death — the budget is never consulted. → [When Nobody Asked](/disruption/involuntary-disruptions/)

Your real homework, in order: [what a drain actually does](/disruption/anatomy-of-a-drain/) → [PDBs, all the way down](/disruption/pod-disruption-budgets/) → [where pods land](/disruption/where-pods-land/) → [the contract](/disruption/platform-contract/).
:::

## Where next

- **Next in the journey:** [What a Drain Actually Does](/disruption/anatomy-of-a-drain/) — you've seen the API say yes to one eviction; now see what the platform's tool does with a whole node's worth, and what happens when it says no. (That skips the routing page, [Start From Your Situation](/disruption/scenarios/) — come back to it when a specific pain shows up.)
- **The lateral jump:** want to watch a budget say *no* — the 429, the blocked drain, the crashloop jam — before it happens in production? [Lab 11](/labs/lab-11-survive-the-drain/) does all of it on a laptop.
