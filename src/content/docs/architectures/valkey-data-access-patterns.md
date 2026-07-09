---
title: "Valkey Data Access: Commands, Read/Write Split, and Cluster Semantics"
description: How clients actually talk to Valkey verb by verb — reads vs writes, replica staleness, pub/sub, streams, transactions, and the CROSSSLOT and MOVED rules cluster mode adds.
keywords:
  - READONLY you can't write against a read only replica
  - CROSSSLOT keys don't hash to the same slot
  - sharded pubsub SSUBSCRIBE SPUBLISH
  - stale reads from a replica
  - MOVED redirect cluster-aware client
  - WAIT numreplicas durability barrier
  - OOM command not allowed maxmemory noeviction
  - hashtag co-locate keys same slot
  - XREADGROUP consumer group stuck messages
  - keyspace notifications expired event
  - replica-serve-stale-data
  - READONLY READWRITE cluster replica reads
sidebar:
  order: 5
---

The parent of this page is the [Valkey Helm Chart Deep Dive](/architectures/valkey-helm-deep-dive/) — that page packages the *server*: the StatefulSets, the config surfaces, the storage, the topologies. This page is its **command/verb companion**: how your clients actually talk to that server, one verb at a time, and how every choice you make about a command interacts with the topology the platform team handed you. The Helm page decides *where the bytes live*; this page decides *what happens when you send `SET`, `XREADGROUP`, or `SSUBSCRIBE` at them*.

If you own the apps and not the cluster, this is the page that keeps you out of the two most common Valkey incidents an app team causes itself: writing to a read-only replica and being surprised by the error, and issuing a multi-key command in cluster mode that hard-fails with `CROSSSLOT`. Neither is a platform bug. Both are the topology telling you the truth about your command.

For the fundamentals underneath all of this — cache-vs-store, persistence, the memory math — read [Valkey and Redis on Kubernetes](/stateful/valkey-and-redis/) first; it's the authoritative source and this page won't repeat it. And for *how the connection physically reaches the cluster* (VIPs, TCP routing, `cluster-announce`), that's the sibling page [Valkey Ingress: VIPs, TCP Routing, and cluster-announce](/architectures/valkey-ingress-and-cluster-announce/) — this page stays strictly on commands and semantics.

## 1. The mental model: every command is a read or a write

Hold one idea in your head and most of the surprises disappear. **A Valkey command is either a READ or a WRITE**, and the *topology* decides where that command is allowed to run. That's it. `GET` is a read. `SET` is a write. `INCR` is a write (it reads *and* writes, so it counts as a write). The command's category plus your topology tells you which pod may serve it.

```text
 PRIMARY / REPLICA topology
 ─────────────────────────
   client ── WRITE (SET, INCR, XADD, DEL) ─────────────► PRIMARY  (:6379)
        │
        └── READ (GET, MGET, XRANGE, ZRANGE) ──► PRIMARY  (read-after-write)
                                               └► REPLICA (:6380, tolerant/stale reads)

 CLUSTER topology (16384 hash slots)
 ───────────────────────────────────
   client ── any command for key K ─► slot = CRC16(K) mod 16384
                                     └► the SHARD that OWNS that slot
                                        (writes → that shard's primary;
                                         reads  → its primary, or its replica
                                                  IF the client sent READONLY)
```

In primary/replica the split is by **verb**: writes must land on the primary, reads may go either way. In cluster mode there's a *second* axis on top of that: the **key** decides which shard, before the verb decides which pod within that shard. Everything below is a consequence of these two diagrams.

## 2. Strings and the basic verbs

Strings are the workhorse type. Here are the verbs you'll use daily, run against a real instance so you can see the responses. Assume `valkey-cli` is already authenticated (`REDISCLI_AUTH` set, as in the [raw build](/architectures/valkey-shared-vip/#3c-statefulset-valkey-primary)).

