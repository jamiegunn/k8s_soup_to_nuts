---
title: "Lab 3: Wiring a Backend Service"
description: Add a Valkey cache behind orders-api — author a second mini-chart, discover it via Service DNS, share a Secret, gate startup with an initContainer, then break it on purpose.
sidebar:
  order: 5
---

So far `orders-api` talks to nobody. Real services almost always have something behind them — a database, a queue, a cache — and the way one pod finds another is the most load-bearing piece of Kubernetes networking. In this lab you'll add a **Valkey** cache behind the API. The interesting part isn't Valkey: it's the wiring — Service DNS, a shared Secret, a startup dependency, and what happens when each of those breaks.

**What you'll have at the end:** two Helm releases (`orders` and `cache`) in the `labs` namespace, `orders-api:0.3.0` caching reads in Valkey with a TTL, discovered purely by DNS name — plus first-hand experience of a cold cache, a shared cache, and a missing Secret.

## Prerequisites

- [Lab 0](/labs/lab-0-cluster/), [Lab 1](/labs/lab-1-java-api/), and [Lab 2](/labs/lab-2-config-and-secrets/) completed: the Lima `k3s` cluster exists, `orders-api:0.2.0` is deployed as release `orders` from `~/k8s-labs/charts/orders-api`, and config flows through env vars, a Secret, and ConfigMap files.
- If you paused between sittings, revive everything (the last command should show `lima-k3s … Ready`):

```bash
limactl start docker && limactl start k3s
export DOCKER_HOST="unix://$HOME/.lima/docker/sock/docker.sock"
export KUBECONFIG="$HOME/.lima/k3s/copied-from-guest/kubeconfig.yaml"
kubectl get nodes
```

All commands run from `~/k8s-labs/` unless stated otherwise, and `kubectl` defaults to the `labs` namespace (set in Lab 0).

## 1. The shape of the thing

Here's what you're building:

```console
curl → Service orders-api → orders-api pod(s)
          │ SPRING_DATA_REDIS_HOST=cache-valkey
          ▼ Service cache-valkey → Valkey pod
```

The API never learns a pod IP. It connects to the hostname `cache-valkey`, a **Service** — a stable name and virtual IP that survives every pod death behind it. That indirection is the whole lab.

One design decision up front: Valkey here is a **Deployment**, not a StatefulSet. Doesn't a cache hold state? Yes — state we can afford to lose: every key is rebuildable from the source of truth and expires on a TTL anyway. No stable identity, no persistent volume, no ordered startup — none of the things a StatefulSet buys. A cache that *must not* lose data isn't a cache, it's a database wearing a disguise. The full argument, including when Valkey *does* deserve persistence, is in [Valkey and Redis on Kubernetes](/stateful/valkey-and-redis/).

## 2. Author the Valkey mini-chart

You could add Valkey's manifests into `charts/orders-api` — resist that. The cache has its own lifecycle: you'll want to restart, upgrade, or delete it without touching the API's release history. So it gets its own chart and its own release: the **chart-per-service** pattern. The alternative — making Valkey a *subchart* (a dependency in `Chart.yaml`) — couples the lifecycles: every `helm upgrade orders` would also reconcile Valkey, and rolling back the API would roll back the cache. Subcharts earn their keep when components genuinely ship together; independent services deserve independent releases. Details of both layouts: [Helm Chart Anatomy](/helm/chart-anatomy/).

Create the skeleton:

```bash
mkdir -p ~/k8s-labs/charts/valkey/templates
```

`charts/valkey/Chart.yaml`:

```yaml
apiVersion: v2
name: valkey
description: A single-node Valkey cache for the labs
version: 0.1.0
appVersion: "8"
```

`charts/valkey/values.yaml`:

```yaml
fullnameOverride: cache-valkey
image:
  repository: valkey/valkey
  tag: "8"
auth:
  existingSecret: cache-auth
  secretKey: password
maxmemory: 64mb
resources:
  requests: {cpu: 50m, memory: 96Mi}
  limits: {memory: 128Mi}
```

