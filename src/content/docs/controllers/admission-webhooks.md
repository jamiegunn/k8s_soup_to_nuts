---
title: Admission Webhooks
description: How mutating and validating webhooks intercept your manifests before etcd, why valid YAML gets rejected, and the dead-webhook outage that blocks all deploys.
sidebar:
  order: 8
---

Sometimes your manifest is perfectly valid Kubernetes — clean schema, correct RBAC — and the apply still fails with an error that mentions neither. Or you deploy a plain pod and it arrives with a sidecar container you never wrote. Both are **admission webhooks**: HTTP callbacks the API server makes to in-cluster services while processing your request, with the power to modify or reject it.

## Where they sit in the request path

```text
kubectl apply
   │
   ▼
authentication ─▶ authorization ─▶ MUTATING webhooks ─▶ schema validation ─▶ VALIDATING webhooks ─▶ etcd
   (who are you?)   (may you?)       (change the object)                       (reject the object)
                                                                                     │
                                                                              controllers see it
```

Key placements to internalize:

- **After authn/authz** — a webhook rejection is *not* an RBAC problem. If the error says `admission webhook ... denied the request`, no amount of permission-granting helps (contrast with [RBAC Denied](/troubleshooting/rbac-denied/)).
- **Before etcd** — a rejected object never exists. Nothing to describe, no events on it; the error message in your terminal or CI log is the *only* artifact. Capture it.
- **Mutating runs before validating** — so policy engines validate the *mutated* object, including fields a mutating webhook or sidecar injector added, not exactly what you wrote.

Every write goes through this — including writes by controllers. That last fact powers the best outage in this article; hold that thought.

## What they're used for

You're almost certainly subject to several already:

- **Sidecar/agent injection** (mutating): service meshes (Istio, Linkerd), secret agents (Vault), monitoring agents — typically opt-in via a namespace or pod label/annotation.
- **Policy engines** (mostly validating, sometimes mutating): **Kyverno**, **OPA Gatekeeper** — enforcing org rules: no `:latest` tags, resource limits required, approved registries only, no privileged containers.
- **Defaulting/normalization** (mutating): injecting `imagePullSecrets`, default resource requests, node tolerations, standard labels.
- **Operators' own webhooks**: validating CRs beyond what OpenAPI schema can express, and defaulting CR fields (see [CRDs Explained](/controllers/crds-explained/) — conversion webhooks are cousins of these).

## Reading a rejection

```console
$ kubectl apply -f deploy.yaml
Error from server: error when creating "deploy.yaml": admission webhook
"validate.kyverno.svc-fail" denied the request:

resource Deployment/team-a/web was blocked due to the following policies

require-resource-limits:
  autogen-check-limits: 'validation error: CPU and memory limits are
    required. rule autogen-check-limits failed at path /spec/containers/0/resources/limits/'
```

Parse it like a stack trace:

1. **The webhook name** (`validate.kyverno.svc-fail`) tells you the engine and often the failure policy (`-fail` suffix = fail closed).
2. **The policy and rule name** (`require-resource-limits` / `autogen-check-limits`) is your search key. Policies are usually cluster-scoped but readable:
   ```console
   $ kubectl get clusterpolicies          # Kyverno
   $ kubectl get constraints              # Gatekeeper
   $ kubectl describe clusterpolicy require-resource-limits
   ```
   Gatekeeper's messages are terser; the `Constraint` object's spec contains the actual rule and often an annotation pointing at docs or the owning team.
3. **The path** points at the offending field. Fix your manifest — compliance beats exemption in both speed and politics.

:::tip[Dry-run trips the same wires]
`kubectl apply --dry-run=server -f deploy.yaml` runs the full admission chain — mutating, validating, everything — without persisting. It's the cheapest way to test manifests against policy *before* CI, and to reproduce a webhook failure on demand while gathering evidence.
:::

For mutations, compare what you wrote against what's live: `kubectl get pod <name> -o yaml` showing containers, initContainers, or env you never authored means a mutating webhook touched it. (Auditing exactly *which* one requires API server audit logs — platform territory.)

## failurePolicy, and the outage where nothing deploys

Each webhook configuration declares what the API server should do when the webhook itself is unreachable:

- **`failurePolicy: Ignore`** — webhook down → request proceeds unchecked. Fails open. Policy gaps during the outage, but deploys keep flowing.
- **`failurePolicy: Fail`** — webhook down → request **rejected**. Fails closed. Correct for security-critical policy... and the source of a legendary outage mode.

The failure looks like this, and once you've seen it you'll never misdiagnose it again:

```console
$ kubectl apply -f deploy.yaml
Error from server (InternalError): Internal error occurred: failed calling
webhook "validate.kyverno.svc-fail": failed to call webhook: Post
"https://kyverno-svc.kyverno.svc:443/validate/fail?timeout=10s":
context deadline exceeded
```

