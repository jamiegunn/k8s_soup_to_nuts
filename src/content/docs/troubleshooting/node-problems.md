---
title: Node Problems (From Your Seat)
description: Recognize node trouble from inside your namespace — evictions, stuck Terminating pods, drains — and make your app survive it.
sidebar:
  order: 12
---

**Symptom:** pods stuck `Terminating` or `Unknown`, a wave of pods rescheduling at once, pods with `Status: Evicted`, or "everything on worker-07 is weird". You don't run the nodes — but node trouble lands squarely in your namespace, and there's a lot you can diagnose and harden without ever touching SSH.

## How node trouble looks from your namespace

```bash
kubectl get pods -o wide          # the NODE column is the whole point
kubectl get events --sort-by=.lastTimestamp | grep -Ei 'evict|taint|notready|drain'
kubectl get nodes                  # often readable even with namespace-scoped RBAC
```

Patterns to recognize:

| What you see | What it usually means |
|---|---|
| Every broken pod shares one NODE value | That node is sick or being drained |
| Pods `Terminating` for many minutes | Node stopped responding mid-shutdown, or a finalizer is stuck |
| Pods `Unknown` | Kubelet stopped reporting entirely; the API has lost contact |
| A burst of new pods, all seconds old, across your Deployments | Mass rescheduling — a node went NotReady or was drained |
| `Status: Failed`, `Reason: Evicted` corpses | Kubelet kicked pods off under resource pressure |
| `kubectl get nodes` shows `NotReady` or `SchedulingDisabled` | Node down / cordoned for maintenance |

:::note[Terminating and Unknown are node symptoms, not app bugs]
A pod stuck `Terminating` past its grace period almost always means the node can't confirm the death — kubelet down, node partitioned. The container might still be running out there. Don't force-delete stateful pods casually: `kubectl delete pod --force --grace-period=0` tells the API to *forget* the pod, not to stop the process, and for a StatefulSet that can mean two instances believing they own the same identity. See [StatefulSets Fundamentals](/stateful/statefulsets-fundamentals/).
:::

## Node conditions and eviction — why *your* pod got killed

Under sustained pressure a node sets conditions — `MemoryPressure`, `DiskPressure`, `PIDPressure` — the scheduler stops placing pods there (via automatic taints like `node.kubernetes.io/disk-pressure`), and the kubelet starts **evicting** pods to recover resources. Evicted pods look like:

```console
$ kubectl describe pod api-7d4b9c6f8-2xkqp | grep -A3 Status
Status:       Failed
Reason:       Evicted
Message:      The node was low on resource: ephemeral-storage. Container api was
              using 9Gi, which exceeds its request of 0.
```

Read the Message — it names the resource and *your usage vs your request*, which is exactly how eviction victims are ranked (most-over-request goes first, BestEffort before Burstable before Guaranteed — [Resources and QoS](/workloads/resources-and-qos/)).

### Ephemeral-storage: the usual suspect — and it's usually you

Memory-pressure evictions are often someone else's noisy neighbor. **Disk-pressure evictions are very frequently self-inflicted:** your container's writable layer, `emptyDir` volumes, and log output all count as ephemeral-storage. The classics:

- Debug logging left on, writing gigabytes to stdout *and* a file inside the container.
- Heap dumps parked in `/tmp` and never shipped out ([Getting Dumps Out](/java/getting-dumps-out/)).
- A cache or scratch dir on `emptyDir` with no size cap.

Defend yourself in the manifest:

```yaml
resources:
  requests:
    ephemeral-storage: "1Gi"
  limits:
    ephemeral-storage: "4Gi"    # exceed this → YOUR pod is evicted, alone,
                                # instead of destabilizing the node for everyone
volumes:
  - name: scratch
    emptyDir:
      sizeLimit: 2Gi
```

An ephemeral-storage *limit* converts "node-wide disk pressure that evicts random victims" into "this one pod gets evicted with a clear message" — a much better failure.

## Cordon, drain, and maintenance

During node upgrades, platform **cordons** a node (no new pods; shows `SchedulingDisabled`) and **drains** it (evicts pods gracefully, respecting PodDisruptionBudgets). From your seat: pods on that node get SIGTERM, grace period, then move.

Whether users notice is decided entirely by *your* manifests, in advance:

