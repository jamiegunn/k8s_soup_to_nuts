---
title: DNS Integration and Naming Architecture
description: How cluster DNS and corporate DNS form one namespace — naming decisions, external-dns, TTL strategy, split-horizon, and the checklist to run before you ask for a record.
sidebar:
  order: 5
---

Your application lives under two entirely separate naming authorities. Inside the cluster, `orders.myteam.svc.cluster.local` is synthesized on demand by [CoreDNS](/routing/coredns-deep-dive/) from an API watch — it exists in no zone file and is invisible to the rest of the company. Outside, `orders.company.com` lives on corporate resolvers (Infoblox, BIND, Windows DNS — whatever your enterprise runs), authoritative, replicated, change-controlled. Neither authority knows the other exists.

You can demonstrate the wall in two commands:

```console
$ dig orders.myteam.svc.cluster.local @10.20.0.53 +short    # ask a corporate resolver
$                                                            # nothing — the name doesn't exist out here
$ kubectl exec deploy/orders -- dig orders.company.com +short  # ask from a pod
10.50.8.20                                                   # corporate view, visible in-cluster via forward
```

The relationship is asymmetric: pods can see the corporate namespace (CoreDNS forwards to it), but nothing outside can see `cluster.local`. Every integration decision in this article flows from that asymmetry.

Making these two systems behave like *one coherent namespace* — where every client, inside or outside, resolves a sensible name to a working path — is a design problem, not a config file. It's also the part of Kubernetes networking where a bad early decision (a name pattern, a TTL, a wildcard) hardens into something you live with for years. This article is the design guide.

## Two authorities, three directions

Every flow touching your service travels one of three directions, and each needs its own naming story:

| Direction | Who answers the DNS query | What the answer points at |
|---|---|---|
| Outside → cluster | Corporate resolvers | The corporate VIP (F5/NetScaler), which forwards to a MetalLB IP |
| Pod → outside | CoreDNS `forward` / stub domains → corporate resolvers | Whatever corporate DNS says |
| Pod → pod | CoreDNS `kubernetes` plugin | ClusterIP or pod IPs |

### Outside → cluster: the naming chain

In the corporate reference topology ([the front door](/architectures/front-door/)), an external client's request rides a chain where **each hop is found by a different mechanism**:

```text
client resolves orders.company.com          → corporate DNS answers: 10.50.8.20 (F5 VIP)
F5 VIP forwards to its pool members         → pool = MetalLB-assigned IPs (no DNS involved)
MetalLB IP lands on a Service               → kube-proxy DNAT to pod IPs (no DNS involved)
```

Only the **first** hop is DNS. The corporate record points at the appliance VIP — a stable, human-owned address — and everything downstream is pool membership and dataplane plumbing ([external load balancing](/networking/external-load-balancing/), [MetalLB](/controllers/metallb/), and if your platform runs F5 CIS, [the controller that maintains the pool automatically](/controllers/f5-cis/)). This layering is a feature: the DNS record almost never changes, because churn is absorbed by the layers below it. Keep that in mind when we get to TTLs.

The corollary that surprises people during incident reviews: **most "DNS changes" you'll ever want aren't DNS changes.** Scaling out, moving the app between nodes, replacing the Service, even re-homing to a different MetalLB pool — all invisible to the record. The record only changes when the *front door itself* moves: new VIP, new datacenter, new appliance. That's why record requests should be rare, deliberate, and well-specified (template below).

### Pod → outside

Your pod asks CoreDNS; CoreDNS forwards to the node's corporate resolvers, with **stub domains** routing specific internal zones to specific resolvers. The mechanics — forward plugin, negative caching, what to request — are the whole back half of [the CoreDNS deep dive](/routing/coredns-deep-dive/). The architectural point here: **pods see the corporate DNS view of the world**, plus `cluster.local` layered on top. That "plus" is where split-horizon lives (below).

### Pod → pod

