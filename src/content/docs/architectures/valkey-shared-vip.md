---
title: "Valkey: Two StatefulSets, One MetalLB VIP"
description: A complete, deployable Valkey primary/replica build where two LoadBalancer Services share a single MetalLB VIP, split by port for read-write and read-only traffic.
keywords:
  - Redis primary replica StatefulSet
  - metallb.io/allow-shared-ip shared VIP
  - manual failover promotion runbook
  - REPLICAOF NO ONE promote
  - async replication data-loss window
  - role-aware readiness probe
  - master_link_status up
  - externalTrafficPolicy Cluster shared IP
  - split-brain fence old primary
  - AOF appendfsync everysec durability
  - read write split by port
sidebar:
  order: 2
---

This is a full reference build: a Valkey **primary** StatefulSet (writes) and a **read replica** StatefulSet (async replication), each fronted by its own `LoadBalancer` Service — but both Services claim the **same MetalLB VIP** via `metallb.io/allow-shared-ip`, separated by port. Clients dial the **corporate VIP** (`valkey.example.internal`) on `:6379` for read-write and `:6380` for read-only; the network team's load-balancer appliance pools both ports to the same MetalLB IP inside the cluster. Every manifest below is complete and applies in order.

:::tip[Two companions to this page]
This is the raw, copy-paste build. For the **Helm-packaged** treatment — what belongs in values vs a templated ConfigMap vs a Secret, Longhorn distributed storage, cluster-mode sharding, and cross-cluster active/passive DR — see the [Valkey Helm Chart Deep Dive](/architectures/valkey-helm-deep-dive/). To build it by hand on a local cluster, do [Lab 9: Valkey the Hard Way](/labs/lab-9-valkey/).
:::

:::note[Tuning the numbers]
The resource blocks and probe timings in this build are starting points. Derive your own from measurements with [Requests & Limits Knobs](/tuning/requests-limits-knobs/) and [Health Check Knobs](/tuning/health-check-knobs/); the method is the [Sizing Walkthrough](/tuning/sizing-walkthrough/).
:::

## 1. Architecture overview

```text
  clients ──────► CORPORATE VIP :6379 / :6380  (valkey.example.internal)
                  network team's F5 / NetScaler appliance — OUTSIDE the cluster
                         │
                         │ pools BOTH ports to MetalLB IP 10.40.0.50, same
                         │ port numbers; its health monitors probe that IP too
                         ▼
                 ┌─ KUBERNETES CLUSTER ────────────────────────────────────────┐
                 │                                                             │
                 │  MetalLB runs IN-CLUSTER: controller pod + speaker pods     │
                 │  (DaemonSet on nodes). A speaker makes one NODE answer      │
                 │  for 10.40.0.50 — the pool member the appliance targets,    │
                 │  not the address clients dial.                              │
                 │                                                             │
                 │ :6379 ────── Service valkey-rw ──► valkey-primary-0 ◄────┐  │
                 │                                                          │  │
                 │ :6380 ────── Service valkey-ro ──► valkey-replica-0 ────┘  │
                 │              (6380 → containerPort 6379)     replication   │
                 │                                              via headless  │
                 │                                              DNS           │
                 └─────────────────────────────────────────────────────────────┘
```

:::note[The two VIP layers]
There are two "VIPs" in this picture, owned by different teams, and only one of them is an appliance. The **corporate VIP** is what clients and DNS see: `valkey.example.internal` resolves to an address on the network team's external load balancer (F5 BIG-IP, NetScaler, whatever your site runs) in front of the cluster. The **MetalLB IP** (`10.40.0.50`) is not an appliance at all — it's an IP that a **cluster node** answers for, because the in-cluster MetalLB speaker announced it (ARP in L2 mode, BGP route in BGP mode). To the appliance, that MetalLB IP is just an ordinary pool member: it forwards client connections there and points its health monitors at it. Full chain: client → corporate VIP (appliance) → MetalLB IP (a cluster node) → kube-proxy → Service → pod. Announcement mechanics in [MetalLB](/controllers/metallb/); how the two layers cooperate in [External Load Balancing](/networking/external-load-balancing/).
:::

**Why one VIP with two ports beats two IPs:** MetalLB pools on bare metal are usually small and platform-owned — every IP you burn is a ticket to the platform team. One MetalLB IP means **one pool member** on the network team's appliance, **one DNS record** (`valkey.example.internal`, pointing at the corporate VIP), **one firewall rule** at the corporate edge, and clients that differ only by port number. Read-write vs read-only becomes a connection-string detail, not a DNS migration.

