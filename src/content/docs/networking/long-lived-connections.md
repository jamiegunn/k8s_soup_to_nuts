---
title: gRPC, WebSockets, and Long-Lived Connections
description: Why Service load balancing breaks for gRPC, WebSockets, and connection pools — one hot pod, disconnect storms on deploy, stale conntrack — and the fixes ranked.
sidebar:
  order: 12
---

Every load-balancing promise Kubernetes makes was designed for short-lived HTTP/1.1: open a connection, send a request or a few, close it. gRPC, WebSockets, database pools, and message-queue consumers all break that assumption, and they all break it the same way. This article is the pattern and its fixes — because "one pod at 90% CPU while its two replicas idle" and "every deploy disconnects all our users at once" are the same root cause wearing different costumes.

## The root cause, stated once

**kube-proxy balances connections, not requests.** When your client connects to a ClusterIP, kube-proxy's iptables/IPVS rules pick a backend pod *at connection time* and then get out of the way — every subsequent byte on that TCP connection goes to that same pod, forever, with no L7 awareness at all (see [Services deep dive](/networking/services-deep-dive/) for the mechanics). This is fine when connections are plentiful and short: the law of large numbers balances you.

It's defeated by anything that inverts the ratio:

- **HTTP/2 and gRPC** multiplex thousands of requests over *one* connection per client.
- **WebSockets** hold one connection per user for hours.
- **DB pools and MQ consumers** open N connections at startup and keep them for the process lifetime.

Few, long connections ⇒ the connection-time coin flip decides your traffic distribution for the next several hours. Scaling out doesn't help either: new pods receive **zero** traffic because nobody opens new connections.

## The gRPC classic: three replicas, one hot pod

The scenario, seen in every org that adopts gRPC: `checkout` calls `inventory` via gRPC at `inventory:9090`, a normal ClusterIP Service, 3 replicas. `kubectl top pod` tells the story:

```console
NAME                         CPU(cores)   MEMORY(bytes)
inventory-6f8d4b9c7d-2lmxw   12m          180Mi
inventory-6f8d4b9c7d-9qhzv   14m          178Mi
inventory-6f8d4b9c7d-k4tpn   1840m        612Mi
```

Each `checkout` replica opened exactly one HTTP/2 connection at startup, kube-proxy assigned each to a pod, and multiplexing does the rest — 100% of requests from each client ride that single connection. Scale `inventory` to 6 and the three new pods sit at 0 RPS.

The fixes, ranked:

### 1. Client-side load balancing with a headless Service

Give the client all the pod IPs and let gRPC balance per-call across them:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: inventory-headless
spec:
  clusterIP: None          # headless: DNS returns every pod IP
  selector:
    app: inventory
  ports:
    - port: 9090
```

```go
conn, err := grpc.NewClient(
    "dns:///inventory-headless.my-team.svc.cluster.local:9090",
    grpc.WithDefaultServiceConfig(`{"loadBalancingConfig": [{"round_robin":{}}]}`),
)
```

The `dns:///` resolver fetches all A records and `round_robin` spreads calls across a connection to each pod. **The caveat:** gRPC's DNS resolver does not poll. It re-resolves on connection *failure*, but a scale-up breaks nothing — so new pods can go unnoticed for a long time. Mitigate with `MaxConnectionAge` on the server (below), which forces periodic reconnect-and-re-resolve. Also mind your resolver's cache: a client that cached DNS aggressively defeats this scheme entirely (more on that below).

:::note
Don't reach for the Service's `sessionAffinity: ClientIP` here — it makes connection distribution *worse* on purpose, pinning all connections from one client IP to one pod. It exists for legacy stateful clients, not for balancing. And its opposite number, "just disable keep-alive," trades your imbalance for a connection-setup tax on every single request. Neither is the fix.
:::

### 2. An L7 proxy that speaks HTTP/2 per-request

Put something request-aware in the path: it terminates the client's HTTP/2 connection and balances *individual requests* across backends. Options, in rough order of likelihood you already have one:

- **The service mesh.** If your platform runs Istio/Linkerd, this problem is already solved — the sidecar load-balances gRPC per-request out of the box, and it's the single best argument for joining the mesh. See [service mesh for app teams](/networking/service-mesh/).
- **Ingress-nginx** for gRPC entering the cluster: `nginx.ingress.kubernetes.io/backend-protocol: "GRPC"` — see [ingress and routing](/networking/ingress-and-routing/) for the TLS prerequisites.
- **A dedicated Envoy** deployment in front of the service, if you're meshless and need east-west gRPC balancing badly enough to run a proxy.

