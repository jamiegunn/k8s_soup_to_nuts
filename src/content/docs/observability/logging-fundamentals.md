---
title: Logging Fundamentals
description: The stdout contract, kubectl logs mastery, where logs physically live and why they vanish, and fixing multiline stack traces with JSON logging.
sidebar:
  order: 2
---

Logging in Kubernetes is built on one deal: your app writes lines to stdout, and everything else — capture, rotation, collection, search — is somebody else's job. Apps that honor the deal get observability nearly for free. Apps that don't (writing to files, rotating their own logs, printing multiline garbage) fight the platform forever.

## The stdout/stderr contract

Rules, in order of how often we see them violated:

1. **Log to stdout/stderr. Never to files.** The container runtime captures stdout per container and the kubelet manages the files. A log written to `/var/log/app/app.log` inside the container is invisible to `kubectl logs`, invisible to the cluster's log collector, and dies with the container.
2. **No log rotation logic in your app.** No `RollingFileAppender`, no logrotate sidecar, no size caps. The kubelet rotates container logs (typically at 10 MiB per file, keeping a handful of rotations — `containerLogMaxSize`/`containerLogMaxFiles` on the node, platform-configured). App-side rotation on top of that just loses data.
3. **One event per line.** Newline-delimited. Multiline output breaks collectors — more on that below.
4. **stderr is not an error channel.** Both streams end up in the same log file. Use a `level` field in the log line itself, not the stream, to signal severity.

If you're stuck with a legacy app that only writes to files, the fix inside the container is often trivial — symlink the file to stdout, which is exactly what the official nginx image does:

```dockerfile
RUN ln -sf /dev/stdout /var/log/app/app.log \
 && ln -sf /dev/stderr /var/log/app/error.log
```

## kubectl logs mastery

This is the tool you'll use most in your Kubernetes career. Learn the flags.

```bash
# Follow live logs (Ctrl-C to stop)
kubectl logs -f deploy/checkout-api

# Time-bounded — do this instead of paging through everything
kubectl logs deploy/checkout-api --since=15m
kubectl logs deploy/checkout-api --since-time=2026-07-03T09:00:00Z

# Last N lines
kubectl logs deploy/checkout-api --tail=100

# Kubelet-added timestamps — essential when your app's own timestamps are missing or wrong
kubectl logs deploy/checkout-api --timestamps --tail=20
```

### --previous: the crashed-container lifesaver

When a container crashes, the pod object survives and a new container starts in its place. `kubectl logs` shows the *new* container — usually a boring startup sequence. The reason it crashed is in the *previous* container's log:

```bash
kubectl logs checkout-api-7d4b9fc6c-x2k4f --previous
```

```console
...
Exception in thread "main" java.lang.OutOfMemoryError: Java heap space
	at java.base/java.util.Arrays.copyOf(Arrays.java:3512)
	at com.shop.checkout.CartCache.loadAll(CartCache.java:88)
```

This is the first command to run on any [CrashLoopBackOff](/troubleshooting/crashloopbackoff/). It only keeps **one** previous instance — the one before that is gone — so capture it before the next crash overwrites it.

### Multi-container pods and selectors

```bash
# Pod has more than one container? Name it with -c (kubectl lists candidates if you guess wrong)
kubectl logs checkout-api-7d4b9fc6c-x2k4f -c istio-proxy
kubectl logs checkout-api-7d4b9fc6c-x2k4f --all-containers

# Logs across ALL pods matching a label, with each line prefixed by its source pod
kubectl logs -l app=checkout-api --prefix --tail=50
```

```console
[pod/checkout-api-7d4b9fc6c-x2k4f/app] {"level":"INFO","msg":"order 4412 confirmed"}
[pod/checkout-api-7d4b9fc6c-9jwq2/app] {"level":"ERROR","msg":"payment gateway timeout"}
```

:::caution
`kubectl logs -l ...` caps concurrent streams (default 5 pods) and doesn't follow new pods that appear. For serious multi-pod tailing, [stern](https://github.com/stern/stern) is the community-standard client-side tool — it needs no cluster privileges beyond what you already have.
:::

## Where logs physically live — and why they vanish

Container stdout is written by the runtime to files on the **node**, at `/var/log/pods/<namespace>_<pod>_<uid>/<container>/0.log`. When you run `kubectl logs`, the API server asks the kubelet on that node to read the file back to you. Three consequences:

