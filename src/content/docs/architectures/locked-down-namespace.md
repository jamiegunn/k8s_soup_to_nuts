---
title: "The Locked-Down Namespace"
description: The fully hardened namespace — restricted PSA, default-deny NetworkPolicy, non-root read-only containers, least-privilege RBAC, and quotas — with a real app running inside it and every 3 a.m. diagnostic path proven to still work.
keywords:
  - Pod Security Admission restricted profile
  - default-deny NetworkPolicy both directions
  - least-privilege RBAC roles no wildcards
  - ResourceQuota LimitRange surge headroom
  - ephemeral debug container under restricted
  - kubectl debug profile restricted
  - heap dump read-only rootfs
  - violates PodSecurity FailedCreate
  - automountServiceAccountToken false
  - 403 RBAC denial missing verb
  - seccompProfile runAsNonRoot drop ALL
sidebar:
  order: 14
---

Security controls fail in a predictable way: they get bolted on after the app already works, the app breaks under them, and within a week someone has an exception ticket that never gets revoked. The `readOnlyRootFilesystem: true` that crashed the pod gets commented out. The default-deny NetworkPolicy that broke DNS gets deleted "temporarily." Six months later the namespace has five security labels and zero security.

This build inverts the order. The namespace starts locked — Pod Security Admission at `restricted`, default-deny NetworkPolicy in both directions, least-privilege RBAC, quotas — and the app is built to work *inside* the walls from the first apply. Then, because a namespace you can't debug is a namespace someone will eventually unlock, we prove every diagnostic path still works: ephemeral debug containers, heap dumps, port-forward, log access. If you can't do the 3 a.m. drill in section 5, the lockdown isn't done.

The layers stack like this, outermost first:

```text
Namespace labels: PSA enforce=restricted            (who may run AT ALL)
 └─ RBAC: three Roles, no wildcards                 (who may do WHAT)
     └─ NetworkPolicy: default-deny + allows        (who may TALK to whom)
         └─ securityContext: non-root, read-only,   (what a running process may do)
             no caps, seccomp
             └─ ResourceQuota + LimitRange          (how much it may consume)
```

Ownership splits cleanly. The **platform team** applies the namespace itself, its PSA labels, and the RBAC bindings — those require cluster-scoped rights you don't have (see [Working Without Admin](/start/working-without-admin/)). But *you write the spec* they apply: section 2 is a complete YAML bundle to hand over, which is exactly the request pattern from [Working with the Platform Team](/operations/working-with-platform-team/). Everything inside — Deployment, Service, NetworkPolicies, Secrets — is yours to apply and own.

The example workload is **orders-api**, the same service as the Golden Service build. That article is the availability build; this is its security module. They compose: same Deployment skeleton, different concerns, clone both.

## 1. The namespace spec to hand platform

### PSA labels: enforce restricted, watch latest

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: orders-prod
  labels:
    # Hard gate: pods violating the restricted profile are REJECTED at admission.
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: "v1.31"   # pin: cluster upgrades don't silently change the rules
    # Early warning: evaluate against the *latest* profile so next version's violations surface early.
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: latest
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: latest
```

`enforce` is pinned to a version; `audit` and `warn` float on `latest`. That asymmetry is the rollout discipline from [Pod Security](/workloads/pod-security/): warnings and audit-log entries tell you what *would* break under tomorrow's rules while today's pinned rules keep enforcing predictably. For a brand-new namespace, enforce from day one. For an existing one, see section 7 — never flip enforce first.

### ResourceQuota and LimitRange

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: orders-prod-quota
  namespace: orders-prod
spec:
  hard:
    requests.cpu: "8"          # steady state: 6 pods × 800m = 4.8 CPU...
    requests.memory: 16Gi      # ...plus surge headroom (see below)
    limits.memory: 24Gi
    pods: "20"
    services: "5"
    persistentvolumeclaims: "0"   # stateless namespace; make state a deliberate quota change
---
apiVersion: v1
kind: LimitRange
metadata:
  name: orders-prod-defaults
  namespace: orders-prod
spec:
  limits:
    - type: Container
      defaultRequest: { cpu: 100m, memory: 128Mi }   # applied to quota-less pods (debug pods, jobs)
      default: { memory: 256Mi }                      # default memory limit; deliberately NO cpu limit
      max: { memory: 4Gi }
```