### 3. `MaxConnectionAge`: blunt but effective

Make the server hang up periodically. The client reconnects, kube-proxy flips a fresh coin, and connections churn enough for statistics to work again. No client changes, no new infrastructure:

```go
// Go server
grpc.NewServer(grpc.KeepaliveParams(keepalive.ServerParameters{
    MaxConnectionAge:      2 * time.Minute,
    MaxConnectionAgeGrace: 20 * time.Second,  // in-flight RPCs get this long to finish
}))
```

```java
// Java server
NettyServerBuilder.forPort(9090)
    .maxConnectionAge(2, TimeUnit.MINUTES)
    .maxConnectionAgeGrace(20, TimeUnit.SECONDS)
    .addService(new InventoryService())
    .build();
```

The server sends HTTP/2 **GOAWAY**, the client drains gracefully and reconnects — zero failed RPCs when the grace period exceeds your longest call. It's not perfect balance, it's "rebalanced every two minutes," which is usually plenty. It also fixes the headless-DNS staleness above, so options 1 and 3 combine well.

## WebSockets: connected is easy, staying connected is the job

WebSockets traverse most ingress controllers fine (the `Upgrade` handshake is handled automatically by ingress-nginx, Traefik, HAProxy). The problems come after the handshake.

### Idle timeouts at every hop

Your connection crosses client-side LB → cloud/hardware LB → ingress controller → your pod, and **every hop has an idle timeout; the shortest one wins.** ingress-nginx defaults to 60s of proxy read/send timeout — a quiet WebSocket dies at 61 seconds with a close the client never requested:

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

The cloud LB in front has its own idle timeout (AWS NLB: 350s, fixed; ALB: 60s default, configurable) and that's platform territory — ask what it is rather than guessing from disconnect patterns. Belt and suspenders: send **application-level pings every ~30s**, which resets every idle timer on the path and doubles as dead-connection detection.

### Rolling updates disconnect everyone at once

Deploy a new version and every pod is replaced; every WebSocket drops; every client reconnects simultaneously into a thundering herd. Two-part fix, and the second part matters more:

1. **Pace the rollout**: `maxSurge: 1, maxUnavailable: 0` plus a real drain period replaces pods one at a time, turning one cliff into N smaller steps — see [rollouts and rollbacks](/workloads/rollouts-and-rollbacks/).
2. **Client reconnect with exponential backoff and jitter.** Disconnects are a *when*, not an *if* — node drains and pod evictions don't consult your deploy schedule (see [high availability](/workloads/high-availability/)). A client that reconnects after `random(0, min(cap, base·2ⁿ))` seconds turns a herd into a trickle. This is the real fix; rollout pacing just reduces how often you need it.

### Sticky sessions, and why to avoid needing them

If a user's state (their room subscriptions, their game session) lives in the pod's memory, a reconnect that lands on a different pod loses it. Cookie-based affinity at the ingress (`nginx.ingress.kubernetes.io/affinity: "cookie"`) papers over this — until the pod dies and the state is gone anyway. **Externalize the state** (Redis pub/sub, a session store) so any pod can serve any client; stickiness then becomes an optimization, not a correctness requirement. Stickiness as a *requirement* also quietly breaks scale-down, spot instances, and rollouts — you've built a stateful service and told nobody.

## Draining: rolling updates and long connections generally

Whatever the protocol, graceful replacement is the same recipe. On pod termination, Kubernetes sends SIGTERM *and* removes the pod from Service endpoints roughly in parallel — your job is to stop taking new work, finish existing work, then exit:

```yaml
spec:
  terminationGracePeriodSeconds: 120   # > your longest connection drain
  containers:
    - name: app
      lifecycle:
        preStop:
          exec:
            command: ["sh", "-c", "sleep 10"]  # let endpoint removal propagate first
```

The `sleep` covers the window where the pod is terminating but ingresses/kube-proxy haven't caught up. Then, on SIGTERM, by workload:

- **HTTP/2 & gRPC**: send GOAWAY, finish in-flight streams, exit (grpc-go `GracefulStop()`, grpc-java `shutdown()` + `awaitTermination`).
- **WebSockets**: send close frames (ideally trickled over a few seconds, not all at once), rely on client reconnect.
- **MQ consumers**: stop fetching (cancel the consumer / pause the listener container), finish and ack in-flight messages, exit. If processing can exceed the grace period, make handling idempotent — the redelivery *will* happen eventually regardless.

`terminationGracePeriodSeconds` must exceed preStop + your worst-case drain, or SIGKILL cuts connections mid-flight anyway.

## Keep-alive pitfalls, both directions

