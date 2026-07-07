---
title: "Lab 6: Metrics, Dashboards, and One Real Alert"
description: Install kube-prometheus-stack sized for one node, scrape orders-api through a ServiceMonitor, run the site's own PromQL against real data, read a Grafana JVM dashboard — then write, trigger, and resolve one real alert.
keywords:
  - install kube-prometheus-stack on a lab cluster
  - scrape spring boot metrics with a servicemonitor
  - run promql queries against live data
  - import a grafana jvm dashboard
  - write trigger and resolve a prometheusrule alert
  - size the monitoring stack for one node
  - why prometheus is not scraping my target
  - expose the actuator prometheus endpoint
  - helm uninstall leaves crds behind
sidebar:
  order: 8
---

Everything you've built so far reports its health one pod at a time: `kubectl get pods` says `Running`, `curl` answers, and thirty seconds later nobody can prove what the system was doing. This lab gives the cluster a memory. You'll install the **kube-prometheus-stack** — Prometheus, Grafana, Alertmanager, and the exporters that feed them — sized honestly for a single node, teach `orders-api` to publish its JVM internals, run the site's own query cookbook against *your* data instead of the article's, and finish with the full alert lifecycle: write a rule, trigger it on purpose, watch it fire, resolve it.

**What you'll have at the end:** a `monitoring` namespace running a trimmed kube-prometheus-stack, `orders-api:0.4.0` exposing `/actuator/prometheus` and scraped via a ServiceMonitor shipped in your own chart, the [PromQL cookbook](/observability/promql-for-resources/) queries verified against live data, a Grafana JVM dashboard, and one PrometheusRule you've seen in all three states — inactive, pending, firing — and back. Then, because this stack is the heaviest tenant in these labs, a clean teardown.

## Prerequisites

- [Lab 0](/labs/lab-0-cluster/) through [Lab 4](/labs/lab-4-ingress-end-to-end/) completed: the Lima VMs `docker` and `k3s`, releases `orders` (image `orders-api:0.3.0`) and `cache` in the `labs` namespace, and ingress-nginx answering on `http://orders.localtest.me:30080` (the load generator in step 7 uses it).
- **RAM headroom.** The monitoring stack is the biggest thing you've installed — roughly 1–1.5 GiB inside the k3s VM once Prometheus warms up. The default 4 GiB VM handles it; step 3 trims `orders-api` to two replicas to keep the node comfortable.
- If you paused between sittings, revive everything:

```bash
limactl start docker && limactl start k3s
export DOCKER_HOST="unix://$HOME/.lima/docker/sock/docker.sock"
export KUBECONFIG="$HOME/.lima/k3s/copied-from-guest/kubeconfig.yaml"
kubectl get nodes
```