The surge-headroom math, because a quota sized to steady state deadlocks your own rollouts: orders-api runs up to 10 pods at HPA max, each requesting 800m CPU and 1.5Gi memory. A rolling update with `maxSurge: 25%` briefly runs 13 pods: 13 × 800m = 10.4 — over an 8-CPU quota, so real sizing is *(HPA max + surge) × per-pod request*, plus a debug-pod allowance. Here 8 CPU covers the current 6-replica reality with surge; raise it in the same commit that raises the HPA ceiling. Sizing the per-pod numbers themselves is [Resources and QoS](/workloads/resources-and-qos/) territory.

The LimitRange matters more than it looks: under this ResourceQuota, **any pod without requests is rejected outright**. The `defaultRequest` is what lets a bare debug pod schedule at all.

### The RBAC bundle: three Roles

No wildcards anywhere. Full YAML, ready to hand over — the reasoning behind each verb choice is in [RBAC Explained](/start/rbac-explained/).

```yaml
# Role 1: deployer — bound to the CI pipeline's ServiceAccount. Writes manifests, reads status, nothing interactive.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: deployer
  namespace: orders-prod
rules:
  - apiGroups: ["", "apps", "networking.k8s.io", "autoscaling"]
    resources: ["deployments", "replicasets", "services", "configmaps", "secrets",
                "serviceaccounts", "networkpolicies", "ingresses", "horizontalpodautoscalers"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]   # no delete: CI replaces, humans remove
  - apiGroups: [""]
    resources: ["pods", "events"]
    verbs: ["get", "list", "watch"]          # CI must READ pod/RS state to report rollout failures
---
# Role 2: developer — humans on call. Everything deployer has, PLUS the debug verbs.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: developer
  namespace: orders-prod
rules:
  - apiGroups: ["", "apps", "networking.k8s.io", "autoscaling", "batch"]
    resources: ["deployments", "replicasets", "statefulsets", "services", "configmaps",
                "secrets", "serviceaccounts", "pods", "events", "networkpolicies",
                "ingresses", "horizontalpodautoscalers", "jobs", "cronjobs"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  # ── the debug trio: without these three, the namespace is a black box at 3 a.m. ──
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["pods/exec", "pods/ephemeralcontainers", "pods/portforward"]
    verbs: ["get", "create", "update"]    # ephemeralcontainers needs update (it patches the pod spec)
---
# Role 3: viewer — dashboards, auditors, the adjacent team. Read-only, no secrets.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: viewer
  namespace: orders-prod
rules:
  - apiGroups: ["", "apps", "networking.k8s.io", "autoscaling", "batch"]
    resources: ["pods", "pods/log", "services", "configmaps", "events", "endpoints",
                "deployments", "replicasets", "networkpolicies", "ingresses",
                "horizontalpodautoscalers", "jobs", "cronjobs"]
    verbs: ["get", "list", "watch"]       # note: secrets deliberately absent
```

Platform binds these to your groups/ServiceAccounts with three RoleBindings. When a role turns out to be missing a verb, the symptom is a 403 with the exact missing tuple in the message — [Decoding RBAC Denials](/troubleshooting/rbac-denied/) covers reading it; the fix is a one-line addition to this file, re-submitted to platform.

## 2. The workload: hardened and happy

The complete Deployment that passes `restricted` on the first apply. Every securityContext field is annotated with what rejects you if it's missing.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: orders-api
  namespace: orders-prod
automountServiceAccountToken: false   # the app never calls the API server; don't hand it credentials
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
  namespace: orders-prod
  labels: { app: orders-api }
