---
title: "Valkey on Kubernetes: A Helm Chart Deep Dive"
description: Packaging the primary/replica Valkey build as a Helm chart on Longhorn storage — what belongs in values vs a templated conf, cluster mode, and cross-cluster active/passive.
keywords:
  - redis helm chart values vs configmap
  - valkey.conf tpl templated config
  - checksum/config annotation roll pods
  - longhorn numberOfReplicas dataLocality
  - double replication block layer and app
  - cluster-enabled 16384 hash slots sharding
  - cluster-announce-ip external access
  - replicaof over WAN active passive
  - masterauth existingSecret pattern
  - REPLICAOF NO ONE promote passive cluster
  - post-install hook cluster bootstrap job
  - valkey-cli --cluster create replicas
  - how clients connect GET SET pubsub streams
  - expose valkey internally and externally L4
sidebar:
  order: 3
---

The companion to this page is [Valkey: Two StatefulSets, One MetalLB VIP](/architectures/valkey-shared-vip/) — a complete, hand-written primary/replica build where every manifest applies as-is. Read it first; it owns the raw mechanics (the shared-VIP contract, the role-aware readiness probe, the manual promotion runbook, the async data-loss window). This page does **not** repeat those manifests. It answers the next three questions a team asks once that build works and they want to ship it to more than one namespace:

1. How do I **package this as a Helm chart** so the primary/replica topology, the config, and the VIP are one versioned, installable unit — and crucially, *what goes in `values.yaml` versus the ConfigMap versus a Secret?*
2. What changes when the PVCs live on **Longhorn** (distributed block storage) instead of the local-NVMe assumption baked into the raw build?
3. What are the topologies past a single primary/replica pair — **cluster mode** (sharding) and **cross-cluster active/passive** — and when do I actually reach for them?

If you only ever run one Valkey in one namespace, the raw-manifest page is the whole job and this one is optional reading. The moment you have three teams asking for "a Valkey like the payments one," you want a chart.

:::note[Two companion deep dives — where this page only summarizes]
This page packages the server and decides *topology*. Two child pages carry the depth it deliberately keeps high-level:

- **[Valkey Data Access: Commands, Read/Write Split, and Cluster Semantics](/architectures/valkey-data-access-patterns/)** — the verb model with runnable call examples: `GET`/`SET` and the other structures, classic vs **sharded** pub/sub (`SPUBLISH`/`SSUBSCRIBE`), Streams and consumer groups, transactions, the read/write split and the `READONLY` error, the `CROSSSLOT`/`{hashtag}` rule, and how cache-vs-store changes every command choice.
- **[Valkey Ingress: VIPs, TCP Routing, and cluster-announce](/architectures/valkey-ingress-and-cluster-announce/)** — how a connection actually reaches the right pod, with a diagram per path: internal ClusterIP vs headless DNS, every external L4 option (MetalLB, NodePort, `tcp-services`, Gateway `TCPRoute`/`TLSRoute`, proxy), the full `cluster-announce` mechanism (and why external cluster-mode clients get `MOVED` to nowhere), and TLS/ACL at the edge.
:::

## 1. The mental model: three moving parts

Before any YAML, hold the whole system in your head as **three concerns that fail independently**, because the chart's job is to keep them separable:

```text
 ┌─ DATA ──────────────┐   ┌─ IDENTITY / REPLICATION ─┐   ┌─ ACCESS ─────────────┐
 │ AOF + RDB on a PVC  │   │ primary STS  ⇄  replica  │   │ internal: ClusterIP  │
 │ (Longhorn block vol)│   │ STS, async repl over     │   │  + headless DNS      │
 │ survives pod restart│   │ headless-service DNS     │   │ external: MetalLB VIP│
 │ node loss → volume  │   │ role decided at runtime, │   │  behind corporate LB │
 │ re-attaches (§4)    │   │ not by hostname          │   │ (L4, Redis protocol) │
 └─────────┬───────────┘   └───────────┬──────────────┘   └──────────┬───────────┘
           │                           │                             │
           ▼                           ▼                             ▼
   volumeClaimTemplate          StatefulSet + probes          Service + annotations
   + StorageClass               + _helpers labels             (externalAccess toggle)
           └───────────────── all rendered by ONE Helm chart ────────────────┘
```

- **Data** is bytes on a PVC — the AOF (append-only file) and RDB snapshots. Durability is a property of the *volume*, and on Longhorn it's a property of the *StorageClass* (§4), not of Valkey.
- **Identity and replication** is which pod is primary and which is replica, and the async stream between them. In this design nobody's *name* decides the role — the readiness probe reads `INFO replication` at runtime (the load-bearing trick from the [raw build](/architectures/valkey-shared-vip/#3d-statefulset-valkey-replica)). The chart just parameterizes the two StatefulSets.
- **Access** is how clients reach it: internal consumers dial the ClusterIP or per-pod headless DNS; external consumers come through a MetalLB `LoadBalancer` VIP fronted by the network team's appliance. Valkey speaks the Redis TCP protocol, **not HTTP**, so there is no Ingress in this picture — access is L4 all the way down (§5).

Everything below is about mapping these three concerns onto Helm's surfaces — `values.yaml`, `templates/`, and a Secret — so that changing one doesn't silently perturb the others.

