---
title: Local Development
description: Build a fast inner loop for Kubernetes apps with kind, Tilt, and mirrord when the only real cluster belongs to the platform team.
sidebar:
  order: 7
---

You own the app. The platform team owns the cluster. That arrangement works fine until you need to test whether your new readiness probe actually gates traffic, or whether your container survives a 512Mi limit — and your only option is pushing to CI, waiting eight minutes, and watching the dev namespace.

There's a better inner loop: a disposable cluster on your laptop for 90% of the work, and surgical tools for the 10% that only reproduces on the shared cluster.

:::tip[Want to be walked through it?]
The [Hands-On Labs](/labs/overview/) section does exactly this as a follow-along series: a k3s cluster on your Mac via Lima, a Spring Boot API built in Docker and shipped with a Helm chart you author, secrets and config wired every way, a Valkey backend, and ingress — every command copy-pasteable.
:::

## Why bother with a local cluster

Three reasons, in order of payoff:

1. **Manifest parity.** Your app doesn't just run code — it runs *inside* a Deployment with probes, limits, ConfigMaps, and Secrets. `docker run` tests none of that. A local cluster runs your actual YAML, so you find out that your liveness probe path returns 404 *before* the pipeline does.
2. **Fast iteration on the slow stuff.** Tuning [health checks](/workloads/health-checks/), [resource limits](/workloads/resources-and-qos/), and [configuration wiring](/workloads/configuration/) requires kill-and-observe cycles. Locally each cycle is seconds. Through CI it's minutes, and you're burning shared-namespace goodwill.
3. **Learning without fear.** You can `kubectl delete` anything, break the scheduler's heart, and rebuild the whole cluster in 60 seconds. Nobody files a ticket. This matters more than it sounds when you're [working without admin](/start/working-without-admin/) everywhere else.

### What local can't tell you

Be honest about the gaps, because they'll bite you if you assume parity where there is none:

- **Real ingress and load balancers.** Your local ingress controller (if any) is not the platform's. TLS termination, path rewriting, timeouts — all differ.
- **NetworkPolicies.** kind's default CNI (kindnet) does **not** enforce NetworkPolicy. Your app works locally, then can't reach the database in dev because a policy blocks it. Silence locally ≠ allowed in prod.
- **Storage classes.** Local provisioners hand out hostPath volumes that behave nothing like the platform's EBS/Ceph/whatever.
- **Admission webhooks and policies.** The platform's OPA/Kyverno/Pod Security rules only exist on their clusters. Your manifest can be perfectly valid locally and rejected in dev.

Test *those* things in your dev namespace, deliberately, and treat local as the place for everything else.

## Picking a local cluster

| Option | Startup | Multi-node | Registry story | Best for |
|---|---|---|---|---|
| **kind** | ~30s | Yes (config file) | `kind load docker-image` | Default choice; CI too |
| **minikube** | ~1min | Yes | `minikube image load` | Need addons (ingress, metrics-server) |
| **k3d** | ~15s | Yes | Built-in registry flag | Lightweight, registry-first workflows |
| **Docker Desktop** | Toggle | No | Shares Docker's image cache | Absolute basics, zero setup |

### kind — the default recommendation

Fast, disposable, and configured by a small file you commit to the repo:

```yaml
# kind-config.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: 30080   # NodePort your Service exposes
        hostPort: 8080
  - role: worker
```

```bash
kind create cluster --name myapp --config kind-config.yaml
```

```console
Creating cluster "myapp" ...
 ✓ Ensuring node image (kindest/node:v1.30.0) 🖼
 ✓ Preparing nodes 📦 📦
 ✓ Writing configuration 📜
 ✓ Starting control-plane 🕹️
 ✓ Joining worker nodes 🚜
Set kubectl context to "kind-myapp"
```

Nuke it with `kind delete cluster --name myapp`. That's the whole lifecycle.

### minikube

Heavier and slower to start, but the addon system is genuinely useful when you need cluster components you'd otherwise install by hand:

```bash
minikube start --memory 6g
minikube addons enable ingress
minikube addons enable metrics-server   # makes `kubectl top` work locally
```

### k3d

k3s (a slimmed Kubernetes) running in Docker. Fastest startup of the bunch, and it can spin up a local registry for you:

```bash
k3d cluster create myapp --registry-create myapp-registry:5000
```

### Docker Desktop