Note what's *not* here: the chart never sees the password, and it never creates the Secret. It only knows the **name** of a Secret that must already exist. Create it now, before anything references it:

```bash
kubectl create secret generic cache-auth --from-literal=password=labs-cache-pw
```

```console
secret/cache-auth created
```

:::note
Keeping secret creation out of the chart is deliberate: a chart that templates its own passwords ends up with credentials in `values.yaml`, in release history, and in every `helm get values`. The "existingSecret" convention — used by most public charts — keeps the credential's lifecycle in your hands. You saw the same idea from the consumer side in Lab 2.
:::

`charts/valkey/templates/deployment.yaml` (a mini-chart this size can skip `_helpers.tpl` and template names straight from values):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Values.fullnameOverride }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{ .Values.fullnameOverride }}
  template:
    metadata:
      labels:
        app: {{ .Values.fullnameOverride }}
    spec:
      containers:
        - name: valkey
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          args:
            - --requirepass
            - "$(VALKEY_PASSWORD)"
            - --maxmemory
            - {{ .Values.maxmemory | quote }}
            - --maxmemory-policy
            - allkeys-lru
          env:
            - name: VALKEY_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.auth.existingSecret }}
                  key: {{ .Values.auth.secretKey }}
          ports:
            - containerPort: 6379
          readinessProbe:
            exec:
              command: ["sh", "-c", "valkey-cli -a \"$VALKEY_PASSWORD\" ping | grep -q PONG"]
            periodSeconds: 5
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          emptyDir: {}
```

Three choices worth noticing:

- **`$(VALKEY_PASSWORD)` in `args`.** Kubernetes expands `$(VAR)` references in `args` from the container's own env vars — so the password reaches `--requirepass` without ever appearing in the manifest.
- **The readiness probe authenticates.** A probe that just checks the port would pass even if auth were misconfigured. `valkey-cli -a … ping` proves the thing your app actually needs: an authenticated `PONG`. Probes should test what clients depend on — the full philosophy is in [Health Checks](/workloads/health-checks/).
- **`emptyDir` for `/data`.** No PersistentVolume. When the pod dies, the data dies — and that's the "cache, not a store" decision made explicit in YAML. Combined with `--maxmemory 64mb` and `allkeys-lru` eviction, this Valkey can never grow beyond its budget or outlive its pod.

`charts/valkey/templates/service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ .Values.fullnameOverride }}
spec:
  selector:
    app: {{ .Values.fullnameOverride }}
  ports:
    - port: 6379
```

Because `fullnameOverride` is `cache-valkey`, the Service — and therefore the DNS name every client uses — is exactly `cache-valkey`. That name is now part of your API's contract.

## 3. Install and verify the cache

```bash
helm install cache charts/valkey
kubectl get pods
```

```console
NAME                            READY   STATUS    RESTARTS   AGE
cache-valkey-7d9c6b5f4-x2m8k    1/1     READY     0          15s
orders-api-6f8d9c7b5-qw4rt     1/1     Running   0          2d
```

`READY 1/1` on the Valkey pod means the authenticated probe passed. Now talk to it directly:

```bash
kubectl exec deploy/cache-valkey -- valkey-cli -a labs-cache-pw PING
```

```console
Warning: Using a password with '-a' or '-u' option on the command line interface may not be safe.
PONG
```

That warning is valkey-cli being a good citizen about shell history — fine for a lab, noted for life.

## 4. Teach the app to cache (0.3.0)

Add the Redis starter (Valkey speaks the Redis protocol) to `app/pom.xml`, next to the existing starters:

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis</artifactId>
</dependency>
```

Then update the controller so `GET /api/orders/{id}` reads through the cache. Replace `app/src/main/java/com/example/orders/OrderController.java` (keep your package name if yours differs from Lab 1 — only the caching logic is new):

