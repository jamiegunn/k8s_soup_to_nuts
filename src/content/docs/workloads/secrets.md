---
title: Secrets
description: What Kubernetes Secrets actually protect, how to create and consume them safely, and how to keep them out of git without breaking your pipeline.
keywords:
  - base64 is not encryption
  - decode secret value
  - etcd encryption at rest
  - createcontainerconfigerror couldnt find key
  - sealed secrets sops external secrets operator
  - keep secrets out of git
  - imagepullsecrets dockerconfigjson
  - secret file vs env var leak
  - last-applied-configuration leak
  - immutable secret rotation
  - gitleaks trufflehog scanning
sidebar:
  order: 13
---

A Kubernetes Secret is a ConfigMap with a different type field and slightly better manners. That's not cynicism — it's the correct mental model, and internalizing it early will save you from a false sense of security. This article goes deep on Secrets specifically; for the broader ConfigMap-vs-Secret decision, see [Configuration](/workloads/configuration/), and for rotating values already in production, see [ConfigMap and Secret rotation](/operations/configmap-secret-rotation/).

## Base64 is encoding, not encryption

Every value in a Secret's `data` field is base64-encoded. That is a transport format, not protection. Anyone who can read the object can read the value:

```bash
kubectl get secret db-credentials -o jsonpath='{.data.password}' | base64 -d
```

```console
s3cr3t-hunter2
```

One command. No key, no passphrase, no audit trail beyond the API server's access log. What Secrets actually buy you over ConfigMaps:

- A separate RBAC resource, so the platform team can grant `get configmaps` without granting `get secrets`.
- Kubelet holds them in tmpfs on the node, not on disk.
- Optional encryption at rest in etcd — **if the platform team enabled it**. This is cluster configuration you cannot see or change. Ask them directly: "is etcd encryption at rest enabled, and with what provider?" If the answer is no, anyone with etcd or node-filesystem access reads everything.

Who can read your Secrets? Anyone with `get` or `list` on `secrets` in your namespace. That includes your teammates, your CI/CD service account, and possibly cluster-wide roles you can't see. The implication: a Secret protects against casual disclosure and RBAC-separated roles, not against a determined actor inside the namespace. Check your own reach with:

```bash
kubectl auth can-i get secrets
kubectl auth can-i list secrets --namespace my-app
```

If you get an unexpected `no` when your workload needs it, that's a [RBAC denied](/troubleshooting/rbac-denied/) conversation with the platform team.

## Secret types and when they matter

The `type` field is mostly a schema hint that enables validation and lets consumers find the right keys:

| Type | Required keys | Used for |
|---|---|---|
| `Opaque` (default) | none | Arbitrary key/value pairs — 90% of app secrets |
| `kubernetes.io/dockerconfigjson` | `.dockerconfigjson` | Private registry pulls via `imagePullSecrets` |
| `kubernetes.io/tls` | `tls.crt`, `tls.key` | Ingress TLS, webhook certs |
| `kubernetes.io/basic-auth` | `username`, `password` | Convention for basic-auth consumers |
| `kubernetes.io/ssh-auth` | `ssh-privatekey` | Git clone in init containers, etc. |
| `kubernetes.io/service-account-token` | (populated by controller) | **Legacy** long-lived SA tokens |

Two notes from the field:

- A malformed `dockerconfigjson` secret is a top cause of `ImagePullBackOff`. If pulls fail right after you rotate registry credentials, start at [ImagePullBackOff](/troubleshooting/imagepullbackoff/).
- Don't create `service-account-token` Secrets for new work. Since 1.24, pods get short-lived **projected** tokens automatically at `/var/run/secrets/kubernetes.io/serviceaccount/token`, rotated by the kubelet. Legacy token Secrets never expire — if you find one in your namespace from 2021, treat it as a live credential leak and clean it up.

## Creating Secrets without leaking them on the way in

### kubectl create

```bash
kubectl create secret generic db-credentials \
  --from-literal=username=app_user \
  --from-file=password=./password.txt
```

`--from-file` is preferable to `--from-literal` for real credentials, because `--from-literal` puts the value in your **shell history** (`~/.zsh_history`) and briefly in the process table where `ps` can see it. If you must inline a value, prefix the command with a space (most shells skip history for it) or read from a file descriptor.

### YAML: data vs stringData

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
type: Opaque
stringData:               # plaintext; API server base64-encodes it into .data
  username: app_user
data:                     # already base64
  password: czNjcjN0LWh1bnRlcjI=