## 2. The Helm chart layout — and what goes where

This is the core of the page. Here's the chart, `valkey`, laid out the way [Chart Anatomy](/helm/chart-anatomy/) recommends — one file per resource kind, helpers in `_helpers.tpl`, a schema that makes typos fail loudly:

```text
charts/valkey/
├── Chart.yaml                    # name: valkey, version (chart API), appVersion: "8.1.2"
├── values.yaml                   # the user-facing API — every knob, documented
├── values.schema.json            # rejects bad/unknown values at install time
├── conf/
│   └── valkey.conf.tpl           # the daemon config, as a template (see tpl below)
├── templates/
│   ├── _helpers.tpl              # names, labels, selectorLabels, checksum helper
│   ├── configmap.yaml            # renders valkey.conf.tpl → ConfigMap
│   ├── secret.yaml               # OPTIONAL: only when auth.existingSecret is unset
│   ├── statefulset-primary.yaml  # the writer
│   ├── statefulset-replica.yaml  # the reader(s)
│   ├── services.yaml             # headless + ClusterIP + (toggled) LoadBalancer VIP
│   ├── pdb.yaml                  # maxUnavailable: 1 per role (don't block drains)
│   ├── networkpolicy.yaml        # default-deny + the three real paths
│   ├── servicemonitor.yaml       # OPTIONAL: Prometheus Operator, gated by a flag
│   ├── cluster-bootstrap-job.yaml # OPTIONAL: post-install hook, cluster mode only (§6)
│   └── NOTES.txt                 # how to connect, printed after install
```

The single decision that makes or breaks a stateful chart is **which surface each setting lives on**. Get it wrong and you either leak secrets into world-readable objects or you can't change config without editing templates. The rule:

| Setting | Lives in | Why there |
|---|---|---|
| Image tag, replica count, resources, storage size/class | **values.yaml** | Per-install knobs; passthrough blocks (`toYaml`) for `resources`/`affinity` |
| `maxmemory`, `maxmemory-policy`, `appendfsync`, `save`, `tcp-keepalive` | **values.yaml → rendered into the conf** | User-tunable, but they're *daemon config*, so they flow through the ConfigMap, not env |
| MetalLB IP + sharing key, `externalAccess.enabled`, `clusterMode.enabled` | **values.yaml** | Topology toggles the templates branch on |
| The literal `valkey.conf` text | **ConfigMap** (from `conf/valkey.conf.tpl`) | It's a file the daemon reads; mounted read-only at `/etc/valkey` |
| `requirepass` / `masterauth` password | **Secret** — referenced by `auth.existingSecret` | NEVER in values or ConfigMap: both are readable by anyone with `get` in the namespace |
| Which pod is primary vs replica | **Neither** — decided at runtime by the probe | Role is state, not config (see the raw build) |

### values.yaml — the user-facing API

Write it as documentation, because `helm show values` prints it verbatim and it *is* the manual. A realistic one:

```yaml
# values.yaml
image:
  repository: valkey/valkey
  tag: "8.1.2"                 # pin by digest in CI; appVersion is the default
  pullPolicy: IfNotPresent

architecture: primary-replica  # or "cluster" — see §6; changes which STS templates render

auth:
  existingSecret: ""           # name of a Secret with key `password`. EMPTY = chart
  existingSecretPasswordKey: password   #   generates one (dev only — see secret.yaml note)

replica:
  replicas: 1                  # bump for more read replicas; each full-syncs from primary

resources:                     # passthrough — any valid shape; requests==limits => Guaranteed
  requests: { cpu: "1", memory: 3Gi }
  limits:   { cpu: "1", memory: 3Gi }

config:                        # these interpolate into valkey.conf.tpl
  maxmemory: 2gb               # keep <= ~0.66 x memory limit (the 1.5x fork rule, §3)
  maxmemoryPolicy: noeviction  # "noeviction" = datastore; "allkeys-lru" = cache
  appendonly: true             # AOF on the primary (durability anchor)
  appendfsync: everysec        # always | everysec | no
  save: ""                     # RDB schedule on the primary; "" disables (only AOF forks)
  tcpKeepalive: 60             # sit below the appliance idle timeout (§5, long-lived conns)

persistence:
  enabled: true
  storageClass: longhorn       # ask platform; see §4 for the replica-count nuance
  size: 10Gi

externalAccess:
  enabled: false               # true renders the MetalLB LoadBalancer Services (§5)
  metallb:
    sharedIP: "10.40.0.50"     # the pinned IP from your platform ask
    sharingKey: "valkey-vip"   # metallb.io/allow-shared-ip value; identical on both Svcs
  rwPort: 6379
  roPort: 6380

pdb:
  maxUnavailable: 1            # singleton-honest: doesn't protect, but doesn't block drains

affinity: {}                   # passthrough; §8 shows the primary/replica anti-affinity
nodeSelector: {}
tolerations: []

metrics:
  enabled: false               # true renders the redis_exporter sidecar + ServiceMonitor
```

