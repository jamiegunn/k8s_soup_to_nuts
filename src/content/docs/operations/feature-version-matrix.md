---
title: "Feature Version Matrix"
description: The single source of truth for which Kubernetes version a feature this guide relies on became stable — so a page never has to guess, and version drift is a one-file fix.
keywords:
  - which kubernetes version has in-place pod resize
  - native sidecar containers stable version
  - kube-proxy nftables mode ga version
  - statefulset pvc retention policy version
  - grpc probe stable version
  - cronjob timezone version
  - does my cluster support this feature
  - kubernetes feature gate graduation versions
  - feature stable since version reference
sidebar:
  order: 12.5
---

Version-sensitive claims are the single most drift-prone thing in a Kubernetes guide: the *mechanics* stay true for years, but "stable since 1.3x" ages the moment your cluster is one release behind or ahead. This page is the **one place** those claims live. Every other page states behavior and links here for the "which version" detail, so keeping the site current is editing one table instead of grepping 265 pages.

If you own the apps but not the cluster, this page answers the question you actually have: *"is this feature on the cluster my platform team gave me?"* Check your server version (`kubectl version`), find the row, and compare. This is the feature-graduation companion to [API Deprecations and Cluster Upgrades](/operations/api-deprecations/) — that page covers apiVersion *removals* (what breaks your `apply`), this one covers feature *graduations* (what your manifests can rely on).

## The matrix

Facts below are verified against the Kubernetes release blog; each row notes the release that made the feature **stable (GA)** and the earlier release where it was **beta** (usually on by default, usable with a caveat). If your cluster predates the "Stable" column, treat the feature as *maybe present, verify* rather than guaranteed.

| Feature | Beta | **Stable (GA)** | What it means for you | Where the guide uses it |
|---|---|---|---|---|
| **In-place pod resize** (change CPU/memory without a restart) | 1.33 | **1.35** | Resource edits no longer imply a pod restart; VPA can act without churn | [Resources & QoS](/workloads/resources-and-qos/), [Requests & Limits Knobs](/tuning/requests-limits-knobs/), [Resource Tuning in Prod](/operations/resource-tuning-in-prod/), [Cost & Rightsizing](/operations/cost-and-rightsizing/) |
| **Native sidecar containers** (init container with `restartPolicy: Always`) | 1.29 | **1.33** | Sidecars start before app containers and stop after them — ordered lifecycle, no more racey mesh injection | [Sidecars](/sidecars/overview/), [Init & Sidecar Containers](/workloads/init-and-sidecar-containers/) |
| **kube-proxy nftables mode** | 1.31 | **1.33** | The successor to iptables mode; same model, far better scaling on large Services | [Services Deep Dive](/networking/services-deep-dive/), [kube-proxy and the Dataplane](/routing/kube-proxy-and-the-dataplane/), [NAT](/routing/nat/) |
| **StatefulSet PVC retention policy** (`persistentVolumeClaimRetentionPolicy`) | 1.27 | **1.32** | Choose whether a StatefulSet's PVCs are deleted or kept when the set is deleted or scaled down | [StatefulSets Fundamentals](/stateful/statefulsets-fundamentals/), [Storage: PV & PVC](/stateful/storage-pv-pvc/) |
| **gRPC probes** (`grpc` liveness/readiness/startup) | 1.24 | **1.27** | Probe a gRPC health service natively — no `grpc_health_probe` binary in the image | [Health Checks](/workloads/health-checks/), [Health Check Design](/tuning/health-check-design/) |
| **CronJob `timeZone`** | 1.25 | **1.27** | Schedules in a named zone instead of UTC arithmetic in the cron string | [Jobs & CronJobs](/workloads/jobs-and-cronjobs/), [API Deprecations](/operations/api-deprecations/) |

## The rule the rest of the site follows

- A page describes *what a feature does* and *why it matters* — timeless.
- The **version** at which it's safe to rely on lives **here**, linked, not restated.
- A feature not yet stable is written as forward-looking ("expected to graduate", "beta as of…") and never as an availability claim.

That discipline is enforced automatically. The repo's [content lint](https://github.com/jamiegunn/k8s_soup_to_nuts/blob/main/scripts/lint-content.mjs) (`npm run lint`, run in CI before every build) carries a single `CURRENT_STABLE_MINOR` constant and flags any prose that claims a feature is available in a release *newer* than that, unless the sentence is explicitly forward-looking. Two consequences worth knowing:

1. **Keeping the site current is a two-step ritual.** When the platform's newest stable release changes, bump `CURRENT_STABLE_MINOR` in the lint and update the "Stable (GA)" column here for anything that graduated. Nothing else needs touching.
2. **Image tags aren't version claims.** `busybox:1.37` in a `kubectl run` example is an image tag, not a Kubernetes version — the lint ignores tags and code blocks, and so should you when reading these pages. (This is the trap a naïve version audit falls into: most "1.37" mentions across the site are busybox tags, not release claims.)

:::note[Checking your own cluster]
```bash
kubectl version -o json | jq -r .serverVersion.gitVersion   # e.g. v1.34.5
```
Compare the minor (`1.34`) against the "Stable (GA)" column. Below it, the feature may still be present as beta — check `kubectl explain` for the field, or ask your [platform team](/operations/working-with-platform-team/) which feature gates are enabled.
:::
