---
title: "The Maintenance Contract With Your Platform Team"
description: Every PDB is half a contract. The other half — the six numbers to ask the platform team for, what to promise back (including the no-zero-budget CI check), the one-time RBAC ask, the before/during/after window runbook, the PDB review checklist, and the alerts that page you instead of them.
keywords:
  - what to ask platform team about node drains
  - drain timeout what happens when it expires
  - maintenance window checklist kubernetes tenant
  - pdb review checklist pull request
  - alert when pdb allowed disruptions is 0
  - kube_poddisruptionbudget_status_pod_disruptions_allowed
  - rbac for pods/eviction
  - ci check pod disruption budget zero
  - platform team overrode our pdb disable-eviction
sidebar:
  order: 9
---

You are here if: you're the SRE rolling disruption budgets out to five teams and need the artifacts — the asks, the checklist, the runbook, the alerts; or you're one team and want maintenance windows to be boring; or you've just learned the platform team bypassed your budget and nobody told you.

Every PDB is half of a contract. It tells the platform team what you can absorb; it says nothing about what they'll do when your budget says no, how long they'll wait, or which of your numbers their tooling will override. This page is the other half — the questions whose answers change settings you own, the promises that make your budgets trustworthy, and the routine that turns a window into a log line. It serves the section's fourth question: **who finds out when it goes wrong?** The answer should be you, from an alert, ten minutes in — not them, from a stalled job, six hours in.

## What to ask

Six questions. Each answer feeds a number you set — that's the reason to ask it, and the reason it's worth the platform team's time to answer:

