---
title: From the Lab to the Paved Road
description: Every move you made in the labs, mapped to its production equivalent — what the CI pipeline does for you now, which habits transfer intact, and which three you must unlearn before Monday.
keywords:
  - what changes moving from lab to production
  - docker build becomes a ci job
  - helm install becomes gitops or a pipeline
  - habits to unlearn in production
  - why kubectl apply to prod is dangerous
  - from laptop to real corporate cluster
  - imagepullsecret artifactory registry path
  - namespace quotas rbac and psa on monday
  - first week on the production cluster
  - which lab skills transfer to work
sidebar:
  order: 11
---

You finished the labs. On your laptop there is a real cluster, a chart you wrote from an empty directory, an image you built and streamed into containerd by hand, and a service answering in a real browser. Every one of those moves was correct — and on Monday, on the org's cluster, you will be allowed to make almost none of them.

That's not a demotion. It's the same system with the trust boundaries drawn where they belong. In the lab you played every role: developer, CI system, registry, release manager, platform team. In production those roles are split across pipelines, GitOps controllers, and an actual platform team — and your job shrinks to the part that was always yours: the code, the chart, and the values. This page maps each lab move to the thing that does it for you now, so the paved road feels like a translation of what you already know rather than a replacement for it.

The mental model in one sentence: **everything you did by hand in the labs still happens — it just happens inside a pipeline, on the record, with your git commit as the trigger instead of your Enter key.**

## The translation table

| You did in the lab | Production does instead | Deep dive |
|---|---|---|
| `docker build -t orders-api:0.1.0 app/` on your Mac | A CI build job builds the image from your commit | [GitHub Actions](/ci/github-actions/) |
| `docker save \| k3s ctr images import -` | CI pushes to Artifactory; the kubelet pulls with an `imagePullSecret` | [Artifactory](/ci/artifactory/) |
| `helm install orders charts/orders-api` from your terminal | The pipeline's deploy stage — or a GitOps controller syncing from git | [CI/CD Pipeline Design](/operations/cicd-pipeline-design/), [GitOps for Tenants](/operations/gitops-for-tenants/) |
| `kubectl create namespace labs`, cluster-admin everywhere | A platform-provisioned namespace with quotas, PSA labels, and scoped RBAC | [Working Without Admin](/start/working-without-admin/), [The Locked-Down Namespace](/architectures/locked-down-namespace/) |
| `kubectl create secret generic ...` (Lab 2) | The org's secret path — External Secrets, a vault integration, or a sealed pipeline step | [Secrets](/workloads/secrets/) |
| `http://orders.localtest.me:30080` via NodePort | A corporate VIP → load balancer → ingress controller → your Service | [The Front Door](/architectures/front-door/), [External Load Balancing](/networking/external-load-balancing/) |
| A five-file chart you authored solo | The org's chart template, values conventions, and shared workflows | [Authoring Best Practices](/helm/authoring-best-practices/), [Reusable Workflows](/ci/reusable-workflows/) |
| `requests: {cpu: 100m, memory: 384Mi}` typed on vibes | Requests and limits derived from measurement, enforced by quota | [Sizing Walkthrough](/tuning/sizing-walkthrough/) |

Eight rows. Let's walk them.

### `docker build` → the CI build job

```bash
# The lab move
docker build -t orders-api:0.1.0 app/
```

```yaml
# The paved-road equivalent: a job in .github/workflows/, triggered by push
jobs:
  build:
    uses: your-org/workflows/.github/workflows/docker-build.yaml@v3
    with:
      image: team-docker/orders-api   # tagged from the commit SHA, not by hand
```

In [Lab 1](/labs/lab-1-java-api/) you ran `docker build` and trusted your own terminal. In production, nobody trusts your terminal — including you, six months from now, when you can't remember which uncommitted change was in the image. The build moves into a CI job triggered by your commit: same Dockerfile, same multi-stage build, same layer-caching trick with `pom.xml` copied before `src`. Everything you learned about the Dockerfile transfers **verbatim**; what changes is *who* runs it and *what* the tag means. Lab tags were `0.1.0` bumped by hand; CI tags are derived from the commit or the release, so every image traces back to exact source. The anatomy of that job — checkout, build, test, push — is [GitHub Actions](/ci/github-actions/), and the reason your org's version is probably a shared `workflow_call` template rather than YAML you write yourself is [Reusable Workflows](/ci/reusable-workflows/).

