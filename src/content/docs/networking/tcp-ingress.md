---
title: TCP and Non-HTTP Ingress
description: Getting raw TCP and UDP into the cluster — LoadBalancer Services, the tcp-services ConfigMap, SNI routing, Gateway API L4 routes, and the timeout traps.
keywords:
  - expose postgres externally
  - expose a database outside the cluster
  - tcp-services ConfigMap
  - SNI passthrough routing
  - connection reset after 350 seconds
  - PROXY protocol
  - idle timeout drops connection
  - TCPRoute UDPRoute TLSRoute
  - conntrack table full dropping packet
  - client IP preservation
  - port-forward
  - invalid startup packet
sidebar:
  order: 14
---

The Ingress resource is HTTP(S)-only by spec. Host and path rules are HTTP concepts; there is nowhere in the API to express "port 5432 goes to Postgres." For databases, message queues, MQTT, LDAP, SMTP, game servers — anything that isn't HTTP — you need a different door into the cluster.

## The option ladder

| Option | Client IP preserved? | TLS handling | Port flexibility | Who must act | Typical use |
|---|---|---|---|---|---|
| Service `type=LoadBalancer` | With `externalTrafficPolicy: Local` | Passthrough (your app terminates) | Any ports you declare | **You** (if platform provisions LBs automatically) | Default answer; one VIP per service |
| NodePort | Source NAT'd unless `Local` | Passthrough | 30000–32767, awkward | You, plus something to reach nodes | Labs, or behind an external LB you don't see |
| ingress-nginx `tcp-services` ConfigMap | Only via PROXY protocol | Passthrough | One backend per controller port | **Platform** (their ConfigMap, their Service) | A few TCP ports on existing shared LB |
| Gateway API TCPRoute/UDPRoute/TLSRoute | Depends on implementation | Passthrough; TLSRoute adds SNI routing | Listener per port (platform-defined) | Platform (Gateway) + you (Route) | Clusters that have adopted Gateway API |
| F5 TransportServer | Yes (BIG-IP options) | BIG-IP terminates or passes through | Flexible | You (CR) + platform (BIG-IP) | Enterprise, BIG-IP fronting cluster |
| `kubectl port-forward` | N/A | N/A | Anything | You | Ad hoc debugging **only** — never a service path |

Work down from the top. Most teams should stop at the first row.

:::note
`kubectl port-forward` deserves its dishonorable mention now: it tunnels through the API server, dies when your laptop sleeps, and handles one connection stream at a time. It's the right tool for "let me psql into staging for five minutes" and the wrong tool for anything a second person depends on. If a runbook says "start the port-forward," the runbook is describing an outage-in-waiting.
:::

A word on NodePort as a standalone answer: it works — every node opens the port and forwards to your Service — but clients must know node IPs (which churn on every node rotation), the port range is 30000–32767 unless platform changed it, and source IPs get SNAT'd by default. Its legitimate role today is as the *hidden layer* under a LoadBalancer Service or an external appliance that platform points at the nodes, not something you hand to clients directly.

## Service type=LoadBalancer: the default answer

One Service, one VIP — a cloud LB in EKS/GKE/AKS, or a [MetalLB](/controllers/metallb/)-assigned address on-prem. How VIPs actually get programmed and routed is covered in [External Load Balancing](/networking/external-load-balancing/); here's the tenant-side YAML for exposing Postgres:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres-external
  annotations:
    # cloud/MetalLB-specific annotations go here (internal LB, address pool, static IP)
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
spec:
  type: LoadBalancer
  externalTrafficPolicy: Local     # preserve client IPs; see below
  selector:
    app: postgres
    role: primary                  # don't send writes to replicas
  ports:
    - name: postgres
      port: 5432
      targetPort: 5432
      protocol: TCP