Long-lived connection problems flow both ways across a pod boundary.

**Client side: pools full of dead connections.** Your app's HTTP/DB pool holds connections to pod IPs that no longer exist after a scale-down or deploy of the *server*. Conntrack entries go stale; the next borrow from the pool gets an RST — a burst of `Connection reset by peer` five minutes after someone else's rollout is this signature. Fixes: enable **TCP keepalive** on pooled connections (detects dead peers) and set a **pool max connection lifetime** (e.g. HikariCP `maxLifetime=1800000`) so connections rotate before the world changes under them.

**Server side: the 502-on-reused-connection classic.** Rule to tattoo somewhere: **your server's keep-alive idle timeout must be LONGER than the idle timeout of whatever proxies to it.** If your app closes idle connections at 5s and ingress-nginx reuses upstream connections it considers valid for 60s, nginx will occasionally write a request into a connection your app is closing at that exact moment → sporadic `502` with `upstream prematurely closed connection` in the controller logs, at a rate too low to reproduce and too high to ignore. Node.js was famous for this (`server.keepAliveTimeout` default 5s); set the app's idle timeout to LB timeout + a margin (e.g. 75s vs nginx's 60s).

## DNS and the client that never asks twice

A long-lived-connection cousin: the client that resolves a name once at startup and holds the answer forever. Recreate a Service (new ClusterIP) or fail over a database, and the client keeps dialing the old IP with religious devotion. The JVM is the canonical offender — with a `SecurityManager`-era default of caching successful lookups **forever**. Fix at the JVM level:

```text
# $JAVA_HOME/conf/security/java.security, or -D at startup
networkaddress.cache.ttl=30
```

Non-JVM stacks have their own variants (resolver caches, connection strings resolved once at pool creation). Pool max-lifetime helps here too: a rotated connection re-resolves. Details of what cluster DNS does and doesn't guarantee: [DNS inside the cluster](/networking/dns/).

## Detection: proving it before fixing it

The smoking gun is **per-pod imbalance** where replicas should be identical:

```bash
kubectl top pod -l app=inventory                       # one hot pod, N idle
# Better: per-pod request rate from your metrics stack, e.g.
# sum by (pod) (rate(grpc_server_handled_total[5m]))
```

Uneven per-pod request rates with even connection *counts* upstream is the connection-level-balancing signature — dashboards for this in [metrics](/observability/metrics/). Then confirm from inside a pod by counting established connections per peer:

```bash
kubectl exec -it deploy/checkout -- ss -tn state established '( dport = :9090 )'
```

```console
Recv-Q  Send-Q  Local Address:Port    Peer Address:Port
0       0       10.244.1.17:41712     10.96.114.3:9090
```

One connection to the Service IP, carrying everything: case closed. A quick per-pod census across all server replicas (who's connected to whom, from the server side):

```bash
for p in $(kubectl get pod -l app=inventory -o name); do
  echo "== $p"
  kubectl exec "$p" -- sh -c "ss -tn state established '( sport = :9090 )' | tail -n +2 | wc -l"
done
```

```console
== pod/inventory-6f8d4b9c7d-2lmxw
1
== pod/inventory-6f8d4b9c7d-9qhzv
1
== pod/inventory-6f8d4b9c7d-k4tpn
4
```

:::tip
Run this census right after a scale-up. New pods showing `0` established connections minutes later is definitive proof your clients aren't re-resolving or reconnecting — and tells you whether to fix the client (option 1) or the server (`MaxConnectionAge`).
:::

## Decision table

| Workload | What breaks | First-choice fix | Ask the platform team for |
|----------|-------------|------------------|---------------------------|
| gRPC service (east-west) | All requests pile onto one pod; scale-out does nothing | Mesh / L7 proxy per-request LB; else headless Service + `round_robin` + `MaxConnectionAge` | Mesh onboarding, or blessing for a headless Service |
| WebSocket fanout | Idle timeouts kill quiet sockets; deploys disconnect everyone | App-level pings + client reconnect with jitter; paced rollouts; externalized session state | LB idle timeout value; ingress read/send timeout overrides |
| DB client (pool) | Stale connections to dead pods; resets after failover | Pool `maxLifetime` + TCP keepalive; short JVM DNS TTL | Heads-up channel for DB/infra maintenance windows |
| MQ consumer | SIGKILL mid-message on deploy; redelivery storms | preStop stop-fetch + drain, adequate `terminationGracePeriodSeconds`, idempotent handlers | Confirmation that grace periods survive node drains |

The unifying principle: assume every connection will die at an inconvenient time, and make both ends indifferent to it. Everything in the table is a variation on that theme.