1. **Kubelet rotation caps history.** Chatty containers can rotate through their entire retention in minutes. `kubectl logs` only reads current + rotated files on that node; older lines are gone.
2. **Logs die with the pod.** Delete a pod, and its log files are cleaned up. A pod evicted or garbage-collected after a Deployment rollout takes its logs with it.
3. **Logs die with the node.** Node gets recycled, logs are gone — nothing you can do about it, which is why durable retention needs [log collection](/observability/log-collection/).

:::danger[Get logs before you delete]
The reflex of "it's broken, let me delete the pod so it restarts" destroys your evidence. Always capture first:

```bash
kubectl logs broken-pod --previous > crash.log 2>&1 || true
kubectl logs broken-pod > current.log
kubectl describe pod broken-pod > describe.txt
kubectl delete pod broken-pod   # NOW you may delete it
```
:::

## Sidecar logging patterns — and when they're justified

A logging sidecar is a second container in the pod that reads log files from a shared `emptyDir` volume and streams them to stdout or ships them directly. It's a workaround, not a pattern to aspire to:

```yaml
spec:
  containers:
    - name: legacy-app        # writes /logs/audit.log, can't be changed
      volumeMounts:
        - { name: logs, mountPath: /logs }
    - name: audit-tailer
      image: busybox:1.36
      args: [/bin/sh, -c, 'tail -n+1 -F /logs/audit.log']
      volumeMounts:
        - { name: logs, mountPath: /logs, readOnly: true }
  volumes:
    - name: logs
      emptyDir: {}
```

Justified when: a vendor binary hard-codes file output, or you need one file stream (e.g. an audit log) kept separate from the app's main stdout. Not justified when you control the app's logging config — fix the app instead. Every sidecar costs memory/CPU requests, complicates `kubectl logs` (now you need `-c`), and adds a restart-ordering headache.

## Multiline stack traces: why JSON logging fixes them

Node agents read log files **line by line**. A Java stack trace is one logical event spanning 40 physical lines, so the collector indexes it as 40 separate one-line "events" — the search backend shows you `\tat com.shop.CartCache.loadAll(CartCache.java:88)` with no exception message, no context, no ordering guarantee. Multiline-parsing rules in Fluent Bit can stitch traces back together, but they're regex-fragile and per-format.

The robust fix is on your side: **structured JSON logging**, where the entire stack trace is a single escaped string inside a single line:

```json
{"timestamp":"2026-07-03T09:14:22.031Z","level":"ERROR","logger":"com.shop.CartCache","message":"cache reload failed","stack_trace":"java.lang.IllegalStateException: pool exhausted\n\tat com.shop.CartCache.loadAll(CartCache.java:88)\n\t...","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736"}
```

One line, one event, atomically shipped and indexed, with fields you can filter on. For Java: Logback with `logstash-logback-encoder`, or Log4j2's `JsonTemplateLayout`. Add `trace_id` and you get log/trace correlation for free — see [Tracing](/observability/tracing/).

:::tip
Human-unreadable in the terminal? Pipe through jq: `kubectl logs deploy/checkout-api --tail=50 | jq -r '"\(.level)\t\(.message)"'`. Or make JSON output conditional on an env var and keep pretty logs for local dev.
:::

## Changing log levels at runtime

You will want DEBUG logs during an incident and you will not want to redeploy to get them. Options, best first:

- **Admin endpoint** — Spring Boot actuator (`POST /actuator/loggers/com.shop --data '{"configuredLevel":"DEBUG"}'` via `kubectl port-forward`), or your framework's equivalent. Instant, no restart, resets on pod restart (a feature: no forgotten DEBUG in prod).
- **Env var + rollout** — `LOG_LEVEL` read at startup, changed via `kubectl set env deploy/checkout-api LOG_LEVEL=DEBUG`. Triggers a rolling restart; fine when the problem reproduces on fresh pods.
- **ConfigMap-mounted config with hot reload** — Log4j2's `monitorInterval` re-reads a mounted file when the ConfigMap updates (mounted ConfigMaps propagate in ~a minute). See [ConfigMap and Secret Rotation](/operations/configmap-secret-rotation/).

Whatever you pick, make sure DEBUG doesn't log request bodies or secrets — that data lands in the cluster's log store with a retention policy you don't control.

## Checklist

- [ ] App logs to stdout/stderr only; no in-app rotation
- [ ] JSON format, one event per line, stack traces embedded as a field
- [ ] `level`, `timestamp`, `logger`, `message`, `trace_id` fields present
- [ ] Team knows `--previous`, `--since`, `-l --prefix`, and `-c` cold
- [ ] "Capture logs before deleting pods" is written into your incident runbook
- [ ] A runtime log-level mechanism exists and is documented