:::caution[Took Lab 4's full teardown?]
If you deleted the `k3s` VM at the end of Lab 4, rebuild before starting: Lab 0 steps 4–7 (new VM, namespace, context), re-import the images (`docker save orders-api:0.3.0 | limactl shell k3s sudo k3s ctr images import -`, same for `valkey/valkey`), then `kubectl create secret generic cache-auth --from-literal=password=labs-cache-pw`, `helm install cache charts/valkey`, `helm install orders charts/orders-api`, and Lab 4 step 1's ingress-nginx install. Your `~/k8s-labs/` directory has everything; it takes about ten minutes.
:::

All commands run from `~/k8s-labs/`, with `kubectl` defaulting to the `labs` namespace.

## 1. Install kube-prometheus-stack — sized for one node

kube-prometheus-stack is the chart most platforms run: the Prometheus **Operator** plus a Prometheus, an Alertmanager, Grafana, node-exporter, kube-state-metrics, and a large bundle of default dashboards and alert rules. Installed with defaults it assumes a real multi-node cluster — so, as with ingress-nginx in Lab 4, the values file is where the honesty lives.

`~/k8s-labs/values-monitoring.yaml`:

```yaml
# --- Control-plane scrapers k3s can't satisfy ---
# k3s packages the whole control plane into one process: there is no separate
# etcd (k3s defaults to a sqlite-backed store), and the scheduler,
# controller-manager, and kube-proxy don't expose their metrics ports.
# Left enabled, each becomes a permanently-DOWN target plus a permanently
# firing "...Down" alert — alert fatigue, factory-installed.
kubeEtcd:
  enabled: false
kubeControllerManager:
  enabled: false
kubeScheduler:
  enabled: false
kubeProxy:
  enabled: false

# --- Alertmanager: ON (step 7 needs it), but minimal ---
alertmanager:
  enabled: true
  alertmanagerSpec:
    resources:
      requests: {cpu: 10m, memory: 64Mi}    # default asks for more than a lab needs

# --- Prometheus: short retention, trimmed requests ---
prometheus:
  prometheusSpec:
    retention: 2d                # default 10d just holds the VM's disk hostage
    resources:
      requests: {cpu: 200m, memory: 512Mi}  # one shared node; be a polite tenant

# --- Grafana: ON, reachable the Lab 4 way ---
grafana:
  adminPassword: labs-grafana    # deterministic login for a lab; never for prod
  service:
    type: NodePort               # same move as ingress-nginx: no cloud, no LB
    nodePort: 30300              # pinned, so the URL never changes
```

Each `enabled: false` deserves its sentence. The four disabled scrapers aren't optional decorations — on a managed or packaged cluster (EKS, GKE, k3s) those control-plane endpoints simply aren't reachable, and the stack's bundled alerts for them would fire forever. Disabling the component also disables its bundled rules and dashboards, so you're not just silencing symptoms. Everything kept — node-exporter, kube-state-metrics, cAdvisor scraping through the kubelet — is what feeds every query in this lab.

Install (the first pull is several images — allow a few minutes):

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  -f values-monitoring.yaml --wait --timeout 10m
```

```console
NAME: monitoring
NAMESPACE: monitoring
STATUS: deployed
NOTES:
kube-prometheus-stack has been installed. Check its status by running:
  kubectl --namespace monitoring get pods -l "release=monitoring"
```

```bash
kubectl get pods -n monitoring
```

```console
NAME                                                     READY   STATUS    RESTARTS   AGE
alertmanager-monitoring-kube-prometheus-alertmanager-0   2/2     Running   0          75s
monitoring-grafana-7c9bd4bd9c-jt4vk                      3/3     Running   0          90s
monitoring-kube-prometheus-operator-58f8c76b95-w2lqm     1/1     Running   0          90s
monitoring-kube-state-metrics-6d5c6f7b48-hx9zr           1/1     Running   0          90s
prometheus-monitoring-kube-prometheus-prometheus-0       2/2     Running   0          72s
```

Note the shape: the **operator** is a controller that watches [CRDs](/controllers/crds-explained/) (`Prometheus`, `ServiceMonitor`, `PrometheusRule`, …) and generates Prometheus configuration from them — the chart installed about ten CRDs to make that possible (`kubectl get crd | grep monitoring.coreos.com`). Remember that fact; it matters at teardown. The stack layers — what scrapes what, and metrics-server vs Prometheus — are mapped in [Metrics](/observability/metrics/).

First look. Prometheus's UI travels over a port-forward (the operator maintains a stable Service named `prometheus-operated`):

```bash
kubectl port-forward -n monitoring svc/prometheus-operated 9090:9090 >/dev/null & PROM_PID=$!
```

Open `http://localhost:9090/targets`: kubelet/cAdvisor, node-exporter, kube-state-metrics, coredns, apiserver — all `UP`, none of them yours. That's the point made in [Metrics](/observability/metrics/): your pods already have resource history *without a line of instrumentation*. What Prometheus can't see yet is inside the JVM. Next.

## 2. Teach orders-api to speak Prometheus (0.4.0)

Spring Boot's actuator grows a `/actuator/prometheus` endpoint the moment Micrometer's Prometheus registry is on the classpath ([Java Observability](/java/java-observability/)). Three small edits.

**`app/pom.xml`** — bump `<version>` to `0.4.0` and add the registry next to the existing starters (version managed by the Boot parent):

```xml
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-registry-prometheus</artifactId>
</dependency>
```

**`app/src/main/resources/application.yaml`** — expose the endpoint, and tag every metric with the app's name (the Grafana dashboard in step 5 templates on this tag; Micrometer doesn't add it by itself):

```yaml
management:
  server.port: 8081
  endpoints.web.exposure.include: health,info,prometheus
  endpoint.health.probes.enabled: true
  metrics.tags.application: orders-api
```

Build, import, and deploy — the dance you know, in one block:

```bash
docker build -t orders-api:0.4.0 app/
docker save orders-api:0.4.0 | limactl shell k3s sudo k3s ctr images import -
```

