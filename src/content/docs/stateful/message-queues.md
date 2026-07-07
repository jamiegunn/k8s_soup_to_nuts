---
title: Message Queues on Kubernetes
description: Running IBM MQ, RabbitMQ, ActiveMQ Artemis, and Kafka on Kubernetes — persistence, quorum safety, PDBs, and client reconnect behavior.
sidebar:
  order: 7
---

Message brokers are stateful twice over: they hold data (persisted messages) *and* identity (a queue manager name, a node ID in a quorum, a broker ID in a cluster). Kubernetes will cheerfully reschedule, restart, and drain them like any other pod — so your job is to make the broker's assumptions and Kubernetes's behavior meet in the middle. The themes repeat across every broker; the specifics differ.

:::tip[Complete build available]
Running IBM MQ? The [IBM MQ reference architecture](/architectures/ibm-mq/) is the full Native HA build — QueueManager CR, TLS channels, MetalLB VIP, quorum drills — ready to adapt.
:::

## The common themes

**Persistence.** Persistent messages live on disk. Every broker below needs PVCs, and the [access mode](/stateful/storage-pv-pvc/) matters — a broker's journal generally wants RWO block storage; some HA modes (IBM MQ multi-instance, Artemis shared-store) instead demand RWX with real POSIX locking, which most NFS-flavored classes only sort of provide. Verify with your platform team, not with hope.

**Ordered identity.** Brokers are StatefulSet-shaped: `rabbitmq-2` must come back *as* `rabbitmq-2` with its disk, or the cluster sees a stranger. Everything in [StatefulSets Fundamentals](/stateful/statefulsets-fundamentals/) applies, including the force-delete warnings.

**Quorum safety and PDBs.** Raft-style brokers (MQ Native HA, RabbitMQ quorum queues, Kafka/KRaft) tolerate losing a minority. Node drains during cluster maintenance are the threat: two of three replicas gone simultaneously = unavailable, or worse. A PodDisruptionBudget makes drains wait:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: broker-pdb
spec:
  maxUnavailable: 1
  selector:
    matchLabels: { app: my-broker }
```

Combine with a `topologySpreadConstraint` or anti-affinity so all three replicas aren't on one node to begin with — otherwise the PDB is protecting a single point of failure. (Good operators create both for you.)

:::caution[PDBs protect against drains, not against you]
A PDB blocks *voluntary* evictions — node drains, descheduling. It does nothing about `kubectl delete pod`, a bad rolling update, or a node dying. And never force-delete two members of a three-member quorum "to unstick things": you've just converted an availability problem into a data-consistency problem. The safe force-delete procedure is in [StatefulSets Fundamentals](/stateful/statefulsets-fundamentals/).
:::

**Graceful shutdown draining.** On SIGTERM a broker should stop accepting connections, hand off leadership, and flush its journal. That takes longer than the default 30s grace period — set `terminationGracePeriodSeconds` to 120+ for brokers, or every drain becomes an unclean shutdown and a journal recovery on restart.

**Client reconnect behavior.** This is the half of HA that lives in *your application*. Every failover, every rolling update, every drain looks to clients like a dropped TCP connection. Clients must:

- **Reconnect with backoff and jitter.** A reconnect stampede after failover is a classic secondary outage — 300 consumers hammering a freshly promoted broker back to its knees.
- **Rediscover the current leader** — via the Service, or protocol-level discovery (MQ client auto-reconnect with a CCDT listing the Service; Kafka's bootstrap + metadata protocol).
- **Handle redelivery.** Most brokers guarantee at-least-once; messages in flight during a failover *will* be delivered again. Consumers must be idempotent — dedup keys, upserts, or transactional outbox patterns on the consuming side.
- **Fail sends loudly.** A publisher that silently drops messages during the 10-second failover window creates the worst kind of bug: no error, no message, discovered weeks later.

If clients connect from *outside* the cluster, the door they come through is its own problem — LB idle timeouts vs protocol heartbeats, client IP preservation, one-VIP-per-broker trade-offs — covered in [TCP and non-HTTP ingress](/networking/tcp-ingress/).

Test all four by killing broker pods in staging while load runs. It's the cheapest chaos experiment with the highest yield, and it converts "we think the client reconnects" into a measured recovery time.

## IBM MQ

IBM ships an official container (`icr.io/ibm-messaging/mq`) and a certified operator (`QueueManager` CR, mostly documented for OpenShift but usable elsewhere — [CRD](/controllers/crds-explained/) install is a platform request). The unit of identity is the **queue manager**: its name, its logs, and its object definitions live on the volume. The queue manager *is* its disk.

Two deployment shapes matter:

- **Single instance + PVC** — one pod, one RWO volume. Outage = pod reschedule time. Completely respectable for dev and for moderate-RTO production; MQ recovers its logs cleanly on restart if you gave it a decent grace period.
- **Native HA** — three pods, three RWO PVCs, Raft-replicated log; one active, two replicas, automatic failover in seconds. This is the modern k8s-native answer (the old multi-instance pattern needed lock-capable RWX filesystems — avoid it on k8s unless platform confirms genuine POSIX locking). Native HA is a quorum: PDB with `maxUnavailable: 1`, spread across nodes, never force-delete two members.

With the operator installed (platform request), a Native HA queue manager is a compact CR:

```yaml
apiVersion: mq.ibm.com/v1beta1
kind: QueueManager
metadata:
  name: orders-qm
