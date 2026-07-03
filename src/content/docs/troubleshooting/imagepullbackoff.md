---
title: ImagePullBackOff
description: Fix ErrImagePull and ImagePullBackOff — tag typos, registry auth, rate limits, and imagePullPolicy surprises.
sidebar:
  order: 5
---

**Symptom:** pod shows `ErrImagePull`, then settles into `ImagePullBackOff`. Same relationship as a crash loop: `ErrImagePull` is the failure, `ImagePullBackOff` is the kubelet waiting (with increasing delay, capped at 5 minutes) before retrying.

## Confirm: read the exact pull error

The pull error message tells you *which* failure mode you have. Don't skip it.

```bash
kubectl describe pod <pod> | grep -A4 "Failed"
```

The three messages that matter:

| Message fragment | Meaning | Cause family |
|---|---|---|
| `manifest unknown` / `manifest for ...:v1.4.2 not found` | Registry answered: **that tag/image doesn't exist** | Typo, tag never pushed, wrong repo path |
| `unauthorized: authentication required` / `pull access denied` | Registry answered: **you're not allowed** (private repos often say this even for nonexistent images) | Missing/wrong imagePullSecrets |
| `dial tcp ... connect: connection refused` / `i/o timeout` / `no such host` | **The node can't reach the registry at all** | Network, DNS, proxy, firewall — usually platform |

Also seen: `toomanyrequests` (rate limit — see below) and TLS errors like `x509: certificate signed by unknown authority` (internal registry with a private CA — platform must trust it on the nodes).

## Causes, ranked by likelihood

### 1. The tag doesn't exist (`manifest unknown`)

The most common cause by a wide margin: a typo, or CI hasn't pushed the tag yet, or the manifest interpolated an empty variable and you're pulling `myapp:` or `myapp:latest` by accident.

```bash
# What exactly is the pod trying to pull?
kubectl get pod <pod> -o jsonpath='{range .spec.containers[*]}{.image}{"\n"}{end}'
```

Verify the tag exists from your machine (no cluster access needed):

```bash
docker manifest inspect registry.example.com/team/myapp:v1.4.2
# or, without docker:
crane manifest registry.example.com/team/myapp:v1.4.2
```

If your pipeline builds and deploys in parallel, you can lose the race: the deploy lands before the push finishes. Make the deploy stage depend on the push stage, and pin by digest for the strongest guarantee.

### 2. Private registry auth (`unauthorized`)

Kubelet pulls with no credentials unless the pod (or its service account) provides them. You need a `docker-registry` secret and a reference to it:

```bash
kubectl create secret docker-registry regcred \
  --docker-server=registry.example.com \
  --docker-username=svc-deploy \
  --docker-password='<token>' \
  --docker-email=team@example.com
```

Reference it per pod:

```yaml
spec:
  imagePullSecrets:
    - name: regcred
  containers:
    - name: app
      image: registry.example.com/team/myapp:v1.4.2
```

Or attach it to the service account so every pod using it inherits the credential — much less repetitive:

```bash
kubectl patch serviceaccount default \
  -p '{"imagePullSecrets": [{"name": "regcred"}]}'
```

Auth debugging checklist:

- Is the secret in the **same namespace** as the pod? Pull secrets don't cross namespaces.
- Does `--docker-server` match the registry in the image reference *exactly*? `registry.example.com` and `registry.example.com:443` are different keys in the docker config.
- Expired token? Registry tokens (ECR especially — 12 hours) rot. Decode and test the stored credential:

```bash
kubectl get secret regcred -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d
```

:::note[Some clusters pre-authenticate nodes]
Managed clusters often have node-level access to a "home" registry (ECR via node IAM role, GCR/AR via node identity) — no imagePullSecrets needed for that registry. If pulls from the standard registry suddenly need auth, or a new registry needs node-level trust, that's a platform conversation.
:::

### 3. Registry unreachable (`connection refused`, `i/o timeout`)

