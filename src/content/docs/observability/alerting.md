---
title: Alerting
description: What to page a human for, what to ticket, and how to ship PrometheusRule CRs as an app team on a platform-run Alertmanager.
sidebar:
  order: 9
---

The failure mode of alerting isn't missing alerts — it's the opposite. A team with 40 alerts that fire weekly and get acknowledged-and-ignored has *worse* coverage than a team with 8, because the one page that matters drowns in the 39 that don't. Alert fatigue is how on-call rotations die and how real outages get slept through.

Two rules before any YAML:

1. **Page on symptoms, ticket on causes.** A page means "users are hurt or about to be, and a human must act now." Error rate up, latency up, app not responding — page. Memory creeping toward a limit, throttling sustained, a replica short — those are causes that *might* become symptoms; they go to a ticket queue or a Slack channel reviewed in business hours.
2. **Every page must be actionable.** If the response to an alert is "hm, noted" — it's not a page. If it fires and there's nothing the on-call can *do*, delete it or demote it.

The platform team owns Prometheus and Alertmanager. You own your rules and your thresholds. This split works fine once you know the interfaces — which is most of this article.

## Symptom alerts: RED on your own metrics

The RED method — **R**ate, **E**rrors, **D**uration — measured on your app's own metrics (exposing them is covered in [Metrics](/observability/metrics/)). These are the pages.

**Error rate** — fraction of requests failing, not absolute count (100 errors/s is fine at 50k req/s, catastrophic at 200 req/s):

```promql
sum(rate(http_requests_total{namespace="myteam", job="checkout-api", status=~"5.."}[5m]))
/
sum(rate(http_requests_total{namespace="myteam", job="checkout-api"}[5m]))
> 0.05
```

**Latency** — p99 from a histogram:

```promql
histogram_quantile(0.99,
  sum by (le) (rate(http_request_duration_seconds_bucket{namespace="myteam", job="checkout-api"}[5m]))
) > 1.5
```

`histogram_quantile` needs the `le` label preserved — aggregate `by (le)` (plus any label you want to split on) or it silently produces garbage.

