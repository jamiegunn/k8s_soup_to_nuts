---
title: Configuration
description: ConfigMaps and Secrets in practice — env vs volume mounts, update propagation rules, immutability, projected volumes, and forcing rollouts on config change.
sidebar:
  order: 9
---

Configuration bugs have a special quality: the app is fine, the cluster is fine, and yet production is wrong because a pod is reading last week's values. Almost all of that pain comes from not knowing exactly *when* config updates reach running containers. That's the core of this article.

:::note[This is the overview]
Three deep dives build on this page: [Environment Variables](/workloads/environment-variables/) (every env source, precedence, expansion, JVM patterns), [Config as Files](/workloads/config-files-and-volumes/) (volume mechanics, subPath, projected volumes, permissions), and [Secrets](/workloads/secrets/) (types, hygiene, keeping them out of git).
:::

## ConfigMaps and Secrets, quickly

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: payments-config
data:
  LOG_LEVEL: "info"
  application.yaml: |
    payment:
      retries: 3
      timeout-ms: 2500
---
apiVersion: v1
kind: Secret
metadata:
  name: payments-secrets
type: Opaque
stringData:                      # write plaintext here; API stores it base64'd
  DB_PASSWORD: "s3cr3t-from-vault-not-from-git"
```

Same shape, same consumption patterns. The differences: Secrets are base64-encoded at rest in the API, can be excluded from logs/`describe` output, and RBAC commonly restricts them harder.

:::danger[Base64 is not encryption]
`kubectl get secret payments-secrets -o jsonpath='{.data.DB_PASSWORD}' | base64 -d` prints the plaintext for anyone with `get` on secrets in your namespace. Base64 is an encoding, full stop. Whether Secrets are encrypted in etcd is a cluster setting you can't see — assume they're not unless the platform team says otherwise. Practical consequences: never commit Secret manifests with real values to git (use sealed-secrets, external-secrets, or your vault integration — ask what your platform provides), and treat "who has read access to our namespace" as your actual secret boundary.
:::

## Consuming config: env vars vs volume mounts

**As environment variables:**

```yaml
containers:
  - name: payments
    envFrom:
      - configMapRef: { name: payments-config }
    env:
      - name: DB_PASSWORD
        valueFrom:
          secretKeyRef: { name: payments-secrets, key: DB_PASSWORD }
```

**As mounted files:**

```yaml
    volumeMounts:
      - name: config
        mountPath: /etc/payments
        readOnly: true
volumes:
  - name: config
    configMap:
      name: payments-config
```

Each key becomes a file (`/etc/payments/LOG_LEVEL`, `/etc/payments/application.yaml`).

## Update propagation — the part to memorize

You edit the ConfigMap. What do running pods see?

| Consumption method | After ConfigMap/Secret update |
|---|---|
| **env / envFrom** | **Nothing, ever.** Env vars are resolved once at container start. Only a restart picks up new values. |
| **Volume mount** | Files update **eventually** — kubelet syncs on its cache period, typically within ~a minute. |
| **Volume mount with `subPath`** | **Never updates.** subPath mounts are a copy at mount time, frozen forever. |

Three corollaries that account for most config incidents:

1. **Env-var config + "I updated the ConfigMap" = nothing happened.** Working as designed. You must roll the pods (see the checksum pattern below).
2. **Volume updates are eventual, not atomic across the fleet.** For up to a minute-plus, different replicas run different config. The update *is* atomic per-pod (kubelet swaps a symlink, so a reader never sees a half-written file), but fleet-wide skew is real — design config changes to be safe when mixed.
3. **subPath is a propagation trap.** People use `subPath` to mount one file into a directory that has other contents; then they wonder for a day why config changes never arrive. If you need in-place updates, mount the whole volume at a dedicated path instead.

And even when the file updates, **your app must re-read it**. Most don't — they parse config at boot. Unless the app watches the file (Spring Cloud's refresh, a fsnotify loop, nginx reload), a volume update changes bytes on disk and nothing else. Be honest about which category your app is in; it determines your whole update strategy.

## The checksum-annotation pattern

Since env-consumed config needs a restart anyway — and since "eventually, per-pod" is a scary way to roll out a risky config change even for volumes — the standard pattern is: **make config changes trigger a normal rolling deploy.**

Put a hash of the config into the pod template annotations:

```yaml
spec:
  template:
    metadata:
      annotations:
        checksum/config: "9f86d081884c7d659a2feaa0c55ad015..."   # sha256 of the ConfigMap content