### `docker save | ctr images import` → push to Artifactory

```bash
# The lab move — repeated after every rebuild, forgotten exactly once
docker save orders-api:0.1.0 | limactl shell k3s sudo k3s ctr images import -
```

```yaml
# The paved-road equivalent: CI pushes, the kubelet pulls
image:
  repository: artifactory.example.com/team-docker/orders-api
  tag: "1.4.2"          # set by the pipeline, traceable to a commit
imagePullSecrets:
  - name: artifactory-pull
```

The lab's strangest command — streaming a tarball into the cluster VM's containerd — existed because you had no registry. Production has one, and it is the *only* road into the cluster: CI pushes to Artifactory, the kubelet pulls from it, and an `imagePullSecret` in your namespace authenticates the pull. Three lab reflexes to update: `pullPolicy: IfNotPresent` was load-bearing for imported images and is merely sensible now; the image `repository` in your values becomes a fully qualified path like `artifactory.example.com/team-docker/orders-api`; and `ImagePullBackOff` stops meaning "you forgot the import pipe" and starts meaning a registry path, permission, or pull-secret problem — the triage lives in [ImagePullBackOff](/troubleshooting/imagepullbackoff/) and the registry mechanics in [Artifactory](/ci/artifactory/). There's likely also a base-image policy: that `eclipse-temurin:21-jre` line may need to become the org's blessed equivalent ([Supply Chain Security](/operations/supply-chain-security/)).

### `helm install` from your terminal → the deploy stage or GitOps

```bash
# The lab move
helm upgrade --install orders charts/orders-api

# The paved-road equivalent
git commit -m "orders-api: bump to 1.4.2" && git push   # ...and the machinery takes it from here
```

Here is the big one. In the lab, *you* were the deployment system: `helm install`, `helm upgrade`, `helm rollback`, all from your prompt. In production that role belongs to either the pipeline's deploy stage (which runs `helm upgrade --install` with credentials that aren't yours — [CI/CD Pipeline Design](/operations/cicd-pipeline-design/)) or a GitOps controller like Argo CD or Flux that continuously syncs the cluster to a git repo ([GitOps for Tenants](/operations/gitops-for-tenants/)). Either way, the trigger is a commit, not a command.

:::caution[Your muscle memory becomes read-only]
Every `kubectl` and `helm` skill from the labs still works in prod — as **inspection**. `helm get values`, `helm history`, `kubectl describe`, `kubectl logs`: use them daily. But the *mutating* verbs — `helm upgrade` from your laptop, `kubectl apply`, `kubectl edit` — now fight the machinery. Under GitOps your hand-edit is reverted within minutes; under a pipeline it silently diverges the cluster from what the next deploy will do, and the deploy "unfixes" your fix at the worst possible moment. The full failure catalog is [Drift and CI/CD](/operations/drift-and-cicd/) — read it before your first incident, because that's when the temptation peaks.
:::

The lab habit that transfers perfectly here: **render first, install second**. `helm template` before `helm install` becomes reading the pipeline's diff or the GitOps dry-run before merging. Same discipline, new location.

### The hand-created namespace → the provisioned one

```bash
# The lab move (you were cluster-admin; everything worked)
kubectl create namespace labs

# The paved-road equivalent: a ticket or a PR to the platform repo — and then
kubectl get resourcequota,limitrange -n your-namespace     # see what came pre-installed
kubectl get ns your-namespace -o jsonpath='{.metadata.labels}' | tr ',' '\n' | grep pod-security
```

Lab 0's `labs` namespace was empty and yours alone. The namespace you receive on Monday arrives pre-furnished: a ResourceQuota that caps total CPU and memory, a LimitRange that stamps defaults onto containers that don't specify their own, Pod Security Admission labels that will refuse pods running as root (your Lab 1 `USER 1001` line just paid for itself), possibly a default-deny NetworkPolicy, and RBAC that scopes you to this namespace and nothing beyond it. `kubectl get nodes` returns `Forbidden`, and that is the system working as designed. [Working Without Admin](/start/working-without-admin/) is the survival guide; [The Locked-Down Namespace](/architectures/locked-down-namespace/) shows the whole furniture set assembled and explains why each piece exists.

### `kubectl create secret` → the org's secret path