Cluster DNS, full stop. Use `service.namespace.svc.cluster.local` forms, mind the ndots tax, and read [DNS inside the cluster](/networking/dns/) — nothing in this article overrides any of it. The rule that *does* belong here: **pod-to-pod traffic between apps in the same cluster should use cluster names, not corporate names**, even when a corporate name for the target exists. Calling `orders.company.com` from a neighboring pod sends your request out through the appliance and back in — the hairpin trap covered below — when `orders.myteam.svc.cluster.local` was three hops away the whole time.

## Naming architecture: the decisions that stick

These are the choices someone makes in the first month of a platform's life and everyone inherits. If you're early enough to influence them, do; if not, at least know which pattern you're living in.

### Wildcard vs per-app records

**Wildcard**: one record, `*.apps.company.com → 10.50.8.20` (the shared VIP). Every new app gets a name for free — `orders.apps.company.com` works the moment the ingress route exists, zero DNS tickets. The appliance (or ingress) routes by Host header.

**Per-app**: each app gets an explicit record, individually requested, individually owned, individually pointable.

| Decision | Recommendation | Why |
|---|---|---|
| Internal/dev/QA apps | **Wildcard** | Velocity; a DNS ticket per QA env is bureaucratic drag with no benefit |
| Production, customer-facing | **Per-app record** (even if it lands on the same VIP) | Independent failover: you can repoint one app during an incident or migration without touching neighbors |
| Anything needing its own cert story or DR target | Per-app | Wildcards weld apps together operationally |
| Env encoding | `app.dev.company.com` (env as subdomain) over `app-dev.company.com` | Subdomains delegate cleanly (a `dev` zone can have its own wildcard, its own owners, its own TTL policy); name-mangling doesn't |

The environment-encoding row deserves a second look, because `app-dev` suffixing is the pattern teams reach for first and regret longest. Compare what each gives you:

```text
Subdomain encoding                       Suffix encoding
─────────────────────                    ─────────────────────
orders.dev.company.com                   orders-dev.company.com
orders.qa.company.com                    orders-qa.company.com
orders.company.com          (prod)       orders.company.com    (prod)

*.dev.company.com → dev VIP  ✓ one       (no wildcard possible without
 wildcard covers every dev app            catching prod names too)
dev zone delegated to platform ✓         every record lives in the prod
wildcard cert *.dev.company.com ✓         zone, every change is a prod ask
```

With subdomains, the whole lower-environment estate becomes self-service under a delegated zone; with suffixes, every QA record is a change ticket in the production zone forever. And promotion is cleaner: the environment is a config value swapped at deploy time, not a string surgery on the app name.

:::tip
The hybrid most mature shops converge on: wildcard per environment zone (`*.dev.apps.company.com`, `*.qa.apps.company.com`) plus explicit per-app production records. You get ticketless lower environments and independently steerable prod names.
:::

### The anti-pattern: leaking cluster.local

It happens innocently: someone pastes `orders.myteam.svc.cluster.local` into a config consumed by a partner team's VM, or embeds it in a callback URL sent to an external system. It resolves nowhere outside the cluster — `cluster.local` exists only in CoreDNS's memory — and the failure arrives later, in someone else's logs, wearing someone else's pager. The rule is absolute: **`cluster.local` names never appear in anything that leaves the cluster** — not in emails, not in webhooks, not in OpenAPI specs, not in TLS certificates. If an external party needs to reach you, they need a corporate name, which means the front-door chain above.

### CNAME chains through the appliance

Corporate DNS teams love CNAMEs, and a typical exposed app accumulates a chain:

```console
$ dig orders.company.com
orders.company.com.        300   IN  CNAME  orders.gslb.company.com.
orders.gslb.company.com.   30    IN  CNAME  orders-dc1.company.com.
orders-dc1.company.com.    300   IN  A      10.50.8.20
```

