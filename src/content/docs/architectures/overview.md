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
| [Zero-Downtime Deploys](/architectures/zero-downtime/) | The behavioral build: probes + PDB + preStop + surge assembled and *proven* with a load-generator harness — zero dropped requests through deploys, drains, and kills |
| [The Locked-Down Namespace](/architectures/locked-down-namespace/) | PSA restricted + default-deny NetworkPolicy + non-root read-only containers + least-privilege RBAC — with a real app working inside and every diagnostic path preserved |
| [Event-Driven Autoscaling with KEDA](/architectures/keda-autoscaling/) | Scaling consumers on queue depth/lag (Kafka, RabbitMQ, IBM MQ) with scale-to-zero and the drain-safe scale-in story |
| [Progressive Delivery](/architectures/progressive-delivery/) | Metric-gated canary with automatic rollback via Argo Rollouts — a bad version caught at 10% traffic by its own error rate |

## Which build do I need?

Start from the requirement, not the technology. Each row is the shortest honest answer to "I need X — which article?"

| I need… | Build | Why this one |
|---|---|---|
| An HA cache with a stable address | [Valkey: Shared VIP](/architectures/valkey-shared-vip/) | Read/write split over one VIP, and an honest account of what single-replica failover actually costs |
| A relational store that survives node loss | [PostgreSQL HA](/architectures/postgresql-ha/) | Quorum-synchronous replication means a confirmed commit exists on two nodes — plus a restore drill, because a backup you haven't restored is a hope |
| Ordered, transactional messaging — MQ is mandated | [IBM MQ](/architectures/ibm-mq/) | You run MQ because the mainframe or the vendor contract says so; this build makes Native HA survive what the mandate didn't anticipate |
| Ordered, transactional messaging — broker is my choice | [RabbitMQ](/architectures/rabbitmq/) | Quorum queues give the same delivery guarantees without the license; the discriminator with MQ is *who chose the protocol*, not features |
| Streaming with replay and consumer fan-out | [Kafka (Strimzi)](/architectures/kafka-strimzi/) | A log you can re-read is a different primitive than a queue you drain — acks/min-ISR is the durability contract spelled out |
| A stateless service done right, end to end | [The Golden Service](/architectures/golden-service/) | Every default that bites, consciously set — the template to clone for anything HTTP-shaped |
| Proof that deploys drop nothing | [Zero-Downtime Deploys](/architectures/zero-downtime/) | Probes + PDB + preStop + surge, *measured* under a load harness — the claim verified, not asserted |
| A security envelope apps can actually live in | [The Locked-Down Namespace](/architectures/locked-down-namespace/) | PSA restricted + default-deny + least-privilege RBAC with a real app running and every diagnostic path preserved |
| Scaling on queue depth, not CPU | [KEDA Autoscaling](/architectures/keda-autoscaling/) | CPU is a proxy; lag is the signal — includes scale-to-zero and the drain-safe scale-in |
| Bad versions caught before full rollout | [Progressive Delivery](/architectures/progressive-delivery/) | A canary at 10% traffic, judged by its own error rate, rolled back by a controller instead of a human at 3 a.m. |
| The cluster edge itself | [The Bare-Metal Front Door](/architectures/front-door/) | The platform-side build every other row assumes exists: MetalLB + ingress-nginx + cert-manager as one system |

## What each build costs in platform tickets

The manifests are the easy half. Each build below needs things only your platform (or network) team can grant — file these before you write any YAML, because operator installs and appliance changes move at ticket speed, not apply speed.

| Build | Platform tickets |
|---|---|
| Golden Service | Near zero: quota sized for maxReplicas + surge; prometheus-operator CRDs if you want the alert rules |
| Zero-Downtime Deploys | Zero — pure workload configuration; that's the point |
| Locked-Down Namespace | Namespace PSA labels (if you can't set them), plus whatever your admission-policy team owns |
| Valkey: Shared VIP | One MetalLB IP with `allow-shared-ip`; a StorageClass |
| PostgreSQL HA | CloudNativePG operator (cluster-scoped install), S3 bucket + credentials, a StorageClass with known fsync behavior |
| RabbitMQ | RabbitMQ cluster operator, one MetalLB IP for AMQPS, appliance pool change for external clients |
| IBM MQ | MQ operator *and* license entitlement, one MetalLB IP, appliance pool change, TLS cert issuance |
| Kafka (Strimzi) | Strimzi operator, **one MetalLB IP per broker** plus bootstrap — the biggest IP ask on this list — and appliance changes to match |
| KEDA Autoscaling | KEDA operator (cluster-scoped), plus credentials to read the queue/lag metrics |
| Progressive Delivery | Argo Rollouts operator, and a Prometheus the analysis can query |
| Front Door | This *is* the platform ticket: an IP range from the network team, the appliance VIP + pool, and PKI for cert-manager |

## Combine them

These builds compose. The trio most teams should ship first is **Golden Service + Zero-Downtime + Locked-Down Namespace**: the first is the service itself, the second proves its deploy behavior under load, the third is the envelope it runs inside — together they cost almost nothing in platform tickets and cover the failure modes that actually page you. Add Progressive Delivery once deploys are boring and you want bad versions caught earlier; add KEDA when a consumer's backlog, not its CPU, is the real signal. The stateful builds slot in as dependencies — the Golden Service's NetworkPolicy already assumes a Postgres namespace shaped like the [PostgreSQL HA](/architectures/postgresql-ha/) build.

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
