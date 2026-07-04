---
title: Service Mesh for App Teams
description: Living inside a platform-run Istio or Linkerd mesh — what the sidecar actually does to your pod, the CRs you own, and how to debug when the proxy is the problem.
sidebar:
  order: 10
---

Your platform team runs a service mesh. You didn't ask for it, you don't administer it, but there is now an extra container in every one of your pods and every byte your app sends or receives passes through it. This article is the tenant's manual: what the mesh does to your workloads, what you get for free, what silently changes, which CRs you're allowed to touch, and how to debug when a 503 comes from the proxy and not your code.

Examples are Istio-first (the most common enterprise install), with Linkerd noted where it differs.

## What the mesh actually adds to your pod

A mesh injects a **sidecar proxy** — Envoy for Istio, `linkerd-proxy` for Linkerd — into your pod via a [mutating admission webhook](/controllers/admission-webhooks/). You submit a Deployment with one container; the API server hands the pod spec to the mesh's webhook; the webhook adds the proxy container plus an init container (`istio-init` / `linkerd-init`) that rewrites the pod's **iptables** rules so *all* inbound and outbound TCP is transparently redirected through the proxy. Your app still thinks it's talking to `orders:8080`; it's actually talking to localhost, to Envoy, which then does mTLS, retries, and load balancing on its behalf.

That injected proxy is a [sidecar container](/workloads/init-and-sidecar-containers/) in every sense that matters: it shares your pod's network namespace, counts against your resource quota, and participates in your pod's lifecycle — which is the source of most mesh surprises.

**Ambient mode**, briefly: newer Istio installs may run **ambient mesh** instead, where a per-node proxy (`ztunnel`) handles mTLS and L4 policy with *no sidecar in your pod*, and optional per-namespace `waypoint` proxies do L7. If your platform runs ambient, most of the sidecar-lifecycle pathologies below don't apply to you — but neither do per-pod Envoy logs. Ask which mode you're in.

### How to tell if you're meshed

```bash
# Container list — a meshed pod has istio-proxy (or linkerd-proxy) alongside your app
kubectl get pod orders-7d9f6c5b8-x2krn \
  -o jsonpath='{.spec.containers[*].name}{"\n"}{.spec.initContainers[*].name}{"\n"}'
```

```console
orders istio-proxy
istio-init
```

```bash
# Namespace labels drive injection
kubectl get ns my-team -o jsonpath='{.metadata.labels}' | jq .
```

```json
{
  "istio-injection": "enabled",
  "kubernetes.io/metadata.name": "my-team"
}
```

Istio: `istio-injection=enabled` or the revision form `istio.io/rev=1-22`. Linkerd: `linkerd.io/inject=enabled` on the namespace or pod template. Ambient Istio: `istio.io/dataplane-mode=ambient` and *no* extra container in your pod. Per-pod opt-out (with platform blessing) is the annotation `sidecar.istio.io/inject: "false"` / `linkerd.io/inject: disabled`.

## What you get without touching code

- **mTLS between pods.** The proxies exchange workload certificates (rotated automatically); traffic between meshed pods is encrypted and identity-authenticated. Verify it's actually on rather than assuming:

  ```bash
  istioctl x describe pod orders-7d9f6c5b8-x2krn   # if you're allowed istioctl
  ```

  ```console
  Pod: orders-7d9f6c5b8-x2krn
     Pod Revision: 1-22
  ...
  Effective PeerAuthentication: STRICT
  ```

  No `istioctl`? Tcpdump-free proof: exec into a *non-meshed* pod and curl a meshed pod's IP directly. Under `STRICT` mTLS you get `connection reset by peer` — the proxy refuses plaintext. Linkerd: `linkerd viz edges deployment -n my-team` shows a padlock per edge.

- **Retries, timeouts, circuit breaking at the proxy** — configured via CRs (below), applied without a deploy.
- **Golden metrics per service** — request rate, error rate, latency histograms, emitted by the proxy with zero instrumentation. Your platform's Grafana almost certainly has a per-namespace mesh dashboard; find it before building your own.
- **Distributed tracing headers** — the proxy *starts* spans and forwards `traceparent`/`x-b3-*` headers on inbound requests. But it cannot correlate the request that came in with the request your app makes next. **Your app must copy trace headers from inbound to outbound requests** or every trace is a chain of one-hop fragments. This is the single most common mesh misunderstanding; see [tracing](/observability/tracing/) for the propagation patterns.

## What changes about everything you knew

The mesh rewires assumptions you've built up from every previous networking article. The big five:

**1. `kubectl exec` + curl behaves differently.** Curl *from* a meshed pod goes through your Envoy — you're testing the mesh path, which is usually what you want. Curl *to* a meshed pod from an unmeshed one (netshoot pod, node, a not-yet-migrated namespace) hits mTLS and dies with `Recv failure: Connection reset by peer` even though the app is perfectly healthy. This is the classic "the service is down!" false alarm. Debug meshed services from inside the mesh, or ask whether the target is in `PERMISSIVE` mode (accepts both plaintext and mTLS).

