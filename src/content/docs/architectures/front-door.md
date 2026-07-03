---
title: "The Bare-Metal Front Door: MetalLB + ingress-nginx + cert-manager"
description: The complete bare-metal HTTP(S) edge — a corporate VIP on the network team's appliance pooled to one MetalLB IP, an HA ingress-nginx behind it, cert-manager issuing TLS, and wildcard DNS — built end to end with verification drills.
sidebar:
  order: 8
---

Most of this site is written for teams who own their applications but not the cluster. This article is the exception: it is the **platform-side build** — the stack your platform team runs so that your `Ingress` resource turns into a URL. We assemble the whole thing end to end for two audiences: app teams who want to debug against the edge (and propose fixes with evidence, per [Working with Your Platform Team](/operations/working-with-platform-team/)), and smaller shops wearing both hats who need to build it themselves.

This is the exact stack the [MetalLB article](/controllers/metallb/) calls "the front door" — with one corporate-reality layer on top: MetalLB announces **one IP** for the whole cluster's HTTP traffic, ingress-nginx sits behind it, cert-manager issues certificates — and the address clients actually hit is a **corporate VIP on the network team's load-balancer appliance** (an F5 BIG-IP, a NetScaler), which pools 80/443 down to the MetalLB IP. The wildcard DNS record points at the *corporate* VIP, not at MetalLB.

## Architecture

The single most misunderstood thing about this design: **there are two "load balancer" layers, and they are owned by different teams.** The appliance is the client-facing edge — its VIP is what DNS resolves to, and the network team owns it, patches it, and monitors it, exactly as they do for every non-Kubernetes app in the company. MetalLB is pods running *inside* the cluster that make cluster *nodes* answer for the pool-member IP the appliance forwards to. The full chain: client → corporate VIP (appliance) → MetalLB IP (announced by in-cluster speakers) → kube-proxy/Service → ingress-nginx pods. The two-layer pattern, and why enterprises insist on it, is [External Load Balancing](/networking/external-load-balancing/).

```text
     clients (browsers, curl, other systems)
              │  DNS: *.apps.example.com → 10.0.5.40
              ▼
 ┌───────────────────────────────┐
 │ corporate LB appliance        │  Network-team-owned (F5, NetScaler).
 │ VIP 10.0.5.40 :80/:443        │  L4 passthrough; pool member for
 │ pool ► 10.20.0.30 :80/:443    │  both ports = the MetalLB IP below.
 └───────────────┬───────────────┘
═════════════════╪═════════════════ cluster boundary ═══════════════
                 │  ARP: "who has 10.20.0.30?"
                 ▼
 ┌─ node-b answers (elected by in-cluster MetalLB speaker pods) ──┐
 │                                                                │
 │   MetalLB IP 10.20.0.30 ──► Service ingress-nginx-controller   │
 │                        (type=LoadBalancer, eTP=Local)          │
 │                              │                                 │
 │                ┌─────────────┴─────────────┐                   │
 │                ▼                           ▼                   │
 │   ┌─────────────────────┐     ┌─────────────────────┐          │
 │   │ ingress-nginx pod 1 │     │ ingress-nginx pod 2 │          │
 │   │ (node-b)            │     │ (node-c)            │          │
 │   └──────────┬──────────┘     └──────────┬──────────┘          │
 │              │  routes by Host/path per Ingress objects        │
 │              ▼                           ▼                     │
 │        Service shop-web            Service api-gw   ...        │
 │              │                           │                     │
 │              ▼                           ▼                     │
 │          app pods                    app pods                  │
 └────────────────────────────────────────────────────────────────┘

 cert-manager (in-cluster) issues TLS certs; DNS: *.apps.example.com → 10.0.5.40
```

### Design goals

