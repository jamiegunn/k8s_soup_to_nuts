---
title: Service Unreachable
description: Hop-by-hop playbook for "the service is down" — selectors, endpoints, ports, DNS, NetworkPolicy, and ingress errors.
sidebar:
  order: 7
---

**Symptom:** clients get connection refused, timeouts, empty responses, or 502/503/504 from the ingress. "The service is down" — except the pods often aren't. Kubernetes networking is a chain: **client → DNS → Service → EndpointSlice → pod IP → containerPort → process**. Something in the chain is broken; your job is to find the first broken hop, not to guess.

Work the hops in this order — it's sorted by likelihood.

## Hop 1: Are the pods Ready?

```bash
kubectl get pods -l app=api
```

A pod that is `Running` but `0/1 READY` is **deliberately removed from the Service** — that's the readiness probe doing its job. All replicas NotReady = zero endpoints = every request fails, even though everything is "running".

```console
NAME                   READY   STATUS    RESTARTS   AGE
api-7d4b9c6f8-2xkqp    0/1     Running   0          15m
api-7d4b9c6f8-9wlmn    0/1     Running   0          15m
```

If this is your picture: `kubectl describe pod` → probe failure events → why is the probe failing? (Dependency down? Probe checking the wrong port/path after a refactor?) See [Health Checks](/workloads/health-checks/). Everything downstream of this hop is fine; stop here and fix readiness.

## Hop 2: Does the selector actually match the labels? (the #1 cause)

The Service selects pods by label. A selector that matches nothing produces a Service that resolves in DNS, accepts connections... and has nowhere to send them. This is the single most common cause of "service down but pods healthy" — typically after a Helm refactor renamed labels, or `version: v2` was added to the selector but not the pods.

Compare them side by side:

```bash
kubectl get svc api -o jsonpath='{.spec.selector}'; echo
kubectl get pods --show-labels | grep api
```

```console
{"app":"api","tier":"backend"}
api-7d4b9c6f8-2xkqp   1/1  Running  0  2d  app=api,tier=web,pod-template-hash=7d4b9c6f8
```

`tier=backend` vs `tier=web` — no match, no endpoints. The definitive cross-check: feed the selector to a pod query and see if anything comes back:

```bash
kubectl get pods -l app=api,tier=backend
# No resources found in prod namespace.  ← there's your outage
```

Fix in the manifest (Service selector or pod template labels, whichever is wrong) and redeploy through the pipeline.

## Hop 3: Do EndpointSlices have addresses?

This hop *proves* hops 1–2 in one command:

```bash
kubectl get endpointslices -l kubernetes.io/service-name=api
```

```console
NAME        ADDRESSTYPE   PORTS   ENDPOINTS                     AGE
api-x7k2m   IPv4          8080    10.42.3.17,10.42.5.22         2d
```

- Endpoints present → Service→pod wiring works; the problem is upstream (DNS, client, NetworkPolicy, ingress) or the port (hop 4).
- `ENDPOINTS <none>` → no Ready pods match the selector. Back to hops 1–2.
- Endpoints exist but the PORTS column isn't what clients dial → hop 4.

## Hop 4: Port chain — port vs targetPort vs containerPort

Three different numbers that people conflate:

```yaml
# Service
ports:
  - port: 80          # what clients dial: api.prod.svc:80
    targetPort: 8080  # where the Service forwards on the pod
# Pod
ports:
  - containerPort: 8080   # documentation-ish; the process must ACTUALLY listen here
    name: http
```

Failure modes:

- `targetPort` ≠ the port the process listens on → **connection refused** on every request while everything looks green. `containerPort` is not enforced — the kernel doesn't care what the YAML says, only what the process binds.
- Process listens on `127.0.0.1:8080` instead of `0.0.0.0:8080` → unreachable from off-pod, works via `kubectl exec` + localhost. Maddening. Fix the app's bind address.
- **Named ports** (`targetPort: http`) resolve against the *pod's* port names — rename the port in the pod template, forget the Service, and the chain silently breaks. Named ports are worth it (change the number in one place), but grep both sides when they misbehave.

## Hop 5: Can you reach the pod IP directly?

Bypass the Service machinery entirely. Spin up a debug pod and curl a pod IP from hop 3:

```bash
kubectl run netcheck --rm -it --image=nicolaka/netshoot -- bash
# inside:
curl -sv --max-time 3 http://10.42.3.17:8080/healthz
```

- **Pod IP works** → the app and pod network are fine. The break is in Service/DNS/policy/ingress — continue to hops 6–8.
- **Pod IP fails** → the app isn't serving (wrong port, localhost bind, wedged process) or a NetworkPolicy blocks you (hop 7). Confirm from *inside* the target pod: `kubectl exec <pod> -- netstat -tlnp` (or `ss -tln`), or use an ephemeral container if the image is toolless ([Debugging Toolbox](/troubleshooting/debugging-toolbox/)).