**2. Startup ordering.** Containers start in spec order, and your app may boot before the proxy is ready to forward traffic — every outbound call at startup (DB connect, config fetch) gets `connection refused` to what is actually the not-yet-listening Envoy. Fixes, best first:

```yaml
# Pod annotation (Istio): don't start app containers until Envoy is ready
metadata:
  annotations:
    proxy.istio.io/config: '{ "holdApplicationUntilProxyStarts": true }'
```

On Kubernetes ≥1.29 with a recent Istio/Linkerd, the proxy is injected as a **native sidecar** (an init container with `restartPolicy: Always`), which solves ordering at both ends properly — check with the platform whether it's enabled. Failing both, make your app retry its startup connections; you should anyway.

**3. Jobs never complete.** Your Job's app container exits 0; the sidecar keeps running; the pod stays `NotReady`/running forever and the Job never succeeds. Fixes: native sidecars (solves it outright — the kubelet stops sidecars when main containers finish); or have the job shut the proxy down itself as its last act:

```bash
# Istio: quitquitquit endpoint on the Envoy admin port
curl -fsS -X POST http://localhost:15020/quitquitquit
# Linkerd: linkerd-await --shutdown -- your-command, or
curl -fsS -X POST http://localhost:4191/shutdown
```

Or annotate the Job's pod template `sidecar.istio.io/inject: "false"` if it doesn't need the mesh at all.

**4. Readiness probes are rewritten (Istio).** With STRICT mTLS, the kubelet (unmeshed, on the node) couldn't probe your app directly — so Istio's webhook rewrites your HTTP probes to hit the proxy's port 15020, which forwards to your app over localhost. `kubectl get pod -o yaml` shows a probe path like `/app-health/orders/readyz` on port 15020 that you never wrote. It's normal. It also means probe traffic bypasses mesh policy — your health-check semantics are unchanged, just relocated. Linkerd doesn't rewrite probes; it exempts kubelet traffic instead.

**5. NetworkPolicies still apply underneath.** The mesh does L7 authorization; the CNI still enforces L3/L4 [NetworkPolicies](/networking/network-policies/) on the same packets. A mesh `AuthorizationPolicy` allowing traffic does nothing if a NetworkPolicy drops it first — and your policies must allow the mesh's own ports (Istio: 15008/15012/15017/15020-15021/15090; Linkerd: 4143/4191). "Works without the policy, mTLS errors with it" is usually a blocked mesh port, not mTLS.

## The CRs you own (and the ones you don't)

Typical tenancy split: platform owns the mesh install, ingress/egress gateways, mesh-wide `PeerAuthentication`, and default sidecar resources. You own routing and resilience CRs *in your namespace* for *your* services. Confirm the split with your platform team before you depend on it.

### Istio: VirtualService — retries, timeouts, canary splits

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: orders
  namespace: my-team
spec:
  hosts:
    - orders.my-team.svc.cluster.local
  http:
    - route:
        - destination:
            host: orders.my-team.svc.cluster.local
            subset: stable
          weight: 90
        - destination:
            host: orders.my-team.svc.cluster.local
            subset: canary
          weight: 10
      timeout: 3s
      retries:
        attempts: 2
        perTryTimeout: 1s
        retryOn: 5xx,reset,connect-failure
```

The weighted split is the foundation of proxy-level canaries — 10% of *requests* (not connections, not pods) to the new version, shift gradually, no replica-count arithmetic. See [rollouts and rollbacks](/workloads/rollouts-and-rollbacks/) for wiring this into a deploy pipeline.

:::caution
`retryOn: 5xx` retries non-idempotent requests too. If a POST charges a card and then times out, the proxy will happily charge it again. Scope retries to idempotent routes or use `retryOn: connect-failure,refused-stream,reset` (pre-request failures only).
:::

### Istio: DestinationRule — subsets, outlier detection, connection pools

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: orders
  namespace: my-team
spec:
  host: orders.my-team.svc.cluster.local
  subsets:
    - name: stable
      labels: { version: v1 }
    - name: canary
      labels: { version: v2 }
  trafficPolicy:
    connectionPool:
      tcp: { maxConnections: 100 }
      http:
        http1MaxPendingRequests: 50
        http2MaxRequests: 200
    outlierDetection:            # passive health checking / circuit breaking
      consecutive5xxErrors: 5
      interval: 10s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
    tls:
      mode: ISTIO_MUTUAL         # don't set DISABLE unless platform says so
```

:::danger
A `DestinationRule` with `tls.mode` that contradicts the mesh's `PeerAuthentication` is the #1 self-inflicted mesh outage: instant, total `503 UF,URX` for every caller. If you don't need the `tls` block, omit it and inherit mesh defaults.
:::

### Linkerd equivalents, in brief

