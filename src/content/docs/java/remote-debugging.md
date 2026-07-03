---
title: Remote Debugging a JVM in a Pod
description: Attaching an IDE debugger to a JVM in Kubernetes over JDWP and port-forward, and the probe-killing, traffic-eating hazards of breakpoints in production.
sidebar:
  order: 6
---

Sometimes logs and dumps aren't enough and you need to *watch the code run*.
The JVM's debug protocol (JDWP) works fine through `kubectl port-forward` —
no cluster changes, no exposed ports, no JDK in the image (JDWP is part of
the JVM itself, including jlink runtimes with default modules). The
technique is easy. The judgment — where a paused thread meets a liveness
probe — is the actual content of this article.

## Enabling JDWP

The JVM only listens for debuggers if started with the agent:

```text
-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005
```

- `server=y` — the JVM listens; your IDE connects.
- `suspend=n` — start the app normally; don't wait for a debugger.
  (`suspend=y` blocks startup until an IDE attaches — occasionally useful for
  debugging initialization, but your readiness probe will hate it.)
- `address=*:5005` — on JDK 9+, plain `address=5005` binds **localhost
  only**, which is actually fine for port-forward (the kubelet connects from
  within the pod's network namespace)... but `*:5005` is the conventional,
  unambiguous form. On JDK 8 the syntax is `address=5005` and it binds all
  interfaces.

JDWP is unauthenticated remote code execution by design. Inside a pod with no
Service exposing 5005 and access only via port-forward, the blast radius is
"people who already have exec-level access". Never put 5005 in a Service or
Ingress. If your namespace has NetworkPolicies, all the better.

### Delivering the flag: env var + restart

You don't rebuild the image; every JVM honors `JAVA_TOOL_OPTIONS`:

```yaml
# In the Deployment (or via kubectl set env for a quick, drift-y version):
env:
  - name: JAVA_TOOL_OPTIONS
    value: "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"
```

```bash
# The fast path during an investigation:
kubectl set env deployment/myapp \
  JAVA_TOOL_OPTIONS="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"
# triggers a rolling restart; confirm the JVM picked it up:
kubectl logs deploy/myapp | grep -m1 "Listening for transport"
```

```console
Picked up JAVA_TOOL_OPTIONS: -agentlib:jdwp=...
Listening for transport dt_socket at address: 5005
```

Two delivery philosophies:

- **Ad-hoc `kubectl set env`** — fast, but now the live Deployment differs
  from what's in git. Your CD system may revert it mid-session (annoying) or
  may *not* (worse: debug agent left enabled for months). See
  [Drift and CI/CD](/operations/drift-and-cicd/).
- **A baked "debug profile"** — a values flag / kustomize overlay in the repo
  that adds the env var, deployed through the normal pipeline. Slower to
  activate, but reviewable, revertible, and impossible to forget silently.
  For anything beyond a one-hour emergency, use this.

A restart is unavoidable either way — JDWP cannot be enabled on a running
JVM. Which is worth saying out loud: **the restart may clear the state you
wanted to debug.** For "why is this instance wedged *right now*", use
[thread dumps](/java/thread-dumps-jre-only/) first; the debugger is for
reproducible logic problems.

## Connecting the IDE

```bash
kubectl port-forward deploy/myapp 5005:5005
# or a specific pod — deploy/ picks one pod for you, fine for single-replica debug
```

Then in the IDE:

- **IntelliJ:** Run → Edit Configurations → `+` → Remote JVM Debug → host
  `localhost`, port `5005` → Debug. Make sure the open source tree matches
  the deployed build, or breakpoints land on the wrong lines.
- **VS Code:** `java` launch config with `"request": "attach",
  "hostName": "localhost", "port": 5005`.

The status bar shows *Connected to the target VM*. You are now holding a
tool that can stop production.

## What a breakpoint actually does to a pod

A standard breakpoint suspends — depending on IDE settings — either the one
thread or **all threads** (IntelliJ's default). All-threads means:

- No requests are served. Every in-flight call times out.
- **Liveness and readiness probes stop answering.** After
  `failureThreshold × periodSeconds` (often 30 s), the kubelet decides your
  container is dead and **kills it**, taking your debug session and the pod
  with it. This is the classic first-time-debugging-in-k8s story, and now
  it won't be yours.
- HTTP health checks from load balancers, service meshes, and monitoring all
  go red at once. Expect pages.

If you must sit at a breakpoint on a live pod, buy yourself time first:

```bash
# Temporarily make probes very tolerant (drift alert — revert after):
kubectl patch deploy myapp --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe/failureThreshold","value":30},
  {"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe/periodSeconds","value":30}]'
```

### The better pattern: a debug replica off the Service

Don't debug a pod that's taking traffic. Clone one that isn't:

1. Copy the Deployment's pod template into a standalone Pod (or a
   1-replica Deployment) named `myapp-debug`.
2. **Change or remove the labels the Service selects on** (e.g. drop
   `app: myapp` or add `debug: "true"` and keep it out of the selector) — no
   Service endpoints, no traffic, no one notices a paused JVM.
3. Remove liveness/readiness probes entirely in the debug copy and add the
   JDWP env var.
4. Port-forward to *that* pod and debug at leisure.

```bash
kubectl get deploy myapp -o yaml > /tmp/debug.yaml
# edit: kind→Pod or replicas: 1, name myapp-debug, labels debug-only,
#        add JDWP env, delete probes
kubectl apply -f /tmp/debug.yaml
kubectl port-forward pod/myapp-debug 5005:5005
```

You can often reproduce the bug by port-forwarding the app port too and
replaying the offending request with curl. Same code, same config, same
namespace, zero production impact.

An alternative some teams use: `kubectl debug pod/<name> --copy-to=myapp-debug`
copies a running pod; you still need the JDWP env var, so in practice
editing the Deployment template is simpler.

## Safer tools than breakpoints

Modern debuggers can observe without stopping:

- **Logpoints / non-suspending breakpoints** (IntelliJ: right-click the
  breakpoint → uncheck *Suspend*, check *Evaluate and log*): print an
  expression every time the line is hit. It's `printf` debugging with no
  redeploy — usually all you actually needed.
- **Conditional breakpoints:** suspend only when `order.getId() == 12345L` —
  the poisoned request — instead of on all ten thousand healthy ones. The
  condition evaluates in the JVM; heavy conditions add per-hit latency,
  so keep them cheap.
- **Watchpoints on a field** to find who mutates shared state — expensive,
  debug-replica only.
- **HotSwap** (reload changed method bodies over JDWP) technically works, but
  now production runs code that exists in no image. Don't — see
  [Live patching](/operations/live-patching/) for when rules like this
  may bend and how to do it accountably.

:::caution[Performance while attached]
`suspend=n` with no debugger attached costs approximately nothing on modern
JVMs. An *attached* debugger disables some JIT optimizations in debugged
frames, and method-entry watchpoints or hot conditional breakpoints can be
brutal. Fine on a debug replica; measurable on a loaded pod.
:::

## Always clean up

The debugging session ends when the bug is understood — the *change* ends
when production matches git again:

```bash
kubectl set env deployment/myapp JAVA_TOOL_OPTIONS-   # trailing '-' removes it
kubectl delete pod myapp-debug
kubectl rollout status deploy/myapp
# and revert any probe patches — diff live vs git to be sure:
kubectl diff -f deploy/myapp.yaml
```

A JDWP agent left listening is an RCE port waiting for a lateral attacker,
plus a pod that pauses if anyone port-forwards and attaches by accident.
Make "remove debug flags" a checklist item in the incident template, and let
your CD system's drift detection be the backstop, not the plan —
[Drift and CI/CD](/operations/drift-and-cicd/) covers making that
reliable.
