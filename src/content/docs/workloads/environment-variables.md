---
title: Environment Variables
description: Every way env vars get into a container, precedence and collision rules, $(VAR) expansion, service links, JVM options variables, and how to debug what a container actually sees.
keywords:
  - env var shows literal $(VAR)
  - createcontainerconfigerror configmap not found
  - envfrom keys skipped invalid
  - invalidenvironmentvariablenames
  - enableservicelinks
  - kubectl set env deployment
  - java_tool_options
  - argument list too long
  - which env vars does my container have
  - envfrom precedence order
  - variable overwritten by service
sidebar:
  order: 11
---

Environment variables look like the simplest part of Kubernetes. Then one day `DB_HOST` is literally the string `$(DB_HOST)` in production, a pod won't start with `CreateContainerConfigError`, and a var you never defined is shadowing your config because someone created a Service named `redis`. The [Configuration overview](/workloads/configuration/) covers env vs volume mounts broadly; this article is the env-var deep dive.

## Every way env gets set

There are five mechanisms in your manifest, plus two sources that inject variables you never wrote. One consolidated example:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: payments-api
spec:
  enableServiceLinks: false        # see "Service links" below — you almost always want this
  containers:
  - name: app
    image: registry.example.com/payments-api:1.14.2
    # 1) envFrom: bulk-import every key from a ConfigMap/Secret.
    #    Processed FIRST, in list order — later sources win on duplicate keys.
    envFrom:
    - configMapRef:
        name: payments-config
    - secretRef:
        name: payments-secrets
      prefix: SECRET_              # every key gets this prefix: SECRET_DB_PASSWORD
    # 2) env: individual variables. Processed AFTER envFrom and beats it on collisions.
    env:
    - name: LOG_LEVEL              # literal value
      value: "info"
    - name: DB_HOST                # single key from a ConfigMap
      valueFrom:
        configMapKeyRef:
          name: payments-config
          key: db.host
    - name: FEATURE_FLAGS          # single key, tolerate absence
      valueFrom:
        configMapKeyRef:
          name: experimental-flags
          key: flags.json
          optional: true           # missing CM or key => var simply not set, pod still starts
    - name: DB_PASSWORD
      valueFrom:
        secretKeyRef:
          name: payments-secrets
          key: DB_PASSWORD
    # 3) Downward API fieldRef: pod metadata/status into env
    - name: POD_NAME
      valueFrom:
        fieldRef:
          fieldPath: metadata.name
    - name: POD_NAMESPACE
      valueFrom:
        fieldRef:
          fieldPath: metadata.namespace
    - name: POD_IP
      valueFrom:
        fieldRef:
          fieldPath: status.podIP
    - name: NODE_NAME
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
    # 4) resourceFieldRef: feed your own requests/limits to the app
    - name: MEMORY_LIMIT_MB
      valueFrom:
        resourceFieldRef:
          containerName: app
          resource: limits.memory
          divisor: 1Mi             # value arrives as "512", not "536870912"
    - name: CPU_REQUEST_MILLIS
      valueFrom:
        resourceFieldRef:
          containerName: app
          resource: requests.cpu
          divisor: 1m
    # 5) $(VAR) expansion — see the expansion section
    - name: DB_URL
      value: "postgres://$(DB_HOST):5432/payments"   # DB_HOST defined ABOVE, so this works
