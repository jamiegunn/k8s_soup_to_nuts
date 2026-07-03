---
title: "IBM MQ: Production Reference Architecture"
description: A complete, copy-paste-deployable IBM MQ Native HA queue manager on Kubernetes — QueueManager CR, TLS, CHLAUTH, MetalLB exposure, quorum-aware PDBs, monitoring, and failure drills.
sidebar:
  order: 4
---

This is the build article. The survey of brokers on Kubernetes — and why MQ's HA story is unusual — lives at [Message Queues on Kubernetes](/stateful/message-queues/). Here we deploy one production queue manager, `QM1`, in **Native HA** mode: three pods, one active, two replicas, RAFT-style replication of the recovery log over the network. Every manifest below is complete and applied in order.

:::note[Tuning the numbers]
The resource blocks and probe timings in this build are starting points. Derive your own from measurements with [Requests & Limits Knobs](/tuning/requests-limits-knobs/) and [Health Check Knobs](/tuning/health-check-knobs/); the method is the [Sizing Walkthrough](/tuning/sizing-walkthrough/).
:::

## Architecture

```text
                     off-cluster apps
                           │  TCP 1414 (TLS on channel)
                           ▼
             corporate VIP  mq.example.internal :1414
             (network team's F5 / NetScaler appliance)
                           │  pools to the MetalLB IP
                           ▼
                 MetalLB VIP 10.20.0.40
                           │
        ┌──────────────────┼──────────────────────────────┐
        │ namespace: mq-prod                              │
        │                  ▼                              │
        │        Service qm1-mq-external (LoadBalancer)   │
        │        Service qm1-ibm-mq      (ClusterIP)      │
        │           │ 1414          ▲ 1414 in-cluster apps│
        │           ▼               │                     │
        │   ┌───────────┐   ┌───────────┐   ┌───────────┐ │
        │   │ qm1-...-0 │◄─►│ qm1-...-1 │◄─►│ qm1-...-2 │ │
        │   │  ACTIVE   │   │  REPLICA  │   │  REPLICA  │ │
        │   └─────┬─────┘ 9414 (log replication, RAFT-ish)│
        │         │PVC          │PVC            │PVC      │
        │      [data-0]      [data-1]        [data-2]     │
        │   zone-a           zone-b          zone-c       │
        └─────────────────────────────────────────────────┘
          9443 (web console) and 9157 (metrics): cluster-internal only
```

Only the active instance accepts client connections. It replicates every recovery-log write to the replicas and acknowledges persistent operations once a **quorum (2 of 3)** has the data. Each pod owns its **own RWO PVC** — no shared storage anywhere.

That last point is the contrast with the legacy pattern. Before Native HA (MQ 9.2.4+), HA-on-Kubernetes meant a **multi-instance queue manager**: two pods pointing at the *same* RWX volume, using file locks to decide who's active. It required an RWX StorageClass with genuinely correct POSIX lease/lock semantics — a bar most NFS-flavored provisioners clear only on a good day — and failover was at the mercy of lock timeout tuning. You'll still meet it in shops with big NFS/Spectrum Scale investments, on MQ versions before 9.2.4, or without MQ Advanced entitlement. For a new build with block storage, Native HA is simply better: no shared-filesystem trust exercise, and quorum semantics you can reason about.

:::caution[Licensing, up front]
**Native HA requires MQ Advanced entitlement.** Base MQ licensing does not include it. For a lab, **MQ Advanced for Developers** is free and includes Native HA — that's `license.use: NonProduction` below. Don't build your production architecture on the developer image and discover the entitlement gap at procurement time.
:::

## Deployment path: Operator vs Helm chart

Two honest options:

- **IBM MQ Operator + `QueueManager` CR.** IBM's supported path. The CR encodes Native HA in one field, wires the three pods, per-pod PVCs, Services, and TLS keystore handling for you. The catch: the operator ships via IBM's operator catalog and is **OpenShift-centric**; on vanilla Kubernetes it can be installed via OLM, but check your IBM support terms before betting production on that combination.
- **`icr.io/ibm-messaging/mq` container + StatefulSet/Helm** (IBM's `mq-helm` samples). Fully workable on vanilla clusters; you assemble Native HA yourself with `MQ_NATIVE_HA=true` and per-pod env for replica addresses.

**This article shows the `QueueManager` CR** because it expresses Native HA declaratively and is what most supported installations run. Chart users: everything maps directly — the MQSC/INI ConfigMaps mount the same way, `spec.queueManager.storage` becomes `volumeClaimTemplates`, `spec.pki` becomes a mounted secret at `/etc/mqm/pki/keys/`, and you own the StatefulSet, PDB, and Services explicitly.

Operator installation is cluster-scoped (CRDs, catalog source) — that's a [platform team ask](/operations/working-with-platform-team/). Request: "IBM MQ Operator, channel `v3.x` pinned, watching namespace `mq-prod`; we own QueueManager CRs in that namespace." Also ask what their StorageClass does on fsync — see the CR notes below.

## The build

Everything lands in `mq-prod`.

```bash
kubectl create namespace mq-prod
```

### 1. Secrets: TLS and identity

The queue manager's TLS keypair (issue from your real CA; a lab can use `openssl`/cert-manager):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: qm1-tls
  namespace: mq-prod
type: kubernetes.io/tls          # standard shape; the MQ container consumes it directly
data:
  tls.key: <base64 PEM key>
  tls.crt: <base64 PEM cert + chain>   # SANs MUST cover the VIP hostname AND qm1-ibm-mq.mq-prod.svc
---
apiVersion: v1
kind: Secret
metadata:
  name: qm1-app-clients-ca
  namespace: mq-prod
type: Opaque
data:
  app-ca.crt: <base64 PEM CA that signs application client certs>
```

We authenticate applications with **mutual TLS** (client certs mapped by CHLAUTH), not passwords — so the second secret is the CA that signs app client certs, added to the queue manager's *trust* store. No password secret to rotate, no `MQ_APP_PASSWORD` dev-image crutch in production. General secret hygiene: [Secrets](/workloads/secrets/).

:::note[MQ's keystore quirk]
MQ doesn't read PEM at runtime — it uses a CMS/PKCS#12 keystore. The container builds that keystore *for you* at startup from files mounted under `/etc/mqm/pki/keys/<label>/` and `/etc/mqm/pki/trust/`, and **the directory name becomes the certificate label** (`spec.pki.keys[].name` below). Rotate by updating the Secret and restarting pods; the keystore is rebuilt. Don't hand-craft `.kdb` files into the image.
:::

### 2. ConfigMap: MQSC and qm.ini

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: qm1-config
  namespace: mq-prod
data:
  app.mqsc: |
    * Queues: DEFPSIST(YES) so messages default to persistent — replicated,
    * survives failover. Non-persistent messages are gone on any failover; if
    * that surprises anyone on your team, it should be decided here, once.
    DEFINE QLOCAL('APP.ORDERS') DEFPSIST(YES) MAXDEPTH(50000) +
           BOTHRESH(5) BOQNAME('APP.ORDERS.BACKOUT') REPLACE
    DEFINE QLOCAL('APP.ORDERS.BACKOUT') DEFPSIST(YES) MAXDEPTH(50000) REPLACE

    * One SVRCONN channel per app domain. TLS is on the CHANNEL (MQ-native),
    * not terminated at the LB. SSLCAUTH(REQUIRED) = mutual TLS.
    * MAXINST/MAXINSTC: cap total and per-client connections so one leaking
    * app can't exhaust the channel table for everyone.
    * HBINT(30): flow a heartbeat every 30s — BELOW the corporate
    * appliance's idle timeout AND any conntrack/firewall timeout on the
    * 1414 path, or idle channels get silently severed.
    DEFINE CHANNEL('APP.SVRCONN') CHLTYPE(SVRCONN) TRPTYPE(TCP) +
           SSLCIPH('ANY_TLS12_OR_HIGHER') SSLCAUTH(REQUIRED) +
           MCAUSER('nobody') MAXINST(50) MAXINSTC(10) HBINT(30) REPLACE

    * CHLAUTH: never disable it. Map the app's certificate DN to a low-priv
    * identity instead. MCAUSER('nobody') above is the fail-closed default;
    * this rule is the only way in.
    SET CHLAUTH('APP.SVRCONN') TYPE(SSLPEERMAP) +
        SSLPEER('CN=orders-app,O=YourOrg') USERSRC(MAP) MCAUSER('app') +
        ACTION(REPLACE)

    * Least-privilege authority for the mapped identity.
    SET AUTHREC OBJTYPE(QMGR) PRINCIPAL('app') AUTHADD(CONNECT,INQ)
    SET AUTHREC PROFILE('APP.ORDERS') OBJTYPE(QUEUE) PRINCIPAL('app') +
        AUTHADD(PUT,GET,BROWSE,INQ)
    SET AUTHREC PROFILE('APP.ORDERS.BACKOUT') OBJTYPE(QUEUE) PRINCIPAL('app') +
        AUTHADD(PUT,GET,BROWSE,INQ)
  tuning.ini: |
    TCP:
      KeepAlive=Yes
    Channels:
      MaxChannels=300
      MaxActiveChannels=300
```

Why HBINT matters this much: an MQ channel is one long-lived TCP connection, exactly the species that idle-timeout middleboxes love to kill. On this build's external path the strictest middlebox is usually the **corporate appliance itself** — get its idle timeout in writing (it's a line in the network-team request below) and keep HBINT under it *and* under any conntrack/firewall timer. Heartbeats below every timeout on the path keep the state entries warm; get it wrong and quiet-period apps throw `MQRC 2009` at 3 a.m. Full treatment: [Long-Lived Connections](/networking/long-lived-connections/).

