---
title: How kubectl Actually Works
description: What happens between pressing Enter and seeing output — kubeconfig anatomy, auth plugins, API discovery, verbosity debugging, and server-side vs client-side.
sidebar:
  order: 2
---

Every kubectl mystery — the hang, the browser popup, the `Forbidden`, the field that silently disappeared — is explainable once you know the pipeline. When you press Enter, kubectl does five things:

1. **Resolves config**: which cluster, which credentials, which namespace (kubeconfig).
2. **Authenticates**: cert, token, or an exec plugin that goes and *gets* a token.
3. **Discovers**: asks the API server what resources exist, to translate `deploy` into a URL.
4. **Sends HTTP**: one or more REST requests.
5. **Renders**: turns the JSON response into a table, YAML, or whatever `-o` asked for.

Failures at each stage look different. Let's walk the pipeline.

## Kubeconfig anatomy

Everything starts at `~/.kube/config` (or wherever `KUBECONFIG` points). It's YAML with three lists and one pointer:

```yaml
apiVersion: v1
kind: Config
clusters:                     # WHERE — API server endpoints
- name: prod
  cluster:
    server: https://api.prod.example.com:6443
    certificate-authority-data: LS0tLS1CRUdJTi...   # CA to trust
users:                        # WHO — credentials
- name: alice-prod
  user:
    exec:                     # more on exec plugins below
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: ["eks", "get-token", "--cluster-name", "prod"]
contexts:                     # WHERE + WHO + default namespace, bundled
- name: prod-team-a
  context:
    cluster: prod
    user: alice-prod
    namespace: team-a
current-context: prod-team-a  # the pointer: which context is active
```

A **context** is just a named triple: cluster + user + default namespace. `kubectl config use-context prod-team-a` does nothing but rewrite the `current-context` line. The commands worth memorizing:

```bash
kubectl config get-contexts            # list all, * marks current
kubectl config current-context         # print the pointer
kubectl config view --minify           # show only the active context's config
kubectl config set-context --current --namespace=team-a   # change default ns
```

### KUBECONFIG merging

`KUBECONFIG` is a colon-separated *list* of files, and kubectl merges them:

```bash
export KUBECONFIG=~/.kube/config:~/.kube/dev-cluster.yaml:~/.kube/prod.yaml
kubectl config get-contexts   # shows contexts from all three files
```

Merge rules that bite people:

- **First file wins on conflicts.** If two files define a context named `dev`, the one from the *earlier* file in the list is used. No warning is printed.
- **`current-context` comes from the first file that sets one.** Two terminals with different `KUBECONFIG` orderings can silently target different clusters.
- **Writes go to the file that defined the thing**, or the first file for new entries. `kubectl config use-context` can therefore modify a file you didn't expect.

```bash
# Merge many files into one portable config
KUBECONFIG=~/.kube/config:~/.kube/new.yaml kubectl config view --flatten > ~/.kube/merged
```

:::caution[Multi-cluster safety]
If you work with prod and non-prod configs, keep them in separate files and set `KUBECONFIG` per terminal instead of merging everything into one file. A fat merged config plus muscle memory is how staging deploys land in prod. More defensive habits in [Tips and Tricks](/kubectl/tips-and-tricks/).
:::

## Changing contexts

A **context** is simply a user-friendly label that maps a specific cluster API server (`cluster`) to specific credentials (`user`) and a default target namespace (`namespace`).

### 1. The standard built-in way
To switch your active context permanently (which modifies the `current-context` field in your active kubeconfig file):
```bash
# List all available contexts
kubectl config get-contexts

# Switch the active context
kubectl config use-context prod-team-a
```

### 2. Changing the default namespace
When you switch contexts, your commands target whatever `namespace` was defined in that context. If no namespace was set, it defaults to `default`. To change this default namespace for your *current* context:
```bash
kubectl config set-context --current --namespace=team-b
```

### 3. One-off overrides (the safest route)
For scripting, automation, or high-security actions, do not rely on your terminal's ambient context. You can override both the context and the namespace for a single command execution:
```bash
kubectl --context=prod-team-a -n team-b get pods
```

