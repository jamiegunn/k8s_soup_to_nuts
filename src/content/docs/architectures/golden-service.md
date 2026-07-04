---
title: "The Golden Service: Production Stateless Reference"
description: The complete production-grade stateless web service — orders-api assembled end to end, every manifest included and every number traced back to the knob that set it.
sidebar:
  order: 6
---

The four stateful builds in this section each fight a specific hard problem — quorum, storage, failover. This one fights the *general* problem: a stateless HTTP service that deploys without dropping requests, survives a zone loss, scales on real signals, and never surprises you at 3 a.m. The patient is **orders-api**, the Spring Boot service that the [Sizing Walkthrough](/tuning/sizing-walkthrough/) carried from "no data" to measured numbers. Every tuned value below — the 800m CPU request, the 1.5Gi memory, the 80-second startup budget, the 70% HPA target — comes from that walkthrough; this article does not re-derive them, it assembles them into the full production stack, in apply order, with nothing omitted.

"Golden" does not mean exotic. It means **every default that bites has been consciously set**: the service account token that mounts by default, the root filesystem that's writable by default, the CPU limit someone adds by default, the replicas field that fights the HPA by default, the 60-second nginx timeout nobody chose. Each manifest below overrides a default on purpose and says why.

## Architecture

```text
                          clients
                             │ HTTPS orders.example.internal
                             ▼ (DNS → corporate VIP)
             corporate LB appliance (network-team-owned)
                             │ pool member: MetalLB IP (platform-owned)
                             ▼
               ingress-nginx (platform-owned namespace)
                             │ proxy timeouts pinned to the app's p99
        ┌────────────────────┼───────────────────────────────────────┐
        │ namespace: orders-prod                                     │
        │                    ▼                                       │
        │      Service orders-api (ClusterIP :80 → http:8080)        │
        │           │                                                │
        │   ┌───────┴──────┬──────────────┐                          │
        │   ▼              ▼              ▼                          │
        │ ┌────────┐   ┌────────┐   ┌────────┐    HPA: 3–10 pods     │
        │ │ pod    │   │ pod    │   │ pod    │    PDB: maxUnavail 1  │
        │ │ zone-a │   │ zone-b │   │ zone-c │    spread: zone+host  │
        │ └────────┘   └────────┘   └────────┘                       │
        │  NetworkPolicy ── in: ingress-nginx :8080, monitoring :8081│
        │                ── out: postgres, downstream-api, DNS       │
        │  ServiceAccount: token NOT mounted                         │
        │  ConfigMap → configtree mount + checksum-annotation rollout│
        └─────────────────────────────────────────────────────────────┘
```

The shape: clients reach a corporate VIP on the network team's load-balancer appliance, which forwards to a MetalLB-announced IP fronting ingress-nginx; ingress-nginx terminates TLS and forwards to a plain ClusterIP Service; three-plus pods spread one-per-zone (and one-per-node) behind it; the HPA owns the replica count between 3 and 10; the PDB serializes voluntary evictions; the NetworkPolicy makes both directions of traffic explicit. Probes and metrics live on a separate management port (8081) that never touches the ingress path — the split is from [Spring Boot on Kubernetes](/java/spring-boot/).

## The build

Everything lands in `orders-prod`. Manifests follow in dependency order — apply top to bottom.

### 1. ServiceAccount — default-deny the API

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: orders-api
  namespace: orders-prod
  labels:
    app.kubernetes.io/name: orders-api
automountServiceAccountToken: false   # never calls the API; a token it doesn't
                                      # have can't be stolen from it
