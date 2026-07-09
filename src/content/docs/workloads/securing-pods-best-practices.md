---
title: "Securing Pods: Best Practices"
description: A prioritized, copy-paste hardening playbook for pods — the practices in blast-radius order, plus the exact commands to audit your namespace and prove a running pod is locked down.
keywords:
  - how to harden a pod
  - pod hardening checklist
  - audit pods for privileged containers
  - verify runAsNonRoot at runtime
  - check capabilities dropped CapEff
  - find hostPath hostNetwork pods
  - default-deny network policy starter
  - scan image for vulnerabilities trivy
  - kubesec kube-score polaris
  - is my pod actually secure
  - least privilege service account token
  - dry-run pod security admission
sidebar:
  order: 17
---

[Pod Security](/workloads/pod-security/) is the *reference* — every `securityContext` field explained, and how Pod Security Admission rejects your workloads. This page is the *playbook*: the practices in the order you should apply them, copy-paste manifests, and — the part most guides skip — the **commands to audit what you already run and prove a pod is actually hardened**. A `securityContext` block in your YAML is a claim; these commands are how you check it's true.

Everything here is squarely on your side of the [ownership line](/operations/working-with-platform-team/): it's your pod spec. The walls (namespace PSA labels, policy engines) are the platform team's, and covered in the reference.

## The 60-second hardened pod

If you copy one thing, copy this. It passes the `restricted` Pod Security Standard and stays debuggable:

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
      automountServiceAccountToken: false     # off unless the app calls the K8s API
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: app
          image: registry.example.com/orders@sha256:9f2c…   # pinned by digest, not :latest
          ports:
            - containerPort: 8080                            # unprivileged; Service maps 80 → 8080
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          resources:
            requests: { cpu: 250m, memory: 512Mi }
            limits:   { memory: 512Mi }                      # memory limit = a DoS control
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: tmp
          emptyDir: { sizeLimit: 256Mi }
```

Every field is explained in [Pod Security](/workloads/pod-security/). The rest of this page is *why in this order*, and *how to verify*.

## Practices in blast-radius order

Apply top-down. The first four break almost nothing; the last few need per-app testing. Ship each through your normal pipeline, one workload at a time.

| # | Practice | Why | Risk of breaking the app |
|---|---|---|---|
| 1 | `allowPrivilegeEscalation: false` | Blocks setuid privilege gain | Nearly none |
| 2 | `seccompProfile: RuntimeDefault` | Filters dangerous syscalls | Nearly none |
| 3 | `capabilities.drop: ["ALL"]` | Removes all Linux capabilities | Only breaks binding ports <1024 |
| 4 | `automountServiceAccountToken: false` | No API token to steal | Breaks apps that call the K8s API |
| 5 | `runAsNonRoot: true` (+ `runAsUser`) | No root in the container | Breaks root-assuming images |
| 6 | `readOnlyRootFilesystem: true` (+ emptyDir kit) | Immutable rootfs | Breaks apps that write to `/` |
| 7 | Pin images by digest, scan them | Supply-chain integrity | None (build-time) |
| 8 | Default-deny NetworkPolicy | Least-privilege network | Breaks flows you forgot to allow |
| 9 | Memory limits | Caps blast radius of a leak/DoS | Only if under-set (OOMKill) |

## Prove a running pod is actually hardened

Setting a field isn't the same as it taking effect (a container-level override, a mutating webhook, or an old ReplicaSet can all lie to you). Check the live pod, not the YAML:

```bash
# Runs as the UID you asked for? (expect uid=10001, not 0)
kubectl exec deploy/orders -- id

# Capabilities really dropped? CapEff should be all zeros (0000000000000000).
# 0000000000000400 means NET_BIND_SERVICE is still added.
kubectl exec deploy/orders -- cat /proc/1/status | grep -i '^Cap'

# Root filesystem really read-only? This should FAIL with "Read-only file system".
kubectl exec deploy/orders -- sh -c 'touch /nope' 2>&1 || echo 'good: rootfs is read-only'

# API token really absent? Expect "No such file or directory".
kubectl exec deploy/orders -- ls /var/run/secrets/kubernetes.io/serviceaccount 2>&1
```

:::tip[The image has no shell]
On distroless/scratch images `kubectl exec` has nothing to run. Use an ephemeral container that shares the target's namespaces instead — `kubectl debug -it <pod> --image=busybox --target=app -- cat /proc/1/status`. Full technique in the [Debugging Toolbox](/troubleshooting/debugging-toolbox/).
:::

## Audit a whole namespace at once

Before you harden, find what's already dangerous. These jsonpath sweeps need no extra tools — run them in any namespace you can read:

```bash
# Privileged containers (should print nothing but names with empty values)
kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{": priv="}{.spec.containers[*].securityContext.privileged}{"\n"}{end}'

# hostPath volumes (a container escape waiting to happen)
kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.volumes[*].hostPath.path}{"\n"}{end}'

