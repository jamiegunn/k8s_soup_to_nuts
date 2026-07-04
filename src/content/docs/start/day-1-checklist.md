---
title: "Day-1 Checklist: Before Your First Deploy"
description: What to ask for and verify before shipping to a platform-provisioned namespace — access, quotas, image path, deploy path, traffic, observability, and the people — each with the command that proves it.
sidebar:
  order: 11
---

Someone provisioned a namespace for you. There's a kubeconfig in your inbox, a Slack channel you were added to, and a deadline. Between you and your first successful deploy stand a dozen small facts about *this specific cluster* — which registry, which ingress class, who actually runs `helm upgrade` — and every one of them is a Friday-afternoon blocker if you discover it on deploy day instead of day one.

This page is the reconnaissance mission, structured so you can run it top to bottom in under an hour. Each item has three parts: **what to establish**, **the command that proves it** (not "someone said so" — proves it), and the deep-dive link for when the answer is surprising. Items marked **ask** need a human; everything else you can verify yourself with read-only commands. At the end there's a copy-paste onboarding request that asks the platform team for every missing piece in one message instead of seven.

If you arrived here from the labs, [From the Lab to the Paved Road](/labs/from-lab-to-prod/) explains *why* each of these exists; this page just gets you through them.

## 1. Access — can you see and touch your namespace?

**Your kubeconfig works and points where you think.** Before anything else, confirm you're talking to the right cluster and the right namespace — a working kubeconfig aimed at the wrong context has burned better engineers than us.

```bash
kubectl config current-context
kubectl config view --minify --output 'jsonpath={..namespace}'; echo
kubectl get pods
```

An empty pod list is fine; `Forbidden` or a connection error is not. If the namespace in the second command isn't yours, fix the context default now, not mid-incident ([kubectl Survival Kit](/start/kubectl-survival-kit/)).

**You know exactly what your RBAC allows.** Don't guess — dump it:

```bash
kubectl auth can-i --list
```

Read the output like a lease agreement. You're looking for `get/list/watch` on pods, deployments, services, configmaps, events at minimum. If the list is shorter than that, stop here and escalate — nothing else on this page will work. The full model behind the output is [RBAC Explained](/start/rbac-explained/); operating happily inside its limits is [Working Without Admin](/start/working-without-admin/).

**The debugging bundle is present.** The permissions that don't matter until 2 a.m., at which point they're the only ones that matter:

```bash
kubectl auth can-i create pods/exec        # shell into a container
kubectl auth can-i create pods/portforward # port-forward for local poking
kubectl auth can-i patch pods/ephemeralcontainers  # kubectl debug on distroless images
kubectl auth can-i get pods --subresource=log      # read logs (yes, verify even this)
```

Any `no` in that list goes into the onboarding request at the bottom of this page, *today*. When a denial surprises you later, [RBAC Denied](/troubleshooting/rbac-denied/) is the triage page.

## 2. Namespace reality — what furniture came pre-installed?

**The quota you're bidding against.** Every pod you create draws from a shared budget; know the ceiling and current usage before you size anything:

```bash
kubectl get resourcequota -o yaml
kubectl describe resourcequota
```

The `describe` output shows `Used` vs `Hard` per resource — if the namespace is shared, someone else's replicas are already spending your budget. Pods that won't schedule against an exhausted quota show up as `Pending` with a quota event ([Pod Pending](/troubleshooting/pod-pending/)); the sizing model is [Resources and QoS](/workloads/resources-and-qos/).

**The LimitRange that will stamp your pods.** If a LimitRange exists, containers that omit requests/limits get defaults injected silently — and containers that exceed the per-container max are rejected outright:

```bash
kubectl get limitrange -o yaml
```

Note the `default` (limit) and `defaultRequest` values: those are what your pods get if your chart forgets to set its own. A 128Mi default memory limit meeting a JVM is a `OOMKilled` origin story ([Resources and QoS](/workloads/resources-and-qos/)).

**The Pod Security level.** PSA labels on the namespace decide whether your pods are even admitted:

```bash
kubectl get ns "$(kubectl config view --minify -o jsonpath='{..namespace}')" \
  -o jsonpath='{.metadata.labels}' | tr ',' '\n' | grep pod-security; echo
```

