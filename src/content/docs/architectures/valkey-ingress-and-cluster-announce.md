---
title: "Valkey Ingress: VIPs, TCP Routing, and cluster-announce"
description: How a client connection actually reaches the right Valkey pod — L4/TCP exposure, ClusterIP vs headless DNS, MetalLB VIPs, TCPRoute, and cluster-announce.
keywords:
  - expose redis outside the cluster
  - cluster-announce-ip behind NAT
  - MOVED to unreachable internal IP
  - tcp-services configmap ingress-nginx
  - redis TLS rediss valkey-cli
  - per-pod loadbalancer cluster mode
  - valkey headless per-pod dns
  - TCPRoute TLSRoute L4 gateway
  - redis client hangs on 10.x pod ip
  - cluster-announce-bus-port gossip
  - externalTrafficPolicy Cluster SNAT client ip
  - least-privilege ACL no FLUSHALL
sidebar:
  order: 4
---

This is the ingress child of the [Valkey Helm Chart Deep Dive](/architectures/valkey-helm-deep-dive/). The parent covers *what to install* and *what goes in values vs a ConfigMap vs a Secret*; the [raw build](/architectures/valkey-shared-vip/) covers the copy-paste manifests. This page answers exactly one question, in depth: **how a client connection actually reaches the right pod** — in-cluster and from outside, in primary/replica and in cluster mode. It is the *network path* companion. It is **not** about what you do once connected (pipelining, transactions, which verbs are safe on a replica) — that belongs to the sibling [Valkey Data Access Patterns](/architectures/valkey-data-access-patterns/) page. Stay in your lane and this page is short; wander into cluster-mode external access and it gets long, because that path is genuinely hard.

## 0. The one constraint everything follows from

Valkey speaks **RESP** (the Redis serialization protocol) over **raw TCP**. It is **not HTTP**. There is no `Host:` header, no URL path, no method — just a length-prefixed binary conversation on a socket. That single fact decides every routing choice below:

```text
  HTTP world (Ingress works)          Valkey world (Ingress does NOT)
  ─────────────────────────           ───────────────────────────────
  GET /orders HTTP/1.1                *3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n
  Host: shop.example.com              (opaque bytes on TCP :6379)
        │                                    │
   L7 proxy reads host+path            nothing to read — it's not text-with-headers
   routes by rule                      you can only route by PORT + DESTINATION IP
```

An **HTTP Ingress** (host/path rules, `nginx.ingress.kubernetes.io/*` annotations, `HTTPRoute`) has nothing to match on. You need **L4 / TCP** exposure the whole way down: a Service, a port, and something that forwards the byte stream unmodified. Keep this diagram in your head — every "why can't I just add an Ingress?" question dies here.

```text
  ┌── the only three layers that exist for a Valkey connection ──┐
  │                                                              │
  │   CLIENT ──TCP──►  SERVICE (a virtual IP + port, L4)         │
  │                         │  kube-proxy / CNI picks an endpoint │
  │                         ▼                                     │
  │                    POD (valkey-server listening on :6379)     │
  │                                                              │
  │   No L7 hop. No path. The Service is the routing decision.    │
  └──────────────────────────────────────────────────────────────┘
```

## 1. Internal access — the easy 90%

Most Valkey clients live *inside* the cluster. They need nothing external, and there are exactly two DNS surfaces. Picking the wrong one is the most common internal mistake.

| Surface | Object | DNS you dial | Load-balances? | Reach for it when |
|---|---|---|---|---|
| **ClusterIP** | `Service` (one virtual IP) | `valkey.ns.svc.cluster.local` | Yes — across all Ready endpoints | "Give me *a* Valkey"; a **read replica pool** |
| **Headless** | `Service` with `clusterIP: None`, `publishNotReadyAddresses: true` | `valkey-primary-0.<headless>.ns.svc.cluster.local` | No — resolves to the pod directly | **Pin the writer**; StatefulSet identity + replication |

### ClusterIP: "give me a Valkey"

A normal `ClusterIP` Service mints one stable virtual IP and one DNS name, and kube-proxy load-balances each new connection across the Ready endpoints behind the selector. This is what you want for a **read replica pool** — three replicas behind `valkey-ro`, connections spread across them:

```bash
# in-cluster read client — DNS resolves to the ClusterIP, kube-proxy picks a replica
valkey-cli -h valkey-ro.valkey.svc.cluster.local -p 6379
```

It is *wrong* for the writer. A ClusterIP over the primary Service works while there is one primary, but the moment you want to be sure you're talking to a *specific* pod — the current writer, a specific shard member — a load-balanced VIP can't express that.

### Headless: pin the writer, and identity

A **headless** Service (`clusterIP: None`) does not allocate a virtual IP. Instead DNS returns the pod addresses directly, and with `publishNotReadyAddresses: true` a StatefulSet gets **per-pod DNS** — stable names like `valkey-primary-0.valkey-primary-headless.valkey.svc.cluster.local`. This is load-bearing for two reasons:

1. **Replication needs it.** The replica's `replicaof` points at the primary's *per-pod* FQDN, which survives pod recreation (the raw build's [§3b](/architectures/valkey-shared-vip/#3b-headless-services)). `publishNotReadyAddresses: true` is what lets the replica *resolve* the primary during a restart, before the primary is Ready again — otherwise reconnection stalls on NXDOMAIN.
2. **Writer pinning.** A write client that must reach the current primary dials the per-pod name, not a VIP that might round-robin it onto a read replica.

```bash
# in-cluster WRITE client — pin the writer by its stable per-pod name
valkey-cli -h valkey-primary-0.valkey-primary-headless.valkey.svc.cluster.local -p 6379
```

The rule of thumb: **read-only pooling → ClusterIP; read-write pinning and replication → headless.** The mechanics of both live in [Services Deep Dive](/networking/services-deep-dive/), and the in-cluster DNS/routing story is in [cluster networking](/cluster-networking/overview/).

:::note[There is no external hop here]
Internal clients never touch MetalLB, an appliance, or a NodePort. `service.namespace.svc.cluster.local` is the whole path. If your consumer runs in the cluster, stop reading at this section — you don't need anything below, and every external door is a data port you'd have to defend.
:::

## 2. External access — the L4 door menu

Once a client lives *outside* the cluster, you need an L4 entry point. Here are the honest options, worst-to-best-fit for a Valkey, before the per-path detail:

| Option | Ports you get | Client IP kept? | Who owns it | Fit for Valkey |
|---|---|---|---|---|
| **MetalLB `LoadBalancer` (shared VIP)** | any (`:6379`/`:6380`) | No (ETP `Cluster` SNATs) | You (Service) + platform (pool) | **Primary answer** on-prem; the shared-VIP family |
| **NodePort** | 30000–32767 only | No unless `Local` | You, plus a way to reach node IPs | Rare — demo, or hidden under a real LB |
| **ingress-nginx `tcp-services`** | one controller port → one backend | Only via PROXY protocol | **Platform** (their ConfigMap + Service) | When platform already runs a shared L4 edge |
| **Gateway API `TCPRoute` / `TLSRoute`** | one listener per port | implementation-dependent | Platform (Gateway) + you (Route) | Clusters that adopted Gateway API |
| **Cluster-aware proxy** | proxy's own port | proxy-dependent | You/platform | The realistic door for **external cluster mode** |

Work down from the top; most on-prem teams stop at row one. All of these are covered generally in [TCP Ingress](/networking/tcp-ingress/) — this page is the Valkey-specific reading.

### 2a. MetalLB LoadBalancer (shared VIP) — the primary pattern

This is the pattern the whole Valkey family is built on, documented end-to-end in [Valkey: Two StatefulSets, One MetalLB VIP](/architectures/valkey-shared-vip/). The summary: **two** `LoadBalancer` Services share **one** MetalLB IP via `metallb.io/allow-shared-ip`, split by port — `:6379` to the primary (read-write), `:6380` to the replica (read-only) — and a corporate appliance fronts that IP with a DNS name clients actually dial. Don't recreate the manifests; the [raw build's §2](/architectures/valkey-shared-vip/#2-prerequisites-and-the-platform-ask) owns the exact sharing contract. The path:

```text
  CLIENT
    │  dials valkey.example.internal :6379 (rw) / :6380 (ro)
    ▼
  CORPORATE VIP  ── F5 / NetScaler appliance, OUTSIDE the cluster ──┐
    │  pools both ports to one MetalLB IP, same port numbers        │
    ▼                                                               │
  MetalLB IP 10.40.0.50  ── announced by a speaker → answered by    │
    │                        ONE cluster NODE (ARP in L2 / BGP route)│
    ▼                                                               │
  kube-proxy on that node  ── SNAT (ETP: Cluster) ──►  POD :6379    │
    │                                                               │
    └── source IP is now a NODE IP, not the client ─────────────────┘
```

Two facts that bite:

- **`externalTrafficPolicy: Cluster` is mandatory here.** The two Services select *different* pod sets (primary vs replica), and MetalLB will only share one IP between them if both use `Cluster` (or both `Local` selecting identical pods — impossible here). With `Local`, the second Service sits `<pending>` forever. Details and the full three-part sharing rule are in [MetalLB](/controllers/metallb/) and [External Load Balancing](/networking/external-load-balancing/).
- **`Cluster` SNATs away the client source IP.** kube-proxy rewrites the source to a node IP before the packet reaches the pod (and the appliance already SNAT'd it once). `CLIENT LIST` shows one node address for every external connection. This is why your NetworkPolicy must allow **node CIDRs**, not client CIDRs (§5).

### 2b. NodePort — the substrate, rarely the answer

A `NodePort` Service opens the **same high port (30000–32767)** on every node and forwards to your pods. It works, but for Valkey it is almost always wrong: you can't get `:6379`, clients must know node IPs that churn on every node rotation, and it announces on all nodes whether or not they run a pod.

```text
  CLIENT ──► nodeIP:31379  (NON-standard port, on EVERY node)
                 │  kube-proxy forwards
                 ▼
              POD :6379
```

Its legitimate role is as the **hidden layer** underneath a MetalLB `LoadBalancer` or an external appliance the platform points at the nodes — not something you hand to a Redis client directly. It shows up honestly in one place below: as a cheaper per-pod addressing substrate for cluster mode (§4).

### 2c. ingress-nginx tcp-services ConfigMap — L4 stream proxy, not an Ingress

ingress-nginx can proxy raw TCP alongside HTTP, but **not** through an `Ingress` resource — through a controller-level ConfigMap named by the controller's `--tcp-services-configmap` flag. It maps a controller port to a Service, and it is pure L4 stream proxying:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tcp-services
  namespace: ingress-nginx        # the controller's namespace, NOT yours
data:
  "6379": "valkey/valkey-rw:6379"   # controllerPort : namespace/service:port
```

```text
  CLIENT ──► ingress-nginx Service :6379 ──► nginx stream{} proxy ──► valkey-rw ──► POD :6379
                 (L4 stream, no host/path — one port, ONE backend, cluster-wide)
```

Two things make this a **platform request, not self-service**: the controller must be *started* with the tcp-services flag, and the port must be *opened* on the controller's own Service/LB. Both objects belong to the platform team. There is also no SNI and no host routing here — one port, one backend, cluster-wide — so if another team already claimed `:6379` on that controller you're stuck picking a nonstandard port. Client IPs are lost unless PROXY protocol is enabled on the mapping *and* Valkey could parse it (it can't). Full treatment and the exact request template: [TCP Ingress](/networking/tcp-ingress/).

### 2d. Gateway API TCPRoute (and TLSRoute for SNI passthrough)

Gateway API is the modern L4 answer, with the platform-owns-Gateway / you-own-Route split. `TCPRoute` is the raw-TCP route kind; it needs a Gateway with a **TCP listener** the platform created for you:

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TCPRoute
metadata:
  name: valkey-rw
  namespace: valkey
spec:
  parentRefs:
    - name: shared-gateway
      namespace: infra-gateways
      sectionName: valkey-6379      # a TCP listener platform opened for you
  rules:
    - backendRefs:
        - name: valkey-rw
          port: 6379
```

If your clients speak **TLS from byte one**, `TLSRoute` with a `Passthrough` listener restores multiplexing: the router reads the SNI server name from the ClientHello (still encrypted payload) and steers the stream to the right backend, and *Valkey* terminates TLS. That's the one way an L4 hop can fan multiple Valkeys out over a single port. Caveats — listener-per-port for plain TCP, and the L4 route kinds are still in the Gateway API **experimental channel** (`v1alpha2` as of 2026), so the platform must have installed the experimental CRDs — are in [Gateway API](/networking/gateway-api/) and [TCP Ingress](/networking/tcp-ingress/).

### 2e. Cluster-aware proxy

For **cluster mode** (sharding), none of the above is enough on its own, because the client gets redirected to *specific* nodes. The common external answer is a proxy that terminates client connections and hides the topology. That's the whole reason §4 exists.

## 3. cluster-announce — why external cluster-mode clients get MOVED to nowhere

The parent only gestured at this; here is the mechanism precisely.

In **cluster mode** the keyspace is 16384 hash slots spread across shards, and the *client* is responsible for reaching the right shard. It learns the topology by asking any node `CLUSTER SLOTS` / `CLUSTER SHARDS`, and each entry in that response contains **the address of the node that owns those slots**. When a client sends a command for a slot the contacted node doesn't own, the node replies:

```text
-MOVED 3999 <ip>:<port>
```

and the client is expected to **reconnect to that exact `<ip>:<port>`** and retry. So the entire cluster protocol depends on the addresses in `CLUSTER SLOTS` and `MOVED` being **routable by the client**.

**Here is the trap on Kubernetes.** By default a pod advertises its **pod IP** (a `10.x` / `192.168.x` address on the CNI network). An in-cluster client can route to that. An **external** client cannot — pod IPs are not reachable from outside the cluster. So the external client connects fine to the first node, sends a command, gets `-MOVED 3999 10.244.2.7:6379`, dutifully tries to open `10.244.2.7:6379`, and **hangs or fails** — every key that lives on another shard is a redirect to an unreachable address.

```text
  EXTERNAL CLIENT ──► node A (some reachable address)
        │  SET user:{42}:name  →  slot 3999 lives on node B
        ▼
  node A replies:  -MOVED 3999 10.244.2.7:6379     ← node B's POD IP
        │
        ▼
  client tries 10.244.2.7:6379  ──✗── UNREACHABLE (pod network, not routable outside)
                                       hang / connection timeout on every cross-shard key
```

### The fix: announce an externally reachable address per node

Valkey lets each node override what it advertises, with three settings:

| Setting | What it advertises | Notes |
|---|---|---|
| `cluster-announce-ip` | the IP peers/clients should use to reach **this** node | must be **externally routable** for external clients |
| `cluster-announce-port` | the **client** (data) port as seen externally | the port `MOVED`/`CLUSTER SLOTS` hand out |
| `cluster-announce-bus-port` | the **cluster bus** (gossip) port | node-to-node only; conventionally `client-port + 10000` |

The **bus port** is a second connection every cluster node opens to every other node for gossip and failure detection — separate from the client data port. Conventionally it is the client port plus 10000 (client `6379` → bus `16379`). It carries no client traffic, but it **must be mutually reachable between all nodes**, and when you announce external addresses the announced bus address has to be consistent so peers can still find each other.

```text
  # per-node valkey.conf (values differ per pod — see below)
  cluster-enabled yes
  cluster-announce-ip   10.40.0.61      # THIS node's externally reachable IP
  cluster-announce-port 6379            # data port clients should dial
  cluster-announce-bus-port 16379       # gossip bus (client-port + 10000)
```

### The hard part: every node needs its own external address

Because each node advertises a **distinct** address, and clients are steered to specific nodes, a **shared VIP cannot work** for cluster mode the way it does for primary/replica. Each shard member needs its own externally reachable address, and each must announce *its own*. That means **per-pod addressing**:

- **Per-pod `LoadBalancer` Service** — one MetalLB IP *per shard member*. Six pods = six IPs out of a finite, platform-owned pool. This is expensive and a big platform ask (contrast the shared-VIP pattern that burns exactly one).
- **Per-pod NodePort** — cheaper, but non-standard ports and node-IP coupling (§2b), and you still need one distinct external port/address per pod.

Either way, each pod's `cluster-announce-*` must be set to **its own** external address — which means the value can't be baked into a shared ConfigMap. The usual mechanism is a small init step that reads the pod's ordinal or a Downward-API env var and writes the right per-pod values, or a per-ordinal templated conf. Sketch of the announced-address flow:

```text
  EXTERNAL CLIENT ──► announced 10.40.0.60:6379  (pod-0's own LB IP)
        │  MOVED 3999 10.40.0.61:6379            ← pod-1's ANNOUNCED external IP
        ▼
  reconnect ──► 10.40.0.61:6379  ──✓── reachable, retry succeeds
        │  and node-to-node gossip flows over the announced bus ports 16379↔16380↔…
        ▼
  (every node advertises a distinct, routable address — no more 10.x dead ends)
```

:::caution[This is why cluster mode usually stays internal]
Per-pod LoadBalancers turn one platform ticket into N, and the announced addresses become a standing configuration you must keep correct through every reschedule. The pragmatic pattern for external cluster access is a **cluster-aware proxy** that terminates client connections, follows `MOVED`/`ASK` itself against the *internal* pod addresses, and presents clients a single stable endpoint — so the topology never leaks outside and no `cluster-announce-*` external gymnastics are needed. If you must expose cluster mode directly, budget one IP per shard member and an init step per pod. Most teams keep cluster mode **cluster-internal** with cluster-aware in-cluster clients, and reach for a proxy only when an external consumer genuinely needs the sharded dataset.
:::

## 4. TLS and auth at the connection edge

Exposing Valkey means exposing a **data port**. Two controls belong on it before anything else: transport encryption and authentication.

### Native TLS

Valkey terminates TLS itself. You enable a TLS port and point it at a cert, key, and CA:

```text
  # valkey.conf (TLS enabled)
  tls-port 6379
  port 0                           # optional: disable the plaintext port entirely
  tls-cert-file /tls/tls.crt
  tls-key-file  /tls/tls.key
  tls-ca-cert-file /tls/ca.crt
  tls-auth-clients yes             # require client certs → mutual TLS (mTLS)
```

Clients then speak TLS — the `rediss://` scheme, or `valkey-cli` flags:

```bash
# TLS connection to an externally exposed, encrypted Valkey
valkey-cli --tls --cacert /etc/pki/corp-ca.crt \
  -h valkey.example.internal -p 6379

# connection-string form (note the double-s: rediss, not redis)
#   rediss://:<password>@valkey.example.internal:6379/0
```

When the CA is your corporate internal CA, clients (and any intermediate hop that validates) must **trust that CA** — mount the CA bundle, or add it to the client image's trust store. That whole story — where the bundle comes from, how to inject it, why `valkey-cli --cacert` beats disabling verification — is [TLS and Corporate CAs](/networking/tls-and-corporate-cas/).

### Passthrough vs termination — an L4 hop can't terminate app TLS

At L4 you **pass TLS through**: the appliance, MetalLB Service, or Gateway `TLSRoute` forwards the encrypted bytes untouched and **Valkey terminates**. An L4 hop *cannot* terminate application TLS on its own — the only reason a `TLSRoute` can even route is that it peeks at the plaintext SNI in the ClientHello (§2d); it never decrypts the payload. So the model is always: encrypt at the client, decrypt at Valkey, and let every hop in between forward ciphertext. (The legacy alternative — a `stunnel` sidecar terminating TLS in front of a plaintext Valkey — predates native `tls-port` and is worth retiring when you can.)

### Auth: requirepass and ACL users

The blunt control is `requirepass` (one shared password). The better one is **Valkey ACL users** — named users with least-privilege command and key scoping, so an app credential *can't* run destructive verbs:

```text
  # least-privilege: an app that reads/writes its own keyspace and CANNOT FLUSHALL
  ACL SETUSER app on >s3cr3t ~app:* +@read +@write -@dangerous

  # replication still needs its own credential
  masterauth <replication-password>     # replica authenticating to the primary
```

`~app:*` scopes the user to keys under `app:`; `+@read +@write` grants the read/write command categories; `-@dangerous` strips `FLUSHALL`, `FLUSHDB`, `CONFIG`, `KEYS`, and friends. Connection strings carry the user:

```text
  rediss://app:s3cr3t@valkey.example.internal:6379/0     # user "app", TLS
```

Give each app its own ACL user, not the shared `default`/`requirepass` — a leaked credential should be revocable and least-privileged, not the keys to `FLUSHALL`.

:::caution[Exposing a data port raises the bar]
An externally reachable Valkey needs, together: **TLS** (so credentials and data aren't on the wire in clear), **auth** (ACL users, least-privilege), and a **tight [NetworkPolicy](/networking/network-policies/)**. And remember the SNAT trap from §2a — with `externalTrafficPolicy: Cluster`, kube-proxy rewrites the client source to a **node IP** before the pod sees it, so your policy's `ipBlock` rules must cover the **node CIDRs**, not the real client CIDRs, or you'll block your own VIP while `kubectl exec` tests keep passing. The shared-vip build works this exact problem in its [NetworkPolicy section](/architectures/valkey-shared-vip/#3f-networkpolicy).
:::

## 5. Which door do I use?

```text
Where does the client live, and what topology?
├── IN-CLUSTER ─────────────► headless per-pod DNS (writer) + ClusterIP (read pool). Done. (§1)
│
├── EXTERNAL, primary/replica► MetalLB shared VIP, split by port, behind the
│                              corporate appliance. TLS + auth + node-CIDR NetworkPolicy. (§2a)
│                              No self-service LB? → platform tcp-services or a Gateway TCPRoute. (§2c/§2d)
│
└── EXTERNAL, cluster mode ──► HARD. Per-pod LoadBalancer + per-pod cluster-announce-ip,
                               OR (preferred) a cluster-aware proxy that hides the topology.
                               Honest default: keep cluster mode INTERNAL. (§3)
```

The through-line: internal is trivial, external primary/replica is a solved shared-VIP pattern, and **external cluster mode is the one that costs you** — a per-shard IP budget and standing `cluster-announce` config, or a proxy. If an external consumer only needs a key-value store and not sharded capacity, give them a primary/replica Valkey and skip the whole §3 problem.

## 6. Troubleshooting the path

| Symptom | Likely cause | Confirm / fix |
|---|---|---|
| `EXTERNAL-IP <pending>` on the LoadBalancer | MetalLB pool exhausted, sharing-key mismatch, or `Local` ETP with distinct pod sets | `kubectl describe svc`; byte-identical `metallb.io/allow-shared-ip`, both `externalTrafficPolicy: Cluster` ([MetalLB](/controllers/metallb/)) |
| Connects, then every cross-shard key `MOVED` to a `10.x` address that hangs | Cluster mode advertising **pod IPs** — `cluster-announce-ip` unset or wrong | Set per-pod `cluster-announce-ip/-port/-bus-port` to each pod's external address (§3), or front it with a cluster-aware proxy |
| Works from inside the cluster, fails from outside | Announce/NAT: internal DNS resolves, external routing doesn't; or cluster-mode announce pointing at internal addresses | Test the MetalLB IP directly, then the appliance VIP; for cluster mode verify announced addresses are externally routable |
| TLS handshake failure / cert error | Client doesn't trust the (corporate) CA, or SNI missing on a `TLSRoute` hop | `openssl s_client -connect host:6379 -servername host`; mount the CA bundle ([TLS and Corporate CAs](/networking/tls-and-corporate-cas/)) |
| Connection drops after N seconds idle | Appliance idle timeout **below** Valkey `tcp-keepalive` — the strictest hop wins | Set `tcp-keepalive` under the appliance timeout, enable client socket keepalives ([Long-Lived Connections](/networking/long-lived-connections/)) |
| `connection refused` / timeout only after adding a NetworkPolicy | `ipBlock` covers client CIDRs but not **node CIDRs** — ETP `Cluster` SNAT'd the source to a node IP | Add the node CIDR to the ingress rule; the pod sees node IPs, not clients (§4, [NetworkPolicies](/networking/network-policies/)) |
| ingress-nginx tcp-services port dead | Controller not started with `--tcp-services-configmap`, or the port not opened on its Service | Platform ticket: both the flag and the controller Service port are theirs ([TCP Ingress](/networking/tcp-ingress/)) |

---

Once a connection lands, what you do with it — read/write splitting semantics, which verbs are safe on a replica, pipelining, transactions, and `{hashtag}` key design for cluster mode — is the sibling [Valkey Data Access Patterns](/architectures/valkey-data-access-patterns/) page. Back to the [Valkey Helm Chart Deep Dive](/architectures/valkey-helm-deep-dive/) for the chart that renders all of this, and to [Lab 9: Valkey the Hard Way](/labs/lab-9-valkey/) to build and break the path on a real cluster.