```

```console
$ kubectl get svc postgres-external
NAME                TYPE           CLUSTER-IP     EXTERNAL-IP      PORT(S)          AGE
postgres-external   LoadBalancer   10.96.140.22   203.0.113.40     5432:31207/TCP   2m
```

Watch the Events if the VIP stays `<pending>` — that's where quota exhaustion, missing pool annotations, and subnet errors surface:

```bash
kubectl describe svc postgres-external | tail -4
```

```console
Events:
  Type     Reason                  Age   From                Message
  ----     ------                  ----  ----                -------
  Warning  SyncLoadBalancerFailed  40s   service-controller  Error syncing load balancer: quota exceeded
```

**Health checks: two different things with the same name.** The cloud LB health-checks *node ports* — "does this node forward to something." It knows nothing about whether Postgres accepts queries. Your app's health is enforced one layer down: readiness probes gate which pods are in the endpoint list. A pod failing readiness leaves the Service; the LB keeps happily sending to the node, which now has nowhere to forward. Both layers must be right, and they fail independently: a green LB dashboard with zero Ready pods still serves connection refused.

UDP works the same way with `protocol: UDP` on the port — but note most clouds won't mix TCP and UDP on one classic LB Service (support for `MixedProtocolLB` Services arrived in newer versions/clouds; check yours), so DNS-style services historically needed two Services sharing one IP via provider-specific annotations.

**Trade-offs.** Every `type=LoadBalancer` Service is a billable cloud LB or a consumed address from a finite MetalLB pool. Three services is fine; thirty is a cost line-item and an IP-exhaustion conversation. At that point ask platform about shared approaches (tcp-services below, a Gateway, or one LB fronting several ports). **Static IPs** — for firewall allowlists at partner sites — are annotation- or platform-driven (`loadBalancerIP` is deprecated; clouds use annotations, MetalLB uses pool/annotation): request one *before* GA, because the VIP changes if the Service is recreated. And give the VIP a **DNS name** — clients configured with raw IPs become outages when the LB is rebuilt. If the cluster runs external-dns, a single annotation publishes the record; see [DNS](/networking/dns/).

## The ingress-nginx tcp-services ConfigMap

ingress-nginx can proxy raw TCP/UDP streams alongside HTTP: a ConfigMap (named by the controller's `--tcp-services-configmap` flag) maps a controller port to your Service:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tcp-services
  namespace: ingress-nginx
data:
  "5432": "team-orders/postgres-external:5432"
  # with PROXY protocol toward your backend, if your app can parse it:
  # "5672": "team-orders/rabbitmq:5672:PROXY"
```

The port must then also be opened on the controller's own Service/LB. Here's the honest framing: **both of those objects belong to the platform team.** This is not a self-service pattern — it's a request pattern. Write the request precisely and it gets done in a day ([Working with the Platform Team](/operations/working-with-platform-team/)):

> Please add `"5432": "team-orders/postgres-external:5432"` to the tcp-services ConfigMap and expose 5432 on the ingress controller Service. Source: partner CIDR 198.51.100.0/24. We do not need PROXY protocol.

Limitations to know before you ask:

- **No SNI, no host routing — one port, one backend, cluster-wide.** Raw TCP has no Host header; nginx can't tell your Postgres traffic from another team's. If someone already claimed 5432, you're picking a nonstandard port and updating every client.
- Client IPs are lost unless PROXY protocol is enabled on that mapping *and* your backend understands it (below).
- You're now coupled to the shared controller's reloads, upgrades, and blast radius.

## TLS + SNI: the exception that restores multiplexing

The one-port-one-backend rule has an escape hatch: if your TCP protocol is **wrapped in TLS**, the ClientHello carries SNI — a server name in plaintext before any decryption. A router can read it and steer the still-encrypted stream, so one port 443-style listener can serve many backends again. Two mainstream implementations:

- **Gateway API TLSRoute** with a `Passthrough` listener — SNI match, encrypted bytes forwarded untouched, your pod terminates TLS:

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata:
  name: rabbitmq-amqps
  namespace: team-orders
spec:
  parentRefs:
    - name: shared-gateway
      namespace: infra-gateways
      sectionName: tls-passthrough    # listener with tls.mode: Passthrough
  hostnames:
    - mq.example.com                  # matched against SNI in the ClientHello
  rules:
    - backendRefs:
        - name: rabbitmq
          port: 5671