```console
127.0.0.1:6379> SET session:42 "alice" EX 300
OK
127.0.0.1:6379> GET session:42
"alice"
127.0.0.1:6379> TTL session:42
(integer) 297
127.0.0.1:6379> SET session:42 "bob" NX
(nil)                          # NX = only if absent; key exists, so no-op
127.0.0.1:6379> SET lock:job1 "held" NX PX 5000
OK                             # NX + PX 5000 = classic 5-second lock
127.0.0.1:6379> INCR page:views
(integer) 1
127.0.0.1:6379> INCRBY page:views 9
(integer) 10
127.0.0.1:6379> APPEND log:line "hello "
(integer) 6
127.0.0.1:6379> MSET a 1 b 2 c 3
OK
127.0.0.1:6379> MGET a b c
1) "1"
2) "2"
3) "3"
127.0.0.1:6379> PERSIST session:42
(integer) 1                    # removes the TTL; key is now durable-until-deleted
127.0.0.1:6379> DEL a b c
(integer) 3
```

`SET key val [EX secs | PX ms | NX | XX]` is deceptively deep: `EX`/`PX` set expiry inline, `NX` writes only if the key is absent, `XX` only if it already exists. Know which verbs are which category, because it decides routing:

| Command | Read or write | Notes |
|---|---|---|
| `GET`, `MGET`, `TTL`, `EXISTS` | **read** | Safe to serve from a replica (accepting staleness — §3) |
| `SET`, `MSET`, `APPEND`, `DEL`, `EXPIRE`, `PERSIST` | **write** | Primary only |
| `INCR`, `INCRBY`, `DECR` | **write** | Atomic read-modify-write; primary only |

Other structures follow the same read/write logic — this is a taste, not the manual:

| Structure | Write verbs | Read verbs | Typical use |
|---|---|---|---|
| Hash | `HSET`, `HDEL` | `HGET`, `HGETALL` | An object with fields (a user record) |
| Set | `SADD`, `SREM` | `SMEMBERS`, `SISMEMBER` | Membership, dedup, tags |
| Sorted set | `ZADD`, `ZREM` | `ZRANGE`, `ZSCORE`, `ZRANK` | **Leaderboards, time-ordered indexes** |
| List | `LPUSH`, `RPUSH` | `LRANGE`, `LPOP` | Simple queues, recent-items |

Sorted sets earn their own mention: they're the go-to for leaderboards and any "give me the top N by score" or "range by time" query, because members stay ordered by score and range reads are cheap.

## 3. The read/write split (primary/replica)