```

The default ServiceAccount mounts a cluster API credential into every pod that never asked for one. A web service that talks to Postgres and one downstream API has no business holding one. If a sidecar later needs the API, opt *that* pod back in explicitly — the mechanics and the exec-into-a-pod attack this blunts are in [ServiceAccounts](/workloads/serviceaccounts/).

### 2. ConfigMap — and the checksum that makes it deployable

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: orders-api-config
  namespace: orders-prod
  labels:
    app.kubernetes.io/name: orders-api
data:
  # configtree files: filename = property name (spring.config.import in the image)
  orders.downstream-url: "http://inventory-api.inventory-prod.svc:8080"
  orders.datasource-url: "jdbc:postgresql://orders-db.orders-db-prod.svc:5432/orders"
  orders.hikari-pool-size: "10"   # load-bearing: HPA maxReplicas math assumes 10/pod
```

Mounted config alone is a trap: update the ConfigMap and *nothing happens* until pods restart. The Deployment below carries a `checksum/config` annotation — the sha256 of this ConfigMap, computed in CI — so a config change produces a new pod template hash and rides the normal rolling update: surge rules, readiness gates, rollback story included. The pattern (and the Kustomize `configMapGenerator` equivalent) is in [Configuration](/workloads/configuration/). Database credentials arrive as a Secret named `orders-api-secrets` through the same projected mount — created by your secret machinery, never committed here.

### 3. Deployment — the centerpiece

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
  namespace: orders-prod
  labels:
    app.kubernetes.io/name: orders-api
    app.kubernetes.io/version: "1.42.0"
spec:
  # NO replicas field. The HPA owns the count; a committed `replicas: 3` would
  # reset the fleet to 3 on every apply — mid-scale-out, at peak.
  selector:                                  # immutable after creation — minimal on
    matchLabels: { app.kubernetes.io/name: orders-api }   # purpose; version labels never go here
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0   # never dip below current capacity during a deploy
      maxSurge: 25%       # 3 pods → 1 extra; 10 pods → 3 extra. Quota must hold
                          # maxReplicas + surge: 13 × 800m ≈ 10.4 CPU, 13 × 1.5Gi ≈ 19.5Gi
  template:
    metadata:
      labels:
        app.kubernetes.io/name: orders-api
        app.kubernetes.io/version: "1.42.0"
      annotations:
        checksum/config: "<sha256 of orders-api-config, injected by CI>"
    spec:
      serviceAccountName: orders-api
      # Drain math: preStop sleep(5) + Spring graceful shutdown(25) + context-close
      # slack must fit BELOW this. The default 30 does not hold; 40 does.
      terminationGracePeriodSeconds: 40
      topologySpreadConstraints:
        - maxSkew: 1                                # hard zone spread: a zone loss
          topologyKey: topology.kubernetes.io/zone  # costs at most ⌈n/3⌉ pods —
          whenUnsatisfiable: DoNotSchedule          # why minReplicas is 3, not 2
          labelSelector: { matchLabels: { app.kubernetes.io/name: orders-api } }
        - maxSkew: 1                                # soft host spread: a drain never
          topologyKey: kubernetes.io/hostname       # takes two pods, but scale-out
          whenUnsatisfiable: ScheduleAnyway         # beyond node count still schedules
          labelSelector: { matchLabels: { app.kubernetes.io/name: orders-api } }
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: orders-api
          # Digest, not tag: what CI tested is bit-for-bit what runs.
          image: registry.internal/orders-api@sha256:4c1f9e2b7a8d0c3e5f6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e
          ports:
            - { name: http, containerPort: 8080 }        # traffic (ingress path)
            - { name: management, containerPort: 8081 }  # probes + metrics only
          env:
            - name: SPRING_PROFILES_ACTIVE
              value: "prod"
            - name: JAVA_TOOL_OPTIONS
              # 65% of 1536Mi ≈ 1000Mi max heap; measured heap p99 780Mi + ~350Mi
              # non-heap fits the limit. ExitOnOutOfMemoryError: die loudly, never limp.
              value: "-XX:MaxRAMPercentage=65.0 -XX:+ExitOnOutOfMemoryError"
          resources:
            requests:
              cpu: 800m        # measured p95 750m at target load, rounded up
              memory: 1.5Gi    # working-set plateau 1.1Gi × 1.35 headroom
            limits:
              memory: 1.5Gi    # request == limit: the scheduler reserved exactly
                               # what the OOM killer enforces
              # NO cpu limit — measured throttle ratio 0%, and the p99 SLO is
              # exactly what CFS throttling taxes
          startupProbe:
            httpGet: { path: /actuator/health/readiness, port: management }
            periodSeconds: 5
            failureThreshold: 16   # 16 × 5s = 80s: slowest measured start 38s × 2.
                                   # Holds liveness AND readiness off during boot.
          readinessProbe:
            httpGet: { path: /actuator/health/readiness, port: management }
            periodSeconds: 5
            failureThreshold: 3    # 15s to leave the Service on real failure
            timeoutSeconds: 2      # request p99 180ms → 10× margin, no flap
          livenessProbe:
            httpGet: { path: /actuator/health/liveness, port: management }
            periodSeconds: 10
            failureThreshold: 3    # 30s of sustained deadness before restart
            timeoutSeconds: 2      # worst GC pause 14ms — three orders of margin
          lifecycle:
            preStop:               # hold SIGTERM until endpoint removal propagates
              exec: { command: ["sh", "-c", "sleep 5"] }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - { name: config-tree, mountPath: /etc/config, readOnly: true }
            - { name: tmp, mountPath: /tmp }   # the one write path the JVM needs
      volumes:
        - name: config-tree
          projected:
            sources:
              - configMap: { name: orders-api-config }
              - secret: { name: orders-api-secrets }
        - name: tmp
          emptyDir:
            sizeLimit: 256Mi   # bounded: a runaway temp file kills this pod, not the node
