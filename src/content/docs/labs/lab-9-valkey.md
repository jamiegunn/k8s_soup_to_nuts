---
title: "Lab 9: Valkey the Hard Way — Helm, Persistence, and Failover"
description: Author a Helm chart for a persistent Valkey primary and replica, verify async replication, then run a failover, a manual promotion, and a backup-restore drill on your single-node cluster.
keywords:
  - deploy valkey with helm
  - valkey primary replica statefulset lab
  - test redis failover on kubernetes
  - helm chart for a database
  - valkey backup and restore drill
  - role-aware readiness probe master_link_status
  - replicaof headless service dns
  - checksum config annotation rolls pods
  - manual promotion replicaof no one
  - persistent volume claim local-path k3s
  - poddisruptionbudget for a statefulset
sidebar:
  order: 11
---

Back in [Lab 3](/labs/lab-3-backend-service/) you ran Valkey as a throwaway cache: one Deployment, an `emptyDir`, data you could afford to lose. That was the right call for a cache. This lab is the opposite call — Valkey as a **datastore you keep**: two StatefulSets (a write primary and a read replica), persistent volumes, async replication, a role-aware readiness probe, and a manual failover you'll actually perform. You author the whole thing as a Helm chart from an empty directory, the same way Lab 1 built `orders-api`.

This is the deployable, hands-on version of the reference build in [Valkey with a Shared VIP](/architectures/valkey-shared-vip/). That page assumes a multi-node cluster with MetalLB in front; here you'll build the same *core* — replication, persistence, promotion — on one node, and each place where a second node would change the picture is called out honestly.

**What you'll have at the end:** a Helm release `valkey` in the `labs` namespace running `valkey-primary-0` and `valkey-replica-0`, each on its own PersistentVolumeClaim, replication verified both ways, plus first-hand reps at a pod-kill failover, a manual promotion, a backup/restore, and a config change that rolls the pods.

## 0. What you'll build

```console
                writes │                    │ reads
                       ▼                    ▼
             Service valkey-rw       Service valkey-ro
             (selects role:primary)  (selects role:replica)
                       │                    │
                       ▼                    ▼
             ┌──────────────────┐   ┌──────────────────┐
             │ valkey-primary-0 │◄──┤ valkey-replica-0 │
             │  role:master     │   │  role:slave      │
             │  AOF everysec    │   │  replicaof ──────┘ (async, via headless DNS)
             │  PVC (local-path)│   │  PVC (local-path)
             └──────────────────┘   └──────────────────┘
```

Two `ClusterIP` Services split the traffic by intent — `valkey-rw` for writes, `valkey-ro` for reads — the way the [shared-VIP build](/architectures/valkey-shared-vip/) splits by port. On one node they're plain ClusterIPs; the LoadBalancer/MetalLB version is the graduation exercise in §8.

**Prerequisites**

- [Lab 0](/labs/lab-0-cluster/) completed: the Lima `k3s` cluster exists, `kubectl` defaults to the `labs` namespace, and `helm` works (`helm version` prints something). This lab needs **only** the `k3s` VM — no image builds, so the `docker` VM can stay stopped.
- If you paused since a previous sitting, revive the cluster:

```bash
limactl start k3s
export KUBECONFIG="$HOME/.lima/k3s/copied-from-guest/kubeconfig.yaml"
kubectl get nodes
```

```console
NAME       STATUS   ROLES                  AGE   VERSION
lima-k3s   Ready    control-plane,master   3d    v1.31.5+k3s1
```

All commands run from `~/k8s-labs/`. This lab is self-contained — it doesn't touch the `orders`/`cache` releases from Labs 1–4, so you can run it on a fresh Lab 0 cluster.

:::note[No new image to build]
Everything here uses the upstream `valkey/valkey:8` image straight from Docker Hub — no Dockerfile, no `docker save … | k3s ctr images import`. The only artifacts you create are the Helm chart and a Secret.
:::

## 1. Scaffold the chart

