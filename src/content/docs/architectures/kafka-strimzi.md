---
title: "Kafka: Production Reference Architecture (Strimzi)"
description: A complete, copy-paste-deployable 3-broker KRaft-mode Kafka cluster on Strimzi — node pools, the acks=all durability triangle, per-broker LoadBalancers over MetalLB, topics and users as CRs, alerts, and failure drills.
keywords:
  - KRaft mode no ZooKeeper
  - acks=all min.insync.replicas durability
  - advertised listeners bootstrap then direct
  - under-replicated partitions
  - KafkaNodePool dual-role
  - external clients time out after bootstrap
  - rack awareness zone spread
  - page cache heap small
  - KafkaTopic KafkaUser CRD
  - consumer group lag
  - NotEnoughReplicas offline partitions
sidebar:
  order: 11
---

This is the build article. Whether Kafka is the right broker at all — versus RabbitMQ, IBM MQ, or a managed stream — is argued in [Message Queues on Kubernetes](/stateful/message-queues/). Here we deploy one production cluster, `kafka`, using **Strimzi**: three KRaft-mode nodes running combined controller+broker roles via a `KafkaNodePool`, TLS everywhere, topics and users as CRs, external access over MetalLB, and the durability contract (`RF=3`, `min.insync.replicas=2`, `acks=all`) wired in from the first manifest. Every manifest is complete and applied in order.

:::note[Tuning the numbers]
Resource blocks and JVM sizes below are justified starting points, not gospel. The method for deriving your own lives in [Requests & Limits Knobs](/tuning/requests-limits-knobs/) and [JVM Memory Knobs](/tuning/jvm-memory-knobs/) — and Kafka is the one build in this section where the JVM memory story is deliberately upside down. Section 2 explains.
:::

## Architecture

```text
            off-cluster producers/consumers (TLS)
                │ bootstrap: kafka.example.com:9094 ──► then DIRECT to each
                │ broker, same VIP, per-broker port: :9095 / :9096 / :9097
                ▼
     ┌─────────────────────────────────────────────────────────────┐
     │ corporate LB appliance (network-team-owned): VIP 10.0.5.60   │
     │  :9094 ► 10.20.0.50:9094      :9096 ► 10.20.0.52:9094       │
     │  :9095 ► 10.20.0.51:9094      :9097 ► 10.20.0.53:9094       │
     └───────────────┬─────────────────────────────────────────────┘
                     ▼
     ┌─────────────────────────────────────────────────────────────┐
     │ MetalLB: 4 LoadBalancer Services (1 bootstrap + 1 PER broker)│
     └───────────────┬─────────────────────────────────────────────┘
     ┌───────────────┼───────────────────────────────────────────┐
     │ namespace: kafka-prod         Strimzi cluster operator     │
     │               ▼               (platform-installed, watches │
     │   Service kafka-kafka-bootstrap (ClusterIP, 9093)  this ns)│
     │        │ in-cluster clients: bootstrap, then direct        │
     │        ▼                                                   │
     │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
     │  │ kafka-dual-0 │◄►│ kafka-dual-1 │◄►│ kafka-dual-2 │      │
     │  │ broker +     │  │ broker +     │  │ broker +     │      │
     │  │ KRaft ctrl   │  │ KRaft ctrl   │  │ KRaft ctrl   │      │
     │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
     │         │  9090 ctrl quorum / 9091 replication (pod-to-pod)│
     │      [PVC-0]           [PVC-1]           [PVC-2]           │
     │      zone-a            zone-b            zone-c            │
     │                                                            │
     │  entity operator (topic + user) ── KafkaTopic/KafkaUser CRs│
     └────────────────────────────────────────────────────────────┘
```

The shape, and why:

- **The operator is the platform's; the CRs are yours.** Strimzi's cluster operator is installed cluster-wide (or per-namespace-watch) by the platform team — the standard [operator split](/controllers/operators/). You never touch a StatefulSet: you write `Kafka`, `KafkaNodePool`, `KafkaTopic`, and `KafkaUser` CRs, and the operator renders pods, per-pod PVCs, Services, and certificates from them.
- **ZooKeeper is dead — actually dead.** If your runbooks, Stack Overflow answers, or 2022-era Helm values mention a ZooKeeper ensemble: modern Kafka (4.x) and modern Strimzi (0.46+) are **KRaft-only**. The Raft-based metadata quorum runs inside Kafka nodes themselves; the `spec.zookeeper` block no longer exists, and there is no ZK anywhere in this build. If you're on an old ZK-based cluster, the migration path was Strimzi 0.4x's annotated migration — do that *before* the operator versions that support it disappear.
- **Node pools, and the roles decision.** `KafkaNodePool` assigns each set of nodes its `roles`: `controller`, `broker`, or both. At three nodes, this build uses one **dual-role pool** — every node is a broker *and* a KRaft quorum member. That's the pragmatic small-cluster answer: separate 3-controller + 3-broker pools cost three more pods whose only job is metadata, worth it only when broker load (GC pauses, saturated disks) starts destabilizing controller elections. Rule of thumb: split roles at ~6+ brokers or when you observe controller elections correlating with broker load spikes. Splitting later is a supported node-pool reshape, not a rebuild.
- **Clients bootstrap, then go direct — this drives everything about external access.** A Kafka client contacts *any* broker via the bootstrap address, receives cluster METADATA (every broker's advertised address, every partition leader), then opens **direct connections to individual brokers**. A single load balancer in front of all three brokers therefore cannot work for data traffic — the client will be told "partition 7's leader is broker 2, connect to broker 2's address" and must be able to reach exactly that broker. So Strimzi's `type: loadbalancer` listener creates **one LoadBalancer Service per broker plus one for bootstrap**: 4 [MetalLB](/controllers/metallb/) IPs for this build, plainly stated. This is raw [TCP ingress](/networking/tcp-ingress/) — no HTTP anything.
- **Alternative external paths, briefly.** `type: nodeport` advertises each broker on a node IP + high port: zero LB IPs, but your off-cluster clients need routable, stable node IPs and your firewall team needs to love NodePort ranges — fine in labs, rarely in prod. `type: ingress` rides an ingress-nginx with **TLS passthrough**: one IP total, one hostname per broker plus bootstrap, SNI does the broker routing. Cheapest on IPs, but adds a proxy hop to every fetch and requires the passthrough feature enabled on the controller. This build takes the LoadBalancer path because it's the fewest moving parts per byte.

### Through the corporate appliance: every broker needs its own path

In the corporate topology, the MetalLB IPs above are not what off-cluster clients dial. The network team's load-balancer appliance (F5 BIG-IP, NetScaler) owns the client-facing VIP; the MetalLB IPs are its **pool members**, and DNS points at the appliance. The standard split applies: network team owns the VIP, pools, monitors, and DNS; platform owns MetalLB; you own the `Kafka` CR — the general pattern is [External Load Balancing](/networking/external-load-balancing/). For HTTP that layering is invisible to the app. For Kafka it collides head-on with bootstrap-then-go-direct: a client that bootstraps through the appliance will be handed broker addresses from METADATA, and if those are the MetalLB IPs, the client — which can only route to the appliance — is stuck. Two consequences: **every broker needs its own forwarding path through the appliance**, and **the brokers must advertise that path, not their MetalLB addresses**.

Two appliance patterns deliver the per-broker paths:

1. **One VIP, per-broker ports** — the recommended shape. A single corporate VIP (`kafka.example.com` → `10.0.5.60`); bootstrap keeps 9094, and each broker gets a dedicated port pooled to that broker's MetalLB IP:

   | Client dials | Appliance pool member | Serves |
   |---|---|---|
   | `kafka.example.com:9094` | `10.20.0.50:9094` | bootstrap (any broker) |
   | `kafka.example.com:9095` | `10.20.0.51:9094` | broker 0 — and *only* broker 0 |
   | `kafka.example.com:9096` | `10.20.0.52:9094` | broker 1 |
   | `kafka.example.com:9097` | `10.20.0.53:9094` | broker 2 |

2. **One corporate VIP per broker** — four VIPs, everything on 9094. Cleaner port hygiene, but corporate VIP ranges are scarcer than MetalLB pool space, and adding a broker means requisitioning another routable IP instead of another port. Take this only if the port-per-broker pattern offends a firewall standard you can't change.

Strimzi supports this directly: the listener's `configuration.brokers[]` entries take `advertisedHost`/`advertisedPort` overrides, which change **only what the broker writes into METADATA** — the broker still listens on 9094, and the MetalLB Services are unchanged. The external listener from the CR below grows to:

```yaml
      - name: external
        port: 9094
        type: loadbalancer
        tls: true
        authentication: { type: tls }
        configuration:
          bootstrap:
            annotations: { metallb.io/address-pool: kafka-pool }
          brokers:
            - broker: 0
              annotations: { metallb.io/address-pool: kafka-pool }
              advertisedHost: kafka.example.com   # the CORPORATE VIP name —
              advertisedPort: 9095                # never the MetalLB IP
            - broker: 1
              annotations: { metallb.io/address-pool: kafka-pool }
              advertisedHost: kafka.example.com
              advertisedPort: 9096
            - broker: 2
              annotations: { metallb.io/address-pool: kafka-pool }
              advertisedHost: kafka.example.com
              advertisedPort: 9097
```

The details that bite, in the order they'll bite you:

- **The failure signature when this is missing** is treacherous: bootstrap *succeeds* (you dialed the VIP by name), metadata *arrives*, then every produce and consume **times out** — the client is obediently dialing `10.20.0.51:9094` from a network where that address doesn't route. Bootstrap working proves almost nothing; the failure-modes table below decodes it.
- **TLS stays end to end.** The appliance runs plain **TCP passthrough** on every port — with a dedicated port (or VIP) per broker it never needs to read SNI to route, so keep it dumb L4. Decline any offer to terminate TLS on the appliance: this listener is mTLS, and a terminating middlebox breaks both the client's CA verification and the brokers' client-certificate authentication. Strimzi adds `advertisedHost` to the listener certificates' SANs automatically, so hostname verification against `kafka.example.com` just works.
- **Idle timeout across the extra hop.** Kafka clients hold long-lived, often-idle connections to every broker; appliances reap idle flows (300 s is a common default) — silently, mid-idle, below the client's `connections.max.idle.ms` (9 min default). Ask for the VIP's idle timeout ≥ 630 s (comfortably above the client default), or lower `connections.max.idle.ms` below the appliance's number. Same physics as [Long-Lived Connections](/networking/long-lived-connections/), one more middlebox.
- **Monitors: TCP connect, one per pool.** Each of the N+1 pools gets a TCP monitor against its MetalLB `IP:9094` — not HTTP (there is nothing HTTP here), and *per pool*, because a down monitor on broker 1's pool means exactly the partitions broker 1 leads go unreachable externally while everything internal stays green.

The network-team request, ready to file (and re-file with one more line whenever you add a broker — pool growth is N+1, budget the ports up front):

> Please create a Kafka VIP on the shared LB pair, **TCP passthrough on all ports, no TLS termination, no HTTP profiles**:
> - VIP: 1 IP, DNS `kafka.example.com`
> - Port 9094 → pool `10.20.0.50:9094` (bootstrap)
> - Port 9095 → pool `10.20.0.51:9094` · Port 9096 → pool `10.20.0.52:9094` · Port 9097 → pool `10.20.0.53:9094` (one broker each — members must NOT be shared or load-balanced across brokers)
> - Monitors: TCP connect per pool member
> - Idle timeout ≥ 630 s on all ports (long-lived Kafka client connections)
> - Client source range: `10.30.0.0/16`

If there is no appliance in your shop, drop this subsection entirely: point clients straight at the MetalLB IPs (as the rest of this article shows), skip the `advertisedHost` overrides — Strimzi advertises the LoadBalancer addresses automatically — and the build works unchanged.

## Prerequisites: platform asks

File the [platform team request](/operations/working-with-platform-team/) early — four items are cluster-scoped and not yours:

1. **Strimzi cluster operator installed, pinned version, watching your namespace** (`STRIMZI_NAMESPACE` includes `kafka-prod`, or cluster-wide watch). [CRDs](/controllers/crds-explained/) are cluster-scoped; you can't install them.
2. **Rack-awareness RBAC.** `spec.kafka.rack` (below) makes each broker read its node's zone label via an init container — that needs a ClusterRoleBinding the operator only creates if it's allowed to. One-line ask: "enable rack awareness support for our Kafka CR."
3. **StorageClass guidance.** Kafka is sequential-I/O-friendly but fsync-sensitive in two places: the KRaft **metadata log** (small, latency-critical — slow fsync here destabilizes the controller quorum) and produce-path flushes. Ask for fast local-ish or provisioned-IOPS block storage, `WaitForFirstConsumer` binding, `allowVolumeExpansion: true` — the full conversation is in [Storage Controllers](/controllers/storage-controllers/) and [PVs & PVCs](/stateful/storage-pv-pvc/). Network-attached storage works; storage that lies about flushes does not.
4. **Four MetalLB IPs** from a routable pool: 3 brokers + 1 bootstrap. Adding a broker later costs one more IP — budget the pool accordingly.
5. **The network-team ticket, if a corporate appliance fronts external access:** the VIP, N+1 pools with per-broker ports, TCP monitors, and the idle-timeout ask — the template is in the appliance subsection above. File it alongside item 4; the pools can't be built until the MetalLB IPs exist, and your external clients can't connect until both are done.

## The build

```bash
kubectl create namespace kafka-prod
```

### 1. KafkaNodePool: the nodes

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaNodePool
metadata:
  name: dual
  namespace: kafka-prod
  labels:
    strimzi.io/cluster: kafka    # binds this pool to the Kafka CR below
spec:
  replicas: 3                    # quorum math: 3 controllers tolerate 1 loss.
                                 # NEVER 2 — Raft majority-of-2 is 2. And never
                                 # an even number; 4 tolerates the same 1 loss as 3.
  roles: [controller, broker]    # dual-role: the pragmatic 3-node shape.
                                 # Splitting later = add a controller-only pool,
                                 # then remove the role here.
  storage:
    type: jbod                   # JBOD even with one volume: lets you ADD volumes
    volumes:                     # later without a storage-type migration
      - id: 0
        type: persistent-claim
        size: 500Gi              # retention is a disk budget (see topic CR below):
                                 # size for retention × ingest rate × RF, not vibes
        class: fast-ssd          # the fsync conversation from prerequisites
        deleteClaim: false       # a deleted CR must never take the data with it
        kraftMetadata: shared    # KRaft metadata log lives on this volume —
                                 # why the latency ask matters even for volume 0
```

### 2. The Kafka CR

This is the cluster. Everything is annotated because every line is a decision:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: kafka
  namespace: kafka-prod
  annotations:
    strimzi.io/node-pools: enabled   # nodes come from KafkaNodePools, not legacy spec
    strimzi.io/kraft: enabled        # explicit, even though it's the only mode now
spec:
  kafka:
    version: 4.0.0                   # PIN it. Upgrades are a deliberate two-step
    metadataVersion: 4.0-IV3         # (day-2 section), never a floating tag.
    listeners:
      - name: tls                    # in-cluster clients: 9093, TLS + mTLS auth
        port: 9093
        type: internal
        tls: true
        authentication: { type: tls }
      - name: external               # off-cluster: 9094 via MetalLB
        port: 9094
        type: loadbalancer           # => 1 LB per broker + 1 bootstrap = 4 IPs
        tls: true
        authentication: { type: tls }
        configuration:
          bootstrap:
            annotations:
              metallb.io/address-pool: kafka-pool
          brokers:                   # per-broker Service annotations; also where
            - broker: 0              # you'd pin loadBalancerIPs if firewalls care —
              annotations: { metallb.io/address-pool: kafka-pool }
                                     # and where advertisedHost/advertisedPort go when
                                     # a corporate appliance fronts the cluster (see
                                     # the appliance subsection in Architecture)
            - broker: 1
              annotations: { metallb.io/address-pool: kafka-pool }
            - broker: 2
              annotations: { metallb.io/address-pool: kafka-pool }
    authorization:
      type: simple                   # ACLs enforced; KafkaUser CRs grant them
    config:
      # ---- THE durability triangle (explained below) ----
      default.replication.factor: 3
      min.insync.replicas: 2
      offsets.topic.replication.factor: 3        # internal topics get the same
      transaction.state.log.replication.factor: 3 # treatment — losing consumer
      transaction.state.log.min.isr: 2            # offsets is losing your place
      # ---- topic hygiene ----
      auto.create.topics.enable: false # a typo'd topic name must be an error,
                                       # not a silent default-config topic that
                                       # dodges your KafkaTopic CRs and reviews
      # ---- retention defaults (topics override per-CR) ----
      log.retention.hours: 168         # 7 days; retention is the disk budget
      log.segment.bytes: 1073741824    # 1Gi segments: retention deletes whole
                                       # segments, so this is deletion granularity
    resources:                       # requests == limits => Guaranteed QoS.
      requests: { cpu: "2", memory: 12Gi }
      limits:   { cpu: "2", memory: 12Gi }
    jvmOptions:
      -Xms: 4g                       # heap SMALL on purpose — see below
      -Xmx: 4g
    rack:
      topologyKey: topology.kubernetes.io/zone   # replicas spread across zones at
                                                 # the PARTITION level, and consumers
                                                 # can fetch from their local replica.
                                                 # Needs the RBAC platform ask.
    template:
      pod:
        topologySpreadConstraints:   # one broker per zone: a zone outage leaves
          - maxSkew: 1               # 2 of 3 — quorum intact, minISR satisfiable.
            topologyKey: topology.kubernetes.io/zone
            whenUnsatisfiable: DoNotSchedule     # scheduling mechanics:
            labelSelector:                       # /workloads/scheduling/
              matchLabels:
                strimzi.io/cluster: kafka
                strimzi.io/kind: Kafka
      podDisruptionBudget:
        maxUnavailable: 1            # Strimzi's default, pinned so nobody
                                     # "simplifies" it: a drain may take ONE
                                     # broker/controller at a time, ever.
    metricsConfig:
      type: jmxPrometheusExporter
      valueFrom:
        configMapKeyRef: { name: kafka-metrics, key: kafka-metrics-config.yml }
  entityOperator:                    # two sidecars that reconcile YOUR CRs:
    topicOperator: {}                # KafkaTopic -> real topics
    userOperator: {}                 # KafkaUser  -> credentials + ACLs
```

**The durability triangle, spelled out.** Three settings form one contract, and all three must agree:

1. `default.replication.factor: 3` — every partition has 3 replicas, one per zone (rack awareness).
2. `min.insync.replicas: 2` — a partition accepts an acked write only while ≥2 replicas are caught up.
3. `acks=all` — set **by producers** (client contract section): the leader confirms only after every in-sync replica has the write.

Together: every acknowledged message is on **2 disks in 2 zones** before the producer proceeds, and the cluster tolerates exactly one broker loss with no data loss *and* no write outage. Break any corner and the contract quietly dies — `acks=1` means an acked message can vanish in a leader failover; `min.insync.replicas: 1` means "acked" can mean "on one disk that just caught fire"; `min.insync.replicas: 3` means one broker down = every producer blocked. The failure-modes table shows each corner failing.

**The heap-small/pagecache-big rule — read this before "fixing" the memory numbers.** Every other JVM build in this guide pushes heap toward 60–75% of the container limit per [JVM Memory Knobs](/tuning/jvm-memory-knobs/). **Kafka is the exception.** Kafka barely uses its heap: messages are written to and served from the **OS page cache**, handed to sockets with zero-copy transfers that never enter the JVM. A big heap actively hurts — it steals memory from the page cache and buys you longer GC pauses on a component whose pauses trigger leader elections. So: **4–6Gi heap, full stop, even on huge nodes** — and the container gets 12Gi so the *other* 8Gi is page cache for hot log segments. Two dashboard consequences: cgroup memory usage will sit near the limit **and that's healthy** (it's cache, reclaimable); and `container_memory_working_set_bytes` — the number that predicts OOM risk, per [Requests & Limits Knobs](/tuning/requests-limits-knobs/) — excludes inactive cache and should hover near heap + active cache, well under the limit. Alert on working set, never on raw usage, or Kafka pages you every night for doing its job.

