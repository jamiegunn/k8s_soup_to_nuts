---
title: "The External Database: In-Cluster App, Out-of-Cluster Data"
description: A complete reference build for the most common corporate topology — the app runs in Kubernetes while the database stays outside — covering naming, egress identity, NetworkPolicy, keepalive alignment, dependency-aware health checks, and the drills that prove each piece.
keywords:
  - ExternalName service
  - ORA-12516 ORA-00018
  - HikariCP connection pool exhaustion
  - egress gateway stable source IP
  - SNAT firewall rule
  - database connect hangs then times out
  - stale JVM DNS cache after failover
  - oracle jdbc keepalive
  - TCPS corporate CA truststore
  - Monday morning first query hangs
  - Postgres on VMs egress identity
sidebar:
  order: 13
---

The other stateful builds in this section put the database *inside* the cluster. In most corporate shops, that's the rarer case. The common one is this: your app runs in Kubernetes, and the data lives where it has lived for fifteen years — Oracle on an Exadata appliance, Postgres on a pair of VMs, DB2 within arm's reach of the mainframe. Nobody is migrating that database this quarter, and nobody should have to. This is the reference build for that shape: **orders-api** in namespace `orders-prod`, talking to an Oracle 19c service the DBA team runs on hardware you will never SSH into. Every manifest below is complete and internally consistent; swap the host, port, and driver details for your Postgres-on-VMs and the architecture is identical.

:::note[Tuning the numbers]
The pool sizes, probe timings, and keepalive values in this build are starting points with the reasoning attached. Derive your own resource numbers with [Requests & Limits Knobs](/tuning/requests-limits-knobs/) and your own timeout ladder with the [Timeout Budget](/tuning/timeout-budget/).
:::

## 1. Architecture overview

```text
 ┌─ KUBERNETES CLUSTER ────────────────────────────┐
 │ namespace: orders-prod                          │
 │                                                 │
 │  orders-api ×4 (Deployment)                     │
 │   pool: 10 conns/pod ──► "orders-db" name       │
 │       │                  (ExternalName, §2)     │
 │       ▼                                         │
 │  egress path — one of:                          │
 │   (a) pod-egress SNAT → NODE IPs (default)      │
 │   (b) egress gateway  → 10.20.50.9 (recommended)│
 └───────│─────────────────────────────────────────┘
         │  source = node IPs or 10.20.50.9
         ▼
   corporate firewall(s) — network team
   rule: src 10.20.50.9/32 → dst 10.60.8.20:1521
   idle timeout: 1800s (ask; it matters in §5)
         │
         ▼
   db-orders.corp.example.com → VIP 10.60.8.20
   Oracle listener :1521, service ORDERS_PRIMARY
   (DBA team's appliance — failover moves the VIP
    or repoints the DNS name; you follow it)
```

Traffic flows one direction: pods dial out, the database never dials in. That makes this an **egress architecture** — no Ingress, no LoadBalancer Service, no MetalLB. The two decisions that shape everything else are *what name the app dials* (§2) and *what source address the database side sees* (§3, and it is **not** the pod IP).

**Who owns what** — four parties, and the tickets in §8 map to them:

| Piece | Owner |
|---|---|
| Everything in `orders-prod`: Deployment, Secret, ExternalName, NetworkPolicy, pool config, probes | **You** |
| The egress path — whether pods SNAT to node IPs or exit via an egress gateway with a stable IP | **Platform team** |
| Routes between cluster and DB network; the corporate firewall rules and their idle timeouts | **Network team** |
| The database, its listener, its VIP/DNS name, its host firewall, your account, your session limit, failover | **DBA team** |

:::tip[Ask for the egress gateway — the "one IP for the DBA team" pattern]
With default pod-egress SNAT, your connections leave the cluster wearing **node IPs** — a set that changes every time the platform team rotates a node pool, which means the DBA team's firewall rule is a moving target ([SNAT and DNAT](/routing/nat/) is the full census of these rewrites). The better shape is an **egress gateway**: all traffic from your namespace exits via one stable IP (`10.20.50.9` here). The rewrite becomes the product — a fixed network passport that survives rescheduling, autoscaling, and cluster growth, and a firewall rule that is one line and never goes stale. Ask the platform team whether their CNI offers it (Calico and Cilium both do); the request template is in §8. Everything below works either way, but the failure table's ugliest row (§7) only exists in the node-IP variant.
:::

## 2. The name: ExternalName vs plain config