- **Replicas ≥ 2** and spread across nodes (`topologySpreadConstraints` / anti-affinity) — a one-replica Deployment takes an outage on every drain, by design.
- **A PodDisruptionBudget** so the drain moves your pods one at a time instead of all at once:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-pdb
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: api
```

- **Graceful shutdown**: handle SIGTERM, stop accepting, drain in-flight requests, exit before `terminationGracePeriodSeconds`. Apps that ignore SIGTERM get SIGKILLed mid-request on every single drain.
- **Readiness gates the cutover**: replacement pods take traffic only when actually ready.

The full pattern is in [High Availability](/workloads/high-availability/). A team with these four in place experiences node maintenance as a log line; a team without them experiences it as an incident, every patch Tuesday.

:::caution[PDBs can also wedge a drain]
`minAvailable: 2` on a 2-replica Deployment means the drain can *never* proceed — platform will either wait, ping you, or force it. Keep PDBs satisfiable: always leave at least one pod's worth of headroom between replicas and minAvailable.
:::

## Taints appearing on nodes

Taints show up on nodes for two reasons you'll encounter: **automatic health taints** (`node.kubernetes.io/not-ready`, `unreachable`, `disk-pressure`, `memory-pressure`) and **policy taints** (dedicated pools). When a node goes NotReady, the `not-ready`/`unreachable` taints are what actually evict your pods — after a default toleration timeout of **300 seconds**, which is why pods sit in limbo for exactly five minutes before rescheduling. You can shorten that per-workload if fast failover matters more than churn:

```yaml
tolerations:
  - key: node.kubernetes.io/unreachable
    operator: Exists
    effect: NoExecute
    tolerationSeconds: 60
```

Don't blanket-tolerate health taints (`operator: Exists` with no key) — that keeps your pods *on* dying nodes. How taints and tolerations actually interact — effects, operators, and the `node.kubernetes.io/*` family — is covered in [Scheduling](/workloads/scheduling/).

## You can't fix nodes — you can stop caring about them

The whole strategy from the application seat: **make your app indifferent to losing any single node at any moment.** Concretely — multiple replicas, spread, PDB, graceful SIGTERM handling, honest probes, requests/limits set (including ephemeral-storage), state in PVCs or external stores rather than node disk. Once that's true, node problems stop being your incidents and become platform's routine.

## Quick check: is this node pain or app pain?

When you're not sure whether to debug your app or draft an escalation, three commands settle it:

```bash
# 1. Do failures cluster on a node?
kubectl get pods -o wide | awk '{print $8}' | sort | uniq -c | sort -rn

# 2. Are there evictions or node-taint events?
kubectl get events --sort-by=.lastTimestamp | grep -Ei 'evict|taint|notready'

# 3. Does a deleted pod come back healthy on a DIFFERENT node?
kubectl delete pod <one-broken-pod>   # Deployment replaces it; watch where it lands
```

If the replacement pod is healthy on another node, you've both confirmed the diagnosis and partially mitigated. If it breaks everywhere, it was never the node — back to [Triage Methodology](/troubleshooting/triage-methodology/).

## Escalating: the evidence package

Node remediation is platform's job. Make it fast for them:

- **Node name(s)** and the pattern: `kubectl get pods -o wide` output showing failures clustered on the node.
- **Timeline**: first bad event timestamp, from `kubectl get events --sort-by=.lastTimestamp`.
- **Eviction messages** verbatim (they name the resource under pressure).
- `kubectl get nodes` / `kubectl describe node <node>` output if your RBAC allows it — conditions and taints sections especially.
- What you did: "deleted the stuck pods, they rescheduled fine to other nodes; worker-07 still shows NotReady."

Format and etiquette in [Working with the Platform Team](/operations/working-with-platform-team/). If pods are stuck and you need service restored *now*: delete the stuck pods (they'll reschedule to healthy nodes) — with the StatefulSet caveat above — and let platform handle the node itself.

## Prevention checklist

- [ ] ≥2 replicas + topology spread for anything user-facing
- [ ] PDB per critical workload, always satisfiable
- [ ] SIGTERM handled; grace period fits your longest request
- [ ] ephemeral-storage requests *and* limits on every container
- [ ] `emptyDir` volumes have `sizeLimit`
- [ ] Dumps and debug artifacts shipped off-pod promptly
- [ ] Alert on `Evicted` pods and on pods `Terminating` > 5 minutes