| Ask | Why it matters to you | The setting it feeds |
|---|---|---|
| **What is your drain timeout, and what happens when it expires** — skip the node and page a human, retry next pass, or fall back to plain deletion (`--disable-eviction`)? | Decides whether a slow-but-legal drain (a quorum set's serial moves) is safe, and what "the budget said no" actually costs | The stateful set's measured drain time vs their timeout; whether you need a *window* rather than a budget |
| **Does your tooling pass `--grace-period`, and how many nodes does it drain at once?** | The flag replaces `terminationGracePeriodSeconds` with its own value — the one flag that reaches inside your pod, dangerous when it's smaller than your `S + D`; parallel drains decide whether "one node at a time" is an assumption you can make | `D` (your app's drain timeout) must fit *their* number, not yours — [the inequality](/workloads/graceful-shutdown/#the-budget-inequality); the `AlwaysAllow` trade on [the PDB page](/disruption/pod-disruption-budgets/#unhealthypodevictionpolicy-letting-the-broken-ones-go) |
| **What are the kubelet's `shutdownGracePeriod` and `shutdownGracePeriodCriticalPods`** (and per-priority windows, if enabled)? | OS-level reboots after patching terminate pods inside that window with no PDB and a capped grace | `min(G, their window) > S + D + margin` — [When Nobody Asked](/disruption/involuntary-disruptions/#kubelet-graceful-node-shutdown) |
| **When are the windows, how are they announced, and do you cordon ahead of draining?** | Lets you run the [runbook](#the-maintenance-window-runbook), avoid rollouts during a cordon (surge pods go Pending), and keep `maxUnavailable: 1` out of the lunch peak where it only just holds | The calendar entry; the "no rollout during the window" rule; the SLO table's ceiling row |
| **Which disruption tools run outside windows** — a descheduler, the VPA updater, anything autoscaler-class? | Evictions at 14:00 on a Tuesday are legal and budget-respecting; you should know they can happen | Whether "no rollout in progress" is a window rule or an always rule; alert thresholds |
| **Are `--disable-eviction` overrides logged, and will you tell us?** | A bypassed budget looks like a `kubectl delete` from your seat — no 429, no `DisruptionTarget`; you need to know your promise was overridden | The [post-window check](#the-maintenance-window-runbook); the [emergency clause](#what-to-promise-back) |

Ask in the [format that gets fast yeses](/operations/working-with-platform-team/#writing-requests-that-get-fast-yeses):

```text
REQUEST:   The six drain/shutdown facts for cluster prod-east (below), and a pointer to
           where they're documented so we don't ask again after the next upgrade.
           1. drain timeout + behavior at expiry   2. --grace-period passed? (value); nodes drained in parallel?
           3. kubelet shutdownGracePeriod / CriticalPods / per-priority windows
           4. window calendar + announcement channel + cordon lead time
           5. tools that evict outside windows (descheduler, VPA updater, …)
           6. are --disable-eviction overrides logged, and will we be told?
WHY:       We size terminationGracePeriodSeconds, PDBs, and our Job policies against
           these numbers; guessing them is how our namespace stalled the 2026-05-20 drain.
EVIDENCE:  Our current budgets: `kubectl get pdb -n payments` (attached). All permit ≥ 1.
DURATION:  permanent (re-ask after cluster upgrades)
URGENCY:   this week — before the next window
ROLLBACK:  n/a (read-only)
```

## What to promise back

The obligations that make your budgets worth honoring. Put them in the team's runbook and mean them:

1. **Every PDB you wrote permits at least one eviction at steady state.** `disruptionsAllowed ≥ 1` on a healthy day, for every budget in the namespace, checked by the alert below and by CI before merge. The one exception is budgets an operator owns and moves around itself — CloudNativePG's primary budget sits at `0` *by design* because the operator switches the primary over rather than letting it be evicted ([the stateful page](/disruption/stateful-and-quorum/#who-owns-the-pdb)); those are exempted by name in the alert and the audit, never "fixed".
2. **A named contact per namespace during windows**, reachable on the channel the platform uses — not a shared mailbox.
3. **The no-zero-budget rule, in CI** — the check below runs on every chart render and fails the build on a budget that permits nothing at the workload's floor.
4. **A written exception process for the budgets that permit nothing.** `maxUnavailable: 0`, `minAvailable: 100%`, or a floor equal to the replica count require a platform-team sign-off that names the reason, the expiry date, and who gets paged when the drain stalls. Almost nobody completes the form; that's the form working.
5. **The emergency clause, agreed in advance:** "If our budget blocks you for more than *N* minutes during a window and you can't reach our contact, you may bypass it for the blocking pod with `--disable-eviction` and page us afterward." This converts the six-hour standoff into a fifteen-minute one with a name on it — and it's what makes the previous four promises credible.
6. **Measured drain times for anything that takes longer than a minute** — the quorum sets — given to them *before* the window ([the stateful page](/disruption/stateful-and-quorum/#why-the-drain-takes-forty-minutes)).

### The CI check

The chart renders; a short script recomputes each budget the way the controller does — at the workload's *floor*, which is the HPA's `minReplicas` when one exists — and fails on zero. It assumes the convention this section uses everywhere: the PDB is named after its workload.

```bash
# seat: CI — fails the build on a budget that permits nothing at the workload's floor (python3 + PyYAML)
helm template payments-api charts/payments-api -f values-prod.yaml > /tmp/rendered.yaml
python3 - <<'EOF'
import math, sys, yaml
docs = [d for d in yaml.safe_load_all(open('/tmp/rendered.yaml')) if d]
floors = {}                       # workload name → smallest replica count it will ever run at
for d in docs:
    if d['kind'] in ('Deployment', 'StatefulSet'):
        floors[d['metadata']['name']] = d['spec'].get('replicas', 1)
for d in docs:
    if d['kind'] == 'HorizontalPodAutoscaler':      # the HPA floor wins over the chart's replicas
        floors[d['spec']['scaleTargetRef']['name']] = d['spec'].get('minReplicas', 1)
bad = []
for d in docs:
    if d['kind'] != 'PodDisruptionBudget':
        continue
    name, spec = d['metadata']['name'], d['spec']
    n = floors.get(name)                            # convention: the PDB is named after its workload
    if n is None:
        bad.append(f"{name}: no workload named {name} — check the selector and naming convention"); continue
    mu, ma = spec.get('maxUnavailable'), spec.get('minAvailable')
    if mu is not None:
        allowed = math.ceil(n * int(str(mu).rstrip('%')) / 100) if str(mu).endswith('%') else int(mu)
    else:
        floor = math.ceil(n * int(str(ma).rstrip('%')) / 100) if str(ma).endswith('%') else int(ma)
        allowed = n - floor
    if allowed < 1:
        bad.append(f"{name}: permits {allowed} disruptions at {n} replicas (floor) — a drain-blocker")
    if spec.get('unhealthyPodEvictionPolicy') is None:
        print(f"warn: {name}: unhealthyPodEvictionPolicy unset (default IfHealthyBudget) — deliberate?")
if bad:
    print("\n".join(bad)); sys.exit(1)
print("all budgets permit ≥ 1 disruption at their floor")
EOF
```

```console
all budgets permit ≥ 1 disruption at their floor
```

…or, on the day someone "hardens" a budget:

```console
payments-api: permits 0 disruptions at 2 replicas (floor) — a drain-blocker
```

Both percentages round *up*, as the controller does ([the arithmetic](/disruption/pod-disruption-budgets/#the-arithmetic)); the script mirrors it. Operator-owned budgets don't render from your chart, so the script never sees them — the exemption only matters for the alert and the audit below.

## The one-time RBAC ask

Three permissions the section's commands need beyond namespace-scoped defaults. `pods/eviction` is usually already in the built-in `edit` ClusterRole; the node and PV reads are cluster-scoped and rarely granted by default. Ask once, with the justification attached:

```yaml
# The self-eviction drill (quick-start, Lab 11) — usually already granted via `edit`
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: disruption-drill
  namespace: payments
rules:
  - apiGroups: [""]
    resources: ["pods/eviction"]
    verbs: ["create"]
---
# Read-only cluster views the landing checks need: cordon state, allocatable, pinned volumes
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: disruption-readonly
rules:
  - apiGroups: [""]
    resources: ["nodes", "persistentvolumes"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: team-payments-disruption-readonly
subjects:
  - kind: Group
    name: team-payments
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: disruption-readonly
  apiGroup: rbac.authorization.k8s.io
```

```text
REQUEST:   (1) create on pods/eviction in namespace payments for group team-payments, if not
           already granted; (2) ClusterRole disruption-readonly (get/list/watch on nodes and
           persistentvolumes) bound to team-payments.
WHY:       (1) lets us test our PDBs by evicting our own pods instead of asking you to drain
           a node; (2) lets us see cordons, N-1 headroom, and node-pinned volumes before your
           windows — the checks in /disruption/where-pods-land/.
EVIDENCE:  kubectl auth can-i create pods/eviction -n payments → no
           kubectl auth can-i list nodes → no
DURATION:  permanent
URGENCY:   this week
ROLLBACK:  delete the binding; nothing we run depends on it at runtime
```

The full debugging bundle these join is in [Working With the Platform Team](/operations/working-with-platform-team/#the-debugging-rbac-bundle); the case for *why* a tenant should see nodes at all is [the Field Note's](/blog/the-pdb-that-blocked-the-drain/) last section — the platform team granted read-only PV access after the incident precisely so tenants could self-audit.

## The maintenance-window runbook

Copyable. Paste it into the team wiki, run it every window; the whole thing is fifteen minutes and every line is a command you've met in this section.

```markdown
## Maintenance window — <date>, cluster <name>, nodes <list>   (contact: <name>)

### Before (the day before, and again an hour before)
- [ ] Every budget permits ≥ 1:  `kubectl get pdb -n payments`  — no `ALLOWED DISRUPTIONS 0`
- [ ] No rollout in progress:    `kubectl rollout status deployment/<each> -n payments --timeout=5s`
- [ ] HPA floor vs budget shape: if any PDB is `minAvailable`, confirm minReplicas − minAvailable ≥ 1
- [ ] Spread:                     `kubectl get pods -n payments -o wide` — no workload with all pods on one node
- [ ] Landing table filled for the nodes in the window (/disruption/where-pods-land/#the-landing-drill-without-node-access)
- [ ] Pinned volumes:             the PV audit shows none on the nodes in the window
- [ ] Quorum sets' drain times sent to the platform team
- [ ] Error budget has headroom for the window (if not: ask to defer, in writing)
- [ ] No deploys scheduled during the window (CI freeze or a calendar block)

### During (three terminals, /disruption/anatomy-of-a-drain/#watching-a-window-from-your-seat)
- [ ] `kubectl get pdb -n payments -w`                                   — ALLOWED dips and recovers
- [ ] `kubectl get events -n payments -w --field-selector reason=Killing` — one per pod, spaced
- [ ] `kubectl get pods -n payments -o wide -w`                          — replacements land elsewhere, reach 1/1
- [ ] Capture `DisruptionTarget` on anything dying you didn't expect

### After
- [ ] Every pod Running, none Pending, none `Failed`, spread restored
- [ ] Clean deaths: one "graceful shutdown complete" log line per `Killing` event (the log stopping mid-drain = the grace was too short — theirs or yours)
- [ ] Reasons match: all `EvictionByEvictionAPI`; any `TerminationByKubelet` means a node was rebooted, not drained — those pods linger as `Failed`; read their exit code
- [ ] Error budget unchanged across the window
- [ ] If the platform reports a bypass (`--disable-eviction`): which pod, why the budget blocked, fix by <date>
- [ ] Drain times per quorum set recorded (from the Killing timestamps) and sent back
```

## The PDB review checklist

The review gate for any PR that adds or changes a PodDisruptionBudget. Copyable; each line links to the page that earns it.

```markdown
## PDB review — <workload>
- [ ] Shape matches the workload: HPA-managed → integer `maxUnavailable`; quorum → one PDB per role;
      bare pods → integer `minAvailable`            (/disruption/pod-disruption-budgets/#which-shape)
- [ ] `# derivation:` comment present, with the SLO level stated (a/b/c) and a date
- [ ] Holds at BOTH ends of the load table — floor row and ceiling row shown
                                                     (/disruption/pod-disruption-budgets/#the-canonical-pdb-table)
- [ ] Selector is the chart's selector helper — not copied, not a subset, not a superset
- [ ] No overlap: `kubectl get pdb -n <ns>` shows no other PDB selecting these pods, incl. operator-owned
- [ ] `unhealthyPodEvictionPolicy` chosen deliberately: AlwaysAllow (stateless) / IfHealthyBudget (quorum)
- [ ] Proof in the PR: `kubectl get pdb` output with ALLOWED DISRUPTIONS ≥ 1 on a healthy day
- [ ] Landing traps checked: anti-affinity soft, spread soft or taint-aware, no pinned volumes, quota N+1
                                                     (/disruption/where-pods-land/#the-traps)
- [ ] Shutdown audit passed for this workload (the budget makes evictions sequential, not clean)
                                                     (/workloads/graceful-shutdown/#the-shutdown-audit)
- [ ] Alert exists for this namespace's budgets       (below)
- [ ] For a budget that permits nothing: the signed exception is linked, with an expiry
```

## Alerts and dashboards

Rules from [kube-state-metrics](/observability/metrics/), wired as a `PrometheusRule` the way [Alerting](/observability/alerting/) sets them up. Each rule: what fires, what it means, what to do.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: payments-disruption
  namespace: payments
spec:
  groups:
    - name: disruption
      rules:
        # The budget has permitted nothing for 30 minutes. On a healthy day this is a
        # drain-blocker (fix the shape); with pods down it's the budget doing its job (fix the pods).
        # Exempt budgets an operator keeps at 0 on purpose (CNPG's primary budget here).
        - alert: PDBPermitsNothing
          expr: kube_poddisruptionbudget_status_pod_disruptions_allowed{namespace="payments", poddisruptionbudget!~"appdb-primary"} == 0
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "PDB {{ $labels.poddisruptionbudget }} has permitted no evictions for 30m"
            runbook: "/disruption/pod-disruption-budgets/#unjamming-a-blocked-drain-right-now"

        # The budget guards nothing: selector drift after a rename, or a PDB left behind.
        - alert: PDBGuardsNothing
          expr: kube_poddisruptionbudget_status_expected_pods{namespace="payments"} == 0
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "PDB {{ $labels.poddisruptionbudget }} selects no pods"
            runbook: "/disruption/pod-disruption-budgets/#selectors-guard-exactly-one-thing"

        # A pod has been Terminating for more than twice the longest grace period in the namespace.
        # kube_pod_deletion_timestamp is an EXPERIMENTAL metric — confirm your kube-state-metrics exposes it.
        - alert: PodTerminatingTooLong
          expr: (time() - kube_pod_deletion_timestamp{namespace="payments"}) > 120
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "{{ $labels.pod }} has been Terminating for over 2 minutes"
            runbook: "/troubleshooting/stuck-terminating/"
```

Three dashboard panels that make a window legible, each one query:

```promql
# Panel 1 — budgets: allowed disruptions per PDB (a healthy namespace is a flat line ≥ 1)
kube_poddisruptionbudget_status_pod_disruptions_allowed{namespace="payments"}
```

```promql
# Panel 2 — healthy vs desired per PDB (the gap is what the drain is waiting for)
kube_poddisruptionbudget_status_current_healthy{namespace="payments"}
  - kube_poddisruptionbudget_status_desired_healthy{namespace="payments"}
```

```promql
# Panel 3 — pods the kubelet ended rather than a drain: node pressure, node shutdown, a lost node
# (kube_pod_status_reason is EXPERIMENTAL and reads the pod's status.reason only — the DisruptionTarget
#  condition reasons like EvictionByEvictionAPI are NOT exported by kube-state-metrics; capture those in the watch loop)
sum by (reason) (kube_pod_status_reason{namespace="payments", reason=~"Evicted|Shutdown|NodeLost"})
```

If you can see node metrics — the platform's Prometheus often exposes `kube_node_spec_unschedulable` to tenants even when the API doesn't — a fourth panel, `kube_node_spec_unschedulable == 1`, shows the cordons as they happen and is the earliest signal a window has started.

**Dynatrace.** The same PDB status fields appear in the Kubernetes API integration's workload views (the PDB is a first-class object there), so a Dynatrace-only prod can chart `disruptionsAllowed` per namespace and alert on zero. The token and scope ceremony is the same as for [scaling signals](/autoscaling/dynatrace-signals/); the query is a workload-status metric, not a DQL exercise.

**Define → observe → decide, for the alert:** `PDBPermitsNothing` fires → open `kubectl get pdb -n payments` and `kubectl get pods -n payments` → all pods Ready means the *shape* permits nothing at this count (the 3 a.m. problem, or a percentage that rounded against you) → fix the shape; pods `0/1` means you're degraded and the budget is correctly refusing to make it worse → fix the pods, and set `AlwaysAllow` so the platform can at least remove the broken ones.

## Governance for the SRE rolling this out

The namespace audit, quarterly, alongside [the capacity true-up](/autoscaling/capacity-and-governance/):

```bash
# seat: tenant (per namespace) or cluster-read (all at once)
kubectl get pdb -A -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,MIN:.spec.minAvailable,MAX:.spec.maxUnavailable,POLICY:.spec.unhealthyPodEvictionPolicy,EXPECTED:.status.expectedPods,ALLOWED:.status.disruptionsAllowed | awk 'NR==1 || $7==0'
```

```console
NS          NAME            MIN      MAX      POLICY            EXPECTED   ALLOWED
reporting   summary-api     <none>   0        <none>            2          0
reporting   audit-writer    80%      <none>   <none>            4          0
payments    report-cache    2        <none>   IfHealthyBudget   0          0
```

Three findings in one line: a `maxUnavailable: 0` (the Field Note's), a percentage that rounds to everything, and a PDB guarding nothing (`EXPECTED 0` — a rename). Each row is a ten-minute conversation, and the audit is what makes the quarter's windows uneventful. Keep a short exemption list beside it for operator-owned budgets that sit at zero by design (CNPG's primary budget) — the `OWNER` column from [the stateful page's audit](/disruption/stateful-and-quorum/#who-owns-the-pdb) tells them apart — so the same rows don't get re-litigated every quarter. Track the derivation comments too — a budget with no `# derivation:` is a budget nobody can defend at review, and the [checklist](#the-pdb-review-checklist) is where it gets caught next time.

## Where next

- **Next in the journey:** [Disruption on One Page](/disruption/cheat-sheet/) — every table on the section condensed, and the FAQ.
- **The lateral jump:** the asks on this page go through the same door as every other platform request — [Working With the Platform Team](/operations/working-with-platform-team/) is how to make them land.
