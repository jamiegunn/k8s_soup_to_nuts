---
title: "502, 503, 504 from the Front Door"
description: Symptom-first playbook for gateway errors at the corporate edge — fingerprint who minted the error, decode the code, bisect the layer in three curls, and fix the cause.
sidebar:
  order: 8
---

**Symptom:** clients get 502 Bad Gateway, 503 Service Unavailable, or 504 Gateway Timeout from your application's public URL. Maybe constantly, maybe in bursts, maybe only during deploys. Your pods look green. It's 2am.

Start with the good news, because it changes everything you do next: **a 5xx status code is evidence, not absence.** Something answered. A machine at layer 7 received the request, formed an opinion, and wrote an HTTP response — which means DNS resolved, TCP connected, and TLS (if any) handshook. You are *not* debugging a black hole; you're debugging a chain of proxies, and exactly one of them minted this error. If instead you're getting connection refused, connection timed out, or an empty reply — no status code at all — you're on the wrong page: that's [Service Unreachable](/troubleshooting/service-unreachable/).

In this topology the chain is: **client → corporate VIP (F5/NetScaler appliance) → MetalLB IP → ingress-nginx → Service → your pods** ([Life of a Request](/routing/life-of-a-request/) walks it hop by hop; [The Bare-Metal Front Door](/architectures/front-door/) is the platform build). Three of those layers can mint a 5xx: the appliance, nginx, and your app. First question, always: **which one wrote this response?**

## Step 1: Fingerprint who minted the error

Every layer signs its work. Grab one failing request with headers and body:

```bash
curl -sv https://api.apps.example.com/api/orders 2>&1 | tail -25
```

```console
< HTTP/1.1 502 Bad Gateway
< Date: Fri, 03 Jul 2026 02:14:07 GMT
< Content-Type: text/html
< Content-Length: 150
< Connection: keep-alive
<
<html>
<head><title>502 Bad Gateway</title></head>
<body>
<center><h1>502 Bad Gateway</h1></center>
<hr><center>nginx</center>
</body>
</html>
```

That bare, centered HTML with the `<hr><center>nginx</center>` footer is ingress-nginx's own error page — nginx minted this; the problem is between nginx and your pods. Compare the fingerprints:

| Minted by | Server / headers | Body shape |
|---|---|---|
| **ingress-nginx** | `Content-Type: text/html`, often no `Server` header (suppressed by config) | Bare HTML: `<h1>502 Bad Gateway</h1>` + `<hr><center>nginx</center>`. Terse, no branding |
| **F5 / NetScaler appliance** | `Server: BigIP` or appliance-flavored headers; sometimes a `Set-Cookie` for persistence | Branded HTML block page — "The requested URL was rejected… support ID: 4839…" or a corporate maintenance page with logos and CSS |
| **Your app** | `Server:` names your framework (`Kestrel`, `gunicorn`, `Jetty`); `Content-Type: application/json` is a giveaway | Structured: `{"error":"upstream timeout","traceId":"8f2c…"}` — your own error contract |

Three immediate conclusions:

- **App-shaped body** → the request traversed the *entire* front door successfully. Your app returned 5xx on purpose. This is application debugging — check `kubectl logs`, not the proxies.
- **nginx-shaped body** → the break is nginx → Service → pods. Everything in this page's "codes decoded" section applies. This is the common case.
- **Appliance-shaped body** → the error was minted *before* traffic ever reached the cluster. Jump to [when it's the layers you don't own](#when-its-the-layers-you-dont-own) — but run the bisect first so you escalate with proof.

:::note[The 2am shortcut]
If the body is JSON, it's your app. If it's ugly bare HTML, it's nginx. If it's *pretty* HTML with a support ID, it's the appliance. You can triage from the body shape alone before reading a single header.
:::

## Step 2: The three-curl bisect

Two minutes, three vantage points, and you know which layer is lying. Run them in this order — each curl adds one more layer to the path.

**Curl 1 — the app directly, bypassing everything:**

```bash
kubectl -n prod port-forward svc/api 8080:80 &
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" http://localhost:8080/api/orders
kill %1
```

```console
200 0.041s
```

**Curl 2 — through ingress-nginx, bypassing the appliance.** Hit the MetalLB IP (`10.20.0.30` in this topology — the `EXTERNAL-IP` on the controller's Service) with the real hostname, so nginx routes it like production traffic:

```bash
curl -sv -o /dev/null -w "%{http_code} %{time_total}s\n" \
  --resolve api.apps.example.com:443:10.20.0.30 \
  https://api.apps.example.com/api/orders
```

```console
200 0.049s
```

If the MetalLB IP isn't reachable from your workstation, run the same curl from a debug pod (`kubectl run curl --rm -it --image=curlimages/curl -- sh`) against the controller Service instead — same test, in-cluster vantage.

**Curl 3 — the full path through the corporate VIP** (this is just the normal URL; DNS points at the appliance):

```bash
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" https://api.apps.example.com/api/orders
```

```console
503 0.031s
```

**Read the matrix:**

| Curl 1 (app) | Curl 2 (nginx) | Curl 3 (VIP) | The minting layer is |
|---|---|---|---|
| 200 | 200 | 5xx | **Appliance / MetalLB path** — cluster is innocent; build the [evidence package](#when-its-the-layers-you-dont-own) |
| 200 | 5xx | 5xx | **nginx → pods** — decode the code below; check Ingress rules, endpoints, timeouts |
| 5xx | 5xx | 5xx | **Your app** — logs, dependencies, resources; the front door is just the messenger |
| hangs/refused | 5xx | 5xx | **Service wiring** — no HTTP at all from the pod: [Service Unreachable](/troubleshooting/service-unreachable/), hops 1–5 |

:::tip[Intermittent errors need a loop, not a curl]
One 200 proves nothing during a flapping incident. Loop it: `while true; do curl -s -o /dev/null -w "%{http_code}\n" <url>; sleep 1; done` at each vantage point, and compare *error rates* per layer. A 3% 502 rate at curl 3 with 0% at curl 2 convicts the appliance path just as firmly.
:::

## The codes decoded

Same three digits, three very different stories. The one-line versions first:

| Code | nginx is saying | First check |
|---|---|---|
| **502** | "I reached a pod and the conversation broke" — refused, reset, or garbage | Rollout in progress? Then targetPort, then restarts |
| **503** | "Your Service has no ready backends at all" | `kubectl get pods` — is anything `1/1`? Then the Ingress backend reference |
| **504** | "A pod took the request and never answered in time" | Is it failing at *exactly* 60s? That's the default timeout, not your app's speed |

All of these assume the nginx fingerprint — nginx minted the error about *its* upstream, which is your pods.

### 502 Bad Gateway — "I reached out and got garbage"

nginx connected (or tried to connect) to a pod IP and the conversation failed: connection refused, connection reset, or a malformed/premature response. Causes, in the order you should check them:

**1. Pods down mid-rotation (the deploy race).** By far the most common. 502s in bursts that correlate exactly with rollouts = nginx routing to pods that are terminating or not yet warm. Check timing first:

```bash
kubectl -n prod rollout history deployment/api
kubectl -n prod get pods -l app=api --sort-by=.metadata.creationTimestamp
```

Pods younger than the error burst → it's the rollout. See [the deploy-correlated section](#deploy-correlated-5xx-the-shutdown-race) below.

**2. Wrong targetPort — connection refused on every request.** The Service forwards to a port nothing listens on. nginx gets an instant RST and mints a 502 (the access log shows `upstream_status: -` — it never got HTTP back). Verify the chain:

```bash
kubectl -n prod get svc api -o jsonpath='{.spec.ports[0].targetPort}'; echo
kubectl -n prod exec deploy/api -- ss -tln
```

If `targetPort: 8080` but the process listens on `:5000`, there's your outage — every request, forever, pods green. Fix the Service. Full port-chain walkthrough in [Service Unreachable](/troubleshooting/service-unreachable/).

**3. App crashing or resetting under load.** The pod accepts the connection, starts a response, then dies mid-request — OOM kill, panic, worker recycle. Signature: *intermittent* 502s that scale with traffic, plus restarts:

```bash
kubectl -n prod get pods -l app=api
# RESTARTS column climbing? kubectl logs <pod> --previous, and check for OOMKilled.
```

**4. The stale-keepalive classic.** nginx keeps idle keepalive connections open to your pods and *reuses* them. If your app's idle timeout is **shorter** than nginx's, the app closes the socket, nginx doesn't notice, sends the next request down the corpse, and gets a reset → sporadic 502s at low-to-moderate traffic, `upstream prematurely closed connection` in the controller log, completely unreproducible with a single curl. The fix is an inequality: **app idle keepalive timeout > nginx's upstream keepalive timeout** (60s by default). Set your app's keep-alive idle timeout to 75–120s, or ask platform what `upstream-keepalive-timeout` is set to and stay above it. Details in [ingress-nginx](/networking/ingress-nginx/).

**5. TLS mismatch to the backend.** nginx speaks plain HTTP/1.1 to upstreams by default. If your pod only serves HTTPS (or gRPC), nginx's HTTP bytes hit a TLS listener and the handshake garbage becomes a 502 on *every* request:

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"   # or "GRPC"
```

### 503 Service Unavailable — "I have nowhere to send this"

nginx is healthy, your route exists, and the upstream list is *empty*. This is almost never nginx's fault — it's an accurate report that your Service has no ready backends.

**1. Zero ready endpoints — the readiness cascade.** All replicas failing readiness at once (shared dependency down, probe checking a dead DB) removes *every* pod from the Service, and nginx mints eternal 503s while every pod shows `Running`:

```bash
kubectl -n prod get pods -l app=api
```

```console
NAME                   READY   STATUS    RESTARTS   AGE
api-7d4b9c6f8-2xkqp    0/1     Running   0          31m
api-7d4b9c6f8-9wlmn    0/1     Running   0          31m
api-7d4b9c6f8-fx8dh    0/1     Running   0          31m
```

`0/1` across the board is the whole diagnosis. `kubectl describe pod` → probe events → fix whatever the probe checks. The controller log confirms it verbatim: `Service "prod/api" does not have any active Endpoint`. Why probes cascade and how to design them so one flaky dependency can't zero your fleet: [Health Checks](/workloads/health-checks/).

**2. The Ingress points at a Service or port that doesn't exist.** Same empty-upstream 503, but the pods *are* ready — the route references `api-svc` after a rename to `api`, or port `8080` where the Service exposes `80`:

```bash
kubectl -n prod describe ingress api | grep -A6 Rules
# Backends showing "<error: services 'api-svc' not found>" = there's your bug.
```

**3. Rate limiting.** ingress-nginx rate-limit annotations (`limit-rps`, `limit-connections`) reject over-limit requests with 503 by default. Signature: 503s only under burst load, only for some clients, pods perfectly healthy. Check the Ingress annotations before blaming capacity.

**4. Maintenance mode someone forgot.** A `default-backend` annotation pointed at a maintenance Service, an appliance maintenance page (that's a *branded* 503 — check the fingerprint), or a leftover "temporarily disabled" Ingress from the last change window. `kubectl get ingress -o yaml | grep -i annotation` and recent change history.

### 504 Gateway Timeout — "I asked, and nobody answered in time"

nginx connected fine, sent the request, and gave up waiting for the response. The upstream is *slow*, not down.

**1. `proxy-read-timeout` vs your p99 — the 60-second wall.** ingress-nginx defaults: `proxy-connect-timeout: 5`, `proxy-send-timeout: 60`, `proxy-read-timeout: 60`. Any response that takes longer than 60s to send a byte gets a 504 *no matter what your app eventually does*. The tell is brutal in its consistency — **504s at exactly 60.0 seconds**:

```bash
curl -s -o /dev/null -w "%{http_code} in %{time_total}s\n" https://api.apps.example.com/api/reports/annual
# 504 in 60.014s      ← not "about a minute". Exactly the timeout.
```

If the endpoint legitimately takes longer (reports, exports), raise it on *that* Ingress — not globally:

```yaml
nginx.ingress.kubernetes.io/proxy-read-timeout: "300"   # seconds, no unit suffix
```

Full timeout inventory in [ingress-nginx](/networking/ingress-nginx/). And ask the harder question: should a 4-minute synchronous request exist, or should this be a job?

**2. Slow downstream chains.** Your app is waiting on *its* dependency — a database, another team's API — and the wait surfaces as your 504. The app logs show the request arriving and the downstream call hanging; `upstream_response_time` in the access log ≈ the timeout, and your own traces show where the time went. Fix the dependency or add an app-side timeout *shorter* than nginx's, so clients get your structured error instead of nginx's bare one.

**3. Long-poll / SSE / WebSocket misclassified as "slow".** A stream that idles 60s between events looks exactly like a hung request to nginx, which kills it — clients see 504s or silent drops on their long-lived connections. These need `proxy-read-timeout`/`proxy-send-timeout` raised (e.g. `"3600"`) and, for SSE, `proxy-buffering: "off"`. The whole genre: [Long-Lived Connections](/networking/long-lived-connections/).

## Deploy-correlated 5xx: the shutdown race

502/503 bursts that start the moment a rollout begins and stop when it settles are the most common front-door incident there is, and the mechanism is always the same race: a pod receives SIGTERM and starts dying *before* nginx has removed it from the upstream list — or nginx adds a new pod *before* it's actually warm. Confirm from the events timeline ([Events](/observability/events/)):

```bash
kubectl -n prod get events --sort-by=.lastTimestamp | tail -12
```

```console
02:13:58   Normal    ScalingReplicaSet   deployment/api      Scaled up replica set api-84c5d9f6b to 2
02:14:01   Normal    Killing             pod/api-7d4b9c6f8-2xkqp   Stopping container api
02:14:02   Warning   Unhealthy           pod/api-84c5d9f6b-2rlqn   Readiness probe failed: connect refused
02:14:07   ...                            ← your 502 burst timestamp lands right here
```

`Killing` events bracketing the error burst = the shutdown race, proven. The fix is not "roll out more slowly" — it's making pods drain correctly: a `preStop` sleep so nginx's endpoint update outruns the SIGTERM, graceful shutdown in the app, honest readiness probes, and sane `maxUnavailable`. The complete recipe is [Zero-Downtime Deployments](/architectures/zero-downtime/); rollout mechanics and how to pause/undo a bad one are in [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/).

:::tip[The 30-second check during any 5xx incident]
`kubectl -n prod rollout history deployment/api` plus pod ages. If pods are younger than the incident, you're probably in this section, and `kubectl rollout undo` is the fastest mitigation while you diagnose.
:::

## Reading the ingress-nginx access log line

The controller's access log is the ground truth for who returned what. You usually can't read it yourself — ask platform for a slice ("access log for host api.apps.example.com, 02:10–02:20 UTC, include upstream fields"). Here's a real 502 line and what it says:

```console
10.0.5.40 - - [03/Jul/2026:02:14:07 +0000] "GET /api/orders HTTP/1.1" 502 150
  "-" "curl/8.5.0" 87 0.007 [prod-api-80]
  [] 10.42.3.17:8080, 10.42.5.22:8080  0, 0  0.003, 0.004  502, 502  8f2c41d0be
```

Decode, field by field:

- `10.0.5.40` — the client IP as nginx saw it. That's the *appliance's* address: real client IPs are being lost at the VIP (a `X-Forwarded-For`/PROXY-protocol story — [NAT and the disappearing client IP](/routing/nat/)).
- `502 150` — status and bytes sent to the client. The 502 the user saw.
- `[prod-api-80]` — the upstream pool: namespace-service-port. Confirms which Ingress rule matched — wrong pool name here means a routing bug, not a backend bug.
- `10.42.3.17:8080, 10.42.5.22:8080` — **two** upstream addresses, comma-separated: nginx tried a pod, failed, and *retried* on a second pod (`proxy-next-upstream`). Both listed.
- `502, 502` — `upstream_status`, one per attempt. Both pods returned garbage → the whole backend is sick, not one bad pod. A single `-` here means nginx never got HTTP at all (connection refused/reset — think targetPort or mid-termination).
- `0.003, 0.004` — `upstream_response_time` per attempt. Milliseconds to fail = refused/reset (502-shaped). If you're diagnosing a 504, this field ≈ the configured timeout, which is the smoking gun for the 60-second wall.

One log line just told you: request routed correctly, two pods tried, both instantly unhealthy, retry didn't save it. That's five minutes of curl experiments, compressed.

## When it's the layers you don't own

Curl matrix says cluster-is-green, VIP-is-broken (row 1). Two usual suspects, and neither is fixable with kubectl — your job is the evidence package. The two-layer edge and why it exists: [External Load Balancing](/networking/external-load-balancing/).

**Appliance health monitor flapping.** The F5/NetScaler probes its pool member (the MetalLB IP) on a health monitor the network team configured — and if that monitor is misconfigured (wrong path, wrong port, too-tight timeout) or intermittently failing, the appliance marks the pool down and serves *its own* 503 page while the cluster is perfectly healthy. Fingerprint: branded 503 at curl 3, clean 200s at curl 2, all day. Classic trigger: the monitor points at a `healthCheckNodePort` on a node that no longer runs a controller pod (an `externalTrafficPolicy: Local` consequence — [NAT](/routing/nat/)).

**MetalLB announcement lost.** With L2 mode, exactly one node answers ARP for `10.20.0.30`. If the speaker on that node dies, or failover leaves the appliance with a stale ARP entry, packets to the pool member evaporate — the appliance sees its monitor fail, marks the pool down, and mints 503s. From your side: curl 2 (the MetalLB IP) times out *from outside the cluster* while in-cluster access works. Speaker mechanics and the "allocated but unannounced" trap: [MetalLB](/controllers/metallb/).

**The evidence package** — per layer owner, timestamped, so the ticket lands as a fix and not a ping-pong:

| To | Attach |
|---|---|
| **Network team** (appliance) | The branded error body + `curl -sv` headers from curl 3; proof curl 2 returns 200 at the same timestamps; the VIP name/IP and hostname; error rate and exact time window |
| **Platform team** (MetalLB / controller) | Curl 2 output from outside *and* inside the cluster; `kubectl get svc -n ingress-nginx` showing the `EXTERNAL-IP`; your namespace's endpoint health (`kubectl get endpointslices`); the request timestamps for a log slice |

## Prevention

- **Alert on "Service has 0 ready endpoints"** — it fires before the first user-facing 503 and names the cause in the alert title.
- **Fix the shutdown race once**: preStop sleep + graceful SIGTERM handling + readiness that reflects real serving ability. Do the [zero-downtime](/architectures/zero-downtime/) checklist and deploy-time 5xx bursts stop being a genre.
- **Know your p99 vs the 60s default.** Any endpoint within shouting distance of `proxy-read-timeout` gets an explicit annotation — or gets redesigned as async.
- **Keepalive inequality in the runbook**: app idle timeout > nginx upstream keepalive timeout. Check it whenever either side's config changes.
- **Declare backend protocol explicitly** (`backend-protocol: HTTPS`/`GRPC`) the day the pod stops speaking plain HTTP, not the day of the incident.
- **Synthetic checks at two vantage points** — through the VIP *and* against the MetalLB IP. When they disagree, you've pre-run curl 2 vs curl 3 and the page tells you which team to wake.
- **Rehearse the bisect** in a game day. The three curls are only a 2-minute diagnosis if the MetalLB IP and controller Service name are already in the runbook.

## Which page next

| You're seeing | Go to |
|---|---|
| Connection refused / timeout / empty reply — **no HTTP status at all** | [Service Unreachable](/troubleshooting/service-unreachable/) — the hop-by-hop chain walk |
| 5xx plus other weirdness, no idea where to start | [Triage Methodology](/troubleshooting/triage-methodology/) — what changed, blast radius, cheapest test first |
| Errors only on WebSockets, SSE, gRPC streams | [Long-Lived Connections](/networking/long-lived-connections/) |
| You need the routing rules, annotations, timeout inventory | [ingress-nginx](/networking/ingress-nginx/) and [Ingress and Routing](/networking/ingress-and-routing/) |
| You want to understand (or build) the whole edge stack | [The Bare-Metal Front Door](/architectures/front-door/) |

The front door has a lot of layers, but it always tells you which one broke — in the body shape, the log line, or the curl matrix. Read the evidence before you restart anything.
