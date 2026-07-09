---
title: Error Message Index
description: Look up the exact error string on your screen — CrashLoopBackOff, FailedScheduling, x509, 502s — and jump straight to the playbook that fixes it.
keywords:
  - what does this error mean
  - kubectl describe pod events
  - FailedScheduling Insufficient cpu
  - OOMKilled exit code 137
  - Back-off restarting failed container
  - ImagePullBackOff unauthorized manifest unknown
  - Error from server Forbidden
  - x509 certificate signed by unknown authority
  - FailedMount Multi-Attach error
  - probe failed connection refused
  - Evicted pod ephemeral-storage
sidebar:
  order: 18
---

You have an error on your screen. This page maps the **literal string** to the playbook that fixes it — no concept-hunting required.

**How to use this page:**

1. Copy the **exact string** from `kubectl describe`, `kubectl get events`, your logs, or your browser — then search this site for it (press `/`). Error strings here are indexed verbatim, so `Insufficient cpu` finds this row, and this row finds the fix.
2. Or scan by lifecycle stage below: the pod won't schedule → won't pull → won't start → dies at runtime → is unreachable → storage → permissions → TLS and edge.
3. Not sure where you are in that lifecycle? Start with [Triage Methodology](/troubleshooting/triage-methodology/) — two commands tell you which table you need.

Statuses like `CrashLoopBackOff` come from `kubectl get pods`; the richer strings come from `kubectl describe pod <pod>` (Events section) and `kubectl get events --sort-by=.lastTimestamp`.

## Won't schedule (Pending)

Pod sits in `Pending`. The scheduler is telling you exactly why — read the `FailedScheduling` event.

