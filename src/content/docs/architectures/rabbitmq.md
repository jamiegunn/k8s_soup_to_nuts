---
title: "RabbitMQ: Production Reference Architecture"
description: A complete, copy-paste-deployable 3-node RabbitMQ cluster on the cluster-operator — quorum queues, the memory-watermark handshake, TLS over a MetalLB VIP, poison-message policies, alerts, and failure drills.
keywords:
  - RabbitMQ Cluster Operator RabbitmqCluster
  - quorum queues Raft
  - vm_memory_high_watermark publishers blocked
  - memory alarm producers hang silently
  - classic queue mirroring removed 4.x
  - pause_minority network partition
  - poison message delivery-limit dead-letter
  - AMQPS TLS over MetalLB VIP
  - Messaging Topology Operator policy
  - heartbeat below idle timeout
  - perf-test verification drill
sidebar:
  order: 8
---

This is the build article. The broker survey — when RabbitMQ is the right answer at all — lives at [Message Queues on Kubernetes](/stateful/message-queues/). Here we deploy one production cluster, `rmq`, using the official **RabbitMQ Cluster Operator** and its `RabbitmqCluster` CR: three nodes, **quorum queues as the default queue type**, per-node PVCs, TLS to off-cluster clients over a MetalLB VIP, and the management UI kept strictly internal. Every manifest is complete and applied in order.

:::note[Tuning the numbers]
Resource blocks and probe timings below are justified starting points, not gospel. The method for deriving your own is [Requests & Limits Knobs](/tuning/requests-limits-knobs/) and [Health Check Knobs](/tuning/health-check-knobs/).
:::

## Architecture

```text
                      off-cluster apps
                            │  AMQPS 5671 (TLS)
                            ▼
              corporate VIP  rabbitmq.example.internal :5671
              (network team's F5 / NetScaler appliance)
                            │  pools to the MetalLB IP
                            ▼
                  MetalLB VIP 10.20.0.41
                            │
        ┌───────────────────┼─────────────────────────────────┐
        │ namespace: rabbitmq-prod                            │
        │                   ▼                                 │
        │      Service rmq-external (LoadBalancer, 5671 only) │
        │      Service rmq          (ClusterIP)               │
        │          │ 5671/5672            ▲ 5672 in-cluster   │
        │          ▼                      │ apps              │
        │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ │
        │  │ rmq-server-0 │◄►│ rmq-server-1 │◄►│ rmq-server-2 │ │
        │  │ QQ leader(s) │ │ QQ follower  │ │ QQ follower  │ │
        │  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ │
        │         │ 25672/4369 clustering + Raft (pod-to-pod) │
        │      [PVC-0]          [PVC-1]          [PVC-2]      │
        │      zone-a           zone-b           zone-c       │
        └─────────────────────────────────────────────────────┘
          15672 (management UI) and 15692 (metrics): internal only
```

The shape, and why:

- **Three nodes, one Raft replica of every quorum queue per node.** A quorum queue is a Raft group: one leader, followers on the other nodes, a publish confirmed only once a **majority (2 of 3)** has it on disk. Any node can accept client connections; traffic to a queue whose leader lives elsewhere is routed inside the cluster.
- **Quorum queues are the default, not an option.** Classic queue *mirroring* — the old HA mechanism — was deprecated for years and is **removed in RabbitMQ 4.x**. There is no migration path that keeps mirrored queues; a classic queue in 4.x is a single-node queue that dies with its node. If you're designing HA today, quorum queues are the design, full stop.
- **Never 2 replicas.** Raft majority of 2 is 2 — both nodes must be up, so a 2-node cluster has *worse* availability than 1 node plus twice the failure surface. Three is the minimum that tolerates a failure; five only if you've measured a need.
- **Per-node RWO PVCs.** Raft replication is the durability story; no shared storage anywhere.
- **The management UI never leaves the cluster.** It's an admin API with credentials — `kubectl port-forward` for humans, nothing on the VIP but 5671.

## Prerequisites: platform asks

File the [platform team request](/operations/working-with-platform-team/) early — three items are cluster-scoped and not yours:

1. **RabbitMQ Cluster Operator installed** ([CRDs](/controllers/crds-explained/) + cluster-wide RBAC — the standard [operator split](/controllers/operators/)). Ask for a pinned operator version and, if you want queues/policies as CRs (section 5), the **Messaging Topology Operator** alongside it.
2. **StorageClass guidance.** Quorum queues fsync the Raft log on every confirmed publish — **p99 fsync latency is your p99 publish-confirm latency**. Ask: what does fsync actually cost on this class, and does the device lie about write barriers? You want RWO block storage, `allowVolumeExpansion: true`, `volumeBindingMode: WaitForFirstConsumer` so PVCs land in each pod's zone. Details: [Storage Controllers](/controllers/storage-controllers/).
3. **Optionally, a MetalLB IP** from a routable pool if off-cluster clients exist.

## The build

Everything lands in `rabbitmq-prod`:

```bash
kubectl create namespace rabbitmq-prod
```

### 1. Secrets: TLS and the default user

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: rmq-server-tls
  namespace: rabbitmq-prod
type: kubernetes.io/tls        # standard shape; the CR consumes it directly
data:
  tls.key: <base64 PEM key>
  tls.crt: <base64 PEM cert + chain>
  # SANs MUST cover: the VIP hostname (rabbitmq.example.internal),
  # rmq.rabbitmq-prod.svc, and *.rmq-nodes.rabbitmq-prod.svc — clients
  # verify whichever name they dialed.
---
apiVersion: v1
kind: Secret
metadata:
  name: rmq-default-user
  namespace: rabbitmq-prod
type: Opaque
stringData:
  username: rmq-admin
  password: <generated, 32+ chars>   # from your secret store, never literal in git
```

Left alone, the operator generates a random default user in `rmq-default-user`. Providing your own (wired in via `secretBackend` below) means the credential comes from *your* rotation machinery instead of a one-time random value nobody owns. Hygiene rules: [Secrets](/workloads/secrets/). Per-application users come later as definitions/CRs — apps never share the admin user.

### 2. The RabbitmqCluster CR

This one resource is the cluster: the operator renders the StatefulSet, per-pod PVCs, Services, Erlang cookie, and peer discovery from it.

```yaml
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqCluster
metadata:
  name: rmq
  namespace: rabbitmq-prod
spec:
  replicas: 3                  # quorum math: 3 tolerates 1 loss. NEVER 2 —
                               # majority-of-2 is 2, so a 2-node cluster is
                               # strictly worse than 1 node.
  image: rabbitmq:4.1.2-management   # PIN it. A floating tag on a Raft-based
                                     # quorum system is a self-inflicted incident.
  resources:                   # requests == limits => Guaranteed QoS. A broker
    requests: { cpu: "2", memory: 4Gi }   # that gets evicted under node pressure
    limits:   { cpu: "2", memory: 4Gi }   # is a surprise leader election; see
                                          # /tuning/requests-limits-knobs/ for the
                                          # reasoning chain behind these numbers.
  persistence:
    storageClassName: fast-ssd # the fsync conversation from prerequisites
    storage: 50Gi              # quorum queues page message bodies to disk under
                               # memory pressure — size for your worst backlog,
                               # not your average depth
  tls:
    secretName: rmq-server-tls # enables AMQPS on 5671; 5672 stays for in-cluster
  secretBackend:
    externalSecret:
      name: rmq-default-user   # our secret from step 1, not an operator-generated one
  rabbitmq:
    additionalConfig: |
      # --- the two-watermark handshake (see below) ---
      total_memory_available_override_value = 4294967296
      vm_memory_high_watermark.relative = 0.6

      # Disk alarm well above the default 50MB joke value. Rule of thumb:
      # at least 1.5-2x the memory limit, because paging under memory
      # pressure needs somewhere to land.
      disk_free_limit.absolute = 8GB

      # Every queue declared without an explicit type is a quorum queue.
      # Belt-and-suspenders with the x-queue-type argument apps set (section 5).
      default_queue_type = quorum

      # AMQP heartbeat: one frame each direction per interval. MUST be below
      # any LB/firewall idle timeout on the client path or idle connections
      # get silently severed — see /networking/long-lived-connections/.
      heartbeat = 30

      # Operator default, pinned explicitly so nobody "simplifies" it away:
      # on partition, the MINORITY side pauses (stops serving) rather than
      # diverging. Matches Raft semantics; never set autoheal for quorum queues.
      cluster_partition_handling = pause_minority
  affinity:
    podAntiAffinity:           # required (not preferred): two brokers on one
      requiredDuringSchedulingIgnoredDuringExecution:   # node turns one node
        - topologyKey: kubernetes.io/hostname           # failure into quorum loss
          labelSelector:
            matchLabels: { app.kubernetes.io/name: rmq }
  override:
    statefulSet:
      spec:
        template:
          spec:
            topologySpreadConstraints:   # one broker per zone: a zone outage
              - maxSkew: 1               # leaves 2 of 3 — still quorate
                topologyKey: topology.kubernetes.io/zone
                whenUnsatisfiable: DoNotSchedule
                labelSelector:
                  matchLabels: { app.kubernetes.io/name: rmq }
