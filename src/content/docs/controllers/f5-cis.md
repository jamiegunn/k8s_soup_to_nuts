---
title: F5 CIS (Container Ingress Services)
description: How F5 CIS turns Kubernetes resources into BIG-IP configuration, the CRs you author to drive it, and the failure modes between your namespace and the VIP.
sidebar:
  order: 6
---

If your organization runs F5 BIG-IP appliances in front of the cluster, there's a good chance your external traffic path is programmed by **F5 Container Ingress Services (CIS)**: a controller pod that watches Kubernetes resources and pushes the equivalent configuration to BIG-IP as **AS3 declarations** (F5's declarative JSON config API). You write Kubernetes YAML; CIS translates it; BIG-IP does the actual load balancing, TLS, and VIP hosting.

:::note[It's CIS, not "F5 CSI"]
People constantly say "F5 CSI." CIS = **Container Ingress Services** — an ingress/traffic controller. CSI = Container **Storage** Interface, a completely unrelated storage plugin standard ([CSI Drivers](/controllers/csi-drivers/)). There is no F5 storage driver in this picture. If you search the wrong acronym you'll find nothing useful, and if you file a ticket with the wrong one you'll confuse the queue.
:::

The mental model matches everything else in this section: CIS is a [reconcile loop](/controllers/reconciliation/). Desired state = your Ingress/VirtualServer resources. Actual state = the BIG-IP's config. CIS diffs and pushes AS3 until they match.

## Three consumption models

How you *drive* CIS depends on how the platform team deployed it. Ask which mode you're in — the YAML differs completely.

**1. Ingress resources with F5 annotations.** Standard `Ingress` objects, with F5-specific behavior bolted on via annotations (`virtual-server.f5.com/ip`, health-monitor annotations, etc.). Portable-ish, but the interesting features hide in annotation strings with no schema validation — typos fail silently.

**2. F5 CRDs — the modern path.** CIS ships CRDs that model BIG-IP concepts natively:

- **VirtualServer** — an L7 HTTP(S) virtual server: host, TLS, path → pool routing.
- **TransportServer** — L4 TCP/UDP passthrough (databases, MQTT, anything non-HTTP).
- **TLSProfile** — where TLS terminates (edge/re-encrypt/passthrough) and which cert/profile.
- **Policy** — attach WAF, iRules, persistence and other BIG-IP profiles.

```yaml
apiVersion: cis.f5.com/v1
kind: VirtualServer
metadata:
  name: web-vs
  namespace: team-a
  labels:
    f5cr: "true"          # some deployments filter on a label — ask your platform team
spec:
  host: web.example.corp
  virtualServerAddress: 10.60.20.15   # from a platform-allocated range; or use IPAM
  tlsProfileName: web-tls
  pools:
    - path: /
      service: web
      servicePort: 8080
      monitor:
        type: http
        send: "GET /healthz HTTP/1.1\r\nHost: web.example.corp\r\n"
        interval: 5
        timeout: 16
```

`kubectl explain virtualserver.spec --recursive` shows the exact schema your cluster serves — trust it over vendor docs (see [CRDs Explained](/controllers/crds-explained/)).

For non-HTTP traffic, `TransportServer` is the same idea at L4 — no host routing, just VIP:port → pool:

```yaml
apiVersion: cis.f5.com/v1
kind: TransportServer
metadata:
  name: postgres-ts
  namespace: team-a
spec:
  virtualServerAddress: 10.60.20.16
  virtualServerPort: 5432
  mode: standard
  type: tcp
  pool:
    service: postgres-rw
    servicePort: 5432
    monitor:
      type: tcp
      interval: 10
      timeout: 31
```

Two practical notes on addresses: many installations pair CIS with **F5 IPAM**, in which case you set `ipamLabel: production` instead of a hardcoded `virtualServerAddress` and the address appears in the CR's status once allocated — same "read status for the answer" pattern as everywhere else. And two VirtualServers can share one address with different hosts (CIS merges them onto one BIG-IP virtual), which is how a team fits many hostnames onto one scarce VIP.

**3. ConfigMap with raw AS3.** A ConfigMap containing a full AS3 JSON declaration that CIS forwards nearly verbatim. Maximum power, zero abstraction; usually reserved for the platform team or legacy setups. If you inherit one, treat the JSON as production config with review discipline — one malformed declaration can affect every app in the same AS3 tenant.

## How pool members map to your pods

This is the detail that decides half the debugging outcomes. CIS runs in one of two pool-member modes:

- **Cluster mode:** BIG-IP pool members are **pod IPs** directly. Requires the BIG-IP to reach the pod network (routes or tunnels — platform plumbing). Traffic goes BIG-IP → pod, no NodePort hop, real per-pod health.
- **NodePort mode:** pool members are **node IPs on the Service's NodePort**. Simpler network-wise, but BIG-IP health-checks nodes rather than pods, and kube-proxy adds a hop and SNAT.

You can tell from your Service requirements: NodePort mode forces your Services to be `type: NodePort`; cluster mode works with plain ClusterIP. If your VirtualServer "does nothing" and your Service is ClusterIP in a NodePort-mode installation, that's the whole bug.

### Two health checks, two opinions

In cluster mode there are **two independent health systems**: Kubernetes readiness probes decide EndpointSlice membership (which pods CIS lists as pool members), and BIG-IP **monitors** decide which of those members receive traffic. They can disagree:

- Pod ready in k8s, but BIG-IP monitor failing → member marked down on the F5, no traffic, and *nothing in Kubernetes looks wrong*. Classic cause: the monitor's `send` string hits a path your app 404s, or the monitor checks `/` which redirects and the monitor doesn't follow.
- Keep them coherent: point the BIG-IP monitor at the same endpoint as your readinessProbe ([Health Checks](/workloads/health-checks/)).

## Failure modes and the evidence to gather

CIS itself runs in a platform namespace; its logs and the BIG-IP GUI are both out of your reach. Work the k8s-side evidence first.

### VirtualServer accepted, but no working VIP

```console
$ kubectl get virtualserver -n team-a
NAME     HOST               TLSPROFILENAME   HTTPTRAFFIC   IPADDRESS     IPAMLABEL   STATUS   AGE
web-vs   web.example.corp   web-tls                        10.60.20.15               ERROR    4m
```

Check, in order:

1. `kubectl describe virtualserver web-vs` — status message and Events. CIS writes validation failures here (bad TLSProfile reference, service not found, address conflicts).
2. Referenced objects exist and are exact: the `service` name, `servicePort` (number vs name mismatch is a favorite), the `TLSProfile` in the same namespace, the cert Secret the TLSProfile names.
3. Label filter: if CIS was deployed with `--custom-resource-label` style filtering, a CR missing the magic label is *silently ignored* — status stays empty forever, no events. Ask the platform team what label their CIS filters on; put it in your manifest templates.
4. Still nothing? The ask for the platform team is precise: *"CIS controller logs for namespace team-a, resource web-vs, around 14:32 UTC — did the AS3 POST succeed?"* AS3 declarations are applied transactionally per tenant/partition; a syntax error from one team's resource can make BIG-IP reject a whole declaration and strand everyone in that partition — a paste of the AS3 response code from the CIS log settles it in minutes.

### Pool members empty

VIP answers, but returns 503 / BIG-IP's "no pool members available" behavior.

1. **Selector chain:** `kubectl get endpointslices -l kubernetes.io/service-name=web` — if empty, your Service selector doesn't match pod labels, or zero pods are Ready. This is the number-one cause and it's entirely in your namespace ([Service Unreachable](/troubleshooting/service-unreachable/)).
2. **Readiness:** unready pods are excluded from EndpointSlices, hence from AS3, hence from the pool. A rollout where the new pods never go Ready empties the pool from BIG-IP's perspective.
3. **Monitor mismatch** (cluster mode): members present but marked down by the F5 monitor — see above. Evidence you can't gather yourself; describe the symptom ("pool members present per EndpointSlice, VIP 503s") and let the platform team read the member status on the BIG-IP.

### Stale AS3 config

You deleted or changed a resource, but BIG-IP still serves the old behavior. CIS pushes AS3 on changes and periodic verification; staleness usually means CIS is wedged, its connection/credentials to BIG-IP mgmt are broken, or an earlier bad declaration is blocking the queue. Your evidence: the CR's current YAML vs the observed behavior, timestamps of your change, and `generation` vs `observedGeneration`-style staleness if the CRD exposes it. Then escalate — nothing in your namespace can unstick the controller.

### Pre-escalation checklist

Ninety seconds, in your namespace, before any ticket:

```bash
kubectl get virtualserver,transportserver -n team-a          # STATUS column
kubectl describe virtualserver web-vs -n team-a              # status message + events
kubectl get svc web -o wide                                  # right type for the CIS mode?
kubectl get endpointslices -l kubernetes.io/service-name=web # non-empty? ready IPs?
kubectl get secret web-tls -o jsonpath='{.type}'             # kubernetes.io/tls, exists?
kubectl get events --sort-by=.lastTimestamp -n team-a | tail -20
```

If the CR status is happy, endpoints are populated, and the VIP still misbehaves, the problem is on the BIG-IP side of the wall — escalate with the outputs above plus a timestamp.

## Division of labor

| Layer | Owner |
|---|---|
| VirtualServer / TransportServer / TLSProfile / Ingress CRs, Services, cert Secrets in your namespace | **You** |
| CIS controller (deployment, mode, label filters, logs) | Platform |
| BIG-IP itself: VIP ranges, partitions/tenants, WAF policies, iRules, network reachability to pods | Platform (often a separate network/F5 team behind them) |

Requests that move fast name the layer: "please allocate a VirtualServer address from the 10.60.20.0/24 range for host `web.example.corp`, TLS edge-terminated, cert provided as Secret `web-tls` in namespace `team-a`" beats "we need F5 config" by about a week. General guidance: [Working with the Platform Team](/operations/working-with-platform-team/).

:::tip
Whatever consumption model you're on, keep the CRs in Git with the rest of your manifests. BIG-IP config drift is invisible from inside the cluster; your CRs being the single, versioned source of truth is what makes "what changed?" answerable during a traffic incident.
:::
