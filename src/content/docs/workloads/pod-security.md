---
title: Pod Security
description: The securityContext fields app teams own, how Pod Security Admission rejects your workloads, and a hardening path that won't break the app.
keywords:
  - runasnonroot image will run as root
  - violates podsecurity restricted
  - deployment applied but no pods
  - failedcreate forbidden replicaset
  - readonlyrootfilesystem erofs
  - bind permission denied port 80
  - capabilities drop all net_bind_service
  - securitycontext fsgroup
  - seccompprofile runtimedefault
  - pod security admission namespace label
  - kyverno gatekeeper policy denied
sidebar:
  order: 16
---

Pod security splits cleanly along the ownership line this whole guide assumes. You own `securityContext` in your pod specs — who the process runs as, what it can write, which kernel capabilities it holds. The platform team owns the walls you run into: Pod Security Admission labels on your namespace, Kyverno/Gatekeeper policies, node and runtime configuration. This article covers both sides — your knobs, and how to read the rejection when you hit their walls. (What each knob actually *is* in the kernel — capability masks, `no_new_privs`, seccomp filters — is mapped in [Kubernetes Is Linux](/troubleshooting/kubernetes-is-linux/).)

## securityContext: pod level vs container level

`securityContext` exists in two places, and they're not the same struct:

```yaml
spec:
  securityContext:            # pod level — applies to ALL containers + volume handling
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    fsGroup: 10001
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: app
      securityContext:        # container level — overrides pod level where fields overlap
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
```

Rules of engagement:

- Where a field exists at **both** levels (`runAsUser`, `runAsGroup`, `runAsNonRoot`, `seccompProfile`), the **container-level value wins** for that container.
- Some fields are **pod-only**: `fsGroup`, `fsGroupChangePolicy`, `supplementalGroups`, `shareProcessNamespace`, `sysctls`.
- Some are **container-only**: `capabilities`, `allowPrivilegeEscalation`, `readOnlyRootFilesystem`, `privileged`.

Set shared identity at the pod level, per-container restrictions at the container level. Field-by-field:

**`runAsNonRoot: true`** — an *assertion*, not a change. The kubelet refuses to start the container if it would run as UID 0. If the image's `USER` is numeric non-zero, fine; if the image has no `USER` or `USER root`, you get the classic startup failure (see the ranked failures below).

**`runAsUser` / `runAsGroup`** — actually *set* the UID/GID, overriding the image's `USER`. Pair with `runAsNonRoot` so a future image change can't sneak root back in.

**`fsGroup`** — GID applied to mounted volumes so your non-root process can write them. This is the fix for "my PVC/emptyDir is owned by root and I can't write to it". Interaction with mounted ConfigMaps/Secrets and `defaultMode` is covered in [Config Files and Volumes](/workloads/config-files-and-volumes/).

**`allowPrivilegeEscalation: false`** — blocks setuid binaries and similar from gaining privileges beyond the parent process. Almost no app notices; set it everywhere.

**`capabilities`** — Linux capabilities, not Kubernetes RBAC. Drop everything, add back only what you can name a reason for:

```yaml
capabilities:
  drop: ["ALL"]
  add: ["NET_BIND_SERVICE"]   # only if you truly must bind < 1024
```

The one capability app teams actually hit: binding port 80 or 443 as non-root fails with `bind: permission denied` because ports below 1024 are privileged. Two fixes: add `NET_BIND_SERVICE` back, or — better — **listen on 8080/8443 and let the Service map port 80 to it**. The Service `port`/`targetPort` split exists precisely so nobody needs privileged ports inside pods.

**`readOnlyRootFilesystem: true`** — the container's root filesystem becomes read-only. Most apps write *somewhere* (`/tmp`, cache dirs, PID files), so the standard fix-kit is an `emptyDir` per writable path:

```yaml
containers:
  - name: app
    securityContext:
      readOnlyRootFilesystem: true
    volumeMounts:
      - { name: tmp, mountPath: /tmp }
      - { name: cache, mountPath: /app/cache }
volumes:
  - name: tmp
    emptyDir: { sizeLimit: 256Mi }
  - name: cache
    emptyDir: { sizeLimit: 512Mi }
```