```

**The two-watermark handshake, spelled out.** This is RabbitMQ's version of the JVM heap-inside-a-container budget. Two independent enforcers watch the same memory:

1. **Kubernetes**: at 4Gi of RSS, the OOM killer terminates the container. No warning, no drain, instant leader elections.
2. **RabbitMQ**: at `vm_memory_high_watermark`, the broker raises a **memory alarm** and *blocks publishers* — a graceful backpressure valve, while consumers keep draining.

The valve only works if it triggers **below** the kill line. Inside a container RabbitMQ can misread the host's `/proc/meminfo` as "available memory", so we pin `total_memory_available_override_value` to exactly the container limit (4Gi = 4294967296), then set the watermark at 0.6 → alarm at ~2.4Gi. The ~1.6Gi of headroom is not waste: it absorbs Erlang allocator overhead, GC transients, and the burst between "watermark crossed" and "publishers actually throttled". Squeeze the gap (0.8+) and you'll meet the OOM killer before the alarm — the failure-modes table covers what each looks like.

### 3. Probes: what the operator sets and what to tune

The operator's default **readiness probe is a plain TCP check on 5672** — cheap, and correct: "accepting AMQP connections" is precisely what the Services should route on. Resist upgrading it to `rabbitmq-diagnostics check_port_connectivity` or even `ping`: every `rabbitmq-diagnostics` invocation boots a short-lived Erlang node and does a distribution handshake — real CPU, every `periodSeconds`, times three pods, forever. Save the diagnostics commands for humans and drills; keep the probe a socket.

If you tune timings, do it through the same override block:

```yaml
  # inside spec.override.statefulSet.spec.template.spec:
            containers:
              - name: rabbitmq
                readinessProbe:
                  tcpSocket: { port: 5672 }
                  initialDelaySeconds: 10
                  periodSeconds: 10
                  timeoutSeconds: 5
                  failureThreshold: 3    # 30s of failure before ejection from
                                         # Services — a broker mid-GC-pause should
                                         # not be dropped from the LB. Method:
                                         # /tuning/health-check-knobs/
```

There is deliberately **no liveness probe**: a node replaying a large Raft log on boot can be unready for minutes, and a liveness probe that kills it mid-replay creates a crash loop that never catches up. [Health Check Knobs](/tuning/health-check-knobs/) covers that failure pattern in general form.

### 4. PodDisruptionBudget

The cluster operator does **not** create a PDB — apply it yourself, and make it match quorum reality:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: rmq-pdb
  namespace: rabbitmq-prod
spec:
  maxUnavailable: 1            # NOT minAvailable: 1 — that permits evicting 2
                               # pods, which is quorum loss for every queue
  selector:
    matchLabels: { app.kubernetes.io/name: rmq }
```

Node drains are how quorum systems actually die in practice — the full argument is in [High Availability](/workloads/high-availability/).

### 5. Queues and policies as code

Two legitimate approaches; pick one and be consistent:

- **App-declared** (most common): applications declare their queues at startup with `x-queue-type: quorum` in the declare arguments. Idempotent, versioned with the app. The `default_queue_type = quorum` above is the safety net for the app that forgets.
- **Definitions as code**: a `definitions.json` (vhosts, users, permissions, policies) imported at boot via `load_definitions`, or — cleaner — the **Messaging Topology Operator's** `Queue`/`Policy`/`Vhost`/`User` CRs, reconciled continuously instead of load-once.

Either way, **this policy is not optional**:

```yaml
apiVersion: rabbitmq.com/v1beta1
kind: Policy                       # Messaging Topology Operator CR
metadata:
  name: qq-poison-protection
  namespace: rabbitmq-prod
spec:
  name: qq-poison-protection
  vhost: "/"
  pattern: ".*"                    # every queue in the vhost
  applyTo: quorum_queues
  definition:
    delivery-limit: 6              # after 6 failed deliveries, stop retrying
    dead-letter-exchange: dlx      # ...and route the poison message here
    dead-letter-routing-key: poison
  rabbitmqClusterReference: { name: rmq }
```

Why this matters: a quorum queue **without a delivery limit redelivers a rejected message forever** (RabbitMQ 4.x finally defaults the limit to 20, but only for newly declared queues — set it explicitly and choose your own number). One consumer that crashes on one malformed message becomes an infinite hot loop: redeliver, crash, redeliver, at full CPU, while the queue backs up behind the poison pill. The delivery limit plus dead-letter exchange turns that into "six tries, then parked on `dlx` where an alert sees it." Declare the `dlx` exchange and its `poison` quorum queue the same way you declare everything else.

One thing you *don't* need: lazy mode. Classic queues needed `x-queue-mode: lazy` to avoid drowning in RAM under backlog; **quorum queues page to disk naturally** as memory tightens. That's also why the disk alarm and PVC sizing above are load-bearing.

### 6. External access: AMQPS on the VIP

Off-cluster clients arrive through **two layers**: a corporate VIP on the network team's appliance, pooled to a [MetalLB](/controllers/metallb/) service IP in-cluster — raw [TCP ingress](/networking/tcp-ingress/) at both hops, no HTTP anything. The in-cluster half:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: rmq-external
  namespace: rabbitmq-prod
  annotations:
    metallb.io/address-pool: prod-services
    metallb.io/allow-shared-ip: "mq-shared-vip"  # optional: share one VIP with
                                                 # other TCP services on other ports
spec:
  type: LoadBalancer
  loadBalancerIP: 10.20.0.41     # or let the pool assign; pin it if firewalls care
  externalTrafficPolicy: Local   # the source IP that survives is the corporate
                                 # appliance's SNAT address (see below) — still
                                 # useful: it pins 5671 to the appliance
  selector:
    app.kubernetes.io/name: rmq  # all 3 ready pods — any node accepts connections;
                                 # the cluster routes to queue leaders internally
  ports:
    - { name: amqps, port: 5671, targetPort: 5671 }
    # 5671 ONLY. 15672 (management) on a VIP is an admin API on the network —
    # port-forward for humans, never expose it.