One checkbox in settings, and images built locally are just *there* — no loading step. But it's single-node, opaque when it breaks, and the reset button is your only repair tool. Fine for your first week; you'll outgrow it.

## Getting your image into the cluster

The rite of passage: you build `myapp:dev`, deploy, and get `ErrImagePull`. Your laptop's Docker daemon and the cluster's container runtime are **different worlds** — kind nodes are containers with their own containerd, and they've never heard of your image. (Full decision tree in [ImagePullBackOff](/troubleshooting/imagepullbackoff/).)

Three fixes:

```bash
# kind: copy the image into the node(s)
kind load docker-image myapp:dev --name myapp

# k3d equivalent
k3d image import myapp:dev --cluster myapp

# or run a local registry and push/pull like prod does
docker tag myapp:dev localhost:5000/myapp:dev && docker push localhost:5000/myapp:dev
```

:::caution[imagePullPolicy matters with loaded images]
A loaded image exists only inside the node — there's no registry to pull from. If your pod spec says `imagePullPolicy: Always` (the default for the `:latest` tag!), kubelet tries to pull, fails, and you're back in `ImagePullBackOff` even though the image is *right there*. Use a real tag and set `imagePullPolicy: IfNotPresent` in your local overlay. Never use `:latest` for local dev.
:::

## The inner loop

By hand, the cycle looks like this:

```bash
docker build -t myapp:dev .
kind load docker-image myapp:dev --name myapp
kubectl rollout restart deployment/myapp
kubectl rollout status deployment/myapp
```

That works, and you should do it manually a few times so you understand what the automation below is doing (and how it relates to what happens in the [life of a deployment](/start/life-of-a-deployment/)). Then automate it, because typing four commands per code change gets old by lunch.

### Tilt

Tilt watches your files and runs build→load→deploy automatically, with a live dashboard. A minimal `Tiltfile`:

```python
# Tiltfile
docker_build(
    'myapp:dev',
    context='.',
    live_update=[
        # sync compiled classes straight into the running container —
        # no image rebuild, no pod restart
        sync('build/classes/java/main', '/app/classes'),
    ],
)
k8s_yaml(kustomize('deploy/overlays/local'))
k8s_resource('myapp', port_forwards='8080:8080')
```

`tilt up`, and every save triggers the loop. The `live_update` block is the killer feature for JVM apps: run your container with an exploded classpath (`java -cp /app/classes:/app/libs/* ...` instead of a fat JAR), and Tilt syncs recompiled `.class` files into the live container in under a second.

### Skaffold

Same job, config-file flavor, and it doubles as a CI deploy tool:

```yaml
# skaffold.yaml
apiVersion: skaffold/v4beta11
kind: Config
build:
  artifacts:
    - image: myapp
      docker:
        dockerfile: Dockerfile
manifests:
  kustomize:
    paths: [deploy/overlays/local]
portForward:
  - resourceType: deployment
    resourceName: myapp
    port: 8080
```

`skaffold dev` watches, rebuilds, redeploys, and streams logs. It auto-detects kind/k3d and loads images for you.

