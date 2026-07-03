---
title: Reference Architectures
description: Complete, copy-paste-deployable builds — every manifest included, every choice explained, with verification plans and failure-mode tables.
sidebar:
  order: 1
---

The rest of this site explains *how things work*. This section is different: each article here is a **complete build** — a set of manifests you can apply in order and get a working, production-shaped system, with every design choice annotated and a test plan to prove it behaves under failure.

## How to use these

1. **Read the architecture overview first**, not the YAML. Each build makes trade-offs (manual failover vs operator complexity, sync vs async replication, one VIP vs many) and the overview tells you whether those trade-offs fit your situation.
2. **Collect the platform asks early.** Every build lists what only your platform team can provide — a MetalLB pool, an operator install, a StorageClass with known fsync behavior. File those requests before you start applying manifests.
3. **Run the verification plan, including the failure drills.** A reference architecture you haven't killed a pod in is a diagram, not a system. Each article ends with kill-the-primary, drain, and restore drills with expected timings.
4. **Adapt names, sizes, and namespaces** — the manifests use consistent placeholder names (`valkey-*`, `pg-*`, `qm1`) and deliberately conservative resource sizing. Scale with the sizing tables, not by guessing.

## The builds

| Architecture | What it demonstrates |
|---|---|
| [Valkey: Two StatefulSets, One MetalLB VIP](/architectures/valkey-shared-vip/) | Read/write splitting over a single shared VIP separated by port (`metallb.io/allow-shared-ip`), StatefulSet replication, and honest single-replica failover trade-offs |
| [PostgreSQL: Production Reference Architecture](/architectures/postgresql-ha/) | A 3-instance CloudNativePG cluster with quorum-synchronous replication, PgBouncer pooling, continuous S3 backup, and a restore drill |
| [IBM MQ: Production Reference Architecture](/architectures/ibm-mq/) | A Native HA queue manager (3 pods, Raft-replicated logs, no shared storage), TLS channels, external clients via a MetalLB VIP, and quorum-loss behavior |
| [RabbitMQ: Production Reference Architecture](/architectures/rabbitmq/) | A 3-node cluster with quorum queues, the memory-watermark-vs-container-limit handshake, AMQPS via MetalLB, and partition/alarm drills |
| [The Golden Service](/architectures/golden-service/) | The stateless flagship: a production Spring Boot service with every default consciously set — HPA, PDB, spread, probes, NetworkPolicy — numbers traceable to the Sizing Walkthrough |
| [Kafka: Production Reference Architecture (Strimzi)](/architectures/kafka-strimzi/) | A 3-broker KRaft cluster with the acks/min-ISR durability contract, rack awareness, per-broker external listeners, and the advertised-listener decoder |
| [The Bare-Metal Front Door](/architectures/front-door/) | The platform-side edge: MetalLB + ingress-nginx + cert-manager as one build — how HTTP traffic actually enters, end to end |

## The conventions every build follows

- **Images pinned** (tag at minimum, digest preferred) — see the [supply-chain article](/operations/supply-chain-security/) for why.
- **Guaranteed QoS** for stateful pods: requests = limits ([Resources and QoS](/workloads/resources-and-qos/)) — and every number is a measured starting point, tunable via [Knobs & Levers](/tuning/overview/).
- **Spread across failure domains** with anti-affinity or topology spread ([High Availability](/workloads/high-availability/)).
- **PDBs that match quorum reality** — never `maxUnavailable: 0`.
- **NetworkPolicies included** — stateful services are default-locked to their consumers ([Network Policies](/networking/network-policies/)).
- **External clients enter through a corporate VIP** on a network-team load-balancer appliance (F5, NetScaler), pooled to an in-cluster [MetalLB](/controllers/metallb/) service IP — every build shows both layers and the ticket that wires them together ([External Load Balancing](/networking/external-load-balancing/)).
- **Everything ships through your pipeline.** These manifests belong in git, not in a terminal history ([Drift and CI/CD](/operations/drift-and-cicd/)).

:::tip[Want another build?]
These builds cover the stateful patterns this site's audience asks about most. The same skeleton — overview, platform asks, annotated manifests, verification plan, failure modes — works for anything; steal it for your own team's runbooks.
:::