Each link is a legitimate layer (friendly name → GSLB steering name → site VIP), but the costs are real: a resolution can take multiple upstream round-trips before caches warm, the **effective TTL is the minimum of the chain** (here 30 s, set by the GSLB link — which is deliberate, that's where failover steering happens), and debugging requires walking every link. Keep chains to two links where you can, and when you file the [record request](#when-theres-no-external-dns-the-manual-request), ask what the final chain will look like — not just the name.

## external-dns: records as code

**external-dns** (the kubernetes-sigs project of the same name) is the controller that closes the loop between the two authorities: it **watches Ingress, Service, and HTTPRoute objects for annotations and writes the corresponding records into corporate DNS** through a provider API — Infoblox, Route 53, Azure DNS, RFC2136 to BIND, and a long list of others. When your platform runs it, "getting a DNS record" stops being a ticket and becomes a line of YAML.

The annotation contract:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: orders-external
  annotations:
    external-dns.alpha.kubernetes.io/hostname: orders.apps.company.com
    external-dns.alpha.kubernetes.io/ttl: "300"
spec:
  type: LoadBalancer          # MetalLB assigns the IP external-dns will publish
  ...
```

external-dns sees the annotation, waits for MetalLB to assign the LoadBalancer IP, and creates `orders.apps.company.com → <that IP>` upstream. On Ingress objects it can work annotation-free, publishing the `spec.rules[].host` names:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: orders
  annotations:
    external-dns.alpha.kubernetes.io/ttl: "300"
spec:
  rules:
    - host: orders.apps.company.com     # external-dns publishes this, pointed at the ingress LB address
      http: { ... }
```

Note what this means in the F5-fronted topology: pointing a record straight at a MetalLB IP **bypasses the appliance** — fine for cluster-internal-corporate traffic, wrong for anything that's supposed to ride the front door. Some platforms solve this by having external-dns publish CNAMEs to an appliance-owned name instead of A records to the raw IP. Your platform's external-dns config determines which pattern you're in; ask before you annotate.

**Ownership TXT records** are how external-dns avoids trampling the rest of the enterprise: alongside every record it creates, it writes a TXT record tagging the record with its owner ID. It will only ever modify or delete records carrying its own tag. This is also your forensic tool — a TXT query on a mystery record tells you which cluster created it:

```console
$ dig TXT orders.apps.company.com +short
"heritage=external-dns,external-dns/owner=prod-cluster-a,external-dns/resource=service/myteam/orders-external"
```

That one answer names the owning cluster, the namespace, and the exact object — worth knowing before you email three teams asking "whose record is this?"

**Why platforms scope it tightly:** an unconstrained external-dns honors *any* annotation in *any* namespace. One typo'd hostname annotation — `payments.company.com` instead of `payments.apps.company.com` — and a controller with broad zone permissions just overwrote (or shadowed) someone else's production record. So mature platforms run it with `--domain-filter` locked to specific zones, often `--policy=upsert-only` (never delete), sometimes per-namespace allow-lists. If your annotation "isn't working," the most common cause is that your requested name falls outside the permitted domain filter — check with platform before debugging the controller.

### When there's no external-dns: the manual request

Plenty of enterprises keep record creation human-gated. Then the deliverable is a request to the DNS team (usually via platform), and the difference between a same-day record and a week of back-and-forth is arriving with a complete spec:

```text
Request: new DNS A record (production)
Name:        orders.apps.company.com
Type/Target: A → 10.50.8.20 (F5 VIP "vip-k8s-prod-web" — NOT the MetalLB IP)
TTL:         300
Owner:       team-orders (orders-oncall@company.com)
Purpose:     customer-facing orders API, fronted by prod cluster A
Decommission review: 2027-Q3
```

Name, target, TTL, owner, purpose, review date. The target is the one that burns people: **give them the appliance VIP, not the MetalLB address**, unless you have explicitly decided this name should bypass the front door.

## TTL strategy: failover time vs query load

A record's TTL is a contract about staleness: no client is obliged to notice a change faster than the TTL. The classic tension — low TTL for fast failover, high TTL to spare resolvers — mostly dissolves in the appliance-fronted topology, because of where change actually happens:

- The **corporate record → VIP** binding is nearly immortal. VIPs don't move during deploys, scaling, node drains, or even most disasters.
- Change happens in the **pool behind the VIP** (MetalLB IPs, pod churn) — and pool membership updates are appliance-side, **invisible to DNS, effective in seconds regardless of any TTL**.

So in this topology, aggressive app-record TTLs (30 s) buy little and cost real query volume; **300 s is a sensible default for app records pointing at a stable VIP**. Reserve genuinely low TTLs for the specific link that implements failover — a GSLB steering CNAME flipping between datacenters — and for records you know you'll repoint soon (migrations).

Then remember the caching stack above DNS, because your *effective* failover time is the sum of the layers:

```text
corporate record TTL (300 s)
  + CoreDNS cache (≤30 s)                    ← platform's cap
  + your runtime's resolver cache            ← YOURS
```

The runtime layer is the one app teams forget. The JVM historically cached successful lookups **forever** under a security manager and still defaults to long-lived caching unless `networkaddress.cache.ttl` is set — a 30-second DNS TTL is theater if your JVM holds the answer for the process lifetime ([JVM–Kubernetes coupling](/java/jvm-kubernetes-coupling/) covers the setting). .NET's `HttpClient` has the inverse problem: it caches *connections*, not DNS, so a pooled connection outlives any record change until `PooledConnectionLifetime` recycles it ([ASP.NET Core on K8s](/dotnet/aspnetcore-on-k8s/)); the same connection-outlives-the-answer dynamic applies to any [long-lived connection](/networking/long-lived-connections/).

Put numbers on it before an incident does. If a dependency you call fails over by repointing its record, your worst-case time to follow it:

| Layer | Typical value | Who tunes it |
|---|---|---|
| Corporate record TTL | 300 s | DNS team (per record request) |
| CoreDNS cache cap | 30 s | Platform (Corefile `cache`) |
| JVM `networkaddress.cache.ttl` | unset → effectively ∞ on some setups | **You** |
| .NET `PooledConnectionLifetime` | unset → connection never recycled | **You** |

The two rows you own are the ones that turn "5.5 minutes" into "until the next deploy." Set them.

## Split-horizon, honestly

Split-horizon DNS is the same name returning **different answers depending on who's asking**. In this architecture it's structural, not exotic: a pod's query for `orders.company.com` goes CoreDNS → corporate resolvers, and corporate resolvers themselves often serve different views to different source networks. Sometimes the split is a design tool; sometimes it's a bug you haven't found yet. Know which one you have.

### Deliberate: the hairpin problem and its fixes

A pod calls the app's own public name — `orders.company.com` — maybe because a shared config or an OAuth redirect URI says so. Corporate DNS answers with the F5 VIP, so the request leaves the cluster, hairpins through the appliance, and comes back in to a pod possibly three feet away:

```text
pod → node egress → F5 VIP → MetalLB IP → kube-proxy → pod
```

Costs: appliance load and connection-table pressure from traffic that never needed to leave; an extra failure domain in every "internal" call; source-IP mangling that confuses allow-lists; and latency. Sometimes hairpinning is *acceptable* — it exercises the same path external users take (a canary argument), and TLS certs validate naturally. But at volume, the standard fix is a **deliberate split-horizon override inside the cluster**: make CoreDNS answer the public name with an internal target. Two platform-side mechanisms, both Corefile changes to [ask for](/operations/working-with-platform-team/):

```txt
rewrite name orders.company.com orders.myteam.svc.cluster.local   # rewrite plugin: alias to the Service
# — or —
hosts {                                                           # hosts plugin: pin specific answers
    10.96.44.7 orders.company.com
    fallthrough
}
```

([rewrite](https://coredns.io/plugins/rewrite/), [hosts](https://coredns.io/plugins/hosts/).) The rewrite form is the maintainable one — it tracks the Service rather than pinning an IP. Two caveats before you request it: your in-cluster clients must still pass TLS validation (the Service must present a cert covering `orders.company.com` — see the certificates paragraph below), and every such override is a divergence someone must remember exists. Keep an inventory.

### Accidental: the inverse decoder

Unplanned split-horizon announces itself as environment-dependent resolution. The decoder:

| Symptom | Likely cause |
|---|---|
| Resolves in pod, fails on laptop | Name only exists via a CoreDNS stub domain / rewrite; corporate DNS (your laptop's view) has no record. You built a name only the cluster can see. |
| Resolves on laptop, fails in pod | Laptop uses VPN resolvers with a view the node's resolvers don't get; or CoreDNS negative cache; or a missing stub domain for that zone |
| Same name, *different IPs* pod vs laptop | True split-horizon on the corporate side (internal vs external view) — possibly intended, verify with the DNS team |
| Works in cluster A's pods, not cluster B's | Stub domain or rewrite exists in one cluster's Corefile only — config drift |

The debugging move is always the same pair of commands, run in both places, compared field by field — `dig name` from a [netshoot pod](/networking/debugging-network/) and from your laptop, looking at answer, TTL, and which server responded:

```console
# From a pod:
$ dig partner-api.corp.example.com +short
10.20.6.88                              ;; SERVER: 10.96.0.10  (via CoreDNS stub domain)

# From your laptop, same minute:
$ dig partner-api.corp.example.com +short
                                        ;; status: NXDOMAIN  SERVER: 192.168.1.1
```

Different answers, different servers — now you know it's a view problem, not an app problem, and the ticket writes itself: both outputs, side by side, timestamped.

:::caution
Accidental split-horizon is worst in CI: build agents often run *outside* the cluster, so an integration test that resolves fine from pods can fail in the pipeline (or vice versa). If a name is load-bearing for tests, verify it resolves identically from both viewpoints before you blame the test.
:::

## Certificates and names, in one paragraph

TLS validates **names, not paths**: the certificate a client receives must carry a SAN matching the name *that client used*, no matter what NAT, VIPs, or rewrites sit in between. So the cert your Service or ingress presents must cover the corporate name external clients use (`orders.company.com`), the internal name pods use if you've done a split-horizon override (same name — convenient), and never needs to cover the MetalLB IP or any `cluster.local` form (which public CAs won't sign anyway, since `.local` isn't a real TLD). The practical failure: TLS terminating on the F5 with a corporate-name cert while the in-cluster hairpin fix sends pods straight to a Service presenting a self-signed or `cluster.local`-named cert — clients that worked via the appliance start failing validation on the "optimized" path. Decide the cert story *when* you decide the naming story, not after.

## The naming-review checklist

Eight questions to answer — in writing, in the ticket or the PR — before requesting any record for a new service:

1. **Who resolves this name?** External users, internal VMs, other pods, or some mix — this decides which authority owns it and whether you need an override for the in-cluster view.
2. **What's the target — appliance VIP or MetalLB IP?** Default is the VIP (the [front door](/architectures/front-door/)); bypassing it is a decision, not an accident.
3. **Wildcard-covered or explicit record?** If a wildcard already covers you, do you still need independent steerability for this app in prod?
4. **What TTL, and what's the *effective* failover time** once CoreDNS and runtime caches stack on top?
5. **Who owns the record** — team, contact, decommission date? Orphaned records are the corporate DNS team's rats' nest; don't add to it.
6. **Does the certificate cover this exact name** (and every other name clients will use, including any split-horizon variant)?
7. **Will pods call this name too?** If yes: accept the hairpin deliberately, or request the CoreDNS override — and note it in the runbook either way.
8. **Is the name environment-portable?** `orders.dev.company.com` → `orders.company.com` should be a config value, not a code change, when you promote.

If you can answer all eight, the record request writes itself — and more importantly, the name will still make sense in three years. For where these names fit in the full request path, start back at the [routing overview](/routing/overview/) and follow [the life of a request](/routing/life-of-a-request/) end to end.