### 3. The QueueManager CR

```yaml
apiVersion: mq.ibm.com/v1beta1
kind: QueueManager
metadata:
  name: qm1
  namespace: mq-prod
spec:
  license:
    accept: true
    license: L-QYVA-B365MB    # MUST match spec.version exactly — IBM publishes
                              # a license-ID-per-release table; this is 9.4's.
    use: Production           # "NonProduction" + developer image for the lab
  version: 9.4.2.0-r1         # PIN the full version-and-revision. Never a
                              # floating tag on a stateful quorum system.
  queueManager:
    name: QM1
    availability:
      type: NativeHA          # the entire HA story, one field: 3 pods,
                              # active/replica election, log replication on 9414
    mqsc:
      - configMap: { name: qm1-config, items: [app.mqsc] }
    ini:
      - configMap: { name: qm1-config, items: [tuning.ini] }
    resources:                # requests == limits => Guaranteed QoS.
      requests: { cpu: "1", memory: 2Gi }
      limits:   { cpu: "1", memory: 2Gi }   # a Burstable QM that gets evicted
                                            # under node pressure = surprise failover
    storage:
      defaultClass: fast-ssd  # ask platform: honest fsync? every persistent PUT
                              # waits on a quorum of log writes hitting disk —
                              # p99 fsync latency IS your p99 put latency
      queueManager: { type: persistent-claim, size: 10Gi }
      recoveryLogs: { enabled: true, type: persistent-claim, size: 15Gi }
      persistedData: { enabled: true, type: persistent-claim, size: 20Gi }
      # Separate log volume: recovery-log I/O is sequential, latency-critical,
      # and the thing Native HA replicates. Isolate it from queue-file I/O.
  pki:
    keys:
      - name: default                 # becomes the cert label in the keystore
        secret: { secretName: qm1-tls, items: [tls.key, tls.crt] }
    trust:
      - name: appca
        secret: { secretName: qm1-app-clients-ca, items: [app-ca.crt] }
  web:
    enabled: true                     # console on 9443 — stays cluster-internal
  template:
    pod:
      spec:
        topologySpreadConstraints:    # see next section
          - maxSkew: 1
            topologyKey: topology.kubernetes.io/zone
            whenUnsatisfiable: DoNotSchedule
            labelSelector:
              matchLabels: { app.kubernetes.io/instance: qm1 }
          - maxSkew: 1
            topologyKey: kubernetes.io/hostname
            whenUnsatisfiable: DoNotSchedule
            labelSelector:
              matchLabels: { app.kubernetes.io/instance: qm1 }
```