Note `sizeLimit` — `emptyDir` writes count against the node (or the container's memory limit if `medium: Memory`), and an unbounded tmp dir is a slow-motion disk-pressure eviction.

**`seccompProfile: RuntimeDefault`** — applies the container runtime's default syscall filter, blocking a few dozen obscure/dangerous syscalls. Breakage is rare and almost always in software that does unusual things (strace-like tools, some old JVM flags, custom clone() usage).

## A hardened-but-debuggable reference spec

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders
spec:
  replicas: 3
  selector:
    matchLabels: { app: orders }
  template:
    metadata:
      labels: { app: orders }
    spec:
      automountServiceAccountToken: false   # app never calls the API — see ServiceAccounts
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001                    # matches the image's USER; remove if image sets it
        runAsGroup: 10001
        fsGroup: 10001
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: app
          image: registry.example.com/orders:1.14.2
          ports:
            - containerPort: 8080           # unprivileged port; Service maps 80 -> 8080
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
          resources:
            requests: { cpu: 250m, memory: 512Mi }
            limits: { memory: 512Mi }
      volumes:
        - name: tmp
          emptyDir: { sizeLimit: 256Mi }
```

This passes the `restricted` Pod Security Standard and stays debuggable: you can still `kubectl exec` into it (if the image has a shell), and `kubectl debug` with an ephemeral tools container covers the rest — see the [Debugging Toolbox](/troubleshooting/debugging-toolbox/). Hardening restricts *the process*, not your kubectl access.

## Pod Security Standards and Admission

Kubernetes defines three **Pod Security Standards**:

| Level | Meaning |
|---|---|
| `privileged` | Anything goes. Node agents, CNI — not you. |
| `baseline` | Blocks known-dangerous stuff: privileged containers, hostPath, hostNetwork, added capabilities beyond a safe list. Most apps pass without changes. |
| `restricted` | Baseline plus: `runAsNonRoot`, `allowPrivilegeEscalation: false`, drop ALL capabilities (only `NET_BIND_SERVICE` may be added back), `seccompProfile` RuntimeDefault/Localhost, only safe volume types. |

**Pod Security Admission (PSA)** enforces these via *namespace labels* — which the platform team sets, not you:

```console
$ kubectl get ns team-orders -o jsonpath='{.metadata.labels}' | jq
{
  "pod-security.kubernetes.io/enforce": "restricted",
  "pod-security.kubernetes.io/enforce-version": "v1.30",
  "pod-security.kubernetes.io/warn": "restricted",
  "kubernetes.io/metadata.name": "team-orders"
}
```

Three modes: `enforce` rejects violating pods, `audit` records violations to the audit log, `warn` prints warnings to your kubectl session on apply. The `-version` suffix pins which release's definition of the standard applies, so a Kubernetes upgrade doesn't silently change the rules. You can read these labels; you cannot change them. If the level is wrong for your workload, that's a [platform team conversation](/operations/working-with-platform-team/).

### Reading the rejection

Create a violating pod directly and the error is verbose and exact:

```console
$ kubectl apply -f pod.yaml
Error from server (Forbidden): error when creating "pod.yaml": pods "orders-debug"
is forbidden: violates PodSecurity "restricted:v1.30": allowPrivilegeEscalation
!= false (container "app" must set securityContext.allowPrivilegeEscalation=false),
unrestricted capabilities (container "app" must set
securityContext.capabilities.drop=["ALL"]), runAsNonRoot != true (pod or container
"app" must set securityContext.runAsNonRoot=true), seccompProfile (pod or container
"app" must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost")
```

Each clause names the field and the container. Fix them one by one; the message is the checklist.

### The sneaky version: the Deployment applies, pods never appear

PSA validates **pods**. A Deployment is not a pod, so `kubectl apply` on a violating Deployment **succeeds** (with a warning if `warn` is set — read your apply output!). The Deployment creates a ReplicaSet, the ReplicaSet tries to create pods, and *those* get rejected. Result: `READY 0/3`, zero pods, no events on the Deployment.

Look at the **ReplicaSet**:

```console
$ kubectl get rs -l app=orders
NAME               DESIRED   CURRENT   READY   AGE
orders-6f9d8b7c4   3         0         0       2m

$ kubectl describe rs orders-6f9d8b7c4 | tail -4
  Warning  FailedCreate  35s (x6 over 2m)  replicaset-controller
  Error creating: pods "orders-6f9d8b7c4-" is forbidden: violates PodSecurity
  "restricted:v1.30": runAsNonRoot != true ...
```

This "controller succeeded, children forbidden" pattern is worth internalizing — it's the same shape for quota exhaustion and webhook rejections. More on the Deployment→ReplicaSet→Pod chain in [Deployments Deep Dive](/workloads/deployments-deep-dive/).

### What `restricted` means for a typical app image

For a typical Java/Node/Go service the delta is exactly the reference spec above: non-root assertion, drop ALL, no privilege escalation, RuntimeDefault seccomp. The genuine friction points:

- **Image runs as root by mistake.** Many Dockerfiles never set `USER`. Quick fix from the manifest: `runAsUser: 10001` — no rebuild needed. But now the process runs as a UID the image never planned for: files baked into the image as `root:root 0640` become unreadable, and app dirs become unwritable. The durable fix is rebuilding with a proper `USER` and correct ownership (`COPY --chown=`); `runAsUser` is the bridge that unblocks today's deploy.
- **Writes to `/` somewhere.** `readOnlyRootFilesystem` isn't required by `restricted`, but if you set it, apply the emptyDir fix-kit.
- **Binds :80.** Move to 8080 (see capabilities above).

## Policy engines on top of PSA

Many clusters run Kyverno or OPA Gatekeeper as admission webhooks *in addition to* PSA — enforcing image-registry allowlists, required labels, resource limits, disallowed tags like `:latest`. Their rejections look different (the error names the policy, e.g. `admission webhook "validate.kyverno.svc-fail" denied the request: ... rule require-registry failed`), and the rules are cluster-specific — the platform team wrote them. How admission webhooks work and how to discover what's mutating/validating your resources is covered in [Admission Webhooks](/controllers/admission-webhooks/).

:::note[What you don't control]
Namespace PSA labels, the cluster's policy-engine rules, seccomp/AppArmor availability, runtime and node hardening — all platform territory. Your lever is your pod spec; theirs is the wall. When the wall is wrong, negotiate — don't try to tunnel.
:::

## Common failures, ranked

**1. `CreateContainerConfigError` — "container has runAsNonRoot and image will run as root"**

```console
$ kubectl describe pod orders-6f9d8b7c4-x2p4m | grep -A1 Error
  Warning  Failed  12s  kubelet  Error: container has runAsNonRoot and image
  will run as root (pod: "orders-...", container: app)
```

The image has no numeric non-root `USER`. Fix: `runAsUser: 10001` in the spec now, `USER 10001` in the Dockerfile properly.

**2. Permission denied writing files.** `EROFS`/`read-only file system` in app logs → `readOnlyRootFilesystem` without the emptyDir fix-kit. `EACCES` on a volume → missing `fsGroup` or wrong `runAsUser` vs file ownership.

**3. `bind: permission denied` on :80/:443.** Privileged port as non-root. Listen on 8080, or add `NET_BIND_SERVICE`.

**4. Seccomp blocking a syscall (rare).** Symptom: `operation not permitted` from a syscall that works locally, usually in exotic tooling. Evidence-gathering: reproduce with the container's seccomp set to `Unconfined` in a scratch namespace *if policy allows*, or ask the platform team to pull the audit log; node-level tracing is their territory. If confirmed, the answer is usually a Localhost profile the platform team maintains — not `Unconfined` in production.

## The hardening checklist, and how to roll it out

Per workload, in order of blast-radius (smallest first):

1. `allowPrivilegeEscalation: false` — breaks almost nothing.
2. `seccompProfile: RuntimeDefault` — breaks almost nothing.
3. `capabilities.drop: ["ALL"]` — breaks port-<1024 binds and little else.
4. `runAsNonRoot: true` (+ `runAsUser` if the image needs it) — breaks root-assuming images; test file permissions.
5. `readOnlyRootFilesystem: true` + emptyDir kit — needs per-app discovery of writable paths.
6. `automountServiceAccountToken: false` — see [ServiceAccounts](/workloads/serviceaccounts/); only if the app never calls the K8s API.

Roll it out the way PSA itself is designed to: **observe before you enforce**. Ask the platform team to set `warn` and `audit` to `restricted` while `enforce` stays at `baseline` — every `kubectl apply` and every audit-log entry then tells you exactly which workloads would break, with zero production risk. Fix the findings at your own pace, then flip `enforce`. Deploy each checklist step through your normal pipeline one workload at a time, watch startup and logs for a full cycle, and you'll land the whole list without a single incident-review meeting.
