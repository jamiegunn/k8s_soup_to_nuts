---
title: CRDs Explained
description: How CustomResourceDefinitions extend the Kubernetes API, how to discover and read the CRDs installed in your cluster, and what to ask the platform team for.
keywords:
  - customresourcedefinition
  - no matches for kind in version
  - kubectl get crds
  - kubectl api-resources
  - kubectl explain custom resource
  - conversion webhook failed
  - cannot list resource forbidden
  - deleting crd deletes custom resources
  - customresourcedefinitions is forbidden at cluster scope
  - served vs storage version
sidebar:
  order: 3
---

Kubernetes ships with a few dozen built-in types — Pods, Services, Deployments. Everything else you'll meet in a real cluster (MetalLB pools, cert-manager Certificates, Postgres clusters, F5 VirtualServers) exists because someone installed a **CustomResourceDefinition**. A CRD teaches the API server a new type. Once installed, the new type behaves like any built-in: `kubectl get/apply/describe/watch` all work, RBAC applies, and controllers can watch it.

That's the whole trick. A CRD adds a *noun* to the API. It does nothing by itself — no behavior, no validation beyond schema, no magic. Behavior comes from a controller watching that noun (see [Operators](/controllers/operators/)). But understanding the noun side is what lets you read any cluster you're dropped into.

## Anatomy of a CRD

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: virtualservers.cis.f5.com   # must be <plural>.<group>
spec:
  group: cis.f5.com                 # the API group — shows up in apiVersion
  names:
    kind: VirtualServer             # what you write in your YAML
    plural: virtualservers          # what kubectl uses in URLs
    shortNames: ["vs"]              # kubectl get vs
    categories: ["all"]             # include in `kubectl get all`? (rarely)
  scope: Namespaced                 # or Cluster
  versions:
    - name: v1
      served: true                  # API server accepts requests at this version
      storage: true                 # this version is what etcd stores
      schema:
        openAPIV3Schema: { ... }    # validation: required fields, types, enums
      subresources:
        status: {}                  # status is a separate subresource
      additionalPrinterColumns:     # what `kubectl get` displays
        - name: Host
          type: string
          jsonPath: .spec.host
```

The parts that matter to you as a consumer:

- **group/version/kind (GVK)** — together they form the `apiVersion` + `kind` you write: `apiVersion: cis.f5.com/v1`, `kind: VirtualServer`. Get the group or version wrong and you'll see `no matches for kind "VirtualServer" in version "cis.f5.com/v2"` — check what's actually served (below).
- **scope** — `Namespaced` CRs live in your namespace and you can usually create them. `Cluster`-scoped CRs (IPAddressPools, StorageClasses-alikes, policy configs) are typically platform-only, though you can often still *read* them, which is gold for debugging.
- **schema** — the API server validates your CR against it at admission time. A rejected CR with a field-level error message is the schema doing its job, not a controller opinion.
- **served/storage versions** — a CRD can serve multiple versions (`v1beta1` and `v1`) while storing one. During operator upgrades, versions get deprecated and unserved; that's when pipelines that hardcode old apiVersions start failing.

## Discovering what's installed

You're dropped into a cluster. First moves:

```console
$ kubectl get crds
NAME                                       CREATED AT
ipaddresspools.metallb.io                  2025-11-02T09:14:22Z
l2advertisements.metallb.io                2025-11-02T09:14:22Z
virtualservers.cis.f5.com                  2025-12-10T14:03:51Z
volumesnapshots.snapshot.storage.k8s.io    2025-10-19T08:41:07Z
...
```

Reading CRD names (usually allowed even for namespace-scoped users) tells you what extensions exist. `kubectl api-resources` gives the practical view — names, short names, scope, and whether they're namespaced:

```console
$ kubectl api-resources --api-group=metallb.io
NAME               SHORTNAMES   APIVERSION           NAMESPACED   KIND
bgppeers                        metallb.io/v1beta2   true         BGPPeer
ipaddresspools                  metallb.io/v1beta1   true         IPAddressPool
l2advertisements                metallb.io/v1beta1   true         L2Advertisement
```

And the underrated one — `kubectl explain` works on custom resources exactly like built-ins, because the schema is served through the same discovery machinery:

```console
$ kubectl explain virtualserver.spec --recursive | head -20
GROUP:      cis.f5.com
KIND:       VirtualServer
VERSION:    v1

FIELD: spec <Object>
  host  <string>
  pools <[]Object>
    path    <string>
    service <string>
    servicePort   <Object>