```

**The corporate VIP in front.** Clients never dial `10.20.0.41` — they dial `rabbitmq.example.internal`, a corporate VIP on the network team's load-balancer appliance (F5 BIG-IP, NetScaler), which pools to the MetalLB IP. Chain: client → corporate VIP (appliance) → MetalLB IP `:5671` → any ready broker. Ownership split: the **network team** owns the appliance, the VIP, and DNS; the **platform team** owns MetalLB and its pools; **you** own the Service and the brokers. The general topology is [External Load Balancing](/networking/external-load-balancing/). The RabbitMQ-specific details:

- **The pool member is the MetalLB IP `:5671`** — not NodePorts, not pod IPs. The appliance health-checks that address; ask for a plain **TCP monitor** (an AMQP-aware monitor opens and abandons a handshake every probe interval, which shows up as connection churn in broker logs — the TCP readiness probes behind the Service already gate which brokers answer).
- **TLS: passthrough.** The AMQPS certificate lives in `rmq-server-tls` with the broker — that's why its SANs cover `rabbitmq.example.internal`, the name clients actually verify. Terminating or re-encrypting at the appliance buys nothing and splits certificate ownership. If the network team runs BIG-IP with [F5 CIS](/controllers/f5-cis/), the VIP, pool, and monitor can be declared from cluster manifests instead of by ticket.
- **The appliance SNATs**, so broker logs and the management UI show the appliance's self-IP for every external connection. RabbitMQ is one of the few stateful services that *can* recover real client IPs via PROXY protocol (`proxy_protocol = true`) — but only if the appliance sends it, and the setting is global to the AMQP listeners, so your in-cluster 5672 clients would have to send the header too. Both ends agree or neither; most shops just accept losing external client IPs.
- **The appliance idle timeout is the strictest timer on the path.** The `heartbeat = 30` in the CR and the matching client setting must stay below it (and below conntrack) — [Long-Lived Connections](/networking/long-lived-connections/) is the full story.

The ticket that stands all of this up:

> **To the network team:** please create VIP `rabbitmq.example.internal`, TCP **5671**, pool = **one member: 10.20.0.41:5671** (our cluster's MetalLB service IP). Monitor: **TCP** on 5671 against that address. Idle timeout: ≥ 90 s and tell us the configured value — AMQP heartbeats flow every 30 s and dead-peer detection takes ~60 s, both must clear it. Persistence: none needed (single member). TLS: **passthrough** — the AMQPS certificate lives with the broker; no termination or re-encryption.

Client URIs use the **corporate VIP's DNS name** and carry the heartbeat and TLS explicitly; automatic recovery is a **client-library setting**, not a server one — turn it on:

```text
amqps://orders-app:s3cret@rabbitmq.example.internal:5671/%2f?heartbeat=30
```

```java
// Java client — the settings that make failover a stall instead of an exception
factory.setAutomaticRecoveryEnabled(true);   // reconnect + re-open channels
factory.setTopologyRecoveryEnabled(true);    // re-declare queues/consumers
factory.setNetworkRecoveryInterval(5000);    // add jitter in your own wrapper
factory.setRequestedHeartbeat(30);           // match the server; below LB idle timeout
```

Heartbeat 30 means dead peers are detected in ~60s (two missed intervals) and the connection never looks idle to any middlebox on the path — the corporate appliance included, whose timer is usually the one that bites first. The physics of why: [Long-Lived Connections](/networking/long-lived-connections/).

### 7. NetworkPolicy

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: rmq-policy
  namespace: rabbitmq-prod
spec:
  podSelector:
    matchLabels: { app.kubernetes.io/name: rmq }
  policyTypes: [Ingress]
  ingress:
    - from:                                       # app namespaces -> AMQP(S)
        - namespaceSelector:
            matchLabels: { rabbitmq-client: "true" }
      ports:
        - { port: 5672, protocol: TCP }
        - { port: 5671, protocol: TCP }
    - from:                                       # off-cluster via VIP -> AMQPS only
        - ipBlock: { cidr: 10.30.0.0/16 }         # your external client range
      ports:
        - { port: 5671, protocol: TCP }
    - from:                                       # clustering + Raft: STRICTLY
        - podSelector:                            # pod-to-pod. Nothing else ever
            matchLabels: { app.kubernetes.io/name: rmq }   # speaks 25672/4369.
      ports:
        - { port: 25672, protocol: TCP }          # inter-node distribution
        - { port: 4369, protocol: TCP }           # epmd peer discovery
    - from:                                       # metrics -> monitoring only
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: monitoring }
      ports:
        - { port: 15692, protocol: TCP }
```

Note what's absent: no rule for 15672 at all — management UI access is `kubectl port-forward svc/rmq 15672` for the humans who need it. Whether `ipBlock` sees real client IPs depends on `externalTrafficPolicy` and your CNI — and behind the corporate appliance, external connections arrive from the appliance's SNAT self-IPs, so the block can often be tightened to just that range. Verify, don't assume: [Network Policies](/networking/network-policies/).

### 8. Monitoring and the alerts that matter

The `rabbitmq_prometheus` plugin is enabled by default in operator-managed clusters — scrape **15692**. Aggregated metrics are cheap; per-queue detail comes from `/metrics/detailed?family=queue_coarse_metrics` (scrape it less often). Confirm metric names against your endpoint before paging anyone; wiring and routing live in [Alerting](/observability/alerting/).