The app needs a hostname for the database. Two honest options:

| | ExternalName Service | Config value per environment |
|---|---|---|
| Mechanism | Cluster DNS returns a CNAME to the real host ([DNS](/networking/dns/)) | The real hostname sits in a Secret/ConfigMap per env |
| Repointing after a DB move | Edit **one Service**, every consumer follows on next resolve | Edit config in every env, redeploy or reload |
| Ports | **Ignored.** It's DNS-only — no proxying, no port mapping, no health checking | N/A — the port lives in the connection string anyway |
| NetworkPolicy | **Cannot target it.** Policies select pods and IPs, not CNAMEs — you still write `ipBlock` rules against the real subnet (§3) | Same `ipBlock` rules |
| TLS hostname | **The gotcha:** if the driver verifies the hostname it dialed, it dialed the alias — and the DB's certificate says the *real* name. Mismatch. | The app dials the real name; certificates just work |

We choose the ExternalName, because "the DBA team moved the database" should be a one-line change in one place, not a config hunt across four environments:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: orders-db
  namespace: orders-prod
spec:
  type: ExternalName
  externalName: db-orders.corp.example.com
```

The app connects to `orders-db.orders-prod.svc.cluster.local` (or just `orders-db` from inside the namespace); CoreDNS answers with a CNAME chasing corporate DNS for the A record — the resolution chain, including how the cluster reaches corporate zones at all, is [DNS Integration](/routing/dns-integration/). **Fall back to plain config when** you enable TLS with hostname verification and can't or won't configure the driver around the alias (see [TLS and Corporate CAs](/networking/tls-and-corporate-cas/) for the verification mechanics) — dialing the real name is the boring fix, and boring is correct for TLS.

**The IP-only variant.** Some legacy listeners have no DNS name — the DBA team hands you `10.60.8.20` and a shrug. ExternalName can't hold an IP (it would emit a CNAME to `10.60.8.20.` — a hostname-shaped lie that some resolvers "resolve" and others reject). The right tool is a **Service without a selector plus a manual EndpointSlice**, which mints a real ClusterIP that kube-proxy DNATs to the external address:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: orders-db
  namespace: orders-prod
spec:
  ports:
  - { name: sqlnet, port: 1521, targetPort: 1521 }
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: orders-db-1
  namespace: orders-prod
  labels:
    kubernetes.io/service-name: orders-db   # binds the slice to the Service
addressType: IPv4
ports:
- { name: sqlnet, port: 1521, protocol: TCP }
endpoints:
- addresses: ["10.60.8.20"]
```

Same DNS name for the app, real port mapping if you ever need it, and when the listener moves you edit the EndpointSlice. The cost: nothing updates that slice but you — there's no controller watching the DBA team's change calendar. Both patterns, with the Oracle-specific trimmings, are also in [Oracle on Kubernetes](/stateful/oracle/).

## 3. The manifests

### 3a. Connection Secret

Credentials and the URL live in a Secret — never a ConfigMap, and never baked into the image ([Secrets](/workloads/secrets/) covers sourcing this from Vault or a sealed-secret pipeline instead of literal YAML):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: orders-db-conn
  namespace: orders-prod
type: Opaque
stringData:
  DB_USER: ORDERS_APP
  DB_PASSWORD: "REPLACE-ME-from-your-secret-manager"
  # Modern Oracle: SERVICE NAME (slash form). (ENABLE=BROKEN) turns on
  # SQL*Net-level dead-connection handling; keepalives are §5's job.
  DB_URL: >-
    jdbc:oracle:thin:@(DESCRIPTION=(ENABLE=BROKEN)
    (ADDRESS=(PROTOCOL=TCP)(HOST=orders-db.orders-prod.svc.cluster.local)(PORT=1521))
    (CONNECT_DATA=(SERVICE_NAME=ORDERS_PRIMARY)))
```

**Service name vs SID:** the slash/`SERVICE_NAME` form (`@//host:1521/ORDERS_PRIMARY`) targets a *service* the DBA team can relocate between instances during failover; the colon form (`@host:1521:ORDP`) targets a SID — one specific instance, which is exactly what you don't want to be pinned to during a switchover. If a DBA hands you a SID-style string for anything built after 2005, ask again. Details and the full TNS-descriptor option in [Oracle on Kubernetes](/stateful/oracle/). For Postgres-on-VMs the same Secret holds `jdbc:postgresql://host:5432/orders?targetServerType=primary` and everything else on this page transfers.