### 3. Topics and users as code

`auto.create.topics.enable: false` means topics exist only as reviewed CRs — the entity operator reconciles them:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: orders.events
  namespace: kafka-prod
  labels:
    strimzi.io/cluster: kafka
spec:
  partitions: 12          # PARTITIONS ARE (effectively) FOREVER. You can add
                          # partitions later — but adding them changes key->partition
                          # mapping, breaking per-key ordering for every keyed
                          # producer. You can NEVER remove them. Overshoot modestly
                          # (12 for a 3-broker cluster = 4 leaders/broker, and room
                          # for 12 parallel consumers); don't "plan ahead" to 500.
  replicas: 3             # matches the triangle; never below it
  config:
    retention.ms: "604800000"      # 7 days explicit — retention is this topic's
    min.insync.replicas: "2"       # disk budget AND your replay/reprocess window
```

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: orders-app
  namespace: kafka-prod
  labels:
    strimzi.io/cluster: kafka
spec:
  authentication:
    type: tls             # mTLS: the user operator mints a client cert.
                          # type: scram-sha-512 if your clients can't do mTLS —
                          # same CR shape, password instead of cert.
  authorization:
    type: simple
    acls:                 # least privilege, per app, reviewed in git
      - resource: { type: topic, name: orders.events, patternType: literal }
        operations: [Describe, Read, Write]
      - resource: { type: group, name: orders-app, patternType: prefix }
        operations: [Read]          # consumer groups need Read on the GROUP too —
                                    # forgetting this is the #1 "why can I produce
                                    # but not consume" ticket
```