```promql
# Memory alarm active — publishers are being blocked RIGHT NOW
rabbitmq_alarms_memory_used_watermark == 1

# Disk alarm active — same blocking behavior, storage cause
rabbitmq_alarms_free_disk_space_watermark == 1

# A broker node is missing — every quorum queue is one failure from read-only
count(rabbitmq_build_info) < 3

# Unroutable messages being dropped: a binding/routing-key bug, silent data loss
increase(rabbitmq_global_messages_unroutable_dropped_total[5m]) > 0

# Queue depth growing while consumers exist = consumers falling behind
sum(rabbitmq_queue_messages) - sum(rabbitmq_queue_messages offset 15m) > 10000

# File descriptors: each connection+queue segment costs FDs; exhaustion = refusals
rabbitmq_process_open_fds / rabbitmq_process_max_fds > 0.85
```

For "quorum queue with fewer than 2 online members," the aggregated endpoint won't tell you per-queue — alert on node count (above) as the proxy, and make `rabbitmq-queues check_if_node_is_quorum_critical` part of your pre-drain checklist: it answers "would taking *this* node down leave some queue without a majority?"

## Verification plan

**1. Cluster formed.**

```console
$ kubectl exec -n rabbitmq-prod rmq-server-0 -- rabbitmq-diagnostics cluster_status --formatter=erlang | grep -A4 running_nodes
{running_nodes,['rabbit@rmq-server-0.rmq-nodes.rabbitmq-prod',
                'rabbit@rmq-server-1.rmq-nodes.rabbitmq-prod',
                'rabbit@rmq-server-2.rmq-nodes.rabbitmq-prod']}
```

Three running nodes and no partitions listed, or stop and fix (usually 25672/4369 blocked by a policy, or PVCs unbound).

**2. Publish/consume through the VIP, with TLS, against a quorum queue.** One Job proves VIP routing, the TLS handshake, auth, and quorum-queue confirms — the four independent failure points:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: rmq-perf-verify
  namespace: rabbitmq-prod
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: perf-test
          image: pivotalrabbitmq/perf-test:2.20.0   # pin it — check the perf-test releases page for current
          args:
            - --uri
            - amqps://rmq-admin:<password>@rabbitmq.example.internal:5671/%2f
            - --quorum-queue
            - --queue
            - verify.qq
            - --producers
            - "2"
            - --consumers
            - "2"
            - --rate
            - "500"
            - --time
            - "60"
            - --flag
            - persistent                          # confirmed, quorum-committed publishes