- **One corporate VIP, one MetalLB IP, for all HTTP(S) apps.** Every HTTP application shares the pair `10.0.5.40 → 10.20.0.30`; ingress-nginx fans out by `Host` header. This is why both the appliance config and the address pool stay small — HTTP virtual hosting means neither the VIP count nor the pool-member count grows with app count. Raw TCP services (databases, brokers) can't share a port by hostname and get their own VIPs and pools via [TCP ingress](/networking/tcp-ingress/) or dedicated LoadBalancer Services — budgeted separately, on both layers.
- **HA at the edge.** Two+ controller replicas spread across nodes, a PDB, and VIP failover. The edge is the one component whose downtime takes out *everything* — see [High Availability](/workloads/high-availability/).
- **Boring TLS.** cert-manager + ACME, a wildcard default certificate so no tenant ever sees the "Kubernetes Ingress Controller Fake Certificate."

### Who runs what

Three parties, three layers. The **network team** owns the appliance: the corporate VIP, its pool and health monitor, the wildcard DNS record, and the firewall rules that let the internet reach it. The **platform team** owns everything from the MetalLB pool inward — the address pool, ingress-nginx, cert-manager — which is the rest of this article. **App teams** consume exactly two things: **Ingress resources** (the contract in [Ingress & Routing](/networking/ingress-and-routing/)) and **DNS names** under `*.apps.example.com`. If you're an app team reading this, the tenant contract section below is your interface; the rest is the machinery behind it. The platform↔network seam is a ticket queue, not a kubectl command — treat it with the same evidence discipline as [Working with Your Platform Team](/operations/working-with-platform-team/).

### The corporate VIP layer

Everything the network team needs from you fits on one page, and getting it right up front saves weeks of ticket ping-pong:

- **Pool members are `10.20.0.30:80` and `10.20.0.30:443`** — the MetalLB IP, one member per port. Not node IPs (they change on every scale event), not NodePorts (that's a different, worse design). MetalLB handles node failover *behind* the pool member; the appliance never needs to know which node currently answers ARP for `.30`.
- **Mode: L4 passthrough (TCP profile), not L7 termination.** The appliance forwards raw TCP on both ports; TLS terminates at ingress-nginx. This is the default here because it keeps cert-manager, SNI routing, and per-Ingress TLS config working untouched — see the TLS decision below.
- **Health monitor: TCP connect to `10.20.0.30:443`** at minimum; better, an HTTPS monitor requesting `GET /healthz` and expecting `200` (ingress-nginx answers `/healthz` on the listener). The monitor is what stops the appliance from black-holing traffic when the cluster edge is down — and its state is your fastest "is the outer layer healthy" signal during incidents.
- **Idle timeout: know the number.** The appliance holds state per connection and reaps idle ones — commonly at 300 s, which is *shorter* than browser/client keepalives and than nginx's own upstream keepalive. Ask what it is, and make sure long-lived flows (WebSockets, SSE, long polls) either heartbeat under it or get a longer timeout on this VIP. The full cross-hop timeout story is [Long-Lived Connections](/networking/long-lived-connections/).
- **SNAT: assume it.** Appliances typically SNAT so return traffic comes back through them — meaning packets arrive at the cluster with the appliance's self-IP as source, and every app behind this edge loses real client IPs unless you carry them in-band. This design's answer is PROXY protocol, configured on **both** the appliance and ingress-nginx — details in the controller section below.

The request template, ready to paste into the network team's ticket system:

> Please create a VIP for `*.apps.example.com` on the shared LB pair:
> - VIP: 1 IP from the DMZ/app range, ports 80 and 443, **TCP passthrough** (no TLS termination, no HTTP profile)
> - Pool: `10.20.0.30:80` and `10.20.0.30:443` (single member per port; failover is handled behind this IP)
> - Monitor: HTTPS `GET /healthz` on `10.20.0.30:443`, expect 200 (TCP-connect fallback acceptable)
> - **Enable PROXY protocol v2 toward the pool members on both ports**
> - Port 80 must stay open end to end (ACME HTTP-01 challenges)
> - Idle timeout: please confirm the value; we need ≥ 3600 s on this VIP for WebSocket traffic
> - DNS: point `*.apps.example.com` at the new VIP

:::note[No appliance? The design degrades gracefully.]
Smaller shops without a network team or an F5 run *exactly* this stack minus the top layer: put `10.20.0.30` in DNS as the client-facing VIP, set `use-proxy-protocol: "false"`, and skip the ticket. Every manifest below is identical — which is precisely why the layering is worth keeping honest.
:::

## Build

Apply order matters: address pool before the controller (or its Service sits `<pending>`), controller before issuers (HTTP-01 needs a working edge), certificates before you flip the default-cert flag.

### 1. MetalLB: the address pool and L2 advertisement

MetalLB is assumed installed (Helm chart or manifest — the MetalLB article covers the speaker/controller mechanics). What this build adds is configuration:

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: front-door
  namespace: metallb-system
spec:
  addresses:
    - 10.20.0.30-10.20.0.33          # four IPs, deliberately small
  autoAssign: false                   # every VIP here is pinned by annotation
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: front-door-l2
  namespace: metallb-system
spec:
  ipAddressPools:
    - front-door
  interfaces:
    - bond0                           # announce only on the server LAN NIC
```

**Why only 4 IPs?** `.30` is the shared HTTP address — the entire point of the design is that this one pool member serves every HTTP app forever. `.31` is reserved for a future internal-only ingress controller (see variants), and `.32`/`.33` are headroom for TCP passthrough experiments before they get their own pool. A big pool invites per-app LoadBalancer Services, which recreates the IP-sprawl problem ingress exists to solve — and every extra IP here is another appliance pool the network team has to build and monitor.

**Why `autoAssign: false`?** The front-door IP is baked into the appliance's pool definition and the firewall rules between the appliance and the server LAN. It must never be handed to whoever creates a LoadBalancer Service first; each assignment is an explicit annotation. Changing it after the fact is a network-team ticket, not a kubectl apply.

**Why L2, and the upgrade note.** L2 mode means one elected node answers ARP for the VIP — all ingress traffic enters through that single node's NIC, and failover takes seconds (client ARP caches). That's fine up to roughly a NIC's worth of edge traffic. When it isn't, the upgrade is `BGPAdvertisement` + ECMP on your router: same pool, same VIP, traffic spread across nodes and sub-second failover. The `interfaces` selector matters on multi-homed nodes — without it, speakers ARP on every interface, including storage and management networks where your VIP has no business appearing.

### 2. ingress-nginx: the controller behind the VIP

Installed via Helm; the values excerpt below is the part that encodes design decisions (chart defaults are fine elsewhere):

```yaml
# helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
#   -n ingress-nginx --create-namespace -f front-door-values.yaml
controller:
  replicaCount: 2
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: DoNotSchedule       # two replicas on one node is zero HA
      labelSelector:
        matchLabels:
          app.kubernetes.io/component: controller
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      memory: 1Gi                            # memory limit only — no CPU limit
  service:
    annotations:
      metallb.io/loadBalancerIPs: 10.20.0.30 # pin it; the appliance pool depends on it
    externalTrafficPolicy: Local
  config:
    use-proxy-protocol: "true"         # the appliance SNATs; client IPs arrive
                                       # in-band via PROXY protocol — see why-note
    use-forwarded-headers: "false"     # trust PROXY protocol, not spoofable headers
    compute-full-forwarded-for: "true"
    worker-processes: "2"              # match CPU request, not node cores
    max-worker-connections: "16384"
    log-format-upstream: >-
      $remote_addr - $host [$time_local] "$request" $status
      $body_bytes_sent $request_time $upstream_addr
      $upstream_status $upstream_response_time
  metrics:
    enabled: true
    serviceMonitor:
      enabled: true
  admissionWebhooks:
    enabled: true
defaultBackend:
  enabled: true
```

Why-notes, top to bottom:

- **2 replicas + spread + PDB.** Rolling upgrades and node drains must never leave zero proxies. The PDB (below) makes drains wait rather than evict both at once.
- **No CPU limit on a proxy.** ingress-nginx is CPU-bound under load (TLS handshakes, header parsing). CFS throttling at the edge manifests as latency for *every* app in the cluster — the worst possible place to throttle. Request honestly, cap memory only; the reasoning is [Requests, Limits & the Knobs Behind Them](/tuning/requests-limits-knobs/).
- **`externalTrafficPolicy: Local`.** With the default `Cluster` policy, kube-proxy SNATs traffic as it bounces to a controller pod on another node. In this topology the *appliance* has already SNAT'd — the L3 source is its self-IP either way, and the real client IP travels in PROXY protocol regardless — so `Local` is no longer about preserving source IPs. It still earns its place: it skips the extra kube-proxy hop, and it makes MetalLB announce the pool-member IP only from nodes actually hosting a controller pod, using the `healthCheckNodePort` that `Local` allocates. The mechanics are in [Services Deep Dive](/networking/services-deep-dive/). The cost: the IP-owning node must run a controller pod, which the topology spread makes likely and the failover drill below proves.
- **`use-proxy-protocol: "true"` — and it takes two.** The appliance SNATs, so packets arrive with its self-IP as source; without help, every app behind this edge loses real client IPs for logs, rate limits, and allow-lists. PROXY protocol carries the original client address in-band across the L4 hop — but it is a *pair* setting: the appliance must send it (the request-template line above) and ingress-nginx must expect it (this key). One side on, the other off, and **every request fails with a protocol error** — nginx logs `broken header` reading PROXY bytes as HTTP, or clients see garbage prepended. Flip both in the same change window. The alternative, if the network team runs the VIP as an L7 HTTP virtual server instead: they inject `X-Forwarded-For`, and you set `use-forwarded-headers: "true"` plus `proxy-real-ip-cidr` scoped to the appliance's SNAT addresses — workable, but it moves HTTP parsing (and TLS, and SNI routing) onto a box you don't control, which is why passthrough + PROXY protocol is this design's answer. Either way, `use-forwarded-headers` stays `"false"` unless the box in front is the one writing the header: trust no `X-Forwarded-For` you didn't verify the origin of.
- **`worker-processes: "2"`.** The default `auto` spawns one worker per node core — on a 32-core node that's 32 workers for a 500m-request pod, and wildly misleading accounting. Pin workers to the CPU you actually requested.
- **Log format with upstream timings.** `$request_time` vs `$upstream_response_time` is the single fastest way to answer "is it the edge or the app?" during an incident. Bake it in before you need it.
- **Admission webhook stays on.** It validates Ingress objects (including nginx snippet syntax) at apply time. One tenant's malformed `configuration-snippet` can otherwise poison the shared nginx config reload for everyone. Sharp edge: the webhook adds a failure mode — if the controller is down, Ingress *writes* fail cluster-wide. `failurePolicy: Ignore` (the chart default) is the right call; don't harden it to `Fail`.

The PDB, as its own manifest (chart-managed PDBs vary by version; explicit is auditable):

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
      app.kubernetes.io/component: controller
```

The controller's own liveness/readiness probes ship sane in the chart (`/healthz` on port 10254); resist the urge to tighten them — a controller flapping NotReady during a config reload storm makes the outage worse. The reasoning behind probe timing trade-offs is in [Health Check Knobs](/tuning/health-check-knobs/), which also backs the tenant probe conventions below.

### 3. cert-manager: issuers and the default certificate

Install cert-manager (Helm, `installCRDs: true`, defaults are fine). Then the issuer:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      - http01:
          ingress:
            ingressClassName: nginx     # solver rides the edge we just built
```

**How the HTTP-01 solver works** — worth understanding because it's the thing that breaks: when a Certificate needs issuing, cert-manager creates a temporary solver pod *plus a temporary Ingress* for `/.well-known/acme-challenge/<token>` on the requested hostname. Let's Encrypt resolves the hostname (to the **corporate VIP**, via the wildcard record), fetches the token *through the appliance, then through this very ingress-nginx*, and the solver objects are deleted on success. Corollaries: the challenge must traverse the **entire** chain — the appliance's port-80 listener open and pooled to `10.20.0.30:80` (the request-template line; security teams love to close port 80, and every closed-80 "hardening" silently breaks renewal weeks later), the edge already working before certificates can — hence the apply order. If the network team won't keep 80 open, that's not a blocker: it's the signal to use DNS-01, which never touches the data path.

**TLS terminates at ingress-nginx — a decision, not a default.** With the appliance in passthrough mode, cert-manager keeps doing everything it does below: per-host certs from Ingress annotations, the wildcard default cert, automatic renewal, SNI routing across hundreds of hostnames — all inside the cluster, zero tickets per app. The variant your network team may propose — terminate TLS *on the F5* (their cert tooling, their HSM, their compliance story) — is legitimate but costs exactly those things: certificates become network-team change requests instead of annotations, cert-manager is reduced to internal traffic, and every new hostname needs appliance-side SNI/cert config. If the org mandates it, run the appliance L7 with re-encryption to the pool member and switch the client-IP strategy to `X-Forwarded-For` as described above. Default to passthrough; concede it only deliberately.

**DNS-01 as the wildcard alternative.** HTTP-01 cannot issue wildcard certificates. If you want a real `*.apps.example.com` cert (recommended as the default cert), add a DNS-01 solver: cert-manager writes a TXT record via your DNS provider's API instead of serving a token. Trade-off: it needs API credentials for your DNS zone living in the cluster — a real secret with real blast radius — but it works for wildcards and for hosts not reachable from the internet.

The default certificate, wired into the controller:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-apps
  namespace: ingress-nginx
spec:
  secretName: wildcard-apps-tls
  issuerRef:
    name: letsencrypt-prod            # requires the DNS-01 solver
    kind: ClusterIssuer
  dnsNames:
    - "*.apps.example.com"
```

Then in the Helm values: `controller.extraArgs.default-ssl-certificate: "ingress-nginx/wildcard-apps-tls"`. This is what kills the **Fake Certificate trap** described in [ingress-nginx](/networking/ingress-nginx/): any Ingress with a `tls:` block but a missing/broken secret — or any HTTPS request for an unrouted host — gets served the wildcard instead of the self-signed "Kubernetes Ingress Controller Fake Certificate" that scares users and breaks clients.

### 4. DNS: the wildcard record

One record, outside the cluster, in your real DNS — pointing at the **corporate VIP**, never at the MetalLB IP (the pool member is an implementation detail the appliance is free to change):

```text
*.apps.example.com.   300   IN   A   10.0.5.40
```

In most corporate setups this record lives in the network team's zone and lands via the same ticket as the VIP. Every app hostname under `.apps.example.com` now resolves to the corporate VIP with zero per-app DNS work — the routing decision moves entirely into Ingress objects. Optional automation: **external-dns** watches Ingress resources and manages per-host records via your DNS provider's API, which you need if apps live under multiple zones or you want records that exist only while the app does. With a single wildcard, skip it; how cluster and external DNS interact — and where external-dns earns its keep — is covered in [DNS](/networking/dns/).

### 5. The tenant contract

What an app team's Ingress must look like to ride this stack:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop-web
  namespace: shop
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod   # per-host cert; OR omit
                                                       # tls.secretName entirely
                                                       # and ride the wildcard
    nginx.ingress.kubernetes.io/proxy-body-size: 8m
spec:
  ingressClassName: nginx            # required; unclassed Ingresses route nowhere
  tls:
    - hosts: [shop.apps.example.com]
      secretName: shop-web-tls       # cert-manager creates this
  rules:
    - host: shop.apps.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: shop-web
                port:
                  number: 80
```

Platform-published contract terms:

- **Class name is `nginx`**, always via `ingressClassName`, never the legacy annotation.
- **TLS two ways:** the cert-manager annotation for a per-host certificate, or omit the `tls` block's secret and be served by the wildcard default. Both end in a green padlock.
- **Snippets are locked down** (`allow-snippet-annotations: false` is the chart default since the CVE-2021-25742 era, and stays that way here). Tenants get the curated annotation set; raw nginx config injection is a platform-only privilege.
- **Rate-limit and body-size defaults** are set cluster-wide in the controller ConfigMap; tenants may lower, not raise, without a platform conversation.
- **Probe-path convention:** every backend Service must front pods with a real readiness probe (see Health Checks and the knobs article linked above for the timings) — ingress-nginx routes to *ready* endpoints, so a missing readiness probe means traffic during startup and 502s during deploys. Convention: `GET /healthz` unauthenticated on the app port.

### 6. Edge observability

The controller exports Prometheus metrics (enabled above); cert-manager exports expiry gauges. The four alerts this build ships with — thresholds are starting points, the alert-design method is in [Alerting](/observability/alerting/):

```yaml
groups:
  - name: front-door
    rules:
      - alert: EdgeHigh5xxRate
        expr: |
          sum(rate(nginx_ingress_controller_requests{status=~"5.."}[5m]))
            / sum(rate(nginx_ingress_controller_requests[5m])) > 0.05
        for: 5m
        labels: {severity: page}
      - alert: EdgeUpstreamLatencyP99
        expr: |
          histogram_quantile(0.99, sum by (le) (
            rate(nginx_ingress_controller_request_duration_seconds_bucket[5m]))) > 2
        for: 10m
        labels: {severity: warn}
      - alert: CertExpiringSoon
        expr: certmanager_certificate_expiration_timestamp_seconds - time() < 14*86400
        for: 1h
        labels: {severity: page}   # 14 days: renewal is stuck, not merely pending
      - alert: FrontDoorVIPDown
        expr: probe_success{job="blackbox", instance="https://ping.apps.example.com/healthz"} == 0
        for: 2m
        labels: {severity: page}
```

The blackbox probe is the one that matters most: probing the *hostname* from outside the traffic path (a blackbox-exporter, ideally off-cluster) tests the full chain — corporate VIP, appliance pool, MetalLB announcement, controller — and is the only alert that catches "MetalLB stopped announcing" *or* "the appliance marked the pool member down", both invisible to every in-cluster metric because in-cluster traffic never touches either VIP. When it fires, verification steps 1 and 2 tell you which layer, and therefore which team.

## Verification plan

Run all seven. An edge you haven't killed a node under is a diagram, not a front door.

1. **Inner layer: the MetalLB IP answers, with ARP evidence.** This check deliberately bypasses the appliance — it isolates the layer the platform team owns. From a machine on the same L2 segment: `arping -c 3 10.20.0.30` — the replying MAC must match one node's NIC (`ip link show bond0` on the nodes to compare). Then `curl --haproxy-protocol -sv http://10.20.0.30/ -H 'Host: nonexistent.apps.example.com'` — the `--haproxy-protocol` flag matters: this listener expects PROXY protocol, so a *plain* curl correctly fails with an empty reply or 400 (that failure is itself evidence the config key took). Expect the default backend's 404. A 404 here is *success*: the whole path MetalLB IP → node → controller works.
2. **Outer layer: the corporate VIP, through the appliance.** `curl -sv https://nonexistent.apps.example.com/` (resolving via the wildcard to `10.0.5.40`) — the same default-backend 404, this time proving DNS → VIP → pool → MetalLB IP end to end, PROXY protocol handshake included. Then check the appliance's own view: ask the network team (or the self-service dashboard, if you're lucky) whether the pool member shows **green on the HTTPS monitor**. Layer 1 passing while this step fails localizes the problem to the appliance or the firewall between it and the server LAN — that's a network-team ticket with your step-1 evidence attached.
3. **HTTP-01 issuance end to end.** Apply a test Certificate for `acme-test.apps.example.com`, then watch the solver machinery live: `kubectl get ingress,pods -n ingress-nginx -w` shows the temporary `cm-acme-http-solver-*` Ingress and pod appear, serve one request from Let's Encrypt, and vanish. `kubectl get certificate -A` shows `READY=True` within ~90 s.
4. **Demo app, zero to padlock.** Deploy any hello-world Deployment + Service, apply the tenant-contract Ingress above with a fresh hostname, and time it: DNS already resolves (wildcard), routing is live on the next nginx reload (~seconds), cert in ~a minute. `curl -v https://demo.apps.example.com/` must show a Let's Encrypt chain — if you see the Fake Certificate, the default-cert wiring or the per-host secret is broken.
5. **Node-kill drill (MetalLB failover, inner layer).** Find the current owner of `10.20.0.30` (`arping` MAC → node), then power it off — don't drain, *kill it*; drains are the polite case. Run `while true; do curl -so /dev/null -w '%{http_code}\n' --max-time 2 https://demo.apps.example.com/; sleep 1; done` throughout — note this loop goes through the corporate VIP, so it exercises the full chain. **L2 timing honesty:** expect ~1–10 s of failures while a surviving speaker wins the memberlist election and sends gratuitous ARP, plus however long upstream ARP caches take to accept it — and the box whose ARP cache matters most is now *the appliance*, since it's the one dialing the pool member. If the blip runs long, its monitor may also mark the pool member down and up again; watch for that double-dip in the appliance logs. Seconds of blip is correct behavior for L2 mode; if you need sub-second, that's the BGP variant.
6. **Controller-pod-kill (zero-downtime claim).** With the curl loop running, `kubectl delete pod -n ingress-nginx -l app.kubernetes.io/component=controller --wait=false` one pod at a time. Expect **zero** failed requests — the Service endpoint drops before nginx stops accepting, and the second replica carries the load. Any 5xx here means your replicas are on one node (spread constraint violated) or the PDB is missing.
7. **Renewal dry run.** `kubectl cert-manager renew wildcard-apps -n ingress-nginx` (cmctl plugin) forces reissuance; confirm the secret's `NotAfter` moves and nginx picks it up without a restart (`echo | openssl s_client -connect 10.0.5.40:443 -servername x.apps.example.com 2>/dev/null | openssl x509 -noout -dates` — through the corporate VIP, because that's what clients see; the MetalLB IP won't talk raw TLS to you now that it expects PROXY protocol). Do this *before* the 60-day mark ever arrives in production.