```

- **ingress-nginx `ssl-passthrough`** — same idea via annotation, if platform enabled `--enable-ssl-passthrough`.

What SNI routing sees: the server name, nothing else. No ALPN-based app routing, no client certs inspected, no L7 anything — it cannot retry, rewrite, or rate-limit. And clients must actually *send* SNI: a client connecting by raw IP, or an old library with SNI disabled, matches no route and gets dropped or handed the default backend. Test with and without `-servername` in `openssl s_client` to see both behaviors.

When this applies: Postgres with `sslmode=require` (with the caveat that classic Postgres negotiates TLS *after* a cleartext `SSLRequest` handshake, so plain SNI routers don't work — Postgres 17's direct-TLS `sslnegotiation=direct` fixes this), AMQPS (5671), MQTT over TLS (8883), LDAPS. If your clients speak TLS-from-byte-one, SNI routing gives you shared-port ingress for TCP.

## Gateway API for L4

Gateway API does L4 properly, with a role split that matches how clusters are actually run: platform owns the `Gateway` (listeners, ports, LB), you own the `Route` objects that attach to listeners the platform allows your namespace to use.

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TCPRoute
metadata:
  name: postgres
  namespace: team-orders
spec:
  parentRefs:
    - name: shared-gateway
      namespace: infra-gateways
      sectionName: postgres-5432     # the listener platform created for you
  rules:
    - backendRefs:
        - name: postgres-external
          port: 5432
```

`UDPRoute` is structurally identical; `TLSRoute` adds SNI `hostnames` matching for the passthrough case above. Realities to check first:

- **Listener-per-port for raw TCP.** No SNI means no multiplexing — every TCP service needs its own listener on the Gateway, which is a platform change per port. The tcp-services limitation didn't disappear; it moved into a cleaner API.
- **Maturity honesty:** TCPRoute/UDPRoute/TLSRoute live in the Gateway API **experimental channel** (`v1alpha2` as of 2026). Your platform must install the experimental [CRDs](/controllers/crds-explained/) *and* run an implementation that supports them. `kubectl api-resources | grep tcproute` tells you in five seconds whether this path exists in your cluster.

## F5 TransportServer

If a BIG-IP fronts your cluster via CIS, `TransportServer` is the enterprise L4 answer: a namespaced CR you write that programs a BIG-IP virtual server for TCP/UDP straight to your Service — VIPs, iRules, persistence, real client IPs, the works. Full treatment in [F5 CIS](/controllers/f5-cis/).

## Protocol field notes

**PostgreSQL.** Database connections are the canonical long-lived TCP flow, and every middlebox has an idle timeout: AWS NLB 350s, Azure LB 4 minutes by default, plus conntrack. The classic ticket reads *"connection reset after exactly 350 seconds"* — an idle pooled connection silently dropped by the LB, discovered on next use as `server closed the connection unexpectedly`. Fixes: TCP keepalives under the shortest idle timeout —

```text
# server side (postgresql.conf) or per-client in the DSN:
tcp_keepalives_idle = 300        # DSN: keepalives_idle=300
tcp_keepalives_interval = 30
tcp_keepalives_count = 3
```

— and a pooler: PgBouncer in front of Postgres inside the cluster keeps external connection churn away from the database, absorbs client reconnect storms after an LB blip, and gives you one place to manage timeouts instead of N application configs. More in [PostgreSQL on Kubernetes](/stateful/postgresql/).

**Message queues.** Broker protocols have their own liveness story — AMQP heartbeats, MQTT keepalive, Kafka's protocol-level metadata — and it must tick faster than the LB's idle timeout or consumers die silently: an idle consumer whose TCP session was dropped by the LB believes it's subscribed while the broker has already closed its channel. Set AMQP heartbeat ≈ 30–60s (under the LB timeout), verify client auto-reconnect *and* re-subscribe behavior — reconnect without re-establishing consumers is the sneakiest variant. See [Message Queues](/stateful/message-queues/).

