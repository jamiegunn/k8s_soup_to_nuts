---
title: ingress-nginx in Practice
description: The de facto Ingress controller from the tenant seat — annotations that actually matter, timeouts, TLS fallback traps, canaries, and debugging 502/504s.
sidebar:
  order: 12
---

Most clusters you'll ever touch route HTTP through **ingress-nginx**. The generic Ingress model — resource anatomy, host/path rules, pathTypes, the controller/resource split — lives in [Ingress and Routing](/networking/ingress-and-routing/). This page is the controller-specific layer: the annotations, defaults, and failure modes of ingress-nginx specifically, from the seat of someone who owns Ingress resources but not the controller.

## Which nginx do you have?

There are two unrelated projects with nearly identical names, and copy-pasting annotations from the wrong one's docs **silently does nothing** — no error, no event, no effect:

| | kubernetes/ingress-nginx | NGINX Inc kubernetes-ingress |
|---|---|---|
| Maintainer | Kubernetes community | F5/NGINX Inc |
| Controller value | `k8s.io/ingress-nginx` | `nginx.org/ingress-controller` |
| Annotation prefix | `nginx.ingress.kubernetes.io/` | `nginx.org/` and `nginx.com/` |
| Docs domain | kubernetes.github.io/ingress-nginx | docs.nginx.com |

This article covers the **community** controller. Confirm which one you have before touching an annotation:

```bash
kubectl get ingressclass -o wide
```

```console
NAME    CONTROLLER             PARAMETERS   AGE
nginx   k8s.io/ingress-nginx   <none>       412d
```

`k8s.io/ingress-nginx` in the CONTROLLER column means community. `nginx.org/ingress-controller` means F5's product and different docs. If you can see the controller pods, the image name settles it (`registry.k8s.io/ingress-nginx/controller` vs `nginx/nginx-ingress`). If you can see neither, ask the platform team — it's a one-line Slack question that saves an afternoon of annotations doing nothing.

:::caution
An annotation with a typo or the wrong prefix is just inert metadata. Kubernetes validates nothing about annotation keys. If an annotation "isn't working," step one is always: right prefix, exact spelling, value quoted as a string.
:::

## How it actually works (enough to debug it)

The controller pods run a real nginx. The controller process watches Ingresses, Services, EndpointSlices, and Secrets across the cluster and compiles all of them into one big `nginx.conf` — every team's Ingress rules merged into one config. On changes it re-renders, and for changes Lua can't handle dynamically (new hosts, certs, config), reloads nginx. On clusters with thousands of Ingresses and certificates this render/reload cycle gets slow, which is why your change can take tens of seconds to take effect on a busy shared controller.

The request path:

```text
client → LB → controller Service → controller pod (nginx) → proxy_pass → POD IP:port
```

The part that surprises people: nginx proxies to **pod IPs directly**, not to your Service's ClusterIP. It reads endpoints from EndpointSlices and load-balances across them itself. Two consequences:

- Your Service's `spec` mostly just selects pods; kube-proxy is not in this path.
- **Readiness gates membership.** A pod failing its readiness probe drops out of nginx's upstream list. If "the Ingress returns 503" the first question is whether any pods are Ready — see [Health Checks](/workloads/health-checks/).

## The annotation toolbox

Everything below goes under `metadata.annotations` on *your* Ingress. Values are strings — quote them.

### Timeouts — the 60-second 504

Defaults: `proxy-connect-timeout: 5`, `proxy-send-timeout: 60`, `proxy-read-timeout: 60`. Any endpoint that takes longer than 60s to send a byte gets a 504 from nginx, regardless of what your app eventually does. This is the single most common "mysterious 504" cause.

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "10"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"   # seconds, no unit suffix
```

### Body size — the 413 classic

Default `proxy-body-size` is **1m**. First file-upload feature to ship hits it.

```yaml
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"   # "0" disables the check
```

### Buffering — streaming and SSE

By default nginx buffers both directions. Response buffering breaks SSE and chunked streaming (client sees nothing until the buffer flushes); request buffering breaks streaming uploads.

```yaml
    nginx.ingress.kubernetes.io/proxy-buffering: "off"           # responses (SSE, streaming)
    nginx.ingress.kubernetes.io/proxy-request-buffering: "off"   # request bodies (uploads)
```

### Redirects and rewrites

`rewrite-target` rewrites the path before proxying. With a regex path and capture group:

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
spec:
  ingressClassName: nginx
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /orders(/|$)(.*)
            pathType: ImplementationSpecific
            backend:
              service:
                name: orders
                port:
                  number: 8080
```

The footgun: `rewrite-target` with `$n` makes **every path in that Ingress** a regex. `pathType: Prefix` semantics no longer apply the way you think, and other paths on the same host in the same Ingress are affected. Keep rewrite Ingresses separate from plain ones.

HTTPS redirects: `ssl-redirect` (default `"true"` when the host has TLS configured) redirects HTTP→HTTPS; `force-ssl-redirect: "true"` does it even without a TLS block — needed when TLS terminates upstream at a cloud LB.