# hostNetwork / hostPID pods
kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\thostNet="}{.spec.hostNetwork}{"\thostPID="}{.spec.hostPID}{"\n"}{end}'
```

jsonpath is fine for the obvious red flags, but it's clumsy for "does this pass `restricted`?" (the rule is pod-*or*-container level, with defaults). For real coverage, run a scanner against your manifests or live cluster:

```bash
trivy k8s --report summary deployment/orders     # misconfig + vuln scan of live workloads
kubesec scan pod.yaml                             # scores a manifest, tells you what to add
kube-score score deployment.yaml                  # opinionated best-practice linter
```

## Test against Pod Security Admission before you ship

Don't discover a `restricted` violation at deploy time. A server-side dry run runs your manifest through admission — including PSA — and returns the exact rejection **without creating anything**:

```bash
kubectl apply --dry-run=server -f deploy.yaml
```

If the namespace enforces (or `warn`s) `restricted`, you'll get the same field-by-field message a real apply would — it's your pre-flight checklist. (Remember PSA validates *pods*: a Deployment applies fine, then its pods get rejected. The reference page covers that "controller succeeded, children forbidden" trap.)

## Least-privilege the API token

Most apps never call the Kubernetes API, yet by default every pod gets a mounted, valid ServiceAccount token — a ready-made credential for anyone who pops a shell. Turn it off:

```yaml
spec:
  automountServiceAccountToken: false
```

Verify it's gone with the `ls` check above. If the app *does* call the API, don't leave it on the `default` ServiceAccount — give it a dedicated SA with a minimal Role. See [ServiceAccounts](/workloads/serviceaccounts/).

## Keep secrets out of the image and out of env

A hardened process still leaks if the secret is sitting in `docker history` or a `kubectl describe`:

- **Never bake secrets into the image.** Scan for it: `trivy image --scanners secret registry.example.com/orders:1.14.2`.
- **Prefer mounted files over env vars.** Env vars show up in `kubectl describe pod`, crash dumps, and child-process environments. Details and the encryption caveats are in [Secrets](/workloads/secrets/).

```bash
# Quick leak check: are any of your env values obviously secret-shaped?
kubectl set env deploy/orders --list | grep -iE 'password|token|secret|key'
```

## Lock down the network with a default-deny

An unhardened pod trusts the whole cluster. The flat pod network means *any* pod can reach yours until a policy says otherwise. Start every namespace with a default-deny, then allow only what you need:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
spec:
  podSelector: {}          # every pod in the namespace
  policyTypes: [Ingress, Egress]
  # no ingress/egress rules = deny both directions
```

:::caution[Deny-all also blocks DNS]
The moment you add egress deny, pods can't resolve names until you allow egress to `kube-dns` on UDP/TCP 53. This is the number-one "my default-deny broke everything" gotcha. The full pattern — including the DNS allow rule — is in [Network Policies](/networking/network-policies/), and enforcement depends on your cluster's CNI (a platform fact worth confirming).
:::

## Trust your images (supply chain)

The most-hardened runtime can't save you from a compromised base image:

- **Start from a non-root, minimal base** — distroless or a slim image with a real `USER`. Fewer binaries = smaller attack surface *and* fewer CVEs to patch.
- **Pin by digest, never `:latest`.** `image: registry/orders@sha256:…` guarantees the bytes you scanned are the bytes you run. (The Field Note "the image that changed under us" is what happens when you don't.)
- **Scan in CI and gate on it** — `trivy image --exit-code 1 --severity HIGH,CRITICAL <image>`. Many clusters also enforce this at admission via Kyverno/Gatekeeper; see [Admission Webhooks](/controllers/admission-webhooks/).

## Resource limits are a security control

It's easy to file limits under "performance," but an unbounded pod is a denial-of-service risk: a memory leak or a malicious payload can starve every neighbor on the node. A `memory` limit caps that blast radius (the kernel OOM-kills the offender, not the node). Set requests and a memory limit on everything — sizing guidance in [Resources and QoS](/workloads/resources-and-qos/).

## Roll it out without an incident

The whole checklist, applied at once, to every workload, is how you cause the outage you were trying to prevent. Do it the way PSA itself is designed to:

1. Ask the platform team to set the namespace to `warn` + `audit` at `restricted` while `enforce` stays at `baseline`. Now every `kubectl apply` and audit-log entry names exactly what would break — at zero production risk.
2. Work down the blast-radius table above, one workload and one row at a time, watching startup and logs for a full cycle after each.
3. When nothing warns anymore, ask them to flip `enforce`.

## The checklist

```text
[ ] allowPrivilegeEscalation: false
[ ] seccompProfile: RuntimeDefault
[ ] capabilities.drop: ["ALL"]   (add back only NET_BIND_SERVICE if truly needed)
[ ] automountServiceAccountToken: false   (unless the app calls the API)
[ ] runAsNonRoot: true  (+ runAsUser/runAsGroup)
[ ] readOnlyRootFilesystem: true  (+ emptyDir for /tmp and cache paths)
[ ] fsGroup set so volumes are writable by the non-root user
[ ] image pinned by digest, scanned, non-root base
[ ] requests set + memory limit set
[ ] default-deny NetworkPolicy in the namespace (+ DNS egress allow)
[ ] verified on the LIVE pod: id, /proc/1/status Cap*, read-only rootfs, no token
```

Pin this next to your Deployment template. Hardening you can't verify is hardening you don't have.