```

Where the annotations point, because this is the manifest reviewers argue about:

- **No `replicas`.** After the HPA exists, a replicas field in git is a landmine with a CI trigger — every apply snaps the fleet back to the committed number. Omit it (as here) or use a patch-based apply that never touches it. [Autoscaling](/workloads/autoscaling/) shows the tug-of-war in motion.
- **`maxSurge: 25%, maxUnavailable: 0`** buys zero-capacity-loss deploys at the price of surge headroom in your ResourceQuota — a surge pod blocked by quota stalls the rollout silently. The surge/readiness interplay is in [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/).
- **The spread pair** — hard on zone, soft on hostname — is the standard HA shape: [Scheduling](/workloads/scheduling/) covers the constraint mechanics, [High Availability](/workloads/high-availability/) the availability math behind them.
- **The hardened `securityContext` costs one emptyDir.** `readOnlyRootFilesystem` breaks anything that writes to `/`; for a JVM that's `/tmp` and nothing else. Drop-ALL and `runAsNonRoot` cost a correctly built image and zero runtime behavior. Checklist: [Pod Security](/workloads/pod-security/).
- **The JVM slice and the resources block are one calculation** — heap percentage against the memory limit, request-no-limit for CPU. The method pages: [JVM Memory Knobs](/tuning/jvm-memory-knobs/) and [Requests & Limits Knobs](/tuning/requests-limits-knobs/).
- **The probes are one system.** The 80s startup budget, readiness's 15s ejection, liveness's 30s patience, and the HPA's 300s scale-down window (below) all reference each other; every number's justification is in [Health Check Knobs](/tuning/health-check-knobs/). The liveness group checks `livenessState` only — never a dependency.

:::caution[JAVA_TOOL_OPTIONS and injected sidecars]
`MaxRAMPercentage` reads the *container's* memory limit. A mutating webhook that injects a sidecar doesn't change your container's limit — but one that *modifies* your resources (some service meshes, some policy agents) silently moves the heap ceiling. After enabling any injection, `kubectl get pod -o yaml` and re-check the arithmetic. The failure-modes table has the symptom.
:::

### 4. Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: orders-api
  namespace: orders-prod
  labels:
    app.kubernetes.io/name: orders-api
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: orders-api
  ports:
    - { name: http, port: 80, targetPort: http }
    # management:8081 deliberately NOT exposed — probes are kubelet-to-pod, Prometheus
    # scrapes pods directly, and an unexposed actuator can't be routed to.
```