The user operator writes a Secret named `orders-app` back into the namespace: `user.crt`/`user.key` (plus a ready-made `user.p12` + password for JVM clients), and the cluster CA is in `kafka-cluster-ca-cert`. Your app mounts these like any other credential — hygiene, rotation, and mounting patterns in [Secrets](/workloads/secrets/). Strimzi renews the CA on a schedule; clients must re-read mounted certs or restart on rotation.

**A second, read-only user for autoscaling.** The [KEDA build](/architectures/keda-autoscaling/) scales the `order-events-consumer` group on this topic's lag, and its operator is a *separate* Kafka client from your app — it needs its own credential with the narrowest possible grant: **Read** on the topic (to read committed offsets) and **Describe** on the consumer group. Never reuse `orders-app` for it — separate creds mean an app-side rotation can't silently break scaling, and vice versa.

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: order-events-scaler
  namespace: kafka-prod
  labels:
    strimzi.io/cluster: kafka
spec:
  authentication:
    type: scram-sha-512   # KEDA's kafka scaler consumes SASL creds; SCRAM keeps
                          # the scaler's client config to username/password + CA,
                          # no keystore to mount into the KEDA operator
  authorization:
    type: simple
    acls:                 # least privilege: read offsets, describe the group. No Write.
      - resource: { type: topic, name: orders.events, patternType: literal }
        operations: [Describe, Read]
      - resource: { type: group, name: order-events-consumer, patternType: literal }
        operations: [Describe, Read]