```

Expect a steady `sent/received ~1000 msg/s` summary and, critically, **consumer latency in low milliseconds** — that number is your fsync-latency conversation with the platform team, measured.

**3. Kill-a-node drill.** Start perf-test as above but for 10 minutes, then `kubectl delete pod rmq-server-0`. Watch `rabbitmq-queues -n rabbit@... quorum_status verify.qq` from another pod: a follower is promoted to leader within a few seconds. Clients connected to the dead node see a connection drop and reconnect (that's the library setting from section 6); clients on surviving nodes see at most a brief publish-confirm stall. The returning pod rejoins and its Raft logs catch up — depth on the queue never lies about it.

**4. Memory-alarm drill (the one that saves a 3 a.m. mystery).** Run perf-test with `--producers 10 --consumers 0` until `rabbitmq_alarms_memory_used_watermark` fires. What you'll see: **publishers hang mid-publish — no error, no exception, throughput to zero** — while a separately started consumer drains normally. This is by design: the alarm applies TCP backpressure to publishing connections only. Burn this into the team's memory now, because "our producer threads are all stuck and nothing is thrown" does not look like a broker memory problem from the app side. Delete the backlog queue; publishers resume by themselves.

**5. Rolling upgrade.** Bump `spec.image` to the next pinned patch. The operator rolls the StatefulSet one pod at a time, highest ordinal first, waiting for readiness between — each restart is one Raft-follower catch-up, never a quorum loss. Verify `cluster_status` and alarm metrics after.

**6. Drain test.** `kubectl drain <node-with-rmq-server-1> --ignore-daemonsets --delete-emptydir-data`. The PDB serializes the eviction; run `rabbitmq-queues check_if_node_is_quorum_critical` first like your runbook says. If the drain hangs because another broker pod is unready, that is the PDB doing its job — do not `--disable-eviction` your way past it.

## Failure modes

| Failure | Behavior | Impact and recovery |
|---|---|---|
| One node lost | Quorum queues elect new leaders in seconds; cluster quorate at 2/3 | Degraded, fully functional — but one more failure from read-only. Fix now, calmly. Connected clients of the dead node reconnect; others barely notice |
| Two nodes lost | Every quorum queue loses majority: **publishes unconfirmed/rejected, consumption stops**; surviving node still accepts connections, which confuses people | No majority = no writes, by design. Recover any second node and queues resume automatically. Never force-delete quorum members to "fix" it |
| Memory alarm | Publishers **blocked silently** (TCP backpressure, no error); consumers unaffected | The "producers hang" mystery. Check `rabbitmq_alarms_memory_used_watermark`, find the backlog queue, drain or purge it. If chronic: more memory or fewer unconsumed messages |
| Disk alarm | Same publisher blocking, `free_disk_space_watermark` cause | Expand the PVC (needs `allowVolumeExpansion`) or purge. The 8GB floor exists so paging under memory pressure doesn't hit a full disk |
| Network partition | `pause_minority` (operator default, pinned in our CR): minority side pauses entirely; majority keeps serving | Clients on the minority side reconnect (through the Service) to majority nodes. Partition heals → paused nodes rejoin automatically. Do not switch to `autoheal`; it can discard writes |
| PVC full (no alarm headroom) | Node crashes or wedges mid-write; Raft peers keep the queue alive at 2/3 | Expand the PVC, restart the pod, let Raft catch up. Alert at 80% disk so this row stays theoretical |
| Client storm after failover | Thousands of clients reconnect simultaneously; connection churn spikes CPU, slows recovery for everyone | Reconnect **with jitter** is part of the client contract from [Message Queues on Kubernetes](/stateful/message-queues/) — randomized backoff in the app's recovery wrapper, not a thundering herd at exactly 5.000s |

## Sizing and day-2

Replicas stay at **3** across tiers — you scale a RabbitMQ cluster up (resources) or out (more clusters), not to more Raft members.

| Tier | CPU / memory per pod | PVC | Fits |
|---|---|---|---|
| Small | 1 / 2Gi (watermark override 2147483648) | 20Gi | ~200 connections, low-thousands msg/s |
| Medium (this build) | 2 / 4Gi | 50Gi | ~2k connections, steady production domains |
| Large | 4 / 8–16Gi | 100–500Gi | ~10k connections, heavy persistent throughput — benchmark fsync first |

Remember the handshake: whenever the memory limit changes, `total_memory_available_override_value` changes with it, or your watermark is computed against a stale number.

**Vhosts and users as code.** One vhost per application domain, one low-privilege user per app, both as Topology Operator CRs (or definitions.json) — never hand-created in the UI, which is exactly the config that evaporates on rebuild.

**Classic → quorum migration.** Queue type is fixed at declaration; you cannot policy a classic queue into a quorum queue. The migration is: declare the new quorum queue, move bindings, drain the old (shovel or consumer), delete it. Do this *before* a 4.x upgrade for anything that was mirrored — 4.x won't carry mirrors for you.

**Version upgrades: the feature-flags step.** After every upgrade stabilizes, run `rabbitmqctl enable_feature_flag all`. Skipping it is the classic trap: everything works for months, then the *next* upgrade refuses to start because required flags from the previous version were never enabled. Make it a post-upgrade checklist line, not tribal knowledge.

**When to shard to multiple clusters.** RabbitMQ clusters don't scale gracefully past a handful of nodes — quorum queues cap at their replica count and inter-node chatter grows. When one cluster's resources max out, split by domain (orders-rmq, telemetry-rmq) exactly like the per-domain scoping argument in [Message Queues on Kubernetes](/stateful/message-queues/): smaller blast radius, independent upgrade windows, and each cluster stays a boring 3-node build like this one.