Storage class expectations belong in writing with your platform team: block storage (RWO), `allowVolumeExpansion: true`, no write-cache lying about fsync, and ideally `volumeBindingMode: WaitForFirstConsumer` so PVCs land in each pod's zone. Background: [Storage Controllers](/controllers/storage-controllers/) and [PV/PVC](/stateful/storage-pv-pvc/).

### 4. Spread and the PDB

The topology spread above forces the three pods across zones *and* hosts (the operator's default anti-affinity is preferred-only — a bin-packed cluster will happily co-locate replicas, which turns one node failure into quorum loss). One replica per zone means any single zone outage leaves 2 of 3 — still quorate.

The PDB must match quorum reality: losing 2 of 3 loses quorum, so drains may take **at most one** pod at a time. Recent operator versions create this for you — run `kubectl get pdb -n mq-prod` and only apply this if it's missing:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: qm1-pdb
  namespace: mq-prod
spec:
  maxUnavailable: 1     # NOT minAvailable: 1 — that would permit a 2-pod
                        # eviction, which is quorum loss, which is an outage
  selector:
    matchLabels: { app.kubernetes.io/instance: qm1 }
```

More on why drains are the real enemy of quorum systems: [High Availability](/workloads/high-availability/).

### 5. Services and how clients connect

The operator creates a ClusterIP Service `qm1-ibm-mq` (1414 traffic, 9443 console, 9157 metrics) and a headless Service for 9414 replication. Crucially, **the 1414 Service selects only the active pod** — the operator manages readiness so replicas never receive client traffic. In-cluster apps just use `qm1-ibm-mq.mq-prod.svc:1414`.

Off-cluster clients reach the queue manager through **two layers**: a corporate VIP on the network team's appliance, pooled to a [MetalLB](/controllers/metallb/) service IP inside the cluster — plain [TCP ingress](/networking/tcp-ingress/) at both hops, no HTTP anything. The in-cluster half first:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: qm1-mq-external
  namespace: mq-prod
  annotations:
    metallb.io/address-pool: prod-services
    metallb.io/allow-shared-ip: "mq-shared-vip"  # optional: ride one VIP with
                                                 # other TCP services on other ports
spec:
  type: LoadBalancer
  loadBalancerIP: 10.20.0.40      # or let the pool assign; pin it if firewalls care
  externalTrafficPolicy: Local     # the source IP that survives is the corporate
                                   # appliance's SNAT address (see below) — still
                                   # useful: it pins 1414 to the appliance
  selector:
    app.kubernetes.io/instance: qm1   # all 3 pods match, but ONLY the active
                                      # instance passes readiness, so the
                                      # endpoint list is exactly the active pod
  ports:
    - { name: qm-traffic, port: 1414, targetPort: 1414 }
```

Never pin `statefulset.kubernetes.io/pod-name` in this selector "for stability" — that defeats failover; readiness-based selection *is* the failover mechanism (sanity-check your selector against the operator's own `qm1-ibm-mq` Service). Expose **only 1414**: the 9443 console and 9157 metrics never go on the VIP.

**The corporate VIP in front.** Clients never dial `10.20.0.40` — they dial `mq.example.internal`, a corporate VIP on the network team's load-balancer appliance (F5 BIG-IP, NetScaler), which pools to the MetalLB IP. Chain: client → corporate VIP (appliance) → MetalLB IP `:1414` → the active pod. Ownership split: the **network team** owns the appliance, VIP, and DNS; the **platform team** owns MetalLB and its pools; **you** own the Service, the QueueManager CR, and the channels. General topology: [External Load Balancing](/networking/external-load-balancing/). What matters at that layer for MQ specifically:

- **The pool member is the MetalLB IP `:1414`** — never NodePorts or pod IPs. The appliance health-checks that address; ask for a plain **TCP monitor**. A protocol-aware monitor sounds nicer but a half-open MQ handshake writes an `AMQ9xxx` error to the QM log every probe interval — the readiness gating already ensures the MetalLB IP only answers when the active instance can serve, so TCP is both quiet and truthful.
- **TLS must be passthrough.** This build uses mutual TLS on the channel with `SSLPEERMAP` mapping client-cert DNs to identities — terminate at the appliance and that authentication model is dead. End-to-end TLS, cert lives with the queue manager; the appliance forwards bytes. (If your network team runs BIG-IP with [F5 CIS](/controllers/f5-cis/), the VIP, pool, and monitor can be declared from cluster manifests instead of a ticket — same passthrough topology.)
- **The appliance SNATs**, so the queue manager sees the appliance's self-IP for every external client — channel status `CONNAME` and any CHLAUTH `TYPE(ADDRESS)` rule become useless for distinguishing external clients. That's exactly why this build authenticates on certificate DN, which survives SNAT. MQ doesn't speak PROXY protocol; accept the lost client IPs.
- **The appliance idle timeout joins the HBINT math.** It's usually the strictest timer on the path — HBINT(30) and the CCDT's `heartbeatInterval` must stay below it (and below conntrack); see [Long-Lived Connections](/networking/long-lived-connections/).

The request that makes all of it real:

> **To the network team:** please create VIP `mq.example.internal`, TCP **1414**, pool = **one member: 10.20.0.40:1414** (our cluster's MetalLB service IP). Monitor: **TCP** on 1414 — no protocol-aware monitor, it spams the queue manager's error log. Idle timeout: ≥ 90 s and tell us the configured value — our channels heartbeat every 30 s and must stay below it. Persistence: none needed (single member). TLS: **passthrough** — the channel does mutual TLS end-to-end; do not decrypt.

Clients get a JSON CCDT with automatic reconnect, mirroring the channel's `DEFRECON` posture:

```json
{
  "channel": [{
    "name": "APP.SVRCONN",
    "type": "clientConnection",
    "clientConnection": {
      "connection": [{ "host": "mq.example.internal", "port": 1414 }],
      "queueManager": "QM1"
    },
    "transmissionSecurity": { "cipherSpecification": "ANY_TLS12_OR_HIGHER" },
    "connectionManagement": {
      "reconnect": { "enabled": true, "timeout": 1800 },
      "heartbeatInterval": 30
    }
  }]
}
```

The `host` is the **corporate VIP's DNS name**, owned by the network team — clients never learn the MetalLB IP. If the appliance moves or the pool member changes, the CCDT stays valid.

Reconnect is a *pair* of settings: the client asks (CCDT `reconnect`, or `MQCNO_RECONNECT`), and the channel permits (`DEFRECON(YES)` on the channel if you want it without client changes). With both in place, a failover looks to the app like a 5–15 second stall inside the MQ client library, not an exception. Without them, every failover is a `2009` surfacing into application code that probably doesn't handle it.

### 6. NetworkPolicy

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: qm1-policy
  namespace: mq-prod
spec:
  podSelector:
    matchLabels: { app.kubernetes.io/instance: qm1 }
  policyTypes: [Ingress]
  ingress:
    - from:                                        # app namespaces -> 1414
        - namespaceSelector:
            matchLabels: { mq-client: "true" }
      ports: [{ port: 1414, protocol: TCP }]
    - from:                                        # off-cluster via VIP -> 1414
        - ipBlock: { cidr: 10.30.0.0/16 }          # your external client range
      ports: [{ port: 1414, protocol: TCP }]
    - from:                                        # 9414 STRICTLY pod-to-pod:
        - podSelector:                             # it's the replication stream,
            matchLabels: { app.kubernetes.io/instance: qm1 }  # nothing else ever
      ports: [{ port: 9414, protocol: TCP }]       # needs it
    - from:                                        # metrics -> monitoring only
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: monitoring }
      ports: [{ port: 9157, protocol: TCP }]
```

Note what's absent: no external rule for 9443. Console access is `kubectl port-forward` for the few humans who need it. Whether the `ipBlock` sees real client IPs depends on `externalTrafficPolicy` and your CNI — and behind the corporate appliance, "real" means the appliance's SNAT self-IPs, so the block can often be tightened to just that range. Verify, don't assume: [Network Policies](/networking/network-policies/).

### 7. Monitoring and the alerts that matter

The container exposes Prometheus metrics on **9157** (the operator enables this by default) — queue-manager-level health. For per-queue depth and channel status, deploy IBM's `mq-metric-samples` exporter and set `MONQ(MEDIUM)`/`MONCHL(MEDIUM)`. Metric names below are the exporter's — confirm against your `/metrics` before paging anyone. Wiring and routing: [Alerting](/observability/alerting/).

```promql
# Consumers falling behind — depth climbing toward MAXDEPTH(50000)
ibmmq_queue_depth{queue="APP.ORDERS"} > 40000

# Oldest message age: catches a STALLED consumer even at low depth
ibmmq_queue_oldest_message_age{queue="APP.ORDERS"} > 300

# App channel has no running instances (status 3 = RUNNING)
max by (channel) (ibmmq_channel_status{channel="APP.SVRCONN"}) != 3

# Native HA: fewer than 2 in-sync instances = one more failure from quorum loss.
# Alert loudly; this is "degraded but up", the best time to act.
ibmmq_nha_in_synch_instances < 2

# Recovery-log filesystem filling — see failure modes for why this is critical
ibmmq_qmgr_log_file_system_bytes_in_use
  / ibmmq_qmgr_log_file_system_bytes_max > 0.8
```

## Verification plan

**1. Native HA state.** Inside any pod:

```console
$ kubectl exec -n mq-prod qm1-ibm-mq-0 -- dspmq -o nativeha -m QM1
QMNAME(QM1)  ROLE(Active)  INSTANCE(qm1-ibm-mq-0)  INSYNC(yes)  QUORUM(3/3)
```

Run it on `-1` and `-2` too: expect `ROLE(Replica) ... INSYNC(yes)`. Anything other than `QUORUM(3/3)` before you proceed means storage or 9414 connectivity problems — fix first.

**2. Put/get through the VIP with TLS.** From an off-cluster host with the MQ client, the app cert in a keystore, and the CCDT above:

```console
$ export MQCCDTURL=file:///opt/mq/ccdt.json MQSSLKEYR=/opt/mq/app-key
$ echo "hello-persistent" | amqsputc APP.ORDERS QM1
Sample AMQSPUT0 start
target queue is APP.ORDERS
Sample AMQSPUT0 end
$ amqsgetc APP.ORDERS QM1
message <hello-persistent>
```

This one round trip proves: VIP routing (both layers — the appliance's pool and MetalLB's announcement), TLS handshake, CHLAUTH mapping, and OAM authority — the things that fail independently.

**3. Failover drill.** Start `amqsgetc` in a loop, then `kubectl delete pod qm1-ibm-mq-0`. Watch `dspmq -o nativeha` on another pod: a replica is elected active typically **within about 10 seconds**. The reconnecting client stalls, then resumes — no error surfaces. The deleted pod returns as a replica and resyncs (`INSYNC(yes)` again within a minute for a quiet QM).

**4. Persistent-message survival.** `amqsputc` one message, delete the active pod *before* consuming, then `amqsgetc` after failover. The message is there: it was quorum-committed to two logs before the put ever returned. Repeat with a non-persistent message (`DEFPSIST(NO)` test queue) and watch it vanish — show this demo to whoever picks message persistence in your apps.

**5. Quorum-loss drill (lab only).** Delete both replicas simultaneously: `kubectl delete pod qm1-ibm-mq-1 qm1-ibm-mq-2`. The active instance, now 1/3, **stops serving** — it cannot quorum-commit, and refusing writes is the design, not a bug: serving without quorum risks split-brain divergence. Clients see connection broken / QM unavailable (2009/2059) until a replica rejoins and `QUORUM(2/3)` returns. This is the drill that teaches everyone why the PDB says `maxUnavailable: 1`.

**6. Drain test.** `kubectl drain <node-with-active-pod> --ignore-daemonsets --delete-emptydir-data`. The PDB serializes evictions; the active pod's eviction triggers one clean failover; the reconnect-enabled client shrugs. If the drain hangs on the PDB while another QM pod is unready, that's the PDB doing its job.

## Failure modes

| Failure | Behavior | Impact and recovery |
|---|---|---|
| Active pod lost | Replica elected in ~5–15s; clients with reconnect stall and resume | Quorum-committed persistent messages: zero loss. Non-persistent: gone. In-flight transactions roll back and are redelivered — consumers must be idempotent or use syncpoints |
| One replica lost | `QUORUM(2/3)`, `in_synch_instances` alert fires; service unaffected | Degraded, still quorate — you're one failure from an outage. Fix the pod/PVC now, at leisure, not later at gunpoint |
| Two instances lost | Active stops serving; QM unavailable | No quorum = no writes, by design. Recovery: get any second instance running and in-sync; service resumes automatically. Never "recover" by force-starting a lone instance |
| Recovery-log disk full | Persistent puts fail (`MQRC 2102 RESOURCE_PROBLEM`); QM may end | Expand the PVC (needs `allowVolumeExpansion`). The 80% alert above exists so you never read this row in anger |
| Channel refuses to start | Client: `AMQ4036`/`MQRC 2035` = CHLAUTH mapping or AUTHREC gap (check QM's AMQERR01.LOG for the matching AMQ9776/9777). `AMQ9643`/TLS errors = cipher or cert mismatch — check SSLCIPH both ends, cert DN vs SSLPEERMAP, CA in trust | Read the *queue manager side* error log; the client-side message is deliberately vague |
| Idle channels dying overnight | Apps throw `MQRC 2009 CONNECTION_BROKEN` at quiet times, fine under load | Classic idle timeout above HBINT — check the corporate appliance's timer first, it's usually the strictest hop. Fix HBINT (both channel and CCDT) below the timeout — don't fix it by adding retry loops in every app |

## Sizing and day-2

| Tier | CPU/mem per pod | Log PVC | Data PVC | Fits |
|---|---|---|---|---|
| Lab (developer license) | 0.5 / 1Gi | 5Gi | 5Gi | Functional testing |
| Standard prod | 1 / 2Gi | 15Gi | 20Gi | Most app domains, ~hundreds msg/s persistent |
| Heavy | 4 / 8Gi | 50Gi+ | 100Gi+ | High-volume persistent; benchmark fsync first |

Multiply storage by 3 — every instance carries a full copy. Persistent throughput is gated by quorum fsync latency long before CPU.

**Upgrades.** Bump `spec.version` to the next pinned release; the operator rolls one pod at a time, **replicas first, active last**, so you pay exactly one election per upgrade. Check `INSYNC(yes)` on all three before and after. Never skip the version/license-ID pairing check.

**Queue-full and poison messages.** `MAXDEPTH` breach returns `MQRC 2053` to producers — decide now whether producers block, retry, or shed. Poison messages hit `BOTHRESH(5)` and land in `APP.ORDERS.BACKOUT`; alert on that queue's depth > 0, because a silent backout queue is where incidents hide for weeks.

**Growing log volumes.** Expand the PVC in place if the class allows it; the CR's storage sizes only apply to new claims. This is a genuine platform-team dependency — confirm expansion support *before* you need it.

**Scoping: one QM per app domain, not one shared QM.** A queue manager per bounded context (orders, payments) keeps blast radius, upgrade windows, CHLAUTH surface, and noisy-neighbor risk contained — three pods per QM is cheap insurance. Shared "enterprise QM" topologies recreate the mainframe-era coupling you came to Kubernetes to escape. The broker-selection and scoping discussion continues in [Message Queues on Kubernetes](/stateful/message-queues/).