## Failure modes

| Symptom | Likely cause | Decode fast | Fix |
|---|---|---|---|
| MetalLB IP unreachable after node maintenance (inner layer) | Stale ARP: the appliance still holds the dead node's MAC for the pool member | `arping` the MetalLB IP — no reply, or reply from wrong MAC vs current speaker owner (`kubectl logs -n metallb-system -l component=speaker`) | Wait out ARP TTL or have the network team clear the appliance's ARP cache; verify a surviving node runs both a speaker *and* a controller pod (eTP=Local requirement) |
| MetalLB IP answers but the corporate VIP doesn't | The outer layer: appliance pool member marked down (monitor misconfigured/failing), VIP disabled, or firewall between appliance and server LAN | Verification steps 1 vs 2 split exactly here — `curl --haproxy-protocol` against `10.20.0.30` works, `curl https://x.apps.example.com/` doesn't | Network-team ticket, with your passing step-1 evidence attached: check monitor status, pool config, and the path from the appliance to `10.20.0.30` |
| Every request fails instantly; nginx logs `broken header`; or clients see junk bytes | PROXY protocol mismatch: enabled on one side of the appliance↔nginx pair but not the other | `curl http://10.20.0.30/` plain vs `curl --haproxy-protocol` — whichever one *works* tells you what nginx expects; compare with what the appliance is configured to send | Flip `use-proxy-protocol` and the appliance-side setting **together**, in one change window — it's a pair setting, never a solo one |
| Everything returns 503 | Two very different causes: controller has no backend endpoints (app-side) vs controller itself unhealthy | One app 503ing → that app's endpoints: `kubectl get endpointslices -n <ns>` (readiness failing?). *All* apps 503ing → the edge: controller pods, config reload errors in controller logs | App-side: fix readiness/selector via [Service Unreachable](/troubleshooting/service-unreachable/). Edge-side: roll back the last config/annotation change |
| Browser shows "Kubernetes Ingress Controller Fake Certificate" | Ingress `tls.secretName` missing/typo'd, cert not yet issued, or default-ssl-certificate flag unset | `kubectl get certificate,secret -n <ns>`; `kubectl describe ingress` events | Fix the secret reference; confirm the controller Deployment args include `--default-ssl-certificate` |
| Certificate stuck `READY=False`, then ACME rate-limit errors | The classic: solver Ingress created but the challenge request can't reach the solver pod — usually a default-deny NetworkPolicy in the app namespace blocking it | `kubectl describe challenge -A` → "connection refused/timeout" on self-check; solver pod exists but receives nothing | Allow ingress-controller→solver traffic in the namespace policy — see [Network Policies](/networking/network-policies/). Then *stop retrying*: Let's Encrypt rate limits are per-hostname-set per week; use the staging server until the path works |
| WebSockets / long-polls drop through the edge | nginx default `proxy-read-timeout: 60` severs idle streams; the **appliance's idle timeout** (often 300 s) reaps flows nginx would have kept; config reloads also terminate workers after `worker-shutdown-timeout` | Disconnects cluster at exact intervals — 60 s points at nginx, 300 s (or whatever the network team confirmed) points at the appliance; or correlate with Ingress-change timestamps in controller logs | Per-app `proxy-read-timeout`/`proxy-send-timeout` annotations, client heartbeats under the *smallest* timeout on the path, reconnect logic — the full treatment is [Long-Lived Connections](/networking/long-lived-connections/) |
| One tenant's Ingress degrades the whole edge | Bad annotation values (huge `proxy-buffer-size`, regex path bombs) or — if you unwisely enabled snippets — invalid nginx config rejected at reload, freezing config updates cluster-wide | Controller logs: `Error reloading NGINX` names the offending Ingress; admission webhook logs show what it rejected | Keep `allow-snippet-annotations: false`; keep the admission webhook on; treat annotation allow-listing as a platform security boundary, not a convenience |

