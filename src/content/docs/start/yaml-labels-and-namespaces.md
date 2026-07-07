---
title: YAML, Labels, and Namespaces
description: Manifest anatomy, labels vs annotations, how selectors wire Deployments to Pods to Services, namespace mechanics, and the YAML footguns that cause real outages.
keywords:
  - selector does not match template labels
  - service selector matches nothing zero endpoints
  - app.kubernetes.io standard labels
  - yaml indentation footgun
  - the norway problem yaml booleans
  - CreateContainerConfigError cross-namespace reference
  - quote configmap values as strings
  - labels vs annotations difference
  - immutable deployment selector
  - dry-run and diff before apply
  - namespace dns fqdn svc.cluster.local
sidebar:
  order: 6
---

Every Kubernetes outage caused by a missing probe or a bad limit gets a postmortem. The ones caused by two spaces of indentation or an unquoted `"yes"` mostly get quietly fixed and never spoken of again. This article is the never-spoken-of part: manifest anatomy, the label/selector wiring that holds your whole app together, and the YAML traps everyone hits exactly once.

## Anatomy of a manifest

Every Kubernetes object has the same four top-level parts:

```yaml
apiVersion: apps/v1        # API group/version this kind lives in
kind: Deployment           # what type of object
metadata:                  # identity: name, namespace, labels, annotations
  name: checkout
  namespace: payments
  labels:
    app.kubernetes.io/name: checkout
spec:                      # desired state — the part you design
  replicas: 3
  ...
```

- **`apiVersion` + `kind`** identify the type. `apps/v1` for Deployments/StatefulSets, plain `v1` for core objects (Pod, Service, ConfigMap, Secret), `batch/v1` for Jobs, `networking.k8s.io/v1` for Ingress and NetworkPolicy. Wrong pairing → immediate rejection: `no matches for kind "Deployment" in version "v1"`. When unsure: `kubectl api-resources | grep -i deploy`.
- **`metadata`** is who the object *is*. Names must be DNS-safe (lowercase alphanumerics and `-`, max 253 chars).
- **`spec`** is what you *want*. The server adds a **`status`** section — what actually *is* — which you read with `kubectl get -o yaml` but never write.

Use `kubectl explain deployment.spec --recursive | less` to browse any spec's fields offline.

## Labels vs annotations

Both are key/value string maps in `metadata`. They are not interchangeable:

| | Labels | Annotations |
|---|---|---|
| Purpose | **Selection and grouping** | Attached metadata, config for tools |
| Queryable? | Yes — selectors, `kubectl -l` | No |
| Size/charset | Strict, short (63-char values) | Loose, can hold big blobs |
| Typical uses | app name, component, environment | ingress behavior, checksums, change-cause, owner contact, Prometheus hints |

Rule of thumb: if anything will ever need to *find* objects by it, it's a label. If it's information *about* the object read by humans or a specific tool, it's an annotation. Don't bloat labels — every distinct label set is an index the API server maintains, and selectors match on **exact equality**, so free-text belongs in annotations.

## Selectors: the wiring of your entire app

Nothing in Kubernetes links objects by name. A Deployment doesn't "contain" its Pods, and a Service doesn't "point at" a Deployment. Everything is matched *loosely, at runtime, by labels*:

```text
Deployment ──(spec.selector.matchLabels)──►  Pods (from template.metadata.labels)
Service    ──(spec.selector)──────────────►  Pods (same labels)  ──► EndpointSlices
```

One complete, correctly wired example:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout
  namespace: payments
spec:
  replicas: 3
  selector:
    matchLabels:                      # (1) how the Deployment finds its Pods
      app.kubernetes.io/name: checkout
  template:
    metadata:
      labels:                         # (2) MUST include everything in (1)
        app.kubernetes.io/name: checkout
        app.kubernetes.io/version: "2.4.1"
    spec:
      containers:
        - name: app
          image: registry.example.com/payments/checkout:2.4.1
          ports:
            - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: checkout
  namespace: payments
spec:
  selector:                           # (3) how the Service finds backend Pods
    app.kubernetes.io/name: checkout  #     must match (2)
  ports:
    - port: 80
      targetPort: 8080