**Why it beats NodePort:** NodePorts land in the 30000–32767 range (no `:6379` for your Redis-protocol clients), they couple clients to node IPs that change when the platform team recycles nodes, and they announce on *every* node. A MetalLB VIP gives you stable, conventional port numbers on a stable address, with `externalTrafficPolicy` as a real choice rather than an afterthought.

:::caution[Be honest about failover]
This design has **manual failover**. If the primary pod dies, the StatefulSet recreates it on the same PVC and clients reconnect — usually within a minute. But if the *node or volume* is lost, promoting the replica is a human action (the full runbook is [§6](#6-operations-notes)). And because replication is **asynchronous**, promotion silently drops any writes the dead primary acknowledged but hadn't yet shipped to the replica — a data-loss window you can measure but not avoid. If you need automatic failover or acknowledged-write guarantees, you want Sentinel or a Valkey operator instead — see [Valkey and Redis on Kubernetes](/stateful/valkey-and-redis/) for that decision. This architecture is the right size when a minute of write downtime and a small async-loss window are acceptable and you want something you fully understand.
:::

## 2. Prerequisites and the platform ask

Three parties own pieces of this build: you own the namespace, Services, and pods; the **platform team** owns MetalLB and its address pools; the **network team** owns the appliance, the corporate VIP, and the DNS record. That means two tickets before applying anything. First, the platform team:

> We need **one IP** from the MetalLB pool assigned to namespace `valkey`, pinned if possible (we'll reference it via `metallb.io/loadBalancerIPs`). We will create **two** `LoadBalancer` Services **sharing that one IP** using `metallb.io/allow-shared-ip: "valkey-vip"` on non-overlapping ports (6379, 6380). Please confirm: (a) IP sharing is not blocked by policy, (b) which pool/IP to use, (c) whether announcements are L2 or BGP.

Then, once the MetalLB IP is known, the network team:

> Please create a VIP for `valkey.example.internal` on the external load balancer, listening on **TCP 6379 and 6380**. Each port forwards to a **single-member pool: 10.40.0.50 on the same port** (6379 → 6379, 6380 → 6380) — that address is our cluster's MetalLB service IP, not a node IP or NodePort. **Monitor:** a plain **TCP check** per port against 10.40.0.50 (a Redis-protocol `PING` monitor would need credentials; our in-cluster readiness probes already gate what answers on that IP). **Idle timeout:** please tell us the configured value — our keepalives must sit below it. **Persistence:** none needed (single pool member). **TLS:** none today; if we add it, it will be passthrough, not terminated on the appliance.

The port mapping is worth spelling out: the appliance exposes `:6379` and `:6380` on the corporate VIP and maps each to the **same port** on the MetalLB IP, so the shared-IP-two-ports design survives both layers — read-write vs read-only stays a port-number detail all the way from the client to the pod.

Two consequences of the appliance hop:

- **Idle timeout.** The appliance's idle timeout is usually the strictest on the whole path — stricter than conntrack or anything kube-side. Valkey's default `tcp-keepalive` is 300 seconds; if the appliance idles out at 300 or lower, set it below that (e.g. `tcp-keepalive 60` in both ConfigMaps) and have clients enable socket keepalives too. The physics of why idle connections die: [Long-Lived Connections](/networking/long-lived-connections/).
- **Client IPs.** The appliance SNATs, so the cluster sees the appliance's self-IP, never the real client — `CLIENT LIST` shows one address for every external connection. PROXY protocol could carry the original IP, but only if *both* ends speak it, and Valkey doesn't. Accept the loss; that's the norm for stateful protocols behind a corporate appliance.

If the network team runs BIG-IP with [F5 CIS](/controllers/f5-cis/), the VIP, pool, and monitor above can be programmed *from* the cluster by manifests instead of by ticket — same topology, different workflow.

The `allow-shared-ip` contract, restated precisely — MetalLB colocates two Services on one IP only if **all three** hold:

1. **Identical sharing-key annotation** — same string value on both Services (`"valkey-vip"` here).
2. **No port overlap** — the port sets must be disjoint (6379 vs 6380: fine).
3. **Compatible `externalTrafficPolicy`** — both `Cluster`, **or** both `Local` *and selecting the exact same pods*.

That third clause decides the ETP question for us. `Local` preserves client source IPs and, for a single-pod backend, is genuinely clean — MetalLB announces from the node that has the pod, so there's no extra hop. But our two Services select **different** pods (primary vs replica), which may sit on different nodes, and one IP can only be announced from one place. MetalLB therefore refuses to share an IP between `Local` Services with different pod sets.

:::danger[Use `externalTrafficPolicy: Cluster` — it is not optional here]
With `Local` on these two Services, the second one sits in `<pending>` forever and the events say only that the IP can't be shared. `Cluster` costs you client source IPs (kube-proxy SNATs to a node IP — this matters for your [NetworkPolicy](#3f-networkpolicy) and for `CLIENT LIST` debugging; for external traffic the appliance's SNAT had already erased them anyway) and adds a possible extra node hop, but it's the only configuration that satisfies the sharing contract with distinct backends. Details in [MetalLB](/controllers/metallb/).
:::

Everything below assumes namespace `valkey` exists (`kubectl create namespace valkey`) and your CI/CD applies manifests in the order shown.

## 3. The manifests

### 3a. Secret and ConfigMaps

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: valkey-auth
  namespace: valkey
type: Opaque
stringData:
  password: "REPLACE-ME-from-your-secret-manager"
```

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: valkey-primary-config
  namespace: valkey
data:
  valkey.conf: |
    port 6379
    dir /data
    appendonly yes
    appendfsync everysec
    save ""
    maxmemory 2gb
    maxmemory-policy noeviction
    repl-diskless-sync yes
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: valkey-replica-config
  namespace: valkey
data:
  valkey.conf: |
    port 6379
    dir /data
    replicaof valkey-primary-0.valkey-primary-headless.valkey.svc.cluster.local 6379
    replica-read-only yes
    appendonly no
    save 900 1
    maxmemory 2gb
    maxmemory-policy noeviction
```

**Why these choices:** The primary is the durability anchor — AOF with `everysec` fsync, RDB snapshots disabled (`save ""`) so the only fork on the primary is the occasional AOF rewrite. The replica inverts that: no AOF, RDB snapshots on, because [§6 backups](#6-operations-notes) run off the replica's PVC. `replicaof` uses the **headless-service FQDN** of pod ordinal 0 — stable DNS that survives pod recreation. `repl-diskless-sync` streams full syncs over the socket instead of writing an RDB to disk first — faster resync after replica restarts. The password is deliberately **not** in these ConfigMaps: `requirepass`/`masterauth` are injected as CLI flags from the Secret (see 3c). Trade-off: flags are visible in `/proc/<pid>/cmdline` on the node — acceptable when only the platform team has node access. The stricter alternative is a Secret mounted as a conf fragment pulled in with `include`; the *wrong* answer is pasting the password into a ConfigMap, which any namespace reader can `kubectl get`.

**The 1.5× rule:** `maxmemory 2gb` against a 3Gi container limit (3c). AOF rewrite and full-sync both `fork()`; copy-on-write means peak RSS can approach 2× dataset under write load, plus replication output buffers. Set the container limit to ~1.5× `maxmemory` or the kernel OOM-kills Valkey mid-rewrite — see the failure table.

### 3b. Headless Services

```yaml
apiVersion: v1
kind: Service
metadata:
  name: valkey-primary-headless
  namespace: valkey
spec:
  clusterIP: None
  publishNotReadyAddresses: true
  selector:
    app: valkey
    role: primary
  ports:
  - { name: valkey, port: 6379 }
---
apiVersion: v1
kind: Service
metadata:
  name: valkey-replica-headless
  namespace: valkey
spec:
  clusterIP: None
  publishNotReadyAddresses: true
  selector:
    app: valkey
    role: replica
  ports:
  - { name: valkey, port: 6379 }
```

**Why:** each StatefulSet needs a governing headless Service to mint per-pod DNS (`valkey-primary-0.valkey-primary-headless...`) — that's the address the replica replicates to. `publishNotReadyAddresses: true` matters: during a primary restart the replica must *resolve* the primary before the primary is Ready, or reconnection stalls on NXDOMAIN. Background in [StatefulSets fundamentals](/stateful/statefulsets-fundamentals/).

### 3c. StatefulSet: valkey-primary

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: valkey-primary
  namespace: valkey
spec:
  serviceName: valkey-primary-headless
  replicas: 1
  selector:
    matchLabels:
      app: valkey
      role: primary
  template:
    metadata:
      labels:
        app: valkey
        role: primary
    spec:
      terminationGracePeriodSeconds: 60
      # priorityClassName: <ask platform team for their stateful/critical class>
      affinity:
        podAntiAffinity:          # keep primary and replica on different nodes
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              topologyKey: kubernetes.io/hostname
              labelSelector:
                matchLabels:
                  app: valkey
      securityContext:
        runAsNonRoot: true
        runAsUser: 999
        runAsGroup: 999
        fsGroup: 999
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: valkey
        # Pin by digest in CI: resolve with `crane digest valkey/valkey:8.1.2`
        # and ship image: valkey/valkey:8.1.2@sha256:<digest>
        image: valkey/valkey:8.1.2
        command:
        - valkey-server
        - /etc/valkey/valkey.conf
        - --requirepass
        - $(VALKEY_PASSWORD)
        - --masterauth
        - $(VALKEY_PASSWORD)
        env:
        - name: VALKEY_PASSWORD
          valueFrom:
            secretKeyRef:
              name: valkey-auth
              key: password
        - name: REDISCLI_AUTH        # lets probe/exec valkey-cli auth without -a on the cmdline
          valueFrom:
            secretKeyRef:
              name: valkey-auth
              key: password
        ports:
        - { name: valkey, containerPort: 6379 }
        resources:
          requests: { cpu: "1", memory: 3Gi }
          limits:   { cpu: "1", memory: 3Gi }
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
        livenessProbe:
          exec:
            command: ["sh", "-c", "valkey-cli PING | grep -q PONG"]
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          exec:
            command:
            - sh
            - -c
            - valkey-cli INFO replication | grep -q 'role:master' &&
              valkey-cli INFO persistence | grep -q 'loading:0'
          periodSeconds: 5
          timeoutSeconds: 3
        lifecycle:
          preStop:
            exec:
              command: ["sh", "-c", "sleep 5"]
        volumeMounts:
        - name: config
          mountPath: /etc/valkey
          readOnly: true
        - name: data
          mountPath: /data
      volumes:
      - name: config
        configMap:
          name: valkey-primary-config
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-local   # ask platform: prefer local NVMe or low-latency SAN class
      resources:
        requests:
          storage: 10Gi
```

**Why these choices:** requests == limits gives **Guaranteed QoS** — a cache/datastore is the last thing you want evicted under node pressure. The `podAntiAffinity` (on both StatefulSets, matching `app: valkey`) pushes primary and replica onto **different nodes** — colocate them and one node loss takes both the write path *and* the promotion candidate, which voids the entire HA story; it's `preferred` rather than `required` so a shrunken or single-node cluster still schedules. Liveness is a bare `PING` (is the process alive?); readiness additionally checks `role:master` and `loading:0` so the VIP never routes to a primary still loading its AOF into memory — the split matters, see [health checks](/workloads/health-checks/). `REDISCLI_AUTH` keeps the password out of probe command lines. On SIGTERM Valkey shuts down cleanly and AOF makes the last second of writes durable; the `preStop` sleep gives kube-proxy time to pull the pod from Endpoints before the listener closes, and 60s of grace covers a final AOF flush. `masterauth` is set on the primary too, so it can be demoted to replica during a promotion without a config edit.

### 3d. StatefulSet: valkey-replica

Same shape as the primary, and written out in full — the contract of this page is that every manifest applies as-is. Three deliberate differences: the labels/serviceName/config point at the replica's resources, `--masterauth` here authenticates *replication to the primary*, and the readiness probe is **role-aware**, not a bare copy:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: valkey-replica
  namespace: valkey
spec:
  serviceName: valkey-replica-headless
  replicas: 1
  selector:
    matchLabels:
      app: valkey
      role: replica
  template:
    metadata:
      labels:
        app: valkey
        role: replica
    spec:
      terminationGracePeriodSeconds: 60
      # priorityClassName: <ask platform team for their stateful/critical class>
      affinity:
        podAntiAffinity:          # keep replica off the primary's node
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              topologyKey: kubernetes.io/hostname
              labelSelector:
                matchLabels:
                  app: valkey
      securityContext:
        runAsNonRoot: true
        runAsUser: 999
        runAsGroup: 999
        fsGroup: 999
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: valkey
        # Pin by digest in CI, same as the primary
        image: valkey/valkey:8.1.2
        command:
        - valkey-server
        - /etc/valkey/valkey.conf
        - --requirepass
        - $(VALKEY_PASSWORD)
        - --masterauth              # authenticates this replica to the primary
        - $(VALKEY_PASSWORD)
        env:
        - name: VALKEY_PASSWORD
          valueFrom:
            secretKeyRef:
              name: valkey-auth
              key: password
        - name: REDISCLI_AUTH        # lets probe/exec valkey-cli auth without -a on the cmdline
          valueFrom:
            secretKeyRef:
              name: valkey-auth
              key: password
        ports:
        - { name: valkey, containerPort: 6379 }
        resources:
          requests: { cpu: "1", memory: 3Gi }
          limits:   { cpu: "1", memory: 3Gi }
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
        livenessProbe:
          exec:
            command: ["sh", "-c", "valkey-cli PING | grep -q PONG"]
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          # Role-aware: Ready = healthy replica OR promoted master.
          # The 'role:master' clause is what makes §6 promotion possible.
          exec:
            command:
            - sh
            - -c
            - valkey-cli INFO replication | grep -Eq 'role:master|master_link_status:up'
          periodSeconds: 5
          timeoutSeconds: 3
        lifecycle:
          preStop:
            exec:
              command: ["sh", "-c", "sleep 5"]
        volumeMounts:
        - name: config
          mountPath: /etc/valkey
          readOnly: true
        - name: data
          mountPath: /data
      volumes:
      - name: config
        configMap:
          name: valkey-replica-config
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-local   # ask platform: prefer local NVMe or low-latency SAN class
      resources:
        requests:
          storage: 10Gi
```

**Why:** the readiness probe is the load-bearing line of this whole build — and it is deliberately **role-aware**. In normal operation the pod reports `role:slave` and readiness hinges on `master_link_status:up`: if replication breaks, the probe fails, the pod leaves the `valkey-ro` Endpoints, and clients get connection refused instead of silently stale reads. Serving errors beats serving lies. The `role:master` clause looks useless today, and it is the **promotion enabler**: the moment you run `REPLICAOF NO ONE` (§6), `master_link_status` *vanishes* from `INFO replication` — masters have no master link. A probe that greps only for `master_link_status:up` fails at that instant, the pod goes NotReady, kube-proxy pulls it from **both** Services' Endpoints, and your failover becomes a total VIP outage on both ports. The OR condition means the pod stays Ready as a healthy replica *or* as a freshly promoted master. Ship this probe from day one — retrofitting it mid-incident means editing a StatefulSet while the VIP is dark.

### 3e. The two LoadBalancer Services — the shared VIP

```yaml
apiVersion: v1
kind: Service
metadata:
  name: valkey-rw
  namespace: valkey
  annotations:
    metallb.io/allow-shared-ip: "valkey-vip"
    metallb.io/loadBalancerIPs: "10.40.0.50"   # the pinned IP from your platform ask
spec:
  type: LoadBalancer
  externalTrafficPolicy: Cluster    # required for sharing across different pod sets (§2)
  selector:
    app: valkey
    role: primary
  ports:
  - { name: valkey-rw, port: 6379, targetPort: 6379 }
---
apiVersion: v1
kind: Service
metadata:
  name: valkey-ro
  namespace: valkey
  annotations:
    metallb.io/allow-shared-ip: "valkey-vip"   # MUST match valkey-rw exactly
    metallb.io/loadBalancerIPs: "10.40.0.50"
spec:
  type: LoadBalancer
  externalTrafficPolicy: Cluster
  selector:
    app: valkey
    role: replica
  ports:
  - name: valkey-ro
    port: 6380          # external port on the VIP
    targetPort: 6379    # the replica container still listens on 6379
```

**Why:** `port` vs `targetPort` is where people trip. The replica process listens on 6379 like any Valkey; the Service *publishes* it on the VIP as **6380**. External `10.40.0.50:6380` → kube-proxy → replica pod `:6379`. Nothing inside the cluster ever uses 6380. Both Services carry the identical sharing key and pinned IP, disjoint external ports, identical ETP — the full contract from §2. Deep dive: [Services](/networking/services-deep-dive/).

### 3f. NetworkPolicy

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: valkey-access
  namespace: valkey
spec:
  podSelector:
    matchLabels:
      app: valkey
  policyTypes: ["Ingress"]
  ingress:
  - from:                      # client traffic arriving via the VIP
    - ipBlock:
        cidr: 10.0.0.0/8       # ADJUST: must cover clients AND node IPs (see note)
    ports:
    - { port: 6379, protocol: TCP }
  - from:                      # replica -> primary replication
    - podSelector:
        matchLabels:
          app: valkey
    ports:
    - { port: 6379, protocol: TCP }
  - from:                      # Prometheus scrapes — metrics port ONLY, never 6379
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
    ports:
    - { port: 9121, protocol: TCP }
```

**Why:** default-deny plus three explicit paths. Note the policy sees **container** ports only — 6380 doesn't exist at the pod, so one rule on 6379 covers both Services. And because ETP is `Cluster`, VIP traffic is SNAT'd to **node IPs** before it reaches the pod — your `ipBlock` must include the node CIDR or you'll block your own VIP while `kubectl exec` tests keep working. (External connections are SNAT'd twice: once by the corporate appliance, once by kube-proxy — by the time the pod sees them, the source is a node IP.) Patterns in [NetworkPolicies](/networking/network-policies/).

The monitoring rule deserves its own sentence, because the lazy version is a hole. Valkey doesn't speak Prometheus natively — scraping means adding an exporter sidecar (e.g. `redis_exporter`, which speaks Valkey fine) listening on **9121**, which this build doesn't include; until you add one, the rule matches no open port and admits nothing, which is the correct default. What you must *not* do is open **6379** to the whole monitoring namespace "for the exporter": that hands every pod in that namespace a network path to the authenticated data port, and NetworkPolicy is exactly the layer that shouldn't rely on `requirepass` catching what it let through. If your exporter runs as a separate deployment instead of a sidecar, scope a 6379 rule to that one pod with a `podSelector` on its labels — never the whole namespace.

### 3g. PodDisruptionBudgets

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: valkey-primary
  namespace: valkey
spec:
  maxUnavailable: 1
  selector:
    matchLabels: { app: valkey, role: primary }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: valkey-replica
  namespace: valkey
spec:
  maxUnavailable: 1
  selector:
    matchLabels: { app: valkey, role: replica }
```

**Why — and an honest note:** with `replicas: 1`, `maxUnavailable: 1` protects nothing. A node drain *will* take the primary down; these PDBs exist to **not block** platform-team drains (a `maxUnavailable: 0` PDB on a singleton stalls their node maintenance indefinitely and earns you an angry ticket) while signaling "this workload is disruption-managed." The real availability story here is fast StatefulSet recreation plus the manual promotion path — see [high availability](/workloads/high-availability/) for when to graduate past singletons.

## 4. Verification plan

**1. Both Services, same EXTERNAL-IP, different ports** (run these in order, after CI applies everything):

```bash
kubectl -n valkey get svc valkey-rw valkey-ro
# NAME        TYPE           CLUSTER-IP      EXTERNAL-IP   PORT(S)          AGE
# valkey-rw   LoadBalancer   10.96.113.20    10.40.0.50    6379:31204/TCP   1m
# valkey-ro   LoadBalancer   10.96.240.7     10.40.0.50    6380:32011/TCP   1m
```

Same `10.40.0.50` twice. If either shows `<pending>`, go straight to the failure table.

**2. Write on 6379, read on 6380:**

```bash
valkey-cli -h 10.40.0.50 -p 6379 -a "$PASS" SET smoke:key hello   # OK
valkey-cli -h 10.40.0.50 -p 6380 -a "$PASS" GET smoke:key         # "hello"
valkey-cli -h 10.40.0.50 -p 6380 -a "$PASS" SET smoke:key nope
# (error) READONLY You can't write against a read only replica.
```

That READONLY error is the design working, not a bug.

**3. Replication health from both sides:**

```bash
valkey-cli -h 10.40.0.50 -p 6379 -a "$PASS" INFO replication | grep -E 'role|connected_slaves'
# role:master
# connected_slaves:1
valkey-cli -h 10.40.0.50 -p 6380 -a "$PASS" INFO replication | grep -E 'role|master_link_status|master_repl_offset'
# role:slave
# master_link_status:up
```

Steps 2–3 deliberately target the MetalLB IP — that isolates the in-cluster hop. Once they pass, repeat step 2 through `valkey.example.internal` to add the appliance hop: if the MetalLB IP answers and the corporate VIP doesn't, the problem is the appliance's pool, monitor, or DNS — a network-team ticket, not a kubectl session.

**4. Failover drill (do this before production, on purpose):**

```bash
kubectl -n valkey delete pod valkey-primary-0
```

Expect: writes to `:6379` fail with connection errors for roughly 15–45s (pod reschedule + AOF load + readiness); the StatefulSet recreates `valkey-primary-0` on the **same PVC**, so no data loss for fsynced writes. Watch the replica reconnect: `master_link_status` flips `down → up` within ~10s of the primary going Ready, and `:6380` briefly leaves rotation (the role-aware probe fails — `role:slave` with the link down — then passes again) — exactly the stale-read protection from 3d. Clients need retry logic; that's the honest cost of the no-Sentinel design. While you're here, dry-run the first step of the [§6 promotion runbook](#6-operations-notes) too: confirm the deployed replica probe is the role-aware one, so the real promotion never starts from a broken contract.

**5. Drain test (coordinate with the platform team):** drain the primary's node and confirm the PDB doesn't block, the pod reschedules (this requires your StorageClass to be attachable on other nodes — local PV users, this is your promotion drill instead), and the VIP keeps answering on 6380 throughout.

## 5. Failure modes

| Symptom | Likely cause | Confirm / fix |
|---|---|---|
| Second Service stuck `<pending>` | Sharing-key annotation mismatch (typo/whitespace), ETP mismatch, or `Local` with different pod sets | `kubectl describe svc valkey-ro` events; make annotations byte-identical, both ETP `Cluster` |
| Both Services `<pending>` | Pool exhausted, or pinned IP outside the pool / already taken | MetalLB controller logs; re-ask platform team for the pool range |
| `:6380` connection refused, pods Running | Replication link down on a non-promoted replica (`role:slave` + link down) — the role-aware probe correctly pulled it from Endpoints | `kubectl exec valkey-replica-0 -- valkey-cli INFO replication`; check `master_link_status`, auth (`masterauth`), NetworkPolicy |
| `:6380` serving stale data | Readiness probe missing/edited — link is down but pod still Ready | Restore the role-aware probe (`role:master` OR `master_link_status:up`); this is the guardrail |
| Both ports dark the instant you promote | Probe drift: replica probe greps only `master_link_status:up`, so `REPLICAOF NO ONE` makes the pod NotReady on both Services | Restore the §3d role-aware probe *before* promoting; the `role:master` clause is the promotion enabler |
| Writes to `:6380` rejected (`READONLY`) | By design: `replica-read-only yes` | Point writers at `:6379`; do not "fix" this |
| Entire VIP dark for ~10s, both ports | L2 mode: announcing node died; MetalLB memberlist failover re-announces from another node (GARP) | Expected blip; if it persists, check speaker pods and ARP caches upstream |
| MetalLB IP answers, corporate VIP doesn't | Appliance layer: pool member wrong or disabled, monitor marking 10.40.0.50 down, or DNS not pointing at the corporate VIP | `dig valkey.example.internal`; ask the network team for pool-member and monitor status — nothing in the cluster fixes this |
| Pod OOMKilled or evicted during AOF rewrite / full sync | `maxmemory` too close to limit (fork COW overshoot), or QoS no longer Guaranteed after a requests/limits edit | Keep limit ≥ 1.5× `maxmemory`; check `last_terminated: OOMKilled` and `.status.qosClass` |

## 6. Operations notes

### Manual promotion runbook (primary's node/volume is gone)

This is a runbook, not a sketch — copy it into your incident tooling *now*, not during the outage. It only works because the replica's readiness probe ([§3d](#3d-statefulset-valkey-replica)) is **role-aware**. Steps in order:

1. **Verify the probe contract before touching Valkey.** Confirm the deployed replica probe is the role-aware one: `kubectl -n valkey get sts valkey-replica -o yaml | grep -B2 -A2 'role:master'`. Here's why this is step 1 and not a footnote: `REPLICAOF NO ONE` makes `master_link_status` *disappear* from `INFO replication` (masters have no master link). Under a link-only probe (`grep -q 'master_link_status:up'`), the promoted pod instantly goes NotReady, kube-proxy pulls it from **both** `valkey-rw` and `valkey-ro` Endpoints, and your promotion becomes a total VIP outage on both ports. If you find the link-only probe deployed, patch the StatefulSet to the §3d probe and let the pod roll *first*.

2. **Measure the data-loss window, then promote.** Record the replica's position: `kubectl exec valkey-replica-0 -- valkey-cli INFO replication | grep -E 'master_repl_offset|slave_read_repl_offset'`. Compare against the primary's last known `master_repl_offset` from your monitoring (you can't ask the dead primary). The delta, in bytes of replication stream, is what's about to be lost — see the aside below. Then: `kubectl exec valkey-replica-0 -- valkey-cli REPLICAOF NO ONE`. The pod flips to `role:master`, becomes writable, and **stays Ready** — the `role:master` clause holding the door open is the whole point of the §3d probe.

3. **Repoint the write path** by patching the Service, not the clients: `kubectl -n valkey patch svc valkey-rw -p '{"spec":{"selector":{"app":"valkey","role":"replica"}}}'` — `VIP:6379` now hits the promoted pod (both LB Services temporarily select it; the port split still routes correctly since both target 6379).

4. **Persist the promotion.** `REPLICAOF NO ONE` is runtime-only, and `valkey-replica-config` (§3a) still bakes in `replicaof valkey-primary-0...` and `replica-read-only yes`. Edit the ConfigMap: delete the `replicaof` line, drop `replica-read-only`, and — since this pod is now your durability anchor — adopt the primary's persistence settings (`appendonly yes`, `appendfsync everysec`). Then restart the pod **deliberately, at a moment you choose**: `kubectl -n valkey delete pod valkey-replica-0` in a window, after confirming the new ConfigMap is mounted-in or the STS has rolled.

   :::danger[Skip step 4 and the cluster undoes your promotion]
   The next *unplanned* restart — node reboot, eviction, OOM — boots the pod from the stale ConfigMap as a replica of `valkey-primary-0`. If the old primary's node has meanwhile returned, the pod full-syncs from it and **discards every write accepted since the promotion**. If the old primary is still gone, the pod comes up `role:slave` with the link down, the role-aware probe fails, and the write VIP goes dark anyway. Either outcome turns a recovered incident back into an outage.
   :::

5. **Fence the old primary — name the failure: split-brain.** The dead node or volume will eventually come back, and when it does, `valkey-primary-0` boots from its PVC as a fully writable `role:master` with the old dataset. Two masters, one VIP architecture: any client or process that still resolves the old headless DNS name, or a hasty selector flip-back, writes to a dataset that will later be thrown away. Fence it *before* it can return: `kubectl -n valkey scale sts valkey-primary --replicas=0`. If you can't scale it down in time (e.g. GitOps fights you), edit `valkey-primary-config` to add `replicaof valkey-replica-0.valkey-replica-headless.valkey.svc.cluster.local 6379` so that if the pod does start, it comes up as a replica of the promoted node — subordinate, not split-brained.

6. **Re-establish the pair later, in a maintenance window.** With the old primary fenced and its config pointing at the promoted pod, scale `valkey-primary` back to 1, let it full-sync as a replica, then either flip the Service selectors and configs back to the original topology or relabel permanently. Whichever you pick, finish with the §4 verification plan end to end.

:::caution[The data-loss window is the price of no Sentinel — say it out loud]
Replication here is **asynchronous**: the primary acks writes to clients before the replica has them. Every write acked in the gap between the replica's last received offset and the primary's death is **gone the moment you promote** — no tool recovers it. You can quantify it (offset deltas in step 2, and trend `master_repl_offset` minus replica offsets in your monitoring so you know your steady-state lag *before* the incident), but you cannot avoid it in this design. Sentinel with `min-replicas-to-write`, or an operator with synchronous semantics, shrinks that window at the cost of the simplicity this whole page is buying. Choose knowingly.
:::

**Backups run off the replica:** `kubectl exec valkey-replica-0 -- valkey-cli BGSAVE`, wait for `rdb_bgsave_in_progress:0` in `INFO persistence`, then `kubectl cp valkey/valkey-replica-0:/data/dump.rdb ./dump-$(date +%F).rdb` (or a CronJob mounting nothing and streaming `--rdb -`). The fork cost and disk I/O land on the replica, never the write path. Full strategy: [backup and DR](/stateful/backup-and-dr/).

**Scaling reads:** bump `valkey-replica` to `replicas: 2`. `valkey-replica-1` gets its own PVC, full-syncs from the primary, and joins the `valkey-ro` Endpoints once the role-aware readiness probe sees `master_link_status:up` (the replica half of the OR). With ETP `Cluster`, kube-proxy spreads `:6380` connections roughly evenly across replicas per-connection (not per-command — pooled clients stick to one backend per connection). Each replica full-sync costs the primary a fork; add replicas one at a time.

**Upgrades:** always **replica first, then primary** — a newer replica can sync from an older primary, rarely the reverse. With one of each, update the `valkey-replica` image, wait for `master_link_status:up` and a clean `GET` on `:6380`, then update `valkey-primary` and eat the same brief write blip as the failover drill. At `replicas: 2+`, use the StatefulSet `spec.updateStrategy.rollingUpdate.partition` field to canary one replica before the rest.
