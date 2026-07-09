---
title: RBAC Explained
description: The complete mental model for Kubernetes RBAC — Roles, bindings, verbs, subjects, defaults, and how to design least-privilege access for your team.
keywords:
  - Forbidden error kubernetes
  - Role RoleBinding ClusterRole ClusterRoleBinding
  - kubectl auth can-i list
  - pods/exec pods/log subresources
  - view edit admin default clusterroles
  - serviceaccount permissions
  - apiGroups empty string core group
  - least-privilege role design
  - how do I get access to a resource
  - who can read secrets in my namespace
  - aggregation rule aggregate-to-edit
sidebar:
  order: 8
---

Every `Forbidden` error you'll ever see, every permission your CI pipeline has, every thing your dashboard can and can't show — it all reduces to one question: **does a rule exist that matches this exact (subject, verb, resource, namespace) tuple?** RBAC is a pile of allow-rules and nothing else. Once you internalize that, permissions stop being mysterious and start being greppable.

This is the conceptual article. If you're staring at a `Forbidden` error right now, go to [the RBAC denied playbook](/troubleshooting/rbac-denied/); if you're wiring up identity for a pod, see [ServiceAccounts](/workloads/serviceaccounts/).

## Where RBAC sits in the request pipeline

Every request to the API server — from your kubectl, from CI, from a pod — passes through three gates in order:

```text
request → 1. Authentication  (who are you?)
        → 2. Authorization   (are you allowed to do this?)   ← RBAC lives here
        → 3. Admission       (is this request acceptable?)
        → persisted to etcd
```

**Authentication** establishes identity. Two things trip people up here:

- **Users are not Kubernetes objects.** There is no `kubectl get users`. Your identity comes from whatever the cluster's authenticator says — an OIDC token from your company IdP, a client certificate, a cloud IAM mapping. The API server just trusts the string it's handed.
- **Groups come from the authenticator too.** If your IdP token says you're in `payments-devs`, RBAC can bind to that group — but Kubernetes can't create, list, or modify groups. Group membership is entirely the IdP/platform team's domain.

**Authorization** asks whether that identity may perform this verb on this resource. RBAC is the usual authorizer, but not the only one — clusters typically chain several (`Node` authorizer for kubelets, sometimes a `webhook` authorizer calling out to an external policy service). If *any* authorizer allows the request, it proceeds.

**Admission** runs after authorization and can mutate or reject requests that were otherwise allowed (quotas, Pod Security, OPA/Kyverno policies).

:::caution[RBAC is allow-only]
There are no deny rules in RBAC. You cannot write "everything except Secrets." The only way to exclude something is to never grant it. When platform teams need actual deny semantics ("nobody touches Secrets in prod, even admins"), that's a policy engine at the admission layer — not RBAC. This shapes everything about how you design roles.
:::

## The four objects

Two objects define *what* is allowed (rules), two define *who* gets them (bindings).

```yaml
# Role: namespaced rules. Only ever grants things inside its own namespace.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  namespace: payments
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
```

```yaml
# ClusterRole: rules with no namespace. Can cover cluster-scoped resources
# (nodes, namespaces, CRDs) and nonResourceURLs — or just be a reusable
# rule set that gets bound per-namespace.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: deployment-manager
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "deployments/scale"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
```

```yaml
# RoleBinding: grants a Role OR a ClusterRole to subjects,
# scoped to the binding's namespace.
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: jane-reads-pods
  namespace: payments
subjects:
  - kind: User
    name: jane@example.com
    apiGroup: rbac.authorization.k8s.io
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: pod-reader
```

```yaml
# ClusterRoleBinding: grants a ClusterRole everywhere. Platform-team territory
# almost by definition — you will rarely, if ever, request one of these.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: sre-view-everything
subjects:
  - kind: Group
    name: sre-team
    apiGroup: rbac.authorization.k8s.io
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: view
```

Note that `roleRef` is **immutable** — to change what a binding points at, you delete and recreate it. That's deliberate escalation protection.

### The three combinations that matter

| Combination | Effective scope | When you'll see it |
|---|---|---|
| Role + RoleBinding | One namespace | Team-specific, one-off grants |
| **ClusterRole + RoleBinding** | **The binding's namespace only** | Reusable rule sets granted per-namespace — how `view`/`edit`/`admin` are actually handed out |
| ClusterRole + ClusterRoleBinding | Entire cluster | Platform-team stuff: operators, SRE, kubelets |

