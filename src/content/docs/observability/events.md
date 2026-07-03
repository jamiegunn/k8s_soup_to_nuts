---
title: Events
description: Kubernetes events as the cluster's audit trail — how to query them, the greatest-hits reasons decoded, and why you must capture them within the hour.
sidebar:
  order: 5
---

Your logs tell you what your app did. **Events** tell you what the cluster did *to* your app — scheduled it, pulled its image, failed its probe, killed it. When a pod misbehaves and the logs look innocent, the answer is almost always sitting in the event stream. Events are the most underused debugging signal in Kubernetes, mostly because they expire before anyone looks.

## Reading events

The default `kubectl get events` output is unsorted (effectively random), which has wasted countless engineer-hours. Always sort:

```bash
kubectl get events --sort-by=.lastTimestamp
```

```console
LAST SEEN   TYPE      REASON             OBJECT                               MESSAGE
12m         Normal    Scheduled          pod/checkout-api-7d4b9fc6c-x2k4f     Successfully assigned shop/checkout-api-7d4b9fc6c-x2k4f to worker-14
12m         Normal    Pulled             pod/checkout-api-7d4b9fc6c-x2k4f     Container image "shop/checkout-api:2.14.1" already present on machine
9m          Warning   Unhealthy          pod/checkout-api-7d4b9fc6c-x2k4f     Readiness probe failed: HTTP probe failed with statuscode: 503
3m          Warning   BackOff            pod/checkout-api-7d4b9fc6c-x2k4f     Back-off restarting failed container app in pod checkout-api-7d4b9fc6c-x2k4f...
```

Narrowing down:

```bash
# Only events for one object
kubectl get events --field-selector involvedObject.name=checkout-api-7d4b9fc6c-x2k4f

# Only warnings — the signal-to-noise fix
kubectl get events --field-selector type=Warning --sort-by=.lastTimestamp

# Watch live during a deploy or incident
kubectl get events -w

# Newer kubectl: a dedicated subcommand with nicer output and --for
kubectl events --for pod/checkout-api-7d4b9fc6c-x2k4f --types=Warning
```

And the one you already use — `kubectl describe` shows the events for that object at the bottom of its output, which is why `describe pod` is the universal first move in triage:

```bash
kubectl describe pod checkout-api-7d4b9fc6c-x2k4f
```

```console
...
Events:
  Type     Reason     Age                    From     Message
  ----     ------     ----                   ----     -------
  Warning  Unhealthy  4m (x12 over 9m)       kubelet  Readiness probe failed: HTTP probe failed with statuscode: 503
  Warning  BackOff    2m (x8 over 6m)        kubelet  Back-off restarting failed container app in pod ...
```

## Event anatomy

Each event carries a few fields worth knowing:

- **Type** — `Normal` or `Warning`. Filter to `Warning` first; expand to all when reconstructing a timeline.
- **Reason** — a machine-readable CamelCase code (`FailedScheduling`, `BackOff`). This is what you grep for and what the decoder table below keys on.
- **Source / From** — which component reported it: `default-scheduler` (placement problems), `kubelet` (runtime, probes, mounts, image pulls), `deployment-controller` / `replicaset-controller` (rollout mechanics), `horizontal-pod-autoscaler` (scaling decisions).
- **Count / aggregation** — identical events get deduplicated into one entry with a count. `x12 over 9m` means it happened twelve times in nine minutes — the *frequency* is often the diagnosis (a probe failing once is noise; x40 is an outage).
- **involvedObject** — what it's about; the handle for `--field-selector`.

## The greatest hits, decoded

| Reason | From | What it actually means | Where to go |
|---|---|---|---|
| `FailedScheduling` | scheduler | No node fits: insufficient CPU/memory for your requests, unsatisfiable affinity, or untolerated taints. The message lists the per-node reasons — read it fully. | [Pod Pending](/troubleshooting/pod-pending/) |
| `BackOff` | kubelet | Container keeps exiting; kubelet is applying exponential restart delay. The event is the symptom — the cause is in `kubectl logs --previous`. | [CrashLoopBackOff](/troubleshooting/crashloopbackoff/) |
| `Unhealthy` | kubelet | Liveness/readiness/startup probe failed; the message says which and how (HTTP 503, timeout, connection refused). Occasional = probe too tight; sustained = app actually unhealthy. | [Health Checks](/workloads/health-checks/) |
| `FailedMount` / `FailedAttachVolume` | kubelet | A volume couldn't mount: PVC pending or attached elsewhere, missing Secret/ConfigMap ("secret ... not found" — check the exact name), or CSI trouble. Pod stays in `ContainerCreating`. | — |
| `FailedCreatePodSandBox` | kubelet | The pod's network/runtime sandbox couldn't be created — usually CNI (IP exhaustion, plugin errors). Node-level infrastructure: capture the message and node name, escalate to platform. | — |
| `Killing` | kubelet | Kubelet is stopping the container: normal during rollouts/deletes, but paired with `Unhealthy` (liveness) it means the probe is killing you. Note: OOM kills often *don't* emit a clean event — check `describe pod` for `OOMKilled` in last state. | [OOMKilled](/troubleshooting/oomkilled/) |
| `Evicted` | kubelet | Node ran short on memory/disk and the kubelet evicted your pod to survive. BestEffort and burst-over-request pods go first — your QoS class decided your fate. | [Resources and QoS](/workloads/resources-and-qos/) |
| `FailedPull` / `ErrImagePull` | kubelet | Image can't be pulled: typo in tag, missing imagePullSecret, registry down or rate-limiting. | [ImagePullBackOff](/troubleshooting/imagepullbackoff/) |

