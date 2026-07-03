---
title: Lifecycle and Ordering
description: The precise startup, restart, and termination semantics of native and classic sidecars — and how to debug a pod when one of several containers is the problem.
sidebar:
  order: 2
---

[Init and Sidecar Containers](/workloads/init-and-sidecar-containers/) introduced the headline: since 1.28/1.29, an init container with `restartPolicy: Always` becomes a **native sidecar** with startup ordering, sane Job behavior, and shutdown-after-the-app guarantees. This article is the fine print — the exact state machine, because every one of these details corresponds to a real outage pattern.

## Native sidecars, precisely

A native sidecar is declared in `spec.initContainers` with the one field that changes its contract:

```yaml
spec:
  initContainers:
    - name: proxy
      image: registry.example.com/mesh/proxy:1.22
      restartPolicy: Always          # <- native sidecar
      ports:
        - containerPort: 15001
      startupProbe:
        httpGet: { path: /healthz/ready, port: 15021 }
        periodSeconds: 1
        failureThreshold: 30
  containers:
    - name: app
      image: registry.example.com/shop/orders:2.4.1
```

Four properties follow from that field, and each deserves precision.

### Startup: init order, gated by startupProbe

The kubelet walks `initContainers` **in list order**. A normal init container must exit 0 before the next entry runs. A native sidecar doesn't exit — instead, the sequence proceeds when the sidecar has **started**, or, if it declares a `startupProbe`, when that probe **passes**.

This makes the startup probe an **ordering lever**, not just a health check. Without one, "started" means "the container process launched" — your proxy binary is running but may be 3 seconds away from accepting connections when the app fires its first request. With one, you get a hard guarantee: *nothing later in the pod starts until this sidecar answers its probe.*

```text
initContainers order:  [render-config (exit 0)] → [proxy (startupProbe passes)] → [log-shipper (started)]
then containers:       [app starts]
```

Order your `initContainers` list deliberately: the proxy that everything's traffic flows through goes before the log shipper that merely tails files. And tune the probe honestly — a sidecar that takes 10s to warm up with a `periodSeconds: 10` probe adds up to 10 wasted seconds of quantization to every pod start. Probe timing mechanics are covered in [Health Check Knobs](/tuning/health-check-knobs/).

:::caution[A slow sidecar startup probe blocks everything behind it]
The gate works both ways. If your native sidecar's startupProbe can't pass — mesh control plane down, bad probe port — the pod sits in `Init:1/2` forever and your app **never starts**. You've made the sidecar a hard startup dependency. That's usually what you want from a proxy (starting without it means traffic bypasses policy), but decide it on purpose, and set `failureThreshold` to fail visibly rather than hang silently.
:::

### Restarts during pod lifetime

`restartPolicy: Always` means what it says: if the sidecar crashes at any point in the pod's life, the kubelet restarts it (with the usual exponential backoff), **without** restarting the app containers and **without** re-running the init sequence. The app keeps running through the sidecar's outage — which is why the app needs to tolerate its sidecar briefly disappearing (connection refused to `127.0.0.1:15001` mid-flight) and why native sidecars support `livenessProbe` and `readinessProbe`, unlike normal init containers.

A crashing sidecar shows up as pod restarts even though your app never blinked:

```console
$ kubectl get pod orders-7d4b9c-x2m4p
NAME                  READY   STATUS    RESTARTS        AGE
orders-7d4b9c-x2m4p   1/2     Running   6 (2m ago)      3d4h
```

`RESTARTS` is a pod-level sum. Always check *which* container is restarting before assuming it's your app (see debugging, below).

### Termination: after the app, in reverse order

