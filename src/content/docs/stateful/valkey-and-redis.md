---
title: Valkey and Redis
description: Running Valkey (the open-source Redis fork) on Kubernetes — persistence tradeoffs, Sentinel and Cluster topologies, and the memory-limit math that prevents OOM kills.
keywords:
  - maxmemory oomkilled
  - cache vs store
  - rdb aof persistence
  - sentinel failover promotion
  - cluster mode sharding slots
  - allkeys-lru eviction policy
  - moved redirect cluster-aware client
  - fork copy-on-write memory spike
  - bitnami licensing broadcom
  - ot-container-kit operator
  - appendfsync everysec
  - terminationgraceperiodseconds graceful shutdown
sidebar:
  order: 4
---

Valkey is the Linux Foundation fork of Redis, created in 2024 when Redis moved off open-source licensing. It's drop-in compatible (protocol, commands, `redis-cli` works fine against it), actively developed, and what you should default to for new deployments unless you have a Redis Enterprise contract. Everything below applies to both; we'll say Valkey and mean either.

:::tip[Complete build available]
Want the finished thing instead of the theory? [Valkey: Two StatefulSets, One MetalLB VIP](/architectures/valkey-shared-vip/) is a copy-paste reference architecture — read/write split over one shared VIP, with verification and failure drills.
:::

## First question: is it a cache or a store?

This decides everything about how you deploy it.

**It's a cache** — data is rebuildable from a source of truth, a cold start means slow requests, not data loss. Then you don't need a StatefulSet, persistence, or maybe even a PVC. A plain Deployment is simpler and rolls faster:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cache
spec:
  replicas: 1
  strategy:
    type: Recreate        # only one writer to nothing, but avoids double-memory during rollout
  selector:
    matchLabels: { app: cache }
  template:
    metadata:
      labels: { app: cache }
    spec:
      containers:
        - name: valkey
          image: valkey/valkey:8.0
          args:
            - "--maxmemory"
            - "1gb"
            - "--maxmemory-policy"
            - "allkeys-lru"
            - "--save"
            - ""                # no RDB snapshots
            - "--appendonly"
            - "no"              # no AOF
          resources:
            requests: { cpu: 250m, memory: 1536Mi }
            limits:   { memory: 1536Mi }
```

Restart = empty cache = your app repopulates it. Done. Don't build a Sentinel topology to protect data you can regenerate.

**It's a store** — sessions you can't drop, queues, dedup sets, anything where a restart losing data causes incidents. Now you need persistence and a StatefulSet, and you should honestly ask whether you need Valkey HA at all or whether the data belongs in [PostgreSQL](/stateful/postgresql/).

## Persistence: RDB vs AOF

- **RDB** — point-in-time snapshots (`save 900 1` etc.). Compact, fast restarts, but you lose everything since the last snapshot. Crash-consistent at best.
- **AOF** — append-only log of every write, fsynced per `appendfsync` (`everysec` is the sane default: at most ~1s of loss). Bigger files, slower restart (log replay), much smaller loss window.
- **Both** (common for stores): AOF for durability, RDB for fast full copies.

Either way, `/data` must be a PVC — see [Storage: PV, PVC, StorageClass](/stateful/storage-pv-pvc/) — or your "persistence" evaporates with the pod.

## The memory math that prevents OOMKilled

This is the number-one Valkey-on-k8s incident. Three numbers interact:

1. `maxmemory` — where Valkey starts evicting (or refusing writes).
2. Container memory **limit** — where the kernel kills the process.
3. **Fork overhead** — RDB saves and AOF rewrites `fork()` the process; copy-on-write means memory usage can grow substantially during the save, in the worst case approaching 2× under heavy write load.

If `maxmemory` ≈ limit, the first background save under write pressure gets you OOM-killed — and on restart, the AOF replay itself can spike past the limit, giving you a crash loop. Rule of thumb:

```text
container limit ≥ maxmemory × 1.5   (persistence enabled, moderate writes)
container limit ≥ maxmemory × 1.2   (pure cache, no persistence)
```

Set `maxmemory` **explicitly, always**. Without it, Valkey grows until the container limit and gets OOM-killed instead of evicting — the kernel's SIGKILL versus a graceful `allkeys-lru`. Pick the eviction policy consciously: `allkeys-lru` for caches, `noeviction` for stores (writes fail loudly instead of data silently vanishing). If you do get killed, [OOMKilled](/troubleshooting/oomkilled/) covers the forensics.

Verify the live numbers whenever memory behavior looks odd:

```console
$ kubectl exec cache-7f6d9c5b8-x2kqp -- valkey-cli info memory | grep -E 'used_memory_human|maxmemory_human|maxmemory_policy|mem_fragmentation'
used_memory_human:812.44M
maxmemory_human:1.00G
maxmemory_policy:allkeys-lru
mem_fragmentation_ratio:1.31
```

A fragmentation ratio well above ~1.5 means the RSS the kernel sees (and kills on) is much larger than `used_memory` — another reason the headroom multiplier is not optional.

## Probes

Readiness with the CLI is the standard pattern:

```yaml
readinessProbe:
  exec:
    command: ["valkey-cli", "ping"]   # redis-cli in Redis images
  periodSeconds: 5