### 5. Ingress — timeouts matched to the app, not to hope

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: orders-api
  namespace: orders-prod
  labels:
    app.kubernetes.io/name: orders-api
  annotations:
    # Measured p99 is 180ms, SLO 250ms. nginx's default 60s read timeout would let
    # a wedged pod hold client connections for a minute. 10s = SLO × 40: generous
    # for the app, fast-failing for the client.
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "5"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "10"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "10"
    nginx.ingress.kubernetes.io/proxy-body-size: "2m"   # orders are JSON, not uploads
spec:
  ingressClassName: nginx
  rules:
    - host: orders.example.internal
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: { name: orders-api, port: { name: http } }
  tls:
    - { hosts: [orders.example.internal], secretName: orders-api-tls }  # cert-manager or platform-issued
```

The annotation dialect, the community-vs-F5 controller trap, and the rest of the knobs that matter (buffering, rate limits) are in [Ingress-NGINX](/networking/ingress-nginx/) — confirm which controller your platform actually runs before trusting any annotation.

:::note[The two hops above ingress-nginx are not yours]
The diagram's top edge — the corporate VIP on the network team's appliance, pooled to a MetalLB IP the platform team announces — is the platform's front-door build: assembled end to end in [The Bare-Metal Front Door](/architectures/front-door/), with the two-layer pattern explained in [External Load Balancing](/networking/external-load-balancing/). Two things about it matter to this manifest. First, client IPs: by the time a request reaches orders-api, the original source address has crossed an appliance and an ingress proxy — `X-Forwarded-For` is exactly as trustworthy as the edge's PROXY-protocol/forwarded-headers configuration, so verify what the platform actually guarantees before building rate limits or audit logs on it. Second, ownership: orders-api touches none of those layers. No VIP ticket, no MetalLB annotation, no appliance monitor — the app team's entire contract with the edge is the Ingress resource above.
:::

### 6. HorizontalPodAutoscaler

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: orders-api
  namespace: orders-prod
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: orders-api }
  minReplicas: 3    # availability, not load: one pod per zone survives a zone loss.
                    # Load alone also said 3 (200 req/s ÷ 75/pod) — coincidence, not cause.
  maxReplicas: 10   # ceiling from the weakest dependency: the DB team grants orders-api
                    # 120 of max_connections; 10 pods × Hikari pool 10 = 100, inside budget.
                    # (The walkthrough's original 80-connection grant capped this at 6;
                    # production negotiated a bigger budget.)
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70   # 70% × 800m request = 560m ≈ 75 req/s/pod —
                                   # half the measured 150 req/s knee
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0                     # react to spikes immediately
      policies:
        - { type: Pods, value: 2, periodSeconds: 60 }   # +2/min: fast, not a stampede
                                                        # of 80s-boot JVMs
    scaleDown:
      stabilizationWindowSeconds: 300                   # ≥ the 80s startup budget, with
      policies:                                         # margin: never shed a pod you'll
        - { type: Pods, value: 1, periodSeconds: 60 }   # pay 80s to rebuild; -1/min descent
```

:::caution[The request–HPA coupling]
`averageUtilization: 70` is 70% **of the CPU request**. Anyone who "tidies" 800m down to 400m silently halves the scaling trigger and doubles the fleet. Requests and HPA targets are one system — the same warning, with the arithmetic, closes the [Sizing Walkthrough](/tuning/sizing-walkthrough/).
:::

### 7. PodDisruptionBudget

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: orders-api
  namespace: orders-prod
spec:
  maxUnavailable: 1   # at minReplicas 3 this equals minAvailable: 2 — but it SCALES.
                      # minAvailable: 2 at an HPA-driven 10 replicas would permit
                      # evicting 8 pods at once. maxUnavailable: 1 means node drains
                      # take one orders-api pod at a time at any fleet size.
  selector:
    matchLabels: { app.kubernetes.io/name: orders-api }
