---
title: RBAC Denied (Forbidden)
description: Decode "Error from server (Forbidden)", test permissions with kubectl auth can-i, and write access requests platform can approve fast.
sidebar:
  order: 9
---

**Symptom:** `Error from server (Forbidden)`. Either your kubectl command bounced, or your application's in-cluster API calls are getting 403s. RBAC denials are the most *precisely documented* failures in Kubernetes — the error message contains every field you need. The skill is reading it, not guessing around it.

## Parse the error — it tells you everything

```console
Error from server (Forbidden): pods is forbidden: User "jane@example.com"
cannot list resource "pods" in API group "" in the namespace "payments"
```

Four facts, right there:

| Fragment | Fact |
|---|---|
| `User "jane@example.com"` | **Who** was denied — you, or a service account like `system:serviceaccount:payments:api-sa` |
| `cannot list` | The **verb** (get/list/watch/create/update/patch/delete) |
| `resource "pods" in API group ""` | **What** — resource plus apiGroup (`""` = core group) |
| `in the namespace "payments"` | **Where** — or "at the cluster scope" |

Every RBAC fix is making a rule exist that matches all four. Before escalating, confirm each one is what you intended — a surprising number of "RBAC bugs" are the wrong kubeconfig context or a typo'd `-n`.

## Confirm with `kubectl auth can-i`

Test permissions without side effects:

```bash
kubectl auth can-i list pods -n payments
# no
kubectl auth can-i create deployments -n payments
# yes

# The full picture — everything you can do in a namespace:
kubectl auth can-i --list -n payments
```

```console
Resources            Non-Resource URLs   Resource Names   Verbs
pods                 []                  []               [get watch]
pods/log             []                  []               [get]
deployments.apps     []                  []               [get list watch create update patch]
```

That output *is* your effective permission set — notice `pods` has `get watch` but not `list`, which explains the error above exactly. Subresources like `pods/exec` test as:

```bash
kubectl auth can-i create pods/exec -n payments
```

(Exec is a `create` on the `exec` subresource — see gotchas below.)

## Role vs ClusterRole, Binding vs ClusterRoleBinding — the 60-second model

You likely can't *grant* anything, but you need the vocabulary to read your own access and to ask for changes precisely:

- **Role** — a named bundle of rules (verbs × resources × apiGroups), scoped to one namespace.
- **ClusterRole** — same bundle, defined cluster-wide. Two uses: cluster-scoped stuff (nodes, CRDs), or a reusable rule-set granted per-namespace.
- **RoleBinding** — attaches a Role *or a ClusterRole* to subjects (users/groups/service accounts) **within one namespace**. This is how you probably have access: a RoleBinding in your namespace pointing at a shared ClusterRole like `edit`.
- **ClusterRoleBinding** — attaches a ClusterRole everywhere. Platform-only territory.