spec:
  replicas: 3
  selector:
    matchLabels: { app: orders-api }
  template:
    metadata:
      labels: { app: orders-api }
    spec:
      serviceAccountName: orders-api
      securityContext:                    # pod-level
        runAsNonRoot: true                # restricted REQUIRES this (or per-container equivalent)
        runAsUser: 10001                  # explicit UID: don't trust the image's USER to be numeric
        runAsGroup: 10001
        fsGroup: 10001                    # volume files (incl. secrets) owned by this GID
        seccompProfile: { type: RuntimeDefault }  # restricted rejects unset/Unconfined seccomp
      containers:
        - name: app
          image: registry.internal/orders/orders-api:2.14.1
          ports:
            - name: http                  # NOT 80: binding <1024 needs NET_BIND_SERVICE,
              containerPort: 8080         # which "drop ALL" removes. Service maps 80→8080.
          securityContext:                # container-level
            allowPrivilegeEscalation: false   # restricted REQUIRES explicit false
            readOnlyRootFilesystem: true      # not required by restricted — but the whole point
            capabilities:
              drop: ["ALL"]               # restricted REQUIRES dropping ALL
          env:
            - name: JAVA_TOOL_OPTIONS
              value: "-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/tmp/dumps"
          volumeMounts:                   # the writable-surfaces kit: every path the app
            - name: tmp                   # writes to gets an explicit emptyDir, because
              mountPath: /tmp             # the rootfs no longer accepts writes
            - name: app-cache
              mountPath: /home/app/.cache
            - name: db-creds
              mountPath: /etc/orders/creds
              readOnly: true
          resources:
            requests: { cpu: 800m, memory: 1.5Gi }
            limits: { memory: 1.5Gi }     # no CPU limit, memory limit == request; see resources-and-qos
          readinessProbe:
            { httpGet: { path: /actuator/health/readiness, port: http }, periodSeconds: 5 }
          livenessProbe:
            { httpGet: { path: /actuator/health/liveness, port: http }, periodSeconds: 10 }
      volumes:
        - name: tmp
          emptyDir: { sizeLimit: 2Gi }    # sized for heap dumps: > max heap, or dumps truncate
        - name: app-cache
          emptyDir: { sizeLimit: 256Mi }
        - name: db-creds
          secret:
            secretName: orders-db-creds
            defaultMode: 0440             # owner+group read only; group = fsGroup 10001
---
apiVersion: v1
kind: Service
metadata:
  name: orders-api
  namespace: orders-prod
spec:
  selector: { app: orders-api }
  ports:
    - { name: http, port: 80, targetPort: http }   # port 80 outside, unprivileged 8080 inside
```

Three decisions worth dwelling on:

- **`automountServiceAccountToken: false`** — a mounted token is a credential sitting on disk in every pod. orders-api never talks to the API server, so it gets none. If a future sidecar needs one, mount it explicitly on that container. Full treatment in [ServiceAccounts](/workloads/serviceaccounts/).
- **Secrets as files, `0440`, owned by `fsGroup`** — files, not env vars, so credentials don't leak into `kubectl describe`, crash dumps, or child processes; mode `0440` plus `fsGroup: 10001` means the non-root app can read them and nothing else can. Why files beat env vars: [Secrets](/workloads/secrets/).
- **The writable-surfaces kit** — finding every path the app writes is the real cost of `readOnlyRootFilesystem`. Run the app once with a writable rootfs and watch `strace`/logs, or just flip it read-only in dev and collect the `EROFS` crashes. For a JVM it's almost always `/tmp` (plus wherever heap dumps go — here the same volume, deliberately, see section 4) and a cache dir.

- **Spec and image must agree** — PSA checks the *pod spec*, not the image. `runAsUser: 10001` against an image whose files are root-owned mode 700 yields a running pod that can't read its own binaries. Build images with a numeric non-root `USER` and world-readable app files.

## 3. The NetworkPolicy ring

One deny, five allows. Each allow exists because deny-all breaks something specific; each entry below names the failure signature you see when that policy is missing — the fastest way to diagnose a hole in the ring. Deep dive on selector semantics: [Network Policies](/networking/network-policies/).

```yaml
# The floor: nothing in, nothing out. Every other policy is an exception to this one.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: orders-prod
spec:
  podSelector: {}                 # all pods in the namespace
  policyTypes: [Ingress, Egress]  # deny BOTH directions; egress is the one people skip
---
# The rule everyone forgets. Missing: every connection fails SLOWLY — 5–10s DNS timeouts first.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: orders-prod
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
          podSelector: { matchLabels: { k8s-app: kube-dns } }
      ports:
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }   # large responses & retries fall back to TCP
---
# Missing signature: app healthy, logs clean, but 502/504 at the edge — nginx can't reach the pods.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-from-ingress-controller
  namespace: orders-prod