```

The two sources from *outside* your manifest:

- **The image's `ENV` instructions.** `PATH`, `JAVA_HOME`, `LANG`, whatever the Dockerfile set. Check with `docker inspect` on the image or `kubectl exec ... -- env` on a running pod. Anything in your pod spec overrides these.
- **Kubelet-injected service links.** `KUBERNETES_SERVICE_HOST`/`KUBERNETES_SERVICE_PORT` always, plus a pile of `FOO_SERVICE_HOST`-style variables for every Service in your namespace unless you disable them. Whole section below.

:::tip[resourceFieldRef is underused]
Runtimes and libraries that size thread pools or heaps by reading cgroups get it wrong often enough that passing `limits.memory` and `limits.cpu` explicitly is the robust play. `MEMORY_LIMIT_MB` with `divisor: 1Mi` gives your app one honest number to size against. If you don't set a limit, `resourceFieldRef` falls back to the **node's allocatable capacity** — a 64Gi number your app will happily try to use. Set limits; see [Resources and QoS](/workloads/resources-and-qos/).
:::

## Precedence and collision rules, precisely

The kubelet builds the final environment in this order, last write wins at each step:

1. **Image `ENV`** — the baseline.
2. **Service link variables** — injected by the kubelet (unless disabled).
3. **`envFrom` sources, in list order** — a duplicate key in a later source silently overwrites the earlier one. No warning, no event.
4. **`env` entries** — beat everything above, including `envFrom` and the image's `ENV`.

Two sharp edges:

- **Duplicate names inside `env` itself**: the API server accepts them and the last entry wins. Recent Kubernetes versions emit a warning on apply, older ones say nothing. Kustomize/Helm layering is the usual way duplicates sneak in.
- **Invalid keys in `envFrom` are silently skipped.** A ConfigMap is allowed to hold keys like `app.properties` or `9LIVES` that aren't valid env var names (must match `[A-Za-z_][A-Za-z0-9_]*`). `envFrom` just drops them, the pod starts fine, and the only trace is an event:

```console
$ kubectl get events --field-selector reason=InvalidEnvironmentVariableNames
LAST SEEN   TYPE      REASON                             OBJECT              MESSAGE
2m14s       Warning   InvalidEnvironmentVariableNames   pod/payments-api    Keys [app.properties, 9LIVES] from the EnvFrom configMap default/payments-config were skipped since they are considered invalid environment variable names.
```

If a var you swear is in the ConfigMap isn't in the container, check that event before anything else. Mixed-purpose ConfigMaps (env keys plus mounted files in one object) trigger this constantly — split them, or use file mounts as described in [Config Files and Volumes](/workloads/config-files-and-volumes/).

## `$(VAR)` expansion — and why yours prints literally

Kubernetes expands `$(VAR_NAME)` references in three places: `env[].value`, `command`, and `args`. This is kubelet-side substitution, not shell — there is no shell involved unless you run one.

The rules:

- In `env[].value`, only variables **already defined at that point** expand: earlier `env` entries, anything from `envFrom` (processed before all of `env`), and service link variables. Reference a var defined *later* in the list and you get the literal string `$(VAR_NAME)`. Order your `env` list dependency-first.
- In `command`/`args`, the fully resolved container environment is available.
- An unresolvable reference is left **as-is**, silently. That's the classic "why does my connection string contain `$(DB_HOST)`" bug: a typo'd name, a var defined below the reference, or a value that only exists in a volume-mounted file.
- Escape a literal with `$$`: `value: "cost is $$(5)"` produces `$(5)`. Needed when your app itself uses `$(...)` syntax.

```yaml
    command: ["java"]
    args: ["-jar", "/app/app.jar", "--server.port=$(HTTP_PORT)"]   # expands
    env:
    - name: HTTP_PORT
      value: "8080"
    - name: BROKEN
      value: "$(DEFINED_LATER)"    # stays literal — defined two lines down
    - name: DEFINED_LATER
      value: "oops"
```

:::caution[$(VAR) is not shell expansion]
`$VAR` and `${VAR}` mean nothing to Kubernetes — they pass through untouched and only expand if your entrypoint is a shell. Conversely, `$(VAR)` in a `sh -c` string is *command substitution* to the shell. If you wrap your command in `sh -c`, use shell syntax and let the shell do the work; don't mix the two.
:::

## Service links: the legacy env you didn't ask for

To support Docker-links compatibility circa 2015, the kubelet injects variables for **every Service that exists in your namespace when the pod starts**: `{SVC}_SERVICE_HOST`, `{SVC}_SERVICE_PORT`, plus `{SVC}_PORT_8080_TCP_ADDR`-style variants for each port. Service name uppercased, dashes to underscores.

Why this hurts in real namespaces:

- **Scale.** A namespace with 200 Services injects well over a thousand variables into every container. We've seen entrypoint scripts and JVM/Node startup measurably slow down iterating over them, and `kubectl exec` payloads bloat.
- **Collisions.** You define `REDIS_PORT=6379` in your ConfigMap; someone creates a Service named `redis`; the kubelet injects `REDIS_PORT=tcp://10.96.44.12:6379`. Your `env` entry wins over service links — but a var you *only* set in the image's `ENV` loses, and apps that parse `FOO_PORT` expecting a number choke on `tcp://...`.
- **Staleness.** Only Services that existed *before* the pod started are present, and the values never update. It's a snapshot masquerading as service discovery.

Opt out per pod and use DNS, which is what everything has used for a decade:

```yaml
spec:
  enableServiceLinks: false   # pod spec level, not container level
```

`KUBERNETES_SERVICE_HOST`/`KUBERNETES_SERVICE_PORT` are still injected regardless — client libraries need them for in-cluster API discovery. Everything else disappears. Talk to services as `redis.my-namespace.svc.cluster.local` (or just `redis` from the same namespace).

## Env is frozen at container start

The environment is resolved once, when the kubelet creates the container. Edit the ConfigMap behind an `envFrom` or `configMapKeyRef` and running containers see **nothing** — not on the next request, not ever. This is the fundamental difference from volume-mounted ConfigMaps, which do update in place (eventually). The full decision tree lives in [ConfigMap and Secret rotation](/operations/configmap-secret-rotation/): env-based config requires a pod restart, period.

`kubectl set env` is the sanctioned way to change env on a live workload — it patches the pod template, which triggers a normal rolling update:

```console
$ kubectl set env deployment/payments-api LOG_LEVEL=debug
deployment.apps/payments-api env updated
$ kubectl rollout status deployment/payments-api
deployment "payments-api" successfully rolled out
```

That's a real API change, not magic: new ReplicaSet, new pods, old ones drained. Which also means it's **drift** — your next CI/CD deploy from git will silently revert it. Fine for a debugging session, dangerous as a fix. [Live patching](/operations/live-patching/) covers the discipline around imperative changes; the short version is: patch, verify, then immediately commit the same change to the manifests.