On pod termination, the kubelet stops the `containers` list first. Only once **all** main containers have exited does it send SIGTERM to native sidecars — in **reverse** of their init order: last started, first stopped. Order your list so the most foundational sidecar (the proxy everything's egress flows through) is *earliest* — it started first, so it's the last thing standing, still carrying traffic while later-listed helpers shut down.

This is the log-shipper win in one sequence: app gets SIGTERM, flushes its final log lines to the shared volume, exits; *then* the shipper gets SIGTERM, drains what the app just wrote, exits. With a classic sidecar, both got SIGTERM simultaneously and the shipper was in its own shutdown while the app's most interesting log lines — the dying breaths you need for the postmortem — were being written.

### Jobs complete

Native sidecars **do not count** toward Job pod completion. When the Job's main containers exit, the kubelet terminates the sidecars and the pod moves to `Succeeded`. This retired an entire genre of workaround (next section). If you run [Jobs and CronJobs](/workloads/jobs-and-cronjobs/) in a mesh-enabled namespace, native sidecar injection is the difference between Jobs that work and Jobs that hang at `1/2 Running` forever.

## Classic sidecars: the world before, still in your cluster

A classic sidecar is just a second entry in `spec.containers`. Its semantics — or lack thereof:

- **No startup ordering.** All entries in `containers` start concurrently, in no guaranteed sequence. The app-starts-before-proxy race is real: your app boots in 800ms, the Envoy next to it takes 3s to get config from the control plane, and your app's first outbound calls fail with connection refused or, worse, silently bypass the proxy's iptables rules mid-setup.
- **No termination ordering.** Everything gets SIGTERM at once.
- **Jobs never complete.** The app exits 0; the sidecar keeps running; the pod stays `Running`; the Job never finishes; your CronJob's `concurrencyPolicy: Forbid` then skips every subsequent run. A classic and expensive failure chain.

The historical hacks are worth recognizing because you'll still find them in older manifests and Helm charts:

```yaml
# Hack 1: the wait script — app entrypoint polls the proxy before exec'ing the real binary
command: ["sh", "-c", "until curl -fsS localhost:15021/healthz/ready; do sleep 1; done; exec /app/server"]
```

```yaml
# Hack 2 (Istio-specific): make injection add a postStart gate on the proxy
# so the kubelet won't start later containers until Envoy is ready.
# Relies on the (unguaranteed but stable) in-order container start behavior.
annotations:
  proxy.istio.io/config: '{ "holdApplicationUntilProxyStarts": true }'
```

And for the Job problem: apps that `curl -X POST localhost:15020/quitquitquit` the proxy's admin endpoint as their last act. If you see these in a codebase on a 1.29+ cluster, they're candidates for deletion in favor of native sidecars — but confirm the mesh actually injects natively first (Istio does when the cluster supports it and `ENABLE_NATIVE_SIDECARS` is on; ask your platform team).

### Is the native mechanism available to you?

You can't list feature gates on a managed cluster, but `kubectl version` gets you nearly all the way — 1.29+ means on-by-default beta, 1.33+ means GA. The empirical test costs one throwaway pod:

```console
$ kubectl apply -f native-sidecar-probe.yaml
# Old API server (<=1.27, or 1.28 with the gate off):
The Pod "probe" is invalid: spec.initContainers[0].restartPolicy: Forbidden: may not be set for init containers
# New enough: pod is created and runs.
```

## Resource accounting: the formula changes

The intro article gave the classic effective-request formula. Native sidecars run for the pod's whole life, so they move from the *max* side to the *sum* side:

```text
effective request = max( max(non-sidecar init container requests),
                         sum(app containers) + sum(native sidecars) )
```

Worked example — a pod with a 1-CPU migration-check init container, a 100m proxy sidecar, a 50m log shipper, and a 500m app:

```text
init (run-to-completion):  max(1000m) = 1000m
steady state:              500m + 100m + 50m = 650m
effective request:         max(1000m, 650m) = 1000m
```

The pod schedules as 1 CPU because of the init container's brief peak, even though it *runs* at 650m — a reason to keep init requests lean. Drop the init container's request to 200m and the pod schedules at 650m. Note also that init containers behind a native sidecar in list order run *concurrently with it*, so strictly the kubelet accounts each init stage as that init container's request plus all already-started sidecars — one more reason to put big one-shot init work *before* your sidecars in the list. Full requests/limits background: [Resources and QoS](/workloads/resources-and-qos/) and sizing methodology in [Requests, Limits, and the Knobs That Matter](/tuning/requests-limits-knobs/).

## Probes on sidecars: one container can NotReady the fleet

Every container — app, classic sidecar, native sidecar — gets its own probes, and the pod's `Ready` condition is the AND of all of them plus any readiness gates. Consequences:

- A sidecar failing its readinessProbe pulls the **whole pod** out of every Service's endpoints, even though the app container is serving fine on its port.
- Now scale that: the sidecar is *identical in every replica*. When it fails for an environmental reason — mesh control plane unreachable, log backend down and the shipper's health endpoint reports unhealthy on a full buffer — it fails **everywhere at once**. Sixty healthy app containers, zero Ready pods, total outage, caused by a helper.

This is the sharpest knife in the drawer, and the mitigation is a design question per sidecar: *should this sidecar's failure remove the pod from service?* For a mesh proxy, yes — traffic through a broken proxy is worse than no traffic. For a log shipper, **no** — degrade to losing logs, not losing the service. Give the shipper a livenessProbe if you want it restarted on wedge, but think hard before giving an auxiliary sidecar a readinessProbe at all. Probe semantics in depth: [Health Checks](/workloads/health-checks/).

:::danger[War story shape you should recognize]
"All pods NotReady across every namespace that has the sidecar, apps' own logs show normal operation, `kubectl describe` shows `Readiness probe failed` on the same container name everywhere." That's not sixty app bugs; that's one sidecar with a shared external dependency baked into its readiness. Check the sidecar's dependency (control plane, log backend, secrets backend) first.
:::

## Shutdown, in full

The complete termination sequence for a pod with native sidecars:

1. Pod is marked for deletion; it's removed from Service endpoints (asynchronously — keep serving briefly).
2. `preStop` hooks run on **main containers**, then SIGTERM to main containers.
3. Kubelet waits for main containers to exit.
4. `preStop` then SIGTERM to native sidecars, in reverse init order.
5. Anything still alive at `terminationGracePeriodSeconds` gets SIGKILL. The countdown started at step 1 and is **pod-scoped** — one shared budget, not per-container.

That last point is where the math bites. Default grace is 30s. Suppose your app needs up to 40s to drain in-flight requests, and your log shipper needs up to 20s to flush its buffer *after* the app exits. The budget you need is roughly:

```text
terminationGracePeriodSeconds >= preStop delay + app drain + sidecar flush + margin
                              >= 5 + 40 + 20 + 5 = 70
```

Set it to 30 (the default) and the sequence dies at t=30: app killed mid-drain or, if the app just barely finished, shipper SIGKILLed with a full buffer — the final, most valuable log lines lost precisely when you need them. Symptoms are quiet: exit code 137 on whichever container was still running, and gaps at the end of incident-time logs.

```yaml
spec:
  terminationGracePeriodSeconds: 70
  initContainers:
    - name: log-shipper
      restartPolicy: Always
      # fluent-bit exits after flushing on SIGTERM; give it a grace period of its own
      env:
        - name: FLB_GRACE
          value: "20"
```

`preStop` hooks work on native sidecars too, and the common use is a short sleep on the *proxy* so it keeps serving egress while the app drains — but remember every second of every hook spends the same shared budget. If you add sleeps, raise `terminationGracePeriodSeconds` in the same commit.

## Debugging multi-container pods

Everything you know from single-container debugging works — you just have to aim it. The [Debugging Toolbox](/troubleshooting/debugging-toolbox/) covers the general kit; here's the multi-container aim.

**Which container is the problem?** `describe` gives per-container state, last state, and exit codes:

```console
$ kubectl describe pod orders-7d4b9c-x2m4p
...
Init Containers:
  proxy:
    State:          Running
    Ready:          True
    Restart Count:  0
Containers:
  orders:
    State:          Waiting
      Reason:       CrashLoopBackOff
    Last State:     Terminated
      Reason:       OOMKilled
      Exit Code:    137
    Restart Count:  6
```

Or the compact version for scripting and quick scans:

```console
$ kubectl get pod orders-7d4b9c-x2m4p -o jsonpath='{range .status.containerStatuses[*]}{.name}{" restarts="}{.restartCount}{" last="}{.lastState.terminated.reason}{"\n"}{end}'
orders restarts=6 last=OOMKilled
```

Note native sidecars report under `status.initContainerStatuses`, not `containerStatuses` — check both.

**Exit codes**, the short table worth memorizing:

| Exit code | Meaning | Typical cause in a sidecar context |
|---|---|---|
| 0 | Clean exit | Classic sidecar in a Job "finished" — or a sidecar that shouldn't exit, exiting |
| 1 / 2 | App error | Sidecar misconfiguration — bad config file, bad flags |
| 137 | SIGKILL (128+9) | OOMKilled, **or** killed at grace-period expiry — check `Reason` to tell them apart |
| 139 | SIGSEGV (128+11) | Sidecar binary crash — often after an injected-image upgrade |
| 143 | SIGTERM (128+15) | Normal termination the container handled cleanly |

**Logs and exec, always with `-c`.** `kubectl logs <pod> --all-containers=true --prefix` for the first look; `-c <name> --previous` for the crash before the restart. And for a sidecar image with no shell (distroless proxies), attach an ephemeral container instead of fighting `exec`:

```bash
kubectl debug orders-7d4b9c-x2m4p -it --image=busybox:1.36 --target=proxy -- sh
```

`--target` puts the ephemeral container in the *named container's* process namespace — you can inspect the proxy's processes and network view without the proxy image containing so much as `ls`. Ephemeral containers coexist fine with sidecars; they're a third list (`spec.ephemeralContainers`) with no probes and no restarts.

## shareProcessNamespace: signals across containers

By default each container has its own PID namespace: the sidecar cannot see, let alone signal, the app's processes. `shareProcessNamespace: true` on the pod spec collapses them into one namespace, and that enables the pattern that justifies it: **a sidecar that signals the app**. Config reloader SIGHUPs nginx; a tools sidecar sends `kill -3` to a JVM for a thread dump on a JRE-only image ([full walkthrough](/java/thread-dumps-jre-only/)); a debug sidecar straces the app.

```yaml
spec:
  shareProcessNamespace: true
```

```console
$ kubectl exec orders-7d4b9c-x2m4p -c tools -- sh -c 'ps -o pid,comm | head -4'
  PID COMMAND
    1 pause
   14 java
   43 fluent-bit
```

The trade-offs, stated plainly:

- **PID 1 changes.** The pause container becomes PID 1, not your app. Apps that install signal handlers assuming they're PID 1, or rely on PID-1 zombie reaping, behave differently. Most modern runtimes don't care; some old entrypoints do.
- **Security boundary erodes.** Every container sees every process, its command line (`/proc/<pid>/cmdline` — secrets passed as CLI args are now readable pod-wide), its environment via `/proc/<pid>/environ` if UIDs align, and its open file descriptors. A compromised sidecar goes from "shares a network namespace" to "can signal and inspect the app process". Filesystems remain per-container, but `/proc/<pid>/root` lets a sufficiently-privileged (same UID or root) container reach into another container's filesystem.
- Any container with `SYS_PTRACE` can trace the others outright.

The rule: turn it on when a recipe requires cross-container signaling, run all containers as the same non-root UID or deliberately distinct UIDs depending on which direction you're protecting, and don't leave it on "for convenience" in pods that don't need it.

Next: [Sidecar Recipes](/sidecars/recipes/) puts all of this to work — five complete, sized, failure-mode-annotated patterns.
