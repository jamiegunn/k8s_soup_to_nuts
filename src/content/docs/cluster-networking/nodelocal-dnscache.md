---
title: NodeLocal DNSCache
description: The per-node DNS cache that kills the exact-5-second timeout — why the conntrack race causes it, how to detect the cache, and what to ask the platform team for.
keywords:
  - every 5th DNS query is slow
  - 5 second DNS timeout
  - intermittent name resolution failures
  - conntrack race
  - insert_failed
  - UDP DNAT race
  - node-local-dns
  - 169.254.20.10
  - DNS slow under load
  - CoreDNS offload
sidebar:
  order: 4
---

You came here because of a very specific, very maddening symptom: DNS *mostly* works, but every so often a lookup takes almost exactly **five seconds** before it succeeds. Most requests are instant. An unlucky few stall for ~5s and then complete. Under load, you might instead see short **bursts of name-resolution failures** — connections that couldn't resolve a host, clearing on retry. And the whole time, every dashboard is green: CoreDNS is healthy, the network is fine, your pods are Ready.

That "almost exactly 5 seconds" is not noise. It's a fingerprint. It points at one specific kernel-level bug, and NodeLocal DNSCache is the thing that removes it.

## Why exactly 5 seconds

Five seconds is the default DNS resolver retransmit timeout. If you see it, a DNS **packet was dropped** and the client sat waiting for its retry timer to fire. It is almost never "CoreDNS being slow" — CoreDNS answers cluster and cache-hit queries in microseconds. Something ate the packet.

Here's the mechanism. Your pod sends its DNS query as **UDP** to the CoreDNS Service ClusterIP (classically `10.96.0.10`). That ClusterIP isn't a real interface — it's a virtual IP that the node's dataplane **DNAT**s to a real CoreDNS pod, and that translation is recorded in the kernel's **conntrack** table.

Now the twist: glibc resolves `A` and `AAAA` records **in parallel** — two UDP queries fired essentially simultaneously, same source, same destination tuple. Two packets needing two conntrack entries **for the same tuple at the same instant** can *race* inside the kernel. One entry wins; the kernel drops the loser as `insert_failed`. That dropped packet is gone. The client waits out its full 5-second timeout, then retransmits — and the retry, arriving alone, succeeds.

So the signature is a **kernel conntrack race on UDP DNAT**, not a DNS server problem. It gets dramatically worse the more lookups you fire, which is exactly what glibc's `ndots:5` search-domain expansion does — multiplying every external name into 4+ queries (each a parallel A+AAAA pair). We won't re-tell the ndots story here; it lives in [DNS inside the cluster](/networking/dns/). Just know it's the accelerant, not the fire.

:::note[The tell]
Green CoreDNS + occasional *exactly*-5s stalls + worse under load = conntrack race on UDP DNS DNAT. If your slow lookups are a random spread of durations (200ms, 800ms, 3s), that's a different problem — probably upstream/corporate DNS. The 5s bug is discrete and repeatable.
:::

## What NodeLocal DNSCache is

NodeLocal DNSCache is a small add-on the platform team installs as a **DaemonSet** — one pod per node, each running a CoreDNS binary as a local cache. It listens on a **link-local address** (default `169.254.20.10`), and your pods' DNS traffic is intercepted to that node-local address instead of being sent off-node to the CoreDNS Service VIP.

You do not deploy this. You do not manage it. It's a cluster-wide platform decision. Your job is to (a) know whether you have it, and (b) know how to ask for it with evidence if you don't.

## Why it kills the 5-second timeout

This is the mechanism that matters, so it's worth being precise:

- **The pod-to-cache hop doesn't go through conntrack DNAT.** The interception to the link-local address uses `NOTRACK` iptables rules, so those DNS packets **skip connection tracking entirely**. No conntrack insert means no `insert_failed` race — the thing that dropped your packet can't happen on this hop.
- **Cache misses go upstream over TCP.** When the local cache doesn't have an answer, it forwards to the real CoreDNS over **TCP** on a connection it keeps open — TCP has no per-packet UDP conntrack race to lose.
- **Most queries never leave the node at all.** A busy node's DNS is overwhelmingly repeat lookups (including all those search-walk NXDOMAINs); served straight from the local cache in microseconds.

The side benefits are real too: **CoreDNS load drops** (fewer queries reach it) and **cross-node DNS latency drops** (the common case is answered on-box). But the headline is the first bullet — the race is structurally impossible on the intercepted path.

## Does my cluster already have it?