Every key appears even when empty (`affinity: {}` documents an extension point), comments explain *behavior* not syntax, and `resources`/`affinity` are verbatim passthroughs — all the [Values and Overrides](/helm/values-and-overrides/) discipline. Ship a `values.schema.json` with `additionalProperties: false` on leaf objects (`image`, `auth`) so `--set imag.tag=...` fails at install instead of silently reverting to the default.

### valkey.conf — a templated ConfigMap, and when you need `tpl`

The daemon config is a real file the process reads (`valkey-server /etc/valkey/valkey.conf`), so it belongs in a ConfigMap, mounted read-only. There are two ways to template it, and the distinction is worth getting right.

**Way one — the conf lives inside a template file.** Then it's already a template; write Go syntax directly, no `tpl` needed:

```yaml
# templates/configmap.yaml  (inline — the file IS a template, so {{ }} just works)
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "valkey.fullname" . }}-config
  labels: {{- include "valkey.labels" . | nindent 4 }}
data:
  valkey.conf: |
    port 6379
    dir /data
    appendonly {{ .Values.config.appendonly | ternary "yes" "no" }}
    appendfsync {{ .Values.config.appendfsync }}
    save "{{ .Values.config.save }}"
    maxmemory {{ .Values.config.maxmemory }}
    maxmemory-policy {{ .Values.config.maxmemoryPolicy }}
    tcp-keepalive {{ .Values.config.tcpKeepalive }}
    repl-diskless-sync yes
```

**Way two — the conf lives in `conf/valkey.conf.tpl` as a shipped file**, kept out of `templates/` so it reads like a real config file in review. Now `.Files.Get` returns it as a **raw string** — Helm does *not* auto-render files it reads with `.Files` — so you must pass it through `tpl` to interpolate values:

```yaml
# templates/configmap.yaml  (from a file — .Files.Get is raw text, tpl renders it)
data:
  valkey.conf: |-
{{ tpl (.Files.Get "conf/valkey.conf.tpl") . | indent 4 }}
```

```text
# conf/valkey.conf.tpl  — a plausible config file with template holes
port 6379
dir /data
appendonly {{ .Values.config.appendonly | ternary "yes" "no" }}
appendfsync {{ .Values.config.appendfsync }}
maxmemory {{ .Values.config.maxmemory }}
maxmemory-policy {{ .Values.config.maxmemoryPolicy }}
{{- if eq .Values.architecture "cluster" }}
cluster-enabled yes
cluster-config-file /data/nodes.conf
cluster-node-timeout 5000
{{- end }}
```

