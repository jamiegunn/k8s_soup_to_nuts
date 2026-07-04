---
title: "Lab 0: A Cluster on Your Mac"
description: Build the lab foundation — CLI tools via Homebrew, a Lima VM running dockerd, a kind cluster with ingress-ready port mappings, and a smoke-tested labs namespace.
sidebar:
  order: 2
---

Every subsequent lab deploys onto the cluster you build here, so this lab is pure foundation: install four CLIs, start a Linux VM that runs Docker, create a kind cluster inside it, and prove the whole stack works end to end. No application code yet — that starts in Lab 1.

**What you'll have at the end:** a kind cluster named `labs` running inside a Lima VM, with port mappings and node labels pre-provisioned for Lab 4's ingress, a `labs` namespace set as your context default, and a passing smoke test for docker, kubectl, and helm.

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

- Roughly **8 GB of free RAM** (the VM defaults to 4 CPUs / 4 GiB) and ~15 GB free disk.
- **No Docker Desktop needed.** These labs never touch it.

:::caution[Docker Desktop users]
If Docker Desktop is installed, it doesn't need to be uninstalled — but if it's *running*, you now have two Docker daemons on one machine, and whichever one your `docker` CLI talks to depends on `DOCKER_HOST` and context settings. Quit Docker Desktop for these labs. Step 3 sets `DOCKER_HOST` explicitly so the CLI always targets the Lima VM, but a running Desktop plus a half-configured shell is the classic source of "it built the image, but kind can't find it."
:::

Why this stack instead of Docker Desktop or minikube? See [Local Development](/start/local-development/) — short version: free, scriptable, and closest to how the pieces actually fit together.

## Step 1: Install the CLIs

```bash
brew install docker kind kubectl helm
```

```console
==> Installing docker
==> Installing kind
==> Installing kubectl
==> Installing helm
🍺  ...
```

One line here deserves attention: `brew install docker` installs the **Docker CLI only** — the `docker` command, a client program. It does *not* install a Docker daemon, because the daemon (`dockerd`) needs a Linux kernel and your Mac doesn't have one. The daemon is Step 2's job. The other three are also plain clients: `kind` creates clusters by talking to a Docker daemon; `kubectl` and `helm` talk to a Kubernetes API server. Nothing installed in this step runs anything by itself.

Verify the versions (yours may be newer; same major version is fine):

```bash
docker --version && kind --version && kubectl version --client && helm version --short
```

```console
Docker version 27.4.0, build bde2b89
kind version 0.27.0
Client Version: v1.32.3
v3.17.2+gcc0f318
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

## Step 4: Write the kind cluster config

Create the lab directory and the cluster config. This file front-loads two things Lab 4 needs (ingress port mappings and a node label), so you never have to recreate the cluster mid-sequence.

```bash
mkdir -p ~/k8s-labs && cd ~/k8s-labs
```

**`~/k8s-labs/kind-labs.yaml`** — create with the editor of your choice:

```yaml
# ~/k8s-labs/kind-labs.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - containerPort: 80
        hostPort: 8080
        protocol: TCP
      - containerPort: 443
        hostPort: 8443
        protocol: TCP
```

Line by line:

- `kind: Cluster` / `apiVersion` — this is kind's own config format, not a Kubernetes manifest.
- `role: control-plane` — a single node that runs both the control plane and your workloads. One node is plenty for the labs.
- `kubeadmConfigPatches` — injects extra kubelet arguments at cluster bootstrap; here it stamps the label `ingress-ready=true` onto the node.
- `node-labels: "ingress-ready=true"` — the label ingress-nginx's kind deployment uses as a node selector, so the controller lands on the node that has the port mappings (Lab 4).
- `extraPortMappings` — publishes ports from the node container to the host, exactly like `docker run -p`. Port **8080 on your Mac → 80 in the node**, and **8443 → 443**. We use 8080/8443 instead of 80/443 to avoid privileged ports and collisions.

This is the standard kind-ingress recipe; you'll see it verbatim in kind's own docs.

## Step 5: Create the cluster

```bash
kind create cluster --name labs --config kind-labs.yaml
```

```console
Creating cluster "labs" ...
 ✓ Ensuring node image (kindest/node:v1.32.2) 🖼
 ✓ Preparing nodes 📦
 ✓ Writing configuration 📜
 ✓ Starting control-plane 🕹️
 ✓ Installing CNI 🔌
 ✓ Installing StorageClass 💾
Set kubectl context to "kind-labs"
Have a nice day! 👋
```

(The first run pulls the ~900 MB `kindest/node` image; expect a couple of minutes. Reruns are ~30 seconds.) What just happened: kind asked the Docker daemon to start **one container** that *pretends to be a machine*. Inside that container run systemd, a kubelet, containerd, and the entire Kubernetes control plane — API server, etcd, scheduler, controller manager. Your pods will be containers *inside* that container. The full nesting:

```console
macOS (your laptop)
└── Lima VM (Linux, runs dockerd)
    └── "labs-control-plane" container (the kind "node")
        └── your pods (containers inside the node)