Same move as Lab 1: an empty directory, files added one at a time, every line on purpose. (We use a different chart name, `valkey-ha`, so nothing here collides with Lab 3's `charts/valkey`.)

```bash
mkdir -p ~/k8s-labs/charts/valkey-ha/templates && cd ~/k8s-labs
```

The layout you're about to fill in:

```console
charts/valkey-ha/
├── Chart.yaml
├── values.yaml
└── templates/
    ├── configmap.yaml          # valkey.conf for primary and replica
    ├── headless-services.yaml  # per-pod DNS for each StatefulSet
    ├── services.yaml           # valkey-rw and valkey-ro (ClusterIP)
    ├── primary.yaml            # the write StatefulSet
    ├── replica.yaml            # the read StatefulSet
    └── pdb.yaml                # disruption budgets
```

`charts/valkey-ha/Chart.yaml`:

```yaml
apiVersion: v2
name: valkey-ha
description: A persistent Valkey primary + replica for the labs
version: 0.1.0
appVersion: "8"
```

## 2. Values, the ConfigMap, and the Secret

Three homes for configuration, and knowing what lives where is half the point of this section:

- **`values.yaml`** — the knobs a *user* turns: image, resources, `maxmemory`, storage size. Public, in Git, in release history.
- **A ConfigMap** — the `valkey.conf` files, rendered from those values. Non-secret runtime config, versioned with the release.
- **A Secret** — the password. Created out-of-band, referenced by name, **never** in the chart.

`charts/valkey-ha/values.yaml`:

```yaml
image:
  repository: valkey/valkey
  tag: "8"
  pullPolicy: IfNotPresent

# The password is NOT here — only the name of a Secret that must already exist.
auth:
  existingSecret: valkey-auth
  secretKey: password

maxmemory: 128mb

storage:
  className: local-path   # k3s ships this StorageClass (Lab 0, Step 6)
  size: 1Gi

resources:
  requests: {cpu: 100m, memory: 192Mi}
  limits: {memory: 256Mi}
```

`charts/valkey-ha/templates/configmap.yaml` — one ConfigMap, two keys. The primary is the durability anchor (AOF on, RDB off); the replica inverts that (AOF off, RDB snapshots on) and carries the `replicaof` line that makes it a replica:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: valkey-config
  labels: {app: valkey}
data:
  primary.conf: |
    port 6379
    dir /data
    appendonly yes
    appendfsync everysec
    save ""
    maxmemory {{ .Values.maxmemory }}
    maxmemory-policy noeviction
  replica.conf: |
    port 6379
    dir /data
    replicaof valkey-primary-0.valkey-primary-hl.{{ .Release.Namespace }}.svc.cluster.local 6379
    replica-read-only yes
    appendonly no
    save 900 1
    maxmemory {{ .Values.maxmemory }}
    maxmemory-policy noeviction
```

The `replicaof` target is the **per-pod headless DNS name** of the primary — `valkey-primary-0.valkey-primary-hl.<namespace>.svc.cluster.local`. That name is stable across pod restarts (unlike a pod IP), which is exactly why StatefulSets and headless Services exist. `{{ .Release.Namespace }}` fills in `labs`.

Now the Secret — created **before** anything references it, exactly the `existingSecret` convention from Lab 3:

```bash
kubectl create secret generic valkey-auth --from-literal=password=labs-valkey-pw -n labs
```

```console
secret/valkey-auth created
```

:::note[Why the password never enters the chart]
A chart that templates its own password leaks it into `values.yaml`, into `helm get values`, and into every release Secret in history. Keeping creation out-of-band puts the credential's lifecycle in your hands — the same reasoning as Lab 3, now protecting a store instead of a cache. Production goes further (external secret stores, per-client creds); this is the honest lab minimum.
:::

## 3. The two StatefulSets

`charts/valkey-ha/templates/headless-services.yaml` — each StatefulSet needs a governing **headless** Service (`clusterIP: None`) to mint the per-pod DNS the `replicaof` line depends on:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: valkey-primary-hl
  labels: {app: valkey, role: primary}
spec:
  clusterIP: None
  publishNotReadyAddresses: true
  selector: {app: valkey, role: primary}
  ports:
    - {name: valkey, port: 6379}
---
apiVersion: v1
kind: Service
metadata:
  name: valkey-replica-hl
  labels: {app: valkey, role: replica}
spec:
  clusterIP: None
  publishNotReadyAddresses: true
  selector: {app: valkey, role: replica}
  ports:
    - {name: valkey, port: 6379}
```

`publishNotReadyAddresses: true` matters during a primary restart: the replica must still *resolve* `valkey-primary-0` while the primary is briefly NotReady, or reconnection stalls on NXDOMAIN.

`charts/valkey-ha/templates/primary.yaml`:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: valkey-primary
  labels: {app: valkey, role: primary}
spec:
  serviceName: valkey-primary-hl
  replicas: 1
  selector:
    matchLabels: {app: valkey, role: primary}
  template:
    metadata:
      labels: {app: valkey, role: primary}
      annotations:
        # Rolls the pod whenever the rendered ConfigMap changes (see §7).
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
    spec:
      terminationGracePeriodSeconds: 30
      affinity:
        podAntiAffinity:            # keep primary and replica on different nodes...
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                topologyKey: kubernetes.io/hostname
                labelSelector:
                  matchLabels: {app: valkey}
      containers:
        - name: valkey
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          command: ["valkey-server", "/etc/valkey/valkey.conf",
                    "--requirepass", "$(VALKEY_PASSWORD)",
                    "--masterauth",  "$(VALKEY_PASSWORD)"]
          env:
            - name: VALKEY_PASSWORD
              valueFrom:
                secretKeyRef: {name: {{ .Values.auth.existingSecret }}, key: {{ .Values.auth.secretKey }}}
            - name: REDISCLI_AUTH   # lets valkey-cli in probes/exec auth without -a on the cmdline
              valueFrom:
                secretKeyRef: {name: {{ .Values.auth.existingSecret }}, key: {{ .Values.auth.secretKey }}}
          ports:
            - {name: valkey, containerPort: 6379}
          livenessProbe:
            exec:
              command: ["sh", "-c", "valkey-cli PING | grep -q PONG"]
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            exec:
              command: ["sh", "-c", "valkey-cli INFO replication | grep -q 'role:master'"]
            periodSeconds: 5
            timeoutSeconds: 3
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          volumeMounts:
            - {name: config, mountPath: /etc/valkey, readOnly: true}
            - {name: data, mountPath: /data}
      volumes:
        - name: config
          configMap:
            name: valkey-config
            items:
              - {key: primary.conf, path: valkey.conf}
  volumeClaimTemplates:
    - metadata:
        name: data
        labels: {app: valkey}
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: {{ .Values.storage.className }}
        resources:
          requests:
            storage: {{ .Values.storage.size }}
```

`charts/valkey-ha/templates/replica.yaml` — the same shape with three deliberate differences: it labels itself `role: replica`, mounts `replica.conf`, and its readiness probe is **role-aware**:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: valkey-replica
  labels: {app: valkey, role: replica}
spec:
  serviceName: valkey-replica-hl
  replicas: 1
  selector:
    matchLabels: {app: valkey, role: replica}
  template:
    metadata:
      labels: {app: valkey, role: replica}
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
    spec:
      terminationGracePeriodSeconds: 30
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                topologyKey: kubernetes.io/hostname
                labelSelector:
                  matchLabels: {app: valkey}
      containers:
        - name: valkey
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          command: ["valkey-server", "/etc/valkey/valkey.conf",
                    "--requirepass", "$(VALKEY_PASSWORD)",
                    "--masterauth",  "$(VALKEY_PASSWORD)"]
          env:
            - name: VALKEY_PASSWORD
              valueFrom:
                secretKeyRef: {name: {{ .Values.auth.existingSecret }}, key: {{ .Values.auth.secretKey }}}
            - name: REDISCLI_AUTH
              valueFrom:
                secretKeyRef: {name: {{ .Values.auth.existingSecret }}, key: {{ .Values.auth.secretKey }}}
          ports:
            - {name: valkey, containerPort: 6379}
          livenessProbe:
            exec:
              command: ["sh", "-c", "valkey-cli PING | grep -q PONG"]
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            # Ready = healthy replica (link up) OR promoted master. The 'role:master'
            # half is what keeps a promoted pod Ready in §5 — do not drop it.
            exec:
              command: ["sh", "-c", "valkey-cli INFO replication | grep -Eq 'role:master|master_link_status:up'"]
            periodSeconds: 5
            timeoutSeconds: 3
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          volumeMounts:
            - {name: config, mountPath: /etc/valkey, readOnly: true}
            - {name: data, mountPath: /data}
      volumes:
        - name: config
          configMap:
            name: valkey-config
            items:
              - {key: replica.conf, path: valkey.conf}
  volumeClaimTemplates:
    - metadata:
        name: data
        labels: {app: valkey}
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: {{ .Values.storage.className }}
        resources:
          requests:
            storage: {{ .Values.storage.size }}
```

Four choices worth reading twice:

- **The role-aware replica probe.** In steady state the replica is `role:slave`, and readiness hinges on `master_link_status:up` — if replication breaks, the probe fails and the pod leaves `valkey-ro`'s Endpoints, so readers get connection-refused instead of *silently stale* data. Serving errors beats serving lies. The `role:master` clause looks dead today; §5 shows it's the promotion enabler. The liveness/readiness split is the subject of [Health Checks](/workloads/health-checks/).
- **`podAntiAffinity` is `preferred`, not `required` — and on one node it does nothing.** With a single node, both pods schedule onto `lima-k3s` together; `preferred` lets that happen instead of leaving a pod `Pending` forever. On a real multi-node cluster the same block pushes primary and replica onto different nodes, so one node loss doesn't take both. We'll say this out loud again in §8.
- **`local-path` persistence.** k3s's bundled `local-path` provisioner (Lab 0, Step 6) carves a directory on the node's disk for each PVC. Perfect for one node. It is **node-local**: the volume can't move to another node, which is the single most important limitation to remember when you graduate (§8).
- **The `checksum/config` annotation** hashes the rendered ConfigMap into the pod template. Change a conf value, the hash changes, and `helm upgrade` rolls the pods — you'll trigger this on purpose in §7.

`charts/valkey-ha/templates/services.yaml` — the read/write split, as plain ClusterIPs:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: valkey-rw
  labels: {app: valkey}
spec:
  selector: {app: valkey, role: primary}
  ports:
    - {name: valkey, port: 6379, targetPort: 6379}
---
apiVersion: v1
kind: Service
metadata:
  name: valkey-ro
  labels: {app: valkey}
spec:
  selector: {app: valkey, role: replica}
  ports:
    - {name: valkey, port: 6379, targetPort: 6379}
```

`charts/valkey-ha/templates/pdb.yaml`:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: valkey-primary
spec:
  maxUnavailable: 1
  selector:
    matchLabels: {app: valkey, role: primary}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: valkey-replica
spec:
  maxUnavailable: 1
  selector:
    matchLabels: {app: valkey, role: replica}
```

With `replicas: 1`, `maxUnavailable: 1` protects nothing on its own — its real job is to **not block** a platform-team node drain (a `maxUnavailable: 0` PDB on a singleton stalls maintenance forever) while marking the workload as disruption-managed. The honest reasoning is in the [shared-VIP build's PDB note](/architectures/valkey-shared-vip/).

## 4. Install and verify replication

Render before you install — never apply a template you haven't read (Lab 1's rule):

```bash
helm template valkey ./charts/valkey-ha | less
```

You should see two StatefulSets, two headless Services, two ClusterIP Services, one ConfigMap, and two PDBs. Happy? Install:

```bash
helm install valkey ./charts/valkey-ha -n labs
kubectl get pods -w
```

```console
NAME               READY   STATUS    RESTARTS   AGE
valkey-primary-0   0/1     Running   0          6s
valkey-replica-0   0/1     Running   0          6s
valkey-primary-0   1/1     Running   0          12s
valkey-replica-0   1/1     Running   0          15s
```

The primary goes `1/1` a beat before the replica — the replica's probe only passes once `master_link_status:up`, i.e. once replication is actually flowing. `Ctrl-C` the watch. Confirm the PVCs bound:

```bash
kubectl get pvc -n labs
```

```console
NAME                    STATUS   VOLUME     CAPACITY   ACCESS MODES   STORAGECLASS   AGE
data-valkey-primary-0   Bound    pvc-1a2b   1Gi        RWO            local-path     40s
data-valkey-replica-0   Bound    pvc-3c4d   1Gi        RWO            local-path     40s
```

Now prove replication from both sides. `REDISCLI_AUTH` is set in each pod, so `valkey-cli` authenticates with no `-a` flag:

```bash
kubectl exec valkey-primary-0 -n labs -- valkey-cli INFO replication | grep -E 'role|connected_slaves'
kubectl exec valkey-replica-0 -n labs -- valkey-cli INFO replication | grep -E 'role|master_link_status'
```

```console
role:master
connected_slaves:1
role:slave
master_link_status:up
```

One master, one connected slave, link up. Now write on the primary, read on the replica, and confirm the replica refuses writes:

```bash
kubectl exec valkey-primary-0 -n labs -- valkey-cli SET greeting "hello from primary"
kubectl exec valkey-replica-0 -n labs -- valkey-cli GET greeting
kubectl exec valkey-replica-0 -n labs -- valkey-cli SET greeting "nope"
```

```console
OK
hello from primary
(error) READONLY You can't write against a read only replica.
```

The `READONLY` error is the design working — `replica-read-only yes` doing its job. **Checkpoint:** if all three lines above match, you have a live replicated pair.

## 5. Failover drill

Working systems teach less than broken ones. First, the automatic recovery — kill the primary and watch the StatefulSet rebuild it on the *same* PVC:

```bash
kubectl delete pod valkey-primary-0 -n labs
kubectl get pods -w
```

```console
valkey-primary-0   0/1     Terminating         0     5m
valkey-primary-0   0/1     Pending             0     0s
valkey-primary-0   0/1     ContainerCreating   0     1s
valkey-primary-0   0/1     Running             0     3s
valkey-primary-0   1/1     Running             0     9s
```

`Ctrl-C` when it's `1/1`. The pod came back on the same identity and the same volume, so fsynced data survived — check it:

```bash
kubectl exec valkey-primary-0 -n labs -- valkey-cli GET greeting
kubectl exec valkey-replica-0 -n labs -- valkey-cli INFO replication | grep master_link_status
```

```console
hello from primary
master_link_status:up
```

`greeting` is still there (AOF replayed it), and if you'd watched the replica during the gap you'd have seen `master_link_status` flip `down → up` as it reconnected. That's the whole automatic story: **pod loss recovers itself; data loss does not happen for fsynced writes.**

:::caution[What the pod-restart drill does *not* cover]
The StatefulSet only rescues you when the *pod* dies. If the *node or the volume* is lost, `local-path` data is gone with it and the primary can't reschedule — this is where you promote the replica by hand. On one node you can't stage a real node failure, so simulate the human procedure below.
:::

**Manual promotion (mini-runbook).** Promote the replica to a standalone master and repoint the write Service at it:

```bash
# 1. Confirm the deployed probe is the role-aware one BEFORE promoting.
kubectl get sts valkey-replica -n labs -o yaml | grep -A1 'role:master'

# 2. Promote: the replica becomes its own master.
kubectl exec valkey-replica-0 -n labs -- valkey-cli REPLICAOF NO ONE

# 3. Repoint the write path — patch the Service selector, not the clients.
kubectl patch svc valkey-rw -n labs -p '{"spec":{"selector":{"app":"valkey","role":"replica"}}}'

# 4. Verify writes now land on the promoted pod (resolving valkey-rw from inside the pod).
kubectl exec valkey-replica-0 -n labs -- valkey-cli -h valkey-rw SET promoted yes
kubectl exec valkey-replica-0 -n labs -- valkey-cli -h valkey-rw GET promoted
```

```console
        - valkey-cli INFO replication | grep -Eq 'role:master|master_link_status:up'
      failureThreshold: 3
OK
service/valkey-rw patched
OK
yes
```

Here's why step 1 is step 1: `REPLICAOF NO ONE` makes `master_link_status` **vanish** from `INFO replication` (a master has no master link). A probe that greps only for `master_link_status:up` would fail the instant you promote, the pod would go NotReady, and kube-proxy would pull it from `valkey-ro`'s Endpoints — a self-inflicted outage. The `role:master` clause in the §3 probe is what holds the door open, keeping the promoted pod Ready. That single OR condition is the load-bearing line of the whole build.

This is the abbreviated form. The full runbook — measuring the async data-loss window, persisting the promotion into the ConfigMap so an unplanned restart doesn't undo it, and fencing the old primary against split-brain — is in [Valkey with a Shared VIP §6](/architectures/valkey-shared-vip/). Reset your lab pair before continuing:

```bash
helm upgrade valkey ./charts/valkey-ha -n labs   # snaps the valkey-rw selector back to role:primary
kubectl delete pod valkey-replica-0 -n labs      # restarts it, re-reading replica.conf → rejoins as a replica
```

## 6. Backup and restore drill

Snapshots run off the **replica**, so the `fork()` and disk I/O never touch the write path. Plant a canary, back up, "lose" it, and restore it into a scratch instance:

```bash
# Plant a key on the primary; it replicates to the replica.
kubectl exec valkey-primary-0 -n labs -- valkey-cli SET backup:canary keepme

# Snapshot on the replica and wait for it to finish.
kubectl exec valkey-replica-0 -n labs -- valkey-cli BGSAVE
kubectl exec valkey-replica-0 -n labs -- valkey-cli INFO persistence | grep rdb_bgsave_in_progress
```

```console
Background saving started
rdb_bgsave_in_progress:0
```

`rdb_bgsave_in_progress:0` means the dump is written. Copy it off the pod, then simulate data loss:

```bash
kubectl cp labs/valkey-replica-0:/data/dump.rdb ./valkey-backup.rdb
kubectl exec valkey-primary-0 -n labs -- valkey-cli DEL backup:canary
kubectl exec valkey-primary-0 -n labs -- valkey-cli GET backup:canary
```

```console
(nil)
```

Gone everywhere (the `DEL` replicated too). Now prove the backup is restorable by loading it into a throwaway Valkey — the clean way to restore, since dropping an RDB onto the live replica would just get overwritten by the next resync from the primary:

```bash
kubectl run valkey-restore --image=valkey/valkey:8 --restart=Never -n labs --command -- sleep 3600
kubectl cp ./valkey-backup.rdb labs/valkey-restore:/data/dump.rdb
kubectl exec valkey-restore -n labs -- sh -c 'valkey-server --dir /data --daemonize yes; sleep 1; valkey-cli GET backup:canary'
```

```console
keepme
```

The canary is back — the backup captured it and restores cleanly. In a real recovery you'd reconcile that restored dataset into the pair; the strategies (scheduled snapshots, off-cluster copies, PITR) are in [Backup and DR](/stateful/backup-and-dr/). Clean up the scratch pod and the local file:

```bash
kubectl delete pod valkey-restore -n labs
rm valkey-backup.rdb
```

## 7. A config change rolls the pods

This ties §3's `checksum/config` annotation to something you can watch. Note the primary's current checksum, bump `maxmemory`, then upgrade:

```bash
kubectl get pod valkey-primary-0 -n labs -o jsonpath='{.metadata.annotations.checksum/config}{"\n"}'
```

Edit `charts/valkey-ha/values.yaml` and change `maxmemory: 128mb` to `maxmemory: 192mb`, then:

```bash
helm upgrade valkey ./charts/valkey-ha -n labs
kubectl rollout status statefulset/valkey-primary -n labs
kubectl rollout status statefulset/valkey-replica -n labs
```

```console
Release "valkey" has been upgraded. Happy Helming!
statefulset rolling update complete 1 pods at revision valkey-primary-...
statefulset rolling update complete 1 pods at revision valkey-replica-...
```

The pods restarted even though nothing in the *pod template proper* changed — only the ConfigMap did. The checksum annotation is the mechanism: a new rendered ConfigMap produces a new hash, the hash lives in the pod template, so Kubernetes sees a template change and rolls. Confirm the annotation moved and the setting took:

```bash
kubectl get pod valkey-primary-0 -n labs -o jsonpath='{.metadata.annotations.checksum/config}{"\n"}'
kubectl exec valkey-primary-0 -n labs -- valkey-cli CONFIG GET maxmemory
```

```console
9f2c...   # a different hash than before
maxmemory
201326592
```

`201326592` bytes is 192 MB. Without the checksum trick, a `helm upgrade` that only changed the ConfigMap would leave the running pods on the *old* config until something unrelated happened to restart them — a classic "why didn't my change take effect" trap.

## 8. Optional / advanced — what changes when you graduate

Everything above runs on one node. The pieces below need more than the lab cluster gives you, so they're marked clearly — don't try to make them work here; read them as "here's what changes at work." Each gets its real treatment in the [Valkey Helm deep dive](/architectures/valkey-helm-deep-dive/).

- **Distributed storage (Longhorn).** `local-path` pins each PVC to one node's disk, so a promoted replica can't reclaim the dead primary's volume — you replicate at the *app* layer instead. With a multi-node cluster and [Longhorn](/controllers/storage-controllers/) (or a cloud block-storage class), a PVC can detach from a failed node and reattach elsewhere, so a rescheduled pod finds its data. That's what makes `podAntiAffinity: required` and true node-failure survival viable.
- **A shared VIP for external clients (MetalLB).** Here the Services are ClusterIPs reachable only inside the cluster. In [Valkey with a Shared VIP](/architectures/valkey-shared-vip/), `valkey-rw` and `valkey-ro` become `LoadBalancer` Services sharing **one** MetalLB IP via `metallb.io/allow-shared-ip`, split by port (6379/6380). [MetalLB](/controllers/metallb/) needs an address pool and (across nodes) L2 or BGP announcement — not something a single-node lab exercises, though MetalLB *can* run on one node for a taste.
- **Cluster mode (sharding).** Primary/replica scales *reads* and gives you failover, but every key still lives on one primary. Valkey **Cluster** shards the keyspace across many primaries, each with replicas — a genuinely different topology (hash slots, `MOVED`/`ASK` redirects, cluster-aware clients), not just "more replicas."
- **Cross-cluster active/passive.** For DR spanning regions you run a second cluster and replicate into it (or restore backups into it) with a documented, rehearsed cutover. That's an organizational capability — two clusters, DNS failover, tested runbooks — well beyond one laptop VM.

## 9. Teardown

The teardown promise, kept — but with a StatefulSet twist worth internalizing: **`helm uninstall` does not delete PVCs, and it does not delete the Secret you created by hand.** That's deliberate (deleting a release shouldn't nuke your data), and it's exactly how you'd accidentally leave orphaned volumes behind in production.