livenessProbe:
  exec:
    command: ["valkey-cli", "ping"]
  initialDelaySeconds: 30    # AOF replay on big datasets takes time
  periodSeconds: 10
  failureThreshold: 6
```

Two subtleties: with `requirepass`, PING unauthenticated still returns an error string, so use `valkey-cli -a "$PASS" ping` (or a HELLO-based script) — test what your probe actually returns. And a replica that's still syncing answers PING but serves stale data; for replicas behind a Service, a stricter readiness check inspects `role:` and `master_link_status:up` in `INFO replication`.

## Sentinel: HA for single-master

Sentinel is the classic HA topology: one master, N replicas, and 3+ sentinel processes that detect master failure and orchestrate promotion. Clients ask Sentinel "who is master right now?" — which means **clients must be Sentinel-aware** (Lettuce, Jedis, ioredis all support it). A plain `Service` pointing at all pods does *not* work: it would route writes to replicas.

Hand-rolling Sentinel manifests is a rite of passage nobody enjoys — three StatefulSets or a sidecar pattern, announce-ip config so Sentinel advertises reachable addresses, careful shutdown ordering. This is operator territory (below). With the OT-Container-Kit operator installed, the whole topology is one CR pair — a `RedisReplication`/`ValkeyReplication` for the data nodes and a `RedisSentinel` pointing at it:

```yaml
apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: RedisSentinel
metadata:
  name: cache-sentinel
spec:
  clusterSize: 3
  redisSentinelConfig:
    redisReplicationName: cache
    masterGroupName: mymaster
    quorum: "2"
```

Your client config then names the sentinels' Service and `mymaster`, not any data pod directly — that indirection *is* the failover mechanism.

## Cluster mode: sharding, not just HA

Valkey/Redis Cluster shards the keyspace across 16384 slots over multiple masters (each with replicas). Use it when the dataset doesn't fit one node's memory or one node's write throughput.

The catch that surprises teams: **clients must be cluster-aware**. Any key can live on any shard; a cluster node answers requests for keys it doesn't own with `MOVED 3999 10.42.1.7:6379` and expects the client to follow. Non-cluster clients just see errors. Also: multi-key operations (`MGET`, transactions, Lua) only work when all keys hash to the same slot — you'll be introducing `{hashtags}` into key names. Don't take on cluster mode for HA alone; Sentinel is simpler if one node's capacity is enough.

## Operators and charts

Realistic options, in order of how often they're the right call:

- **valkey-operator / redis-operator (OT-Container-Kit)** — CRs for standalone, replication+sentinel, and cluster topologies. Actively maintained; the mainstream choice for operator-managed Valkey.
- **Bitnami charts caveat**: the long-standard `bitnami/redis` and `bitnami/valkey` charts got caught in Broadcom's 2025 licensing shift — freely available images moved to `bitnamilegacy` (unmaintained) with the maintained catalog going commercial. Pin digests, mirror what you depend on into your own registry, and don't base new production deployments on "Bitnami is free forever."
- **Upstream `valkey/valkey` image + your own manifests** — completely fine for standalone instances; that's what the examples here use.

Remember the constraint: an operator's [CRDs](/controllers/crds-explained/) are a cluster-scoped install — **platform team request** — after which you create the namespaced CRs yourself. [Operators for State](/stateful/operators-for-state/) covers that workflow.

:::tip[The decision table]
| Situation | Deploy as |
|---|---|
| Rebuildable cache | Deployment, no persistence, `allkeys-lru` |
| Small store, brief downtime OK | StatefulSet ×1, AOF, PVC, good backups |
| Store, no downtime tolerated | Operator-managed Sentinel topology |
| Dataset > one node's RAM | Cluster mode (operator), cluster-aware clients |

:::

## Graceful shutdown

Valkey traps SIGTERM and, with persistence enabled, performs a final save before exiting. Give it room: `terminationGracePeriodSeconds: 60` or more for large datasets, or a kubelet-delivered SIGKILL mid-save leaves you restarting from the previous snapshot. If you run replicas, a `PodDisruptionBudget` (`minAvailable: 1` at minimum) keeps a node drain from taking master and replica out together — more on drain behavior in [High Availability](/workloads/high-availability/).