### 4. Interactive context switching
Typing `kubectl config use-context` is tedious and error-prone. Two popular CLI helpers solve this:
* **[kubectx](https://github.com/ahmetb/kubectx)**: Switch contexts with `kubectx <context-name>`. Running it with no arguments opens an interactive list.
* **[kubens](https://github.com/ahmetb/kubectx)**: Switch namespaces in the current context with `kubens <namespace-name>`.

If you prefer a native shell solution without installing external binaries, add these lightweight helpers to your shell profile (`~/.zshrc` or `~/.bashrc`) using [fzf](https://github.com/junegunn/fzf) for instant fuzzy matching:
```bash
# Switch contexts interactively via fzf
kctx() {
  local ctx
  ctx=$(kubectl config get-contexts -o name | fzf --height=40% --reverse)
  if [ -n "$ctx" ]; then
    kubectl config use-context "$ctx"
  fi
}

# Switch default namespaces interactively via fzf
kns() {
  local ns
  ns=$(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}' | tr ' ' '\n' | fzf --height=40% --reverse)
  if [ -n "$ns" ]; then
    kubectl config set-context --current --namespace="$ns"
  fi
}
```

## Importing new contexts

When a platform team provisions a new namespace, or you build a local cluster (e.g., k3s in a VM), you are handed a raw kubeconfig YAML file. You need to import this context into your local environment.

### Method 1: The merging and flattening workflow (recommended)
Rather than manually copy-pasting YAML blocks (which is prone to indentation errors), you can use `kubectl` to merge and flatten the configuration files.

Suppose you have your main config (`~/.kube/config`) and a new config file (`~/Downloads/dev-cluster.yaml`):

1. **Load both files temporarily in the `KUBECONFIG` variable:**
   ```bash
   export KUBECONFIG=~/.kube/config:~/Downloads/dev-cluster.yaml
   ```
2. **Flatten the combined configuration into a clean, unified config file:**
   ```bash
   kubectl config view --flatten > ~/.kube/config.new
   ```
3. **Replace your old config with the new merged config:**
   ```bash
   mv ~/.kube/config.new ~/.kube/config
   unset KUBECONFIG
   ```
This automatically merges all clusters, users, and contexts without duplicates.

### Method 2: Cloud provider CLIs
If you are using managed Kubernetes, cloud providers provide built-in command utilities to automatically fetch, merge, and import contexts into your default `~/.kube/config` file.

* **AWS (EKS):**
  ```bash
  aws eks update-kubeconfig --region us-west-2 --name my-eks-cluster --alias my-eks-context
  ```
* **GCP (GKE):**
  ```bash
  # Automatically appends the context to ~/.kube/config
  gcloud container clusters get-credentials my-gke-cluster --zone us-central1-a --project my-project-id
  ```
* **Azure (AKS):**
  ```bash
  az aks get-credentials --resource-group my-resource-group --name my-aks-cluster
  ```

### Method 3: Manual context assembly
If you only have raw endpoint URLs and credentials (such as a ServiceAccount token or a client cert) and want to construct a context from scratch:

```bash
# 1. Define the cluster endpoint and certificate authority
kubectl config set-cluster my-custom-cluster \
  --server=https://k8s-api.example.com:6443 \
  --certificate-authority=/path/to/ca.crt \
  --embed-certs=true

# 2. Add the user credentials (token-based example)
kubectl config set-credentials my-custom-user --token="kubeconfig-user-token-xxxxx"

# 3. Create the context binding the cluster and credentials together
kubectl config set-context my-custom-context \
  --cluster=my-custom-cluster \
  --user=my-custom-user \
  --namespace=my-default-namespace

# 4. Use the new context
kubectl config use-context my-custom-context
```

## Auth methods you'll actually meet

The `user` entry decides how kubectl proves who you are. Four flavors in the wild:

**Client certificates** (`client-certificate-data` / `client-key-data`): a TLS cert presented during the handshake. Common in kubeadm clusters and kind/minikube. Symptom of expiry: `x509: certificate has expired or is not yet valid` — nothing you run client-side will fix it; you need a re-issued cert.

**Static tokens** (`token:` field): a bearer token pasted into the config, often a ServiceAccount token someone exported. Works until it doesn't; expired tokens produce `Unauthorized` (401) — note that's different from `Forbidden` (403), which means *authenticated but not allowed*.

**OIDC**: kubectl (or a plugin like `kubelogin`) holds an ID token from your identity provider. This is the **"why did kubectl just open a browser?"** moment — your token expired, and the exec plugin launched an SSO flow to refresh it. That's normal. What's *not* normal is a headless CI job doing it: CI should use a ServiceAccount token, never a human's OIDC login.

**Exec plugins** — the managed-cloud standard. The kubeconfig doesn't contain a credential at all; it contains a *command to run*:

```yaml
user:
  exec:
    command: aws
    args: ["eks", "get-token", "--cluster-name", "prod"]
    # GKE: gke-gcloud-auth-plugin   |   AKS: kubelogin get-token
```

Every kubectl invocation runs that command, which mints a short-lived token. Consequences worth knowing:

- kubectl slow to start? Time the plugin: `time aws eks get-token --cluster-name prod`. A 3-second `kubectl get pods` is often a 2.9-second auth plugin.
- `Unauthorized` after lunch? Your cloud CLI session expired. Fix the *cloud* login (`aws sso login`, `gcloud auth login`, `az login`), not the kubeconfig.
- `exec: executable gke-gcloud-auth-plugin not found` — the plugin binary isn't on your PATH. Install it; kubectl can't auth without it.

## API discovery: how `get deploy` becomes a URL

kubectl doesn't hardcode resource types. It asks the server what exists:

```console
$ kubectl api-resources | head -8
NAME          SHORTNAMES   APIVERSION   NAMESPACED   KIND
bindings                   v1           true         Binding
configmaps    cm           v1           true         ConfigMap
endpoints     ep           v1           true         Endpoints
events        ev           v1           true         Event
pods          po           v1           true         Pod
secrets                    v1           true         Secret
services      svc          v1           true         Service

$ kubectl api-versions | grep apps
apps/v1
```

This table is how kubectl maps your shorthand to a REST path. `kubectl get deploy my-app -n team-a` resolves as:

- `deploy` → shortname for `deployments`, group `apps`, version `v1`, namespaced: true
- Therefore: `GET /apis/apps/v1/namespaces/team-a/deployments/my-app`

The URL grammar, worth internalizing:

```text
core group ("v1"):     /api/v1/namespaces/<ns>/<resource>[/<name>]
everything else:       /apis/<group>/<version>/namespaces/<ns>/<resource>[/<name>]
cluster-scoped:        /apis/<group>/<version>/<resource>[/<name>]
```

Short names (`po`, `svc`, `deploy`, `ing`) and **categories** come from the same discovery data. `kubectl get all` is not "all resources" — it's the resources that opted into the `all` category (pods, services, deployments, replicasets, statefulsets...). ConfigMaps, Secrets, Ingresses, and PVCs are *not* in it, which has surprised every engineer at least once.

Discovery is also why CRDs installed by the platform team "just work": the moment a CRD registers, it shows up in `api-resources` and kubectl can `get` it with zero client changes. See [CRDs Explained](/controllers/crds-explained/).

:::tip
Discovery results are cached in `~/.kube/cache/discovery/`. If a brand-new CRD gives `error: the server doesn't have a resource type "foo"`, the cache may be stale — it refreshes on its own (default ~10 min), or delete the cache dir to force it.
:::

## Watching the wire: `-v=6` and `-v=8`

This is the single best kubectl debugging tool, and it needs no permissions at all. `-v=6` logs each HTTP request, status, and latency:

```console
$ kubectl get pods -v=6 2>&1 | grep round_trippers
I0703 09:14:21.883210   41233 round_trippers.go:553] GET https://api.prod.example.com:6443/api/v1/namespaces/team-a/pods?limit=500 200 OK in 87 milliseconds
```

`-v=8` adds request/response bodies (truncated):

```console
$ kubectl get pod web-6d4cf56db6-x8rjp -v=8 2>&1 | grep -E 'GET|Response Body' | head -3
I0703 09:15:02.114532   41317 round_trippers.go:466] curl -v -XGET ... 'https://api.prod.example.com:6443/api/v1/namespaces/team-a/pods/web-6d4cf56db6-x8rjp'
I0703 09:15:02.201776   41317 round_trippers.go:553] GET https://api.prod.example.com:6443/api/v1/namespaces/team-a/pods/web-6d4cf56db6-x8rjp 200 OK in 86 milliseconds
I0703 09:15:02.202312   41317 request.go:1212] Response Body: {"kind":"Pod","apiVersion":"v1","metadata":{"name":"web-6d4cf56db6-x8rjp",...
```

What each level buys you:

- **`-v=6`** — the workhorse. Which URLs, which status codes, how slow. A "slow kubectl" splits instantly into slow auth plugin (long pause *before* the first request line) vs slow API server (big `in NNNN milliseconds`).
- **`-v=7`** — adds request headers (minus the auth token).
- **`-v=8`/`-v=9`** — full bodies. Use when the server is mutating or rejecting something and you need to see the exact payload. `-v=9` doesn't truncate.

Real diagnosis from the field: `kubectl get pods` taking 20 seconds. `-v=6` showed a happy 90 ms GET for pods... preceded by dozens of discovery GETs, several returning `503` from a broken aggregated API (a dead metrics adapter). Nothing wrong with our namespace at all — one screenful of `-v=6` output turned a vague complaint into a precise platform-team ticket.

## Direct API access: `kubectl get --raw`

Sometimes you want the API without the table rendering:

```bash
kubectl get --raw /apis | jq '.groups[].name' | head        # list API groups
kubectl get --raw /api/v1/namespaces/team-a/pods | jq '.items | length'
kubectl get --raw /apis/metrics.k8s.io/v1beta1/namespaces/team-a/pods \
  | jq '.items[] | {name: .metadata.name, cpu: .containers[0].usage.cpu}'
```

That last one is the raw form of `kubectl top pods` — handy when you want machine-readable numbers.

```console
$ kubectl get --raw /healthz
Error from server (Forbidden): forbidden: User "alice" cannot get path "/healthz"
```

Expected. `/healthz`, `/livez`, `/readyz`, `/metrics` on the API server are cluster-operator endpoints; namespace-scoped RBAC almost never grants them. A 403 here is your cluster working as designed, not a problem to fix.

## Server-side vs client-side: what runs where

Knowing which half of the system does what explains a lot of "why did that happen":

| Concern | Client (kubectl) | Server (API server) |
|---|---|---|
| Table rendering, `-o` formatting, JSONPath | ✔ | |
| Schema validation (unknown fields) | basic | ✔ authoritative |
| **Defaulting** (fills in `imagePullPolicy`, `strategy`, ...) | | ✔ |
| Admission webhooks, quotas, policies | | ✔ |
| RBAC | | ✔ |

The two dry-runs make the split concrete:

```bash
kubectl apply -f deploy.yaml --dry-run=client -o yaml   # local: parse + basic checks, no network needed
kubectl apply -f deploy.yaml --dry-run=server -o yaml   # full server pipeline, nothing persisted
```

- `--dry-run=client` catches YAML typos and obviously wrong structure. It will **not** catch a value an admission webhook would reject, and it won't show you defaulted fields.
- `--dry-run=server` runs validation, **defaulting** (the output comes back with every field the server would add — instructive to read once), and admission — it needs the same RBAC as the real write. It's the honest answer to "would this apply cleanly?"

This is also why a manifest that "worked with client dry-run" can still bomb in CI: only the server knows about the OPA policy requiring resource limits. See [Drift and CI/CD](/operations/drift-and-cicd/) for how this plays into pipelines.

## Version skew: does my kubectl match the cluster?

```console
$ kubectl version
Client Version: v1.31.2
Server Version: v1.29.8
WARNING: version difference between client (1.31) and server (1.29) exceeds the supported minor version skew of +/-1
```

The rule: **kubectl is supported within one minor version of the server, in either direction** (v1.30 client ↔ v1.29–v1.31 servers). Beyond that it usually still works, but you get subtle breakage: flags that don't exist server-side, output columns that changed, `kubectl explain` describing fields your server doesn't have. If you juggle clusters on different versions, keep multiple kubectl binaries (`kubectl-1.29`, `kubectl-1.31`) or use a version manager — it's a two-minute setup that ends a class of confusing bugs.

## `kubectl proxy`: borrow kubectl's auth

```console
$ kubectl proxy --port=8001 &
Starting to serve on 127.0.0.1:8001
$ curl -s localhost:8001/api/v1/namespaces/team-a/pods | jq '.items[0].metadata.name'
"web-6d4cf56db6-x8rjp"
```

The proxy listens on localhost, forwards to the API server, and injects your credentials — including running your exec plugin. Perfect for scripts and quick API exploration without token wrangling. It only grants what *you* already have; RBAC still applies to every request. Don't confuse it with `kubectl port-forward`, which tunnels to a pod, not the API.

## RBAC errors are just HTTP 403 with coordinates

Because every command is a request, every `Forbidden` names the exact tuple that was denied:

```console
$ kubectl get pods -n team-b
Error from server (Forbidden): pods is forbidden: User "alice" cannot list resource "pods" in API group "" in the namespace "team-b"
```

Read it as coordinates: **verb** `list`, **resource** `pods`, **group** `""` (core), **namespace** `team-b`. That's precisely the RoleBinding line you're missing, phrased in the language your platform team's RBAC manifests use. Check what you *can* do before filing the ticket:

```bash
kubectl auth can-i list pods -n team-b        # yes / no
kubectl auth can-i --list -n team-a           # everything you can do here
```

Full treatment — including why `get` can succeed while `list` fails, and how to write the access request that gets approved first try — in [RBAC Denied](/troubleshooting/rbac-denied/).

## The pipeline, one more time

Config → auth → discovery → HTTP → render. When kubectl misbehaves, locate the failing stage:

- Wrong cluster/namespace? **Config.** `kubectl config view --minify`.
- 401, browser popups, slow start? **Auth.** Time the exec plugin, refresh the cloud login.
- "no resource type"? **Discovery.** Check `api-resources`, consider stale cache.
- 403, 404, slow responses? **HTTP.** `-v=6` and read the actual request.
- Data present but ugly? **Render.** That's the next article: [Output and Queries](/kubectl/output-and-queries/).