**The one-line rule for `tpl`:** you need it when the template *source* is a string that arrived at render time — from `.Files.Get`, or from a value that itself contains `{{ }}` (a user-supplied annotation, an `extraConfig` blob). You do **not** need it for a plain `templates/*.yaml` file, which the engine already renders. The [template language](/helm/template-language/#tpl-templates-inside-values) covers the trap: errors from inside a `tpl` string report a position *within the string*, not a file and line, so keep the templated conf small and legible. Pick way one for a short conf; way two once the conf grows past a screen and deserves to look like a config file.

### _helpers.tpl — names, labels, and the checksum

The standard quartet, plus the split that keeps upgrades from failing on immutable selectors ([why](/helm/template-language/#named-templates-done-right-_helperstpl)):

```yaml
{{/* templates/_helpers.tpl */}}
{{- define "valkey.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "valkey.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "valkey.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "valkey.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
```

`selectorLabels` is the minimal frozen pair that goes into every StatefulSet `spec.selector` and every Service selector; the richer `labels` set (which changes on every chart bump via `helm.sh/chart`) goes on metadata only. Merge the version-bearing labels into a selector and your first `helm upgrade` fails with `field is immutable`.

### The Secret — never in values or ConfigMap

Restating the raw build's rationale because Helm makes it easier to get wrong: a password on a Valkey command line lands in `/proc/<pid>/cmdline` on the node, and a password in a ConfigMap is readable by anyone with `get configmap` in the namespace. So the chart accepts a Secret *name* and never the material:

```yaml
# templates/statefulset-primary.yaml (env excerpt — the existingSecret pattern)
env:
- name: VALKEY_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.auth.existingSecret | default (printf "%s-auth" (include "valkey.fullname" .)) }}
      key: {{ .Values.auth.existingSecretPasswordKey }}
- name: REDISCLI_AUTH          # lets probes/exec run valkey-cli without -a on the cmdline
  valueFrom:
    secretKeyRef:
      name: {{ .Values.auth.existingSecret | default (printf "%s-auth" (include "valkey.fullname" .)) }}
      key: {{ .Values.auth.existingSecretPasswordKey }}
```

In production, `auth.existingSecret` points at a Secret your External Secrets Operator or SOPS pipeline populates — the chart just references it. The `templates/secret.yaml` that generates a random password when `existingSecret` is empty is a *dev convenience only*; gate it (`{{- if not .Values.auth.existingSecret }}`) and know that a chart-generated password lands in Helm's release Secret and every `helm get manifest`. The [b64enc trap](/helm/template-language/#b64enc-and-secrets-proceed-carefully) is the whole reason `existingSecret` is the default posture.

### Runtime-only vs file config — and the checksum that rolls pods

Two facts collide here. First, some Valkey knobs change *live* via `CONFIG SET maxmemory 4gb` and take effect without a restart; most, and everything you care about surviving a restart, live in the conf file. Second — and this is the classic Helm-on-stateful footgun — **editing a ConfigMap changes nothing the StatefulSet watches**, so `helm upgrade` with a new `maxmemory` updates the ConfigMap and leaves every pod running the old value. Pods only roll when the *pod template* changes. The fix is to hash the rendered ConfigMap into a pod annotation:

```yaml
# templates/statefulset-primary.yaml (pod template metadata)
spec:
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
      labels: {{- include "valkey.selectorLabels" . | nindent 8 }}
    spec:
      containers:
      - name: valkey
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
        command: ["valkey-server", "/etc/valkey/valkey.conf",
                  "--requirepass", "$(VALKEY_PASSWORD)",
                  "--masterauth",  "$(VALKEY_PASSWORD)"]
        resources: {{- toYaml .Values.resources | nindent 10 }}
        # ... probes, volumeMounts, securityContext as in the raw build
```

Config change → different rendered ConfigMap → different hash → pod-template diff → rolling restart, atomically with the config change. This is the [rollout-triggers](/workloads/rollout-triggers/) pattern; without it, your "I bumped maxmemory" upgrade is a no-op until the next unrelated restart, which is a confusing incident. Note the honest cost: rolling the primary is a brief write outage (§9), so batch conf changes and apply them in a window.

## 3. Config tradeoffs, mapped to values

The daemon-config decisions are the same as the [raw build](/architectures/valkey-shared-vip/#3a-secret-and-configmaps) and [Valkey/Redis fundamentals](/stateful/valkey-and-redis/) — the added angle here is *which value drives each one*, so a chart consumer tunes durability from a values file, not by editing templates.

**Persistence mode** (`config.appendonly`, `config.save`):

| Mode | Durability | Fork cost | Set via | Use when |
|---|---|---|---|---|
| AOF only (`appendonly: true`, `save: ""`) | Up to `appendfsync` granularity | One fork per AOF rewrite | primary defaults | Datastore; the primary here |
| RDB only (`appendonly: false`, `save: "900 1"`) | Last snapshot | Fork per snapshot | replica defaults | Read replica used for backups |
| Both | AOF durability + fast RDB restore | More frequent forks | both true | You want quick cold-start *and* fine durability, and can spend the RAM |

**`appendfsync`** (`config.appendfsync`):

| Value | Guarantee | Cost |
|---|---|---|
| `always` | Every write fsynced before ack | Slowest; on Longhorn every fsync is a network round-trip (§4) |
| `everysec` | ≤1s loss on power loss | The sane default |
| `no` | OS decides (up to ~30s) | Fastest, weakest |

**`maxmemory-policy`** (`config.maxmemoryPolicy`): `noeviction` makes Valkey a **store** — it returns errors when full rather than dropping data; `allkeys-lru` makes it a **cache** — it evicts to stay under `maxmemory`. Choosing `allkeys-lru` on something clients treat as durable is how you lose data nobody meant to be evictable. This is a topology decision disguised as a one-liner; put a comment on it in values.

**`save ""` on the primary**: disables RDB snapshots so the *only* fork on the write path is the occasional AOF rewrite. Snapshots run off the replica instead (its `save` is set, its `appendonly` isn't). Keeps snapshot fork cost off the latency-sensitive primary.

**The 1.5× rule** — the one that OOM-kills you if ignored: AOF rewrite and full-sync both `fork()`, and copy-on-write means peak RSS can approach 2× the dataset under write load, plus replication output buffers. Set the container memory **limit to ≥ 1.5× `maxmemory`**. In chart terms that's an invariant between two values (`resources.limits.memory` and `config.maxmemory`) that no schema enforces — document it in the values comment and, if you're strict, `fail` in a template when the ratio is violated. With `maxmemory: 2gb`, keep the limit at `3Gi`, exactly as the raw build does.

## 4. Longhorn: distributed block storage for the AOF/RDB

The raw build assumed `storageClassName: fast-local` — local NVMe, fastest possible fsync, but the pod is *pinned* to that node and node loss means volume loss (the promotion drill becomes your recovery). [Longhorn](/controllers/storage-controllers/#longhorn-a-distributed-block-store-one-volume-at-a-time) changes that story, and it changes the replica-count math in a way worth being honest about.

**What Longhorn is:** a CNCF distributed block store. Every volume gets its own tiny storage system — an engine on the pod's node, and N replicas on *other* nodes' disks, connected over the network. Writes go to all replicas synchronously; reads come from any. You select it with a StorageClass whose parameters are its fingerprint:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-valkey        # platform-owned; you consume it by name
provisioner: driver.longhorn.io
allowVolumeExpansion: true
parameters:
  numberOfReplicas: "2"        # block-layer copies on distinct nodes (see the nuance below)
  dataLocality: "best-effort"  # keep a replica on the pod's node → local reads
  staleReplicaTimeout: "30"    # minutes before a dead replica is rebuilt elsewhere
  fsType: "ext4"
```

```yaml
# volumeClaimTemplate in statefulset-primary.yaml, driven by values
volumeClaimTemplates:
- metadata:
    name: data
  spec:
    accessModes: ["ReadWriteOnce"]
    storageClassName: {{ .Values.persistence.storageClass }}
    resources:
      requests:
        storage: {{ .Values.persistence.size }}
```

**Why it changes failover:** Longhorn replicates the volume at the **block layer** across nodes. When the primary pod is rescheduled to a different node (drain, node loss), the RWO volume *follows the pod* and re-attaches with the same data — because a healthy replica exists elsewhere. Node loss no longer means volume loss. That's the drain test in the raw build's [§4.5](/architectures/valkey-shared-vip/#4-verification-plan) actually passing instead of turning into a manual promotion. Contrast local-path storage, where the PV carries node affinity and the pod can *only* schedule where the disk is.

**`dataLocality: best-effort`** migrates a replica onto the workload's own node so reads skip the network — a real win for a latency-sensitive datastore. The tradeoff is against pure spreading (a node with the local replica dying means both a reschedule *and* a rebuild), but for a read-heavy Valkey it's usually the right call.

:::caution[Double replication: you may be paying for HA twice]
Here's the nuance every Longhorn-plus-Valkey design gets wrong at least once. **Valkey already replicates** (primary → replica, app layer). If Longhorn *also* keeps 3 block replicas, you're storing the dataset **six times** (2 Valkey copies × 3 block copies) and paying synchronous cross-node block-write latency on *every* fsync on top of it — on the exact workload where fsync latency is the whole ballgame. Longhorn's write floor is a round-trip to the slowest replica; stacking that under an already-replicated database is redundant overhead, not extra safety.
:::

Reconcile the two replication layers deliberately:

| Topology | Longhorn `numberOfReplicas` | Rationale |
|---|---|---|
| Primary/replica (this build) | **2** (or even local-path) | Valkey replication already covers node loss; 2 block replicas cover the volume-follows-pod reschedule without paying for a third. `dataLocality: best-effort`. |
| Single instance, **no** app replica | **3** | Longhorn is your *only* redundancy now; give it real margin. |
| Cluster mode shard members (§6) | **1** + `strict-local`, or local-path | Each shard has its own Valkey replica; block replication is pure waste — use fast local disk. |

The instinct "more replicas = safer" is correct only when there's *nothing else* replicating. With an app-level replica in the picture, `numberOfReplicas: 2` buys you reschedule survival at a third less storage and lower write latency. Expose it as `persistence.storageClass` in values and let the platform team's class names encode the choice.

**Snapshots and backups:** Longhorn **snapshots** are in-cluster, on the same replicas — they protect you from *yourself* (bad migration, fat-fingered `FLUSHALL`), not from the cluster. Longhorn **backups** are full/incremental copies shipped to an external **S3 or NFS backupstore**, configured cluster-wide by the platform team (if no backup target is configured, "we have backups" is false no matter the docs). A `RecurringJob` schedules snapshots/backups; the CSI `VolumeSnapshot` API triggers them from standard Kubernetes objects. This complements, never replaces, application-level `BGSAVE` off the replica — see [Backup and DR](/stateful/backup-and-dr/) for why you want both layers, and [Storage: PV and PVC](/stateful/storage-pv-pvc/) plus [CSI Drivers](/controllers/csi-drivers/) for the binding and snapshot mechanics.

## 5. Internal and external access

This section is the chart-packaging summary — the `externalAccess` toggle and the Services it renders. The full treatment of *every* exposure path, TLS/ACL at the edge, and the `cluster-announce` deep dive lives in [Valkey Ingress: VIPs, TCP Routing, and cluster-announce](/architectures/valkey-ingress-and-cluster-announce/).

**Internal** consumers stay in-cluster and need nothing external. Two DNS surfaces: a `ClusterIP` Service (`{{ include "valkey.fullname" . }}` on `:6379`, load-balanced across ready endpoints) for "give me a Valkey," and the **headless** Services (`clusterIP: None`, `publishNotReadyAddresses: true`) that mint per-pod DNS — `valkey-primary-0.<headless>.<ns>.svc.cluster.local` — which is both what the replica replicates *to* and how a client pins the writer. Same as the raw build's [§3b](/architectures/valkey-shared-vip/#3b-headless-services).

**External** is where the protocol matters: Valkey speaks the **Redis TCP protocol, not HTTP**, so an HTTP Ingress cannot route it — host/path rules are meaningless for a binary TCP protocol. You need **L4**. Two doors, both covered in [TCP Ingress](/networking/tcp-ingress/):

- **MetalLB `LoadBalancer`** — the shared-VIP pattern this whole family of pages is built on. Two Services share one MetalLB IP via `metallb.io/allow-shared-ip`, split by port (`:6379` rw, `:6380` ro), fronted by the corporate appliance. The full contract (identical sharing key, disjoint ports, both `externalTrafficPolicy: Cluster`) is in the [raw build's §2](/architectures/valkey-shared-vip/#2-prerequisites-and-the-platform-ask) — don't repeat it, link it. Announcement mechanics: [MetalLB](/controllers/metallb/) and [External Load Balancing](/networking/external-load-balancing/).
- **ingress-nginx `tcp-services` ConfigMap** or **Gateway API `TCPRoute`** — when the platform already runs a shared L4 entry point and won't hand you a VIP. Platform-owned; you get a port on their controller. See [Gateway API](/networking/gateway-api/).

The chart makes external access a **toggle** so the same chart serves internal-only and externally-exposed installs:

```yaml
# templates/services.yaml (excerpt) — externalAccess gates the LoadBalancer Services
{{- if .Values.externalAccess.enabled }}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "valkey.fullname" . }}-rw
  annotations:
    metallb.io/allow-shared-ip: {{ .Values.externalAccess.metallb.sharingKey | quote }}
    metallb.io/loadBalancerIPs: {{ .Values.externalAccess.metallb.sharedIP | quote }}
spec:
  type: LoadBalancer
  externalTrafficPolicy: Cluster        # required for sharing across distinct pod sets
  selector: {{- include "valkey.selectorLabels" . | nindent 4 }}
    app.kubernetes.io/component: primary
  ports:
  - { name: valkey-rw, port: {{ .Values.externalAccess.rwPort }}, targetPort: 6379 }
---
apiVersion: v1
kind: Service
metadata:
  name: {{ include "valkey.fullname" . }}-ro
  annotations:
    metallb.io/allow-shared-ip: {{ .Values.externalAccess.metallb.sharingKey | quote }}  # MUST match
    metallb.io/loadBalancerIPs: {{ .Values.externalAccess.metallb.sharedIP | quote }}
spec:
  type: LoadBalancer
  externalTrafficPolicy: Cluster
  selector: {{- include "valkey.selectorLabels" . | nindent 4 }}
    app.kubernetes.io/component: replica
  ports:
  - { name: valkey-ro, port: {{ .Values.externalAccess.roPort }}, targetPort: 6379 }
{{- end }}
```

`externalAccess.enabled: false` (the default) renders none of it — a purely internal Valkey with no VIP burned. Remember the [raw build's idle-timeout lesson](/architectures/valkey-shared-vip/#2-prerequisites-and-the-platform-ask): the appliance's idle timeout is usually the strictest hop, so `config.tcpKeepalive` must sit below it ([Long-Lived Connections](/networking/long-lived-connections/)).

## 6. Cluster mode (sharding) — the other topology

Everything above is **primary/replica**: one dataset, scaled vertically, with read replicas. When one shard can't hold the data or absorb the write throughput, the alternative is **Valkey Cluster** — horizontal sharding.

**How it works:** the keyspace is 16384 hash slots, sharded across **≥3 primary shards**, each with a replica → **≥6 pods minimum**. Config: `cluster-enabled yes`, `cluster-config-file /data/nodes.conf` — and that file **must live on the PVC**, because it's how a node remembers its slot assignments and peers across restarts; lose it and the node forgets it was ever in a cluster. `cluster-node-timeout` governs failure detection. Clients must be **cluster-aware**: they follow `MOVED`/`ASK` redirects, and multi-key operations only work when the keys hash to the same slot — which you force with a `{hashtag}` in the key name (`user:{42}:name` and `user:{42}:email` share a slot).

**On Kubernetes** the shape is usually *one* StatefulSet of N pods plus a headless Service, then a **one-time bootstrap Job** — a Helm `post-install` hook — that wires the slots:

```yaml
# templates/cluster-bootstrap-job.yaml (sketch — only when architecture == "cluster")
{{- if eq .Values.architecture "cluster" }}
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "valkey.fullname" . }}-cluster-init
  annotations:
    "helm.sh/hook": post-install
    "helm.sh/hook-weight": "5"
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  backoffLimit: 6                 # pods must be up first; retries cover the race
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: init
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
        env:
        - name: REDISCLI_AUTH
          valueFrom: { secretKeyRef: { name: {{ .Values.auth.existingSecret }}, key: password } }
        command: ["sh","-c"]
        args:
        - |
          # collect every pod's FQDN:port, then let valkey-cli assign slots + replicas
          valkey-cli --cluster create $(POD_FQDNS) --cluster-replicas 1 --cluster-yes
{{- end }}
```

The hook runs *after* the StatefulSet's pods exist ([Helm hooks](/helm/lifecycle-and-operations/), [Jobs and CronJobs](/workloads/jobs-and-cronjobs/)); `--cluster-replicas 1` tells `valkey-cli` to make half the nodes replicas of the other half. It runs **once** — re-running against an already-formed cluster errors, which is why the delete policy and `backoffLimit` matter, and why cluster formation is genuinely harder to make idempotent than a primary/replica pair.

**External access is the hard part, and the reason cluster mode usually stays internal.** Each node must **advertise a stable, externally reachable address** to clients and to its peers, via `cluster-announce-ip`, `cluster-announce-port`, and `cluster-announce-bus-port` (the bus is the separate gossip channel, conventionally client-port + 10000). A shared VIP can't work — the client is redirected to *specific nodes* by `MOVED`, so every node needs its own routable address. That means a **per-pod LoadBalancer** (one MetalLB IP per shard member — expensive and a big platform ask) or a **cluster-aware proxy**. Because of this, cluster mode is typically kept **cluster-internal**, with only cluster-aware in-cluster clients. The full walkthrough — the `MOVED`-to-an-unreachable-pod-IP failure, the three `cluster-announce-*` settings, the gossip bus port, and per-pod addressing — is in [Valkey Ingress](/architectures/valkey-ingress-and-cluster-announce/), and the client-side `MOVED`/`ASK`/`READONLY` semantics are in [Valkey Data Access](/architectures/valkey-data-access-patterns/).

**Primary/replica vs cluster mode:**

| | Primary/replica (this build's default) | Cluster mode |
|---|---|---|
| Data | One dataset, fits in one node's RAM | Sharded across ≥3 primaries |
| Scaling | Vertical + read replicas | Horizontal (add shards) |
| Pods (min) | 2 | 6 |
| Client | Any Redis client | Must be **cluster-aware** |
| Multi-key ops | Work freely | Only within a slot (`{hashtag}`) |
| External access | Clean (shared VIP, §5) | **Hard** (per-pod addressing) |
| Ops burden | Low; manual failover runbook | Higher; slot rebalancing, node addition |
| Reach for it when | Default; one shard suffices | One shard can't hold the data *or* the write throughput |

Cluster mode is not "more HA" — it's "more capacity." If your dataset fits in one node and your writes fit in one primary, the sharding buys you complexity you don't need. Reach for it only when you've measured that one shard genuinely can't cope.

## 7. Cross-cluster active/passive (here be dragons)

The advanced ask: ship data continuously to a **passive Valkey in a second Kubernetes cluster**, for DR. Be honest up front — **OSS Valkey has no native active-active / multi-primary.** Concurrent multi-site writes with conflict resolution is CRDT territory (Redis Enterprise), not open-source Valkey. What OSS *does* support is **active/passive async replication**, which is often all DR actually needs.

The mechanism is the same `replicaof` you already use, pointed **across the WAN** at the active cluster's external VIP:

```text
   ACTIVE CLUSTER (region A)                    PASSIVE CLUSTER (region B)
 ┌──────────────────────────┐                ┌──────────────────────────┐
 │ primary (writable)       │   WAN, TLS     │ primary (read-only)      │
 │  VIP:6379  ───────────────┼──────────────► │  replicaof A-VIP 6379    │
 │  (corporate LB → MetalLB)│   async repl   │  masterauth <secret>     │
 │  clients write here      │   stream       │  continuously receives   │
 └──────────────────────────┘                └──────────────────────────┘
        │  (normal)                                   │  (on disaster)
        ▼                                             ▼
   GSLB / global DNS ─────────── flip on failover ──► point clients at B-VIP
```

The passive cluster's primary runs `replicaof <A-external-VIP> 6379` (with `masterauth` for the WAN hop), so it streams the active dataset continuously. Two ways to ship the data, and the choice is an RPO-vs-resilience call:

| Strategy | Mechanism | RPO | Needs | Pick when |
|---|---|---|---|---|
| **(a) Live cross-cluster replication** | `replicaof` over the WAN | Near-real-time (seconds = the link's lag) | Stable external endpoint on A, `masterauth`, ideally **TLS** on the WAN hop, tolerance for latency/breaks | You need low RPO and the inter-region link is reliable |
| **(b) AOF/RDB shipping to object storage** | Scheduled `BGSAVE`/AOF → S3, restore on B | Minutes-to-hours (your schedule) | Only object-store access from both sides | The link is flaky, or you want the sites fully decoupled |

Strategy (a) gives near-zero RPO but couples the two clusters to a live WAN connection that will occasionally break (and a replica stuck resyncing over a high-latency link is a real failure mode — §9). Strategy (b) survives a dead link entirely because the sites only ever talk to S3, at the cost of a much larger data-loss window. Many teams run **both**: live replication for the low-RPO path, plus periodic object-store snapshots as the fallback when the link is down.

**Failover across clusters** is a deliberate, human, one-way action:

1. Promote the passive: `REPLICAOF NO ONE` on B's primary (it becomes writable).
2. Flip **global DNS / GSLB** so clients resolve the corporate hostname to B's VIP instead of A's.
3. **Fence the old active.** If A comes back and is still writable, you have two primaries and a split brain — any client still resolving A writes to a dataset that will be discarded. Scale A's primary to zero, or reconfigure it as a replica of B, *before* it can accept writes.

:::danger[This is a design section, not a copy-paste build]
Cross-cluster replication multiplies every failure mode of the single-cluster design by a WAN link and a second control plane. RPO equals your cross-cluster replication lag — measure it in steady state so you know it *before* the disaster. Split-brain on cross-region failover has destroyed more data than the disaster it was meant to survive. Do not build this without a written, rehearsed runbook and a fencing step you've actually tested. If you need synchronous cross-site guarantees or automatic multi-site failover, you've outgrown OSS Valkey — that's [operator or Redis-Enterprise](/stateful/operators-for-state/) territory.
:::

## 8. Probes, PDB, and data protection — as chart values

These carry over verbatim from the raw build; the only change is they're now driven by values instead of hand-written.

**Role-aware readiness probe** — the single most important line ([why](/architectures/valkey-shared-vip/#3d-statefulset-valkey-replica)). The replica is Ready when it's a *healthy replica* OR a *freshly promoted master*; grep only for `master_link_status:up` and promotion (`REPLICAOF NO ONE`) makes the pod NotReady and darkens the VIP. In the chart it's still an exec probe, just templated in:

```yaml
readinessProbe:
  exec:
    command:
    - sh
    - -c
    - valkey-cli INFO replication | grep -Eq 'role:master|master_link_status:up'
  periodSeconds: {{ .Values.probes.readiness.periodSeconds | default 5 }}
  timeoutSeconds: 3
```

The primary's readiness additionally checks `role:master` and `loading:0` so the VIP never routes to a primary still loading its AOF. Liveness stays a bare `PING`. [Health checks](/workloads/health-checks/) explains the liveness/readiness split.

**Singleton PDB honesty** — with `replicas: 1`, `maxUnavailable: 1` protects nothing, but a `maxUnavailable: 0` PDB on a singleton **blocks platform-team node drains indefinitely** and earns an angry ticket. So the chart ships `pdb.maxUnavailable: 1` per role: signals "disruption-managed" without wedging maintenance.

**Anti-affinity** keeps primary and replica on **different nodes** — colocate them and one node loss takes both the write path and the promotion candidate. As a chart value (`preferred`, so a small cluster still schedules):

```yaml
# values.yaml — passed through with toYaml into both StatefulSets
affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 100
      podAffinityTerm:
        topologyKey: kubernetes.io/hostname
        labelSelector:
          matchLabels:
            app.kubernetes.io/name: valkey
```

## 9. Helm lifecycle and troubleshooting

**Install and upgrade** with the CI-safe flags from [Lifecycle and Operations](/helm/lifecycle-and-operations/):

```bash
helm upgrade --install payments-valkey ./charts/valkey \
  -f values-prod.yaml --atomic --wait --namespace payments
```

`--wait` blocks until pods are Ready (your probes' honesty, measured), and `--atomic` auto-rolls-back on failure so a bad upgrade ends reverted, not half-applied. The config-checksum annotation (§2) makes a `maxmemory` change actually roll the pods; the cluster-mode bootstrap Job runs as a `post-install` hook (§6). Always upgrade **replica image first, then primary** — a newer replica syncs from an older primary, rarely the reverse — and eat the brief write blip when the primary rolls.

| Symptom | Likely cause | Fix |
|---|---|---|
| Replica `master_link_status:down` | Wrong `masterauth`, NetworkPolicy blocking 6379, or (cross-cluster) a dead WAN link | `kubectl exec ... valkey-cli INFO replication`; check the Secret, the NetworkPolicy pod path, WAN reachability |
| Pod OOMKilled during AOF rewrite | `maxmemory` too close to the limit — the 1.5× rule (§3) | Set `resources.limits.memory` ≥ 1.5 × `config.maxmemory`; check `.status.qosClass` is still Guaranteed |
| PVC won't attach on another node | Longhorn replica placement, or expecting a local-path/RWO volume to follow the pod | Confirm `numberOfReplicas ≥ 2` on the class; local-path can't move — that's a promotion, not a reschedule (§4) |
| External VIP stuck `<pending>` | Sharing-key mismatch, pool exhausted, or ETP `Local` with distinct pod sets | `kubectl describe svc`; byte-identical `sharingKey`, both `externalTrafficPolicy: Cluster` ([MetalLB](/controllers/metallb/)) |
| Cluster bootstrap Job failed | Pods not up yet, or nodes can't reach each other on the bus port (client-port + 10000) | Check pod readiness before the hook; verify NetworkPolicy allows the bus port; re-run once cleanly |
| Config change didn't roll pods | Missing `checksum/config` annotation on the pod template | Add the sha256sum annotation (§2); the ConfigMap changed but nothing watched it |
| Cross-cluster replica stuck syncing | WAN MTU/fragmentation, or the appliance idled the long replication connection | Check path MTU, set `tcp-keepalive` below the appliance idle timeout, confirm `repl-timeout` tolerance ([Long-Lived Connections](/networking/long-lived-connections/)) |
| `helm upgrade` hangs then rolls back | `--wait` timed out — a probe never passed, often a pod still loading a large AOF | `kubectl get pods`; if healthy-but-slow, the readiness probe's timing is too tight for the dataset size |

## Which topology should I choose?

```text
Does one node's RAM hold your dataset, and one primary absorb your writes?
├── YES ─► PRIMARY/REPLICA (this build + the raw manifests). Longhorn numberOfReplicas: 2.
│         Need external access? Shared MetalLB VIP (§5). Need a DR copy in
│         another cluster? Add active/passive replication (§7) — eyes open.
└── NO ──► CLUSTER MODE (§6). ≥6 pods, cluster-aware clients, keep it internal.
          If you also need synchronous or multi-site-writable guarantees,
          you've outgrown OSS Valkey → an operator or a managed offering.
```

Start at primary/replica — it's simpler, externally accessible, and the failure modes are ones you can reason about at 2 a.m. Graduate to cluster mode only when you've *measured* that one shard can't cope, and reach past OSS Valkey only when the async data-loss window is genuinely unacceptable.

Ready to build it? The hands-on [Valkey lab](/labs/lab-9-valkey/) walks the chart from `helm install` to a failover drill on a real cluster.