That middle row is the underrated one. A ClusterRole is just a named, namespace-less bundle of rules; binding it with a *RoleBinding* confines it to that namespace. Platform teams love this pattern because they maintain one `team-developer` ClusterRole and stamp out a RoleBinding per team namespace — one definition, no drift. When you propose roles (later in this article), propose them in this shape.

## Rule anatomy, precisely

```yaml
rules:
  - apiGroups: ["apps"]                 # which API group
    resources: ["deployments"]          # which resource type(s)
    verbs: ["get", "list", "watch"]     # which actions
    resourceNames: ["api-server"]       # optional: only these named objects
```

**`apiGroups`** — the eternal gotcha: the core group (pods, services, configmaps, secrets, serviceaccounts) is the *empty string* `""`, not `"core"` or `"v1"`. Deployments live in `"apps"`, ingresses in `"networking.k8s.io"`, jobs in `"batch"`. Find any resource's group with `kubectl api-resources | grep <name>`. A rule with `apiGroups: ["apps"]` grants nothing on pods, and this mismatch is the single most common reason a "correct-looking" Role doesn't work.

**`verbs`** — what each really permits:

| Verb | What it actually allows |
|---|---|
| `get` | Fetch one object by name |
| `list` | Fetch collections — **includes full object bodies**, not just names |
| `watch` | Open a stream of changes. `list` without `watch` breaks controllers and `kubectl get -w`; they usually travel together |
| `create` | Make new objects (name of your choosing) |
| `update` | Replace a whole object (`kubectl apply` on existing objects needs this or patch) |
| `patch` | Partial modification — what `kubectl apply`, `edit`, `scale`, `label` mostly use |
| `delete` | Remove one object by name |
| `deletecollection` | Remove everything matching a selector in one call — far more destructive than `delete`; grant separately, reluctantly |