In `charts/orders-api/values.yaml`, set `tag: "0.4.0"` — and while you're there, set `replicaCount: 2`: monitoring is the hungriest tenant this node has hosted, and the third replica is pure RAM with no lesson left in it. Then:

```bash
helm upgrade orders charts/orders-api && kubectl rollout status deploy/orders-api
```

Verify the endpoint exists before involving the scraper (the same discipline as smoke-testing an image before deploying it):

```bash
kubectl port-forward deploy/orders-api 8081:8081 >/dev/null & PF_PID=$!
sleep 2
curl -s localhost:8081/actuator/prometheus | grep -m3 "^jvm_memory_used_bytes"
kill $PF_PID
```

```console
jvm_memory_used_bytes{application="orders-api",area="heap",id="G1 Eden Space"} 2.4117248E7
jvm_memory_used_bytes{application="orders-api",area="heap",id="G1 Old Gen"} 1.8874368E7
jvm_memory_used_bytes{application="orders-api",area="nonheap",id="Metaspace"} 5.9812344E7
```

Prometheus text format, hundreds of series, `application="orders-api"` on every one. The app is publishing; nobody is listening yet.

## 3. The ServiceMonitor — scrape config as a chart resource

There are two ways to tell Prometheus about a target: pod annotations (the older convention) or a **ServiceMonitor** CR (the Operator-native way, and what this stack uses) — the comparison lives in [Metrics](/observability/metrics/). A ServiceMonitor points at a *named Service port*, and Lab 1 deliberately kept 8081 off the Service. The scrape is the reason that decision gets amended: add a second named port to `charts/orders-api/templates/service.yaml`, under `ports:`:

```yaml
    - name: management
      port: {{ .Values.managementPort }}
      targetPort: management
```

(Lab 1's principle survives — internals still don't ride the *traffic* port, and this Service is ClusterIP-only. The alternative that avoids touching the Service at all is a PodMonitor; same idea, pod-side.)

Append to `charts/orders-api/values.yaml`:

```yaml
metrics:
  enabled: true
  interval: 15s
```

New file `charts/orders-api/templates/servicemonitor.yaml`:

```yaml
{{- if .Values.metrics.enabled }}
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: {{ include "orders-api.fullname" . }}
  labels:
    {{- include "orders-api.labels" . | nindent 4 }}
    release: monitoring        # the label this stack's Prometheus selects on
spec:
  selector:
    matchLabels:
      {{- include "orders-api.selectorLabels" . | nindent 6 }}
  endpoints:
    - port: management
      path: /actuator/prometheus
      interval: {{ .Values.metrics.interval }}
{{- end }}
```

:::caution[The label that makes or silently breaks this]
kube-prometheus-stack's Prometheus only adopts ServiceMonitors carrying `release: <its-release-name>` — here, `release: monitoring`. Omit it and *nothing errors*: the CR sits there, valid and ignored, and your target never appears. This and the named-port mismatch are the two classic "Prometheus isn't scraping me" bugs from [Metrics](/observability/metrics/). The `enabled` gate is the same chart courtesy as Lab 4's ingress toggle — consumers without the CRDs installed set one value and the resource vanishes (Lab 7 relies on exactly this).
:::

```bash
helm upgrade orders charts/orders-api
kubectl get servicemonitor
```

```console
NAME         AGE
orders-api   10s
```

Within ~30 seconds, `http://localhost:9090/targets` (your port-forward is still up) grows a `serviceMonitor/labs/orders-api/0` section with **2/2 up**. Prove it with a query on the Graph tab:

```promql
sum by (pod) (jvm_memory_used_bytes{application="orders-api", area="heap"})
```

Two pods, two heap numbers. The cluster now remembers.

## 4. Run the site's own queries against your data