immutable: true           # optional; see below
```

`stringData` is write-only convenience — it's merged into `data` on the server and never returned on reads. Fine for readability; irrelevant for security since both are equally decodable.

:::caution[The last-applied-configuration leak]
If you `kubectl apply` a Secret, the full plaintext-equivalent content is stored in the `kubectl.kubernetes.io/last-applied-configuration` annotation on the object — including old values after an update. Anyone who can `get` the Secret sees the previous value too. Use `kubectl apply --server-side` for Secrets, or create/replace instead of apply.
:::

### Immutable Secrets

`immutable: true` prevents all edits (you must delete and recreate). Two wins: nobody hot-patches a credential in place and skips your pipeline, and the kubelet stops polling the API server for changes, which matters at scale. The cost: rotation becomes create-new-Secret-and-roll-Deployment, which — as covered in [rotation](/operations/configmap-secret-rotation/) — is the more reliable pattern anyway.

## Consuming: files beat environment variables

You have two options, and they are not equivalent.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
  selector:
    matchLabels: { app: api }
  template:
    metadata:
      labels: { app: api }
    spec:
      imagePullSecrets:
        - name: registry-creds
      containers:
        - name: api
          image: registry.internal/team/api:1.42.0
          env:
            - name: DB_USER                      # env: convenient, leaky
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: username
          volumeMounts:
            - name: db-secret                    # file: preferred
              mountPath: /etc/secrets/db
              readOnly: true
      volumes:
        - name: db-secret
          secret:
            secretName: db-credentials
            defaultMode: 0400                    # owner read-only
            items:
              - key: password
                path: password
```

Why files win — and let's be precise, because the usual claim is wrong. `kubectl describe pod` does **not** show `secretKeyRef` values (it shows the reference, not the content). The real leak vectors for env vars:

- `/proc/<pid>/environ` is readable by anyone who can exec into the container as the same user.
- Child processes inherit the whole environment — including that shell script that pipes `env` to a debug log.
- Crash handlers and error reporters (Sentry, language runtime dumps) routinely capture the environment.
- `kubectl set env deployment/api --list` prints resolved literal env vars in plaintext (references stay references, but the habit is dangerous).
- Env vars are frozen at container start; mounted Secret files are updated in place (atomically, via symlink swap) when the Secret changes — the foundation of every sane rotation story.

`defaultMode: 0400` matters: the default is `0644`, world-readable inside the container. If you run with `runAsUser` and `fsGroup` set, Kubernetes chowns the files to the fsGroup — set the mode so only the app user reads them.

`envFrom` with a `secretRef` injects every key as an env var. Convenient, and the fastest way to accidentally hand your entire credential set to a child process. Use it sparingly.

For registry credentials, `imagePullSecrets` on the pod spec works, but attaching once to the ServiceAccount is cleaner — every pod using that SA inherits it:

```bash
kubectl patch serviceaccount default \
  -p '{"imagePullSecrets": [{"name": "registry-creds"}]}'
```

## Keeping secrets out of git (and staying pipeline-friendly)

Plain Secret YAML in git is a breach with a delay timer. The ecosystem has four mainstream answers. In every case the operator/controller install is **platform-team territory**; what you own is the namespace-scoped custom resource or annotation — consistent with [working without admin](/start/working-without-admin/).

| Tool | What lives in git | Who decrypts | Your namespace-scoped piece | Platform prerequisite |
|---|---|---|---|---|
| **Sealed Secrets** | `SealedSecret` CR (encrypted, safe to commit) | Controller in-cluster | The `SealedSecret`, sealed per-namespace by default | Controller installed; you need the public cert |
| **SOPS** (+ FluxCD/CI) | Encrypted YAML (age/KMS) | CI pipeline or Flux at deploy time | The decrypted Secret it applies | Nothing in-cluster if CI decrypts; KMS key access |
| **External Secrets Operator** | `ExternalSecret` CR (no secret material at all) | Operator, from Vault/AWS SM/GCP SM | `ExternalSecret` + `SecretStore` in your namespace | Operator installed + backend reachable |
| **CSI Secrets Store** | `SecretProviderClass` CR | Kubelet driver at pod start | `SecretProviderClass` + volume in pod spec | CSI driver + provider DaemonSet installed |

Honest guidance on which one when:

- **No external secret manager, small team:** Sealed Secrets. Lowest concept count; git remains the source of truth. Weakness: rotation means re-sealing, and losing the controller's private key means re-sealing everything.
- **You already run Vault / AWS Secrets Manager / GCP Secret Manager:** External Secrets Operator. Git contains only *references*; rotation happens in the backend and ESO syncs it into a normal Secret your pods consume unchanged. This is the best default for most orgs in 2026.
- **GitOps-heavy shop with KMS access:** SOPS. Encrypted values live next to the manifests they configure; diffs show *which* key changed. Weakness: key distribution to every decrypting pipeline.
- **Compliance says "never materialize as a Secret object":** CSI Secrets Store, which mounts straight from the backend into the pod filesystem. Weakness: env-var support requires syncing to a Secret anyway (defeating the point), and a backend outage blocks pod starts.

An `ExternalSecret`, since it's the shape you'll most likely write:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: db-credentials
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: team-vault          # SecretStore in your namespace
    kind: SecretStore
  target:
    name: db-credentials      # the plain Secret ESO creates/maintains
  data:
    - secretKey: password
      remoteRef:
        key: apps/my-app/db
        property: password
```

Your Deployment consumes `db-credentials` exactly as before. Nothing secret ever touches git, and [drift detection in CI/CD](/operations/drift-and-cicd/) still works because the CRs are declarative.

## Operational hygiene

- **Don't log secrets.** Obvious, yet startup logs that dump config are the most common leak I see in incident reviews. Redact by default; log key *names*, never values.
- **Heap dumps contain them.** Any secret your JVM has read — env var or file — sits in the heap as a plain `String`. A heap dump shared with a vendor is a credential disclosure. See [heap dumps on JRE-only images](/java/heap-dumps-jre-only/) and treat dumps like the secrets they contain.
- **Scan in CI.** Run `gitleaks` or `trufflehog` against every commit. They catch the `stringData:` block someone pasted "just to test" — and they catch it *before* it lands in history, where scrubbing requires a force-push and a rotation anyway. Detection after commit still means rotation: git history is forever.
- **Audit references before editing.** Deleting or renaming a Secret that a live pod references via env kills the next rollout, not the running pod — a delayed-fuse outage. Find consumers first:

  ```bash
  kubectl get pods -o json | jq -r '
    .items[] | select(
      (.spec.volumes[]?.secret.secretName == "db-credentials") or
      ([.spec.containers[].env[]?.valueFrom.secretKeyRef.name] | index("db-credentials")) or
      ([.spec.containers[].envFrom[]?.secretRef.name] | index("db-credentials"))
    ) | .metadata.name'
  ```

- **Know your own permissions** before you're paged: `kubectl auth can-i --list | grep -i secret` shows exactly what your account can do.

## Debugging Secret problems

**`CreateContainerConfigError`** — the classic. The pod schedules, then the kubelet can't assemble the container config:

```console
$ kubectl get pods
NAME                   READY   STATUS                       RESTARTS   AGE
api-7d9f8b6c5-x2k4p    0/1     CreateContainerConfigError   0          45s

$ kubectl describe pod api-7d9f8b6c5-x2k4p | tail -3
  Warning  Failed  12s (x4 over 40s)  kubelet
    Error: couldn't find key passwrd in Secret my-app/db-credentials
```

Either the Secret doesn't exist, or the key doesn't (typo above: `passwrd`). Compare `kubectl get secret db-credentials -o jsonpath='{.data}' | jq keys` against your manifest.

**Optional vs required:** `secretKeyRef` and `secret` volumes accept `optional: true`. Optional env vars are simply skipped if missing; an optional *volume* mounts as an empty directory. Required (the default) blocks: env refs give `CreateContainerConfigError`, volumes leave the pod in `ContainerCreating` with `MountVolume.SetUp failed ... secret "x" not found` in events. A pod stuck in `ContainerCreating` for minutes with no image activity is almost always a missing volume source.

**Verify what the pod actually got.** In your own pod, inspect the mount:

```bash
kubectl exec api-7d9f8b6c5-x2k4p -- ls -l /etc/secrets/db
```

```console
lrwxrwxrwx 1 root root 15 Jul  3 09:12 password -> ..data/password
```

The symlink through `..data` is the atomic-update mechanism at work. Check file *size* or a checksum rather than catting the value into your terminal (and your session recording):

```bash
kubectl exec api-7d9f8b6c5-x2k4p -- sh -c 'wc -c /etc/secrets/db/password; sha256sum /etc/secrets/db/password'
```

For env vars, the same rule: `kubectl exec <pod> -- sh -c 'test -n "$DB_USER" && echo set || echo missing'` confirms presence without printing the value. Every value you echo in a debug session ends up in scrollback, terminal logs, or a screen-share recording — the whole point of this article is that those are places secrets go to be found.
