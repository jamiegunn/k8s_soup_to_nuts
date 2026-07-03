---
title: Init and Sidecar Containers
description: Multi-container pods done right — init container semantics, native sidecars, the classic sidecar patterns, and the anti-patterns that turn one pod into two problems.
sidebar:
  order: 13
---

A pod is not "a container". It's a group of containers that share a network namespace, an IP, and optionally volumes and a process namespace. Most pods only need one container, and that's fine. But when you genuinely need helpers — wait for a dependency, ship logs, terminate TLS, reload config — Kubernetes gives you two distinct mechanisms with very different semantics: **init containers** (run before, in order, to completion) and **sidecars** (run alongside, for the pod's whole life). Mixing up which one you need is how you end up with Jobs that never finish and rollouts that run database migrations twice.

:::tip[There's a whole section on this]
This article covers the fundamentals. The [Sidecars section](/sidecars/overview/) goes deeper: [lifecycle and ordering mechanics](/sidecars/lifecycle-and-ordering/) (native sidecars, shutdown ordering, the shared grace-period budget) and [production-ready recipes](/sidecars/recipes/) (log shipper, config reloader, secrets fetcher, and more).
:::

## Init containers: sequential, run-to-completion

Init containers live in `spec.initContainers` and run **one at a time, in the order listed, each to successful completion**, before any container in `spec.containers` starts. If one fails, the kubelet retries it according to the pod's `restartPolicy` (for a Deployment that's `Always`, so it retries forever with backoff). The app containers do not start until every init container has exited 0.

Key semantics that bite people:

- Init containers run again on **pod restart** — a rescheduled or evicted pod reruns the whole init sequence. Init work must be idempotent.
- They do **not** support `livenessProbe`, `readinessProbe`, or `lifecycle` hooks. They run, they exit, that's the contract.
- They see the same volumes and (their own) env vars, and run under the same ServiceAccount as the rest of the pod.

### Classic use 1: wait for a dependency

Your app crashes at boot if the database isn't reachable. You could fix the app (best), rely on [CrashLoopBackOff](/troubleshooting/crashloopbackoff/) restarts as a crude retry loop (works, noisy), or gate startup with an init container:

```yaml
initContainers:
  - name: wait-for-db
    image: busybox:1.36
    command:
      - sh
      - -c
      - |
        until nc -z -w 2 postgres.data.svc.cluster.local 5432; do
          echo "waiting for postgres..."
          sleep 2
        done
        echo "postgres is up"
    resources:
      requests: { cpu: 10m, memory: 16Mi }
      limits: { memory: 32Mi }
```

```console
$ kubectl logs orders-7d4b9c-x2m4p -c wait-for-db
waiting for postgres...
waiting for postgres...
postgres is up
```

Note the `-w 2` timeout on `nc` — without it a blackholed connection (NetworkPolicy drop, see [Network Policies](/networking/network-policies/)) hangs forever instead of looping visibly.

### Classic use 2: schema migration — and why it bites during rollouts

Running `flyway migrate` or `alembic upgrade head` in an init container is common and mostly fine — until a rolling update. During a rollout you have **old and new pods running simultaneously**, and if your Deployment has 5 replicas, the migration init container runs in **every new pod**, concurrently, racing each other for the migration lock.

Consequences:

- Your migration tool must handle concurrent runners (Flyway and Liquibase lock; hand-rolled SQL scripts usually don't).
- Old pods run old code against the new schema for the duration of the rollout. Migrations must be backward-compatible or you get a window of 500s.
- A broken migration doesn't fail once — it fails in every new pod, the rollout stalls at `Init:CrashLoopBackOff`, and old pods keep serving. That last part is actually the good news.

The cleaner pattern for anything non-trivial: run migrations as a [Job](/workloads/jobs-and-cronjobs/) triggered by your pipeline *before* the Deployment update, and keep the init container (if any) as a cheap "is schema at version >= N" check.

### Classic use 3: fetch-and-render config or secrets

Pull a template plus values, render the real config file into a shared `emptyDir`, and let the app read it:

```yaml
initContainers:
  - name: render-config
    image: registry.example.com/tools/envsubst:1.2
    command: ["sh", "-c", "envsubst < /templates/app.conf.tmpl > /config/app.conf"]
    envFrom:
      - secretRef: { name: orders-db }
    volumeMounts:
      - { name: templates, mountPath: /templates }
      - { name: rendered, mountPath: /config }
containers:
  - name: app
    volumeMounts:
      - { name: rendered, mountPath: /etc/app, readOnly: true }
volumes:
  - name: templates
    configMap: { name: orders-config-tmpl }
  - name: rendered
    emptyDir: {}
```

This is also the standard shape for fetching secrets from an external vault when there's no CSI driver available to you.

### Classic use 4: permission fixups

An image writes to `/data` as UID 1000, but the volume mounts owned by root. `fsGroup` (see [Config Files and Volumes](/workloads/config-files-and-volumes/)) fixes group ownership for most volume types; when it can't, a one-shot `chown` init container running as root does:

```yaml
initContainers:
  - name: fix-perms
    image: busybox:1.36
    command: ["sh", "-c", "chown -R 1000:1000 /data"]
    securityContext: { runAsUser: 0 }
    volumeMounts:
      - { name: data, mountPath: /data }
```

:::caution
This requires the init container to run as root, which a `restricted` Pod Security namespace will reject — see [Pod Security](/workloads/pod-security/). Prefer `fsGroup` or fixing the image's expected UID first.
:::

## Resource accounting: max, not sum

Because init containers run *before* the app containers (never alongside them), the scheduler doesn't add their requests to the app's. The **effective pod request** for each resource is:

```text
effective request = max( max(all init container requests),
                         sum(all app + sidecar container requests) )
```

Same formula for limits. Practical upshot: a migration init container that requests 2Gi in a pod whose app containers sum to 512Mi makes the *pod* request 2Gi for scheduling purposes — you're paying for the peak, so keep init requests honest and small. Details on requests/limits mechanics live in [Resources and QoS](/workloads/resources-and-qos/).

## When init containers fail

The pod status tells you exactly where you are in the sequence:

```console
$ kubectl get pods
NAME                      READY   STATUS                  RESTARTS   AGE
orders-7d4b9c-x2m4p       0/1     Init:CrashLoopBackOff   4          3m
orders-7d4b9c-z8k1q       0/1     Init:1/2                0          20s
```

- `Init:1/2` — first of two init containers finished, second is running. Normal.
- `Init:Error` — an init container exited non-zero; retry pending.
- `Init:CrashLoopBackOff` — it keeps failing, kubelet is backing off.

Debug with per-container logs and describe:

```bash
kubectl logs orders-7d4b9c-x2m4p -c wait-for-db          # current attempt
kubectl logs orders-7d4b9c-x2m4p -c wait-for-db --previous
kubectl describe pod orders-7d4b9c-x2m4p                  # events + exit codes
```

`-c <name>` works everywhere — `logs`, `exec`, `debug` — and you'll need it constantly in multi-container pods. Without `-c`, kubectl picks the first app container and you'll stare at the wrong logs.

## Native sidecars: init containers with restartPolicy: Always

Since Kubernetes 1.28 (beta and on by default in 1.29, stable in 1.33), an init container can declare `restartPolicy: Always`, which turns it into a **native sidecar**:

```yaml
initContainers:
  - name: log-shipper
    image: fluent-bit:3.0
    restartPolicy: Always        # <- this one field changes everything
    volumeMounts:
      - { name: app-logs, mountPath: /var/log/app }
```

What that one field buys you over declaring the same container under `containers`:

1. **Startup ordering.** The sidecar starts *before* the app containers, in init order, and only needs to be *started* (or pass its `startupProbe`) — not exit — for the sequence to continue. Your proxy is accepting connections before the app makes its first outbound call.
2. **Jobs actually complete.** The classic failure: a Job pod with an app container plus a mesh-proxy sidecar under `containers`. The app exits 0, the proxy keeps running, the pod never terminates, the Job never completes. Whole cottage industries of "curl the Envoy admin port to make it quit" hacks exist for this. Native sidecars don't count toward Job completion — when the app containers finish, the sidecars are stopped and the pod completes.
3. **Shutdown ordering.** On pod termination, app containers are stopped first; native sidecars are terminated **after** the main containers exit, in reverse order. Your log shipper stays alive to flush the app's final log lines instead of dying mid-SIGTERM alongside it.

Native sidecars can have probes (unlike normal init containers), and their resource requests count in the *sum* side of the effective-request formula above, since they run for the pod's life.

### Is it available on your cluster?

You can't see feature gates, but the server version is enough:

```console
$ kubectl version
Client Version: v1.31.2
Server Version: v1.30.6
```

1.29+ means native sidecars work unless the platform team explicitly disabled the gate — rare, but a one-line question to them settles it. On 1.28 exactly, ask; the gate was off by default. Cheapest empirical test: apply a throwaway pod with a `restartPolicy: Always` init container — on an old API server it's rejected at admission with a validation error naming the field.

## Classic sidecar patterns — and when each is justified

### Log shipper

Justified only when the app **cannot** log to stdout (legacy file-only logger, multiple distinct log files). The default answer is: log to stdout and let the cluster's collection pipeline do its job — see [Log Collection](/observability/log-collection/). If you must ship files, share an `emptyDir` between app and a fluent-bit sidecar, and make it a *native* sidecar so it flushes on shutdown.

### Proxy / service mesh

You usually don't add this one — a mutating admission webhook injects it when your namespace is mesh-enabled (see [Admission Webhooks](/controllers/admission-webhooks/)). Understand what that does to *your* pod:

- `kubectl get pod -o yaml` shows containers you never wrote (`istio-proxy`, an `istio-init`/`istio-validation` init container). Your applied manifest and the live pod spec have diverged **by design**.
- The proxy's requests add to your pod's effective request — a 100m/128Mi proxy across 40 replicas is 4 CPUs of quota you didn't budget. Check the injected values, not your manifest, when quota math stops adding up.
- When traffic misbehaves, suspect the sidecar *first*: `kubectl logs <pod> -c istio-proxy`, and check readiness — a pod is only Ready when **all** containers are ready, so a proxy that can't reach the mesh control plane makes your perfectly healthy app NotReady.

### Config reloader

Watches a mounted ConfigMap volume and signals the app (HTTP endpoint or signal) when the file changes, for apps that only read config at boot. Justified when you can't change the app; needs `shareProcessNamespace: true` if it signals by PID.

## What containers in a pod share

| Mechanism | What it gives you | Enable with |
|---|---|---|
| `emptyDir` volume | Shared scratch files (logs, rendered config, sockets) | mount in both containers |
| localhost networking | Containers reach each other on `127.0.0.1:<port>` — no Service needed | free, always on |
| Process namespace | Containers see each other's processes, can send signals | `shareProcessNamespace: true` on the pod |

`shareProcessNamespace` is the underrated one for debugging: a tools sidecar (or `kubectl debug` ephemeral container) can see the app's PID and send it signals — which is exactly the trick for getting a thread dump out of a JRE-only Java image with `kill -3`. Full walkthrough in [Thread Dumps on JRE-only Images](/java/thread-dumps-jre-only/). Cost: processes and their `/proc` entries are visible across containers, and PID 1 becomes the pause container, which changes signal handling assumptions for apps that care about being PID 1.

:::tip[-c everywhere]
Every per-pod command takes `-c <container>`: `kubectl logs -c`, `kubectl exec -c`, `kubectl debug --target=<container>`. `kubectl logs <pod> --all-containers=true` is the fastest first look at a multi-container pod you don't know.
:::

## Anti-patterns

- **Sidecar as a second application.** If it has its own release cadence, its own team, or its own traffic, it's a separate Deployment behind a Service. Coupling two apps in one pod means they scale together, deploy together, and take each other down.
- **Init container doing a Job's work.** Database migrations, one-off backfills, index builds — anything that should run *once per release* rather than *once per pod* belongs in a [Job](/workloads/jobs-and-cronjobs/). Init containers run per pod, per restart, per node eviction.
- **`sleep 30` as dependency management.** A fixed sleep is a race condition with a delay. Use a real readiness check loop or fix the app's retry behavior.
- **Log shipper sidecar when stdout works.** You're paying memory and CPU per pod for something the node already does once.
- **Classic-container sidecar in a Job.** Covered above; use a native sidecar or the Job hangs forever.

The unifying test: *does this container have exactly the same lifecycle as the app?* Starts with it, scales with it, dies with it, meaningless without it — sidecar. Runs once before it — init container. Anything else — its own workload.
