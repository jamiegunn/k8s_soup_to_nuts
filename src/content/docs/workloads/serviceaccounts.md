---
title: ServiceAccounts
description: Workload identity — how your pods (not you) authenticate to the Kubernetes API and cloud services, and how to debug it when they can't.
keywords:
  - pod 403 forbidden calling api
  - automountserviceaccounttoken false
  - system:serviceaccount default
  - bound projected token
  - 401 unauthorized long-running pod
  - irsa gke workload identity
  - unable to locate credentials
  - kubectl auth can-i --as
  - role rolebinding serviceaccount
  - kubectl create token
  - unable to locate credentials aws
sidebar:
  order: 17
---

There are two kinds of identity in a cluster and people conflate them constantly. *You* authenticate with your user credentials — that's what `kubectl` uses, and what [RBAC denied](/troubleshooting/rbac-denied/) errors against your commands are about. *Your pods* authenticate as a **ServiceAccount** — a namespaced identity object that exists whether you think about it or not, because every pod runs as one. This article is about the second kind: what the pod-side identity is, when your app should actually use it, and how the same mechanism extends to cloud IAM.

## Every pod has one, and it's probably `default`

If your pod spec doesn't say otherwise, it runs as the ServiceAccount named `default` in its namespace. The kubelet mounts a credential bundle into every container:

```console
$ kubectl exec orders-7d4b9c-x2m4p -- ls /var/run/secrets/kubernetes.io/serviceaccount/
ca.crt
namespace
token
```

- `token` — a signed JWT proving "I am `system:serviceaccount:team-orders:default`"
- `ca.crt` — the CA to verify the API server's certificate
- `namespace` — the pod's own namespace as plain text (handy for self-configuration)

Since 1.22 the token is a **bound, projected token**, which is materially better than the legacy Secret-based tokens that preceded it:

| Property | Bound token (current) | Legacy Secret token |
|---|---|---|
| Audience | Bound to the API server (rejected elsewhere) | None — valid anywhere that trusts the signer |
| Expiry | ~1 hour (requested as 1y for compat, but short-lived in practice) | **Never expires** |
| Bound to pod | Yes — invalid after the pod is deleted | No |
| Refresh | Kubelet rotates it; the mounted file is updated in place | Static |

The refresh detail matters for app code: the file at `/var/run/secrets/.../token` **changes over time**. Read it per-request or use a client library that re-reads it — more on that failure mode at the end. If you find a `kubernetes.io/service-account-token` Secret in your namespace, that's a legacy non-expiring credential; treat it like a leaked password and see [Secrets](/workloads/secrets/) for cleanup.

## Default-deny: automountServiceAccountToken: false

Here's the uncomfortable default: every container in your namespace ships with a valid API credential mounted, and most apps never use it. That's free ammunition for anyone who exploits your app — an SSRF or RCE immediately harvests a working cluster token. The fix costs one line:

```yaml
spec:
  automountServiceAccountToken: false
```

Set it in the pod template of every workload that doesn't call the Kubernetes API — which is most of them. (It also exists on the ServiceAccount object itself as a namespace-wide default; a pod-level `true` can opt back in.) This is step 6 of the hardening checklist in [Pod Security](/workloads/pod-security/), and it's the cheapest security win in this whole guide.

**Should** your app talk to the API? Legitimate cases: a controller/operator you wrote that watches resources, leader election between replicas (via a coordination `Lease`), a pod discovering its siblings for cluster formation (Kafka, Hazelcast, Akka discovery). If your app serves HTTP and talks to a database, the answer is no — mount nothing.

## Giving a pod permissions: the SA + Role + RoleBinding trio

A ServiceAccount by itself grants *nothing*. Permissions come from RBAC bindings. Never pile permissions onto `default` (every unconfigured pod inherits them); create a dedicated SA per workload that needs one:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: sidecar-injector-controller
  namespace: team-orders
automountServiceAccountToken: true
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  namespace: team-orders
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: sidecar-injector-controller-pod-reader
  namespace: team-orders
subjects:
  - kind: ServiceAccount
    name: sidecar-injector-controller
    namespace: team-orders
roleRef:
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

Then reference it in the pod template:

```yaml
spec:
  serviceAccountName: sidecar-injector-controller
```

If the Role's `apiGroups`/`resources`/`verbs` rules read like incantations, [RBAC Explained](/start/rbac-explained/) covers the full model — rule anatomy, the built-in ClusterRoles, and how to design least-privilege roles.

All three objects are namespaced. Whether *you* can create Roles and RoleBindings depends on your own RBAC — many platforms allow SA creation but reserve Role management. If `kubectl apply` on the Role gets you a Forbidden, the ask to the platform team is precise: "Role `pod-reader` (get/list/watch pods) in `team-orders`, bound to SA `sidecar-injector-controller`" — a five-minute ticket. See [Working Without Admin](/start/working-without-admin/) for framing those requests.

:::caution
You can only bind permissions someone is willing to grant. Wanting `watch` on pods across all namespaces means a ClusterRole and ClusterRoleBinding — cluster-scoped, definitively platform territory.
:::

### Test the pod's permissions without deploying anything

`kubectl auth can-i` accepts an impersonation target, and you can (usually) impersonate ServiceAccounts in your own namespace:

```console
$ kubectl auth can-i list pods \
    --as=system:serviceaccount:team-orders:sidecar-injector-controller
yes
$ kubectl auth can-i delete pods \
    --as=system:serviceaccount:team-orders:sidecar-injector-controller
no
```

