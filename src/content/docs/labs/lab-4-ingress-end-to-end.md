---
title: "Lab 4: Ingress and the Full Path"
description: Install ingress-nginx on kind, route orders.localtest.me to your API, trace a request hop by hop, break readiness on purpose — then tear the whole lab stack down cleanly.
sidebar:
  order: 6
---

Everything you've built so far is reachable only through `kubectl port-forward` — a debugging tool wearing a front-door costume. In this final lab you give the system a real entrance: an **Ingress controller** routing `http://orders.localtest.me:8080` from your Mac's browser to a pod, through every layer in between. Then you'll trace that path hop by hop, stress it, break it, and — because every good lab ends clean — tear the whole stack down.

**What you'll have at the end:** `orders-api` served at a real hostname through ingress-nginx, a decoded access log proving each hop, a rolling restart survived with zero failed requests, one deliberately broken readiness probe diagnosed and reverted — and, if you choose, an empty laptop.

## Prerequisites

- [Lab 0](/labs/lab-0-cluster/) through [Lab 3](/labs/lab-3-backend-service/) completed: the kind cluster `labs`, releases `orders` (image `orders-api:0.3.0`) and `cache` in the `labs` namespace. Lab 0's `kind-labs.yaml` already did this lab's groundwork: hostPort 8080→containerPort 80 (and 8443→443) mapped on the node, and the node labeled `ingress-ready=true`.
- If you paused between sittings, revive everything (the last command should show `labs-control-plane … Ready`):

```bash
limactl start docker
export DOCKER_HOST="unix://$HOME/.lima/docker/sock/docker.sock"
kubectl get nodes
```

All commands run from `~/k8s-labs/`, with `kubectl` defaulting to the `labs` namespace.

## 1. Install ingress-nginx, the kind way

An Ingress *resource* is just routing rules; something has to read them and actually proxy traffic. That something is a controller, and the de facto standard is **ingress-nginx** — installed, like everything in these labs, via Helm. It needs a few kind-specific values, so write them down as a file (files beat `--set` flags: reviewable, repeatable, versionable).

`~/k8s-labs/values-ingress.yaml`:

```yaml
controller:
  hostPort:
    enabled: true          # bind :80/:443 directly on the node
  nodeSelector:
    ingress-ready: "true"  # land on the node with the kind port mappings
    kubernetes.io/os: linux
  service:
    type: ClusterIP        # default LoadBalancer would sit <pending> forever
  tolerations:             # kind's only node may be a tainted control plane
    - key: node-role.kubernetes.io/control-plane
      operator: Equal
      effect: NoSchedule
```

Install it into its own namespace — infrastructure and applications don't share:

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  -f values-ingress.yaml --wait
```

```console
NAME: ingress-nginx
NAMESPACE: ingress-nginx
STATUS: deployed
NOTES:
The ingress-nginx controller has been installed.
```

```bash
kubectl get pods -n ingress-nginx
```

```console
NAME                                        READY   STATUS    RESTARTS   AGE
ingress-nginx-controller-7d56585cd5-k4xzn   1/1     Running   0          45s
```

Be clear about *why* those values exist, because none of them belong in production. A kind "node" is a Docker container with no cloud around it, so there's no LoadBalancer implementation to hand the controller a public IP. The kind-documented workaround: the controller binds the node's ports 80/443 directly (`hostPort`), a `nodeSelector` pins it to the one node whose ports Lab 0 mapped out to your Mac, and the Service is demoted to ClusterIP so nothing waits on an external IP that will never come. In a real cluster the same controller sits behind a Service of type LoadBalancer, fed by MetalLB, a cloud provider, or a hardware appliance chain — that whole edge stack is mapped in [The Front Door](/architectures/front-door/) and [External Load Balancing](/networking/external-load-balancing/).

## 2. Give orders-api an Ingress

The Ingress belongs to the app, so it goes in the app's chart — values-driven like everything else there.

Append to `charts/orders-api/values.yaml`:

```yaml
ingress:
  enabled: true
  className: nginx
  host: orders.localtest.me
  proxyReadTimeout: "30"