```

With the zone spread above, a full zone drain evicts one pod, waits for its replacement to pass the 80s startup budget elsewhere, then takes the next. Slow drains are the *point* — see the drill in the verification plan.

### 8. NetworkPolicy — the ring

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: orders-api
  namespace: orders-prod
spec:
  podSelector:
    matchLabels: { app.kubernetes.io/name: orders-api }
  policyTypes: [Ingress, Egress]
  ingress:
    - from:   # traffic: only through the ingress controller (confirm the namespace)
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: ingress-nginx }
      ports: [{ port: 8080, protocol: TCP }]
    - from:   # scrapes: only from monitoring, only the management port
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: monitoring }
      ports: [{ port: 8081, protocol: TCP }]
  egress:
    - to:     # DNS first — forget this and every other egress rule "randomly" fails
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: kube-system }
      ports: [{ port: 53, protocol: UDP }, { port: 53, protocol: TCP }]
    - to:     # Postgres
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: orders-db-prod }
      ports: [{ port: 5432, protocol: TCP }]
    - to:     # the one downstream API
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: inventory-prod }
      ports: [{ port: 8080, protocol: TCP }]
```

Egress default-deny is where NetworkPolicies earn their keep and where they bite: kubelet probes are exempt (node-originated), but the DNS rule is not optional, and CNI dialects differ on the details — verify against yours per [Network Policies](/networking/network-policies/).

### 9. PrometheusRule — four alerts guarding the tuned numbers

Every derived number decays; each alert fires when one goes stale, *before* it fails. Routing, severities, and runbook-link discipline are in [Alerting](/observability/alerting/).

:::caution[This one manifest can fail `kubectl apply` outright]
`PrometheusRule` is a custom resource from the prometheus-operator — the only one of the nine that isn't a stock Kubernetes kind. If the CRDs aren't installed, the apply fails with `no matches for kind "PrometheusRule"`. Check first: `kubectl api-resources | grep monitoring.coreos.com`. If that comes back empty, this is a platform ask — the operator install is cluster-scoped and not yours to do — and your pipeline should apply this manifest conditionally or keep it in a separate overlay so the other eight still ship while the ticket is open.
:::

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: orders-api
  namespace: orders-prod
spec:
  groups:
    - name: orders-api.sizing
      rules:
        - alert: OrdersApiMemoryHeadroomGone
          expr: container_memory_working_set_bytes{namespace="orders-prod",container="orders-api"} / on(pod) kube_pod_container_resource_limits{namespace="orders-prod",resource="memory",container="orders-api"} > 0.90
          for: 15m
          labels: { severity: warning }
          annotations:
            summary: "Working set >90% of the 1.5Gi limit (sized for ~73% plateau) — re-size before the OOM killer does"
        - alert: OrdersApiCpuThrottled
          expr: rate(container_cpu_cfs_throttled_periods_total{namespace="orders-prod",container="orders-api"}[5m]) / rate(container_cpu_cfs_periods_total{namespace="orders-prod",container="orders-api"}[5m]) > 0.05
          for: 10m
          labels: { severity: warning }
          annotations:
            summary: "Throttling on a pod deployed with no CPU limit — a LimitRange or webhook injected one"
        - alert: OrdersApiUnexplainedRestarts
          expr: increase(kube_pod_container_status_restarts_total{namespace="orders-prod",container="orders-api"}[1h]) > 0
          labels: { severity: warning }
          annotations:
            summary: "Guaranteed-memory pod with 10x probe margins restarted outside a deploy — an OOM, liveness kill, or crash means a tuned number is stale"
        - alert: OrdersApiScaledToMax
          expr: kube_horizontalpodautoscaler_status_current_replicas{namespace="orders-prod",horizontalpodautoscaler="orders-api"} >= kube_horizontalpodautoscaler_spec_max_replicas{namespace="orders-prod",horizontalpodautoscaler="orders-api"}
          for: 15m
          labels: { severity: critical }
          annotations:
            summary: "Pinned at maxReplicas 10 for 15m — the fleet can no longer buy latency with pods. Raising max requires the DB connection budget first."