In a primary/replica topology the replica is **read-only by config** — `replica-read-only yes`, which is the default and what the [raw build ships](/architectures/valkey-shared-vip/#3a-secret-and-configmaps). Point a write at it and Valkey refuses, loudly:

```console
# :6380 is the read-only VIP port → the replica
127.0.0.1:6380> GET session:42
"alice"
127.0.0.1:6380> SET session:42 "mallory"
(error) READONLY You can't write against a read only replica.
```

That `READONLY` error is not a bug and not something to "fix" — it's the topology enforcing the split. If you see it in your app logs, your client sent a write to the read-only endpoint. Fix the *routing*, not the server.

**Replica reads are asynchronous, therefore possibly stale.** Replication streams from primary to replica after the primary has already acked the write to the client. So the instant you read from the replica, you're accepting **eventual consistency** — the replica may be milliseconds (or, under a slow link, much more) behind. Two config knobs govern the edge case where the replication link *breaks*:

```text
replica-serve-stale-data yes   # (default) keep serving the last-known data
                               #   even while the link to the primary is down
replica-serve-stale-data no    # instead, error most commands until re-synced:
                               #   -MASTERDOWN Link with MASTER is down ...
```

With `yes` (default) a replica whose link just died keeps answering reads with whatever it last had — availability over freshness. With `no` it fails reads instead of serving stale — freshness over availability. Note the [raw build's readiness probe](/architectures/valkey-shared-vip/#3d-statefulset-valkey-replica) sidesteps some of this by pulling a link-down replica out of the `:6380` Endpoints entirely — but if you dial a specific pod directly, this knob is what you're relying on.

When you *do* need a write to be durably replicated before you proceed, `WAIT` is your barrier:

```console
127.0.0.1:6379> SET order:99 "confirmed"
OK
127.0.0.1:6379> WAIT 1 500
(integer) 1        # 1 replica acked within 500ms. If it returned 0, no replica
                   #   confirmed in time — the write is on the primary but not
                   #   yet safely on any replica.
```

`WAIT numreplicas timeout` blocks the primary until at least `numreplicas` replicas have acknowledged all writes issued so far, or the timeout (ms) elapses. It returns the number that actually acked.

:::caution[`WAIT` is a durability barrier, NOT synchronous replication]
`WAIT` does not make replication synchronous. The primary already acked your `SET` to the client *before* `WAIT` ran. `WAIT` only lets you *observe, after the fact,* whether replicas have caught up — and it can return fewer than you asked for. It shrinks your data-loss window on failover; it does not close it. If you need acknowledged-write guarantees, that's Sentinel with `min-replicas-to-write` or an operator, discussed in [Valkey and Redis](/stateful/valkey-and-redis/#sentinel-ha-for-single-master).
:::

**Routing guidance, distilled:**

| Read pattern | Route to | Why |
|---|---|---|
| Read-after-write ("I just wrote it, now read it") | **Primary** (`:6379`) | The replica may not have it yet |
| Anything that must be current (balances, locks, dedup) | **Primary** | Staleness is a correctness bug here |
| Bulk / analytics / tolerant reads (catalog, cached views) | **Replica** (`:6380`) | Offload the primary; staleness is acceptable |
| All writes | **Primary** | The replica will `-READONLY` you |

## 4. Pub/Sub — and how topology rewrites it

Pub/Sub is the clearest case of "the same verbs behave differently depending on topology," so it's worth its own section.

**Classic pub/sub** is fire-and-forget messaging:

```console
# subscriber (one connection, now in subscribe mode)
127.0.0.1:6379> SUBSCRIBE news
1) "subscribe"
2) "news"
3) (integer) 1
# ... later, a message arrives:
1) "message"
2) "news"
3) "market opened"

# publisher (a different connection)
127.0.0.1:6379> PUBLISH news "market opened"
(integer) 1        # delivered to 1 subscriber
127.0.0.1:6379> PSUBSCRIBE news.*     # pattern subscribe: news.eu, news.us, ...
```

In a **primary/replica** topology, a message `PUBLISH`ed to the primary propagates down the replication stream, so subscribers connected to a *replica* receive it too. Handy — but understand the guarantees: pub/sub is **fire-and-forget, in-memory, with no persistence and no delivery guarantee.** A subscriber that's disconnected when a message is published simply misses it forever. There is no backlog, no redelivery, no ack.

In **cluster mode**, classic `PUBLISH` gets expensive. Because a subscriber could be connected to *any* node and classic channels have no slot affinity, the publish is **broadcast across the entire cluster bus to every node** so no subscriber is missed. Correct, but it's O(nodes) fan-out on every publish — it does not scale as you add shards.

**Sharded pub/sub** (Valkey/Redis 7+) fixes that. `SPUBLISH`/`SSUBSCRIBE` map the *channel name* to a hash slot, exactly like a key, so only the shard owning that slot handles the channel — no cluster-wide fan-out:

```console
# The channel maps to a slot; the subscriber MUST be on the shard owning it.
127.0.0.1:6379> SSUBSCRIBE room:42
1) "ssubscribe"
2) "room:42"
3) (integer) 1

127.0.0.1:6379> SPUBLISH room:42 "hi"
(integer) 1
127.0.0.1:6379> SUNSUBSCRIBE room:42
```

| | Classic pub/sub | Sharded pub/sub |
|---|---|---|
| Commands | `SUBSCRIBE` / `PUBLISH` / `PSUBSCRIBE` | `SSUBSCRIBE` / `SPUBLISH` / `SUNSUBSCRIBE` |
| Channel → node | No affinity | Channel name hashes to a **slot** |
| Cluster behavior | **Broadcast to every node** (expensive) | Handled by the **owning shard only** (scales) |
| Subscriber placement | Any node | **Must connect to the shard owning the slot** |
| Pattern matching (`P*`) | Yes | No (`SSUBSCRIBE` has no pattern form) |
| Fan-out cost at scale | Grows with cluster size | Flat |

The catch with sharded pub/sub: your subscriber has to connect to the *right shard*. A cluster-aware client handles this (it hashes the channel and routes there), but if you're hand-rolling connections you must send `SSUBSCRIBE` to the node that owns the channel's slot, or you'll get a `MOVED`.

:::caution[Pub/Sub is not a durable queue]
Neither classic nor sharded pub/sub persists anything or guarantees delivery. A subscriber that blinks out misses every message sent while it was gone — there's no replay. If you need durability, consumer groups, acknowledgements, or redelivery of un-acked messages, you want **Streams** (§5), not pub/sub.
:::

## 5. Streams — the durable log and queue

A Stream is an append-only log stored as a key. Unlike pub/sub, entries persist (as long as the key does — see the persistence note), and consumer groups give you at-least-once delivery with acknowledgements. This is your queue/event-log primitive.

**Producing and simple reading:**

```console
127.0.0.1:6379> XADD events * type "signup" user "42"
"1720353600123-0"          # server-generated ID: <ms-time>-<seq>
127.0.0.1:6379> XADD events * type "login" user "42"
"1720353600981-0"
127.0.0.1:6379> XLEN events
(integer) 2
127.0.0.1:6379> XRANGE events - +           # - = start, + = end
1) 1) "1720353600123-0"
   2) 1) "type"
      2) "signup"
      3) "user"
      4) "42"
2) 1) "1720353600981-0"
   2) 1) "type"
      2) "login"
      3) "user"
      4) "42"
# Tail like `tail -f`, blocking up to 5s for anything after the last ID we saw:
127.0.0.1:6379> XREAD BLOCK 5000 COUNT 10 STREAMS events $
```

**Consumer groups** — the queue pattern with acks and redelivery:

```console
# create a group starting from the beginning of the stream (0), or $ for "new only"
127.0.0.1:6379> XGROUP CREATE events workers 0
OK
# consumer "c1" claims up to 10 never-before-delivered messages (the > ID):
127.0.0.1:6379> XREADGROUP GROUP workers c1 COUNT 10 STREAMS events >
1) 1) "events"
   2) 1) 1) "1720353600123-0"
         2) 1) "type"
            2) "signup" ...
# process it, then acknowledge so it leaves the pending list:
127.0.0.1:6379> XACK events workers 1720353600123-0
(integer) 1
# a consumer crashed mid-processing? find and reclaim stuck (un-acked) messages:
127.0.0.1:6379> XPENDING events workers
127.0.0.1:6379> XAUTOCLAIM events workers c2 60000 0
#   ^ reassign to c2 any pending message idle > 60000ms
```

`XREADGROUP ... STREAMS events >` delivers messages never handed to *any* consumer in the group; each delivered-but-un-acked message sits in that consumer's Pending Entries List (PEL) until `XACK`. If a consumer dies, `XPENDING` shows the stuck entries and `XAUTOCLAIM` (or `XCLAIM`) reassigns them — that's how you get at-least-once delivery without losing work to a crashed worker.

**Trimming** keeps the stream from growing forever:

```console
127.0.0.1:6379> XADD events MAXLEN ~ 100000 * type "click"   # cap ~100k on write
127.0.0.1:6379> XTRIM events MINID 1720000000000             # drop entries older than an ID
```

The `~` makes trimming approximate (much cheaper — it trims in whole macro-nodes rather than exact-counting). Use `MAXLEN ~ N` on hot streams.

:::caution[A stream used as a queue NEEDS AOF]
A Stream is just a key held in memory. It's made durable exactly like any other key — by **AOF and/or RDB**. If you run a Stream as your job queue on an instance with `appendonly no` and no snapshots, a pod restart **loses the queue and every un-acked message in it.** Turn on `appendonly yes` (`appendfsync everysec`) for any Stream you can't afford to lose. This is the same cache-vs-store decision as §8 — a queue is *storage*, not cache.
:::

**In cluster mode, a stream lives on exactly one slot.** All of a stream's entries hash to the slot of its key, so every `XADD`/`XREADGROUP`/`XACK` for that stream goes to a single shard's primary. That's fine and correct — just know a single stream does **not** shard its throughput across nodes. To spread load you partition manually (e.g. `events:0`, `events:1`, ... `events:{n}`), each landing on a potentially different shard.

## 6. Transactions, pipelines, and scripts

**Transactions** (`MULTI`/`EXEC`) queue commands and run them atomically, with optimistic locking via `WATCH` (a compare-and-set):

```console
127.0.0.1:6379> WATCH balance:42            # abort EXEC if this key changes first
OK
127.0.0.1:6379> MULTI
OK
127.0.0.1:6379> DECRBY balance:42 10
QUEUED
127.0.0.1:6379> INCRBY balance:99 10
QUEUED
127.0.0.1:6379> EXEC
1) (integer) 90
2) (integer) 110
# If another client wrote balance:42 between WATCH and EXEC, EXEC returns (nil)
# and nothing ran — you retry. That's the CAS. DISCARD abandons a queued MULTI.
```

**Pipelining** is a *client-side* trick: send many commands without waiting for each reply, to cut round-trip time. It is **not** atomic and **not** a transaction — replies just come back batched. Use it to make 1000 independent `SET`s one round-trip instead of 1000. Don't confuse "pipelined" with "atomic."

**Scripts and functions** run server-side logic atomically: `EVAL <lua> numkeys key... arg...`, `EVALSHA <sha>` (after the script is cached), and the newer `FUNCTION`/`FCALL` library API. All of a script's key access must be declared in its `KEYS` list.

**The cluster rule that catches everyone:** in cluster mode, **every key touched by a transaction, a Lua script, or any multi-key command must hash to the same slot.** If they don't:

```console
# cluster mode — these two keys hash to different slots:
127.0.0.1:6379> MGET user:42:name user:42:email
(error) CROSSSLOT Keys in request don't hash to the same slot
```

You force co-location with a **hash tag** — the substring inside `{...}` is the *only* part hashed, so keys sharing a tag share a slot:

```console
127.0.0.1:6379> CLUSTER KEYSLOT order:{42}:items
(integer) 8541
127.0.0.1:6379> CLUSTER KEYSLOT order:{42}:total
(integer) 8541            # same slot — because only "42" is hashed
127.0.0.1:6379> MGET order:{42}:items order:{42}:total
1) "3 widgets"
2) "59.90"                # now it works: both keys are on the same shard
```

Same rule bites `MGET`, `DEL a b c`, `MSET`, `SINTERSTORE`, and any command spanning multiple keys — they only work when all keys land on one slot. Design your key names *up front* so related keys share a `{tag}`; retrofitting hash tags means rewriting keys in production.

:::note[This never happens in primary/replica]
`CROSSSLOT` is purely a cluster-mode phenomenon — there's only one slot-space to begin with in primary/replica, so multi-key commands just work. It's one of the real costs of graduating to cluster mode (see the [Helm deep dive's topology comparison](/architectures/valkey-helm-deep-dive/#6-cluster-mode-sharding--the-other-topology)).
:::

## 7. Cluster-mode client semantics

In cluster mode the *client* issues a few verbs your app never writes directly — a cluster-aware library does this for you, but you should know what it's doing when you read a stack trace.

**Bootstrap.** On connect, the client learns the slot→node map with `CLUSTER SHARDS` (or the older `CLUSTER SLOTS`):

```console
127.0.0.1:6379> CLUSTER SLOTS
1) 1) (integer) 0
   2) (integer) 5460
   3) 1) "10.42.1.10"        # primary for slots 0–5460
      2) (integer) 6379
   4) 1) "10.42.2.11"        # its replica
      2) (integer) 6379
2) ...  (slots 5461–10922 on another shard, etc.)
```

**Follow redirects.** The client sends each command to the slot's owner. If it guesses wrong, the node replies with a redirect and the client re-sends:

```console
# redis-cli -c enables cluster mode (auto-follow). Watch it follow a MOVED:
$ redis-cli -c -h 10.42.1.10 -p 6379
10.42.1.10:6379> SET user:{99}:name "carol"
-> Redirected to slot [4938] located at 10.42.2.11:6379
OK
10.42.2.11:6379> CLUSTER KEYSLOT user:{99}:name
(integer) 4938
```

Two redirect kinds, and the difference matters:

| Redirect | Meaning | Client action |
|---|---|---|
| `-MOVED <slot> host:port` | **Permanent** — that slot now lives there | Follow *and* update the cached slot map |
| `-ASK <slot> host:port` | **Transient** — slot is mid-migration | Follow *this one* request (prefixed with `ASKING`); do **not** update the map |

A client that ignores `MOVED` and never refreshes its map will thrash forever; a *non*-cluster client hitting a cluster just sees these as errors. This is why a cluster-mode app **requires a cluster-aware client library**.

**Reading from a replica in cluster mode** needs one extra verb. By default a replica redirects reads to its primary (a `MOVED`), because the cluster assumes you want consistency. To opt into replica reads, the client sends `READONLY` on the connection first:

```console
10.42.2.11:6379> READONLY
OK
10.42.2.11:6379> GET user:{99}:name      # now served locally by the replica (possibly stale)
"carol"
10.42.2.11:6379> READWRITE               # revert: reads go back to the primary
OK
```

So the primary/replica read-split from §3 exists in cluster mode too — it's just gated behind an explicit `READONLY` per connection, and you're accepting the same staleness bargain.

## 8. Cache vs storage — the decision that colors every command

The single biggest lens on all of the above is whether this Valkey is a **cache** (data is rebuildable; loss is a slow request, not an incident) or a **store/datastore** (data is authoritative; loss is an incident). The [fundamentals page](/stateful/valkey-and-redis/#first-question-is-it-a-cache-or-a-store) says this decides *everything about deployment*; here's how it decides everything about your *commands*.

The behavior that makes the two feel different in practice is **what happens when memory fills up.** With a cache eviction policy, a `SET` at the limit silently evicts something old and succeeds. With `noeviction`, that same `SET` fails loudly to protect your data:

```console
# CACHE (maxmemory-policy allkeys-lru): a SET at the limit evicts, never fails
127.0.0.1:6379> SET newkey val
OK                             # something old was evicted to make room

# STORE (maxmemory-policy noeviction): a SET at the limit refuses
127.0.0.1:6379> SET newkey val
(error) OOM command not allowed when used memory > 'maxmemory'.
```

That `OOM` error is the store *protecting your data* — your write fails loudly instead of some other key vanishing silently. It's the correct behavior for a datastore and an alarming surprise for anyone who assumed cache semantics. Which one you get is one config line, and choosing wrong is how teams "lose data nobody meant to be evictable."

| Axis | CACHE | STORE / datastore |
|---|---|---|
| `maxmemory-policy` | `allkeys-lru` / `allkeys-lfu` | `noeviction` |
| When full | Evicts old keys; `SET` succeeds | `-OOM` error; `SET` **fails**, data protected |
| Persistence | Optional (loss acceptable) | `appendonly yes` + `appendfsync everysec` |
| TTLs | Yes — `SET k v EX 300` on most keys | No TTL on durable keys |
| Where reads go | Replicas (staleness fine) | Primary (read-after-write) |
| Durability barrier | Not used | `WAIT`, backups |
| Durable structures | Simple strings/hashes with TTL | Streams, sorted sets, hashes |
| Invalidation | Keyspace notifications on expiry | N/A (data is the truth) |
| Example verbs | `GET`/`SET ... EX`, `HGETALL` | `XADD`, `ZADD`, `WAIT`, `BGSAVE` |

**Cache-specific pattern — keyspace notifications for invalidation.** A cache often needs to *react* when keys expire. Enable notifications (`notify-keyspace-events`, e.g. `Ex` for expired-key events) and subscribe to the event channel:

```console
127.0.0.1:6379> CONFIG SET notify-keyspace-events Ex
OK
127.0.0.1:6379> SUBSCRIBE __keyevent@0__:expired
# ... when session:42 expires, you receive:
1) "message"
2) "__keyevent@0__:expired"
3) "session:42"
```

Now your app can drop the corresponding local entry the moment Valkey expires it. (Note: expired-key events are themselves pub/sub — same no-guarantee caveat from §4; a disconnected listener misses expirations.)

**Store-specific posture:** `noeviction`, AOF on, no TTLs on the durable keys, reads that must be current go to the primary, and `WAIT`/backups for stronger guarantees. The persistence and memory tradeoffs that back this up are the [Helm deep dive's config-tradeoffs section](/architectures/valkey-helm-deep-dive/#3-config-tradeoffs-mapped-to-values), and the backup layers that make "we have backups" actually true are in [Backup and DR](/stateful/backup-and-dr/).

## 9. Connecting from your app

Your client reaches Valkey with a connection string; the forms you'll meet:

```text
redis://:password@valkey.example.internal:6379/0     # password only (requirepass), DB 0
redis://appuser:pass@valkey.example.internal:6379/0  # ACL user + password
rediss://:password@valkey.example.internal:6380      # TLS (note the extra 's')
```

The scheme is `redis://` (or `rediss://` for TLS) even against Valkey — the wire protocol is unchanged, so every Redis client library works. Two things to get right:

- **A cluster-mode app needs a cluster-aware client library.** It must follow `MOVED`/`ASK`, read the slot map with `CLUSTER SHARDS`, and (for replica reads) send `READONLY`. A plain single-node client pointed at a cluster works only by luck and breaks on the first redirect. Most mainstream libraries have a distinct "cluster" client class — use it.
- **Route by verb, not by convenience.** In primary/replica, send writes and read-after-write to the primary connection (`:6379`) and tolerant reads to the replica connection (`:6380`). Many clients support a read-from-replica preference — set it deliberately, knowing §3's staleness bargain.

*How* that connection physically reaches the cluster — the VIPs, the L4/TCP routing, `cluster-announce-ip` so each cluster node advertises a reachable address — is deliberately out of scope here. That's the sibling page: [Valkey Ingress: VIPs, TCP Routing, and cluster-announce](/architectures/valkey-ingress-and-cluster-announce/).

## Which verbs for which job

Bring it together. Pick the command family for the job, and the topology falls out of it:

| Job | Command family | Read/write shape | Topology that fits |
|---|---|---|---|
| Cache lookup | `GET` / `SET ... EX`, `HGETALL` | Read-heavy, tolerant of staleness | Primary/replica, reads on the replica; `allkeys-lru` |
| Counters | `INCR` / `INCRBY` | Atomic writes | Primary only (writes) |
| Session store | `SET ... EX` / `GET`, `HSET`/`HGETALL` | Read-after-write; loss = logout | Primary for reads *and* writes; persistence on |
| Pub/sub fan-out | `PUBLISH`/`SUBSCRIBE`; `SPUBLISH`/`SSUBSCRIBE` | Fire-and-forget, no durability | Primary/replica for classic; **sharded** in cluster |
| Durable event stream / queue | `XADD` / `XREADGROUP` / `XACK` | Persisted log, at-least-once | Store: `appendonly yes`; one slot per stream in cluster |
| Leaderboard / ranked index | `ZADD` / `ZRANGE` / `ZSCORE` | Ordered reads, frequent writes | Reads can hit replica; keep one leaderboard on one key |

Start from "is this a read or a write, and is it cache or store" — §1 and §8 — and the routing, the persistence, and the cluster caveats all follow. When you're ready to see the server these verbs land on, go back up to the [Valkey Helm Chart Deep Dive](/architectures/valkey-helm-deep-dive/); when you need to know how the connection gets there, take the [ingress sibling](/architectures/valkey-ingress-and-cluster-announce/).