```

New file `charts/orders-api/templates/ingress.yaml`:

```yaml
{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "orders-api.fullname" . }}
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: {{ .Values.ingress.proxyReadTimeout | quote }}
spec:
  ingressClassName: {{ .Values.ingress.className }}
  rules:
    - host: {{ .Values.ingress.host }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ include "orders-api.fullname" . }}
                port:
                  number: {{ .Values.service.port }}
```

:::note
The helper (`orders-api.fullname`) and `.Values.service.port` are the same ones every other template in your chart has used since Lab 1 — if you named yours differently, match your own chart. The `{{- if .Values.ingress.enabled }}` wrapper is the standard chart courtesy: consumers who front the app some other way set one value and the resource vanishes.
:::

The annotation is the teaching example, not a necessity: `proxy-read-timeout` tells *this controller* how long to wait for the upstream on *this route only*. Annotations are how ingress-nginx exposes its hundreds of nginx knobs per-Ingress — powerful, unvalidated (a typo is silently inert), and controller-specific. The catalog of ones that matter is in [ingress-nginx in Practice](/networking/ingress-nginx/); the portable Ingress model itself is in [Ingress and Routing](/networking/ingress-and-routing/).

Ship it and verify the resource:

```bash
helm upgrade orders charts/orders-api
kubectl get ingress
```

```console
NAME         CLASS   HOSTS                 ADDRESS   PORTS   AGE
orders-api   nginx   orders.localtest.me             80      10s
```

Now the moment the whole lab sequence has been building toward — from your Mac, no port-forward:

```bash
curl http://orders.localtest.me:8080/api/orders/1001
```

```console
{"id":"1001","item":"3x espresso beans","source":"cache"}
```

Two small mysteries in that URL deserve answers:

**Why does `orders.localtest.me` resolve at all?** `localtest.me` is a public DNS zone whose every subdomain resolves to `127.0.0.1`. Your Mac asks real DNS, gets loopback back, and connects to itself — no `/etc/hosts` editing, and you still exercise genuine host-based routing, because what matters to nginx is the `Host:` header `curl` sends.

**Why port 8080?** Count the hops: curl connects to `127.0.0.1:8080` → Lima forwards your Mac's 8080 into the VM → kind's `extraPortMappings` (Lab 0) forward the VM's 8080 to the node container's port 80 → the controller's `hostPort` owns node port 80 → nginx matches the `Host` header against your Ingress rule → proxies to Service `orders-api` → which forwards to a pod on 8080. Three of those hops (Lima, kind mapping, hostPort) exist only because this is a laptop; the last three (controller → Service → pod) are exactly production. The unabridged version of this trace — conntrack, iptables, and all — is [Life of a Request](/routing/life-of-a-request/).

## 3. Watch the path work

First, confirm the controller resolved your backends:

```bash
kubectl describe ingress orders-api
```

```console
Name:             orders-api
Namespace:        labs
Ingress Class:    nginx
Rules:
  Host                 Path  Backends
  ----                 ----  --------
  orders.localtest.me  /     orders-api:8080 (10.244.0.19:8080)
Annotations:           nginx.ingress.kubernetes.io/proxy-read-timeout: 30
Events:
  Type    Reason  Age   From                      Message
  ----    ------  ----  ----                      -------
  Normal  Sync    2m    nginx-ingress-controller  Scheduled for sync
```

The `Backends` column is the health check that matters: the Service name resolved to actual **pod IPs**. `<none>` or `<error>` there means the Service name or port in your template doesn't match reality — the number one Ingress typo.

Now watch a request land. In one terminal, tail the controller; in another, run the curl again:

```bash
kubectl logs -n ingress-nginx deploy/ingress-nginx-controller --tail=1 -f
```

```console
192.168.5.2 - - [03/Jul/2026:14:21:07 +0000] "GET /api/orders/1001 HTTP/1.1" 200 57 "-" "curl/8.7.1" 87 0.004 [labs-orders-api-8080] [] 10.244.0.19:8080 57 0.004 200 f3a9c2…
```

That access-log line is worth decoding once in your life, left to right: client IP (Lima's forwarder, not your Mac — a preview of the real-world "where did the client IP go" problem), the request and its **status 200**, response bytes, user agent, request bytes, **total request time (0.004s)**, `[namespace-service-port]` — the upstream nginx chose, then the **pod IP it proxied to**, the upstream's bytes, the **upstream response time**, upstream status, and the request ID. Total time vs upstream time is the two-second 502 triage: if they diverge, the delay is in nginx or the connection to the pod; if they match, your app is just slow.

## 4. Probes under fire

The point of readiness probes plus a Service is that pods can die mid-traffic without anyone noticing. Prove it. First give the Deployment a partner, then start a request loop on your Mac:

```bash
helm upgrade orders charts/orders-api --set replicaCount=2 --reuse-values
kubectl rollout status deploy/orders-api
```

```bash
while true; do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://orders.localtest.me:8080/api/orders/1001)
  echo "$(date '+%H:%M:%S') $code"
  sleep 0.2