## Scaling and variants

**When one VIP isn't enough.** L2 mode's ceiling is one node's NIC and its failover is seconds. The upgrade path keeps every manifest above except the advertisement: swap `L2Advertisement` for `BGPAdvertisement` plus `BGPPeer`s to your ToR routers, and the *same VIP* becomes an ECMP route across all controller-bearing nodes — horizontal edge bandwidth and sub-second failover. This needs router cooperation, so it's a platform-team-and-network-team conversation; the MetalLB article covers the BGP mechanics.

**Automating the appliance layer.** The pool in this build is one static member that never changes — a one-time ticket is the right tool. If your org instead wants the F5 to pool *node* addresses directly, or to reconfigure itself as the cluster changes, that's F5's Container Ingress Services: an in-cluster controller that writes BIG-IP config from Kubernetes resources, replacing the MetalLB layer rather than sitting behind it — a different design with different trade-offs, covered in [F5 CIS](/controllers/f5-cis/).

**Internal vs external ingress classes.** When some apps must never face the internet, run a second ingress-nginx release with `ingressClassName: nginx-internal`, pinned to `.31` from the same pool, with the wildcard `*.internal.example.com` resolvable only on the corporate network and the external firewall never forwarding to `.31`. Two controllers, two VIPs, one pool — tenants choose exposure by class name alone, which is exactly the interface you want.

**Gateway API as the successor.** The `Gateway`/`HTTPRoute` split formalizes what this build does by convention: platform owns the `Gateway` (listener, VIP, wildcard cert), tenants own `HTTPRoute`s bound to it — the tenant contract becomes API-enforced instead of documented. ingress-nginx itself is not the long-term Gateway API vehicle; when you migrate, the MetalLB and cert-manager layers of this build carry over unchanged, which is a good test of whether your architecture was actually layered.

The front door is the one piece of shared infrastructure every request crosses. Build it once, drill it honestly, and publish the tenant contract — then app teams can treat "how do I get a URL?" as a two-manifest problem instead of a networking project.