```bash
# The lab move — fine on a laptop, an audit finding in prod
kubectl create secret generic orders-secrets --from-literal=DB_PASSWORD='hunter2'
```

```yaml
# One common paved-road equivalent: an ExternalSecret the operator reconciles
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: orders-secrets
spec:
  secretStoreRef: {name: team-vault, kind: SecretStore}
  target: {name: orders-secrets}
  data:
    - secretKey: DB_PASSWORD
      remoteRef: {key: orders/db, property: password}
```

Lab 2 taught you what a Secret *is* and every way a pod can consume one — that knowledge is permanent. What changes is provenance: typing a secret at the command line puts credentials in your shell history and nowhere auditable, so orgs route secrets through a managed path — an External Secrets operator pulling from a vault, a CI-injected sealed secret, or similar. The consumption side (`envFrom`, volume mounts, Spring property binding) is untouched; only *creation* moves. Find your org's path in [Secrets](/workloads/secrets/) before you need it, because "how do I get a database password into the namespace" is guaranteed to be a week-one question.

### NodePort 30080 → the corporate VIP chain

```console
# The lab path (Lab 4)
browser → localhost:30080 (Lima forward) → NodePort 30080 → ingress-nginx → Service → pod

# The paved-road path
browser → orders.example.com (corporate DNS) → VIP on the load balancer
        → ingress controller (TLS terminates here or earlier) → Service → pod
```

Lab 4's `orders.localtest.me:30080` compressed the entire front door into one NodePort. Production unrolls it: a DNS name pointing at a corporate VIP, a hardware or cloud load balancer behind the VIP, an ingress controller behind that, then your Service, then your pods. The good news: the **Ingress resource you wrote is nearly identical** — host rule, path, backend Service. What changes is everything in front of it (owned by the platform team) plus TLS, which the lab skipped entirely and production will not. The whole chain, hop by hop, is [The Front Door](/architectures/front-door/); the load-balancer layer specifically is [External Load Balancing](/networking/external-load-balancing/). When a request dies somewhere in that chain, the lab's trace-the-hops method from Lab 4 is exactly the right instinct — just with more hops.

### Your chart → the org's conventions

```console
# The lab chart                        # The org's likely shape
charts/orders-api/                     deploy/
├── Chart.yaml                         ├── Chart.yaml        # depends on the org's library chart
├── values.yaml                        ├── values.yaml       # your app's knobs only
└── templates/                         ├── values-dev.yaml
    ├── _helpers.tpl                   └── values-prod.yaml
    ├── deployment.yaml                # templates/ mostly inherited — you own values, not YAML
    └── service.yaml
```

You authored five files from scratch, and that was the point: now you can *read* any chart. But the org probably doesn't want your artisanal chart — it wants your app expressed in *its* conventions: a shared library chart or template, standard label sets, values files per environment (`values-dev.yaml`, `values-prod.yaml`), naming rules that make `fullnameOverride` a conversation rather than a default. Adopting the template isn't a loss; it's the reason your app gets platform-team support and pipeline compatibility for free. [Authoring Best Practices](/helm/authoring-best-practices/) covers the conventions worth having; [Reusable Workflows](/ci/reusable-workflows/) covers the pipeline half of the same idea.

### Lab-sized resources → measured ones

```bash
# The paved-road reflex before setting any number: what is it actually using?
kubectl top pods -n your-namespace
kubectl get resourcequota -n your-namespace   # ...and how much room is left to bid
```

The lab's `requests: {cpu: 100m, memory: 384Mi}` were sensible defaults for a demo JVM on a laptop with no neighbors. In production, requests are a bid against a shared quota and the input to every scheduling and eviction decision — too low and you're throttled or OOMKilled, too high and you're squatting on quota your teammates need. The honest answer is measurement: run under representative load, read the actual usage, size from data. [Sizing Walkthrough](/tuning/sizing-walkthrough/) does exactly that, end to end, for a JVM service that looks suspiciously like `orders-api`.

## What stays exactly the same

Reread that table and notice what *isn't* in it. The parts of the labs that live inside the cluster boundary transfer to production without a single edit:

- **The debugging loop.** `kubectl describe` → `kubectl logs` → `kubectl get events` is the same on a 500-node prod cluster as it was on `lima-k3s`. The [triage methodology](/troubleshooting/triage-methodology/) you practiced when a lab step failed is precisely the production incident method — you've already done the reps.
- **Probe semantics.** Liveness still answers "restart me?", readiness still answers "send me traffic?", and the actuator endpoints on the management port are the same URLs the production kubelet polls. Everything Lab 1 taught you about probes is production knowledge, full stop ([Health Checks](/workloads/health-checks/)).
- **The chart mechanics.** Templates, values, helpers, `selectorLabels` kept minimal because selectors are immutable, `helm template` before anything — the org's chart is bigger than yours, but it's made of exactly the pieces you hand-built. You can now *read* it, which most people deploying with it cannot.
- **The objects themselves.** Deployments, Services, ConfigMaps, Secrets, Ingress, DNS-based service discovery — Lab 3's `cache` release found by name is the same mechanism your prod service uses to find its database. k3s wasn't a simulator, and nothing you learned needs unlearning at the API level.
- **Rollout behavior.** Surge, drain, readiness gating, `kubectl rollout status` — identical, just with more replicas and real traffic in flight ([Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/)).

The proof is that this sequence — the one you ran a dozen times across the labs — is a perfectly good first move on the production cluster, unchanged:

```bash
kubectl get pods                      # what's running?
kubectl describe pod <name>           # why is it in that state?
kubectl logs <name> --previous        # what did the last container say before it died?
kubectl get events --sort-by=.lastTimestamp | tail
helm history <release>                # what changed, and when?
```

If the first half of this page felt like a list of things being taken away, this half is the ledger balancing: the *understanding* was the expensive part, and you keep all of it.

## The three habits to unlearn

Three lab moves are actively dangerous in production. Name them now so you recognize the impulse later.

**1. `kubectl apply` (or `helm upgrade`) straight to prod.** In the lab, your terminal was the deployment system. In prod, applying by hand creates state that no pipeline knows about and no teammate can see. Under GitOps it's reverted; under a pipeline it lurks until the next deploy overwrites it — usually during the incident *caused* by the overwrite. The fix ships through git, every time, even when it's 2 a.m. and the change is one line. Especially then. ([Drift and CI/CD](/operations/drift-and-cicd/))

**2. `--set` in anger.** Lab 1 taught you the failure mode gently: `--set replicaCount=3` lives only in that revision, and the next plain upgrade snaps it back. In production the stakes are higher and the amnesia identical — a `--set` hotfix is invisible in code review, absent from git, and destined to be un-applied by the next deploy. Flags are for experiments on your laptop; **files are for decisions**. If a value matters, it goes in a values file in the repo. ([Values and Overrides](/helm/values-and-overrides/))

**3. Editing live objects.** `kubectl edit deploy`, tweaking an env var in place, bumping a probe timeout on the live object — in the lab, harmless; the chart was three directories away and you were the only reader. In prod, a live edit is drift with your fingerprints on it: Helm doesn't know, git doesn't know, and the next sync erases it. If you need to see what a change *would* do, use a dev namespace or `helm template`. If you need the change, commit it. ([Live Patching](/operations/live-patching/) covers the narrow legitimate exceptions and their cleanup cost.)

The common thread: in the lab, *you* were the source of truth. In production, **git is** — and every habit above is a way of lying to it.

## Your first week on the real cluster

You know the mapping. What you don't know yet is *this specific org's* answers: which registry path, which ingress class, which secret operator, who to ask when the quota says no. That's not a mapping problem — it's a reconnaissance problem. Before your first deploy, you want to be able to check every box on this list:

- [ ] My kubeconfig works, and I know exactly what my RBAC lets me do — including the debugging verbs (`exec`, `port-forward`).
- [ ] I've read the quota, the LimitRange defaults, and the PSA labels on my namespace — the furniture that will stamp my pods.
- [ ] I know the registry path my images must live at, and the pull secret is in the namespace.
- [ ] I know *what* deploys to my namespace — pipeline or GitOps — and where its config lives.
- [ ] I know my ingress class, my DNS pattern, and who issues my TLS certificates.
- [ ] I know where my logs land and how Prometheus finds my metrics.
- [ ] I know the platform team's channel, the escalation path, and the maintenance windows.

Every one of those has a verification command, a deep-dive link, and a fallback human — and they're all collected in one place: the [Day-1 Checklist](/start/day-1-checklist/), which ends with a copy-paste onboarding request that asks for everything at once instead of seven times.

You built the whole system by hand once. Now go enjoy having most of it done for you.
