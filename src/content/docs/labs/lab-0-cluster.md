---
title: "Lab 0: A Cluster on Your Mac"
description: Build the lab foundation — CLI tools via Homebrew, a Lima VM running dockerd for builds, a second Lima VM running k3s as the cluster, and a smoke-tested labs namespace.
keywords:
  - set up a local kubernetes cluster on mac
  - install lima and k3s
  - run kubernetes without docker desktop
  - configure kubeconfig and point kubectl at the cluster
  - docker cli talking to a lima vm over a socket
  - install kubectl helm docker with homebrew
  - create and default the labs namespace
  - smoke test a pod on k3s
  - pause and tear down a local cluster
sidebar:
  order: 2
---

Every subsequent lab deploys onto the cluster you build here, so this lab is pure foundation: install the CLI tools, start a Linux VM that runs Docker, start a second Linux VM that runs Kubernetes, and prove the whole stack works end to end. No application code yet — that starts in Lab 1.

**What you'll have at the end:** a single-node k3s cluster running in a Lima VM named `k3s`, a second Lima VM named `docker` whose daemon builds your images, `kubectl` and `helm` wired to the cluster through `KUBECONFIG`, a `labs` namespace set as your context default, and a passing smoke test for docker, kubectl, and helm.

## Prerequisites

- **macOS** with **Homebrew** installed (`brew --version` prints something).
- **Lima** installed. Verify:

```bash
limactl --version
```

```console
limactl version 1.0.6
```

If that fails, `brew install lima` first.

- Roughly **10 GB of free RAM** (each of the two VMs defaults to 4 CPUs / 4 GiB) and ~15 GB free disk.
- **No Docker Desktop needed.** These labs never touch it.

:::caution[Docker Desktop users]
If Docker Desktop is installed, it doesn't need to be uninstalled — but if it's *running*, you now have two Docker daemons on one machine, and whichever one your `docker` CLI talks to depends on `DOCKER_HOST` and context settings. Quit Docker Desktop for these labs. Step 3 sets `DOCKER_HOST` explicitly so the CLI always targets the Lima VM, but a running Desktop plus a half-configured shell is the classic source of "it built the image, but the cluster can't find it."
:::

Why this stack instead of Docker Desktop or minikube? See [Local Development](/start/local-development/) — short version: free, scriptable, and closest to how the pieces actually fit together.

## Step 1: Install the CLIs

```bash
brew install docker docker-buildx kubectl helm
```

```console
==> Installing docker
==> Installing docker-buildx
==> Installing kubectl
==> Installing helm
🍺  ...
```

One line here deserves attention: `brew install docker` installs the **Docker CLI only** — the `docker` command, a client program. It does *not* install a Docker daemon, because the daemon (`dockerd`) needs a Linux kernel and your Mac doesn't have one. The daemon is Step 2's job. `docker-buildx` is the CLI's modern build engine, packaged as a plugin — without it, `docker build` falls back to the deprecated legacy builder, which prints different output than these labs show and is being removed upstream. The other two are plain clients as well: `kubectl` and `helm` talk to a Kubernetes API server — Step 4 starts the VM that runs one. Nothing installed in this step runs anything by itself.

Verify the versions (yours may be newer; same major version is fine):

```bash
docker --version && kubectl version --client && helm version --short
```

```console
Docker version 27.4.0, build bde2b89
Client Version: v1.32.3
v3.17.2+gcc0f318
```

One wrinkle: Homebrew puts the buildx plugin where the `docker` CLI doesn't look by default, so tell it where. Create the Docker config directory and edit `~/.docker/config.json`:

```bash
mkdir -p ~/.docker
```