This is a one-command check from your own seat. Look at what kubelet wrote into a pod's resolver:

```bash
kubectl exec deploy/yourapp -- cat /etc/resolv.conf
```

```console
search myteam.svc.cluster.local svc.cluster.local cluster.local
nameserver 169.254.20.10
options ndots:5
```

The tell is the **`nameserver`** line:

| `nameserver` value | What it means |
|---|---|
| `169.254.20.10` (a link-local `169.254.x.x`) | NodeLocal DNSCache is in play |
| `10.96.0.10` (the kube-dns / CoreDNS ClusterIP) | No NodeLocal — you're going straight to the Service VIP |

:::note[One wrinkle]
Some installations keep the old `10.96.0.10` in resolv.conf and transparently **intercept** it to the local cache, so a ClusterIP nameserver doesn't strictly *prove* you lack NodeLocal. But a `169.254.20.10` nameserver is a positive confirmation you have it. If you see the ClusterIP and still suspect a local cache, that's a question for platform.
:::

From a node-privileged context, the platform would confirm by spotting a `node-local-dns` DaemonSet in `kube-system`. You typically **can't** list `kube-system` objects, so don't burn time trying — ask them, or rely on the resolv.conf tell above.

## What you can do right now (before any ticket)

NodeLocal is a platform install, and those take time. Meanwhile, the accelerant is *your* lookup volume, and you own several knobs that reduce it. Fewer queries means fewer chances to lose the race:

- **Use fully-qualified names with a trailing dot.** `db.myns.svc.cluster.local.` (note the final `.`) is treated as fully qualified — the search-domain walk is skipped entirely, collapsing 4+ queries into 1. Works in most config files and clients; test it, since some TLS/SNI paths dislike the trailing dot.
- **Tune `ndots` per pod** via `dnsConfig` so external names stop triggering the search-walk. Full mechanics and a worked example are in [DNS inside the cluster](/networking/dns/).
- **Cache in your app.** Honor DNS TTLs, and if you're on the JVM, stop it from caching forever *or* re-resolving every call. Fewer resolutions, fewer races.
- **Prefer fewer DNS-heavy fan-outs.** A service that resolves a hostname on every one of a thousand parallel calls is manufacturing the exact conditions this bug needs.

There's also the direct escape hatch when you can't restructure lookups: `single-request-reopen` (or `single-request`) in `dnsConfig.options` makes glibc **serialize** the A and AAAA queries instead of firing them together — which removes the same-tuple-at-once condition the race depends on. It's a per-pod change you own, and it's the standard stopgap before NodeLocal lands.

```yaml
spec:
  dnsConfig:
    options:
      - name: ndots
        value: "2"
      - name: single-request-reopen
```

## When to escalate — and the evidence to attach

If you've **confirmed the 5-second signature** and the mitigations above aren't enough (or you can't set resolver options in your stack), the real fix is NodeLocal DNSCache, and that is a **platform request**. Frame it as a question, not a config demand — see [working with the platform team](/operations/working-with-platform-team/) for the etiquette.

A ticket that gets actioned staples on proof, not adjectives:

- **Captured ~5s DNS latencies** — `time dig <name>` runs or app-metric histograms showing the discrete 5s spike (not a smooth latency spread).
- **`insert_failed` counts**, if anyone with node access can read them (`conntrack -S` or the node's `netfilter` stats) — a rising `insert_failed` is the smoking gun that confirms the UDP DNAT race.
- **The affected workload** — namespace, deployment, and the names it resolves hardest, so they can gauge blast radius.

"DNS is flaky" comes straight back to you. "Here are captured 5.0s DNS stalls correlating with rising conntrack `insert_failed` under load on `orders` — please evaluate NodeLocal DNSCache" gets a real answer.

## The caution nobody mentions

NodeLocal DNSCache is not free of trade-offs. It adds a **per-node failure surface** — if a node's local DNS pod is unhealthy, DNS on *that* node degrades — and it introduces **its own cache with its own TTLs**. That means the classic *"I fixed the record but pods still resolve the old value"* now has one more suspect: the stale answer might be sitting in the node-local cache, not just in CoreDNS. When you're chasing a cache-staleness ghost, remember there are potentially three layers holding the old answer (NodeLocal, CoreDNS, your app). The cache semantics — including how negative/NXDOMAIN answers get cached — are covered in the [CoreDNS Deep Dive](/routing/coredns-deep-dive/).

For where this add-on sits in the broader internal fabric — the pod network, the Service network, and cluster DNS — see the [Cluster Networking overview](/cluster-networking/overview/).