done
```

With the loop printing `200`s, kill one pod in a second terminal:

```bash
kubectl get pods
kubectl delete pod <one-of-the-orders-api-pod-names>
```

```console
14:32:10 200
14:32:10 200   ← pod deleted around here
14:32:11 200
14:32:11 200
```

Zero non-200s. That's not luck — it's the readiness probe (dying pod leaves the endpoint list before nginx sends it anything) and graceful shutdown working together, while the survivor absorbs the traffic. If you *do* see a stray 502, you've found the gap this drill exists to reveal — the preStop/termination choreography in [Zero-Downtime Deployments](/architectures/zero-downtime/) closes it.

Now break it deliberately, because someday a bad readiness path will ship and you should recognize the blast pattern. Point the probe at a URL that 404s (the values key is the probe block you created in Lab 1 — adjust if yours differs):

```bash
helm upgrade orders charts/orders-api --reuse-values \
  --set probes.readiness.path=/definitely-not-here
kubectl get pods -w
```

```console
orders-api-8c6f7d9b4-p2x8n   0/1   Running   0   30s
orders-api-8c6f7d9b4-w7k3m   0/1   Running   0   12s
```

Watch the failure spread in order: new pods run but never turn `READY` (the probe 404s), the rollout stalls, and once no ready pods back the Service, the endpoint list drains and nginx has nowhere to send traffic:

```bash
kubectl get endpoints orders-api
```

```console
NAME         ENDPOINTS   AGE
orders-api   <none>      3d
```

Your curl loop is now printing `503` — nginx answers (the edge is fine!) but reports "no healthy upstream". This exact signature — Ingress fine, Service present, endpoints empty — is the most common "the site is down" shape in Kubernetes, and the diagnosis walk lives in [Service Unreachable](/troubleshooting/service-unreachable/) with the probe theory in [Health Checks](/workloads/health-checks/). Notice what *didn't* happen: the old ReplicaSet's pods were failing the same new probe, so this config change took out running pods too — readiness changes are not "safe because rolling".

Revert with the tool built for exactly this:

```bash
helm rollback orders
kubectl get endpoints orders-api
```

```console
Rollback was a success! Happy Helming!
NAME         ENDPOINTS                           AGE
orders-api   10.244.0.19:8080,10.244.0.23:8080   3d
```

The curl loop returns to `200`s. Stop it with `Ctrl-C`.

## 5. The full-stack tour

You've now built and touched every hop a request crosses. One table, from your keyboard to the cache, with the reference that owns each layer:

| Hop | What happens | Deep dive |
|---|---|---|
| `curl` → `orders.localtest.me` | Public DNS returns 127.0.0.1; Lima + kind mappings carry :8080 to the node's :80 | [Lab 0](/labs/lab-0-cluster/) |
| nginx matches `Host` + path | Ingress rules, classes, annotations | [ingress-nginx](/networking/ingress-nginx/), [Ingress and Routing](/networking/ingress-and-routing/) |
| nginx → Service `orders-api` | Endpoints, kube-proxy, virtual IPs | [Services Deep Dive](/networking/services-deep-dive/) |
| Service → a ready pod | Readiness gates membership; probes decide | [Health Checks](/workloads/health-checks/) |
| App boots with its config | env + Secret + ConfigMap files, checksum rollouts | [Configuration](/workloads/configuration/), Lab 2 |
| App → `cache-valkey` by name | Cluster DNS resolves Services | [DNS](/networking/dns/), Lab 3 |
| Valkey answers | The backend you authored a chart for | [Valkey and Redis](/stateful/valkey-and-redis/) |

If every row makes you nod rather than squint, the labs did their job.

## 6. Full teardown

The lab stack peels off in layers, and it's worth knowing what each command actually removes:

```bash
helm uninstall orders cache
helm uninstall ingress-nginx -n ingress-nginx
```

```console
release "orders" uninstalled
release "cache" uninstalled
release "ingress-nginx" uninstalled
```

Uninstalling releases deletes the Kubernetes resources Helm created — Deployments, Services, the Ingress — but not things you made by hand (`kubectl get secret cache-auth` still answers; `kubectl delete secret cache-auth` if you're being thorough). The cluster itself is untouched.

```bash
kind delete cluster --name labs
```

```console
Deleting cluster "labs" ...
Deleted nodes: ["labs-control-plane"]
```

That removes the node container, every image you `kind load`-ed into it, and the `labs` context from your kubeconfig. The Lima VM and your local Docker images (`orders-api:0.1.0`–`0.3.0`) remain.

```bash
limactl stop docker      # pause: VM off, disk kept — restart anytime
limactl delete docker    # remove: VM and its disk, including all Docker images
```

`stop` is the "see you next weekend" option; `delete` is final. The only thing left after `delete` is `~/k8s-labs/` — your source, charts, and values files. Keep it: it's the artifact the whole sequence exists to produce. (`rm -rf ~/k8s-labs` if you truly want zero trace, as promised in the [overview](/labs/overview/).)

Or keep the cluster running — it costs a few GB of RAM and makes a fine scratchpad for everything else on this site.

## 7. Where to go next

You've graduated from the labs; here's where the reference sections pick up the exact threads you're holding:

- **[The Golden Service](/architectures/golden-service/)** — the production version of this precise app: same shape (API + backing service + ingress), now with resource governance, PDBs, autoscaling, and observability. You'll recognize every block.
- **[Zero-Downtime Deployments](/architectures/zero-downtime/)** — the drill you half-did in step 4, completed: preStop hooks, terminationGracePeriod, connection draining, and the proof-loop methodology at production scale.
- **[Sizing Walkthrough](/tuning/sizing-walkthrough/)** — the requests and limits you copy-pasted in these labs, actually derived: how to right-size the very JVM service you just built.
- **[CI/CD Pipeline Design](/operations/cicd-pipeline-design/)** — everything you did by hand (build, tag, load, `helm upgrade`, rollback) is a pipeline stage; this is how teams automate the loop you now understand from the inside.

:::caution
**Troubleshooting box**

- **404 from nginx** (`404 Not Found` with a `nginx` server header) — the controller answered but matched no rule. Either the `Host` header doesn't say `orders.localtest.me` (curling by IP? a typo'd hostname?) or the Ingress wasn't adopted: check `kubectl get ingress` shows CLASS `nginx` and that `ingressClassName` made it into the rendered manifest (`helm get manifest orders`).
- **Connection refused on 8080** — the path from Mac to node is broken, not Kubernetes. Is the Lima VM running (`limactl list`)? Was the cluster created from Lab 0's `kind-labs.yaml` with the `extraPortMappings`? `docker ps` (with `DOCKER_HOST` exported) should show the kind node publishing `0.0.0.0:8080->80/tcp`. If the mapping is missing, the fix is unfortunately a cluster recreate — the mapping is set at `kind create cluster` time.
- **ingress-nginx pod `Pending`** — the `nodeSelector` matched no node. `kubectl get nodes --show-labels | grep ingress-ready` should show the label from Lab 0's config; if it's absent, `kubectl label node labs-control-plane ingress-ready=true` and the pod schedules immediately.
- **503 from nginx** — the edge is fine, the backends are gone. Straight to step 4's diagnosis: `kubectl get endpoints orders-api`, then [Service Unreachable](/troubleshooting/service-unreachable/).
:::

## Where you are now

Nothing, if you tore it down — and that's the right ending. You built a cluster from a config file, shipped a service through four versions of a chart you wrote, wired in a backend by DNS name, put a real front door on it, watched a request cross seven layers, and removed it all without a trace. Every piece of that will reappear in your first production cluster, larger and with pager stakes — but the shape is now yours.