[PromQL for CPU and Memory](/observability/promql-for-resources/) is written against a fictional `myteam` namespace. You have a real one. Run its money queries with `namespace="labs"` in the Prometheus UI and check the shapes (your digits will differ; the structure shouldn't).

**Working set ÷ limit** — the distance-to-OOM ratio:

```promql
max by (pod, container) (
  container_memory_working_set_bytes{namespace="labs", container!="", container!="POD"}
)
/ on (pod, container) group_left ()
max by (pod, container) (
  kube_pod_container_resource_limits{namespace="labs", resource="memory"}
)
```

```text
{container="orders-api", pod="orders-api-64d7c8b9f5-8kwzr"}   0.57
{container="orders-api", pod="orders-api-64d7c8b9f5-tj6mp"}   0.55
```

Each JVM sits near **~290Mi of its 512Mi limit** — comfortable, and now *measured* instead of assumed. (A `cache-valkey` row appears only if your Valkey chart set a memory limit; rows exist only where limits do.) Working set — not `usage_bytes`, not `rss` — is the number the OOM killer compares to the limit; the full metric zoo is in the [cookbook](/observability/promql-for-resources/) and the consequences in [OOMKilled](/troubleshooting/oomkilled/).

**CPU in cores, per pod:**

```promql
sum by (pod) (
  rate(container_cpu_usage_seconds_total{namespace="labs", container!="", container!="POD"}[5m])
)
```

```text
{pod="orders-api-64d7c8b9f5-8kwzr"}    0.012
{pod="orders-api-64d7c8b9f5-tj6mp"}    0.011
{pod="cache-valkey-7d9c6b5f4-x2m8k"}   0.004
```

An idle Spring Boot app burns ~10 millicores keeping itself alive. Its CPU *request* is 100m — you're using ~11% of what the scheduler reserved, which is the honest starting point for every sizing conversation ([Resources and QoS](/workloads/resources-and-qos/)).

**Throttle ratio:**

```promql
sum by (pod, container) (rate(container_cpu_cfs_throttled_periods_total{namespace="labs", container!=""}[5m]))
/
sum by (pod, container) (rate(container_cpu_cfs_periods_total{namespace="labs", container!=""}[5m]))
```

```text
Empty query result
```

Not a bug — a lesson. The CFS throttling counters only exist for containers with a **CPU limit**, and nothing in `labs` has one, because the chart followed this site's advice (memory limit yes, CPU limit usually no). A metric that can't exist until the foot-gun is installed is the tidiest argument against installing it.

**The brownfield audit query** — from [Requests & Limits on a Running Fleet](/tuning/brownfield-resources/), the join that counts restarts and keeps only the OOM-caused ones:

```promql
sum by (namespace, pod, container) (
  increase(kube_pod_container_status_restarts_total{namespace="labs"}[30d])
  * on (namespace, pod, container) group_left
  kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}
)
```

```text
Empty query result
```

Zero OOM kills in your fleet's history — correct, and worth seeing: an audit that returns nothing is still an audit (the naive one-liner that page warns about would *also* return nothing here, for the wrong reason — `last_terminated_reason` is a gauge, and `increase()` on a gauge lies). Keep this query handy: depending on how step 7 goes for you, it may return its first honest row today.

## 5. Grafana: one dashboard, read properly

Grafana is already on a NodePort, and Lima forwards it just like Lab 4's 30080. Open **http://localhost:30300**, log in as `admin` / `labs-grafana` (the values file's doing).

Import the community JVM dashboard: **Dashboards → New → Import**, enter ID **4701** ("JVM (Micrometer)"), select the `Prometheus` datasource, Import. The `application` dropdown offers `orders-api` — that's the Micrometer tag from step 2 earning its keep; without it this dashboard renders blank.

Read it top to bottom, because these panels answer real pages:

- **Heap used vs max** — a gentle sawtooth under a ~128Mi ceiling. The ceiling is the giveaway: the JVM sized its heap at 25% of the 512Mi *container limit* (default ergonomics), not of the node.
- **Non-heap** — metaspace and code cache, ~90Mi and nearly flat. Now do the triangle: heap max 128Mi + non-heap ~90Mi + threads and buffers ≈ the ~290Mi working set Prometheus showed in step 4, all inside the 512Mi limit. Three tools, one consistent story — the correlation habit [Java Observability](/java/java-observability/) drills.
- **GC pause durations** — near zero at idle. Watch this panel during step 7's load loop.
- **Threads / classes loaded** — flat lines that only matter when they aren't.

One more stop: **Dashboards → Kubernetes / Compute Resources / Namespace (Pods)**, pick `labs`. Those panels are the step 4 queries, pre-built by the stack — the tip from [Metrics](/observability/metrics/): find the platform's dashboards before building your own.

## 6. One real alert, end to end

Everything so far *observes*. Alerts act. You'll ship the memory-near-limit rule from the [Alerting](/observability/alerting/) starter pack — working set above 85% of the limit — watch it traverse inactive → pending → firing, see it in Alertmanager, and resolve it.