```java
package com.example.orders;

import java.time.Duration;
import java.util.Map;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private static final Map<String, String> ORDERS = Map.of(
        "1001", "3x espresso beans", "1002", "1x burr grinder", "1003", "2x filter papers");

    private final StringRedisTemplate redis;

    public OrderController(StringRedisTemplate redis) {
        this.redis = redis;
    }

    @GetMapping
    public Map<String, String> all() {
        return ORDERS;
    }

    @GetMapping("/{id}")
    public ResponseEntity<Map<String, String>> byId(@PathVariable String id) {
        String key = "orders::" + id;
        // 1. Try the cache — and treat ANY cache failure as a miss.
        try {
            String cached = redis.opsForValue().get(key);
            if (cached != null) {
                return ResponseEntity.ok(Map.of("id", id, "item", cached, "source", "cache"));
            }
        } catch (Exception e) { /* Valkey unreachable? Fall through, serve live. */ }

        // 2. "Load" the order (stand-in for a slow database call).
        String item = ORDERS.get(id);
        if (item == null) {
            return ResponseEntity.notFound().build();
        }
        try { Thread.sleep(300); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }

        // 3. Populate the cache with a TTL — best effort, same rule.
        try {
            redis.opsForValue().set(key, item, Duration.ofSeconds(60));
        } catch (Exception e) { /* Cache write failed; the response is still correct. */ }
        return ResponseEntity.ok(Map.of("id", id, "item", item, "source", "live"));
    }
}
```

The two `try/catch` blocks are the **graceful degradation** path: if Valkey is gone, every request quietly becomes a cache miss and the API keeps answering. A cache outage should cost you latency, never availability. For that to hold, the client must fail *fast* — Lettuce's default timeout is a leisurely 60 seconds. Cap it in `app/src/main/resources/application.yaml`:

```yaml
spring:
  data:
    redis:
      timeout: 250ms
      connect-timeout: 250ms
```

Where's the host and password config? Nowhere in the app — and that's the point. Spring's relaxed binding maps the env vars `SPRING_DATA_REDIS_HOST`, `SPRING_DATA_REDIS_PORT`, and `SPRING_DATA_REDIS_PASSWORD` straight onto `spring.data.redis.*`. The chart will supply them. Same pattern you built in Lab 2, new consumer.

Build and import, same dance as always (expect the `unpacking docker.io/library/orders-api:0.3.0 …done` line):

```bash
docker build -t orders-api:0.3.0 app/
docker save orders-api:0.3.0 | limactl shell k3s sudo k3s ctr images import -
```

## 5. Wire the chart: DNS, the shared Secret, and a gate

In `charts/orders-api/values.yaml`, bump the image tag to `"0.3.0"` and add a cache block:

```yaml
cache:
  host: cache-valkey
  port: "6379"
  existingSecret: cache-auth
  secretKey: password
```

In `charts/orders-api/templates/deployment.yaml`, add to the container's `env` list (alongside the Lab 2 entries):

```yaml
            - name: SPRING_DATA_REDIS_HOST
              value: {{ .Values.cache.host | quote }}
            - name: SPRING_DATA_REDIS_PORT
              value: {{ .Values.cache.port | quote }}
            - name: SPRING_DATA_REDIS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.cache.existingSecret }}
                  key: {{ .Values.cache.secretKey }}
```