spec:
  podSelector: { matchLabels: { app: orders-api } }
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: ingress-nginx } }
      ports:
        - { protocol: TCP, port: 8080 }   # pod port, not the Service port 80
---
# Missing signature: startup crash-loop with DB connection *timeouts* (not refused) —
# packets silently dropped, so no RST ever comes back.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-egress-to-database
  namespace: orders-prod
spec:
  podSelector: { matchLabels: { app: orders-api } }
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: postgres-prod } }
          podSelector: { matchLabels: { app: postgres } }
      ports:
        - { protocol: TCP, port: 5432 }
---
# Missing signature: no alerts, no errors — a metrics flatline and "context deadline exceeded"
# on the Prometheus targets page. Monitoring goes blind quietly.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-monitoring-scrape
  namespace: orders-prod
spec:
  podSelector: {}                  # scrape anything in the namespace with a metrics port
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: monitoring } }
      ports:
        - { protocol: TCP, port: 8080 }   # orders-api serves /actuator/prometheus on the app port
---
# Only if pods here call each other; missing-signature is intra-ns timeouts that "worked in dev."
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-intra-namespace
  namespace: orders-prod
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
  ingress:
    - from: [{ podSelector: {} }]   # same namespace only
  egress:
    - to: [{ podSelector: {} }]
```

:::caution
Namespace selectors depend on the *target* namespace's labels, and `kubernetes.io/metadata.name` is the only one guaranteed present. Verify what your platform's ingress and monitoring namespaces are actually named before applying — a selector that matches zero namespaces fails silently as "still denied."
:::

## 4. Debugging inside the walls

This section is why the article exists. A lockdown that survives its first incident is one where every diagnostic was rehearsed *before* the incident. Here is each path, proven under full restrictions.

### Ephemeral debug containers under restricted PSA

`kubectl exec` into orders-api gets you a distroless shell-less non-root container — by design. The tool is `kubectl debug`, but the ephemeral container is admitted through the same PSA gate as everything else. A stock `kubectl debug -it pod/orders-api-6f7b9-x2k4p --image=busybox` is **rejected**: the busybox container runs as root with no securityContext. Two fixes:

```bash
# Option A (kubectl ≥1.31): the restricted profile flag writes a compliant securityContext for you
kubectl -n orders-prod debug -it orders-api-6f7b9-x2k4p \
  --image=nicolaka/netshoot --target=app --profile=restricted -- bash

# Option B: keep a debug image that is non-root BY DEFAULT (USER 10001, tool ownership correct):
kubectl -n orders-prod debug -it orders-api-6f7b9-x2k4p \
  --image=registry.internal/tooling/netshoot-nonroot:1.4 --target=app --profile=restricted
```

`--target=app` shares the app container's process namespace: you see its PIDs, read `/proc/<pid>/root/...`, run `ss`/`tcpdump`-lite style checks from *inside* its network namespace. Building and stocking that non-root toolbox image is [The Debugging Toolbox](/troubleshooting/debugging-toolbox/); the minimal-busybox techniques (and its sharp edges as a debug image) are in [Busybox](/troubleshooting/busybox/). Keep the toolbox image *in your internal registry* — mid-incident is when Docker Hub rate limits find you.

One more wall: the NetworkPolicy ring applies to the debug container too — it lives in the pod, so it gets the pod's egress rules. `wget https://example.com` failing from the debug container is the policy working, not the debug session broken.

### Heap dumps with a read-only rootfs

The JVM writes dumps wherever `HeapDumpPath` points — and every path is read-only except the mounts. That's why section 2 pointed `-XX:HeapDumpPath=/tmp/dumps` into the `/tmp` emptyDir and sized it at 2Gi (> the 1.2Gi max heap; a too-small emptyDir means truncated, unloadable dumps). Trigger and retrieve, no root, no exec into the app:

```bash
# Trigger a live dump via an ephemeral container sharing the app's PIDs (jattach needs no JDK in the app image)
kubectl -n orders-prod debug -it orders-api-6f7b9-x2k4p \
  --image=registry.internal/tooling/jvm-debug:21 --target=app --profile=restricted \
  -- jattach 1 dumpheap /tmp/dumps/manual-$(date +%s).hprof
# /tmp is the SAME volume in both containers (shared pod volume), so retrieve from either:
kubectl -n orders-prod cp orders-api-6f7b9-x2k4p:/tmp/dumps/manual-1751500000.hprof ./heap.hprof
```

The JRE-only variants (no `jmap` in the image, jattach tricks, dump-on-OOM flows) are [Heap Dumps on JRE-Only Images](/java/heap-dumps-jre-only/).

### Port-forward under the RBAC bundle

`pods/portforward` is in the developer Role precisely so you can hit the app without touching any NetworkPolicy — port-forward tunnels through the API server and the kubelet, so it is **not subject to the NetworkPolicy ring**. That makes it both your escape hatch and your control experiment: if port-forward works but the ingress path doesn't, the problem is network policy or Service wiring, not the app.

```bash
kubectl -n orders-prod port-forward deploy/orders-api 8080:8080
curl -s localhost:8080/actuator/health | jq .status    # "UP"
```

### What you deliberately cannot do — and the sanctioned replacement

| Gone | Why | Sanctioned alternative |
|---|---|---|
| `kubectl exec` as root | non-root + restricted PSA | ephemeral container with `--target`, read via `/proc/<pid>/root` |
| `apt-get install` mid-incident | read-only rootfs, non-root | pre-built toolbox image attached as ephemeral container |
| `curl` from the app container | distroless image, no shell | debug container in the same netns (`--target=app`) |
| bind port 80 | ALL capabilities dropped | listen 8080, `Service` maps 80→8080 |
| write anywhere ad hoc | read-only rootfs | the emptyDir kit; add a mount in a PR, not a shell |

## 5. Verification plan

Run all five drills on day one, then after every platform upgrade.

**RBAC: `kubectl auth can-i` per role.** Expected grid — any deviation means a binding or Role drifted:

```bash
kubectl -n orders-prod auth can-i create pods/exec --as-group=orders-developers --as=dev@example.com            # yes
kubectl -n orders-prod auth can-i create pods/exec --as=system:serviceaccount:orders-prod:ci-deployer           # no
kubectl -n orders-prod auth can-i get secrets --as-group=orders-viewers --as=viewer@example.com                 # no
kubectl -n orders-prod auth can-i update pods/ephemeralcontainers --as-group=orders-developers --as=dev@example.com  # yes
# and in any OTHER namespace, every one of these answers "no" — Role, not ClusterRole
```

**The PSA probe.** Apply a deliberately violating pod and read the exact rejection — this confirms enforce is live, not just labeled:

```bash
kubectl -n orders-prod run psa-probe --image=busybox --restart=Never -- sleep 60
# Error from server (Forbidden): pods "psa-probe" is forbidden: violates PodSecurity
# "restricted:v1.31": allowPrivilegeEscalation != false, unrestricted capabilities
# (must drop ["ALL"]), runAsNonRoot != true, seccompProfile (...)
```

**The NetworkPolicy matrix.** One compliant busybox `httpd` listener plus `wget -T 3 -q -O- http://TARGET` probes from strategic points — the 3-second timeout makes denials fail fast, and a hang past it *is* the denial signature. Expected grid:

| From → To | Expected | Proves |
|---|---|---|
| debug container → `orders-api:8080` (same ns) | **timeout** | default-deny ingress (until intra-ns policy applied) |
| debug container → `kube-dns:53` | pass | allow-dns-egress |
| debug container → `postgres:5432` | pass | allow-egress-to-database |
| debug container → `example.com:443` | **timeout** | default-deny egress holds |
| ingress-nginx pod → `orders-api pod:8080` | pass | allow-from-ingress-controller |
| monitoring pod → `orders-api pod:8080/actuator/prometheus` | pass | allow-monitoring-scrape |
| pod in an unrelated namespace → `orders-api pod:8080` | **timeout** | deny beats hope |

**Quota exhaustion.** Scale to a replica count the quota can't fund and confirm the failure is loud in the right place:

