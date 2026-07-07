---
title: Gateway API for App Teams
description: The tenant-seat deep dive on HTTPRoute — anatomy, weighted canaries, status conditions, ReferenceGrant, and migrating off Ingress annotations.
keywords:
  - HTTPRoute
  - my route does nothing
  - Accepted False
  - NotAllowedByListeners
  - NoMatchingListenerHostname
  - ResolvedRefs
  - RefNotPermitted
  - ReferenceGrant
  - weighted traffic split canary
  - gRPCRoute
  - allowedRoutes
  - ingress2gateway migration
sidebar:
  order: 7
---

The Ingress resource is frozen. Not deprecated — it will keep working for years — but the upstream API stopped taking features around 2020, which is why every real-world capability (timeouts, canaries, rewrites, gRPC) lives in controller-specific annotations. You've felt this if you've ever pasted an `nginx.ingress.kubernetes.io/*` annotation into a cluster running Traefik and watched nothing happen. [Gateway API](https://gateway-api.sigs.k8s.io/) is the successor, and for readers of this guide it has one property no ingress API ever had: **it was designed for your seat**. The role split *is* the design:

| Resource | What it says | Who owns it |
|---|---|---|
| `GatewayClass` | "This flavor of data plane exists in this cluster" | Vendor / infra |
| `Gateway` | A running listener: address, ports, TLS certs, which namespaces may attach | **Platform team** |
| `HTTPRoute` | "Traffic matching *this* goes to *my* Service, split *this* way" | **You** |

With Ingress, TLS config, hostnames, and routing rules were mashed into one object, so platform teams either gave everyone too much power or bottlenecked every change through a ticket. With Gateway API, the platform owns the shared edge; you own your routes; the boundary between them is typed, validated, and — crucially — *reported in status* instead of silently ignored. [Ingress and routing](/networking/ingress-and-routing/) introduced this split in one section; this article is the full working manual for the part you own.

## Step zero: discover what you actually have

Gateway API resources are CRDs — if the platform hasn't installed them, none of this exists in your cluster (see [CRDs explained](/controllers/crds-explained/) for why `kubectl` may reply `the server doesn't have a resource type`):

```bash
kubectl get gatewayclasses
kubectl get gateways -A
```

```text
NAME    CONTROLLER                                   ACCEPTED   AGE
istio   istio.io/gateway-controller                  True       412d

NAMESPACE        NAME             CLASS   ADDRESS        PROGRAMMED   AGE
infra-gateways   shared-gateway   istio   203.0.113.40   True         412d
```

Two facts to extract:

1. **Which implementation.** The `CONTROLLER` string tells you: `istio.io/gateway-controller` (Istio), `gateway.envoyproxy.io/gatewayclass-controller` (Envoy Gateway), `gateway.nginx.org/nginx-gateway-controller` (NGINX Gateway Fabric), `io.cilium/gateway-controller` (Cilium), `traefik.io/gateway-controller` (Traefik). Core HTTPRoute behaves the same everywhere; extended features and policy attachments differ, so knowing the implementation tells you which docs to read when you go beyond the core.
2. **Whether you can attach.** Each Gateway listener declares `allowedRoutes` — the platform's attachment policy:

```bash
kubectl get gateway shared-gateway -n infra-gateways -o yaml
```

```yaml
spec:
  gatewayClassName: istio
  listeners:
    - name: https
      port: 443
      protocol: HTTPS
      hostname: "*.example.com"
      tls:
        mode: Terminate
        certificateRefs:
          - name: wildcard-example-com
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: "granted"
```

`from: Same` means only routes in the Gateway's own namespace attach (you're locked out); `from: All` means anyone; `from: Selector` means your namespace needs the label. If your namespace lacks `gateway-access: granted`, no HTTPRoute you write will ever bind — that's a [platform ticket](/operations/working-with-platform-team/), not a YAML problem.

## HTTPRoute anatomy, fully worked

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shop-api
  namespace: shop
spec:
  parentRefs:
    - name: shared-gateway
      namespace: infra-gateways
      sectionName: https        # bind to ONE listener, not all of them
  hostnames:
    - shop.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
          headers:
            - name: X-Canary
              value: "internal"
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            set:
              - name: X-Route-Source
                value: gateway-api
      backendRefs:
        - name: shop-api
          port: 8080
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: shop-web
          port: 8080
```

**parentRefs** names the Gateway you attach to. Use `sectionName` (listener name) or `port` to bind to a specific listener; omit both and the route tries to attach to *every* listener it's allowed on — usually not what you want on a Gateway that also has an HTTP-redirect listener.

**hostnames** must *intersect* with the listener's hostname or the route silently doesn't bind to that listener. Listener says `*.example.com`; your route can say `shop.example.com` (narrower — fine) or nothing (inherits the wildcard). Say `shop.other.org` and the intersection is empty — the route attaches to zero listeners and status tells you so (next section). This intersection rule is the single most common "my route does nothing" cause.

**matches** are typed, not annotation strings: `path` with `type: Exact`, `PathPrefix` (element-wise — `/api` matches `/api/v1` but not `/apiv1`), or `RegularExpression` (implementation-specific support); `headers` (exact or regex); `queryParams`; `method`. Multiple matches in one list are OR'd; fields within one match are AND'd.

**filters** replace half of the ingress-nginx annotation zoo with typed fields: `RequestHeaderModifier` / `ResponseHeaderModifier` (set/add/remove), `RequestRedirect` (scheme, hostname, port, path, statusCode — HTTP→HTTPS redirects and vanity-domain bounces), `URLRewrite` (replace hostname or path prefix before proxying — the typed version of `rewrite-target`, without regex capture groups), and `RequestMirror` (shadow a copy of live traffic to a test backend; responses from the mirror are discarded).

### Weights: the canary you no longer need annotations for

`backendRefs` take weights natively. This is the headline feature for app teams — traffic splitting was previously a second Ingress with three `canary-*` annotations on the right controller, or nothing:

```yaml
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: shop-api          # stable
          port: 8080
          weight: 90
        - name: shop-api-canary   # new version behind its own Service
          port: 8080
          weight: 10
```

Ninety percent of requests go to `shop-api`, ten to `shop-api-canary`. Shift weights with `kubectl edit` or your CI pipeline, watch error rates, walk it to 100/0 either direction. Weights are proportional, not percentages (90/10 ≡ 9/1). One route change in Git per step — this composes cleanly with the deployment strategies in [rollouts and rollbacks](/workloads/rollouts-and-rollbacks/), and progressive-delivery tools (Argo Rollouts, Flagger) can drive these weights for you.

:::caution
Weighted splitting is per-*request* only if connections are short-lived. Clients with keep-alive pools, gRPC channels, or WebSockets stick to the backend their connection landed on — a 90/10 weight can look like 100/0 for a chatty client that opened one connection. See [long-lived connections](/networking/long-lived-connections/) before you trust canary metrics.
:::

### Rule precedence

When multiple rules (or multiple HTTPRoutes on the same listener) match a request, the spec defines the order — you don't control it with rule ordering alone: exact path beats longer prefix beats shorter prefix; method match beats none; more header matches beat fewer; then more query params. Ties across *routes* go to the older `creationTimestamp`, then alphabetical namespace/name. Practical upshot: your `/api` rule wins over `/` regardless of listing order, but two teams both claiming `/` on the same hostname is a fight the older route wins — coordinate hostname ownership through the platform team.

## Status is where the truth lives

Ingress ignored your mistakes silently. HTTPRoute writes a verdict per parentRef, and reading it is 80% of debugging:

```bash
kubectl describe httproute shop-api -n shop
```

```text
Status:
  Parents:
    Conditions:
      Last Transition Time:  2026-07-03T09:14:22Z
      Message:               Route was valid
      Observed Generation:   3
      Reason:                Accepted
      Status:                True
      Type:                  Accepted
      Last Transition Time:  2026-07-03T09:14:22Z
      Message:               All references resolved
      Reason:                ResolvedRefs
      Status:                True
      Type:                  ResolvedRefs
    Controller Name:         istio.io/gateway-controller
    Parent Ref:
      Name:                  shared-gateway
      Namespace:             infra-gateways
      Section Name:          https
```

Two conditions matter:

- **`Accepted`** — did the Gateway let you attach? `False` reasons: `NotAllowedByListeners` (the listener's `allowedRoutes` excludes your namespace — label missing, or platform policy), `NoMatchingListenerHostname` (your `hostnames` don't intersect the listener hostname), `NoMatchingParent` (bad `sectionName`/`port`, or the Gateway doesn't exist).
- **`ResolvedRefs`** — do your backendRefs resolve? `False` reasons: `BackendNotFound` (typo'd Service name), `RefNotPermitted` (cross-namespace backend without permission — see next).

:::tip
`Observed Generation` should match `metadata.generation`. If it lags, the controller hasn't processed your latest edit — check controller health before debugging your own YAML, and check `kubectl get events -n shop` for controller-emitted warnings ([events](/observability/events/) covers reading them properly).
:::

### ReferenceGrant: the RefNotPermitted fix

By default, an HTTPRoute may only reference Services in its **own namespace** — otherwise any tenant could route the shared edge into anyone's backend. If your route in `shop` needs a Service in `shop-backend`, the *target* namespace must consent with a ReferenceGrant:

```yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-shop-routes
  namespace: shop-backend        # lives WHERE THE TARGET IS, not with the route
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: shop
  to:
    - group: ""                  # core API group (Service)
      kind: Service
```

The `v1beta1` is not a typo: ReferenceGrant is the one resource here that hasn't graduated to `v1` alongside Gateway, HTTPRoute, and GRPCRoute. The direction trips everyone up: the grant is written by the namespace being *pointed at*, granting the pointing namespace permission. If both namespaces are yours, ship the grant alongside the backend's manifests. If the target belongs to another team, this is a deliberate consent handshake — which is the point.

## What you don't get from Ingress land (yet)

Honesty section. The core HTTPRoute surface is portable and stable; the edges vary:

- **Typed policy attachments** replace per-controller annotations for the fancier features. `BackendTLSPolicy` (the Gateway speaks TLS to your backend — replacing `backend-protocol: "HTTPS"`) is standard but recently graduated; check your implementation's version. Beyond that, each implementation has its own policy CRDs (Envoy Gateway's `BackendTrafficPolicy`, Istio's mesh config, NGINX Gateway Fabric's policies) — typed and validated, but not portable across implementations.
- **Timeouts** are in the core API now: `rules[].timeouts.request` and `timeouts.backendRequest` (Gateway API v1.1+, implementation support varies). If your cluster's CRDs are older, the fields don't exist and the platform team has to upgrade.
- **Retries** (`rules[].retry`) are landing through the experimental channel — don't build on them yet without checking what your cluster ships.
- **Still ingress-nginx territory:** body-size limits, rate limiting, auth subrequests (`auth-url`), session affinity cookies, and regex-capture rewrites have no core equivalent — they're policy-attachment or implementation territory. If your service leans hard on those [ingress-nginx annotations](/networking/ingress-nginx/), it migrates last.

```yaml
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      timeouts:
        request: 30s           # total budget for the request
        backendRequest: 10s    # per attempt to your backend
      backendRefs:
        - name: shop-api
          port: 8080
```

## Migration pragmatics

Ingress and HTTPRoute coexist fine — many implementations serve both from the same data plane, and even with separate controllers they're just different resources programming different (or the same) edges. Nobody flag-days this.

- **Convert first:** anything currently doing canary via annotations (native weights are strictly better), plain host+path routes (mechanical), and new services (start them on HTTPRoute, accumulate no legacy).
- **Leave for later:** routes leaning on nginx-specific annotations with no typed equivalent yet (auth subrequests, rate limits, exotic rewrites).
- **Tooling:** the `ingress2gateway` CLI (a Gateway API subproject) converts Ingress (and understands several annotation dialects) into Gateway API resources. Treat its output as a first draft — review the hostname intersections and parentRefs against *your* platform's Gateways before committing.
- **Cutover:** create the HTTPRoute alongside the Ingress, verify `Accepted`/`ResolvedRefs`, test via the Gateway's address with a `curl --resolve`, flip DNS or delete the Ingress, keep the Ingress manifest in Git for one release as the rollback.

## gRPCRoute: native gRPC matching

gRPC over Ingress meant `backend-protocol: "GRPC"` annotations and path-prefix hacks against `/package.Service/Method`. GRPCRoute (GA in Gateway API v1.1) makes the RPC structure first-class:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: shop-grpc
  namespace: shop
spec:
  parentRefs:
    - name: shared-gateway
      namespace: infra-gateways
      sectionName: https
  hostnames:
    - grpc.example.com
  rules:
    - matches:
        - method:
            service: shop.v1.CheckoutService
            method: PlaceOrder        # omit to match the whole service
      backendRefs:
        - name: checkout
          port: 9090
```

Header matching and weighted backendRefs work the same as HTTPRoute. The usual gRPC caveats apply doubly here: HTTP/2 multiplexes many calls over few connections, so weight-based canaries and load balancing behave per-*connection* unless the proxy balances at the stream level — [long-lived connections](/networking/long-lived-connections/) is required reading before shipping a gRPC canary.

## Debugging checklist

Work top-down; each layer's failure has a distinct signature.

1. **Route shows no status / `Accepted: False`.** Read the reason. `NotAllowedByListeners` → your namespace fails the listener's `allowedRoutes` selector; check `kubectl get ns shop --show-labels` against the Gateway spec. `NoMatchingListenerHostname` → your `hostnames` don't intersect the listener hostname; compare both. `NoMatchingParent` → wrong `sectionName`, wrong Gateway namespace, or the Gateway is gone. No status at all → CRDs installed but no controller watching, or wrong `parentRefs` entirely.
2. **Route Accepted, client gets 404.** DNS points at the right Gateway address? Hostname in the request matches `hostnames`? Path match type right (`Exact` vs `PathPrefix`)? Another, older route winning precedence on the same hostname? `curl -v --resolve shop.example.com:443:203.0.113.40 https://shop.example.com/api/health` takes DNS out of the equation.
3. **Route Accepted, client gets 503.** `ResolvedRefs: False` with `RefNotPermitted` → missing ReferenceGrant in the target namespace. `BackendNotFound` → Service name/port typo. Both `True` and still 503 → the Service has no ready endpoints: `kubectl get endpointslices -n shop -l kubernetes.io/service-name=shop-api` — readiness probes failing or selector mismatch, which is [Services deep-dive](/networking/services-deep-dive/) territory. Check [events](/observability/events/) in both your namespace and (if you can see it) the Gateway's.
4. **Everything green, behavior still wrong.** Now it's plausibly the Gateway, listener TLS, or controller — the platform's layer. File a ticket with: route name/namespace, the full `status.parents` block, the Gateway/listener you target, one failing `curl -v` with timestamp, and what changed last. That's everything they need to grep their controller logs on the first pass — [working with the platform team](/operations/working-with-platform-team/) has the general template.

:::note
The clean division of debugging labor is the quiet payoff of the role split: if your HTTPRoute says `Accepted: True` and `ResolvedRefs: True` and your endpoints are ready, you have receipts that your layer is correct. Under Ingress, "the annotation was silently ignored" and "the controller is broken" looked identical from your seat.
:::

## Where it fits

Gateway API doesn't change the front-door topology — DNS still points at a load balancer, which still fronts a proxy fleet, which still routes to your Services. It changes *who edits what* to make that true, and gives your piece of it real feedback. The [front door architecture](/architectures/front-door/) article shows where the Gateway sits in the full edge picture, and [TCP ingress](/networking/tcp-ingress/) covers this same API's L4 side (TCPRoute, TLSRoute) when your traffic isn't HTTP at all. For the spec itself, conformance tables, and which features are core vs. extended vs. experimental, the authoritative source is [gateway-api.sigs.k8s.io](https://gateway-api.sigs.k8s.io/).