`~/k8s-labs/alert-orders-api.yaml`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: orders-api-alerts
  namespace: labs
  labels:
    release: monitoring        # same selector story as the ServiceMonitor
spec:
  groups:
    - name: orders-api.tickets
      rules:
        - alert: OrdersApiMemoryNearLimit
          expr: |
            max by (pod, container) (container_memory_working_set_bytes{namespace="labs", container="orders-api"})
              / on (pod, container) group_left ()
            max by (pod, container) (kube_pod_container_resource_limits{namespace="labs", container="orders-api", resource="memory"})
            > 0.85
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "{{ $labels.pod }} memory at {{ $value | humanizePercentage }} of its limit"
            description: "Working set has been above 85% of the memory limit for 2 minutes. Next stop is the OOM killer."
```

`severity: warning`, deliberately: this is a **cause** alert — a future outage, not a current one — and [Alerting](/observability/alerting/)'s first rule is that causes get tickets, not pages (`for: 2m` is lab-sized impatience; the reference uses 30m). Apply and verify it was *adopted*, not just accepted:

```bash
kubectl apply -f alert-orders-api.yaml
```

Check `http://localhost:9090/rules` — `orders-api.tickets` should be listed, state **inactive**. If it isn't there, the API server took your YAML and Prometheus ignored it: the `release: monitoring` label again, failing silently.

**Now trigger it.** The rule compares working set to the limit, and you control the limit. Step 4 measured ~290Mi against 512Mi (0.57); shrink the limit to sit just above the working set — and shrink the *request* with it, because the API server rejects a limit below the request:

```bash
helm upgrade orders charts/orders-api --reuse-values \
  --set resources.requests.memory=320Mi --set resources.limits.memory=320Mi
kubectl rollout status deploy/orders-api
```

Then give the JVMs something to do (allocation pressure raises the working set) — from your Mac, through Lab 4's front door:

```bash
while true; do curl -s http://orders.localtest.me:30080/api/orders/1001 >/dev/null; sleep 0.1; done
```