### 3b. Deployment — the fragments that matter

This is the DB-relevant slice of the Deployment; the full production stateless build it plugs into (probes ports, spread, PDB, security context) is the [Golden Service](/architectures/golden-service/), and its resource numbers come from [Requests & Limits Knobs](/tuning/requests-limits-knobs/):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
  namespace: orders-prod
spec:
  replicas: 4
  selector:
    matchLabels: { app: orders-api }
  template:
    metadata:
      labels: { app: orders-api }
    spec:
      securityContext:
        sysctls:                          # safe sysctls since K8s 1.29;
        - name: net.ipv4.tcp_keepalive_time     # older clusters: platform
          value: "300"                          # must allowlist these
        - name: net.ipv4.tcp_keepalive_intvl
          value: "60"
        - name: net.ipv4.tcp_keepalive_probes
          value: "5"
      containers:
      - name: app
        image: registry.example.com/orders/orders-api:2.7.1
        envFrom:
        - secretRef: { name: orders-db-conn }
        env:
        - name: JAVA_TOOL_OPTIONS
          value: >-
            -Dsun.net.inetaddr.ttl=30
            -Doracle.net.keepAlive=true
        - name: HIKARI_MAX_POOL_SIZE
          value: "10"
        - name: HIKARI_MAX_LIFETIME_MS
          value: "1500000"    # 25 min — under the 30 min firewall idle (§5)
        - name: HIKARI_KEEPALIVE_MS
          value: "300000"     # 5 min ping on idle pooled connections
        - name: HIKARI_CONN_TIMEOUT_MS
          value: "5000"       # fail borrowing fast; retries per timeout budget
        readinessProbe:
          httpGet: { path: /readyz, port: 8081 }
          periodSeconds: 5
          timeoutSeconds: 2
          failureThreshold: 3     # hysteresis: 15s of failure before leaving rotation
        livenessProbe:
          httpGet: { path: /livez, port: 8081 }  # process-only; NEVER touches the DB (§4)
          periodSeconds: 10
          timeoutSeconds: 2
          failureThreshold: 6
        resources:
          requests: { cpu: 800m, memory: 1536Mi }
          limits:   { memory: 1536Mi }
```

`sun.net.inetaddr.ttl=30` caps the JVM's DNS cache — without it, some JVM configurations cache a resolved address for the process lifetime, and the DB failover drill in §6 becomes a fleet restart. `oracle.net.keepAlive=true` makes the JDBC thin driver actually set `SO_KEEPALIVE`, so the pod sysctls above have something to act on.

### 3c. The pool math — do the multiplication before the DBA does

Every pod carries its own pool; the database sees the *product*. Run this table with real numbers before asking for an account:

| Quantity | Value | Where it comes from |
|---|---|---|
| `maximumPoolSize` per pod | 10 | Sized to the pod's CPU request, not to hope |
| Steady-state replicas | 4 | The Deployment above |
| **Steady-state DB sessions** | **40** | 4 × 10 |
| During a rolling update (`maxSurge: 25%`) | 50 | 5 pods alive at once, old pools drain lazily |
| If an HPA can reach 8 replicas | 80 | *This* is your real ceiling — use the HPA max, not `replicas` |
| **Session limit to request from the DBA** | **100** | Ceiling + headroom for reconnect storms after a blip |

The failure mode when this math is wrong has two distinct faces (§7): if *your* pool is the smaller number, threads queue and Hikari times out borrowing; if the *DB limit* is smaller, new connections die with `ORA-12516`/`ORA-00018` and — the nasty part — they die for **every app sharing that database**, not just yours. Scaling replicas up scales DB sessions up; wire that fact into your HPA review.

### 3d. Egress NetworkPolicy

In a locked-down namespace with default-deny egress, the DB path must be opened explicitly — and this policy is where NAT theory becomes practice:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: orders-api-egress-db
  namespace: orders-prod
spec:
  podSelector:
    matchLabels: { app: orders-api }
  policyTypes: ["Egress"]
  egress:
  - to:                        # DNS first — forget this and NOTHING resolves,
    - namespaceSelector:       # including orders-db; every symptom looks like
        matchLabels:           # "database down"
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels: { k8s-app: kube-dns }
    ports:
    - { port: 53, protocol: UDP }
    - { port: 53, protocol: TCP }
  - to:
    - ipBlock:
        cidr: 10.60.8.0/24     # the DB subnet — see the note on which side sees what
    ports:
    - { port: 1521, protocol: TCP }
```