```

The user operator writes a Secret named `order-events-scaler` holding the SCRAM `password`; the KEDA `TriggerAuthentication` references it directly (see the KEDA build's §2).

### 4. NetworkPolicy

Strimzi creates its own policies for the ports it owns (9090 controller quorum, 9091 replication, operator access). Your job is the client-facing surface — and pinning the pod-to-pod rules explicitly so a future default-deny doesn't eat the cluster:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kafka-clients
  namespace: kafka-prod
spec:
  podSelector:
    matchLabels: { strimzi.io/kind: Kafka }
  policyTypes: [Ingress]
  ingress:
    - from:                                  # app namespaces -> internal TLS listener
        - namespaceSelector:
            matchLabels: { kafka-client: "true" }
      ports:
        - { port: 9093, protocol: TCP }
        # add 9092 here ONLY if you add a plaintext internal listener; this
        # build deliberately has no plaintext port at all
    - from:                                  # off-cluster via MetalLB -> external
        - ipBlock: { cidr: 10.30.0.0/16 }    # your producer/consumer range
      ports:
        - { port: 9094, protocol: TCP }
    - from:                                  # quorum + replication: STRICTLY pod-to-pod
        - podSelector:
            matchLabels: { strimzi.io/kind: Kafka }
      ports:
        - { port: 9090, protocol: TCP }      # KRaft controller quorum
        - { port: 9091, protocol: TCP }      # inter-broker replication
    - from:                                  # metrics -> monitoring only
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: monitoring }
      ports:
        - { port: 9404, protocol: TCP }      # jmx-prometheus-exporter
```