**`resourceNames`** restricts a rule to specific object names — useful for "may update this one ConfigMap." Two hard limits: it **cannot restrict `create`** (the object doesn't exist yet, so a create request carries no name to check — and the API *accepts* the combination without complaint, so the rule just silently never matches; worse than a rejection, because the Role looks scoped while granting nothing for `create`), and **`list`/`watch`/`deletecollection` don't honor it** (collection requests aren't name-scoped, so a rule granting `list` with `resourceNames` grants nothing usable for `list`). `resourceNames` works cleanly with `get`, `update`, `patch`, `delete`.

**Subresources** are separate grant targets, written `resource/subresource`:

```yaml
  - apiGroups: [""]
    resources: ["pods/log", "pods/exec", "pods/portforward"]
    verbs: ["get", "create"]   # logs are get; exec/portforward/attach are create
```

Being able to read a pod tells you nothing about whether you can exec into it. That split is intentional: `pods/exec` is effectively arbitrary code execution as the pod's ServiceAccount, with access to every mounted [Secret](/workloads/secrets/). Same idea for `deployments/scale` (grant scaling without full deployment write) and CRD `status` subresources. `pods/exec` and `pods/portforward` use verb `create` (they open a session), `pods/log` uses `get`.

**`nonResourceURLs`** cover raw API paths like `/healthz`, `/metrics`, `/api` — no resource objects involved, so they only make sense in ClusterRoles and can only be granted via ClusterRoleBinding.

## Subjects: who bindings point at

```yaml
subjects:
  - kind: User                          # a string from the authenticator; not an object
    name: jane@example.com
    apiGroup: rbac.authorization.k8s.io
  - kind: Group                         # also a string from the authenticator
    name: payments-devs
    apiGroup: rbac.authorization.k8s.io
  - kind: ServiceAccount                # the only subject that IS a k8s object
    name: ci-deployer
    namespace: payments                 # required — and NO apiGroup field
```

ServiceAccount subjects take a `namespace` and **omit `apiGroup`** (it's the core group). Get that wrong and the binding silently matches nothing. In RBAC error messages and audit logs, a ServiceAccount appears as the user string `system:serviceaccount:payments:ci-deployer` — and belongs to synthetic groups worth knowing:

- `system:authenticated` — every authenticated identity in the cluster. A binding to this is a grant to *everyone*; treat it with suspicion when auditing.
- `system:serviceaccounts` — all ServiceAccounts, cluster-wide.
- `system:serviceaccounts:<namespace>` — all ServiceAccounts in one namespace. Convenient, and exactly one compromised pod away from being too broad.

## The default ClusterRoles you'll actually be granted

Every cluster ships `view`, `edit`, `admin`, and `cluster-admin`. You'll almost always receive one of the first three via RoleBinding into your namespace. Know what they really contain:

| ClusterRole | Includes | Notably excludes |
|---|---|---|
| `view` | Read most namespaced objects | **Secrets** (read access to Secrets ≈ every credential in the namespace), Roles/RoleBindings |
| `edit` | `view` + create/update/delete workloads, ConfigMaps, PVCs — **and read/write Secrets** | Roles/RoleBindings (can't grant permissions) |
| `admin` | `edit` + manage Roles/RoleBindings in the namespace | ResourceQuota, LimitRange, the Namespace object itself — the guardrails stay platform-owned |
| `cluster-admin` | Everything, everywhere (`*`/`*`/`*` + all nonResourceURLs) | Nothing. You will not get this. |

Two of these surprise people: `view` **excluding** Secrets (your read-only dashboard identity can't leak credentials — good) and `edit` **including** them (anyone who can deploy can read every Secret in the namespace — plan accordingly).

### Aggregation: how these roles grow

`edit` and friends aren't static files; they're built by **aggregation**:

```yaml
aggregationRule:
  clusterRoleSelectors:
    - matchLabels:
        rbac.authorization.k8s.io/aggregate-to-edit: "true"
```

Any ClusterRole carrying that label gets its rules merged into `edit` automatically. This is how well-behaved operators extend the defaults: install cert-manager and a labeled ClusterRole quietly teaches `edit` about Certificates. It's why your `edit` grant sometimes covers a CRD you never asked about — and why it sometimes doesn't, if the operator didn't ship aggregation labels. More in [CRDs explained](/controllers/crds-explained/).

## Auditing what you actually have

Start every investigation with `kubectl auth can-i` — it asks the real authorizer, so it accounts for group memberships you can't see:

```bash
kubectl auth can-i --list -n payments
```

```console
Resources                    Non-Resource URLs   Resource Names   Verbs
pods                         []                  []               [get list watch]
pods/log                     []                  []               [get]
deployments.apps             []                  []               [get list watch create update patch]
selfsubjectaccessreviews.*   []                  []               [create]
```

Point checks and impersonation (impersonation itself requires the `impersonate` verb — you may only be able to test as yourself):

```bash
kubectl auth can-i create deployments -n payments          # yes/no
kubectl auth can-i get secrets -n payments                 # the honest question
kubectl auth can-i delete pods -A                          # cluster-wide check
kubectl auth can-i list pods -n payments --as system:serviceaccount:payments:ci-deployer
kubectl auth can-i get nodes --as jane@example.com --as-group payments-devs
```

Then trace a permission to its source. You can read RBAC objects in your own namespace if you hold `admin` (not `view`/`edit`):

```bash
kubectl get role,rolebinding -n payments -o wide
```

```console
NAME                                  CREATED AT
role.rbac.../pod-reader               2026-05-11T09:14:22Z

NAME                              ROLE                        AGE   USERS               GROUPS          SERVICEACCOUNTS
rolebinding.../jane-reads-pods    Role/pod-reader             52d   jane@example.com
rolebinding.../devs-edit          ClusterRole/edit            120d                      payments-devs
rolebinding.../ci-deploy          ClusterRole/team-deployer   88d                                       payments/ci-deployer
```

`-o wide` shows subjects and roleRef in one line — that table *is* the access map for your namespace. To answer "why can I do X": find the binding naming you (or your group), then `kubectl describe role/clusterrole <roleRef>` for the rules. Note the referenced ClusterRoles may not be readable by you; `auth can-i --list` remains your ground truth. For bigger audits, the kubectl plugins `access-matrix` and `rbac-tool` (via krew) render verb-by-resource grids and reverse lookups ("who can read secrets in payments?") — worth having, but everything above is doable with stock kubectl.

## Designing roles for your team

You can't create Roles yourself unless you hold `admin` — but arriving at the platform team with complete, least-privilege YAML gets approved in hours instead of weeks (see [working without admin](/start/working-without-admin/)). A starter set that has survived real production use, in the ClusterRole + RoleBinding shape platform teams prefer:

```yaml
# 1. CI deployer: may apply exactly the kinds your manifests contain. Nothing else.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: team-deployer
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: [""]
    resources: ["services", "configmaps"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: [""]                      # rollout visibility only
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
---
# 2. Developer: read everything visible, debug interactively, no writes.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: team-developer
rules:
  - apiGroups: ["", "apps", "batch", "networking.k8s.io"]
    resources: ["pods", "services", "configmaps", "endpoints", "events",
                "deployments", "replicasets", "jobs", "cronjobs", "ingresses"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["pods/exec", "pods/portforward"]
    verbs: ["create"]
---
# 3. Read-only for dashboards/on-call: no Secrets, no exec.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: team-readonly
rules:
  - apiGroups: ["", "apps", "batch"]
    resources: ["pods", "pods/log", "services", "events",
                "deployments", "replicasets", "jobs", "cronjobs"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ci-deployer
  namespace: payments
subjects:
  - kind: ServiceAccount
    name: ci-deployer
    namespace: payments
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: team-deployer
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: devs
  namespace: payments
subjects:
  - kind: Group
    name: payments-devs
    apiGroup: rbac.authorization.k8s.io
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: team-developer
```

Honest trade-offs baked in:

- **The deployer has no Secrets access.** If your pipeline templates Secrets, it needs `create`/`patch` on them — but then a compromised pipeline reads every credential in the namespace (`get` and `list` on secrets are the dangerous verbs; you can grant write verbs without read, which is often the right call for a pipeline that only pushes). Better: external-secrets or sealed-secrets so CI never touches raw Secret objects.
- **The developer role has `exec` but no writes.** Exec is already powerful — inside a pod you can read mounted Secrets regardless of RBAC. Most teams accept that in dev/staging and drop `pods/exec` from the prod variant. Decide explicitly; don't inherit it by accident.
- **No `delete` anywhere.** `kubectl apply` doesn't need it. Add `delete` on specific resources only when your pipeline genuinely prunes.

:::danger[Wildcards in a namespaced Role still bite]
`resources: ["*"], verbs: ["*"]` scoped to one namespace feels contained. It isn't: it includes Secrets (every credential you'll ever mount), `pods/exec` on everything, `deletecollection`, and — because wildcards match resources that don't exist yet — every CRD any future operator installs into that group. Enumerate resources. It's ten more lines of YAML and it's the difference between "auditable" and "hope."
:::

**Escalation prevention**, briefly: even with permission to create Roles and RoleBindings, Kubernetes blocks you from granting permissions you don't hold yourself — you can't write yourself a secrets-reader Role if you can't read secrets. The escape hatches are two special verbs: `escalate` (may create/update Roles exceeding your own access) and `bind` (may create bindings to roles exceeding your access). If a request you're drafting needs either, expect real scrutiny.

## CRDs: new resources start at zero

Installing a CRD grants nobody anything. `kubectl get certificates` returns `Forbidden` for your whole team until rules exist for the new apiGroup:

```yaml
  - apiGroups: ["cert-manager.io"]
    resources: ["certificates"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
```

Well-packaged operators ship aggregation-labeled ClusterRoles so `edit`/`view` pick the CRD up automatically; plenty don't, and then per-CRD grants like the above are on you to request. Also note the status split: if the CRD enables the `status` subresource, writing `.status` requires a separate rule for `certificates/status` — which is why *your* identity usually gets the spec-side verbs and the operator's ServiceAccount gets status. Details in [CRDs explained](/controllers/crds-explained/).

## The request template

RBAC changes are platform-team territory. This format gets approved fast because it's copy-pasteable into a rule and auditable later:

```text
Subject:     Group "payments-devs"            (or system:serviceaccount:payments:ci-deployer)
Namespace:   payments
apiGroup:    "" (core)
Resource:    pods/portforward
Verbs:       create
Duration:    permanent  (or "until 2026-08-01, remove after incident review")
Why:         Debugging staging DB connectivity requires port-forward to pods;
             team currently has get/list/watch on pods only.
Evidence:    $ kubectl auth can-i create pods/portforward -n payments
             no
             Error from server (Forbidden): ... cannot create resource
             "pods/portforward" in API group "" in the namespace "payments"
```

Attach the exact `Forbidden` message and the failing `auth can-i` — the error contains every field of the tuple, so nobody has to reverse-engineer your intent. More on decoding those errors in [RBAC denied](/troubleshooting/rbac-denied/), and on making requests land well in [working with the platform team](/operations/working-with-platform-team/).

The model, one last time: identity from the authenticator, allow-rules matched against (verb, apiGroup, resource, namespace), bindings connecting the two, and no deny anywhere. Everything else in this site's access questions is a special case of that sentence.
