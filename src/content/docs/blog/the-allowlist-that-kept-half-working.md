---
title: "Field Notes: The Allow-List That Kept Half-Working"
description: A reporting service that connected to the corporate database perfectly for weeks, then began timing out — but only from some pods, and worse under load. The trail led to egress SNAT, a firewall pinned to node IPs, and a cluster that had quietly grown.
date: 2026-07-06
authors: editor
tags:
  - networking
  - egress
  - snat
  - debugging
excerpt: The DBA allow-listed our app and it worked. Six weeks later it started timing out — but only sometimes, and only from certain pods. Nothing in our code had changed. What had changed was how many nodes the cluster had.
---

The most dangerous kind of outage is the one that starts as a rounding error.

Our `reporting` service opens connections to a corporate Oracle database, `db.corp.example:1521`, to build overnight extracts. When we onboarded, the DBA asked for "the IP your app comes from," we gave them what we saw, they added a firewall rule, and it worked. For six weeks it worked. Then the nightly job started logging occasional `ORA-12170: TNS:Connect timeout occurred` — a few at first, then enough to fail the extract. No deploy, no config change, no code change on our side. The database team swore nothing changed on theirs. Both of us were telling the truth.

## "Only sometimes" plus "only some pods" equals identity

The failures weren't random. Retried on a different pod, the same connection often succeeded. We scaled the job to a few parallel pods and logged which ones could reach the DB:

```console
$ kubectl get pods -l job=nightly-extract -o wide
NAME                    READY   NODE       ...
nightly-extract-4k2p9   1/1     worker-3   ...   # DB reachable
nightly-extract-7xq4m   1/1     worker-11  ...   # DB times out
nightly-extract-9wz2c   1/1     worker-3   ...   # DB reachable
nightly-extract-p8n6t   1/1     worker-14  ...   # DB times out
```

Reachability tracked the **node**, not the pod. Pods on `worker-3` got through; pods on `worker-11` and `worker-14` timed out. That single correlation reframed the whole incident: this wasn't our app, and it wasn't the database — it was *which node the pod happened to land on*. And the only thing about a pod that a firewall between us and the database can see is the source IP on the packet.

## Whose IP does the database actually see?

Here's the thing every app team learns exactly once: **the database does not see your pod's IP.** Pod IPs come from the cluster's pod CIDR, which the corporate network has no route back to, so on the way out the node masquerades your source to its own IP — rewrite (e) in the [SNAT and DNAT census](/routing/nat/#e-pod-egress-masquerade--pod-ip-to-node-ip), the default behavior described in full in [Egress](/networking/egress/). We proved it from inside the pods without any node access, by asking an outside echo service what source it saw:

```console
$ kubectl exec nightly-extract-4k2p9 -- curl -s https://ifconfig.corp.example
10.40.8.13                          # worker-3's node IP — the "good" one
$ kubectl exec nightly-extract-7xq4m -- curl -s https://ifconfig.corp.example
10.40.8.31                          # worker-11's node IP — the "bad" one

# and the pod's own idea of its address, for contrast:
$ kubectl exec nightly-extract-7xq4m -- ip -br addr show eth0
eth0  UP  10.244.7.42/24            # what the pod thinks it is; the DB never sees this
```

Two pods, two *node* IPs, neither one the pod's own `10.244` address. The database's firewall rule allowed some of those node IPs and not others. We asked the DBA to read us the actual allow-list:

```text
# corporate DB firewall, "reporting app" rule
allow 10.40.8.10/31   # worker-1, worker-2
allow 10.40.8.12/31   # worker-3, worker-4
allow 10.40.8.14/31   # worker-5, worker-6
# ...six weeks ago the cluster had 6 nodes. That's all of them.
```

At onboarding the cluster had six nodes, so "the IP your app comes from" was a small, complete set and the DBA pinned exactly those. Since then the platform team had **autoscaled the cluster to nineteen nodes**, and the cluster scheduler — with no idea a firewall cared — was placing our pods on `worker-7` through `worker-19`, whose node IPs no rule mentioned. The allow-list wasn't wrong when it was written. It was *outgrown*. And it got worse under load precisely because load is when the cluster adds the newest, least-likely-to-be-allow-listed nodes.

:::note[This is the classic node-IP allow-list trap]
"Allow the app's IP" quietly means "allow every node the pod could ever run on" — and that set grows every time the cluster scales out. A firewall rule pinned to node IPs works right up until the scheduler places a pod on a node born after the rule was written. It fails at peak, intermittently, with no code change — which is exactly why it's so hard to recognize from the app side. See [Egress → the three identities](/networking/egress/#the-three-egress-identities).
:::

## The fix: stop giving them a moving target

The bad options were to allow-list all nineteen node subnets (and re-ticket the DBA on every scale event, forever) or to route pod IPs into the corporate network (a BGP project nobody wanted for one reporting job). The right option was the third egress identity: **an egress gateway** — a single, stable IP that all of the namespace's outbound DB traffic SNATs through, no matter which node the pod runs on.

The platform team already ran a Cilium egress gateway for exactly these "the DB team needs one IP" requests. We asked for our namespace's DB-bound traffic to exit through it:

```yaml
apiVersion: cilium.io/v2
kind: CiliumEgressGatewayPolicy
metadata:
  name: reporting-db-egress
spec:
  selectors:
    - podSelector:
        matchLabels: {job: nightly-extract}
  destinationCIDRs:
    - 10.60.4.0/24            # the DB subnet
  egressGateway:
    nodeSelector:
      matchLabels: {egress-gateway: "true"}
    egressIP: 10.40.9.9        # ONE stable IP, forever
```

Now every pod, on any node, leaves as `10.40.9.9`:

```console
$ kubectl exec nightly-extract-7xq4m -- curl -s https://ifconfig.corp.example
10.40.9.9
$ kubectl exec nightly-extract-p8n6t -- curl -s https://ifconfig.corp.example
10.40.9.9                          # same identity regardless of node
```

We handed the DBA a single line — *"all traffic now arrives from `10.40.9.9/32`, and that will not change when the cluster scales"* — and they replaced eleven fragile node-subnet rules with one. The next scale-up was a non-event.

## What we changed on our side

- **We treat egress identity as a design decision, not a discovery.** Before this, "the IP we come from" was whatever `ifconfig` happened to report the day we onboarded. Now every service that talks to a firewalled dependency has its egress identity chosen on purpose — default node IP, routed pod IP, or gateway — and *written down* in the service README. The [egress decision table](/networking/egress/#the-decision-table) is the menu.
- **`curl https://<echo> ` from inside the pod is step one of any "the firewall blocks us" ticket.** The address the outside world sees is almost never the one you assume, and one command settles it before anyone opens a bridge call with the network team.
- **We never again hand a firewall team a node IP.** A node IP is a moving target the scheduler reserves the right to change. We give them either a stable egress-gateway `/32` or nothing — and we say the words "stable across scaling" in the request, because that's the DBA's real question ([getting the firewall rule right](/networking/egress/#getting-the-firewall-rule-right-the-first-time)).
- **"Only some pods" is now a first-class clue.** When reachability correlates with `-o wide`'s NODE column instead of the request, the problem is between the node and the destination — SNAT, routing, or a firewall keyed on node identity — not the app. That correlation check is a thirty-second `kubectl get pods -o wide` we run early now, not late.

Nothing in our code broke. The database never changed. The cluster just quietly grew past the edge of a firewall rule that had been complete the day it was written — and the only fix that actually holds is to leave as an identity that doesn't move.