| Error text | What it means | Playbook |
|---|---|---|
| `Pending` (status, no node assigned) | Scheduler hasn't found (or can't find) a node | [Pod Pending](/troubleshooting/pod-pending/) |
| `0/N nodes are available` | Every node was ruled out — the reasons follow this prefix | [Pod Pending](/troubleshooting/pod-pending/) |
| `FailedScheduling` ... `Insufficient cpu` | No node has enough **unrequested** CPU for your request | [Pod Pending](/troubleshooting/pod-pending/#1-insufficient-cpu-or-memory), [Requests & Limits Knobs](/tuning/requests-limits-knobs/) |
| `FailedScheduling` ... `Insufficient memory` | Same, for memory — requests, not actual usage | [Pod Pending](/troubleshooting/pod-pending/#1-insufficient-cpu-or-memory), [Requests & Limits Knobs](/tuning/requests-limits-knobs/) |
| `node(s) had untolerated taint` | Nodes are tainted (dedicated, cordoned, pressure) and your pod lacks the toleration | [Scheduling](/workloads/scheduling/#taints-and-tolerations-repel-dont-attract), [Pod Pending](/troubleshooting/pod-pending/#4-untolerated-taint) |
| `node(s) didn't match Pod's node affinity/selector` | Your `nodeSelector`/affinity rules exclude every node | [Scheduling](/workloads/scheduling/#debugging-placement) |
| `volume node affinity conflict` | The PV lives in one zone/node; the pod can only schedule elsewhere | [Volume Failures](/troubleshooting/volume-failures/), [Storage: PV & PVC](/stateful/storage-pv-pvc/) |
| `Too many pods` | Nodes hit their per-node pod count limit — capacity, not your YAML | [Pod Pending](/troubleshooting/pod-pending/#5-too-many-pods), [Working with the Platform Team](/operations/working-with-platform-team/) |
| `node(s) had volume node affinity conflict` | Zonal PV vs. pod placement mismatch (multi-zone clusters) | [Volume Failures](/troubleshooting/volume-failures/) |
| `exceeded quota` (on the ReplicaSet/Deployment, not the pod) | Namespace ResourceQuota is full — pods aren't even being created | [Working Without Admin](/start/working-without-admin/#know-your-budget-quotas-and-limit-ranges), [Pod Pending](/troubleshooting/pod-pending/#2-resourcequota-exceeded) |
| `SchedulingGated` | Pod has `schedulingGates` set — something (a controller, a webhook) must remove them first | [Pod Pending](/troubleshooting/pod-pending/), [Admission Webhooks](/controllers/admission-webhooks/) |
| `1 node(s) were unschedulable` | Node is cordoned (maintenance, drain in progress) | [Node Problems](/troubleshooting/node-problems/#cordon-drain-and-maintenance) |

## Won't pull the image

Pod is stuck before the container even exists. All roads lead to `kubectl describe pod` Events.

| Error text | What it means | Playbook |
|---|---|---|
| `ImagePullBackOff` | Pull failed repeatedly; kubelet is backing off between retries | [ImagePullBackOff](/troubleshooting/imagepullbackoff/) |
| `ErrImagePull` | The pull just failed — the message after it says why | [ImagePullBackOff](/troubleshooting/imagepullbackoff/#confirm-read-the-exact-pull-error) |
| `manifest unknown` / `manifest for ... not found` | Registry answered: that **tag doesn't exist** — typo, unpushed build, or deleted tag | [ImagePullBackOff](/troubleshooting/imagepullbackoff/#1-the-tag-doesnt-exist-manifest-unknown) |
| `unauthorized: authentication required` | Registry rejected credentials — missing/wrong `imagePullSecrets` | [ImagePullBackOff](/troubleshooting/imagepullbackoff/#2-private-registry-auth-unauthorized), [Secrets](/workloads/secrets/) |
| `pull access denied` / `repository does not exist or may require 'docker login'` | Repo is private (auth) or the repo path itself is wrong | [ImagePullBackOff](/troubleshooting/imagepullbackoff/#2-private-registry-auth-unauthorized) |
| `InvalidImageName` | The image reference can't be parsed — uppercase repo, bad character, stray template variable like `${TAG}` | [ImagePullBackOff](/troubleshooting/imagepullbackoff/) |
| `ErrImageNeverPull` | `imagePullPolicy: Never` but the image isn't on the node — common when a local-dev manifest reaches a real cluster | [ImagePullBackOff](/troubleshooting/imagepullbackoff/), [Local Development](/start/local-development/#getting-your-image-into-the-cluster) |
| `x509: certificate signed by unknown authority` (during pull) | The registry's TLS cert isn't trusted by the **node** — platform-team territory | [ImagePullBackOff](/troubleshooting/imagepullbackoff/#air-gapped-and-proxy-registries), [Working with the Platform Team](/operations/working-with-platform-team/) |
| `dial tcp ... i/o timeout` (during pull) | Node can't reach the registry — proxy, firewall, or registry outage | [ImagePullBackOff](/troubleshooting/imagepullbackoff/#3-registry-unreachable-connection-refused-io-timeout) |

## Won't start

Image arrived, but the container can't be created or exits immediately.

| Error text | What it means | Playbook |
|---|---|---|
| `CreateContainerConfigError` | Kubelet can't assemble the container config — usually a referenced ConfigMap/Secret **key or object doesn't exist** | [Configuration](/workloads/configuration/#debugging-config-problems), [Secrets](/workloads/secrets/#debugging-secret-problems) |
| `configmap "..." not found` / `secret "..." not found` | The specific missing reference behind CreateContainerConfigError | [Config Files & Volumes](/workloads/config-files-and-volumes/#debugging-the-mount), [Secrets](/workloads/secrets/#debugging-secret-problems) |
| `CreateContainerError` | Runtime failed to create the container — bad `command`/entrypoint (`executable file not found in $PATH`), duplicate container name | [CrashLoopBackOff](/troubleshooting/crashloopbackoff/#4-bad-command-or-entrypoint) |
| `CrashLoopBackOff` | Container starts, exits, restarts — kubelet is backing off between attempts | [CrashLoopBackOff](/troubleshooting/crashloopbackoff/) |
| `Back-off restarting failed container` | The event form of CrashLoopBackOff — same diagnosis | [CrashLoopBackOff](/troubleshooting/crashloopbackoff/) |
| `Error` (status) with exit code `1` | App exited with a generic failure — the answer is in `kubectl logs --previous` | [CrashLoopBackOff](/troubleshooting/crashloopbackoff/#step-zero-read-the-previous-containers-logs) |
| exit code `139` | SIGSEGV — the process segfaulted (native crash, bad glibc/musl mix) | [CrashLoopBackOff](/troubleshooting/crashloopbackoff/) |
| `container has runAsNonRoot and image will run as root` | Pod securityContext demands non-root but the image's user is root/unset | [Pod Security](/workloads/pod-security/#common-failures-ranked) |
| `mkdir ... read-only file system` (with `readOnlyRootFilesystem`) | App writes to a path that's locked read-only — mount an `emptyDir` there | [Pod Security](/workloads/pod-security/#common-failures-ranked), [Config Files & Volumes](/workloads/config-files-and-volumes/#patterns-youll-reach-for-constantly) |
| `violates PodSecurity "restricted:..."` | Namespace-level Pod Security admission rejected the pod spec outright | [Pod Security](/workloads/pod-security/#reading-the-rejection), [Working Without Admin](/start/working-without-admin/) |
| `admission webhook "..." denied the request` | A cluster policy webhook (OPA/Kyverno/etc.) vetoed your object at apply time | [Admission Webhooks](/controllers/admission-webhooks/#reading-a-rejection), [Working with the Platform Team](/operations/working-with-platform-team/) |
| `failed calling webhook` ... `context deadline exceeded` | A webhook is **down or unreachable**, blocking all applies it intercepts — escalate | [Admission Webhooks](/controllers/admission-webhooks/#failurepolicy-and-the-outage-where-nothing-deploys), [Emergency Playbooks](/operations/emergency-playbooks/) |
| `PodInitializing` / `Init:0/1` (stuck) | An init container hasn't finished — debug it like a normal container | [Init & Sidecar Containers](/workloads/init-and-sidecar-containers/#when-init-containers-fail), [Lifecycle & Ordering](/sidecars/lifecycle-and-ordering/) |
| `Init:CrashLoopBackOff` | An init container itself is crash-looping | [Init & Sidecar Containers](/workloads/init-and-sidecar-containers/#when-init-containers-fail), [CrashLoopBackOff](/troubleshooting/crashloopbackoff/#6-init-containers-crash-looping) |

## Dies at runtime

It ran — then something killed it, or Kubernetes decided it wasn't healthy.

| Error text | What it means | Playbook |
|---|---|---|
| `OOMKilled` / `Reason: OOMKilled` | Container hit its memory **limit**; kernel killed it instantly, no logs | [OOMKilled](/troubleshooting/oomkilled/) |
| exit code `137` | SIGKILL — OOM kill, eviction, or a probe/shutdown timeout escalation; check `Reason` to tell them apart | [OOMKilled](/troubleshooting/oomkilled/#confirm-it-was-actually-oom) |
| exit code `143` | SIGTERM — graceful shutdown request (rollout, scale-down, drain); usually normal | [Rollouts & Rollbacks](/workloads/rollouts-and-rollbacks/), [Life of a Deployment](/start/life-of-a-deployment/) |
| `Evicted` | Kubelet kicked the pod off a node under pressure | [Node Problems](/troubleshooting/node-problems/#node-conditions-and-eviction--why-your-pod-got-killed) |
| `Evicted` ... `low on resource: ephemeral-storage` | Your container filled node-local disk — logs, temp files, cache | [Node Problems](/troubleshooting/node-problems/#ephemeral-storage-the-usual-suspect--and-its-usually-you), [Resources & QoS](/workloads/resources-and-qos/) |
| `no space left on device` | Disk full — inside the container (ephemeral) or on a PVC; find out which | [Volume Failures](/troubleshooting/volume-failures/#volume-full-no-space-left-on-device), [Node Problems](/troubleshooting/node-problems/#ephemeral-storage-the-usual-suspect--and-its-usually-you) |
| `Unhealthy` ... `Liveness probe failed` | Liveness probe failing → container gets **restarted** | [Health Checks](/workloads/health-checks/#debugging-probe-failures), [Health Check Knobs](/tuning/health-check-knobs/) |
| `Unhealthy` ... `Readiness probe failed` | Readiness failing → pod pulled from Service endpoints (no restart) | [Health Checks](/workloads/health-checks/#debugging-probe-failures), [Service Unreachable](/troubleshooting/service-unreachable/#hop-1-are-the-pods-ready) |
| `probe failed` ... `context deadline exceeded` (probe flavor) | Probe **timed out** — app too slow to answer, or threads starved | [Health Check Knobs](/tuning/health-check-knobs/), [Performance Analysis](/observability/performance-analysis/) |
| `probe failed` ... `connection refused` | Nothing listening on the probe port yet — wrong port or app not up | [Health Checks](/workloads/health-checks/#debugging-probe-failures) |
| `probe failed: HTTP probe failed with statuscode: 503` | App answered — and said it's not ready; check its health logic | [Health Checks](/workloads/health-checks/#debugging-probe-failures), [Actuator](/java/actuator/) or [Operational Endpoints](/dotnet/operational-endpoints/) |
| `Terminating` (stuck) | Pod won't finish deleting — finalizer stuck, node gone, or process ignoring SIGTERM | [Node Problems](/troubleshooting/node-problems/#how-node-trouble-looks-from-your-namespace), [Emergency Playbooks](/operations/emergency-playbooks/) |
| `java.lang.OutOfMemoryError: Java heap space` | JVM heap exhausted — different beast from OOMKilled (JVM-internal, you get a stack trace) | [Memory Leaks & OOM](/java/memory-leaks-and-oom/#step-zero-which-oom-is-it) |
| `java.lang.OutOfMemoryError: Metaspace` | Class metadata space exhausted — classloader leak or undersized Metaspace | [Memory Leaks & OOM](/java/memory-leaks-and-oom/#metaspace-leaks-the-classloader-disease), [JVM Memory Knobs](/tuning/jvm-memory-knobs/#the-non-heap-knobs--the-rss-budget-everyone-forgets) |
| `java.lang.OutOfMemoryError: GC overhead limit exceeded` | JVM spending almost all time in GC — heap too small or a leak | [GC & Performance](/java/gc-and-performance/), [Memory Leaks & OOM](/java/memory-leaks-and-oom/#heap-leaks-histogram--dump--dominator-tree) |
| `java.lang.OutOfMemoryError: unable to create native thread` | Thread count vs. container memory/pid limits — not heap | [JVM in Containers](/java/jvm-in-containers/), [Memory Leaks & OOM](/java/memory-leaks-and-oom/#thread-leaks) |

## Unreachable (network, DNS, ingress)

The pod is fine; nobody can talk to it — or it can't talk out.

| Error text | What it means | Playbook |
|---|---|---|
| `connection refused` | You reached the IP, nothing accepts on that port — wrong `targetPort`, app on localhost only, or pod not ready | [Service Unreachable](/troubleshooting/service-unreachable/#hop-4-port-chain--port-vs-targetport-vs-containerport), [Services Deep Dive](/networking/services-deep-dive/) |
| `connection timed out` / `i/o timeout` | Packets are being **dropped** — NetworkPolicy or firewall, not a closed port | [Network Policies](/networking/network-policies/), [Debugging Network](/networking/debugging-network/) |
| `no route to host` | No path to that IP — stale endpoint, dead node, or policy drop with reject | [Debugging Network](/networking/debugging-network/), [Service Unreachable](/troubleshooting/service-unreachable/) |
| `Name or service not known` / `NXDOMAIN` | DNS says the name doesn't exist — typo, wrong namespace suffix, or missing Service | [DNS](/networking/dns/#debugging-dns-from-where-you-stand), [Service Unreachable](/troubleshooting/service-unreachable/#hop-6-dns) |
| `server misbehaving` / `SERVFAIL` | DNS infrastructure itself failed (CoreDNS or upstream) — not a typo | [DNS](/networking/dns/), [Debugging Network](/networking/debugging-network/) |
| `Temporary failure in name resolution` | DNS unreachable or overloaded — check CoreDNS, ndots, conntrack | [DNS](/networking/dns/) |
| `502 Bad Gateway` (from the edge/ingress) | Ingress reached the pod and got a broken/refused response — app crash mid-request or wrong port | [Front-Door 5xx](/troubleshooting/front-door-5xx/), [Ingress & Routing](/networking/ingress-and-routing/#debugging-502504-from-the-ingress) |
| `503 Service Temporarily Unavailable` (from the edge/ingress) | **No ready endpoints** behind the Service — readiness failing or zero replicas | [Front-Door 5xx](/troubleshooting/front-door-5xx/), [Service Unreachable](/troubleshooting/service-unreachable/#hop-8-ingress-layer--decoding-502503504) |
| `Service does not have any active Endpoint` (in ingress-nginx logs) | nginx's log-side twin of the 503 — the Service the Ingress points at has zero ready endpoints | [Front-Door 5xx](/troubleshooting/front-door-5xx/) |
| `504 Gateway Time-out` (from the edge/ingress) | Upstream took longer than the ingress timeout — slow app or long request vs. proxy timeouts | [Front-Door 5xx](/troubleshooting/front-door-5xx/), [Ingress-NGINX](/networking/ingress-nginx/#timeouts--the-60-second-504) |
| `broken header` (in ingress-nginx logs) | PROXY protocol mismatch — one side sends it, the other doesn't expect it | [Ingress-NGINX](/networking/ingress-nginx/), [External Load Balancing](/networking/external-load-balancing/#preserving-client-ips-the-other-ways) |
| `upstream connect error or disconnect/reset before headers` | Mesh sidecar can't reach the app container — mTLS, port naming, or startup ordering | [Service Mesh](/networking/service-mesh/), [Lifecycle & Ordering](/sidecars/lifecycle-and-ordering/) |
| `MQRC 2009` / `CONNECTION_BROKEN` (IBM MQ) | Long-lived MQ channel silently severed — idle timeout on an LB/firewall between client and QM | [Long-Lived Connections](/networking/long-lived-connections/), [IBM MQ](/architectures/ibm-mq/) |

## Storage and volumes

Pod stuck at `ContainerCreating`, or data isn't where it should be.

| Error text | What it means | Playbook |
|---|---|---|
| `FailedMount` | Kubelet couldn't mount a volume — the message names which and why | [Volume Failures](/troubleshooting/volume-failures/#pod-stuck-containercreating-on-volumes) |
| `Unable to attach or mount volumes` ... `timed out waiting for the condition` | The generic "mount didn't happen" umbrella — look at earlier events for the real cause | [Volume Failures](/troubleshooting/volume-failures/#2-failedmount-timeout) |
| `Multi-Attach error for volume` | RWO volume is still attached to **another node** — old pod not fully gone (common during node failure) | [Volume Failures](/troubleshooting/volume-failures/#1-multi-attach-error-on-rwo--the-1-by-a-mile), [StatefulSets Fundamentals](/stateful/statefulsets-fundamentals/) |
| `FailedAttachVolume` | The CSI driver couldn't attach the disk to the node | [Volume Failures](/troubleshooting/volume-failures/#pod-stuck-containercreating-on-volumes), [CSI Drivers](/controllers/csi-drivers/#the-failure-playbook) |
| `ProvisioningFailed` | PVC can't get a PV — wrong StorageClass name, quota, or backend out of capacity | [Storage: PV & PVC](/stateful/storage-pv-pvc/), [Volume Failures](/troubleshooting/volume-failures/#pvc-stuck-pending) |
| PVC stuck `Pending` | No provisioner acted on it — check StorageClass exists and events on the PVC | [Storage: PV & PVC](/stateful/storage-pv-pvc/) |
| `Read-only file system` (on a PVC that should be writable) | Volume remounted read-only after an I/O error, or wrong access mode | [Volume Failures](/troubleshooting/volume-failures/#read-only-filesystem-suddenly) |

## Permissions and API errors

`kubectl` or your CI pipeline said no.

| Error text | What it means | Playbook |
|---|---|---|
| `Error from server (Forbidden)` | RBAC denied the verb/resource/namespace combination — the message spells out exactly which | [RBAC Denied](/troubleshooting/rbac-denied/#parse-the-error--it-tells-you-everything), [RBAC Explained](/start/rbac-explained/) |
| `cannot create resource "pods/exec"` | You can see pods but not **exec into** them — the subresource needs its own RBAC rule | [RBAC Denied](/troubleshooting/rbac-denied/#subresources-exec-denied-while-get-works), [Working Without Admin](/start/working-without-admin/) |
| `User "system:serviceaccount:..." cannot ...` | It's your **workload's** ServiceAccount being denied, not you | [ServiceAccounts](/workloads/serviceaccounts/), [RBAC Denied](/troubleshooting/rbac-denied/#your-kubeconfig-vs-your-pods-service-account--two-different-identities) |
| `error: You must be logged in to the server (Unauthorized)` | Your kubeconfig credentials are expired or invalid — authentication, not authorization | [How kubectl Works](/kubectl/how-kubectl-works/#auth-methods-youll-actually-meet), [RBAC Denied](/troubleshooting/rbac-denied/) |
| `field is immutable` (e.g. Deployment `spec.selector`) | You changed a field Kubernetes forbids changing in place — delete/recreate or rename | [Deployments Deep Dive](/workloads/deployments-deep-dive/#the-selectorlabels-contract), [Live Patching](/operations/live-patching/) |
| `the object has been modified; please apply your changes to the latest version` | Optimistic-concurrency conflict — something else updated the object between your read and write; re-get and retry | [Live Patching](/operations/live-patching/#kubectl-edit--the-full-yaml-scalpel), [Drift & CI/CD](/operations/drift-and-cicd/) |
| `is forbidden: exceeded quota` | Namespace ResourceQuota blocks the create/update — trim requests or ask for more | [Working Without Admin](/start/working-without-admin/#know-your-budget-quotas-and-limit-ranges), [Requests & Limits Knobs](/tuning/requests-limits-knobs/) |
| `no matches for kind ... in version ...` | That apiVersion doesn't exist on this cluster — deprecated/removed API or missing CRD | [API Deprecations](/operations/api-deprecations/), [CRDs Explained](/controllers/crds-explained/) |

## TLS and the edge

Certificate and trust failures — at the ingress, between services, or from clients.

| Error text | What it means | Playbook |
|---|---|---|
| `x509: certificate signed by unknown authority` | Client doesn't trust the CA that signed the server's cert — missing CA bundle or corporate MITM proxy | [Ingress & Routing](/networking/ingress-and-routing/), [Debugging Network](/networking/debugging-network/) |
| `x509: certificate is valid for X, not Y` | Hostname mismatch — the cert doesn't cover the name you dialed | [Ingress & Routing](/networking/ingress-and-routing/) |
| `x509: certificate has expired or is not yet valid` | Expired cert (or clock skew) — check renewal automation | [Ingress & Routing](/networking/ingress-and-routing/), [ConfigMap & Secret Rotation](/operations/configmap-secret-rotation/) |
| `tls: bad certificate` | The **server** rejected the client's cert — mTLS handshake failure | [Service Mesh](/networking/service-mesh/), [Network Policies](/networking/network-policies/) |
| `Kubernetes Ingress Controller Fake Certificate` | ingress-nginx served its default self-signed cert — your Ingress's TLS secret is missing, misnamed, or the host doesn't match | [Ingress-NGINX](/networking/ingress-nginx/#tls), [Ingress & Routing](/networking/ingress-and-routing/) |
| `SSL routines ... wrong version number` | One side spoke plaintext where the other expected TLS — port/scheme mismatch, often behind TLS-terminating ingress | [Ingress & Routing](/networking/ingress-and-routing/), [TCP Ingress](/networking/tcp-ingress/) |

## Didn't find your string?

- Search the site (press `/`) with a **shorter fragment** — drop pod names, IPs, and timestamps, keep the stable words.
- Run `kubectl get events --sort-by=.lastTimestamp -n <ns>` — the event *Reason* column often maps to a row above even when your log line doesn't.
- Fall back to [Triage Methodology](/troubleshooting/triage-methodology/) to classify the failure, or browse the [Solutions Index](/start/solutions-index/) by task instead of by error.