:::note[Events are per-namespace]
`kubectl get events` shows your namespace only, which matches your access. Node-level events (pressure, kubelet issues) live outside it — `kubectl describe node` shows node conditions *if* you have read access; otherwise that's a platform-team question.
:::

## Events are ephemeral — capture during incidents

Events live in etcd with a TTL, **one hour by default** on most clusters. There is no history API. The eviction that broke your service at 02:00 is unqueryable by 03:15 — one of the sharpest edges in Kubernetes debugging, and it cuts every team once.

Rules that follow:

1. **Dump events the moment an incident starts**, before you understand it:
   ```bash
   kubectl get events --sort-by=.lastTimestamp -o wide > events-$(date +%Y%m%d-%H%M%S).txt
   kubectl get events --sort-by=.lastTimestamp -o json > events-$(date +%Y%m%d-%H%M%S).json
   ```
2. **Attach the dump to the incident channel/ticket immediately.** Post-incident review happens days later; the events won't.
3. **For chronic intermittent problems**, run a watch in a terminal (`kubectl get events -w --field-selector type=Warning | tee -a events-watch.log`) or ask the platform team whether an event exporter (e.g. kubernetes-event-exporter shipping events into the log store) exists — many clusters have one, making events searchable next to logs. If yours doesn't, it's a high-value request.

### jq recipes for event archaeology

The JSON dump carries fields the table view hides — exact first/last timestamps and full counts. Recipes that earn their keep:

```bash
# Timeline of warnings: first seen, last seen, how many times
kubectl get events --field-selector type=Warning -o json | jq -r '
  .items[] | [.firstTimestamp, .lastTimestamp, .count, .reason, .involvedObject.name]
  | @tsv' | sort

# Which reasons are churning the most right now?
kubectl get events -o json | jq -r '.items[] | .reason' | sort | uniq -c | sort -rn | head
```

```console
  41 Unhealthy
   8 BackOff
   3 FailedScheduling
   2 Pulled
```

A leaderboard like that reads as a diagnosis: probe failures dominating, with restart backoff as the consequence.

## Events in CI/CD debugging: "why did my rollout hang?"

Pipelines fail with `kubectl rollout status` timing out and a useless "deadline exceeded". The narrative of *why* is in the events. The debugging sequence:

```bash
kubectl rollout status deploy/checkout-api --timeout=120s   # confirms it's stuck, not why
kubectl get pods -l app=checkout-api                        # find the pods that aren't Ready
kubectl get events --sort-by=.lastTimestamp | grep -E 'checkout-api|Warning'
```

The stuck rollout almost always resolves to one event pattern: `FailedScheduling` (cluster can't fit the surge pods — remember rolling updates need headroom for maxSurge), `ErrImagePull` (the tag your pipeline pushed isn't the tag it deployed), `Unhealthy` (new version fails its readiness probe — the rollout is *correctly* protecting you), or `FailedMount` (the new pod references a Secret the pipeline forgot to create). Each maps straight to a fix; see [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/).

:::tip[Bake it into the pipeline]
Make your deploy job dump events on failure — future-you will thank present-you:

```bash
kubectl rollout status deploy/checkout-api --timeout=180s || {
  kubectl get events --sort-by=.lastTimestamp --field-selector type=Warning
  kubectl get pods -l app=checkout-api -o wide
  kubectl describe pods -l app=checkout-api | sed -n '/Events:/,$p'
  exit 1
}
```

This turns "rollout failed, someone go look" into a self-diagnosing pipeline, and it captures the events before the one-hour TTL eats them.
:::

## Checklist

- [ ] `--sort-by=.lastTimestamp` is muscle memory
- [ ] You filter with `--field-selector type=Warning` and `involvedObject.name=...`
- [ ] You can decode the eight greatest-hits reasons without looking them up
- [ ] Incident runbook step 1 includes an event dump
- [ ] CI/CD pipeline dumps events on rollout failure
- [ ] You've asked platform whether an event exporter ships events to the log store