### Sticky sessions

```yaml
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/session-cookie-name: "route"
    nginx.ingress.kubernetes.io/session-cookie-max-age: "3600"
```

nginx sets a cookie pinning the client to one pod. It survives scale-ups but not the pinned pod dying. If you *need* stickiness for correctness, that's usually in-memory session state that belongs in Redis or a database — stickiness is a smell, and it interacts badly with rollouts and long-lived connections; see [Long-Lived Connections](/networking/long-lived-connections/).

### Rate limiting

```yaml
    nginx.ingress.kubernetes.io/limit-rps: "20"          # requests/sec per client IP
    nginx.ingress.kubernetes.io/limit-connections: "10"  # concurrent per client IP
```

Exceeding clients get **503** (default), which looks exactly like "backend down" in your dashboards. If you add rate limits, tell whoever reads the alerts. Note the limit keys on client IP — behind a CDN without real-IP config, all traffic looks like one client and you rate-limit everyone at once.

### CORS

```yaml
    nginx.ingress.kubernetes.io/enable-cors: "true"
    nginx.ingress.kubernetes.io/cors-allow-origin: "https://app.example.com"
    nginx.ingress.kubernetes.io/cors-allow-methods: "GET, POST, PUT, DELETE, OPTIONS"
    nginx.ingress.kubernetes.io/cors-allow-credentials: "true"
```

Handles preflight OPTIONS at the edge so your app never sees them. Don't *also* set CORS headers in the app — duplicated `Access-Control-Allow-Origin` headers are themselves a CORS failure in browsers.

### backend-protocol