**Why `ipBlock` works here but means nothing to the DBA's firewall:** NetworkPolicy egress is evaluated **at the pod**, before the packet reaches the node's SNAT — the destination is still the real DB address, so an `ipBlock` on `10.60.8.0/24` matches exactly what you intend. But by the time that packet crosses the corporate firewall, the *source* has been rewritten to a node IP or the egress gateway IP. Two firewalls, two vocabularies: yours speaks destinations (real), theirs speaks sources (post-SNAT). Write the cluster-side rule against the DB subnet; write the §8 network ticket against your egress identity. The rewrite census is [SNAT and DNAT](/routing/nat/); policy patterns and the DNS-rule tax are [Network Policies](/networking/network-policies/). Note the CIDR, not a `/32`: the DBA's failover may move the listener to a sibling VIP in the same subnet, and you'd rather not need a manifest change mid-switchover.

**TLS to the corporate DB:** when the DBA team enables TCPS (usually port 2484), the listener presents a certificate signed by the corporate CA — which no default truststore contains. The truststore wiring — mounting the corporate CA bundle, pointing the JVM at it, and surviving CA rotation — is its own article: [TLS and Corporate CAs](/networking/tls-and-corporate-cas/). Budget for it *before* the security team's deadline, and remember the §2 hostname gotcha decides your naming pattern.

## 4. Health checks: the database is a hard dependency

orders-api without its database is a paperweight — the DB is a **hard** dependency, and per the canonical rules in [Health Check Design](/tuning/health-check-design/), that means: **readiness checks it, with hysteresis; liveness never does.**

`/readyz` includes a pooled `SELECT 1 FROM dual` with its own 800ms budget, so a slow DB fails the check crisply instead of eating the probe's whole `timeoutSeconds`. The hysteresis lives in two layers: the endpoint requires damping (don't flip on one failed ping), and the probe's `failureThreshold: 3 × periodSeconds: 5` means a pod leaves rotation only after 15 seconds of sustained failure — one dropped packet on the corporate middle mile doesn't evict the fleet ([Health Checks](/workloads/health-checks/) has the probe mechanics).

:::danger[The "DB blip must not restart the fleet" rule]
Put the database in the **liveness** probe and here is your outage: the DBA runs a 90-second switchover, liveness fails on all 4 pods, kubelet restarts all of them *simultaneously*, every JVM cold-starts, and 40 connections storm the freshly failed-over database at once — you've converted a blip into a thundering herd against a recovering system, plus a `CrashLoopBackOff` lottery. Liveness answers exactly one question: *is this process wedged?* A healthy process waiting on a remote database is not wedged. `/livez` checks the process and nothing else.
:::

The intended behavior during a DB outage, which §6's blip drill verifies: all pods go `NotReady`, the Service empties, callers get fast connection-refused, restart counters stay at **zero**, and the instant the DB returns, pods pass readiness and rejoin — no restarts, no cold JVMs, no storm. One deliberate wrinkle from [Health Check Design](/tuning/health-check-design/): when a *shared* hard dep dies, an emptied Service means callers see refused connections instead of a polite 503 — if your callers handle 503-with-`Retry-After` better, keep ready and degrade at the application layer instead. Decide on purpose and write it down.

## 5. Timeouts and keepalives across the corporate middle

The classic: everything works Friday. Monday 08:59, the first order of the week hangs for two minutes and dies. Nothing changed — except that every connection in every pool sat idle all weekend, and a stateful firewall between cluster and database quietly dropped their conntrack entries at idle-timeout + 1 second. The firewall doesn't send RSTs for expired flows; it just forgets them. The pool hands your request a connection that *both endpoints* still believe is alive, the query's packets fall into the void, and TCP retransmits into silence until the read timeout finally gives up. The full pathology is [Long-Lived Connections](/networking/long-lived-connections/); the defense is **aligned numbers**:

| Layer | Knob | Value | Rule it satisfies |
|---|---|---|---|
| Corporate firewall | idle timeout | 1800s *(ask — never guess)* | The budget everything below must beat |
| Pod kernel | `tcp_keepalive_time` | 300s | Probe idle sockets at ≤ half the firewall idle |
| Pod kernel | `intvl` × `probes` | 60s × 5 | Dead peer declared ~10 min after first probe |
| JDBC driver | `oracle.net.keepAlive` | `true` | Actually enables `SO_KEEPALIVE` on the socket |
| HikariCP | `keepaliveTime` | 300 000 ms | L7 ping on idle *pooled* connections — belt to the kernel's suspenders |
| HikariCP | `maxLifetime` | 1 500 000 ms (25 min) | Rotate connections before the 30-min firewall window |
| HikariCP | `connectionTimeout` | 5 000 ms | Fail the borrow fast; the retry ladder is the [Timeout Budget](/tuning/timeout-budget/) |
| DBA side | `SQLNET.EXPIRE_TIME` | 10 min | *Their* dead-client detection — ask for it in the §8 ticket |

Three lines of defense, cheapest first: kernel keepalives reset the firewall's idle timer so quiet connections survive; Hikari's `keepaliveTime` validates at the protocol level in case a middlebox ignores bare ACK probes; `maxLifetime` guarantees no connection ever gets *old enough* to hit the window even if both fail. The one number you cannot compute yourself is the firewall's — it's in the network-team template in §8, and "keepalive-friendly" is a negotiable spec, not a default.

## 6. Verification plan

**1. Connectivity proof from a debug pod.** Label it `app: orders-api` so the §3d egress policy applies to it — otherwise you're testing a path your app doesn't have:

```bash
kubectl -n orders-prod run dbcheck --rm -it --labels=app=orders-api \
  --image=nicolaka/netshoot -- bash
nc -vz -w 5 orders-db.orders-prod.svc.cluster.local 1521
# Connection to ... 1521 port [tcp/*] succeeded!   ← route + firewall + listener all good
openssl s_client -connect db-orders.corp.example.com:2484 \
  -servername db-orders.corp.example.com </dev/null | head -20
# (TCPS only) shows the cert chain — check the issuer is the corporate CA
```

`nc` timing out vs being refused is diagnostic — that's the §7 decoder. Do this *before* deploying the app; it separates "network problem" from "app problem" forever after.

**2. Pool-exhaustion drill.** Scale to the HPA maximum and have the DBA watch sessions: `kubectl -n orders-prod scale deploy orders-api --replicas=8`, then on their side `SELECT count(*) FROM v$session WHERE username = 'ORDERS_APP'`. Expect ≤ 80 against the limit of 100 from §3c. If the count approaches the limit at a replica count you consider normal, the multiplication table is wrong in production — fix it now, in daylight.

**3. Firewall-idle drill.** In a test namespace, stop all traffic for firewall-idle-timeout plus five minutes, then run one query. With the §5 stack, it returns instantly; `tcpdump -ni eth0 'tcp port 1521'` inside the pod during the quiet period shows keepalive probes every 300s. Now the negative test: remove the sysctls and `keepaliveTime`, repeat, and watch the first query hang into retransmission — you've reproduced Monday morning on demand, which is the only way to be sure the fix is the fix.

**4. DB-failover drill.** Schedule the DBA team's switchover in a test window and watch from the app side. Expect: in-flight queries error, the pool evicts broken connections, new connections resolve the (possibly repointed) name and land on the new primary within seconds. If reconnection takes minutes and then works after a pod restart, you found the JVM DNS cache — confirm `-Dsun.net.inetaddr.ttl=30` from §3b actually made it into the process (`kubectl exec ... -- jcmd 1 VM.system_properties | grep inetaddr`). Readiness should dip and recover; restart counters must not move.

**5. Blip drill — readiness isolates, liveness holds.** Apply a copy of the §3d policy with the DB rule deleted (DNS rule kept), then watch:

```bash
kubectl -n orders-prod get pods -w
# all pods → 1/2 or 0/1 NotReady within ~20s (readiness hysteresis)  ✓
kubectl -n orders-prod get endpointslices -l kubernetes.io/service-name=orders-api
# empty — callers fail fast                                          ✓
kubectl -n orders-prod get pods -o wide | awk '{print $1, $4}'
# RESTARTS column: still 0 — liveness held                           ✓
```

Restore the policy; pods return Ready with zero restarts. If anything restarted, a dependency has leaked into `/livez` — fix that before it meets a real switchover.

## 7. Failure modes