The **node** pulls the image, not you — so "the registry works from my laptop" proves nothing. Node-level egress, proxy config, and DNS are platform-owned. Before escalating, check whether it's all nodes or one:

```bash
kubectl get pods -o wide | grep -i imagepull
```

All pulls failing on one node, fine elsewhere = sick node (report it, or just delete the pod and let it reschedule). Failing everywhere = registry down or network path broken; escalate with the exact error text and a timestamp.

### 4. Rate limits (`toomanyrequests`)

Docker Hub throttles anonymous pulls per source IP — and every node in your cluster typically shares NAT egress, so the whole cluster burns one anonymous allowance. Symptom:

```console
Failed to pull image "redis:7":
  toomanyrequests: You have reached your pull rate limit
```

Fixes, in order of preference: pull through your org's mirror/proxy registry (ask platform — one probably exists), or add authenticated Docker Hub credentials as an imagePullSecret (higher limit), and stop pointing production at Docker Hub directly.

## `imagePullPolicy` and the `:latest` trap

The policy decides whether the kubelet pulls at all:

| Policy | Behavior |
|---|---|
| `IfNotPresent` | Pull only if the image isn't cached on that node. **Default for any real tag.** |
| `Always` | Check the registry every pod start. **Default when the tag is `:latest` or missing.** |
| `Never` | Never pull; fail unless cached. |

This produces the two classic mysteries:

**"It works on node A but not node B."** With `IfNotPresent` and a deleted/never-pushed tag, pods land fine on nodes that cached the image weeks ago and fail on fresh nodes. The scheduler doesn't know or care about image cache. If pull failures correlate with specific nodes, check whether the tag still exists in the registry — the cached copies are living on borrowed time.

**"I pushed a new `:latest` but pods run old code."** Worse than a failure: no error at all. Retagging a moving tag (`latest`, `dev`, `stable`) means different nodes run different bytes depending on when they pulled, and rollback is impossible because the old bytes are gone.

```yaml
# The reliable pattern: immutable tag, or better, a digest
image: registry.example.com/team/myapp:v1.4.2
# strongest — immune to retagging entirely:
image: registry.example.com/team/myapp@sha256:9f8c1e...
```

:::caution[Never deploy moving tags to production]
Unique tag per build (git SHA or semver), set by CI. It makes rollouts deterministic, rollbacks possible, and this entire class of incident extinct. See [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/).
:::

## Air-gapped and proxy registries

Many enterprise clusters can't reach the public internet at all. Pull-through proxies (Artifactory, Harbor, Nexus) or a mirroring pipeline are the norm:

- Image references must use the internal name: `artifactory.corp.example/docker-remote/library/redis:7`, not `redis:7`. A public reference in your manifest fails with `i/o timeout` and no amount of auth fixes it.
- New upstream images may need to be **allow-listed or mirrored first** — a request to whoever owns the proxy, before your deploy.
- Internal registries with private CAs cause `x509` errors until platform installs the CA on the nodes.

Keep the registry prefix in a kustomize/Helm value so the same manifest works across environments with different registries.

## Decision path

1. `kubectl describe pod` → read the exact message.
2. `manifest unknown` → verify tag exists (`crane manifest` / `docker manifest inspect`); check CI pushed it.
3. `unauthorized` → secret exists in this namespace? Server matches? Token fresh? Referenced by pod or SA?
4. `timeout`/`refused`/`x509` → one node or all? → platform escalation with exact error.
5. `toomanyrequests` → mirror or authenticated pulls.
6. Intermittent / node-dependent → `imagePullPolicy` + cache archaeology; fix your tags.

## Prevention

- Immutable tags or digests, always. CI enforces; humans forget.
- Deploy stage depends on push stage in the pipeline.
- Attach pull secrets to the service account once, not to every manifest.
- New namespace checklist includes: create/copy the pull secret (they're namespaced).
- Alert on `ImagePullBackOff` lasting > 5 minutes — it never fixes itself except in the rate-limit case.