```

When the config changes, the checksum changes, the pod template changes, and the Deployment does a standard [rolling update](/workloads/rollouts-and-rollbacks/) — surge rules, readiness gates, `rollout status` in CI, rollback story, all of it. Helm users write `checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}`; Kustomize gets the same effect differently (below); plain-manifest pipelines can compute it in a CI step:

```bash
CHECKSUM=$(kubectl get cm payments-config -o yaml | sha256sum | cut -c1-16)
kubectl patch deploy payments -p \
  "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"checksum/config\":\"${CHECKSUM}\"}}}}}"
```

The quick-and-dirty alternative when you just need pods to re-read config *now* is `kubectl rollout restart deploy/payments` — fine operationally, but it's imperative and leaves no trace in git. The fuller decision tree is in [ConfigMap and Secret rotation](/operations/configmap-secret-rotation/).

## Immutable ConfigMaps and the rename pattern

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: payments-config-v42        # content-addressed name
immutable: true
data: { ... }
```

`immutable: true` means the API rejects any update to `data` — delete-and-recreate is the only change path. Two wins: no one can hot-edit config under your running pods (every change is forced through a new object and a pod-template change, i.e., a real reviewed rollout), and the kubelet stops watching immutable objects, which meaningfully reduces API server load in big clusters.

The workflow it implies: new config → new name (`-v42` → `-v43`, or a content hash suffix) → update the Deployment's reference → rolling update. Kustomize's `configMapGenerator` automates exactly this — hash-suffixed names, references rewritten — and is the reason many teams never need the checksum-annotation trick. The cost: garbage-collecting old ConfigMaps, which generators also mostly handle.

## Projected volumes and the downward API

**Projected volumes** merge several sources into one mount — handy when the app wants a single config directory:

```yaml
volumes:
  - name: config
    projected:
      sources:
        - configMap: { name: payments-config }
        - secret: { name: payments-secrets }
        - downwardAPI:
            items:
              - path: labels
                fieldRef: { fieldPath: metadata.labels }
```

**The downward API** injects pod metadata — the pod's own name, namespace, labels, resource limits — as env vars or files. The everyday use is tagging logs/metrics with pod identity without any Kubernetes client library:

```yaml
env:
  - name: POD_NAME
    valueFrom:
      fieldRef: { fieldPath: metadata.name }
  - name: POD_NAMESPACE
    valueFrom:
      fieldRef: { fieldPath: metadata.namespace }
  - name: MEM_LIMIT_BYTES
    valueFrom:
      resourceFieldRef: { resource: limits.memory }
```

`MEM_LIMIT_BYTES` is a favorite for [sizing runtime heaps](/java/jvm-in-containers/) relative to the container limit.

## Debugging config problems

The greatest hits, with their one-line diagnoses:

```console
# "Pod won't start" — referencing a ConfigMap/Secret that doesn't exist
$ kubectl describe pod payments-7d9f8b6c4d-x2kfp | grep -A2 Events
  Warning  Failed  12s  kubelet  Error: configmap "payments-cofnig" not found   # typo, CreateContainerConfigError

# "What config is this pod ACTUALLY running with?" — check the container, not the ConfigMap
$ kubectl exec payments-7d9f8b6c4d-x2kfp -- env | grep LOG_LEVEL
$ kubectl exec payments-7d9f8b6c4d-x2kfp -- cat /etc/payments/application.yaml

# "Which pods reference this ConfigMap?" — before you edit it
$ kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.volumes[*].configMap.name}{"\n"}{end}' | grep payments-config
```

That middle pair is the golden rule of config debugging: **inspect what the container sees, not what the API object says.** Between env-var freezing, subPath freezing, kubelet sync delay, and apps that don't re-read files, the two disagree far more often than anyone expects — and every one of those disagreements is invisible from `kubectl get configmap`.

:::tip
A missing ConfigMap blocks container start (`CreateContainerConfigError`), but here's the asymmetry: `optional: true` on the reference makes it non-blocking if you genuinely can tolerate absence. Default is required — usually what you want, because failing loud at deploy beats running with defaults silently.
:::