Make `~/.docker/config.json` contain (create the file if it doesn't exist):

```json
{
  "cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]
}
```

:::note[Intel Macs]
Homebrew lives under `/usr/local` on Intel Macs — use `"/usr/local/lib/docker/cli-plugins"` there instead.
:::

Verify the CLI now finds the plugin:

```bash
docker buildx version
```

```console
github.com/docker/buildx v0.20.1 5b03bb1
```

## Step 2: Start the Docker VM with Lima

Lima's job is to give your Mac the Linux kernel it lacks. The `docker` template boots a small Linux VM, installs `dockerd` inside it, and exposes the daemon's control socket back to macOS as a file under your home directory.

```bash
limactl start template://docker
```

:::note[First start takes a while]
The first run downloads a Linux image (~600 MB) and provisions the VM — allow **3–8 minutes** depending on your connection. Later starts (`limactl start docker`) take seconds.
:::

```console
? Creating an instance "docker" Proceed with the current configuration
INFO[0000] Starting the instance "docker" with VM driver "vz"
INFO[0032] [hostagent] Waiting for the essential requirement 1 of 2: "ssh"
INFO[0074] READY. Run `limactl shell docker` to open the shell.
INFO[0074] Message from the instance "docker":
To run `docker` on the host (assumes docker-cli is installed), run the following commands:
docker context create lima-docker --docker "host=unix:///Users/you/.lima/docker/sock/docker.sock"
...
```

If prompted with a configuration menu, accept **"Proceed with the current configuration"** — the labs assume the defaults. Note the instance is named `docker` (from the template name); every later Lima command uses that name.

Confirm it's running:

```bash
limactl list
```

```console
NAME      STATUS     SSH                VMTYPE    ARCH       CPUS    MEMORY    DISK      DIR
docker    Running    127.0.0.1:60022    vz        aarch64    4       4GiB      100GiB    ~/.lima/docker
```

`STATUS Running` is what you need. (`DISK 100GiB` is thin-provisioned — it only consumes what's used.)

## Step 3: Point the Docker CLI at the VM

Lima's final message suggested creating a docker *context*; we use the equivalent `DOCKER_HOST` environment variable instead — one line, survives context confusion, makes the client/server split explicit. Set it now and make it permanent (zsh is the macOS default; use `~/.bashrc` for bash):

```bash
export DOCKER_HOST="unix://$HOME/.lima/docker/sock/docker.sock"
echo 'export DOCKER_HOST="unix://$HOME/.lima/docker/sock/docker.sock"' >> ~/.zshrc
```

Now the teaching moment. Ask Docker to describe both halves of itself:

```bash
docker version
```

```console
Client:
 Version:           27.4.0
 OS/Arch:           darwin/arm64

Server: Docker Engine - Community
 Engine:
  Version:          27.4.1
  OS/Arch:          linux/arm64
```

Read those two `OS/Arch` lines carefully: the **client is `darwin`** (your Mac) and the **server is `linux`** (the Lima VM). Every `docker build` and `docker run` you type from now on is a macOS program sending API calls through that Unix socket to a daemon inside a Linux VM. This is exactly what Docker Desktop does too — it just doesn't show you. It's also the same client/server shape as `kubectl` talking to an API server, which is why understanding it now pays off in [How kubectl Works](/kubectl/how-kubectl-works/).

## Step 4: Start the k3s VM

Your Mac can now build images. It still has no Kubernetes — that's the second VM's job. Lima's `k3s` template boots another small Linux VM and installs **k3s** inside it:

```bash
limactl start template://k3s
```

:::note[First start takes a while]
Same story as Step 2: the first run downloads a Linux image and installs k3s — allow **3–8 minutes**. Later starts (`limactl start k3s`) take seconds.
:::

```console
? Creating an instance "k3s" Proceed with the current configuration
INFO[0000] Starting the instance "k3s" with VM driver "vz"
INFO[0031] [hostagent] Waiting for the essential requirement 1 of 2: "ssh"
INFO[0092] READY. Run `limactl shell k3s` to open the shell.
INFO[0092] Message from the instance "k3s":
To run `kubectl` on the host (assumes kubectl is installed), run the following commands:
export KUBECONFIG="/Users/you/.lima/k3s/copied-from-guest/kubeconfig.yaml"
kubectl ...
```

Accept **"Proceed with the current configuration"** again if prompted. That closing message is Step 5's whole job: Lima copied the cluster's admin kubeconfig out of the guest onto your Mac — you just have to point `kubectl` at it.

What's now running in that VM is not a toy or a simulator. **k3s** is a real, certified Kubernetes distribution that packages the entire control plane — API server, scheduler, controller manager, datastore — plus the kubelet into **one binary**, with containerd riding along as the runtime. It's what runs on production edge devices, in retail back rooms, and on physical on-prem servers where a full multi-node install would be overkill. One process inside one VM, but every component described in [How Kubernetes Works](/start/how-kubernetes-works/) is genuinely in there.

Confirm both VMs are up:

```bash
limactl list
```

```console
NAME      STATUS     SSH                VMTYPE    ARCH       CPUS    MEMORY    DISK      DIR
docker    Running    127.0.0.1:60022    vz        aarch64    4       4GiB      100GiB    ~/.lima/docker
k3s       Running    127.0.0.1:60023    vz        aarch64    4       4GiB      100GiB    ~/.lima/k3s
```

The full picture, one honest layer at a time:

```console
macOS (your laptop)
├── Lima VM "docker" — dockerd (builds your images)
└── Lima VM "k3s"    — k3s: control plane + kubelet + containerd (runs your cluster)
    └── your pods
```

Two VMs, one job each: images are built on the left and run on the right — and Lab 1 makes a point of how they travel across.

## Step 5: Point kubectl at the cluster

Step 3's move again, different CLI: `kubectl` reads the file named by `KUBECONFIG` to know which API server to talk to and how to authenticate. Point it at the file Lima copied out of the guest, and make it permanent:

```bash
export KUBECONFIG="$HOME/.lima/k3s/copied-from-guest/kubeconfig.yaml"
echo 'export KUBECONFIG="$HOME/.lima/k3s/copied-from-guest/kubeconfig.yaml"' >> ~/.zshrc
```

Your shell profile now carries two exports — `DOCKER_HOST` aiming `docker` at one VM, `KUBECONFIG` aiming `kubectl` at the other. Verify:

```bash
kubectl get nodes
```

```console
NAME       STATUS   ROLES                  AGE     VERSION
lima-k3s   Ready    control-plane,master   2m40s   v1.31.5+k3s1
```

One node, `Ready`, and a `VERSION` with `+k3s1` stapled onto the Kubernetes version — the k3s signature. That node is the whole cluster: control plane and worker in one.

## Step 6: Verify the cluster — and meet what k3s bundled

```bash
kubectl get nodes -o wide
```

```console
NAME       STATUS   ROLES                  AGE     VERSION        INTERNAL-IP    EXTERNAL-IP   OS-IMAGE             KERNEL-VERSION     CONTAINER-RUNTIME
lima-k3s   Ready    control-plane,master   3m10s   v1.31.5+k3s1   192.168.5.15   <none>        Ubuntu 24.04.1 LTS   6.8.0-51-generic   containerd://1.7.23-k3s2
```

`STATUS Ready` means the CNI installed and the kubelet is healthy. Now look at what came in the box:

```bash
kubectl get pods -n kube-system
```

```console
NAME                                      READY   STATUS      RESTARTS   AGE
coredns-ccb96694c-x7trd                   1/1     Running     0          3m
local-path-provisioner-5cf85fd84d-9hjts   1/1     Running     0          3m
metrics-server-5985cbc9d7-nl4q8           1/1     Running     0          3m
helm-install-traefik-crd-b2xn7            0/1     Completed   0          3m
helm-install-traefik-4kb9c                0/1     Completed   0          3m
svclb-traefik-8fd6db8f-tqzmk              2/2     Running     0          2m
traefik-57b79cf995-jgm4l                  1/1     Running     0          2m
```

:::note[k3s ships batteries]
Three of those are k3s add-ons you'd have to install yourself on a bare cluster: **Traefik**, a full ingress controller (Lab 4 has a decision to make about it); **ServiceLB** (the `svclb-*` pods), a minimal LoadBalancer implementation for clusters with no cloud around them; and the **local-path** StorageClass behind `local-path-provisioner`, which satisfies any PersistentVolumeClaim with a directory on the node's disk — the reason PVC experiments Just Work on this cluster. How provisioners like that operate is covered in [Storage Controllers](/controllers/storage-controllers/).
:::

## Step 7: Create and default the labs namespace

All lab workloads live in a `labs` namespace, made the context default so no lab command ever needs `-n labs`:

```bash
kubectl create namespace labs
kubectl config set-context --current --namespace=labs
```

```console
namespace/labs created
Context "default" modified.
```

(k3s names its context, cluster, and user all `default` — plain, but honest.) Confirm where you're pointed — the habit that prevents more incidents than any other (see the [kubectl Survival Kit](/start/kubectl-survival-kit/)):

```bash
kubectl config get-contexts
```

```console
CURRENT   NAME      CLUSTER   AUTHINFO   NAMESPACE
*         default   default   default    labs
```

One last piece of housekeeping — create the directory every later lab works from:

```bash
mkdir -p ~/k8s-labs
```

## Step 8: Smoke test — run a pod

Prove the full path: kubectl → API server → scheduler → kubelet → containerd → a running process.

```bash
kubectl run hello --image=busybox:1.37 --rm -it --restart=Never -- echo hello-from-the-vm
```

```console
hello-from-the-vm
pod "hello" deleted
```

That one line of output traveled from a container, inside a VM, to your terminal. `--rm --restart=Never` makes it a one-shot pod that cleans up after itself — a pattern you'll use constantly for in-cluster debugging (see [Busybox](/troubleshooting/busybox/)).

## Step 9: Helm sanity check

```bash
helm version && helm list
```

```console
version.BuildInfo{Version:"v3.17.2", GitCommit:"cc0f318", GitTreeState:"clean", GoVersion:"go1.23.7"}
NAME    NAMESPACE    REVISION    UPDATED    STATUS    CHART    APP VERSION
```

An empty list is the correct answer — `helm list` reads Release records from the current namespace (`labs`), and you haven't installed anything yet. Lab 1 fixes that. If you want to know what a Release actually is before then, start with the [Helm overview](/helm/overview/).

## Troubleshooting

:::caution[When output doesn't match]
**`Cannot connect to the Docker daemon at unix:///var/run/docker.sock`** — `DOCKER_HOST` isn't set in this shell. The CLI fell back to the default socket path, which doesn't exist on your Mac. Run the `export` from Step 3, and confirm it's in `~/.zshrc` for future shells (`echo $DOCKER_HOST` should print the Lima socket path).

**`docker: 'buildx' is not a docker command`** — the plugin directory isn't configured. Homebrew installs buildx to `/opt/homebrew/lib/docker/cli-plugins` (Intel Macs: `/usr/local/lib/docker/cli-plugins`), but the CLI only searches there if `~/.docker/config.json` lists that path under `cliPluginsExtraDirs`. Revisit Step 1, then confirm with `docker buildx version`.

**`Cannot connect to the Docker daemon at unix:///Users/you/.lima/docker/sock/docker.sock`** — `DOCKER_HOST` is set, but the `docker` VM is stopped (common after a reboot). Check `limactl list`; if `STATUS Stopped`, run `limactl start docker`. Your images and build cache come back with it.

**`The connection to the server localhost:8080 was refused`** (or kubectl answering about some *other* cluster) — `KUBECONFIG` isn't set in this shell, so kubectl fell back to `~/.kube/config`, which on a fresh Mac doesn't exist — and if you have older clusters configured, points at one of *them*. Run the export from Step 5, confirm it's in `~/.zshrc`, and check `kubectl config current-context` prints `default`.

**`dial tcp 127.0.0.1:6443: connect: connection refused`** — `KUBECONFIG` is right, but the `k3s` VM is stopped. Check `limactl list`; if `STATUS Stopped`, run `limactl start k3s`. The cluster and everything in it survive stops.

**Your Mac is crawling** — two VMs at 4 GiB each is a real bite out of a small machine. Close what you can, or `limactl stop docker` between builds — only the image-building steps need that VM; kubectl and helm talk exclusively to the `k3s` VM.

**Builds/images behave strangely and Docker Desktop is installed** — check `docker context ls` and `echo $DOCKER_HOST`. If Desktop is running, its context may win in shells where `DOCKER_HOST` isn't exported, so images land in the wrong daemon and Lab 1's image-import pipe streams the wrong (or a missing) image. Quit Docker Desktop, keep the Step 3 export, open a fresh terminal.

**Everything is broken and you're tired of debugging** — teardown below, then rerun this lab. Under fifteen minutes, nothing of value lost.
:::

## Pause or tear down

**Pausing between sittings** (keeps everything):

```bash
limactl stop docker && limactl stop k3s
```

Stopping the `k3s` VM stops the cluster with it; `limactl start k3s` brings both back, state intact. Stopping is **not** deleting — both VM disks and everything in the cluster survive.

**Full teardown** (removes the cluster — the VM *is* the cluster — keeps the docker VM and your built images for a fast rebuild):

```bash
limactl delete -f k3s
```

```console
INFO[0000] Stopping the instance "k3s"
INFO[0004] The instance "k3s" is deleted
```

**Scorched earth** (both VMs and all — only when you're done with the whole lab section):

```bash
limactl delete -f k3s && limactl delete -f docker && rm -rf ~/k8s-labs
```

## Where you are now

You have a real Kubernetes cluster — real API server, real scheduler, real kubelet — idling on your laptop, with a bundled ingress controller already running and a namespace waiting for workloads. In **Lab 1** you'll build the `orders-api` Spring Boot image entirely inside Docker (no Java toolchain required), stream it into this cluster, and write the Helm chart that deploys it.

If you want the theory to catch up with your fingers first: [How Kubernetes Works](/start/how-kubernetes-works/) explains what all those control-plane pieces were doing during Step 8, and [Local Development](/start/local-development/) compares this stack to the alternatives you didn't have to install.