**UDP.** UDP "connections" are just conntrack entries with short timeouts (default ~30s for unreplied flows). There's no handshake for the LB to health-check and no connection for readiness to gate mid-stream — a pod going NotReady doesn't reset anything; existing conntrack entries keep steering packets at it until they expire. Protocols with app-level sessions (game servers, SIP) need app-level failover; don't expect Kubernetes to give it to you.

**The alignment rule.** Whatever the protocol: every hop's idle timeout must exceed the application's keepalive interval — client, LB, conntrack, any proxy, server. One hop shorter than your keepalive period and connections die there, always with a symptom that blames somewhere else. The full method is in [Long-Lived Connections](/networking/long-lived-connections/).

## Client IP preservation at L4

Three states, in order of preference:

1. **`externalTrafficPolicy: Local`** on your LoadBalancer Service: traffic only lands on nodes running your pods and skips the SNAT, so the pod sees the real client IP. Costs you cross-node balancing and makes LB health checks meaningful (nodes without your pods fail them — by design).
2. **PROXY protocol**: the LB prepends a header line with the real client address to each connection. Both ends **must agree**. The failure fingerprint is unmistakable — if only the sender speaks it, your app reads `PROXY TCP4 198.51.100.7 203.0.113.40 33125 5432\r\n` as protocol garbage and drops the connection; Postgres logs *"invalid startup packet"*, and byte-sensitive protocols just reset. If only the receiver expects it, every real client's first bytes get parsed as a malformed PROXY header. Enable it on both sides in one change window, or not at all.
3. **You just can't have it**: multiple SNAT layers, a middlebox that can't speak PROXY, tcp-services without the PROXY option. Stop fighting; get the IP at the application layer if the protocol allows, and put network-level allowlisting where the real IP still exists (the LB), not in the cluster.

## Debugging the TCP path

No HTTP means no status codes — you're down to "does the TCP handshake complete and does the protocol answer." Learn the three connect outcomes and what each means: **immediate refused** = something is listening infrastructure but the final hop said no (wrong port, no ready endpoints with `Local` policy on that node); **timeout** = packets are being dropped (firewall, security group, LB health check failing, NetworkPolicy); **connects then hangs/resets** = routing is fine, the protocol or a timeout is the problem. Probe from outside first:

```bash
nc -vz db.example.com 5432
```

```console
Connection to db.example.com port 5432 [tcp/postgresql] succeeded!
```

```bash
# TLS-wrapped protocols — also validates SNI routing and the served cert:
openssl s_client -connect mq.example.com:5671 -servername mq.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject
```

Then walk the chain hop by hop, halving the search space each time:

```bash
# 1. Pod itself, from inside the namespace (netshoot has nc, dig, tcpdump, conntrack):
kubectl run tmp --rm -it --image=nicolaka/netshoot -- nc -vz postgres-external.team-orders 5432
# 2. NodePort layer (from netshoot, using a node IP from `kubectl get nodes -o wide`):
kubectl run tmp --rm -it --image=nicolaka/netshoot -- nc -vz 10.20.0.11 31207
# 3. VIP from outside (above). Where the connect first fails is your layer.
```

Pod works but NodePort doesn't → kube-proxy/endpoints/`Local`-policy-on-a-podless-node territory. NodePort works but VIP doesn't → LB config or its health checks — platform's side of the line. Everything connects but the *protocol* misbehaves → timeouts (field notes above) or PROXY protocol mismatch. Full toolkit in [Debugging Network Issues](/networking/debugging-network/).

:::tip
"Connects fine, dies under load or after idle" is the conntrack/timeout family, not a routing problem. Symptoms of conntrack pressure: new connections fail while old ones live, `nf_conntrack: table full, dropping packet` in node logs (platform can check), UDP-heavy workloads suffering first.
:::

When you hand it to platform, send an escalation package, not a vibe: Service name/namespace and VIP; exact client symptom with timestamps (*"TCP RST after 350s idle"* beats *"drops sometimes"*); which hop of the nc-walk above fails; whether `externalTrafficPolicy`/PROXY protocol is in play; and a capture if you have one (`kubectl exec` + `tcpdump` in your own pod is within your rights). That package turns a week of ping-pong into one fix.