`enforce=restricted` means non-root user, no privilege escalation, seccomp profile, dropped capabilities — your chart's `securityContext` must say all of that explicitly or the pod is rejected at admission with a message that names each violation. What each level requires: [Pod Security](/workloads/pod-security/).

**Whether the network is default-deny.** Many platform namespaces ship with a deny-all NetworkPolicy, which means nothing talks to your pods (or vice versa) until a policy allows it:

```bash
kubectl get networkpolicy
```

An empty list means open networking (within the cluster). Anything named `default-deny`, `deny-all`, or similar means your first deploy needs egress/ingress policies *shipped with it* — DNS to the cluster resolver, egress to your database, ingress from the ingress controller. The debugging signature of a forgotten policy is a connection that times out (not refuses) — [Network Policies](/networking/network-policies/) has both the authoring guide and the triage.

## 3. Image path — how do images get in?

**Which registry, which path.** **Ask:** the exact repository prefix your team pushes to (e.g. `artifactory.example.com/team-docker/`). Then verify the pull side works — the pull secret exists and is referenced:

```bash
kubectl get secrets | grep -i pull
kubectl get serviceaccount default -o jsonpath='{.imagePullSecrets}'; echo
```

If the secret exists but the ServiceAccount doesn't reference it, every chart you deploy must list it under `imagePullSecrets` explicitly. The whole registry relationship — repos, permissions, tokens, cleanup policies — is [Artifactory](/ci/artifactory/).

**The base-image and admission policy.** **Ask:** may you use public base images (`eclipse-temurin`, `nginx`), or must everything build FROM the org's golden images? Is there an admission controller rejecting unsigned or unscanned images? Discovering this in CI is cheap; discovering it as a cryptic admission webhook denial on deploy day is not ([Supply Chain Security](/operations/supply-chain-security/)).

## 4. Deploy path — who actually applies manifests?

**Pipeline or GitOps?** **Ask** — this single answer changes your whole workflow: does a CI deploy stage run `helm upgrade` with its own credentials ([CI/CD Pipeline Design](/operations/cicd-pipeline-design/)), or does a GitOps controller sync the namespace from a git repo ([GitOps for Tenants](/operations/gitops-for-tenants/))? Get the repo/pipeline URL and confirm you have write (or PR) access to it.

**The reconciler fingerprint check.** Whatever they told you, verify it — look at who *actually* manages the live objects:

```bash
kubectl get deploy -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.app\.kubernetes\.io/managed-by}{"\n"}{end}'
kubectl get secrets -l owner=helm    # Helm releases live here — installed by whom?
```

`managed-by: Helm` plus release secrets means Helm-based deploys; Argo CD or Flux labels/annotations (`argocd.argoproj.io/instance`, `kustomize.toolkit.fluxcd.io/name`) mean a reconciler is watching — and will revert anything you change by hand, usually within minutes. Either way, the operational rule is the same: **mutations go through git; your kubectl is read-only in this namespace.** Why that rule exists, with incident receipts: [Drift and CI/CD](/operations/drift-and-cicd/).

## 5. Traffic — how do requests reach you?

**The ingress class.** Clusters routinely run more than one ingress controller; an Ingress with the wrong (or missing) class is silently ignored — valid YAML, no route, no error:

```bash
kubectl get ingressclass
kubectl get ingress -A 2>/dev/null | head -5   # if visible: what do neighbors use?
```

**Ask** which class your team should use if more than one exists, and whether any required annotations come with it ([Ingress and Routing](/networking/ingress-and-routing/)).

**The DNS pattern.** **Ask:** what hostname will your service get — `orders.apps.example.com`? `orders-team.example.com`? — and is DNS automated (ExternalDNS watching your Ingress) or a ticket to the network team with a lead time measured in days? The automation and its failure modes: [DNS Integration](/routing/dns-integration/).

**The certificate issuer.** **Ask:** who issues TLS certs — cert-manager with a corporate CA, a wildcard cert already on the load balancer, or a manual CSR process? And will your *outbound* calls to internal services need the corporate CA bundle in your trust store? Both halves — serving corporate-CA certs and trusting them — are covered in [TLS and Corporate CAs](/networking/tls-and-corporate-cas/).

## 6. Observability — will you be able to see it running?

**Where logs land.** Your pods' stdout is being collected by something — find out what and where it's queryable (Splunk? Loki? Elastic?), and **ask** for the index/query that scopes to your namespace. Verify collection is actually happening before you need it:

```bash
kubectl logs deploy/<anything-running> --tail=5   # works via kubectl...
# ...now find these same lines in the org's log UI. If you can't, file that now.
```

Any format requirements (JSON logs, mandatory fields) are cheapest to adopt before your first deploy — [Log Collection](/observability/log-collection/) has the pipeline, [Logging Fundamentals](/observability/logging-fundamentals/) the app-side conventions.

**The Prometheus scrape convention.** **Ask** how metrics get discovered in this cluster: `prometheus.io/scrape` annotations or a `ServiceMonitor`/`PodMonitor` CRD? Check what the cluster supports:

```bash
kubectl api-resources | grep -i -E 'servicemonitor|podmonitor'
```

If ServiceMonitors exist, annotations may be silently ignored — your app exports metrics into the void. Wiring details: [Metrics](/observability/metrics/).

**Alert routing.** **Ask:** when your pods crashloop at 3 a.m., does anything page *your team* — or only the platform team, who will forward the ticket at 9? Get your team's alert route (and on-call rotation, if any) registered before the first incident, not during it ([Alerting](/observability/alerting/)).

## 7. The people — who do you call?

The platform is a product and you are its customer, but escalation paths beat guesswork:

- **Ask:** the platform team's channel, and whether it's for questions, incidents, or both.
- **Ask:** the escalation path when the channel is quiet — on-call handle, ticket queue, severity definitions.
- **Ask:** the maintenance windows — when nodes get drained and upgraded, so a pod restart during the window doesn't send you on a phantom bug hunt. (Your workloads should survive drains anyway — that's [High Availability](/workloads/high-availability/) — but *knowing* the window turns a mystery into a calendar entry.)
- **Ask:** where the platform docs live. Every answer on this page is probably written down somewhere; find the somewhere.

How to be the tenant whose tickets get answered first: [Working with the Platform Team](/operations/working-with-platform-team/).

## The namespace onboarding request

Everything above that needed a human, in one message. Paste into the platform channel, fill in the brackets, and delete what you already know:

```text
Hi! We're onboarding [service-name] into namespace [namespace] on [cluster]
and I'd like to confirm our setup in one pass. Could you confirm / provide:

ACCESS
1. Our RBAC includes the debugging subresources: pods/exec, pods/portforward,
   pods/log, and pods/ephemeralcontainers (kubectl debug). If not, what's the
   process to request them?

NAMESPACE
2. The ResourceQuota and LimitRange for [namespace] — and the process for a
   quota increase when we have load-test data.
3. The PSA enforcement level, and any admission policies beyond it
   (image signing, required labels, etc.).
4. Is there a default-deny NetworkPolicy? If so, is there a policy template
   for: DNS egress, ingress-controller ingress, and egress to [dependencies]?

IMAGES
5. Our registry path (we assume [artifactory.example.com/team-docker/]) and
   confirmation the pull secret in the namespace covers it.
6. Base-image policy: approved bases / golden images we must build from?

DEPLOY
7. How deploys work for this namespace: pipeline or GitOps? Which repo/pipeline,
   and how do we get access? Anything we must NOT do by hand?

TRAFFIC
8. Ingress class + required annotations, the DNS pattern for our hostname
   ([orders].apps.example.com?), and the TLS issuer / cert process.

OBSERVABILITY
9. Where our namespace's logs are queryable, the metrics discovery convention
   (annotations vs ServiceMonitor), and how we register alert routing to
   [team channel / pager].

PEOPLE
10. Escalation path outside this channel, and the maintenance windows for
    [cluster].

Happy to work through these async — a link to existing docs answers any of them.
```

Ten questions, one message, and every answer slots into a section above. When the replies come in, re-run this page's verification commands — "confirmed by the platform team" and "proven by kubectl" are different things, and only one of them holds up at 2 a.m.

## Where to go next

- Boxes all checked? Ship it — and when something goes sideways, the [Solutions Index](/start/solutions-index/) maps symptoms straight to fixes.
- Want the guided route through the reference material instead? Pick a track in [Learning Paths](/learning-paths/).
- Came here without doing the labs, and some of these commands felt like incantations? The [Hands-On Labs](/labs/overview/) build the muscle memory on a cluster where nothing can go wrong that `limactl delete -f` can't fix.