(That's the compressed version — this page is the symptom playbook; the full permission model, rule anatomy and binding resolution included, lives in [RBAC Explained](/start/rbac-explained/).)

Inspect what exists in your namespace (you can usually read these):

```bash
kubectl get rolebindings -n payments
kubectl describe rolebinding <name> -n payments   # shows Role + subjects
```

:::note[You probably can't grant yourself anything]
RBAC has no privilege escalation by design — you can't bind permissions you don't hold. If `can-i` says no, the path forward is a request to platform, not creative YAML. Skip to "Writing the access request" below.
:::

## Your kubeconfig vs your pod's service account — two different identities

The denial's *subject* tells you which problem you have:

**`User "jane@..."`** → your personal access. Wrong context (`kubectl config current-context`), expired SSO token, or you genuinely lack the grant.

**`system:serviceaccount:<ns>:<sa>`** → your **application's** identity failing an in-cluster API call. This surfaces as app errors (client-go/fabric8/kubernetes-client 403s), operators that won't reconcile, or CI deploy steps failing. Diagnose it *as* that identity:

```bash
# Which SA does the pod run as?
kubectl get pod <pod> -o jsonpath='{.spec.serviceAccountName}'

# Test as the SA without touching the pod:
kubectl auth can-i list configmaps -n payments \
  --as=system:serviceaccount:payments:api-sa
```

Common app-side traps: the pod uses `default` SA (nearly zero permissions) because nobody set `serviceAccountName`; the SA exists but no RoleBinding names it; or the binding lives in a different namespace than the pod. The app needing its own Role + RoleBinding (which you *may* be allowed to create within your namespace — check `can-i create roles`) versus needing a platform grant depends on your cluster's policy. How this identity works end to end — tokens, `serviceAccountName`, and giving an app exactly the permissions it needs — is covered in [ServiceAccounts](/workloads/serviceaccounts/).

## Common gotchas

### Right verb, wrong apiGroup

```console
Error from server (Forbidden): deployments.apps is forbidden: ... cannot list
resource "deployments" in API group "apps" ...
```

A rule granting `deployments` in apiGroup `""` grants nothing useful — Deployments live in `apps`. Same trap: Ingress in `networking.k8s.io`, CronJobs in `batch`, CRDs in their own groups. When reporting or requesting, always name resource *and* group. Find a resource's group with:

```bash
kubectl api-resources | grep -i deploy
```

### Subresources: exec denied while get works

`kubectl get pods` succeeds; `kubectl exec` returns Forbidden. Not a contradiction — `pods/exec`, `pods/log`, `pods/portforward`, and `pods/attach` are **separate subresources** with separate rules:

```console
Error from server (Forbidden): pods "api-7d4b9c6f8-2xkqp" is forbidden:
User "jane@example.com" cannot create resource "pods/exec" in API group ""
in the namespace "payments"
```

Note it's `create` on `pods/exec` (exec opens a session = create), and `get` on `pods/log`. Clusters commonly hand out read-only roles that include logs but deliberately exclude exec and port-forward. If your debugging workflow needs them ([Debugging Toolbox](/troubleshooting/debugging-toolbox/)), that's an explicit request. Ephemeral containers gate on yet another subresource: `pods/ephemeralcontainers` (verb `patch` or `update`).

### Namespace mismatch

You have full edit in `payments` and run the command in `payments-staging` — or your kubectl context pins a default namespace you forgot about. Two-second check:

```bash
kubectl config view --minify -o jsonpath='{..namespace}'; echo
```

Also remember RoleBindings don't inherit: access to a namespace says nothing about its lookalike siblings.

### The verb ladder

`get` ≠ `list` ≠ `watch`. Tools need surprising combinations: `kubectl get pods` (plural) needs `list`; `kubectl get pod x` needs `get`; anything with `-w` needs `watch`; `kubectl apply` needs `get` + `patch` (+ `create` for new objects). If a tool half-works, it's usually missing one rung.

## Writing the access request platform will approve fast

Vague: "I need more access to the payments namespace." That gets a meeting invite, not a grant.

Precise — copy this shape:

```text
Subject: RBAC request: pods/exec in payments (prod)

Who:       jane@example.com  (and group payments-devs, if group-managed)
What:      create pods/exec, create pods/portforward  (API group "")
Where:     namespace payments, prod cluster only
Why:       on-call debugging of JVM services; need jcmd via exec per our
           runbook (troubleshooting/debugging-toolbox)
Evidence:  kubectl auth can-i create pods/exec -n payments  → no
           Error: cannot create resource "pods/exec" in API group ""
Duration:  standing for on-call rotation members
```

Verb + resource + apiGroup + namespace + justification — the exact fields a Role rule needs, so the reviewer can approve without a round-trip. More on the relationship in [Working with the Platform Team](/operations/working-with-platform-team/).

## Decision path

1. Read the error: who / verb / resource+group / namespace.
2. Right context and namespace? (`kubectl config current-context`)
3. `kubectl auth can-i <verb> <resource> -n <ns>` — confirm the denial is real.
4. User or service account? SA → check `serviceAccountName`, test with `--as=`.
5. Half-working tool → suspect apiGroup, subresource, or missing verb.
6. Genuine gap → precise access request; don't try to self-grant.
