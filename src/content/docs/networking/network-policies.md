---
title: Network Policies
description: How NetworkPolicy selection flips pods from default-allow to default-deny, the rules you actually need, and why some clusters silently don't enforce them.
sidebar:
  order: 7
---

The Kubernetes pod network is flat and open: by default, **any pod can connect to any pod in any namespace**. NetworkPolicy is the firewall layer you control — namespace-scoped resources you can create without any platform privileges. But it has semantics that trip up nearly everyone the first time, and one production-grade trap: whether policies are enforced *at all* depends on the CNI plugin your platform team runs.

## The semantic model (read this twice)

There is no "deny" rule in NetworkPolicy. The model is:

1. A pod not selected by any policy: **everything allowed** (both directions).
2. The moment *any* policy selects a pod for a direction (`Ingress` or `Egress`), that direction flips to **default-deny**, and only traffic matching some policy's rules is allowed.
3. Policies are **additive** — multiple policies selecting the same pod form a union of allows. There is no ordering, no precedence, no conflict: if any policy allows a flow, it flows.
4. Directions are independent: a policy with `policyTypes: [Ingress]` doesn't touch egress at all.
5. Connections are stateful: allow the initiating direction and the replies come back automatically. You do **not** need an egress rule for responses to allowed ingress.

The practical consequence: adding your first, innocent-looking policy ("allow monitoring to scrape me") **silently blocks everything else inbound**. That first policy is the moment your pod goes from open to locked-down-except-this.

## Anatomy and the three peer types

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: orders-ingress
  namespace: myteam
spec:
  podSelector:            # WHICH PODS this policy applies to (in this namespace)
    matchLabels:
      app: orders
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:          # pods in THIS namespace with these labels
            matchLabels:
              app: frontend
        - namespaceSelector:    # ALL pods in namespaces with these labels
            matchLabels:
              kubernetes.io/metadata.name: payments
        - ipBlock:              # CIDR ranges (for traffic from outside the pod network)
            cidr: 10.40.0.0/16
            except: [10.40.9.0/24]
      ports:
        - protocol: TCP
          port: 8080
```

Two gotchas hiding in that YAML:

- Within one `from` element, listing `podSelector` and `namespaceSelector` as **separate list items means OR**. Combining them in a *single* item (both keys, one dash) means AND — "pods with these labels in namespaces with those labels." The one-character diff between them has caused real outages.
- `namespaceSelector` matches **labels on the Namespace object**, not names. Every namespace automatically carries `kubernetes.io/metadata.name: <name>`, which is the reliable way to target a namespace by name.

An empty `podSelector: {}` selects **all pods in the namespace** — that's how you write namespace-wide baselines.

## The rules you will actually need

**1. Default-deny baseline** (the starting point for a locked-down namespace):

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
```

**2. Allow DNS egress — the classic forgotten rule.** The moment egress is denied, your pods can't resolve *anything*, and every connection fails with a timeout that looks nothing like a DNS problem. Ship this alongside any egress-restricting policy, always:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

**3. Allow the ingress controller** — without this, your Ingress-routed traffic 502s while in-namespace tests pass, which is maximally confusing:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-from-ingress-controller
spec:
  podSelector:
    matchLabels:
      app: orders
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx   # ask platform for the real namespace
      ports:
        - protocol: TCP
          port: 8080
```

:::caution[Controllers on hostNetwork break podSelector rules]
If the ingress controller (or kubelet probes on some CNIs) runs with `hostNetwork: true`, its traffic arrives from a **node IP**, which no pod/namespace selector matches — you'd need an `ipBlock` with the node CIDR, which only your platform team can tell you. If your allow-from-ingress rule mysteriously doesn't work, ask whether the controller is hostNetwork.
:::

**4. Allow egress to your database** in another namespace:

```yaml
egress:
  - to:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: data
        podSelector:              # same item as above: AND — postgres pods in "data" ns
          matchLabels:
            app: postgres
    ports:
      - protocol: TCP
        port: 5432
```

## Enforcement depends on the CNI — verify, don't assume

NetworkPolicy is an API contract that the **CNI plugin** may or may not implement. Calico and Cilium enforce it. Plain Flannel **accepts your policies and does absolutely nothing with them** — `kubectl apply` succeeds, `kubectl get netpol` lists them, and every packet still flows. No error, no event, no warning.

So before you trust a policy (especially one you're presenting to a security auditor), **prove it blocks something**:

```bash
# From a pod that should now be blocked:
kubectl run probe --rm -it --image=nicolaka/netshoot -- \
  timeout 3 nc -zv orders.myteam.svc.cluster.local 8080
```

```console
nc: connect to orders.myteam.svc.cluster.local (10.96.44.7) port 8080 (tcp) timed out
```

A timeout is what enforcement looks like (policies drop packets; you get timeouts, not refusals). If that connection *succeeds* after you've applied default-deny, your cluster isn't enforcing policies — take that finding to your platform team.

## Testing methodology

Treat policies like code: test the allow *and* the deny.

```bash
# The allowed path still works:
kubectl exec deploy/frontend -- curl -s -m 3 -o /dev/null -w '%{http_code}\n' http://orders:8080/healthz
# The denied path is actually denied (run from a pod NOT matching any allow rule):
kubectl run probe --rm -it --image=nicolaka/netshoot -- timeout 3 curl -sv http://orders.myteam:8080/healthz
# What policies currently select traffic in this namespace?
kubectl get networkpolicy -o wide
kubectl describe networkpolicy orders-ingress
```

Roll out in this order to avoid self-inflicted outages: (1) apply the allow rules first, (2) verify the legitimate paths, (3) *then* apply default-deny. Doing it the other way around gives you a window where everything is blocked.

:::tip
Policy match is by **pod labels at connection time**. If your Deployment's pod template labels drift from what your policies select (a rename, a Helm refactor), new pods silently fall outside the allow rules. Keep policy selectors and workload labels in the same file or chart so they change together — see [labels and namespaces](/start/yaml-labels-and-namespaces/).
:::

## The signature incident

The most common NetworkPolicy incident pattern, worth memorizing:

> *Rollout succeeds, health checks pass, but the new pods can't reach the database. Old pods (still draining) were fine. Nothing changed in the network.*

What actually happened: an egress policy in the namespace allows `to: podSelector: app=orders-v1`-style flows, or the new pods carry a changed label set that no longer matches the egress allow rules — or the DB namespace's *ingress* policy allows the old labels only. New pods start with different labels → fall out of the allow set → connections to the database time out. The health check passes because it doesn't touch the database (a probe-design mistake in itself — see [health checks](/workloads/health-checks/)).

Diagnosis is fast once you suspect it:

```bash
kubectl get netpol -n myteam -o yaml | grep -B3 -A8 'matchLabels'
kubectl get pods -l app=orders --show-labels     # do these match the policy selectors?
```

And remember the other direction: the *database's* namespace may have policies you can't see if you lack read access there. Cross-namespace flows need the egress side (yours) **and** the ingress side (theirs) to allow it. Coordinate with the owning team.

When a connection times out and you don't know why, policies are checkpoint two (right after DNS) in the [debugging playbook](/networking/debugging-network/), and the deep-dive symptom catalog lives in [service unreachable](/troubleshooting/service-unreachable/).