That `system:serviceaccount:<namespace>:<name>` string is the SA's username on the wire — memorize the format, because it's how SAs appear in every RBAC error you'll ever debug.

## Calling the API from inside the pod

The from-first-principles version, worth doing once so the client libraries stop being magic. From a shell in a pod whose SA has the `pod-reader` Role:

```bash
SA=/var/run/secrets/kubernetes.io/serviceaccount
TOKEN=$(cat $SA/token)
NS=$(cat $SA/namespace)

curl --cacert $SA/ca.crt \
     -H "Authorization: Bearer $TOKEN" \
     "https://kubernetes.default.svc/api/v1/namespaces/$NS/pods?limit=2"
```

```console
{
  "kind": "PodList",
  "apiVersion": "v1",
  "items": [
    { "metadata": { "name": "orders-7d4b9c-x2m4p", ... } },
    ...
```

`kubernetes.default.svc` always resolves to the API server from inside any pod. Real code should use a client library's in-cluster config — `rest.InClusterConfig()` (client-go), `config.load_incluster_config()` (Python), `Config.fromCluster()` (Java) — which does exactly what the curl does: reads those three files and points at that hostname, with token re-reading handled for you.

## Short-lived tokens on demand: TokenRequest

The mounted token is a TokenRequest product; you can mint your own for testing or for handing a scoped credential to an external system:

```console
$ kubectl create token sidecar-injector-controller --duration=15m
eyJhbGciOiJSUzI1NiIsImtpZCI6...
```

That's a real, expiring JWT for the SA — invaluable for reproducing "what can this workload actually do" from your laptop (`kubectl --token=...`), and the correct alternative anywhere you're tempted to create a legacy token Secret.

## Cloud workload identity: the same idea, pointed at AWS/GCP/Azure

Your pod probably needs S3 or Pub/Sub more than it needs the Kubernetes API. The wrong answer is cloud keys in a Secret: long-lived, manually rotated, readable by the whole namespace. Every major cloud now federates the SA token instead — same shape, different names:

- **AWS**: IRSA (IAM Roles for Service Accounts) or EKS Pod Identity
- **GCP**: GKE Workload Identity
- **Azure**: Azure AD Workload Identity

The common mechanism: the cluster's OIDC issuer signs your SA tokens; a cloud IAM role is configured to *trust* tokens for `system:serviceaccount:team-orders:orders-app`; the cloud SDK inside your pod exchanges the projected token for cloud credentials automatically. No key material exists to leak or rotate.

Honest division of labor: **setup is a platform + cloud-team request** (OIDC provider registration, IAM role and trust policy — all outside your namespace). Your part is two things: the annotation, and using a current SDK:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: orders-app
  namespace: team-orders
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/team-orders-app
    # GKE equivalent: iam.gke.io/gcp-service-account: orders-app@proj.iam.gserviceaccount.com
    # Azure equivalent: azure.workload.identity/client-id: <client-id> (+ pod label)
```

Modern SDKs pick up the injected env vars/token file with zero code changes. First debugging move, always from *inside* the pod:

```console
$ kubectl exec deploy/orders -- aws sts get-caller-identity
{
    "UserId": "AROA...:botocore-session-1719...",
    "Account": "123456789012",
    "Arn": "arn:aws:sts::123456789012:assumed-role/team-orders-app/botocore-session-..."
}
```

Wrong role or `Unable to locate credentials`? Check, in order: annotation typo (silent no-op), pod created *before* the annotation (webhook injection happens at pod creation — restart the pods), SDK too old to know web-identity flow, and then hand the IAM trust-policy end to the platform team — see [Working with the Platform Team](/operations/working-with-platform-team/).

## imagePullSecrets ride on ServiceAccounts too

A registry credential referenced from the SA is attached to every pod using that SA — cleaner than repeating `imagePullSecrets` in each pod spec:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: orders-app
imagePullSecrets:
  - name: registry-cred
```

If pulls work for some workloads and not others, compare which SA each uses before staring at the registry.

## Debugging workload identity

**403 from inside the pod.** The error names the identity — read it:

```console
pods is forbidden: User "system:serviceaccount:team-orders:default" cannot list
resource "pods" in API group "" in the namespace "team-orders"
```

Two findings in one line: the pod runs as `default` (you forgot `serviceAccountName`), and it lacks `list pods` (no binding). Fix the spec first, then reproduce with `kubectl auth can-i ... --as=system:serviceaccount:...` until it says yes.

**Token not mounted.** `curl: (26) Failed to open/read local data` or file-not-found on the token path → `automountServiceAccountToken: false` somewhere (pod or SA). Deliberate default-deny meeting a genuine consumer — opt that one workload back in.

**401 Unauthorized in long-running pods.** The classic slow burn: app works for weeks, then starts failing with 401s. Cause: code (or an outdated client library) read the token once at startup and cached it; the kubelet rotated the file; the cached JWT expired. Fix: upgrade the client library (all mainstream ones re-read the file now) or re-read per request in hand-rolled code. Never work around it with a legacy non-expiring token — that trades a bug for a standing credential.

**"It worked in the old cluster."** Old cluster likely had legacy tokens or `default` bound to something generous. New cluster is doing it right; do the trio.

The mental model that makes all of this compose: a ServiceAccount is a principal like any other. It gets exactly what's bound to it, it shows up by its full `system:serviceaccount:ns:name` in every error, and everything from `kubectl auth can-i` to cloud IAM trust policies keys off that one identity string.