spec:
  license:
    accept: true
    license: L-XXXX-XXXXXX      # from IBM's license list for your MQ version
    use: Production
  queueManager:
    name: ORDERSQM
    availability:
      type: NativeHA
    storage:
      queueManager:
        type: persistent-claim
        size: 20Gi
        storageClassName: fast-ssd
    resources:
      requests: { cpu: "1", memory: 1Gi }
      limits:   { cpu: "2", memory: 2Gi }
  version: 9.4.2.0-r1
```

Check quorum health from inside the active pod with `dspmq -o nativeha`:

```console
$ kubectl exec orders-qm-ibm-mq-0 -- dspmq -o nativeha -m ORDERSQM
QMNAME(ORDERSQM) ROLE(Active) INSTANCE(orders-qm-ibm-mq-0) INSYNC(Yes) QUORUM(3/3)
```

`QUORUM(2/3)` during a node drain is expected; `2/3` for hours means a replica isn't coming back — investigate before the next drain makes it `1/3` and the queue manager stops.

License note: the developer edition (`mq:latest` with `LICENSE=accept`) is free; production MQ is licensed per core — sized by the container's CPU **limits** under IBM's container licensing terms, so set explicit limits and keep records.

## RabbitMQ

Use the official **cluster-operator** (`RabbitmqCluster` CR — platform installs the operator, you create the CR):

```yaml
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqCluster
metadata:
  name: orders-mq
spec:
  replicas: 3
  persistence:
    storageClassName: fast-ssd
    storage: 20Gi
  resources:
    requests: { cpu: "1", memory: 2Gi }
    limits:   { cpu: "2", memory: 2Gi }
```

The operator handles the StatefulSet, peer discovery, PDB, and rolling upgrades. Two decisions remain yours:

- **Quorum queues, not classic mirrored queues.** Classic queue mirroring is deprecated and removed in RabbitMQ 4.x; it had well-documented data-loss edge cases during partitions. Declare queues as `x-queue-type: quorum` (Raft-based, predictable partition behavior). The remaining role for classic queues is transient/exclusive queues where loss is fine.
- **Partition handling.** Quorum queues make this mostly moot (minority side just stalls — correct behavior), but if you still run classic mirrors anywhere, `pause_minority` is the only defensible `cluster_partition_handling` setting on Kubernetes.

Memory: RabbitMQ blocks *publishers* at its high-memory watermark; the operator sets the watermark relative to the container limit. If publishers mysteriously hang, check the broker's memory alarms before blaming the network.

## ActiveMQ Artemis

Artemis (the modern ActiveMQ; "Classic" is legacy — don't start new deployments on it) has an official operator, **activemq-artemis-operator** (`ActiveMQArtemis` CR), which handles clustering, versioned upgrades, and address/queue config via CRs.

The HA model choice:

- **Shared-store**: live and backup broker point at the same journal volume; failover = backup grabs the file lock. On k8s this means an RWX volume with reliable locking — the same caveat as MQ multi-instance. Historically the more robust option *on bare metal with a real SAN*; on typical k8s storage it's the harder one to do safely.
- **Replication**: live streams its journal to the backup over the network; no shared volume, each broker has its own PVC. Fits Kubernetes storage far better. Classic replication needs quorum help to avoid split-brain (that's what the pluggable quorum/ZooKeeper option is for); the operator's supported topologies handle the wiring — stay inside them.

A minimal operator-managed broker, for shape:

```yaml
apiVersion: broker.amq.io/v1beta1
kind: ActiveMQArtemis
metadata:
  name: orders-broker
spec:
  deploymentPlan:
    size: 2
    persistenceEnabled: true
    storage:
      size: 20Gi
      storageClassName: fast-ssd
    messageMigration: true      # drain messages off a scaled-down broker
  acceptors:
    - name: core
      port: 61616
      protocols: core,amqp
```

`messageMigration: true` matters more than it looks: without it, scaling down strands persisted messages on the removed broker's PVC until it scales back up.

## Kafka, briefly

Kafka deserves (and has) whole books; the Kubernetes summary: use **Strimzi**. It's the mature CNCF operator — `Kafka` CR, rack awareness, rolling upgrades that respect in-sync replicas, cruise-control rebalancing. Two era notes: ZooKeeper is gone — modern Kafka is **KRaft** (Raft-based, controllers either dedicated or combined via Strimzi's `KafkaNodePool`s), which removes an entire stateful system from your stack; and client behavior differs from the queue brokers above — Kafka clients bootstrap through any broker then connect *directly to partition leaders* via advertised listeners, so Strimzi's listener configuration (not a plain Service) is what makes external access work. Consumers track their own offsets; "redelivery" is your consumer group rewinding, and idempotency is still your job.

## Choosing, honestly

| You have | Reasonable default |
|---|---|
| Existing MQ estate, JMS apps, ops runbooks | IBM MQ container, Native HA |
| General app messaging, AMQP, routing needs | RabbitMQ cluster-operator, quorum queues |
| JMS-heavy Java stack, embedded-broker history | Artemis operator, replication HA |
| Event streaming, replay, high throughput | Kafka via Strimzi |

And the perennial alternative: if a managed service (cloud MQ/AMQP/Kafka offerings) fits your latency and compliance needs, the [overview's decision framework](/stateful/overview/) applies — connect to it and let someone else own broker 3 a.m. pages. Whatever you run, wire up broker metrics from day one ([Metrics](/observability/metrics/)): queue depth and consumer lag are the two numbers that predict messaging incidents before they page you.
