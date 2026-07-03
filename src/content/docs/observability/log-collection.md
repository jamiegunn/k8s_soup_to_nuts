---
title: Log Collection
description: How the cluster log pipeline works, what app teams control, Loki vs ELK querying, volume etiquette, and the "my logs aren't showing up" checklist.
sidebar:
  order: 3
---

`kubectl logs` dies with the pod. Durable, searchable logs come from a collection pipeline that the platform team runs and you feed. Understanding the pipeline — even the parts you can't touch — is the difference between fixing "my logs aren't showing up" yourself in five minutes and filing a ticket that bounces for a week.

## The pipeline

```text
your container ──stdout──▶ /var/log/pods/... (node file, kubelet-rotated)
                                   │
                     node agent DaemonSet (Fluent Bit / Fluentd / Vector)
                     · tails files, parses lines, enriches with pod metadata
                                   │
                     (optional) aggregation tier — buffering, routing, filtering
                                   │
                     store + query: Elasticsearch/OpenSearch, Loki,
                     or cloud (CloudWatch, GCP Logging, Azure Monitor)
```

**The node agent** is a DaemonSet — one pod per node, running with host-path mounts to read every container's log files. It's cluster infrastructure: you can usually *see* it (`kubectl get ds -n logging` if you have read access, or just ask), but you can't modify it. Each agent tails the files, parses each line (JSON parsing, or regex for plaintext), attaches Kubernetes metadata (namespace, pod name, container, labels), and ships batches upstream.

**The store** determines how you query. Elasticsearch/OpenSearch indexes every field of every log line — powerful full-text search, expensive at scale. Loki indexes only *labels* and greps the log content at query time — cheap to run, different query discipline. Cloud offerings sit somewhere in between.

Everything in that diagram except your container is platform-owned. What's yours:

:::note[kubectl logs is independent of all this]
`kubectl logs` reads the node files directly via the kubelet — it works even when the whole collection pipeline is down, and the pipeline works even when the API server is struggling. They're parallel consumers of the same files. If logs are missing from the backend but present in `kubectl logs`, the pipeline broke; if they're missing from both, your app never wrote them.
:::

## What you control

### 1. Log format

The agent's parser is configured once, cluster-wide, and it almost certainly expects **JSON, one event per line** (see [Logging Fundamentals](/observability/logging-fundamentals/)). Emit clean JSON and every field becomes searchable automatically. Emit plaintext and you get, at best, one big unindexed `message` blob; at worst, a parse failure that tags your logs with a fallback format or drops fields.

Field-name consistency matters more than you'd think. If the cluster convention is `level`/`message`/`timestamp` and your app emits `severity`/`msg`/`ts`, your logs are technically there but every shared dashboard and alert misses them. Ask the platform team for the expected schema — most have one, few document it. A sane baseline that fits nearly every pipeline:

```json
{
  "timestamp": "2026-07-03T09:14:22.031Z",
  "level": "ERROR",
  "logger": "com.shop.checkout.PaymentClient",
  "message": "payment gateway timeout after 3 retries",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "thread": "http-nio-8080-exec-7",
  "stack_trace": "java.net.SocketTimeoutException: ..."
}
```

Validate before you deploy — a single non-JSON line in the stream is what breaks parsers:

```bash
kubectl logs deploy/checkout-api --tail=200 | jq -e . > /dev/null && echo "all valid JSON" || echo "found non-JSON lines"
kubectl logs deploy/checkout-api --tail=200 | grep -vE '^\{' | head   # show the offenders
```

Startup banners (looking at you, Spring Boot ASCII art) and third-party libraries writing directly to stdout are the usual offenders — disable the banner and route java.util.logging/stdout captures through your JSON encoder.

### 2. Labels and annotations that become index fields

The agent attaches pod metadata to every log line. Your pod **labels** typically become searchable fields or Loki labels — which means sane, consistent labels are an observability feature, not just tidiness:

```yaml
metadata:
  labels:
    app.kubernetes.io/name: checkout-api
    app.kubernetes.io/version: "2.14.1"
    app.kubernetes.io/part-of: shop
```

Now "all logs for the shop system" or "logs from version 2.14.1 only" are one-click queries. See [YAML, Labels, and Namespaces](/start/yaml-labels-and-namespaces/).

Many pipelines also honor **annotations** for per-pod behavior — common conventions include Fluent Bit's `fluentbit.io/exclude: "true"` (don't collect this pod) and `fluentbit.io/parser: <name>` (use a specific parser). These are pipeline-specific; ask which ones your cluster supports before relying on them.

### 3. Not logging secrets

This deserves its own line. Anything your app prints goes into a shared, multi-tenant log store with retention and access rules you don't control. Assume every developer with log access — possibly in other teams — can read it. Never log: authorization headers, tokens, passwords, full request bodies on auth endpoints, PII beyond what your compliance rules allow. Scrub at the source; pipeline-level redaction is a backstop, not a plan.