## JVM patterns: the three options variables

Java shops accumulate env vars named `JAVA_OPTS`, `JAVA_TOOL_OPTIONS`, and `JDK_JAVA_OPTIONS` and treat them as interchangeable. They are not:

| Variable | Honored by | Notes |
|---|---|---|
| `JAVA_TOOL_OPTIONS` | **Any** JVM launch — `java`, embedded JVMs, JNI, forked child JVMs | JVMTI standard. Prints `Picked up JAVA_TOOL_OPTIONS: ...` to stderr. The reliable one. |
| `JDK_JAVA_OPTIONS` | The `java` launcher only, JDK 9+ | Ignored by JNI-embedded JVMs and anything that isn't literally the `java` binary. Can't inject a main class. |
| `JAVA_OPTS` / `CATALINA_OPTS` / `JVM_ARGS` | **Nothing in the JVM.** Pure convention read by start scripts (Tomcat's `catalina.sh`, many entrypoints) | If the entrypoint doesn't reference it, it does nothing. Grep the entrypoint before relying on it. |

This is why `JAVA_TOOL_OPTIONS` is the field-standard way to add JVM flags **without touching the image** — heap settings, GC logging, or a debug agent:

```yaml
    env:
    - name: JAVA_TOOL_OPTIONS
      value: "-XX:MaxRAMPercentage=75 -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"
```

Verify it took by looking for the `Picked up` line in `kubectl logs`. Container-aware heap sizing and its interaction with limits is in [JVM in Containers](/java/jvm-in-containers/); wiring that debug agent to your IDE is in [Remote Debugging](/java/remote-debugging/).

## Debugging what a container ACTUALLY has

`kubectl describe pod` shows what was *requested*. The container's real environment can differ (skipped invalid keys, image ENV, service links, expansion results). Check the real thing:

```console
$ kubectl exec payments-api -c app -- env | sort | head -6
DB_HOST=pg-primary.data.svc.cluster.local
DB_URL=postgres://pg-primary.data.svc.cluster.local:5432/payments
HOME=/root
HOSTNAME=payments-api
JAVA_HOME=/opt/java/openjdk
KUBERNETES_PORT=tcp://10.96.0.1:443
```

Distroless or scratch image with no `env` binary? Read pid 1's environment straight from procfs (works as long as *some* shell or `cat` exists; with `kubectl debug` ephemeral containers sharing the process namespace, run it from the debug container):

```console
$ kubectl exec payments-api -c app -- cat /proc/1/environ | tr '\0' '\n' | sort
```

Two subtleties when comparing:

- **An exec'd shell is not pid 1.** The runtime gives your exec session the same container-spec env, but a shell then adds `PWD`, `SHLVL`, `TERM`, and anything from rc files, and `HOSTNAME` may be set by the shell rather than inherited. `/proc/1/environ` is ground truth for what the app process started with; `exec -- env` is close enough for almost everything, just don't panic over the shell bookkeeping vars.
- **Frozen means frozen.** If you rotated a ConfigMap after the pod started, `describe` shows the ref, the ConfigMap shows the new value, and pid 1 still has the old one. Restart to reconcile.

When a **non-optional** `configMapKeyRef`/`secretKeyRef`/`envFrom` target doesn't exist, the pod doesn't crash — it never starts the container:

```console
$ kubectl get pod payments-api
NAME           READY   STATUS                       RESTARTS   AGE
payments-api   0/1     CreateContainerConfigError   0          45s
$ kubectl describe pod payments-api | tail -2
  Warning  Failed  12s (x4 over 40s)  kubelet  Error: configmap "payments-config" not found
```

That's distinct from the app starting and then dying because a var is empty — that flavor lands you in [CrashLoopBackOff](/troubleshooting/crashloopbackoff/). `CreateContainerConfigError` = kubelet couldn't assemble the config; CrashLoopBackOff = your process got the config and hated it.

## Limits and hygiene

- **There's no Kubernetes cap on env size, but Linux has opinions.** `execve` enforces `ARG_MAX` (~2 MiB total for args+env on typical kernels, ~128 KiB per single string). Stuff a whole JSON config or a TLS cert chain into one variable and you'll eventually hit `exec: argument list too long` — sometimes only in `kubectl exec` or a health-check subprocess, which makes it a fun one to diagnose. Big blobs belong in [mounted files](/workloads/config-files-and-volumes/).
- **Don't put secrets in env.** Env leaks by default: crash reporters and `/debug` endpoints dump it, child processes inherit all of it, `/proc/<pid>/environ` is readable to anyone who can exec, and half the APM agents ship it home unless configured not to. Prefer mounted Secret files. The full threat model is in [Secrets](/workloads/secrets/).
- **12-factor, without the cargo cult.** "Config in the environment" earns its keep for the small, deploy-varying scalars: hostnames, ports, feature flags, log levels. It was never a mandate to serialize your entire application config into 90 variables with a bash entrypoint templating them back into a file. Small knobs in env, structured config in files, secrets in mounted Secrets — and one place (your manifests, in git) that owns all three.