Note the difference: not "denied the request" (policy verdict) but **"failed calling webhook ... context deadline exceeded"** (the webhook service is dead/unreachable, and failurePolicy=Fail turned that into a rejection). Every write matching the webhook's rules now fails: your deploys, your teammates' deploys, and — because controllers' writes go through admission too — sometimes ReplicaSets can't even create pods to replace ones that die. A dead policy pod quietly converts into a namespace-wide (or cluster-wide) change freeze. This is why your deploy "suddenly times out" when you changed nothing.

**Your move:** this is a platform incident, full stop — the webhook backing service is theirs. Escalate immediately with the verbatim error; the webhook name in the message tells them exactly which component to revive. Don't burn an hour re-linting your YAML: *"context deadline exceeded calling webhook X"* is never your manifest's fault.

:::danger[Don't ask for the webhook to be deleted]
Under deploy-freeze pressure, someone always suggests deleting the ValidatingWebhookConfiguration. That drops the entire policy layer cluster-wide and tends to become permanent. The platform team's job is to fix the webhook backend (or consciously, temporarily flip failurePolicy) — your job is fast, precise evidence.
:::

### Mutation side effects: the Job that never finishes

Injected sidecars don't just add containers — they change workload semantics. The canonical casualty is the **Job with an injected service-mesh sidecar**: your batch container exits 0, but the sidecar keeps running, so the pod never completes and the Job hangs at `1/1 Running` forever. CronJobs then stack up behind `concurrencyPolicy: Forbid`, and someone gets paged for "batch is frozen" (see [Jobs and CronJobs](/workloads/jobs-and-cronjobs/)).

Fixes, best to worst: opt the Job's pods out of injection (per-pod annotation, e.g. `sidecar.istio.io/inject: "false"`); use the mesh's native sidecar-container support if the cluster is new enough; or have your entrypoint tell the sidecar to quit on completion. The general lesson generalizes: after any mutating webhook is added to your namespaces, re-test Jobs, initContainers ordering, and anything that assumes it knows the pod's full container list.

## namespaceSelector: why some namespaces are exempt

Webhook configurations scope themselves with selectors — most commonly `namespaceSelector` matching namespace labels:

```yaml
namespaceSelector:
  matchExpressions:
    - key: policy.example.corp/enforce
      operator: In
      values: ["true"]
```

Consequences you'll observe:

- The same manifest deploys fine in one namespace and gets rejected in another → compare namespace labels: `kubectl get ns team-a team-b --show-labels`.
- Sidecar injection is opt-in/out via labels like `istio-injection: enabled` — on the namespace (you may not be able to edit namespace labels yourself; that's a platform request) or per-pod via annotations (usually yours to set).
- `kube-system` and platform namespaces are typically excluded so the policy engine can't deadlock the cluster's own recovery.

If you can read cluster-scoped objects, the configurations themselves list every hook, its rules, scope, and failurePolicy:

```console
$ kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations
```

Even read access to *names* helps you guess which engine is in play.

:::note[Webhooks also add latency]
Every matching write pays the webhook round-trip, capped by the config's `timeoutSeconds` (max 30, commonly 10). A slow policy engine makes *every* `kubectl apply` and every controller write sluggish before it makes anything fail. If deploys got mysteriously slower cluster-wide after a policy rollout, that's the mechanism — measurable by comparing `--dry-run=server` timings against a namespace the webhook doesn't select.
:::

## Evidence package for the platform team

For webhook trouble, collect:

> 1. The **verbatim error** — it contains the webhook name, policy, and failure type (denied vs failed-calling).
> 2. Reproduction via `kubectl apply --dry-run=server` (proves it's admission, not your pipeline).
> 3. Namespace and its labels (`kubectl get ns <ns> --show-labels`).
> 4. Timestamps — "worked at 14:00, failing since 14:20" points at a policy or webhook rollout on their side.

## The compliance workflow that avoids all of this

Teams that never fight admission at deploy time do three things:

1. **Know the policy set.** Get (or read) the cluster's policy list; encode the rules into your base manifests/Helm templates once — limits always set, no `:latest`, registries pinned.
2. **Shift left:** run `kubectl apply --dry-run=server` against a real cluster in CI, or run the engine's CLI (`kyverno apply`, `gatekeeper-test`/`gator test`) against manifests in the pipeline. Rejections in CI cost minutes; rejections during an emergency hotfix cost an incident bridge.
3. **Request exemptions properly.** If a policy genuinely can't fit a workload, the ask is specific: policy name, resource, namespace, why, and for how long. Policy engines support scoped exceptions; platform teams grant narrow ones far more readily than "please turn it off."

One habit ties it together: treat policy rules like compiler warnings, not obstacles. The clusters where admission is painless are the ones whose base manifests were made compliant once, in a single sitting, and templated everywhere.

Admission is the last gate before your intent becomes cluster state — after it, [reconciliation](/controllers/reconciliation/) takes over and the controllers you've met across this section start making it real.