```

## What is deliberately not here

- **No CPU limit.** Measured throttle ratio was zero and the SLO is p99 latency — the one thing CFS throttling taxes directly. The `OrdersApiCpuThrottled` alert exists precisely to catch a limit sneaking in; the full argument and the policy-negotiation fallback are in [Requests & Limits Knobs](/tuning/requests-limits-knobs/).
- **No `replicas` field.** The HPA owns the count; a committed number is drift-by-design that reverts every scale-out on the next apply.
- **No `:latest`, no floating tags at all.** The image is a digest. "What is actually running" should be a lookup, never an investigation.
- **No privileged anything.** No hostPath, no hostNetwork, no added capabilities, no writable root. A stateless HTTP service needs none of it, so every one of those fields reads as an alarm in review.
- **No liveness check that sees dependencies.** Postgres being down makes pods *not ready*; it must never make them *restart*. The dependency-blip drill below proves the difference.

## Verification plan

Run these in a staging namespace with the k6 load Job from the [Sizing Walkthrough](/tuning/sizing-walkthrough/) holding ~200 req/s. Each drill exercises a specific manifest above.

**1. Rolling deploy under load.** Push a new digest and watch the surge math play out:

```bash
kubectl -n orders-prod rollout restart deploy/orders-api
kubectl -n orders-prod get rs -w
# with 3 replicas, maxSurge 25%, maxUnavailable 0: new RS 0→1 while old holds 3
# (4 total: the surge pod); old steps 3→2 only after the new pod passes its 80s
# startup budget — repeat until 3/0
```

p99 must stay under 250ms the whole time and the error rate flat at zero — a burst of 502s during pod termination means the drain math (preStop 5 + graceful 25 < grace 40) is broken, not the capacity.

**2. Kill a pod at peak.** `kubectl delete pod` on one replica. Survivors absorb ~100 req/s each (measured: 750m CPU, p99 180ms — inside SLO). Zero errors during the death itself is the pass criterion.

**3. Drain a node.** `kubectl drain` a node holding one pod. Watch the PDB serialize it (`kubectl get pdb orders-api -w`) and the replacement land in the *same zone* — the spread constraint refusing to double up elsewhere. A drain that hangs on `Cannot evict pod ... violates PodDisruptionBudget` while a replacement boots is correct behavior.

**4. Dependency blip.** Scale the staging `inventory-api` to zero for 60s. Correct outcome: orders-api returns fast 5xx for affected requests, pods stay Running with **zero restarts**, and readiness stays up (the readiness group excludes the downstream — deliberately). If all pods drop from the Service simultaneously, your readiness check includes the world; if any pod *restarts*, your liveness check does. Both are probe bugs, not capacity bugs.

**5. HPA out and back.** Ramp k6 to 400 req/s. Scale-out is stepwise (+2 pods/min per the behavior block) and stops once average utilization falls back under 560m/pod. Drop the load to zero and watch nothing happen for five minutes — the scale-down stabilization window — then a gentle -1/min descent. `kubectl get hpa orders-api -w` shows all of it.

**6. Config change → checksum rollout.** Edit a value in `orders-api-config`, let CI recompute `checksum/config`, and confirm a full rolling update fires (new ReplicaSet appears). Then edit the ConfigMap *without* the checksum step and confirm nothing rolls — that's the failure mode the annotation exists to close.

## Failure modes

| Failure | Behavior | Impact and recovery |
|---|---|---|
| Zone loss | Zone spread caps the damage at ⌈n/3⌉ pods; survivors absorb load at measured-safe levels; HPA adds pods in surviving zones (soft host spread permits doubling up) | Degraded headroom, no outage. When the zone returns, spread rebalances only on natural churn — force it with a rollout restart if skew matters |
| HPA pinned at max | 10 pods, utilization past 70%, then p99 climbing toward the 150 req/s knee — saturation looks like *slow*, not *down* | `OrdersApiScaledToMax` pages at 15m. More pods needs a bigger DB connection budget first; short-term, shed load at the ingress |
| Quota-blocked surge | Rollout stalls: new RS pod Pending with `exceeded quota`; old RS can't scale down (maxUnavailable 0) — deploy frozen, service unaffected | `kubectl describe rs` shows it. Fix quota or lower the fleet. This is why quota must hold maxReplicas + surge |
| Webhook-injected sidecar | Pod resources no longer match git: heap %, HPA utilization (averaged across containers), and quota math all shift silently | `OrdersApiCpuThrottled` catches injected CPU limits; after any mesh/policy rollout, diff `kubectl get pod -o yaml` against the manifest and re-run the sizing arithmetic |
| Drift reverts a tuned number | Someone "fixes" the request to 400m or the probe budget to 30s — by hand or via a stale branch; everything works until the next bad day | The restart and throttle alerts catch the loud cases; only continuous reconciliation catches the quiet ones — [Drift and CI/CD](/operations/drift-and-cicd/) is the systemic answer |

## Shipping it

**Repo layout.** All nine manifests live with the application, not in a platform repo — the team that owns the p99 owns the probe numbers. Two equally valid shapes for the same content; orgs standardize on one, and this site's labs and CI sections use Helm:

As a Kustomize base with overlays:

```text
orders-api/deploy/
├── base/
│   ├── serviceaccount.yaml  # 1     ├── ingress.yaml         # 5
│   ├── configmap.yaml       # 2     ├── hpa.yaml             # 6
│   ├── deployment.yaml      # 3     ├── pdb.yaml             # 7
│   ├── service.yaml         # 4     ├── networkpolicy.yaml   # 8
│   └── prometheusrule.yaml  # 9
└── overlays/
    ├── staging/   # host, HPA 2–4, softer alert thresholds
    └── prod/      # this article
