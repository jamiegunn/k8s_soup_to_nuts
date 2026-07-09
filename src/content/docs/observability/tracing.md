---
title: Tracing
description: Distributed tracing with OpenTelemetry — context propagation, the Java auto-instrumentation agent, collector patterns, sampling, and log correlation.
keywords:
  - OpenTelemetry OTLP collector
  - traceparent W3C context propagation
  - Java javaagent auto-instrumentation
  - Jaeger Grafana Tempo
  - head vs tail sampling
  - OTEL_EXPORTER_OTLP_ENDPOINT
  - spans and traces
  - trace_id span_id log correlation
  - my traces aren't showing up
  - unknown_service:java service name
  - gRPC 4317 HTTP 4318
  - broken fragmented traces propagation gap
sidebar:
  order: 6
---

Once a request crosses more than one service, logs and metrics stop composing: each service swears it's fine, and the user waits four seconds anyway. Distributed tracing follows a single request across every hop and shows you exactly where the time went. It's the only signal built for the question microservices make you ask daily: *which* service, *which* call, *this* request.

## Spans, traces, and context propagation

- A **span** is one timed operation: an HTTP handler, a DB query, a call to a downstream service. It has a name, start/end time, attributes, and a parent.
- A **trace** is the tree of spans sharing one `trace_id` — the full story of one request across all services.
- **Context propagation** is what stitches them: each outgoing request carries the trace context in headers so the next service can attach its spans to the same trace.

The propagation standard is **W3C Trace Context** — a `traceparent` header:

```text
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
              │  └── trace-id (16 bytes) ──────┘ └─ parent span ─┘ └ sampled flag
```

The failure mode to burn in: **one uninstrumented service breaks the chain.** If service B doesn't forward `traceparent`, C's spans start a fresh trace and your end-to-end view splits into disconnected fragments. Broken traces are almost always a propagation gap, not a backend problem — and homegrown HTTP clients, thread pools that lose context, and message queues are the usual suspects.

## OpenTelemetry: the standard

OpenTelemetry (OTel) won. It's the vendor-neutral standard for generating and exporting traces (plus metrics and logs), and every serious backend — Jaeger, Grafana Tempo, Datadog, Honeycomb, cloud vendors — ingests its wire protocol, **OTLP**. Instrument once with OTel and the backend becomes a config value, not a code change.

### Java: auto-instrumentation with the OTel javaagent

For Java teams this is the single best deal in observability. The OTel javaagent instruments at the bytecode level — HTTP servers/clients, JDBC, Kafka, gRPC, Redis, thread pools, and dozens more — with **zero code changes**. It's just a `-javaagent` flag, which makes it perfect for the locked-down, JRE-only container world described in [JVM in Containers](/java/jvm-in-containers/): no JDK tooling, no rebuild of app code, no framework migration.

Bake the agent into the image (or pull it via an init container) and wire it up:

```dockerfile
# In your Dockerfile — pin the version; "latest" is a moving target you can't reproduce
ADD https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v2.8.0/opentelemetry-javaagent.jar /otel/opentelemetry-javaagent.jar
```

```yaml
# Deployment pod template
env:
  - name: JAVA_TOOL_OPTIONS
    value: "-javaagent:/otel/opentelemetry-javaagent.jar"
  - name: OTEL_SERVICE_NAME
    value: "checkout-api"
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: "http://otel-collector.observability.svc:4317"   # ask platform for this
  - name: OTEL_EXPORTER_OTLP_PROTOCOL
    value: "grpc"   # agent 2.x defaults to http/protobuf (4318) — must match the port above
  - name: OTEL_RESOURCE_ATTRIBUTES
    value: "service.version=2.14.1,deployment.environment=prod"
  - name: OTEL_TRACES_SAMPLER
    value: "parentbased_traceidratio"
  - name: OTEL_TRACES_SAMPLER_ARG
    value: "0.10"
```

`JAVA_TOOL_OPTIONS` is picked up by any JVM automatically — no entrypoint changes. All OTel SDK configuration flows through `OTEL_*` env vars, which means it lives in your manifests (or a shared ConfigMap), varies per environment, and changes without a rebuild. The same env-var scheme configures the SDKs for Go, Python, Node, and .NET; Python and Node also have auto-instrumentation of similar quality.

:::note[If the platform runs the OTel Operator]
Some platform teams run the OpenTelemetry Operator, which injects the agent for you when you annotate your pod (`instrumentation.opentelemetry.io/inject-java: "true"`). Ask — it's less for you to maintain, and the platform controls agent versions centrally.
:::

### Verifying the agent actually attached

Trust nothing until you've seen it. The agent announces itself on stdout at JVM startup:

```bash
kubectl logs deploy/checkout-api | head -5
```

```console
Picked up JAVA_TOOL_OPTIONS: -javaagent:/otel/opentelemetry-javaagent.jar
[otel.javaagent 2026-07-03 09:12:01:334 +0000] [main] INFO io.opentelemetry.javaagent.tooling.VersionLogger - opentelemetry-javaagent - version: 2.8.0
```

No `Picked up JAVA_TOOL_OPTIONS` line means the env var isn't reaching the JVM — check for an entrypoint script that clobbers the environment. To see spans without any backend at all, set `OTEL_TRACES_EXPORTER=console` in a dev environment: spans print to stdout, proving instrumentation works before you fight the export path.

### Custom spans where auto-instrumentation can't see

Auto-instrumentation traces the *edges* (HTTP in, DB out) but your business logic in between is one opaque span. Annotate the interesting interior methods:

```java
import io.opentelemetry.instrumentation.annotations.WithSpan;
import io.opentelemetry.instrumentation.annotations.SpanAttribute;

@WithSpan("price-calculation")
public Quote calculatePrice(@SpanAttribute("cart.items") int itemCount) {
    // shows up as a child span with the attribute attached
}
```

That's one small dependency (`opentelemetry-instrumentation-annotations`) — still no SDK wiring, the agent picks the annotations up. Add spans around the two or three operations you'd want timed during an incident, not around everything.

## Collector deployment patterns

Apps should not export straight to the tracing backend. In between sits the **OTel Collector**, which buffers, batches, retries, strips/enriches attributes, and decouples your app from backend choice. Two patterns you'll encounter:

- **Platform gateway (the norm):** a central collector Deployment (or per-node DaemonSet agent tier), run by the platform team. Your app exports OTLP to a cluster-internal Service endpoint and you're done. This is what you want — one config value, zero infrastructure owned by you.
- **Sidecar collector:** a collector container in your own pod. Justified only for unusual needs — per-app processing rules, strict tenancy isolation, or when no platform collector exists and you can't wait. Costs you resources in every pod and an image you now maintain.

Under the platform-team model of this guide: **ask for the gateway endpoint first.** Run a sidecar only as a stopgap, and say so in the ticket.

## Sampling: traces cost real money

Tracing every request in a busy system generates enormous data volume, and backends bill by ingested span. Nobody traces at 100% in production for long.

- **Head sampling** decides at trace start (e.g. `parentbased_traceidratio` at 10%, as above). Cheap, simple, but it can't know a trace will turn out slow or broken — it discards 90% of *everything*, including 90% of your errors. `parentbased_` matters: it honors the caller's sampling decision so traces don't get half-sampled mid-chain — everyone in the call graph should use a parent-based sampler.
- **Tail sampling** decides after the trace completes, in the collector — "keep all errors, all traces >2 s, and 5% of the rest." Far better signal per dollar, but it requires collector-side setup (and enough memory to hold traces in flight), so it's a platform-team capability to ask about, not an env var you set.

Start with head sampling at 5–10%, keep dev/stage at 100%, and revisit when you find yourself searching for an error trace that got sampled away.

:::caution[Sampled traces lie about rates]
A trace backend at 10% sampling shows you 10% of requests — never eyeball request *rates* or error *counts* from trace search results. Rates come from [metrics](/observability/metrics/); traces are for the shape of individual requests. Teams burn hours "investigating" a traffic drop that was actually a sampling-rate change.
:::

## Correlating traces with logs

The highest-leverage integration in this whole section: put `trace_id` into every log line. Then the workflow becomes seamless in both directions — from a slow trace, jump to the exact logs of that request; from an error log, pull up the full distributed trace.

With the Java agent, current trace/span IDs are injected into the logging MDC automatically — just add the fields to your JSON encoder (see [Logging Fundamentals](/observability/logging-fundamentals/)):

```json
{"timestamp":"2026-07-03T09:14:22.031Z","level":"ERROR","message":"payment gateway timeout","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7"}
```

Grafana wires this together explicitly (Loki "derived fields" turn `trace_id` into a click-through to Tempo, and Tempo links back to logs); Kibana/APM setups have equivalents. If your logs have `trace_id` today, asking platform to enable that linking is a one-line config for them and a workflow transformation for you.

:::tip
Even before any tracing backend exists, JSON logs with a propagated `trace_id` give you "grep one request across all services" in your log store. It's 60% of tracing's value for 5% of the effort — do it first.
:::

## "My traces aren't showing up" — the short checklist

1. **Agent attached?** Check for the `otel.javaagent` banner in `kubectl logs` (above).
2. **Exporting to the right place?** Look for `Failed to export spans` / connection-refused errors in the app log. Test reachability from the pod: `kubectl exec deploy/checkout-api -- sh -c 'nc -zv otel-collector.observability.svc 4317'` (or `wget -qO- http://...:4318/` for HTTP). Wrong port is the classic — 4317 is gRPC, 4318 is HTTP, and `OTEL_EXPORTER_OTLP_PROTOCOL` must match.
3. **Sampled away?** At 10% head sampling, nine out of ten of your test requests produce nothing. Set `OTEL_TRACES_SAMPLER=always_on` temporarily while verifying.
4. **Wrong service name?** You're searching the backend for `checkout-api` but `OTEL_SERVICE_NAME` was never set, so spans land under `unknown_service:java`. Everyone does this once.
5. **Trace exists but fragmented?** Propagation gap — find the first service in the chain whose spans start a new trace; its *caller* is dropping the `traceparent` header.

## What to ask your platform team

1. **Is there an OTel collector, and what's the OTLP endpoint?** (gRPC 4317 / HTTP 4318; and whether it's a gateway Service or a node-local agent)
2. **What's the tracing backend** — Jaeger, Tempo, a vendor — and where's the query UI?
3. **Is the OTel Operator installed** (annotation-based agent injection)?
4. **What sampling policy exists at the collector** (tail sampling? per-namespace budgets?) so your head-sampling rate composes with it instead of fighting it.
5. **Is trace/log correlation wired up** in Grafana or Kibana, and what field name does it expect (`trace_id` vs `traceId`)?

If the answer to (1) is "there isn't one," a sidecar collector exporting to a free-tier vendor or a namespace-local Jaeger `all-in-one` (fine for dev, not for prod retention) will get you unstuck — but put the gateway request in writing. Tracing is a per-cluster investment that pays off across every team; see [Working with the Platform Team](/operations/working-with-platform-team/).

And regardless of the backend situation: ship the `-javaagent` flag and `trace_id`-bearing JSON logs now. Instrumentation with nowhere to export costs almost nothing; an incident with no instrumentation costs a weekend.