...
```

:::tip[explain beats docs]
Vendor docs describe the version the vendor wants you on. `kubectl explain <kind> --recursive` describes the version *your cluster actually runs*. When a field from a blog post "doesn't work," this is the two-second check.
:::

## Status subresource, printer columns, categories

Three quality-of-life features you'll interact with constantly:

- **Status subresource.** When enabled (almost always), `spec` and `status` update through separate API calls. You can't accidentally overwrite the controller's status with `kubectl apply`, and the controller can't touch your spec. It also enables `observedGeneration` tracking — your key tool for "has the controller seen my change?" (see [Reconciliation](/controllers/reconciliation/)).
- **Printer columns.** Whatever `kubectl get <kind>` shows beyond NAME and AGE is the CRD author's choice of jsonPaths. `kubectl get <kind> -o wide` often reveals more. When the columns are unhelpful, go straight to `-o yaml` and read `status` yourself.
- **Categories.** A CRD can join named groups; `kubectl get all` only shows CRs whose CRD opted into the `all` category — which is why **`kubectl get all` silently omits most custom resources**. Never trust `get all` to prove a namespace is empty.

## Versions and conversion

When an operator upgrades, its CRDs often move `v1beta1 → v1`. The API server can serve both simultaneously and convert between them — either by simple no-op conversion or via a **conversion webhook** the operator provides. Two consumer-side effects:

1. Your manifests keep working during the transition, but deprecation warnings appear in kubectl output. Fix your YAML before the old version stops being served.
2. If the conversion webhook is down (operator pod dead), *reads of existing CRs at the converted version fail* — you'll see `conversion webhook ... failed` on plain `kubectl get`. That's a platform escalation, not a you-problem, but now you'll recognize it.

## RBAC treats every CRD as a brand-new resource

A subtle follow-on that catches teams after every operator install: your existing Role grants say nothing about the new types. RBAC rules name API groups and resources explicitly, so `get/list on pods, services, deployments` gives you zero access to `virtualservers.cis.f5.com`. The symptom is a fresh CRD you can see in `api-resources` but can't touch:

```console
$ kubectl get virtualservers
Error from server (Forbidden): virtualservers.cis.f5.com is forbidden:
User "you" cannot list resource "virtualservers" in API group "cis.f5.com"
in the namespace "team-a"
```

Quick self-checks before filing anything:

```console
$ kubectl auth can-i create virtualservers.cis.f5.com -n team-a
no
$ kubectl auth can-i --list -n team-a | grep cis.f5.com
```

So every CRD-installation request should include the RBAC line for your team in the same breath — otherwise you get the API type without the keys to it, and that's a second ticket and a second wait. (Full decoding of Forbidden errors: [RBAC Denied](/troubleshooting/rbac-denied/).)

## When a CRD is removed: the cascading delete

Here's the part that deserves a moment of genuine fear. CRs are *owned* by their CRD in the deepest sense: delete the CRD, and **every custom resource of that type, in every namespace, is deleted with it**. Not orphaned — deleted, with finalizers running, controllers deprovisioning whatever those CRs represented.

:::danger[Uninstalling an operator can delete your data's definition]
`helm uninstall` of an operator chart that includes CRDs (Helm normally leaves `crds/` in place, but not every chart follows the convention, and `kubectl delete -f the-whole-manifest.yaml` certainly doesn't) removes the CRDs → removes every CR → for a database operator, that can mean deprovisioning every database cluster it managed. This is a top-tier platform-team incident pattern. If you ever hear "we're removing operator X," ask loudly what happens to existing CRs *before* it happens, and take backups (see [Backup and DR](/stateful/backup-and-dr/)).
:::

The flip side: this is why platform teams are (rightly) conservative about CRD lifecycle, and why "just upgrade the operator" requests sometimes take longer than you'd like.

## You can't install CRDs — here's the request to make

Creating a CRD is a cluster-scoped write (`customresourcedefinitions.apiextensions.k8s.io`). Your namespaced RBAC won't allow it, and it shouldn't: a CRD is a cluster-wide API change affecting every tenant. So when a Helm chart you want to use fails like this:

```console
Error: INSTALLATION FAILED: customresourcedefinitions.apiextensions.k8s.io
is forbidden: User "you" cannot create resource "customresourcedefinitions"
at the cluster scope
```

...that's your cue to file a platform request, not to escalate your own permissions. A request that gets approved quickly looks like:

> We'd like to use **cert-manager** (or: the `external-secrets` operator, etc.).
> - **CRDs needed:** `certificates.cert-manager.io`, `issuers.cert-manager.io` (chart version X.Y, CRDs from the official chart)
> - **Controller:** runs cluster-scoped or per-namespace — whichever fits your model; we only need it reconciling namespace `team-payments`
> - **RBAC we need:** create/get/list/watch on the namespaced kinds in our namespace
> - **Why:** replacing hand-rotated TLS secrets; reduces our cert-expiry incidents
> - **Blast radius notes:** no webhooks / includes a validating webhook scoped by namespaceSelector (flag this — see [Admission Webhooks](/controllers/admission-webhooks/))

Naming the exact CRDs, the chart version, and the RBAC you need turns a week of back-and-forth into a single review. More on the general art of these requests in [Working with the Platform Team](/operations/working-with-platform-team/).

Once the CRD exists and an operator watches it, your day-to-day interface is the CR itself — which is the subject of [Operators](/controllers/operators/).
