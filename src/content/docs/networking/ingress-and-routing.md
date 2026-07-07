---
title: Ingress and Routing
description: Ingress resource anatomy, TLS termination, cert-manager, the Gateway API role split, and how to debug 502s and 504s.
keywords:
  - 502 bad gateway
  - 504 gateway timeout
  - ingressClassName ignored
  - pathType Prefix
  - TLS termination
  - cert-manager
  - Fake Certificate
  - reverse proxy
  - annotation silently ignored
  - empty endpoints
  - X-Forwarded-Proto
  - default backend 404
sidebar:
  order: 6
---

Services get traffic *to* pods; Ingress decides *which* Service based on HTTP — hostnames, paths, TLS. It's the layer where the division of labor between you and the platform team is sharpest: they run the **ingress controller** (the actual proxy pods, usually ingress-nginx, Traefik, HAProxy, or a cloud L7 LB), you write **Ingress resources** in your namespace declaring what you want routed. The controller watches all namespaces and merges everyone's rules into its config.

If no controller is running, an Ingress resource does exactly nothing. It's a wish, not a mechanism.

## Anatomy of an Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: orders
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "20m"
spec:
  ingressClassName: nginx          # which controller handles this — ask platform for the right value
  tls:
    - hosts:
        - orders.example.com
      secretName: orders-tls       # a kubernetes.io/tls Secret in YOUR namespace
  rules:
    - host: orders.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: orders
                port:
                  name: http
          - path: /healthz
            pathType: Exact
            backend:
              service:
                name: orders
                port:
                  name: http
```

The pieces that matter:

- **`ingressClassName`** — selects the controller. Clusters often run several (internal vs internet-facing). Omit it and your Ingress may be silently ignored, or picked up by a default class you didn't intend. Get the valid class names from your platform team; `kubectl get ingressclass` shows them if your RBAC allows.
- **`rules`** — matched by `host` first, then longest path. No matching rule → the controller's `default backend` (usually a 404).
- **`pathType`**:
  - `Prefix` — matches on `/`-separated segments: `/api` matches `/api` and `/api/v2`, **not** `/apiv2`.
  - `Exact` — the path and nothing else.
  - `ImplementationSpecific` — whatever the controller decides; with ingress-nginx this historically means regex-capable matching. Avoid unless you need controller-specific behavior, because it's not portable.
- **`tls`** — hostnames to terminate TLS for, and the Secret holding cert + key. The Secret must live in the same namespace as the Ingress.

## Controllers differ — annotations are dialect

The Ingress spec is deliberately minimal. Everything interesting — timeouts, body size limits, redirects, rewrites, sticky sessions, rate limits — lives in **controller-specific annotations**:

```yaml
metadata:
  annotations:
    # ingress-nginx dialect:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/affinity: "cookie"
```

Traefik, HAProxy, and cloud controllers each have entirely different annotation sets. Two consequences: (1) find out which controller your cluster runs *before* copy-pasting annotations from Stack Overflow — wrong-dialect annotations are silently ignored, no error, no effect; (2) your manifests aren't portable across clusters with different controllers. This annotation sprawl is a big part of why Gateway API exists (below). If your cluster runs the most common controller, [ingress-nginx in practice](/networking/ingress-nginx/) covers its annotation toolbox — timeouts, body size, gRPC, canaries — in working detail.

:::note[Ingress is HTTP-only]
The Ingress API routes HTTP(S) and nothing else. Postgres, MQ, MQTT, LDAP — anything speaking raw TCP or UDP needs a different door into the cluster: [TCP and non-HTTP ingress](/networking/tcp-ingress/) walks the full option ladder.
:::

:::caution[Silently ignored is the theme]
Wrong `ingressClassName`: ignored. Wrong annotation prefix: ignored. Backend Service name typo: accepted, routes to nothing. Always verify with `kubectl describe ingress orders` — a healthy one lists your backends *with pod endpoints resolved*, e.g. `orders:http (10.244.1.5:8080,10.244.2.7:8080)`. If it shows `<error: endpoints "orders" not found>` or no address, stop and fix that first.
:::

## The full request path

Know every hop, because a 502 can be born at any of them:

```text
client ──TLS──> external LB ──> ingress controller pod ──> (Service lookup) ──> your pod
        (1)         (2)                  (3)                                    (4)
```

1. Client resolves `orders.example.com` to the LB's IP (external DNS — often platform or corporate DNS team territory).
2. The external LB (cloud LB, [MetalLB](/controllers/metallb/), F5) forwards to the ingress controller pods — typically via their `LoadBalancer`/`NodePort` Service.
3. The controller matches host + path, then proxies to a backend. Important detail: ingress-nginx by default proxies **directly to pod IPs from the EndpointSlice**, not through the ClusterIP — so it does its own load balancing and reacts to readiness itself.
4. Your pod answers. Or doesn't.

If your namespace runs a [service mesh](/networking/service-mesh/), there's an extra hop the diagram hides: the sidecar in front of your pod, whose VirtualServices, retries, and timeouts shape routing on top of everything the ingress decided.

## TLS termination options

- **Terminate at the ingress** (most common) — the `tls:` block above; the controller decrypts, traffic to your pod is plain HTTP inside the cluster.
- **Terminate at the external LB** — the controller sees plain HTTP; you may still want `X-Forwarded-Proto` handling in your app.
- **Passthrough / re-encryption** — end-to-end TLS to your pod, for compliance or mTLS. Controller-specific (`ssl-passthrough` in nginx requires a controller flag only the platform team can set — ask).

For headers like `X-Forwarded-For` and preserving real client IPs across these hops, see [External load balancing](/networking/external-load-balancing/).

## cert-manager: certificates as resources

If the platform team installed cert-manager, you can request certificates declaratively instead of pasting PEM files into Secrets:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: orders-tls
spec:
  secretName: orders-tls          # cert-manager creates/renews this Secret
  dnsNames:
    - orders.example.com
  issuerRef:
    name: corp-ca                 # ClusterIssuer name — platform team tells you this
    kind: ClusterIssuer
```

