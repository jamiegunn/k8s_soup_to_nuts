---
title: "Valkey: Two StatefulSets, One MetalLB VIP"
description: A complete, deployable Valkey primary/replica build where two LoadBalancer Services share a single MetalLB VIP, split by port for read-write and read-only traffic.
sidebar:
  order: 2
---

This is a full reference build: a Valkey **primary** StatefulSet (writes) and a **read replica** StatefulSet (async replication), each fronted by its own `LoadBalancer` Service — but both Services claim the **same MetalLB VIP** via `metallb.io/allow-shared-ip`, separated by port. Clients hit `VIP:6379` for read-write and `VIP:6380` for read-only. Every manifest below is complete and applies in order.

## 1. Architecture overview

```text
                ┌───────────────────────────┐
  clients ─────►│ VIP 10.40.0.50:6379 (rw)  │──► valkey-primary-0 ◄──┐ replication via
                │   Service: valkey-rw      │                        │ headless DNS:
                │ VIP 10.40.0.50:6380 (ro)  │                        │ valkey-primary-0.
  clients ─────►│   Service: valkey-ro      │──► valkey-replica-0 ───┘ valkey-primary-headless
                └───────────────────────────┘     (6380 → containerPort 6379)
```

**Why one VIP with two ports beats two IPs:** MetalLB pools on bare metal are usually small and platform-owned — every IP you burn is a ticket to the platform team. One VIP means **one DNS record** (`valkey.example.internal`), **one firewall rule** at the corporate edge, and clients that differ only by port number. Read-write vs read-only becomes a connection-string detail, not a DNS migration.

**Why it beats NodePort:** NodePorts land in the 30000–32767 range (no `:6379` for your Redis-protocol clients), they couple clients to node IPs that change when the platform team recycles nodes, and they announce on *every* node. A MetalLB VIP gives you stable, conventional port numbers on a stable address, with `externalTrafficPolicy` as a real choice rather than an afterthought.