Whether `ipBlock` sees real client IPs through the LB path depends on `externalTrafficPolicy` and your CNI — verify with a live connection before trusting the rule: [Network Policies](/networking/network-policies/).

### 5. Monitoring and the alerts that matter

The `metricsConfig` block above needs its rules ConfigMap — take `kafka-metrics.yaml` from the Strimzi examples repo for your operator version verbatim (the JMX→Prometheus relabel rules are versioned with Strimzi; don't hand-roll them). Scrape port 9404 on the broker pods. Confirm exact metric names against your endpoint before paging anyone; routing and severity design live in [Alerting](/observability/alerting/).

```promql
# Under-replicated partitions: a broker is down or falling behind.
# Not an outage YET — you are one more failure from one. Page at >0 for 5m.
sum(kafka_server_replicamanager_underreplicatedpartitions) > 0

# Offline partitions: no leader — producers AND consumers of these are dead now.
sum(kafka_controller_kafkacontroller_offlinepartitionscount) > 0

# KRaft brain check: exactly one active controller, always.
sum(kafka_controller_kafkacontroller_activecontrollercount) != 1

# Disk: retention deletes lag ingest spikes. Page well before full (see failure table).
kubelet_volume_stats_available_bytes{namespace="kafka-prod"}
  / kubelet_volume_stats_capacity_bytes{namespace="kafka-prod"} < 0.15

# Consumer lag needs a lag exporter (Strimzi ships kafka-exporter as
# spec.kafkaExporter; Burrow if you want evaluation windows, not thresholds):
sum by (consumergroup, topic) (kafka_consumergroup_lag) > 50000
```

Lag deserves one design note: alert on lag *growing over a window*, not a raw threshold — a batch consumer legitimately builds lag every night. `deriv()` or offset-comparison beats a magic number.

## The client contract

What every team connecting to this cluster must set — put it in the onboarding doc, not tribal memory:

```properties
# ---- everyone ----
bootstrap.servers=kafka-kafka-bootstrap.kafka-prod.svc:9093   # in-cluster
# external clients: bootstrap.servers=kafka.example.com:9094 (the corporate VIP;
# 10.20.0.50:9094 directly if no appliance fronts you) — but remember: bootstrap is
# ONLY the introduction. After metadata, clients dial each broker's ADVERTISED
# address: kafka.example.com:9095/:9096/:9097 through the appliance, or the
# per-broker MetalLB IPs (.51/.52/.53) without one.
security.protocol=SSL
ssl.truststore.location=/certs/ca.p12          # from kafka-cluster-ca-cert Secret
ssl.keystore.location=/certs/user.p12          # from the KafkaUser Secret

# ---- producers: the third corner of the durability triangle ----
acks=all
enable.idempotence=true        # exactly-once per partition per producer session;
                               # makes broker-failover retries safe (no dupes/reorder)
delivery.timeout.ms=120000     # total retry budget — fail loudly after 2 minutes

# ---- consumers ----
group.id=orders-app            # must match the ACL'd group prefix
auto.offset.reset=earliest     # explicit choice; "latest" silently skips backlog
# Offsets are committed positions, not acks — commit after processing, and make
# processing idempotent: rebalances and rewinds redeliver. That's Kafka's model.
```

Connection behavior on the external path needs care. Kafka clients hold **long-lived TCP connections to every broker they talk to** and refresh cluster metadata every `metadata.max.age.ms` (5 min default). Any middlebox idle timeout on the LB path shorter than the client's `connections.max.idle.ms` (9 min default) silently severs connections mid-idle, and the next produce eats a reconnect + metadata round trip — set the client idle timeout *below* the path's timeout, or better, keep chatty defaults and verify the path. The physics: [Long-Lived Connections](/networking/long-lived-connections/). MetalLB itself imposes no idle timeout — but the corporate appliance in front almost certainly does (that's the ≥ 630 s line in the network-team template), and so does the firewall between your datacenter VLANs.

## Verification plan

**1. Cluster formed, quorum healthy.** Run a throwaway client pod (same image as the brokers — the CLI tools ship in it):

```console
$ kubectl run kfk -n kafka-prod --rm -it \
    --image=quay.io/strimzi/kafka:0.46.0-kafka-4.0.0 -- \
    bin/kafka-metadata-quorum.sh --bootstrap-server kafka-kafka-bootstrap:9093 \
    --command-config /tmp/client.properties describe --status
LeaderId:            0
CurrentVoters:       [0, 1, 2]
HighWatermark:       1247
```

Three voters, one leader, advancing high watermark — the KRaft quorum is alive. (`client.properties` = the TLS trust/keystore lines from the contract above; every CLI invocation below needs it.)

**2. Topic exists as declared.**

```console
$ bin/kafka-topics.sh --bootstrap-server kafka-kafka-bootstrap:9093 \
    --command-config /tmp/client.properties --describe --topic orders.events
Topic: orders.events  PartitionCount: 12  ReplicationFactor: 3
  Configs: min.insync.replicas=2,retention.ms=604800000
  Partition: 0  Leader: 1  Replicas: 1,0,2  Isr: 1,0,2
  ...
```

Twelve partitions, ISR lists all three brokers everywhere, leaders spread across 0/1/2 (rack awareness working).

**3. Produce/consume round trip — internal, then external.** Internally: `kafka-console-producer.sh`/`consumer.sh` against `kafka-kafka-bootstrap:9093` with the `orders-app` certs; type a line, see it echo. Externally: same commands from **off-cluster** against the corporate VIP, `kafka.example.com:9094` (or `10.20.0.50:9094` if no appliance fronts you), with the same CA truststore (Strimzi's listener certs carry the LB IPs — and any `advertisedHost` override — as SANs automatically). If internal works and external times out *after* an initial connection succeeds, you have the advertised-listener failure from the table below — bootstrap reachable, brokers not. Worth one extra minute here: `kafka-broker-api-versions.sh --bootstrap-server kafka.example.com:9094` prints each broker's advertised address — every line must show the corporate VIP name and a per-broker port, never a MetalLB IP.

**4. Kill-a-broker drill.** Start a continuous producer (`acks=all`, idempotence on), then `kubectl delete pod kafka-dual-1`. Expected sequence: `underreplicatedpartitions` jumps to ~⅓ of partitions; leaders held by broker 1 re-elect in seconds; the producer sees a brief blip of retriable `NOT_LEADER_OR_FOLLOWER` errors that idempotent retries absorb — **zero message loss, zero duplicates, throughput dip of seconds**. The pod returns, replicas catch up, URP drains to 0. If your producer *errored out* instead, its retry/timeout budget is miswired — fix the client, not the cluster.

**5. Rolling restart.** Change anything rollable (a `config` value), or `kubectl annotate strimzipodset kafka-dual strimzi.io/manual-rolling-update=true`. Watch: Strimzi rolls **one pod at a time and checks partition safety first** — it will not restart a broker if doing so would drop any partition below `min.insync.replicas`. This is the operator earning its keep; a bare StatefulSet rolling update ([StatefulSets Fundamentals](/stateful/statefulsets-fundamentals/)) has no such judgment.

**6. Controller failover.** Note `LeaderId` from step 1, delete that pod. Re-run `describe --status` from another broker: a new leader within seconds, `CurrentVoters` unchanged. Clients shouldn't notice at all — data traffic doesn't touch the quorum.

**7. Drain test.** `kubectl drain <node-with-kafka-dual-2> --ignore-daemonsets --delete-emptydir-data`. The PDB admits one eviction; if a second broker is already unready the drain **hangs, correctly** — that hang is [High Availability](/workloads/high-availability/) working as designed. Never `--disable-eviction` past it.

## Failure modes

| Failure | Behavior | Impact and recovery |
|---|---|---|
| One broker down | URP > 0; leader elections in seconds; ISR shrinks to 2 = still ≥ minISR | Fully writable and readable, but zero margin — one more failure is an outage. Fix now, calmly. Idempotent producers ride through the elections |
| Two brokers down | Partitions lose ISR ≥ 2: **producers with `acks=all` block, then error** (`NotEnoughReplicas`); partitions whose remaining replica isn't leader go fully offline | No majority = no acked writes, by design — the triangle protecting you. Recover *either* broker and everything resumes. Never "fix" it with `min.insync.replicas: 1` |
| Disk full on one broker | That broker's log appends fail; historically Kafka **kills the broker process** rather than corrupt logs → pod crash-loops; its partitions fail over | Cluster degrades to the one-broker-down row. Expand the PVC (`allowVolumeExpansion`), restart, let replication catch up. The 15% disk alert exists so this row stays theoretical |
| KRaft quorum loss (2 of 3 controllers down) | No metadata writes: **no leader elections, no topic changes, no consumer-group coordination changes**. Existing leaders keep serving on cached metadata — deceptively "up" | The scary one: looks healthy until the next broker hiccup can't elect a leader. Restore any second controller; quorum resumes automatically. This is why dual-role at 3 nodes means broker health *is* controller health |
| LB path broken, internal fine | External clients connect to bootstrap fine, fetch metadata fine, then **time out talking to brokers** — because clients dial the per-broker advertised addresses from METADATA, *not* your bootstrap string | The #1 external-Kafka confusion. Bootstrap working proves almost nothing. No appliance: check all 4 LB Services have external IPs and each broker IP is reachable from the client network — one lost MetalLB IP breaks exactly the partitions led by that broker. **With the corporate appliance:** same signature means the brokers are advertising MetalLB IPs the client can't route to (missing `advertisedHost`/`advertisedPort` overrides — fix the listener config), or one broker's appliance pool/port is down or mismapped to the wrong broker — TCP monitor status and the port-map table decide which, and the second one is a network-team ticket |
| Storage latency spike | Produce p99 explodes cluster-wide: page-cache writeback stalls, replica fetchers lag, ISRs flap in and out (URP oscillates) | Kafka absorbs bursts in page cache — sustained slow flushes are unabsorbable. Check the storage backend before restarting anything; restarts make it worse (log recovery = more I/O). This is the prerequisite fsync conversation, cashed in |

## Sizing and day-2

| Tier | Nodes | CPU / memory per pod (heap) | PVC each | Partitions guidance |
|---|---|---|---|---|
| Small | 3 dual-role | 1 / 6Gi (heap 3Gi) | 100Gi | ≤ ~200 partitions/broker; single-team, few topics |
| Medium (this build) | 3 dual-role | 2 / 12Gi (heap 4Gi) | 500Gi | ≤ ~1000 partitions/broker; steady multi-team production |
| Large | 3 controllers + 5+ brokers (split pools) | 4–8 / 24–32Gi (heap 6Gi — **still 6Gi**; the rest is page cache) | 1–2Ti JBOD, multiple volumes | Thousands of partitions/broker; benchmark before believing |

Memory scales the *container* (page cache), not the heap — that rule survives every tier.

**Upgrades are a two-step, in order, always.** (1) Platform team upgrades the **operator** first — new Strimzi speaks old Kafka. (2) You bump `spec.kafka.version`; Strimzi rolls brokers with its ISR-aware choreography. (3) After a soak period, bump `metadataVersion` — the KRaft successor to the old inter-broker protocol bump. Until step 3 you can roll back the version; **after it you cannot**. Two changes, two PRs, days apart.

**Adding brokers.** Bump the pool's `replicas` (one more MetalLB IP — and, behind the corporate appliance, one more VIP port + pool + `advertisedPort` override: the N+1 ticket from the appliance subsection). The new broker joins **empty** — Kafka never auto-rebalances data. Enable `spec.cruiseControl: {}` in the Kafka CR and apply a `KafkaRebalance` CR in `add-brokers` mode; Cruise Control computes and executes the partition reassignment with throttles. Hand-rolled `kafka-reassign-partitions.sh` works but is an evening of JSON you don't need to have.

**When to shard clusters.** One cluster stops being the answer when teams need conflicting configs (retention, versions, maintenance windows), when partition counts push controller limits, or when one team's backlog can evict another's page cache. Split by domain — `orders-kafka`, `telemetry-kafka` — the same blast-radius argument as every broker in [Message Queues on Kubernetes](/stateful/message-queues/): each clone stays a boring three-node build exactly like this one.