```bash
kubectl -n orders-prod scale deploy/orders-api --replicas=15
kubectl -n orders-prod describe rs -l app=orders-api | grep -A2 FailedCreate
#  Warning  FailedCreate  ... Error creating: pods "orders-api-..." is forbidden: exceeded quota:
#  orders-prod-quota, requested: requests.cpu=800m, used: ..., limited: ...   (then scale back to 3)
```

Note where that error lives: **ReplicaSet events**, not Deployment status, not pod events (there are no pods). Same hiding spot as PSA rejections — memorize it.

**The 3 a.m. drill, end to end.** Under full lockdown, one on-call engineer must complete in under ten minutes: attach an ephemeral netshoot, confirm DB connectivity from inside the pod's netns, trigger and download a heap dump, port-forward and hit the health endpoint. Time it quarterly. If a step 403s or gets PSA-rejected, the drill just found the gap for free.

## 6. Failure modes

| Symptom | Actual cause | Where the evidence hides | Fix |
|---|---|---|---|
| Deploy "succeeds," pods never appear | PSA rejecting pod creation | `kubectl describe rs` events (`FailedCreate ... violates PodSecurity`) — invisible at Deployment level | make spec pass restricted (section 2 checklist) |
| CrashLoopBackOff, `EROFS`/"read-only file system" in logs | `readOnlyRootFilesystem` without the emptyDir kit | container logs, first lines before exit | mount emptyDir at every write path |
| Every outbound call slow-fails after ~5–10s | default-deny egress without DNS allow | debug container: `nslookup` times out, direct-IP works | apply `allow-dns-egress` |
| Metrics flatline, no alerts firing | scrape blocked by deny-all | Prometheus targets page: `context deadline exceeded` | apply `allow-monitoring-scrape` |
| CI pipeline 403 on apply | deployer Role missing a resource/verb (often a new resource type) | 403 body names the exact missing tuple | add the rule, re-submit bundle to platform |
| Pods rejected only when a mesh/agent is enabled | webhook-injected sidecar violates restricted (root init container, added capabilities) | RS events name the *injected* container, not yours | injector's PSA-compliance mode; see [Admission Webhooks](/controllers/admission-webhooks/) |

The unifying lesson: in a locked-down namespace, **failures move up a level**. Things that used to fail as broken pods now fail as *absent* pods, and the evidence migrates to ReplicaSet events and admission errors. Retrain your reflexes accordingly.

## 7. Adopting this in an existing namespace

Greenfield namespaces start at section 1. A namespace with a year of running workloads gets the staged path:

1. **Label `audit` and `warn` only.** Zero enforcement, full visibility: every violating pod now generates a warning on apply and an audit-log annotation. Nothing breaks.
2. **Build the violations inventory.** Collect a week of warnings; the API server's audit log gives you the complete list of offending workloads and *which* control each violates.
3. **Fix pods one control at a time**, easiest first: `seccompProfile` and `allowPrivilegeEscalation: false` are usually free; `capabilities: drop ALL` flushes out port-80 binders; `runAsNonRoot` and `readOnlyRootFilesystem` need image work and the emptyDir kit. Every fix rolls out as a normal deploy; the warnings burn down measurably.
4. **Flip `enforce: restricted`** only when a full week passes with zero warnings — and note that enforce gates pod *creation*, so already-running violators keep running until their next restart. Flush them with a rolling restart while you're watching, not whenever the node reboot lottery decides.
5. **Never flip enforce on a Friday.** Enforcement failures surface at the next pod churn — a node drain, an HPA scale-up, a Saturday-night OOM restart. Flip it Tuesday morning, then immediately trigger a rolling restart of everything in the namespace and watch it come back.

Then apply the NetworkPolicy ring in the same audit-first spirit: allows *first*, `default-deny-all` last, so there is never a moment where legitimate traffic is dropped.

## Closing

This namespace is the site's thesis as a runnable artifact: you don't own the cluster, but with a well-written spec handed to the platform team and disciplined manifests inside, you own a namespace that is simultaneously locked down and fully operable. It is deliberately the security module of [The Golden Service](/architectures/golden-service/) — same app, complementary concerns. Clone both, merge the Deployments, and you have the complete starting point: available *and* hardened, with the 3 a.m. drill already rehearsed.