Stop at `SPRING_DATA_REDIS_HOST=cache-valkey`. That value is a bare Service name — no IP, no FQDN, no config server. Inside the cluster, DNS resolves `cache-valkey` (via the pod's search domains, really `cache-valkey.labs.svc.cluster.local`) to the Service's virtual IP, and the Service forwards to whatever healthy Valkey pod exists at that instant. **This is service discovery in Kubernetes** — a DNS name that outlives every pod behind it. The mechanics are in [DNS](/networking/dns/) and [Services Deep Dive](/networking/services-deep-dive/).

Both deployments reference the *same* Secret, `cache-auth` — the **shared-secret pattern**. It's honest to name its limits: the Secret lives in one namespace, both parties must sit there; rotating it means rolling both workloads in the right order; and anything with `get secret` in the namespace can read it. Fine for a lab and common in real clusters, but it's a convention, not a security boundary — production systems reach for external secret stores and per-client credentials.

One more addition — a startup gate. In the pod spec, directly above `containers:`:

```yaml
      initContainers:
        - name: wait-for-cache
          image: busybox:1.37
          command: ["sh", "-c", "until nc -z {{ .Values.cache.host }} {{ .Values.cache.port }}; do echo waiting for cache; sleep 2; done"]
```

The initContainer must exit successfully before the app container starts, so `orders-api` never boots into a world where the cache DNS name doesn't answer. Busybox's `nc -z` is a pure TCP connect test — no auth, no protocol — which is exactly the right amount of checking for a gate (the app's own degradation path handles the rest). Why this beats retry loops in bash entrypoints, and when a sidecar fits better, is in [Init and Sidecar Containers](/workloads/init-and-sidecar-containers/); busybox's toolbox itself is cataloged in [Busybox](/troubleshooting/busybox/).

## 6. Upgrade and prove it end to end

```bash
helm upgrade orders charts/orders-api && kubectl rollout status deploy/orders-api
```

```console
Release "orders" has been upgraded. Happy Helming!
deployment "orders-api" successfully rolled out
```

The app has no ingress yet (that's Lab 4), so port-forward — using local port 8088, keeping clear of anything else camped on 8080 on your Mac — and hit the endpoint twice, inside the 60-second TTL:

```bash
kubectl port-forward svc/orders-api 8088:8080 &
time curl -s http://localhost:8088/api/orders/1001
time curl -s http://localhost:8088/api/orders/1001
```

```console
{"id":"1001","item":"3x espresso beans","source":"live"}
curl -s http://localhost:8088/api/orders/1001  0.373 total
{"id":"1001","item":"3x espresso beans","source":"cache"}
curl -s http://localhost:8088/api/orders/1001  0.058 total
```

`source` flipped from `live` to `cache` and the 300 ms of fake database work vanished. Now prove the key actually lives in Valkey:

```bash
kubectl exec deploy/cache-valkey -- valkey-cli -a labs-cache-pw KEYS 'orders::*'
kubectl exec deploy/cache-valkey -- valkey-cli -a labs-cache-pw TTL orders::1001
```

```console
orders::1001
47
```

One key, 47 seconds of life left. The whole chain works: app → DNS → Service → pod → memory.

## 7. Failure drills

Working systems teach less than broken ones. Three drills — observe each before fixing anything.

**Drill 1: kill the cache.** Keep a curl loop going in a second terminal (`while true; do curl -s http://localhost:8088/api/orders/1001; echo; sleep 1; done`), then:

```bash
kubectl delete pod -l app=cache-valkey
kubectl get pods -w
```

```console
cache-valkey-7d9c6b5f4-n5j2w    0/1     ContainerCreating   0     2s
cache-valkey-7d9c6b5f4-n5j2w    1/1     Running             0     6s
```

Watch the curl loop: during the gap every response says `"source":"live"` — slightly slower, never failing. That's the `try/catch` from step 4 earning its keep, bounded by the 250 ms timeout. The Deployment replaces the pod within seconds, the cache comes back **empty** (emptyDir — you chose this), and the next request repopulates it. Run the `KEYS` command again right after the restart to see the empty-then-refilled sequence yourself.

**Drill 2: scale the API and share the cache.**

```bash
kubectl scale deploy/orders-api --replicas=3
kubectl rollout status deploy/orders-api
```

Curl `/api/orders/1002` a few times through the port-forward. The first hit says `live`; every subsequent hit says `cache` — *regardless of which replica served it*, because all three replicas talk to the same `cache-valkey`. Contrast with an in-process cache, where each replica would pay its own miss. Scale back with `kubectl scale deploy/orders-api --replicas=1`. (Note that `kubectl scale` drifts from your chart's values — the next `helm upgrade` snaps it back. That's a feature, and a Lab 1 lesson revisited.)

**Drill 3: delete the Secret and roll.**

```bash
kubectl delete secret cache-auth
kubectl rollout restart deploy/orders-api
kubectl get pods
```

```console
NAME                           READY   STATUS                       RESTARTS   AGE
orders-api-5b7f8d9c6-k8s2p     0/1     Init:CreateContainerConfigError   0    10s
orders-api-6f8d9c7b5-qw4rt     1/1     Running                      0          9m
```

Decode it: `CreateContainerConfigError` means the kubelet couldn't *assemble* the container — here, an env var points at a Secret that doesn't exist. `kubectl describe pod <new-pod>` says it plainly: `Error: secret "cache-auth" not found`. Notice two mercies: the old pod keeps serving (the rolling update won't proceed past a broken new pod), and the running Valkey pod is untouched — its env was injected at *its* start. Recreate the Secret and the kubelet's retry loop fixes the pod on its own, no redeploy needed:

```bash
kubectl create secret generic cache-auth --from-literal=password=labs-cache-pw
```

This error and its cousins are cataloged in [CrashLoopBackOff and Friends](/troubleshooting/crashloopbackoff/) and the [Error Index](/troubleshooting/error-index/).

## 8. Exploration: see the DNS with your own eyes

The app image is a slim JRE — no `nslookup`, no `dig`, by design. So borrow a toolbox with an **ephemeral debug container** attached to the running API pod:

```bash
POD=$(kubectl get pod -l app=orders-api -o name | head -1)
kubectl debug -it $POD --image=busybox:1.37 --target=orders-api -- sh
```

Inside:

```bash
nslookup cache-valkey
```

```console
Server:         10.43.0.10
Address:        10.43.0.10:53

Name:   cache-valkey.labs.svc.cluster.local
Address: 10.43.143.201
```

There's the trick exposed: you asked for the bare name `cache-valkey`, and the answer came back for `cache-valkey.labs.svc.cluster.local` — the pod's `resolv.conf` search domains (run `cat /etc/resolv.conf` to see them) expanded it, and the nameserver `10.43.0.10` is CoreDNS itself. Compare the returned address with `kubectl get svc cache-valkey`: it's the Service's ClusterIP, not any pod's. Exit with `exit`. Naming rules live in [DNS](/networking/dns/); what CoreDNS does with that query is in [CoreDNS Deep Dive](/routing/coredns-deep-dive/).

:::caution
**Troubleshooting box**

- **`Init:0/1` forever on orders-api** — the wait-for-cache gate can't reach Valkey. Is the `cache` release installed and its pod `1/1`? Does `kubectl get svc cache-valkey` exist? A typo in `cache.host` shows up here first.
- **`NOAUTH Authentication required` in app logs, or the Valkey pod stuck `0/1 Running`** — wrong or missing password somewhere. Check `kubectl exec deploy/orders-api -- env | grep REDIS`, and remember the readiness probe authenticates too: a bad Secret key fails the probe itself.
- **Every response says `live`, never `cache`** — writes are failing silently. `kubectl logs deploy/cache-valkey` for `maxmemory` or auth errors; verify the TTL hasn't simply elapsed between curls.
- Systematic version of all this: [Service Unreachable](/troubleshooting/service-unreachable/).
:::

## Where you are now

Two charts, two releases, one namespace: `orders` (0.3.0) reading through `cache` via nothing but a DNS name and a shared Secret, gated by an initContainer, degrading gracefully when the cache is gone. Stop the port-forward (`kill %1`) and pause with `limactl stop docker && limactl stop k3s` if you're done for the day. What you built is the toy edition of a real pattern — the production version, with replication, failover, and a stable VIP shared across clients, is assembled piece by piece in [Valkey with a Shared VIP](/architectures/valkey-shared-vip/). Read it after Lab 4 and you'll recognize every part.

Next: [Lab 4: Ingress and the Full Path](/labs/lab-4-ingress-end-to-end/) — where `curl` finally gets to come from your Mac instead of a port-forward.