```

As a Helm chart — the same nine manifests become templates, and the overlays become values files:

```text
orders-api/charts/orders-api/
├── Chart.yaml
├── templates/            # the nine manifests, parameterized
├── values.yaml           # defaults
├── values-staging.yaml   # host, HPA 2–4, softer alert thresholds
└── values-prod.yaml      # this article
```

The template mechanics are in [Chart Anatomy](/helm/chart-anatomy/); publishing the packaged chart from CI is in [Artifactory](/ci/artifactory/). Either way, the environment-specific numbers — hosts, HPA bounds, alert thresholds — live in the per-environment layer, and the golden invariants live in the base/templates where an environment can't quietly unset them.

**Pipeline gates**, per [CI/CD Pipeline Design](/operations/cicd-pipeline-design/): schema-validate every manifest (kubeconform), policy-check the invariants this article established (digest-pinned image, no CPU limit *added*, automount still false, PDB present), inject the config checksum and the image digest as the only CI-written fields, then gate promotion on `kubectl rollout status` and a post-deploy smoke hit through the Ingress. The rollout-status gate is what turns the quota-blocked-surge row above from a mystery into a red pipeline.

**Clone this as your template.** The *structure* transfers to any stateless HTTP service; the *numbers* do not. When you copy it, parameterize exactly these — each traceable to a measurement you must make yourself via the [Sizing Walkthrough](/tuning/sizing-walkthrough/) method:

- CPU request and memory request=limit (your Phase 1 table, not orders-api's)
- `MaxRAMPercentage` — JVM services only; delete `JAVA_TOOL_OPTIONS` otherwise
- The startup budget (`failureThreshold × periodSeconds` from *your* slowest start × 2)
- HPA target (from *your* knee) and maxReplicas (from *your* weakest dependency)
- Ingress timeouts (from *your* p99), the drain math (from *your* shutdown timing), and the alert thresholds (from *your* plateaus)

Everything else — the spread constraints, the security context, the PDB shape, the NetworkPolicy ring, the checksum pattern, the missing CPU limit — is the golden part. Copy it verbatim, and defend it in review.