:::note[Why the ratio doesn't just jump to 0.91]
A resource change rolls the pods, and each new JVM re-reads the *new* limit at startup and sizes a smaller heap — so the working set lands lower than the old 290Mi and climbs from there under load. Expect the step 4 ratio query to show ~0.80 right after the rollout, then creep up. If yours plateaus below 0.85 after a few minutes, take one more notch (`--set resources.requests.memory=304Mi --set resources.limits.memory=304Mi --reuse-values`) — measuring before every shrink is precisely the pre-check ritual from [the brownfield article](/tuning/brownfield-resources/), run in miniature. And if you overshoot *below* the working set, the pod is OOMKilled on rollout — the guaranteed failure that article warns about. No shame in it here: `kubectl get pods` shows `OOMKilled`, [OOMKilled](/troubleshooting/oomkilled/) explains the anatomy, the step 4 audit query finally returns a row, and one notch back up recovers you.
:::

Watch `http://localhost:9090/alerts`. The sequence, usually inside five minutes:

```text
OrdersApiMemoryNearLimit   inactive              (ratio below 0.85)
OrdersApiMemoryNearLimit   pending    (0 active) (expr true, "for" clock running)
OrdersApiMemoryNearLimit   firing     (2 active) (true for 2m — Alertmanager notified)
```

`pending` is the flap suppressor doing its job: a 30-second spike never escalates. Once it's **firing**, follow it downstream:

```bash
kubectl port-forward -n monitoring svc/alertmanager-operated 9093:9093 >/dev/null & AM_PID=$!
```

Open `http://localhost:9093` — there's your alert, grouped by namespace, both pods under one notification. It goes no further: this stack's default route delivers to a receiver named `null`, so nothing pages anyone. Wiring `severity` labels to real receivers — Slack, PagerDuty, a ticket queue — is the routing half of [Alerting](/observability/alerting/), and on a platform cluster it's a request to the team that owns this config.

**Resolve it** the way Lab 1 taught: the `--set` flags live only in that revision, so a plain upgrade from your files *is* the reset:

```bash
helm upgrade orders charts/orders-api && kubectl rollout status deploy/orders-api
```

Fresh pods, 512Mi limits, ratio back to ~0.55. Within a minute the alert drops to **inactive** and vanishes from Alertmanager. Stop the curl loop with `Ctrl-C`, and kill the port-forwards (`kill $PROM_PID $AM_PID`). You've now walked an alert through its entire life — most engineers only ever meet the firing part, at 3am, from the wrong side.

## 7. Teardown — because this stack is heavy

A monitoring stack idling on a lab cluster costs real memory. Unless you're heading somewhere that needs it, take it down — and learn the one honest wrinkle on the way out:

```bash
kubectl delete -f alert-orders-api.yaml
helm uninstall monitoring -n monitoring
kubectl delete namespace monitoring
```

```console
release "monitoring" uninstalled
namespace "monitoring" deleted
```

Now the wrinkle:

```bash
kubectl get crd | grep monitoring.coreos.com
```

```console
alertmanagers.monitoring.coreos.com        2026-07-03T14:02:11Z
prometheusrules.monitoring.coreos.com      2026-07-03T14:02:11Z
servicemonitors.monitoring.coreos.com      2026-07-03T14:02:11Z
...
```

**`helm uninstall` does not remove CRDs.** By design: CRDs are cluster-scoped, deleting one instantly destroys *every* CR of that kind in every namespace, and Helm refuses to make that call for you. They cost nothing to keep — a handful of schema definitions — and keeping them means your chart's ServiceMonitor template stays installable. If you want zero trace:

```bash
kubectl get crd -o name | grep monitoring.coreos.com | xargs kubectl delete
```

…and then set `metrics.enabled: false` in `charts/orders-api/values.yaml`, or the next `helm upgrade orders` fails with `no matches for kind "ServiceMonitor"` — the CR has nowhere to land. That's the `enabled` gate from step 3 paying for itself.

## Troubleshooting

:::caution[When output doesn't match]
**Stack install times out** — first-run image pulls on a slow connection. `kubectl get pods -n monitoring` to see what's stuck; `helm upgrade --install monitoring ... ` with the same flags is safe to re-run.

**Pods `Pending` after installing the stack** — the node is out of allocatable memory. Did you trim `replicaCount` to 2 in step 2? `kubectl describe pod -n monitoring <pod>` will show `Insufficient memory`.

**No `orders-api` target in Prometheus** — the two classic bugs: the ServiceMonitor is missing `release: monitoring` (check `kubectl get servicemonitor orders-api -o yaml`), or its `port: management` doesn't match a *named* port on the Service (`kubectl get svc orders-api -o yaml`). Both fail silently; [Metrics](/observability/metrics/) explains why.

**`/actuator/prometheus` returns 404** — the pod is running an old image. Confirm `helm get values orders` shows `tag: 0.4.0`, and that you re-ran the `docker save | ctr images import` pipe after the rebuild — the number-one gotcha since Lab 1.

**The alert never leaves `inactive`** — the ratio isn't crossing 0.85. Run the step 4 ratio query and look at the actual number; shrink one more notch as described. If the rule isn't listed at all under `/rules`, it's the `release: monitoring` label.

**`OOMKilled` pods after the shrink** — you set the limit below the real working set. Bump both request and limit up a notch, and appreciate the free lesson: this is the exact rollout failure [the brownfield article](/tuning/brownfield-resources/) makes you pre-check for.

**Grafana panels all empty** — wrong datasource selected at import time, or the `application` tag is missing because the 0.4.0 image isn't actually running (see the 404 entry above).
:::

## Where you are now

Release `orders` runs `orders-api:0.4.0`, two replicas, exposing `/actuator/prometheus` and carrying a ServiceMonitor and a gated `metrics` toggle in its chart — the observability wiring travels *with the app* now, which is the whole idea. You've run the [PromQL cookbook](/observability/promql-for-resources/) against live data, read a JVM dashboard against a working set you can explain, and shipped, triggered, and resolved a PrometheusRule. The monitoring stack itself is gone (or humming, if you kept it), and either way you know exactly what `helm uninstall` left behind.

The reference threads to pull next: [Alerting](/observability/alerting/) for the full page-vs-ticket discipline and the starter pack you sampled one rule from; [Java Observability](/java/java-observability/) for what else Micrometer and JFR can hand you for free; and [Requests & Limits on a Running Fleet](/tuning/brownfield-resources/) — you've now personally executed both its audit query and its cautionary tale. Next lab: [Lab 7: The CI Pipeline, Run Locally](/labs/lab-7-ci-locally/), where everything you've been typing by hand becomes a testing ladder a machine could run.