```

Turtles all the way down — but each layer does an honest job, and the Kubernetes components inside are the real ones described in [How Kubernetes Works](/start/how-kubernetes-works/). kind also wrote credentials into `~/.kube/config` and switched your current context to `kind-labs`. See the "node" as the container it really is:

```bash
docker ps
```

```console
CONTAINER ID   IMAGE                  STATUS         PORTS                                                                     NAMES
1f2e3d4c5b6a   kindest/node:v1.32.2   Up 2 minutes   0.0.0.0:8080->80/tcp, 0.0.0.0:8443->443/tcp, 127.0.0.1:60101->6443/tcp   labs-control-plane
```

Note the `PORTS` column — your `extraPortMappings` from Step 4, live.

## Step 6: Verify the cluster

```bash
kubectl cluster-info
```

```console
Kubernetes control plane is running at https://127.0.0.1:60101
CoreDNS is running at https://127.0.0.1:60101/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy
```

```bash
kubectl get nodes -o wide
```

```console
NAME                 STATUS   ROLES           AGE     VERSION   INTERNAL-IP   EXTERNAL-IP   OS-IMAGE       KERNEL-VERSION    CONTAINER-RUNTIME
labs-control-plane   Ready    control-plane   2m14s   v1.32.2   172.18.0.2    <none>        Debian GNU/Linux 12 (bookworm)   6.8.0-generic     containerd://1.7.24
```

Check `STATUS Ready` (the CNI installed and the kubelet is healthy), then confirm the node label you baked in:

```bash
kubectl get node labs-control-plane -o jsonpath='{.metadata.labels.ingress-ready}{"\n"}'
```

```console
true
```

## Step 7: Create and default the labs namespace

All lab workloads live in a `labs` namespace, made the context default so no lab command ever needs `-n labs`:

```bash
kubectl create namespace labs
kubectl config set-context --current --namespace=labs
```

```console
namespace/labs created
Context "kind-labs" modified.
```

Confirm where you're pointed — the habit that prevents more incidents than any other (see the [kubectl Survival Kit](/start/kubectl-survival-kit/)):

```bash
kubectl config get-contexts
```

```console
CURRENT   NAME        CLUSTER     AUTHINFO    NAMESPACE
*         kind-labs   kind-labs   kind-labs   labs
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

That one line of output traveled from a container, inside a container, inside a VM, to your terminal. `--rm --restart=Never` makes it a one-shot pod that cleans up after itself — a pattern you'll use constantly for in-cluster debugging (see [Busybox](/troubleshooting/busybox/)).

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

**`Cannot connect to the Docker daemon at unix:///Users/you/.lima/docker/sock/docker.sock`** — `DOCKER_HOST` is set, but the Lima VM is stopped (common after a reboot). Check `limactl list`; if `STATUS Stopped`, run `limactl start docker`. Your kind cluster comes back with it — the node container restarts automatically.

**`kind create cluster` fails with `address already in use` on 8080 or 8443** — something on your Mac already owns that port (another dev server, a proxy). Find it with `lsof -nP -iTCP:8080 -sTCP:LISTEN` and stop it, or change `hostPort` in `kind-labs.yaml` — but if you change it, remember Lab 4's URL becomes `orders.localtest.me:<your-port>`.

**Builds/images behave strangely and Docker Desktop is installed** — check `docker context ls` and `echo $DOCKER_HOST`. If Desktop is running, its context may win in shells where `DOCKER_HOST` isn't exported, so images land in the wrong daemon and `kind load docker-image` can't find them. Quit Docker Desktop, keep the Step 3 export, open a fresh terminal.

**Everything is broken and you're tired of debugging** — teardown below, then rerun this lab. Under fifteen minutes, nothing of value lost.
:::

## Pause or tear down

**Pausing between sittings** (keeps everything):

```bash
limactl stop docker
```

Stopping the VM stops the cluster with it; `limactl start docker` brings both back, state intact. Stopping is **not** deleting — the VM disk, the node container, and everything in the cluster survive.

**Full teardown** (removes the cluster, keeps the VM for a fast rebuild):

```bash
kind delete cluster --name labs
```

```console
Deleting cluster "labs" ...
```

**Scorched earth** (VM and all — only when you're done with the whole lab section):

```bash
kind delete cluster --name labs && limactl delete docker && rm -rf ~/k8s-labs
```

## Where you are now

You have a real Kubernetes cluster — real API server, real scheduler, real kubelet — idling on your laptop, with ingress plumbing pre-installed and a namespace waiting for workloads. In **Lab 1** you'll build the `orders-api` Spring Boot image entirely inside Docker (no Java toolchain required), load it into this cluster, and write the Helm chart that deploys it.

If you want the theory to catch up with your fingers first: [How Kubernetes Works](/start/how-kubernetes-works/) explains what all those control-plane pieces were doing during Step 8, and [Local Development](/start/local-development/) compares this stack to the alternatives you didn't have to install.