## Hop 6: DNS

```bash
# from the netshoot pod:
nslookup api                       # same namespace
nslookup api.prod.svc.cluster.local
```

`NXDOMAIN` for a Service that exists usually means wrong namespace (cross-namespace clients must use `api.prod`, not `api`), a typo, or — if *all* lookups fail/timeout — cluster DNS trouble, which is platform territory. Full decoding in [DNS](/networking/dns/).

## Hop 7: NetworkPolicy

If the pod IP works from your debug pod but the *real client* still can't connect — or the debug pod itself times out while the app demonstrably listens — suspect NetworkPolicy. Policies are default-allow until any policy selects a pod; then it's default-deny for that direction.

```bash
kubectl get networkpolicy
kubectl describe networkpolicy <name>
```

Classic: a namespace-wide ingress policy allows traffic from pods labeled `role: frontend`, and the new consumer doesn't carry the label. Timeouts (not refusals) are the NetworkPolicy signature — dropped packets, no RST. Details and test patterns in [Network Policies](/networking/network-policies/).

## Hop 8: Ingress layer — decoding 502/503/504

Only relevant when external clients fail but in-cluster access works. The status code tells you where to look ([Ingress and Routing](/networking/ingress-and-routing/)):

| Code | Ingress controller is saying | Look at |
|---|---|---|
| **502** Bad Gateway | I connected (or tried) and the backend answered garbage or reset | App crashing mid-request, wrong targetPort, TLS mismatch (controller speaks HTTP to an HTTPS-only pod) |
| **503** Service Unavailable | I have no healthy backends for this route | Zero endpoints (hops 1–3!), wrong Service name/port in the Ingress rule |
| **504** Gateway Timeout | Backend took too long | Slow app, controller timeout shorter than your slowest request, NetworkPolicy silently dropping controller→pod traffic |

An Ingress pointing at a Service name or port that doesn't exist produces eternal 503s with everything green in your namespace — validate the reference:

```bash
kubectl describe ingress api | grep -A5 "Rules"
```

The ingress *controller* itself (config, logs, reloads) is platform-owned; escalate with the status code, a timestamped failing request, and proof that in-cluster access works.

:::tip[Two chain-breakers this walkthrough can't see]
If the namespace is meshed, 503s can originate in the sidecar rather than any hop above — check the Envoy response flags ([Service Mesh](/networking/service-mesh/)). And if only *some* requests fail, or one pod gets all the traffic, suspect gRPC/WebSocket connection-level balancing ([Long-Lived Connections](/networking/long-lived-connections/)).
:::

## Copy-paste diagnostic: walk the whole chain

```bash
#!/usr/bin/env bash
# usage: ./svc-check.sh <service> [namespace]
SVC=$1; NS=${2:-$(kubectl config view --minify -o jsonpath='{..namespace}')}; NS=${NS:-default}
echo "=== Service ==="
kubectl -n "$NS" get svc "$SVC" -o wide || exit 1
SELECTOR=$(kubectl -n "$NS" get svc "$SVC" -o jsonpath='{.spec.selector}' \
  | tr -d '{}"' | tr ':' '=' | tr ',' ',')
echo "=== Selector: $SELECTOR ==="
echo "=== Pods matching selector ==="
kubectl -n "$NS" get pods -l "$SELECTOR" -o wide
echo "=== EndpointSlices ==="
kubectl -n "$NS" get endpointslices -l "kubernetes.io/service-name=$SVC"
echo "=== NetworkPolicies in namespace ==="
kubectl -n "$NS" get networkpolicy 2>/dev/null
echo "=== In-cluster probe (DNS + HTTP) ==="
PORT=$(kubectl -n "$NS" get svc "$SVC" -o jsonpath='{.spec.ports[0].port}')
kubectl -n "$NS" run "svc-check-$$" --rm -i --restart=Never \
  --image=curlimages/curl -- \
  sh -c "nslookup $SVC.$NS.svc.cluster.local && curl -sv --max-time 5 http://$SVC.$NS:$PORT/ 2>&1 | tail -15"
```

Interpretation: empty pod list → selector bug (hop 2). Pods `0/1` → readiness (hop 1). Empty endpoints with Ready pods → port/selector mismatch. DNS fails → hop 6. curl times out with endpoints present → NetworkPolicy (hop 7) or app bind address (hop 5).

## Prevention

- Lock the label ↔ selector contract in one templated variable (Helm/kustomize) so they can't drift apart.
- Use named ports; grep both Service and pod template when renaming anything.
- Readiness probes that reflect actual serving ability — and alert on "Service has 0 endpoints", the highest-signal alert in this entire article.
- Test cross-namespace and through-ingress paths in staging, not just pod-local curls.
