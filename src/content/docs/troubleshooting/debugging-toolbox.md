---
title: Debugging Toolbox
description: kubectl debug, ephemeral containers, pod copies, port-forward, kubectl cp, and the debug images worth memorizing.
sidebar:
  order: 14
---

Modern production images are deliberately hostile to debugging: distroless, no shell, no package manager, read-only filesystem, non-root. Good for security, useless for `kubectl exec`. This page is the toolkit that works anyway — all of it namespace-scoped, none of it requiring node access.

## `kubectl exec` — and where it stops working

The classic, when the image cooperates:

```bash
kubectl exec -it <pod> -- sh                # or bash
kubectl exec <pod> -c <container> -- env    # one-shot, multi-container pods need -c
```

Exec runs a binary **that must already exist in the image**. Against distroless:

```console
$ kubectl exec -it api-7d4b9c6f8-2xkqp -- sh
error: Internal error occurred: ... exec: "sh": executable file not found in $PATH
```

No shell, no `ls`, no `curl`, nothing. This isn't a failure of your access — there is literally nothing to run. You need to *bring* tools to the pod. Enter ephemeral containers.

## `kubectl debug` with ephemeral containers — the main tool

An ephemeral container is injected into a **running** pod without restarting it. It shares the pod's network namespace (and optionally a container's process namespace), so you can inspect the pod from inside using an image that actually has tools:

```bash
kubectl debug -it <pod> --image=nicolaka/netshoot -- bash
```

You now have curl, dig, ss, tcpdump, netcat — *inside the pod's network identity*. `localhost:8080` is your app; DNS resolves exactly as the app sees it; NetworkPolicies apply to you as they apply to the pod. This is the single best way to answer "what does the network look like from this pod" ([Service Unreachable](/troubleshooting/service-unreachable/), [Debugging Network](/networking/debugging-network/)).

### `--target`: see the app's processes

By default the ephemeral container has its own PID namespace — `ps` shows only your shell. Target a container to share its process namespace:

```bash
kubectl debug -it <pod> --target=app --image=busybox -- sh
```

```console
/ # ps aux
PID   USER     COMMAND
    1 1000     /app/server --config=/etc/app/config.yaml
   14 1000     [worker]
   27 root     sh
/ # cat /proc/1/root/etc/app/config.yaml    # the target's filesystem, via procfs
/ # cat /proc/1/environ | tr '\0' '\n'      # the target's actual env vars
```

`/proc/<pid>/root/` is the quiet superpower: the *target container's* filesystem, readable from your tooled container. For JVM debugging, a JDK-image ephemeral container with `--target` gets you `jcmd` against the app process — see [Thread Dumps](/java/thread-dumps-jre-only/).

### `--profile`: fixing permission mismatches

The debug container's securityContext often needs adjusting — e.g. tcpdump needs capabilities, or the pod runs as non-root and your root-user debug image can't read shared files. `--profile` sets sensible presets:

| Profile | Effect |
|---|---|
| `general` | Sane default |
| `netadmin` | Adds `NET_ADMIN`/`NET_RAW` — needed for tcpdump, iptables inspection |
| `sysadmin` | Privileged — often blocked by cluster policy |
| `restricted` | Non-root, drops capabilities — for clusters enforcing the restricted PodSecurity standard (if injection is rejected with a security error, try this first) |

```bash
kubectl debug -it <pod> --image=nicolaka/netshoot --profile=netadmin -- bash
```

:::caution[Ephemeral containers are permanent residents]
You can't remove an ephemeral container from a pod — it stays (exited) in the pod spec until the pod dies. Fine for troubleshooting; just know repeated debugging accretes clutter, and the pod's next restart via Deployment rollout clears it. Also note they need the `pods/ephemeralcontainers` RBAC subresource — if injection is Forbidden, see [RBAC Denied](/troubleshooting/rbac-denied/).
:::

## `kubectl debug --copy-to` — debug the crash without the crash

Ephemeral containers need a *running* pod. For a crash-looper, make a **copy** of the pod with the startup command replaced:

```bash
kubectl debug <pod> -it --copy-to=crashpad --container=app -- sleep infinity
```

The copy has the same image, env, volumes, ConfigMaps, Secrets, and service account — but sleeps instead of crashing. Exec in (or add an ephemeral container if distroless) and run the real entrypoint by hand to watch it fail interactively. Full walkthrough in [CrashLoopBackOff](/troubleshooting/crashloopbackoff/).

Variations worth knowing:

```bash
# Different image, same pod context (test a fixed build against real config):
kubectl debug <pod> -it --copy-to=testpad \
  --set-image=app=registry.example.com/team/myapp:v1.4.3-rc1 -- sh

# Copy WITH shared process namespace across containers:
kubectl debug <pod> --copy-to=crashpad --share-processes -- sleep infinity
```

The copy is a bare pod: no owner references, no labels matching your Service (kubectl strips them), so it takes no traffic. **Delete it when done** — `kubectl delete pod crashpad` — it will not clean itself up.

## `kubectl port-forward` — poke services from your laptop

```bash
kubectl port-forward pod/<pod> 8080:8080          # localhost:8080 → pod:8080
kubectl port-forward svc/api 8080:80              # via the Service (one backend pod)
kubectl port-forward deploy/api 5005:5005         # first ready pod of the deployment
```

Perfect for hitting admin endpoints, actuator pages, or attaching a debugger ([Remote Debugging](/java/remote-debugging/)) without exposing anything. Two caveats: it bypasses Ingress and NetworkPolicy enforcement points, so "works over port-forward" does **not** prove the in-cluster path works ([Service Unreachable](/troubleshooting/service-unreachable/) tests that); and the tunnel dies with your terminal or an idle timeout — it's for humans, never for wiring systems together.

## `kubectl cp` — and its tar problem

```bash
kubectl cp <ns>/<pod>:/tmp/heap.hprof ./heap.hprof -c app
```

Fine print: `kubectl cp` is a wrapper around `kubectl exec ... tar`. **No `tar` in the image — no `cp`:**

```console
error: Internal error occurred: ... exec: "tar": executable file not found in $PATH
```

Fallbacks, best first:

```bash
# 1. Raw stream over exec — needs only cat:
kubectl exec <pod> -c app -- cat /tmp/heap.hprof > heap.hprof

# 2. Not even cat (distroless)? Ephemeral container + target's fs via procfs:
kubectl debug <pod> --target=app --image=busybox -it -- sh
#   then inside:  cat /proc/1/root/tmp/heap.hprof  (stream it out via a second exec)
```

For multi-gigabyte artifacts like heap dumps, there are better patterns (compression, shared volumes, object storage push) — the full menu is in [Getting Dumps Out](/java/getting-dumps-out/).

## `kubectl debug node/` — mostly not yours

```bash
kubectl debug node/worker-07 -it --image=busybox
```

This schedules a privileged pod on the node with the host filesystem mounted at `/host` — effectively node access without SSH. On any sensibly locked-down cluster **this is platform-only** (it requires creating privileged pods, usually blocked by policy in your namespaces). Know it exists so you can say "can you run a node debug pod on worker-07 and check kubelet logs?" in your escalation — see [Node Problems](/troubleshooting/node-problems/).

## Debug images cheat sheet

| Image | Size | What's in it | Reach for it when |
|---|---|---|---|
| `busybox` | ~2MB | sh, cat, ps, wget (limited), vi | Minimal poking; fastest pull — full applet tour and the copy-the-static-binary-in trick in [The BusyBox Toolkit](/troubleshooting/busybox/) |
| `nicolaka/netshoot` | ~300MB | tcpdump, dig, nmap, ss, curl, iperf, conntrack, jq | Any network question — the kitchen sink |
| `curlimages/curl` | ~15MB | curl + sh | HTTP checks; small enough for strict clusters |
| `eclipse-temurin:21` (full JDK) | ~450MB | jcmd, jstack, jmap, jfr | JVM debugging against a JRE-only app container |
| `alpine` | ~8MB | sh + `apk add` anything | When you want small but extensible (needs egress) |
| `ubuntu` / `debian` | ~30–80MB | apt ecosystem | glibc tools, when musl (alpine/busybox) misbehaves |

:::tip[Mirror your debug images]
In air-gapped or proxied clusters, the mid-incident `kubectl debug --image=nicolaka/netshoot` fails with ImagePullBackOff exactly when you need it. Get your two or three debug images mirrored into the internal registry *now*, and keep the internal references in a team runbook. See [ImagePullBackOff](/troubleshooting/imagepullbackoff/).
:::

## Which tool for which situation

| Situation | Tool |
|---|---|
| Healthy pod, image has a shell | `kubectl exec` |
| Healthy pod, distroless | `kubectl debug` ephemeral + `--target` |
| Network question from the pod's viewpoint | ephemeral `netshoot` (`--profile=netadmin` for tcpdump) |
| Crash-looping pod | `kubectl debug --copy-to` + `sleep infinity` |
| Hit an internal endpoint from your laptop | `kubectl port-forward` |
| Extract a file | `kubectl cp` → `exec cat` → procfs fallback |
| Node-level inspection | Ask platform (`kubectl debug node/` is their tool) |