nginx speaks HTTP/1.1 to upstreams by default. If your pod serves HTTPS or gRPC, you must say so or you get 502s (or gRPC's `code 14`):

```yaml
    nginx.ingress.kubernetes.io/backend-protocol: "GRPC"   # or HTTPS, GRPCS; default HTTP
```

### Source IP allowlisting

```yaml
    nginx.ingress.kubernetes.io/whitelist-source-range: "10.0.0.0/8,192.168.10.0/24"
```

This filters on the client IP **nginx sees**. If the external LB doesn't preserve source IPs (no `externalTrafficPolicy: Local`, no PROXY protocol) or you're behind a CDN without `use-forwarded-headers`/real-ip config on the controller, nginx sees the LB/CDN IP and you'll either block everyone or allow everyone. Verify what IP actually arrives before trusting this — it's a controller-level (platform) setting.

### Auth

```yaml
    # Basic auth from a secret you create (htpasswd format, key "auth")
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: ops-basic-auth
    nginx.ingress.kubernetes.io/auth-realm: "Restricted"
```

For real auth, `auth-url` makes nginx send a subrequest to an external service per request; non-2xx blocks the request. That's how oauth2-proxy integrations work — powerful, but every request now depends on the auth service being up and fast.

## WebSockets, SSE, gRPC

- **WebSockets** mostly just work — nginx handles the Upgrade automatically. What kills them is the 60s `proxy-read-timeout`/`proxy-send-timeout` on idle sockets. Raise both on the WebSocket Ingress (e.g. `"3600"`) and keep application-level pings under that interval.
- **gRPC** needs `backend-protocol: "GRPC"` *and* TLS on the Ingress (nginx only serves HTTP/2 on the TLS listener). Without the annotation: 502s and `RST_STREAM` weirdness.
- **SSE/streaming** needs `proxy-buffering: "off"` plus a long `proxy-read-timeout`.

Every hop's timeout has to agree for long-lived traffic — the full treatment is in [Long-Lived Connections](/networking/long-lived-connections/).

## configuration-snippet: probably disabled, and rightly

`configuration-snippet` and `server-snippet` inject raw nginx config from your annotation into the shared config. Arbitrary config injection into a proxy that handles *every team's* traffic and holds *every team's* TLS keys is how CVE-2021-25742 happened (snippet annotations could exfiltrate cluster secrets). Most platforms now disable snippets (`allow-snippet-annotations: false`), and newer controllers add `annotations-risk-level` gating risky annotations generally.

If your Ingress needs something only a snippet used to provide: check whether a first-class annotation now exists (the toolbox above covers most historical snippet uses), and otherwise take it to the platform team as a request for a supported annotation or a global controller setting — see [Working with the Platform Team](/operations/working-with-platform-team/). Don't burn a day discovering your snippet is silently stripped.

## TLS

```yaml
spec:
  tls:
    - hosts: ["api.example.com"]
      secretName: api-example-com-tls   # kubernetes.io/tls secret in YOUR namespace
```

The secret lives in your namespace ([Secrets](/workloads/secrets/) covers creation and cert-manager). The trap is the fallback: if the secret is **missing, misnamed, malformed, or doesn't cover the host**, nginx doesn't error your Ingress — it serves the controller's *default certificate*. If that default is the self-signed **"Kubernetes Ingress Controller Fake Certificate"**, browsers scream; if platform installed a wildcard default, you might not even notice until someone hits a name it doesn't cover. Diagnose from outside:

```bash
openssl s_client -connect api.example.com:443 -servername api.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer
```

```console
subject=O=Acme Co, CN=Kubernetes Ingress Controller Fake Certificate
issuer=O=Acme Co, CN=Kubernetes Ingress Controller Fake Certificate
```

That output = your TLS secret isn't being used. Check `kubectl describe ingress` events and `kubectl get secret api-example-com-tls`.

`ssl-passthrough: "true"` skips termination entirely and streams TLS to your pod based on SNI. It requires the controller to run with `--enable-ssl-passthrough` (platform decision), and you lose every L7 feature for that host — no path routing, no rewrites, no rate limits, nothing above TCP.

## Debugging from the tenant seat

Always start with:

```bash
kubectl describe ingress orders
```

Read the `Backends` lines (are there endpoint IPs, or `<none>`?) and Events (the controller reports rejected/ignored config here). `<none>`/no endpoints means a Service/selector/readiness problem, not an nginx problem — work through [Service Unreachable](/troubleshooting/service-unreachable/).

**Controller logs.** The access log is the ground truth for "who returned this error." Key fields: `status` (what the client got), `upstream_status` (what *your pod* returned — a `-` means nginx never reached it), `upstream_response_time`, and `upstream_addr` (which pod IP was tried; multiple comma-separated addresses mean retries). You typically can't read them yourself — ask platform for a slice: *"access log lines for host api.example.com between 14:00–14:10 UTC, please include upstream_addr and upstream_response_time"*. If you do have read access:

```bash
kubectl logs -n ingress-nginx deploy/ingress-nginx-controller | grep api.example.com | tail -5
```

**Error fingerprints.** Learn to tell nginx's errors from your app's: the plain `404 Not Found` from the default backend means *no Ingress rule matched at all* (wrong host/path/class). nginx's own bare-HTML `502 Bad Gateway` / `503 Service Temporarily Unavailable` / `504 Gateway Time-out` pages mean nginx couldn't get a good answer from your pods (connection refused / no ready endpoints / timeout respectively). Your app's errors look like your app. `curl -v` the URL and look at the body and `Server` header.

**Config spelunking** (if platform grants controller pod access) via the krew plugin:

```bash
kubectl ingress-nginx backends -n ingress-nginx --deployment ingress-nginx-controller | jq '.[].name'
kubectl ingress-nginx conf -n ingress-nginx --host api.example.com
```

That prints the actual generated `server {}` block — the final word on what nginx will do with a request.

## Canary deployments

ingress-nginx gives tenants traffic splitting without a mesh: a **second** Ingress with the same host/path, marked canary, pointing at the new Service.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: orders-canary
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"                  # 10% of traffic
    # or route deterministically instead of by weight:
    # nginx.ingress.kubernetes.io/canary-by-header: "X-Canary"      # value "always"/"never"
spec:
  ingressClassName: nginx
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: orders-v2
                port:
                  number: 8080
```

Gotchas: **one canary Ingress per host/path rule set** — a second one for the same rules is ignored; header/cookie rules take precedence over weight; weight-based splitting is per-request, so without session affinity a single user bounces between versions (fine for stateless APIs, jarring for UIs); and remember to delete the canary Ingress after promoting, or it keeps splitting forever.

## Quick reference: symptom → fix

| Symptom | Likely cause | Fix |
|---|---|---|
| `413 Request Entity Too Large` on upload | 1m default body limit | `proxy-body-size: "50m"` |
| 504 after exactly 60s | default read/send timeout | `proxy-read-timeout` / `proxy-send-timeout` |
| 502 on gRPC, HTTP works | nginx speaking HTTP/1.1 to backend | `backend-protocol: "GRPC"` (TLS Ingress required) |
| 502, `upstream_status: -` in logs | pod refusing connections / wrong port | check containerPort vs Service targetPort |
| 503, endpoints `<none>` in describe | no Ready pods behind Service | readiness probe / selector — [Health Checks](/workloads/health-checks/) |
| Intermittent 503 under load | your own rate-limit annotations | `limit-rps` / `limit-connections` values |
| Wrong cert / "Fake Certificate" | TLS secret missing/invalid/wrong host | fix `secretName`, check secret contents |
| SSE/streaming responses arrive in bursts | response buffering | `proxy-buffering: "off"` |
| WebSockets drop after ~60s idle | read/send timeout | raise both timeouts, app-level pings |
| Sticky sessions broken behind CDN | affinity keyed on client IP visibility / cookie stripped | controller real-IP config (platform), check CDN cookie handling |
| Allowlist blocks everyone | nginx sees LB IP, not client IP | real client IP config — platform-level |
| Annotation has no effect | wrong prefix (`nginx.org/`?), typo, snippets disabled | verify controller flavor, spelling, platform policy |

For non-HTTP traffic — databases, queues, raw TCP — none of this applies; that's the next article's territory.