Linkerd is deliberately smaller: traffic splitting and per-route policy via Gateway API **HTTPRoute** (or legacy `ServiceProfile` for per-route metrics/retry budgets), retries and timeouts via annotations on the HTTPRoute/Service (`retry.linkerd.io/http: 5xx`, `retry.linkerd.io/limit: "2"`, `timeout.linkerd.io/request: 3s`). No DestinationRule analogue — connection pooling and mTLS mode aren't tenant-tunable, which is arguably a feature.

## Debugging in a mesh

First question, always: **app or proxy?** The proxy has its own logs:

```bash
kubectl logs orders-7d9f6c5b8-x2krn -c istio-proxy --tail=20   # Linkerd: -c linkerd-proxy
```

Istio's Envoy access log carries a **response flag** field — the proxy telling you exactly why a request failed. Decoder for the ones you'll actually meet:

| Flag | Meaning | Usual cause |
|------|---------|-------------|
| `-`  | No flag — response came from your app | It's your bug, not the mesh's |
| `UH` | No healthy upstream | All endpoints failing readiness, or outlier detection ejected everything |
| `UF` | Upstream connection failure | App not listening on the port, or mTLS mismatch |
| `UO` | Upstream overflow | Your own `connectionPool` limits — circuit breaker doing its job |
| `URX` | Retry limit exceeded | Retries configured and exhausted |
| `DC` | Downstream connection closed | The *caller* hung up (client timeout shorter than yours) |
| `UT` | Upstream timeout | Your `timeout:` fired before the app answered |
| `NR` | No route configured | VirtualService typo — host/port doesn't match anything |

A `503` with `UH`/`UF`/`NR` **came from the mesh, not your app** — your app never saw the request, and no amount of app-log grepping will find it. Fold this into your normal [service unreachable](/troubleshooting/service-unreachable/) workflow: check response flags *before* endpoints.

If you have read-only `istioctl` (worth requesting):

```bash
istioctl proxy-status                          # is every sidecar SYNCED with the control plane?
istioctl proxy-config clusters deploy/orders   # what endpoints does MY Envoy think exist?
istioctl analyze -n my-team                    # lints your VS/DR for the classic mistakes
```

`proxy-status` showing `STALE` means your Envoy has old config — a control-plane problem, page the platform team. Linkerd: `linkerd diagnostics proxy-metrics` and `linkerd viz tap` are the analogues.

**mTLS mismatch symptoms**, for the pattern library: plaintext client → STRICT server = connection reset at TLS handshake; meshed client → unmeshed server with a stale DestinationRule forcing `ISTIO_MUTUAL` = `503 UF` with `TLS error` in the sidecar log. Both look like "service is flapping" from the app's point of view.

## The sidecar costs you resources

The proxy's CPU/memory requests come out of **your namespace quota** — typically 100m CPU / 128Mi requests per pod for Istio (Linkerd's proxy is markedly lighter, ~one-tenth the memory). At 50 pods that's 5 CPU / 6.4Gi of quota you're paying for the mesh, plus real latency (~0.5–2ms per hop) and real CPU under load — a proxy pushing thousands of RPS can want a full core.

Sizing is usually a platform-owned injection default, overridable per-pod by annotation *if platform allows it*:

```yaml
metadata:
  annotations:
    sidecar.istio.io/proxyCPU: "50m"
    sidecar.istio.io/proxyMemory: "96Mi"
    sidecar.istio.io/proxyCPULimit: "1"
```

Watch `container="istio-proxy"` in your resource dashboards. If the proxy is throttled, *your* p99 suffers and nothing in your app metrics explains it. That's a concrete, data-backed ask to bring to platform.

## Do you even want the mesh?

If you're given the choice: the mesh earns its complexity when you need **mTLS-by-policy** (compliance), **uniform golden metrics across polyglot services**, or **traffic shaping you can't do at ingress** (per-request canaries, outlier ejection, deep retry control). It does *not* earn it for a three-service stack that could get retries from a library and TLS from the ingress — you'd be adding a distributed system to debug in exchange for features you won't use. Linkerd, if offered, is the lower-cost on-ramp: less to configure, less to misconfigure, fewer CRDs.

### Onboarding checklist for joining an existing mesh

1. Confirm mode (sidecar vs ambient) and mTLS posture (`PERMISSIVE` vs `STRICT`) with platform.
2. Verify quota headroom for sidecars: pods × proxy requests.
3. Enable `holdApplicationUntilProxyStarts` (or confirm native sidecars) before flipping injection.
4. Audit Jobs and CronJobs for the sidecar-never-exits trap; add shutdown hooks or opt-outs.
5. Check NetworkPolicies allow mesh control and data ports.
6. Confirm your app propagates trace headers, or accept fragmented traces.
7. Enable injection on a **new rollout**, not by labeling the namespace and waiting — pods only get sidecars at creation. Roll one deployment, soak, then the rest.
8. Find the mesh dashboard for your namespace and put the response-flag table somewhere your on-call can see it.

The mesh also changes the calculus for anything holding connections open — gRPC finally load-balances properly, for one. That story is next: [gRPC, WebSockets, and long-lived connections](/networking/long-lived-connections/).