cert-manager watches the Certificate, performs the issuance (ACME/Let's Encrypt, corporate CA, Vault), writes the Secret, and renews before expiry. Even simpler, most setups support the annotation shortcut on the Ingress itself: `cert-manager.io/cluster-issuer: corp-ca`, which auto-creates the Certificate. Check status with `kubectl describe certificate orders-tls` — the events tell you exactly where issuance is stuck (usually DNS validation or an issuer misconfiguration). Whether cert-manager exists, and which issuers you may use, is a platform team question; the CRD mechanics are covered in [CRDs explained](/controllers/crds-explained/).

## Gateway API: the successor, and why the role split is the point

This section is the orientation; the full tenant-seat treatment — HTTPRoute anatomy, weighted canaries, status conditions, ReferenceGrant — is in [Gateway API for App Teams](/networking/gateway-api/).

Ingress is being succeeded by the **Gateway API**, and its defining feature is exactly the org chart this guide assumes:

| Resource | Purpose | Owner |
|---|---|---|
| `GatewayClass` | "This kind of load balancer exists" (like IngressClass) | Platform / vendor |
| `Gateway` | An actual listener: IPs, ports, TLS certs, which namespaces may attach | **Platform team** |
| `HTTPRoute` | "Route these hosts/paths to my Services" | **You**, in your namespace |

You write an HTTPRoute and attach it to their Gateway:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: orders
spec:
  parentRefs:
    - name: shared-gateway
      namespace: infra-gateways     # platform-owned Gateway
  hostnames:
    - orders.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      backendRefs:
        - name: orders
          port: 80
```

What you get over Ingress: typed fields for header matching, traffic splitting (canary by weight!), redirects and rewrites — no annotation dialects. What changes operationally: the platform team controls *which namespaces may attach routes* to each Gateway (`allowedRoutes`), so onboarding a new hostname is an explicit, auditable handshake instead of a free-for-all. If your cluster offers Gateway API, prefer HTTPRoute for new services; check `kubectl api-resources | grep gateway`.

## Debugging 502/504 from the ingress

The two classic errors, decoded:

**502 Bad Gateway** — the controller reached out to your pod and got a broken/refused/reset connection.
**504 Gateway Timeout** — the controller waited and your pod never answered in time.

Work the chain:

```bash
# 1. Does the Ingress resolve to real endpoints?
kubectl describe ingress orders          # look for backends with pod IPs
# 2. Are the backends Ready? (empty EndpointSlice = guaranteed 502/503)
kubectl get endpointslices -l kubernetes.io/service-name=orders
# 3. Can YOU reach the Service from inside, bypassing the ingress?
kubectl run t --rm -it --image=nicolaka/netshoot -- curl -sv http://orders.myteam/api/ping
# 4. Reproduce through the ingress with the right Host header:
curl -kv https://orders.example.com/api/ping --resolve orders.example.com:443:<LB-IP>
```

Common root causes, in field-observed order of frequency:

1. **Rollout with no readiness overlap** — old pods gone, new pods not Ready yet → empty endpoints → burst of 502s. Fix probes and rollout settings ([rollouts and rollbacks](/workloads/rollouts-and-rollbacks/)).
2. **App timeout > proxy timeout** — your report takes 90 s, nginx's default `proxy-read-timeout` is 60 s → 504. Raise it via annotation.
3. **Pod closes keep-alive connections abruptly** (short app-side idle timeout) → intermittent 502s under load. Make your app's keep-alive timeout *longer* than the controller's upstream keep-alive.
4. **A NetworkPolicy blocking the controller's namespace** → every request 502s while in-namespace curl works — see [Network policies](/networking/network-policies/) for the allow-from-ingress rule.
5. **TLS Secret missing/expired** → controller serves its default self-signed cert ("Kubernetes Ingress Controller Fake Certificate" is the tell).

:::note[WebSockets and gRPC time out differently]
Long-lived streams don't behave like request/response at this hop: an idle WebSocket dies at the proxy's read timeout, and a controller reload or rollout can sever every open stream at once. [Long-lived connections](/networking/long-lived-connections/) covers the timeout and draining behavior in detail.
:::

If steps 1–3 all pass and the failure only occurs through the ingress, the controller's own logs hold the answer — those are platform-owned, so file a ticket with your timestamps, the exact URL, and the request ID header if your controller injects one.