:::tip[Multi-window burn rate, the honest version]
The SRE-book approach: instead of one threshold, alert when your error budget is burning fast on *two* windows at once — a short one (catches it quickly) and a long one (proves it's not a blip). For a 99.9% SLO, a practical pair:

- **Page**: 5m error ratio > 1.4% **and** 1h error ratio > 1.4% (≈14x burn — budget gone in ~2 days).
- **Ticket**: 30m > 0.35% **and** 6h > 0.35% (slow leak).

The full framework has four windows and math you'll forget; two windows and two severities captures 90% of the value. Start there.
:::

## Cause alerts: tickets, not pages

These are the "future outage" detectors. Route them at `severity: warning` to Slack/tickets — never to the pager. The queries are explained in depth in [PromQL for CPU and Memory](/observability/promql-for-resources/); here they are in alert-shaped form.

| Condition | Expression sketch | For | Why a ticket |
|---|---|---|---|
| Memory near limit | working_set ÷ limit > 0.85 | 30m | Pre-[OOMKill](/troubleshooting/oomkilled/) warning — resize before it dies at 3am |
| CPU throttled | throttled ÷ total periods > 0.25 | 30m | Latency is quietly degraded; fix the limit in daylight |
| Restarts climbing | `increase(kube_pod_container_status_restarts_total[1h]) > 3` | — | Something crash-cycling; investigate before it becomes CrashLoopBackOff |
| Replicas short | available < desired | 15m | Degraded redundancy; if users were hurt, the RED alerts page you |
| PVC filling | `kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes > 0.8` | 30m | Full disks become outages; note kubelet volume stats are only there if the platform exposes them — ask |
| CronJob silent | `time() - kube_cronjob_status_last_successful_time{...} > 2 * <period>` | — | The invisible failure: the job that just... stops running |
| Cert expiring | `certmanager_certificate_expiration_timestamp_seconds - time() < 14*86400` | 1h | Only if cert-manager metrics are exposed; expired certs are self-inflicted outages |

Fifteen minutes of `replicas < desired` deserves a look, not adrenaline. If the shortage actually hurts users, your symptom alerts fire — that's the whole point of the split. (If pods are failing readiness rather than crashing, start with your probes, not your alerts.)

## The dead-man's switch: absent()

Every alert above shares a silent failure mode: **if your app stops reporting metrics entirely, none of them fire.** Scrape config broken, pod stuck, ServiceMonitor label drift after a refactor — Prometheus sees no data, and no data matches no threshold.

```promql
absent(up{namespace="myteam", job="checkout-api"} == 1)
```

`absent()` returns 1 when no series match — it fires on *nothing being there*. This is the alert that catches everything else failing silently, and it's the first rule to write for any service. When a routine rename of your app's labels breaks scraping, this is the only thing that will tell you — everything else just goes green and quiet.

:::caution
`absent()` can't infer labels from a match that returned nothing, so you need one rule per job — you can't write a generic "anything missing" rule this way. Tedious, worth it.
:::

The platform-side equivalent — Alertmanager itself being down — should be covered by the platform team's own dead-man's switch (a "watchdog" alert that always fires, alarming when it *stops* arriving). Ask them if it exists.

## PrometheusRule anatomy

Most platforms run the Prometheus Operator, so rules ship as `PrometheusRule` custom resources — YAML through your normal CI/CD, not clicks in a UI. A complete example:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: checkout-api-alerts
  namespace: myteam
  labels:
    team: myteam            # ask platform which labels their Prometheus's
    release: kube-prometheus # ruleSelector requires — wrong labels = silently ignored
spec:
  groups:
    - name: checkout-api.symptoms
      rules:
        - alert: CheckoutHighErrorRate
          expr: |
            sum(rate(http_requests_total{namespace="myteam", job="checkout-api", status=~"5.."}[5m]))
            /
            sum(rate(http_requests_total{namespace="myteam", job="checkout-api"}[5m]))
            > 0.05
          for: 5m
          labels:
            severity: critical
            team: myteam
          annotations:
            summary: "checkout-api error rate above 5%"
            description: "Error ratio is {{ $value | humanizePercentage }} for the last 5m."
            runbook_url: "https://wiki.example.com/runbooks/checkout-high-error-rate"
```

The parts that matter:

- **`expr`** — any PromQL. The alert is *pending* while true, *firing* once it's been true for **`for`**. `for: 5m` is your flap suppressor: a 30-second blip never pages.
- **`labels`** — routing keys. `severity` and `team` are what Alertmanager routes on; agree the vocabulary with platform (`critical` = page, `warning` = ticket is the common convention).
- **`annotations`** — human-facing text. `{{ $labels.pod }}` and `{{ $value }}` template in the firing series' labels and value. Write the description for the 3am reader: what's wrong, how bad, where's the runbook.

**Where does the CR go?** Two models, and it depends entirely on platform configuration:

1. Platform sets `ruleNamespaceSelector` to pick up PrometheusRules from tenant namespaces (usually gated on a namespace or object label). Then it's just another manifest in your repo — the good model.
2. Prometheus only reads rules from its own namespace. Then your alert is a PR to the platform's rules repo, with their review cycle.

Ask which one you're in before writing anything — it changes your iteration speed from minutes to days. This is a day-one question for [working with the platform team](/operations/working-with-platform-team/). And in either model: a rule with the wrong selector labels fails *silently*. After deploying, confirm it appears under Status → Rules in the Prometheus UI.

## Routing: Alertmanager is theirs, receivers are yours

You write rules; Alertmanager decides who gets woken. You can't edit its config, but you can (and should) ask the platform team for specific things:

- **A route keyed on your team label**: `team: myteam` + `severity: critical` → your PagerDuty service; `severity: warning` → your Slack channel. This is a five-line change on their side and the single highest-value ask.
- **Sane grouping**: group by `alertname` and `namespace` so 30 pods failing at once is one notification, not 30 pages.
- **Inhibition during maintenance windows**: when the platform drains nodes or upgrades the cluster, your pods restart and your warning alerts fire. Ask whether their maintenance alert inhibits tenant alerts, or whether they'll create silences that match your `team` label. Otherwise you'll learn to ignore your own alerts on patch night — which is exactly how fatigue starts.

Until your route exists, your alerts fire into whatever default receiver the platform configured — often a channel nobody you know reads. **Verify the path end-to-end**: deploy a trivially-true test alert (`expr: vector(1)`), confirm the Slack message/page arrives, delete it.

## Runbook discipline

Every alert carries a `runbook_url`. No runbook, no alert — if you can't write down what the responder should do, you've just proven the alert isn't actionable. The runbook format that works under stress is the [emergency playbook](/operations/emergency-playbooks/) pattern: confirm the symptom (exact query/command), three most likely causes with a check for each, mitigation first, root cause later.

And review hygiene: **quarterly, list every alert that fired in the last 90 days and what action it produced.** Fired repeatedly, no action ever taken → delete it or fix the threshold. Never fired → fine for symptoms (good months happen), suspicious for causes (is the expression even matching anything? check for label drift). An alert nobody acts on isn't monitoring — it's noise with a severity label.

## Starter pack

Copy, adjust namespace/job/thresholds, ship. Symptom rules at `severity: critical`, cause rules at `warning`. Annotations trimmed here for space — add `summary`, `description`, and `runbook_url` to every one.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: myapp-starter-alerts
  namespace: myteam
  labels:
    team: myteam
spec:
  groups:
    - name: myapp.pages
      rules:
        # 1. Users are seeing errors — the page that matters most.
        - alert: HighErrorRate
          expr: |
            sum(rate(http_requests_total{job="myapp", status=~"5.."}[5m]))
              / sum(rate(http_requests_total{job="myapp"}[5m])) > 0.05
          for: 5m
          labels: {severity: critical, team: myteam}

        # 2. Users are waiting — p99 above SLO.
        - alert: HighLatencyP99
          expr: |
            histogram_quantile(0.99, sum by (le)
              (rate(http_request_duration_seconds_bucket{job="myapp"}[5m]))) > 1.5
          for: 10m
          labels: {severity: critical, team: myteam}

        # 3. Dead-man's switch — the app stopped reporting entirely.
        - alert: TargetMissing
          expr: absent(up{job="myapp"} == 1)
          for: 5m
          labels: {severity: critical, team: myteam}

    - name: myapp.tickets
      rules:
        # 4. Pre-OOM warning — resize before the OOM killer does it for you.
        - alert: MemoryNearLimit
          expr: |
            max by (pod, container) (container_memory_working_set_bytes{namespace="myteam", container!="", container!="POD"})
              / on (pod, container) group_left ()
            max by (pod, container) (kube_pod_container_resource_limits{namespace="myteam", resource="memory"}) > 0.85
          for: 30m
          labels: {severity: warning, team: myteam}

        # 5. Sustained throttling — latency is degraded even if averages look fine.
        - alert: CPUThrottlingHigh
          expr: |
            sum by (pod, container) (rate(container_cpu_cfs_throttled_periods_total{namespace="myteam", container!=""}[5m]))
              / sum by (pod, container) (rate(container_cpu_cfs_periods_total{namespace="myteam", container!=""}[5m])) > 0.25
          for: 30m
          labels: {severity: warning, team: myteam}

        # 6. Something is crash-cycling.
        - alert: ContainerRestarting
          expr: increase(kube_pod_container_status_restarts_total{namespace="myteam"}[1h]) > 3
          labels: {severity: warning, team: myteam}

        # 7. Running below desired replicas — redundancy is gone.
        - alert: DeploymentReplicasShort
          expr: |
            kube_deployment_status_replicas_available{namespace="myteam"}
              < kube_deployment_spec_replicas{namespace="myteam"}
          for: 15m
          labels: {severity: warning, team: myteam}

        # 8. Pinned at max replicas — the HPA has no headroom left.
        - alert: HPAMaxedOut
          expr: |
            kube_horizontalpodautoscaler_status_current_replicas{namespace="myteam"}
              >= kube_horizontalpodautoscaler_spec_max_replicas{namespace="myteam"}
          for: 30m
          labels: {severity: warning, team: myteam}

        # 9. Nightly job silently stopped succeeding (threshold = 2x its period).
        - alert: CronJobNotRunning
          expr: |
            time() - kube_cronjob_status_last_successful_time{namespace="myteam", cronjob="nightly-report"}
              > 2 * 86400
          labels: {severity: warning, team: myteam}

        # 10. PVC filling up — only works if platform exposes kubelet volume stats.
        - alert: PVCAlmostFull
          expr: |
            kubelet_volume_stats_used_bytes{namespace="myteam"}
              / kubelet_volume_stats_capacity_bytes{namespace="myteam"} > 0.8
          for: 30m
          labels: {severity: warning, team: myteam}
```

Rule 8 pairs with the HPA utilization-of-request math covered in the PromQL cookbook — pinned at max means either raise the ceiling or fix the per-pod efficiency.

**Three more for JVM apps** (Micrometer metric names; requires your app's `/metrics` scraped):

```yaml
    - name: myapp.jvm
      rules:
        # Heap headroom shrinking — leak or undersized -Xmx; investigate before OOME.
        - alert: JVMHeapNearMax
          expr: |
            sum by (pod) (jvm_memory_used_bytes{job="myapp", area="heap"})
              / sum by (pod) (jvm_memory_max_bytes{job="myapp", area="heap"}) > 0.90
          for: 30m
          labels: {severity: warning, team: myteam}

        # GC eating the CPU budget — throughput collapse precedes the outage.
        - alert: JVMGCPauseTimeHigh
          expr: |
            sum by (pod) (rate(jvm_gc_pause_seconds_sum{job="myapp"}[5m])) > 0.10
          for: 15m
          labels: {severity: warning, team: myteam}

        # Container memory high while heap is fine = native growth (threads,
        # direct buffers, metaspace) — the limit needs headroom above -Xmx.
        - alert: JVMNativeMemoryGrowth
          expr: |
            (max by (pod) (container_memory_working_set_bytes{namespace="myteam", pod=~"myapp-.*", container="app"})
              - on (pod) group_left () sum by (pod) (jvm_memory_used_bytes{job="myapp"}))
              / on (pod) group_left ()
            max by (pod) (kube_pod_container_resource_limits{namespace="myteam", pod=~"myapp-.*", resource="memory"}) > 0.35
          for: 1h
          labels: {severity: warning, team: myteam}
```

`JVMHeapNearMax` at 90% *sustained* is the key qualifier — the JVM routinely rides high and collects; a sawtooth touching 90% is normal, a floor that never drops below it is a leak (see [GC and Performance](/java/gc-and-performance/) for reading GC behavior, and [JVM in Containers](/java/jvm-in-containers/) for why the third rule exists at all).

Start with these, wire the route, write the runbooks, and then be ruthless: every rule you add from here should displace one, or earn its pager scars in review.