| Symptom | Likely cause | Confirm / fix |
|---|---|---|
| Connect **hangs** then times out (~5s per §3b, or 60–130s at kernel defaults) | Firewall **silently drops** — no rule for your source, or SNAT identity not allowed. Timeout = drop; instant refusal = RST from a live host with a closed port or a reject rule. The decoder: *timeout → network ticket; refused → DBA ticket (listener)* | `nc -vz -w5` from the debug pod; if it times out, gather your egress identity and file the §8 network ticket |
| App connects to the **old** VIP after a DB migration; new pods work, old pods don't | JVM DNS cache — some configs cache resolution forever, so the repointed CNAME/A change never reaches long-lived processes | Set `networkaddress.cache.ttl` / `-Dsun.net.inetaddr.ttl=30` (§3b); rolling restart clears the immediate incident |
| Hikari: `Connection is not available, request timed out after 5000ms` | **Your** limit: pool exhausted — every borrow queues; the DB is fine | Check leak detection and slow queries first; only then raise `maximumPoolSize` — and redo the §3c table |
| `ORA-12516` / `ORA-00018` (or Postgres `FATAL: too many connections`) on **new** connections | **Their** limit: replicas × pool exceeded the DB session cap — possibly after an innocent-looking scale-up | The §3c multiplication; either lower pool/replicas or request a higher cap with the math attached |
| Worked for months; connect timeouts start after platform maintenance, from *some* pods only | Node pool rotation changed the **SNAT identity** — the DBA firewall still allows the *old* node IPs, and only pods on new nodes fail | Compare `kubectl get nodes -o wide` against the firewall rule; file the platform ticket — then convert to an egress gateway (§1) so this row never fires again |
| TLS handshake failures after the DB's certificate rotation | New cert chains to a CA (or intermediate) your truststore lacks | `openssl s_client` from the debug pod shows the presented chain; update the CA bundle per [TLS and Corporate CAs](/networking/tls-and-corporate-cas/) — and get on the DBA team's rotation notification list (§8) |
| Monday 08:59: first query hangs, second works | Firewall idle-timeout ate the weekend-quiet pool connections (§5) | The §6 idle drill proves the fix; align the keepalive table |
| Everything fails at once, including name resolution in the debug pod | The NetworkPolicy DNS rule went missing — default-deny egress eats port 53 and every error masquerades as "DB down" | `nslookup orders-db` in the debug pod; restore the §3d DNS rule |

## 8. The request templates

Two tickets open this build, and vague versions of them bounce for weeks. Copy, fill, send. (Framing and escalation etiquette: [Working with the Platform Team](/operations/working-with-platform-team/).)

**To the DBA team:**

> We're deploying `orders-api` on the corporate Kubernetes platform, connecting to `ORDERS_PRIMARY` on `db-orders.corp.example.com:1521`. Requests: **(1) Account:** service account `ORDERS_APP`, password delivered via our secret manager, least privilege on the `ORDERS` schema. **(2) Session limit:** please provision for **100 concurrent sessions** (steady state 40; ceiling 80 at max autoscale during rollouts; headroom for reconnects — our math attached). **(3) Our network identity:** connections will arrive from **`10.20.50.9`** (our cluster egress gateway) — *not* from individual server IPs; please allow that source on your host firewall. **(4) Dead-client detection:** please confirm `SQLNET.EXPIRE_TIME` is set (we suggest 10) so sessions from abruptly killed containers get reaped. **(5) Failover:** we follow the service name and re-resolve DNS within 30s — please add us to the switchover notification list, and tell us whether failover repoints DNS or moves the VIP. **(6) TLS:** if/when the listener moves to TCPS, we need the port and the issuing CA two weeks ahead.

**To the network team:**

> Please add a firewall rule for a new application path: **source** `10.20.50.9/32` (Kubernetes egress gateway for namespace `orders-prod` — the platform team can confirm), **destination** `10.60.8.20` **TCP 1521** (Oracle listener, `db-orders.corp.example.com`). Two questions we need answered, not defaulted: **(1)** What is the **idle timeout** on this path? Our connection pools hold long-lived quiet connections; we send TCP keepalives every 300s and rotate connections every 25 minutes — if any device on the path idles out below ~700s, we need to know the number to retune. **(2)** On teardown, does the firewall **drop or reject**? We can work with either, but our runbooks decode timeouts vs resets differently. If the egress gateway isn't provisioned yet, the interim source is the cluster node range `10.20.0.0/16` — we'd rather not ship that rule permanently, for reasons you already know.

If the platform team can't offer an egress gateway, both tickets change shape: the source becomes the node CIDR, wide but honest, and you add a standing agreement that **node pool changes trigger a notification to you** — because §7's stale-SNAT row is now a matter of *when*. That agreement is worth more than the firewall rule itself.
