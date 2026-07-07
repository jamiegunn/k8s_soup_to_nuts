---
title: Working with the Platform Team
description: The interface between app teams and cluster owners — what's theirs vs yours, how to write requests that get fast yeses, and how to escalate well during incidents.
keywords:
  - rbac request template
  - pods/exec permission denied
  - error from server forbidden
  - quota raise request evidence
  - cluster upgrade readiness
  - pluto deprecated api detection
  - poddisruptionbudget node drain
  - break-glass elevation prod
  - namespace ownership boundary
  - incident escalation etiquette
  - kubectl auth can-i denial
sidebar:
  order: 7
---

You own your application. Somebody else owns the cluster. That boundary is the single most important organizational fact about how you operate, and teams that treat it as an API — with clear contracts, good error messages, and pre-negotiated fast paths — ship faster and page each other less. This article is that API's documentation.

## The ownership map

The exact split varies, but this is the common shape:

| Theirs (platform team) | Yours (app team) |
|---|---|
| Nodes, node pools, OS, kubelet, capacity | Deployments, StatefulSets, Jobs in your namespaces |
| CNI, cluster networking, NetworkPolicy enforcement | Services, your NetworkPolicy *requests* / manifests |
| Ingress **controllers** (nginx, F5, gateway impls) | Ingress **resources** routing to your Services |
| [CRDs](/controllers/crds-explained/) and operator installations (cluster-scoped) | Custom resource *instances* your apps use |
| RBAC grants — Roles/Bindings that give you access | Knowing exactly which verbs you need, and asking |
| StorageClasses, CSI drivers, backup infrastructure | PVCs, data lifecycle, app-level backups |
| Cluster upgrades, API server, etcd | Your workloads' *readiness* for those upgrades |
| ResourceQuotas, LimitRanges on your namespaces | Living within them; asking with evidence when you can't |
| Argo CD / Flux installation and policy | Your app-of-apps, your manifests, your sync hygiene |

Two implications worth internalizing. First: many things that *look* like your bug are their layer (node pressure evicting your pods, CNI drops, an ingress controller reload bug) — the skill of telling the layers apart is most of [Triage methodology](/troubleshooting/triage-methodology/). Second: many things that look like their job are actually yours — nobody but you can set a correct PDB, a graceful shutdown handler, or a memory limit.

## Writing requests that get fast yeses

Platform teams field dozens of requests a week. The ones that get actioned same-day are the ones the platform engineer can execute *without a follow-up question*. The formula:

**Exact resource + namespace + verb/change + duration + evidence.**

Compare:

> "We keep getting permission errors, can someone look at our access?"

...which triggers a triage conversation, versus:

> **Request**: Add `pods/exec`, `pods/portforward`, and `pods/ephemeralcontainers` (create) to the `shop-dev-role` Role in namespaces `shop` and `shop-staging`, for group `team-shop`.
> **Why**: We can't attach debug containers during incidents. Last night (INC-4821, 02:10–02:40 UTC) we lost ~20 min unable to inspect a wedged pod.
> **Evidence**: `kubectl auth can-i create pods/ephemeralcontainers -n shop` → `no`. Denial in audit log at 2026-07-03T02:12:41Z, user `gunn.gsd@example.com`.
> **Duration**: permanent (it's our standing on-call toolkit).

...which is a two-minute yes. Every request type has the same skeleton:

- **Quota raise**: current usage graphs (p99 over 30 days), the arithmetic (`8 replicas × 1.5Gi requests + surge`), what you already did to reduce footprint.
- **New StorageClass / bigger PVC**: workload, IOPS/throughput observed vs needed, retention expectations.
- **NetworkPolicy exception**: source/destination (namespace, label selector, port), protocol, and the failing connection's evidence ([Debugging network](/networking/debugging-network/) shows how to capture it).
- **Operator/CRD installation**: which operator, which version, what you'll use it for, link to its security posture docs — you're asking them to run cluster-scoped code, respect the diligence that requires.

Attach evidence as *artifacts*, not prose: `kubectl describe` output, events with timestamps, the exact `Error from server (Forbidden)` line, correlation IDs. Timestamps in UTC. A platform engineer who can grep their audit log for your exact timestamp is a platform engineer who says yes quickly.

:::tip[Get the denial verbatim]
For RBAC asks, always include the literal output of `kubectl auth can-i <verb> <resource> -n <namespace>` and the full `Forbidden` error. RBAC denials name the exact resource, subresource, and verb — the platform team can turn that string into a Role rule mechanically. More in [RBAC denied](/troubleshooting/rbac-denied/).
:::

Keep the skeleton as a literal template in your team docs:

```text
REQUEST:   <exact resource / permission / change, incl. namespace(s)>
WHY:       <one sentence; incident ID if applicable>
EVIDENCE:  <command outputs, events, timestamps in UTC, correlation IDs>
DURATION:  <permanent | until <date> | for incident INC-xxxx only>
URGENCY:   <now — active incident | this week | whenever>
ROLLBACK:  <how they undo it if it causes problems>
```

The `ROLLBACK` line is the underrated one — a platform engineer approves faster when the blast radius of being wrong is written down for them.

## The debugging RBAC bundle

Ask for this as a package, once, calmly — not piecemeal at 2 AM. It's the minimum kit for the techniques in the [debugging toolbox](/troubleshooting/debugging-toolbox/) and the Java dump articles:

```yaml
# The rules you're asking them to add to your namespace Role
rules:
  - apiGroups: [""]
    resources: ["pods/exec", "pods/portforward", "pods/attach"]
    verbs: ["create"]
  - apiGroups: [""]
    resources: ["pods/ephemeralcontainers"]   # kubectl debug
    verbs: ["update"]
  - apiGroups: [""]
    resources: ["pods/log", "events"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments/scale", "statefulsets/scale"]
    verbs: ["update", "patch"]
```

If the platform team balks at standing `exec` in production, propose the compromise positions: exec in staging + break-glass elevation in prod (time-boxed grant via their PAM tooling), or `ephemeralcontainers` only (auditable, no shell into the app container itself). A negotiated partial yes beats a stonewalled full ask.

## When the answer is no

Platform teams say no for reasons that are usually real: multi-tenancy blast radius, compliance scope, support burden for one-off exceptions. When you hit a no:

- **Ask what the yes-able version is.** "No standing exec in prod" often has a shape that works — time-boxed grants, audit-logged sessions, a jump workload they control. Ask "what *would* you approve?" rather than re-arguing.
- **Quantify the cost of the no.** "We lost 20 minutes of INC-4821 to this gap" is an argument; "it would be convenient" is not. Keep a running list of incidents where a missing permission or quota extended the outage — three data points turn a no into a roadmap item.
- **Don't route around it.** Shadow workarounds (a pod running with a mounted over-privileged ServiceAccount someone found, a sidecar that shells out) get discovered in security reviews and burn exactly the credibility you need. If the constraint is genuinely blocking, escalate through management with your incident-cost data — that's the legitimate channel and it works more often than people expect.

## Cluster upgrade readiness — your half of their project

Platform teams run one to three cluster upgrades a year, and the app-team half of the work is real. When the "we're upgrading to 1.34" notice lands, your checklist:

**API deprecations.** Your manifests may reference API versions that the new cluster drops. Scan before they upgrade, not after your deploy fails:

```bash
# Server-side: check what you're actually running
kubectl get deploy,sts,cronjob,ingress,hpa -o yaml | grep 'apiVersion:' | sort | uniq -c

# Better: run pluto against your manifests/charts in CI
pluto detect-files -d manifests/
pluto detect-helm -n shop
```

`pluto` (FairwindsOps) flags deprecated and removed APIs against a target version; some teams also get `kubectl deprecations` output from the platform team's own scans. Fix findings in git — this is the rare drift-free change, since nothing live moves until the pipeline deploys the new apiVersion.

**PDBs on everything that matters.** Upgrades drain nodes. A drain evicts your pods, and the *only* thing pacing those evictions is your PodDisruptionBudget. No PDB = all replicas can be evicted simultaneously if they share a node. Wrong PDB (`minAvailable` equal to replica count) = the drain wedges and the platform team pages *you*. Target: every multi-replica service has a PDB allowing at least one disruption; see [High availability](/workloads/high-availability/).

**Graceful shutdown.** Drains send SIGTERM. Apps that handle it — stop accepting, finish in-flight, exit — sail through upgrades invisibly. Apps that don't turn every node roll into an error blip. Verify yours before the upgrade window, not during.

**A canary namespace.** If the platform team offers a pre-upgraded staging cluster or node pool, deploy to it early and run your smoke tests. Cheap, and it makes you their favorite tenant.

## Escalation etiquette during incidents

When you page the platform team mid-incident:

1. **Lead with the impact and the ask**, not the story. "Checkout is down, ~40% error rate since 02:10. We believe it's node-level: 3 nodes NotReady in pool `general-b`. Ask: node status check on your side." Detail after, headline first.
2. **Show your elimination work.** You've checked your pods, events, recent deploys, and it points below your namespace ([Node problems](/troubleshooting/node-problems/) covers what node trouble looks like from tenant-level access). Platform teams triage tenant pages fast when the tenant has demonstrably done their layer.
3. **One channel, one thread.** Timestamps, commands run, outputs — in the incident thread as you go. Their engineer joining at 02:40 should be able to catch up by scrolling, not by interview.
4. **Don't work around them mid-incident.** If reconciliation needs pausing (see [Drift and CI/CD](/operations/drift-and-cicd/)) or a quota needs an emergency bump, ask in the thread — a platform engineer with admin can do in 30 seconds what you'd spend 30 minutes approximating.
5. **Afterward: share the postmortem.** Even when the root cause was yours. *Especially* when it was yours — it builds the credibility your next 2 AM page spends.

## Build the relationship before you need it

The 2 AM interaction goes well in proportion to the daylight investment:

- **Shared runbooks.** Your [emergency playbooks](/operations/emergency-playbooks/) should note, per card, which steps need platform help — and the platform team should have reviewed them. Pre-negotiated: "if we ask for an Argo sync pause on `payments-prod` during a declared incident, that's a pre-approved yes."
- **Game days.** Twice a year, break staging together on purpose: kill a node, revoke a credential, fill a PVC. You learn their escalation path; they learn your architecture. Every real incident afterward is a rerun.
- **Know their roadmap.** Their upgrade calendar, their planned CNI migration, their Argo version bump — all of it lands on your workloads. Ask for a standing sync or at least their announcements channel.
- **Be the tenant with clean asks.** Every well-formed request trains them that your team's tickets are cheap to action. That reputation *is* your incident fast path.

:::note[The platform team is not the enemy of velocity]
The constraint structure — quotas, RBAC scoping, GitOps enforcement — reads as friction until the day another tenant's runaway workload *doesn't* take your service down with it. You're not working around the platform team; you're operating through an interface they keep stable. Learn the interface. This whole guide, starting with [Working without admin](/start/working-without-admin/), is written for exactly that position.
:::

## Summary

- The boundary is an API: they own everything below the namespace, you own everything in it — including the readiness work (PDBs, graceful shutdown, API versions) that only you can do.
- Requests get fast yeses when they're executable without follow-up questions: exact resource, namespace, verb, duration, evidence, rollback.
- Ask for the debugging RBAC bundle once, in daylight, as a package.
- During incidents: impact and ask first, elimination work shown, one thread, no workarounds.
- The relationship is built in daylight — shared runbooks, game days, clean asks — and spent at 2 AM.