:::tip[Pick one, don't collect both]
Tilt if you want the best interactive experience and hot-reload (`live_update` is more mature). Skaffold if your team wants one tool spanning local dev and CI deploys. Flipping a coin is also fine — switching later costs an afternoon, not a quarter.
:::

## When local can't reproduce it: the shared dev cluster

Some bugs only exist where the platform's ingress, policies, and real dependencies live. You still don't have to develop *blind* there.

**Port-forward dependencies to your laptop.** Run your app locally (bare process, full debugger), and pull the cluster's dependencies to you:

```bash
kubectl port-forward svc/postgres 5432:5432 -n team-dev &
kubectl port-forward svc/redis 6379:6379 -n team-dev &
```

Cheap, zero install, works with namespace-scoped access. Falls over when your app needs to *receive* traffic or resolve many in-cluster names.

**mirrord — the modern default.** mirrord runs your *local* process while impersonating a pod: it mirrors (or steals) the pod's incoming traffic, and gives your process the pod's environment variables, DNS resolution, and even file volumes. Basic use needs **no cluster-side installation** — it injects an agent into your namespace on demand, which your existing RBAC usually permits:

```bash
mirrord exec --target deployment/myapp -n team-dev -- ./gradlew bootRun
```

Your local JVM now sees `DATABASE_URL` from the pod, resolves `redis.team-dev.svc`, and receives a copy of real dev traffic — under your IDE's debugger.

**Telepresence** does full traffic *interception* (requests to the in-cluster Service route to your laptop), but it needs a cluster-side Traffic Manager installed — for you, that's a platform-team ask, not a `brew install`. Request it if mirrord's model doesn't fit; otherwise skip the ticket.

:::danger[Shared namespace etiquette]
Your dev namespace has teammates in it.

- **Label your experiments** (`kubectl label deploy myapp-spike owner=jane experiment=true`) so people know what's safe to delete — see [labels and namespaces](/start/yaml-labels-and-namespaces/).
- **Clean up** when you're done. Orphaned debug pods eat the namespace's resource quota.
- **Don't scale shared things down** to "free up room" or steal traffic. Intercepting a Service others are testing against ruins their afternoon; stealing traffic with mirrord `--steal` on a shared deployment doubly so.
:::

## Make local look like prod

The value of a local cluster is proportional to how closely it mirrors what CI deploys. The mechanism: **same base manifests, thin local overlay** (see [Helm and Kustomize](/operations/helm-and-kustomize/)):

```text
deploy/
├── base/                 # the real Deployment, Service, probes
└── overlays/
    ├── local/            # 1 replica, IfNotPresent, small limits
    ├── dev/
    └── prod/
```

Rules that pay for themselves:

- **Keep the probes.** If the local overlay deletes readiness/liveness probes "to make things easier," you've un-tested the thing local dev is best at testing.
- **Keep resource limits — scaled down, not removed.** A 256Mi limit locally catches the OOMKill that a limitless local pod hides until production. For JVM apps this is doubly true: heap sizing against container limits is exactly the failure class you want to hit on your laptop ([Resources and QoS](/workloads/resources-and-qos/), [JVM in containers](/java/jvm-in-containers/)).
- **Dependencies: pod vs testcontainers.** Run Postgres *as a pod in the local cluster* when you're testing the deployed system (service discovery, config wiring, network paths). Use testcontainers when you're writing integration *tests* — they belong to the test suite, not the cluster. Most teams end up with both, for different jobs.
- **Secrets: generate, never copy.** A `.env` file (gitignored) plus a kustomize `secretGenerator` gives you the same Secret *shape* as prod with throwaway values:

```yaml
# overlays/local/kustomization.yaml
secretGenerator:
  - name: myapp-secrets
    envs: [.env.local]
```

:::danger
Never load real production secrets into a local cluster. kind's state is an unencrypted container on your laptop, and `kubectl get secret -o yaml` is one shell-history entry away.
:::

## Java-specific notes

- **Debug the pod, not a simulation.** Add `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005` to the local overlay's JVM args, `kubectl port-forward deploy/myapp 5005:5005`, attach your IDE. Same technique works on the shared cluster — full walkthrough in [Remote debugging](/java/remote-debugging/).
- **JVM startup is your enemy in the inner loop.** A 40-second Spring Boot boot per iteration kills the whole point. Fixes, in escalating order: Tilt `live_update` syncing `build/classes` into an exploded-classpath container plus `spring-boot-devtools` (which restarts the application context, not the JVM, in ~2s); tiered compilation flags for faster boot (`-XX:TieredStopAtLevel=1` locally only); or run the app *outside* the cluster with mirrord when you're iterating on business logic rather than deployment shape.
- Keep dev-only dependencies like `spring-boot-devtools` out of the production image — `developmentOnly` scope in Gradle handles it.

## Choose your setup

| Scenario | Setup |
|---|---|
| Solo, learning Kubernetes | kind + manual build/load/restart loop; break things on purpose ([survival kit](/start/kubectl-survival-kit/) open in the other pane) |
| One app, 2 dependencies (db, cache) | kind + kustomize `local` overlay running deps as pods + Tilt with `live_update` |
| One microservice among 30 | Don't run 30 services locally. mirrord against the shared dev cluster; local kind only for manifest/probe/limit work on *your* service |
| Bug that only happens in the dev cluster | mirrord `--target` the affected deployment and debug your local process; port-forward + remote JDWP debug as fallback |

The pattern underneath all four rows: local clusters are for testing the *deployment shape* of your app fast and safely; the shared cluster is for the platform-specific behavior you can't fake. Use each for what it's actually good at, and stop paying the CI tax for either.