```bash
helm uninstall valkey -n labs
kubectl get pvc -n labs
```

```console
release "valkey" uninstalled
NAME                    STATUS   VOLUME     CAPACITY   ACCESS MODES   STORAGECLASS   AGE
data-valkey-primary-0   Bound    pvc-1a2b   1Gi        RWO            local-path     22m
data-valkey-replica-0   Bound    pvc-3c4d   1Gi        RWO            local-path     22m
```

The PVCs (and their data) outlived the release. Reclaim them and the Secret explicitly — the `app: valkey` label you put on the `volumeClaimTemplates` makes the selector clean:

```bash
kubectl delete pvc -l app=valkey -n labs
kubectl delete secret valkey-auth -n labs
```

```console
persistentvolumeclaim "data-valkey-primary-0" deleted
persistentvolumeclaim "data-valkey-replica-0" deleted
secret "valkey-auth" deleted
```

To keep the chart for later, that's all — the files under `~/k8s-labs/charts/valkey-ha/` cost nothing at rest. Pausing the whole cluster between sittings is the usual `limactl stop k3s`; the full scorched-earth recipe lives in the [labs overview](/labs/overview/).

## Where you are now

You built the persistent, replicated Valkey that Lab 3's cache deliberately wasn't: two StatefulSets on their own volumes, async replication verified both ways, a role-aware readiness probe you now understand line by line, and muscle memory for the three drills that matter — pod-kill recovery, manual promotion, and backup/restore. You also felt where a single node stops you: distributed storage, an external shared VIP, and sharding all wait on the graduation to real infrastructure.

Read [Valkey with a Shared VIP](/architectures/valkey-shared-vip/) next and every part will look familiar — you've now deployed its beating heart. In [Lab 10](/labs/lab-10-autoscaling/), this primary gets one more job: a KEDA scaler watches one of its lists and scales a worker fleet on queue depth — including down to zero. The broader map from lab to production is [From the Lab to the Paved Road](/labs/from-lab-to-prod/).