:::caution[Be honest about failover]
This design has **manual failover**. If the primary pod dies, the StatefulSet recreates it on the same PVC and clients reconnect — usually within a minute. But if the *node or volume* is lost, promoting the replica is a human action (sketched in [§6](#6-operations-notes)). If you need automatic failover, you want Sentinel or a Valkey operator instead — see [Valkey and Redis on Kubernetes](/stateful/valkey-and-redis/) for that decision. This architecture is the right size when a minute of write downtime is acceptable and you want something you fully understand.
:::

## 2. Prerequisites and the platform ask

You own the namespace; the platform team owns MetalLB. Before applying anything, send them this request:

> We need **one IP** from the MetalLB pool assigned to namespace `valkey`, pinned if possible (we'll reference it via `metallb.io/loadBalancerIPs`). We will create **two** `LoadBalancer` Services **sharing that one IP** using `metallb.io/allow-shared-ip: "valkey-vip"` on non-overlapping ports (6379, 6380). Please confirm: (a) IP sharing is not blocked by policy, (b) which pool/IP to use, (c) whether announcements are L2 or BGP.

The `allow-shared-ip` contract, restated precisely — MetalLB colocates two Services on one IP only if **all three** hold:

1. **Identical sharing-key annotation** — same string value on both Services (`"valkey-vip"` here).
2. **No port overlap** — the port sets must be disjoint (6379 vs 6380: fine).
3. **Compatible `externalTrafficPolicy`** — both `Cluster`, **or** both `Local` *and selecting the exact same pods*.

That third clause decides the ETP question for us. `Local` preserves client source IPs and, for a single-pod backend, is genuinely clean — MetalLB announces from the node that has the pod, so there's no extra hop. But our two Services select **different** pods (primary vs replica), which may sit on different nodes, and one IP can only be announced from one place. MetalLB therefore refuses to share an IP between `Local` Services with different pod sets.

:::danger[Use `externalTrafficPolicy: Cluster` — it is not optional here]
With `Local` on these two Services, the second one sits in `<pending>` forever and the events say only that the IP can't be shared. `Cluster` costs you client source IPs (kube-proxy SNATs to a node IP — this matters for your [NetworkPolicy](#3f-networkpolicy) and for `CLIENT LIST` debugging) and adds a possible extra node hop, but it's the only configuration that satisfies the sharing contract with distinct backends. Details in [MetalLB](/controllers/metallb/).
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

**Why these choices:** requests == limits gives **Guaranteed QoS** — a cache/datastore is the last thing you want evicted under node pressure. Liveness is a bare `PING` (is the process alive?); readiness additionally checks `role:master` and `loading:0` so the VIP never routes to a primary still loading its AOF into memory — the split matters, see [health checks](/workloads/health-checks/). `REDISCLI_AUTH` keeps the password out of probe command lines. On SIGTERM Valkey shuts down cleanly and AOF makes the last second of writes durable; the `preStop` sleep gives kube-proxy time to pull the pod from Endpoints before the listener closes, and 60s of grace covers a final AOF flush. `masterauth` is set on the primary too, so it can be demoted to replica during a promotion without a config edit.

### 3d. StatefulSet: valkey-replica

Identical shape — only the differences are shown; everything else is copied verbatim from `valkey-primary`:

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
      # ... same securityContext, tgps, container spec (incl. --requirepass and
      # --masterauth — masterauth authenticates replication to the primary),
      # resources, livenessProbe, preStop and volumeClaimTemplates as
      # valkey-primary, with two substitutions:
      containers:
      - name: valkey
        # 1) config volume: configMap: { name: valkey-replica-config }
        # 2) readinessProbe verifies the replication link, not just liveness:
        readinessProbe:
          exec:
            command:
            - sh
            - -c
            - valkey-cli INFO replication | grep -q 'master_link_status:up'
          periodSeconds: 5
          timeoutSeconds: 3
```

**Why:** the readiness probe is the load-bearing line of this whole build. `VIP:6380` should only ever serve a replica whose link to the primary is **up**. If replication breaks, the probe fails, the pod leaves the `valkey-ro` Endpoints, and clients get connection refused instead of silently stale reads. Serving errors beats serving lies.

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
  - from:                      # monitoring/exporter scrapes
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
    ports:
    - { port: 6379, protocol: TCP }
```

**Why:** default-deny plus three explicit paths. Note the policy sees **container** ports only — 6380 doesn't exist at the pod, so one rule on 6379 covers both Services. And because ETP is `Cluster`, VIP traffic is SNAT'd to **node IPs** before it reaches the pod — your `ipBlock` must include the node CIDR or you'll block your own VIP while `kubectl exec` tests keep working. Patterns in [NetworkPolicies](/networking/network-policies/).

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

**4. Failover drill (do this before production, on purpose):**

```bash
kubectl -n valkey delete pod valkey-primary-0
```

Expect: writes to `:6379` fail with connection errors for roughly 15–45s (pod reschedule + AOF load + readiness); the StatefulSet recreates `valkey-primary-0` on the **same PVC**, so no data loss for fsynced writes. Watch the replica reconnect: `master_link_status` flips `down → up` within ~10s of the primary going Ready, and `:6380` briefly leaves rotation (readiness fails) then returns — exactly the stale-read protection from 3d. Clients need retry logic; that's the honest cost of the no-Sentinel design.

**5. Drain test (coordinate with the platform team):** drain the primary's node and confirm the PDB doesn't block, the pod reschedules (this requires your StorageClass to be attachable on other nodes — local PV users, this is your promotion drill instead), and the VIP keeps answering on 6380 throughout.

## 5. Failure modes

| Symptom | Likely cause | Confirm / fix |
|---|---|---|
| Second Service stuck `<pending>` | Sharing-key annotation mismatch (typo/whitespace), ETP mismatch, or `Local` with different pod sets | `kubectl describe svc valkey-ro` events; make annotations byte-identical, both ETP `Cluster` |
| Both Services `<pending>` | Pool exhausted, or pinned IP outside the pool / already taken | MetalLB controller logs; re-ask platform team for the pool range |
| `:6380` connection refused, pods Running | Replication link down — readiness probe correctly pulled the replica from Endpoints | `kubectl exec valkey-replica-0 -- valkey-cli INFO replication`; check `master_link_status`, auth (`masterauth`), NetworkPolicy |
| `:6380` serving stale data | Readiness probe missing/edited — link is down but pod still Ready | Restore the `master_link_status:up` probe; this is the guardrail |
| Writes to `:6380` rejected (`READONLY`) | By design: `replica-read-only yes` | Point writers at `:6379`; do not "fix" this |
| Entire VIP dark for ~10s, both ports | L2 mode: announcing node died; MetalLB memberlist failover re-announces from another node (GARP) | Expected blip; if it persists, check speaker pods and ARP caches upstream |
| Pod OOMKilled or evicted during AOF rewrite / full sync | `maxmemory` too close to limit (fork COW overshoot), or QoS no longer Guaranteed after a requests/limits edit | Keep limit ≥ 1.5× `maxmemory`; check `last_terminated: OOMKilled` and `.status.qosClass` |

## 6. Operations notes

**Manual promotion (primary's node/volume is gone):** the sketch — (1) `kubectl exec valkey-replica-0 -- valkey-cli REPLICAOF NO ONE` — the replica becomes a writable master; (2) repoint the write path by patching the Service, not the clients: `kubectl -n valkey patch svc valkey-rw -p '{"spec":{"selector":{"app":"valkey","role":"replica"}}}'` — `VIP:6379` now hits the promoted pod (both LB Services temporarily select it; the port split still routes correctly since both target 6379); (3) when the old primary is recoverable, give it `replicaof` config pointing at the promoted pod, let it sync, then either flip everything back in a maintenance window or relabel permanently. Write this as a runbook *now*, not during the incident.

**Backups run off the replica:** `kubectl exec valkey-replica-0 -- valkey-cli BGSAVE`, wait for `rdb_bgsave_in_progress:0` in `INFO persistence`, then `kubectl cp valkey/valkey-replica-0:/data/dump.rdb ./dump-$(date +%F).rdb` (or a CronJob mounting nothing and streaming `--rdb -`). The fork cost and disk I/O land on the replica, never the write path. Full strategy: [backup and DR](/stateful/backup-and-dr/).

**Scaling reads:** bump `valkey-replica` to `replicas: 2`. `valkey-replica-1` gets its own PVC, full-syncs from the primary, and joins the `valkey-ro` Endpoints once its readiness probe sees `master_link_status:up`. With ETP `Cluster`, kube-proxy spreads `:6380` connections roughly evenly across replicas per-connection (not per-command — pooled clients stick to one backend per connection). Each replica full-sync costs the primary a fork; add replicas one at a time.

**Upgrades:** always **replica first, then primary** — a newer replica can sync from an older primary, rarely the reverse. With one of each, update the `valkey-replica` image, wait for `master_link_status:up` and a clean `GET` on `:6380`, then update `valkey-primary` and eat the same brief write blip as the failover drill. At `replicas: 2+`, use the StatefulSet `spec.updateStrategy.rollingUpdate.partition` field to canary one replica before the rest.