## Querying: Loki vs ELK in two minutes

You'll get one of these. The mental models differ:

**Loki (LogQL)** — select a log *stream* by labels, then filter/parse:

```text
{namespace="shop", app="checkout-api"} |= "timeout" | json | level="ERROR"

# Rate of errors per pod over 5m — logs as metrics
sum by (pod) (rate({namespace="shop", app="checkout-api"} | json | level="ERROR" [5m]))
```

Labels are cheap to filter, content is grepped. Keep label sets small; do the heavy lifting in the filter stages.

**Elasticsearch/OpenSearch (Lucene/KQL via Kibana)** — everything's indexed, query fields directly:

```text
kubernetes.namespace: "shop" AND kubernetes.labels.app: "checkout-api"
  AND level: "ERROR" AND message: *timeout*
```

Full-text and field queries are equally natural; the cost was paid at ingest time.

## Volume etiquette: noisy apps get dropped or billed

Log pipelines have real capacity and real cost — Elasticsearch storage, Loki ingestion limits, cloud per-GB pricing. Platform teams enforce this with per-namespace rate limits, sampling, or chargeback. An app logging every request at INFO across 40 replicas can emit tens of GB a day; when the pipeline hits backpressure, agents drop lines — often *everyone's* lines on that node, which is how you become the neighbor nobody wants.

- **Default to INFO in prod, and make INFO quiet.** Request-level logging belongs at DEBUG, or in [metrics](/observability/metrics/) and [traces](/observability/tracing/) which are built for high-frequency data.
- **Never log in a tight loop or per-item in a batch.** Log the batch summary.
- **Watch high-cardinality fields.** In Elasticsearch, a field like `user_id` or a raw UUID-bearing URL as an *indexed field* bloats the index mappings; in Loki, a high-cardinality *label* (pod IP, request ID as a label) explodes the stream count and can get your tenant throttled. Cardinality belongs in log *content*, not in labels/index keys.
- **Sample the repetitive stuff.** If a warning can fire 1000×/sec, log it once per N or once per interval with a counter.

:::caution
Crash loops are log-volume incidents too: a pod restarting every 15 s re-prints its entire startup banner each time, forever. Fix [CrashLoopBackOff](/troubleshooting/crashloopbackoff/) fast, not just for the app's sake.
:::

## "My logs aren't showing up" — the checklist

Work top to bottom; the first three are yours to check, the last two are evidence for the platform team.

1. **Are the logs reaching stdout at all?**
   ```bash
   kubectl logs deploy/checkout-api --tail=20
   ```
   Empty? Your app is logging to a file or buffering. Fix that first — the pipeline can't ship what the node never sees. (Python: `PYTHONUNBUFFERED=1`; Java: check for a file appender.)

2. **Did your format break the parser?** One malformed change — a startup banner, a non-JSON line from a library, a log framework switch — and the agent's JSON parser fails. Symptoms: logs appear but fields like `level` stopped being searchable, or lines land tagged as unparsed. Compare a raw `kubectl logs` line against the expected schema character by character.

3. **Multiline?** Stack traces split into fragments, or dropped by a parser that expects single lines. The fix is JSON logging — see [Logging Fundamentals](/observability/logging-fundamentals/).

4. **Agent backpressure or agent down on that node?** If *other* pods on the same node also stopped shipping around the same time, it's the agent, not you. Note the node (`kubectl get pod -o wide`), the time window, and whether logs resume — hand that to the platform team.

5. **Index/tenant problem?** Logs shipped but a broken index template, a full index, ILM/retention policy, or a Loki tenant limit rejected them at the store. Entirely platform-side; your evidence is "stdout confirmed at time X, node Y, never appeared in the store."

:::tip[Prove which side of the fence the problem is on]
Log a unique marker and search for it: exec into your pod, `echo '{"level":"INFO","message":"logpath-test-4f9a2c"}' >> /proc/1/fd/1` (writes to the main process's stdout), confirm it appears in `kubectl logs`, then search the backend for `logpath-test-4f9a2c` two minutes later. Present-in-kubectl but absent-in-backend is airtight evidence for the platform ticket.
:::

## What to ask your platform team

- What's the log stack (Loki? OpenSearch? cloud?) and where's the query UI?
- What JSON schema does the parser expect (field names for level/timestamp/message)?
- Which pod annotations does the pipeline honor (exclude, parser override)?
- What are the volume limits and what happens when we exceed them — drop, sample, or bill?
- What's the retention, and is it different per level or per namespace?
- Is there an event exporter shipping Kubernetes [events](/observability/events/) into the same store? (Searchable events next to logs is a big incident-response upgrade.)

Get the answers in writing, into your team's runbook. Half the "logging is broken" tickets we've seen were really "nobody wrote down how the pipeline works."