```

Three failure modes, all label-related:

1. **Selector ⊄ template labels** → the API server rejects the Deployment (`selector does not match template labels`). Annoying but honest.
2. **Service selector matches nothing** (typo, or labels renamed in a refactor) → *silently* zero endpoints. No error anywhere. The app deploys green and takes no traffic. Check: `kubectl get endpointslices -l kubernetes.io/service-name=checkout`.
3. **Service selector matches too much** — a loose selector like `app: api` catching pods from two different Deployments → intermittent wrong-backend weirdness that's miserable to spot. Keep selectors specific.

Also: a Deployment's `spec.selector` is **immutable**. Change it and you must delete and recreate the Deployment. Pick labels you can live with — and note that `app.kubernetes.io/version` belongs in the pod template labels but *not* in the selector, or every release would orphan the old pods. Details on how this plays into rollouts in [Deployments Deep Dive](/workloads/deployments-deep-dive/), and endpoints in [Services Deep Dive](/networking/services-deep-dive/).

## Recommended labels: use the standard set

Kubernetes defines [well-known labels](https://kubernetes.io/docs/concepts/overview/working-with-objects/common-labels/) under `app.kubernetes.io/`. Use them instead of inventing your own — dashboards, cost tools, and your platform team's tooling already understand them:

```yaml
metadata:
  labels:
    app.kubernetes.io/name: checkout          # the app
    app.kubernetes.io/instance: checkout-prod # this deployment of it
    app.kubernetes.io/version: "2.4.1"        # quoted! see footguns
    app.kubernetes.io/component: api          # api | worker | cache ...
    app.kubernetes.io/part-of: payments       # the umbrella system
    app.kubernetes.io/managed-by: helm        # or kustomize, argocd ...
```

Minimum viable set: `name`, `instance`, `component`. Put them on *every* object your app ships — Deployment, Service, ConfigMap, all of it — so `kubectl get all -l app.kubernetes.io/instance=checkout-prod` shows your whole footprint in one command.

## Namespaces

A namespace is a named scope: names must be unique only within it, RBAC and ResourceQuota attach to it, and DNS is organized around it. Your Service `checkout` in namespace `payments` is reachable as:

```text
checkout                                # from inside payments
checkout.payments                       # from other namespaces
checkout.payments.svc.cluster.local     # fully qualified
```

(Cross-namespace *visibility* via DNS doesn't guarantee *reachability* — NetworkPolicies may say otherwise. See [DNS](/networking/dns/) and [Network Policies](/networking/network-policies/).)

:::caution[Always pin the namespace — in the manifest, not the command line]
A manifest without `metadata.namespace` goes wherever the current kubectl context points. That's how staging manifests land in prod namespaces. Put `namespace:` explicitly in everything you commit, and let your pipeline enforce it. ConfigMaps and Secrets can only be referenced by pods **in the same namespace** — a cross-namespace reference fails at container start with `CreateContainerConfigError`.
:::

You can't create namespaces yourself in most setups (they're cluster-scoped) — that's a platform team request, per [Working Without Admin](/start/working-without-admin/).

## YAML footguns

**Indentation.** YAML nesting is spaces-only (tabs are a syntax error), and one level is conventionally two spaces. The killer isn't invalid YAML — it's *valid YAML with the wrong shape*:

```yaml
# WRONG: resources is a sibling of the container list item,
# so it's silently ignored as an unknown pod-spec-level field... 
      containers:
        - name: app
          image: checkout:2.4.1
        resources:              # <- mis-indented
          limits:
            memory: 512Mi
```

Defense: `kubectl apply --dry-run=server -f file.yaml` catches unknown fields; `kubectl diff` shows you the real shape before it ships.

**The Norway problem and friends.** YAML 1.1 (which Kubernetes tooling largely follows) auto-types unquoted scalars: `yes`/`no`/`on`/`off`/`true`/`false` become booleans, `022` is octal, `3.10` is the float `3.1`, and country code `NO` becomes `false`. Bites hardest in ConfigMaps, where **all values must be strings**:

```yaml
data:
  enable_cache: "true"     # unquoted -> boolean -> API rejects the ConfigMap
  country: "NO"            # unquoted -> false. Ask Norway.
  version: "1.20"          # unquoted -> 1.2
```

Same trap in env vars and labels — `app.kubernetes.io/version: 2.4` is a float, hence the quotes in the example above. **Ports, by contrast, must be numbers**: `containerPort: "8080"` (string) is rejected. Rule: quote anything that's semantically text, even when it looks numeric or boolean; leave genuinely numeric fields unquoted.

**Multi-document files.** `---` on its own line separates objects in one file; `kubectl apply -f` handles them all. Two traps: a stray `---` at a bad spot silently splits an object in half, and a repeated `metadata.name`+`kind` later in the file *overwrites* the earlier one without warning. Keep one logical app per file, objects in dependency-friendly order (Namespace-level config first, then workloads, then Service/Ingress).

**Env values must be strings:**

```yaml
env:
  - name: MAX_CONNECTIONS
    value: "100"        # unquoted 100 -> "cannot unmarshal number into ... string"
```

## Pre-flight checklist

Before every commit of manifest changes:

```bash
kubectl apply --dry-run=server -f app.yaml   # schema + admission, no changes made
kubectl diff -f app.yaml                     # what would actually change?
```

Two commands, five seconds, and they catch every footgun on this page except the semantic label mismatches — for those, after deploy, check your endpoints like [Life of a Deployment](/start/life-of-a-deployment/) taught you.
