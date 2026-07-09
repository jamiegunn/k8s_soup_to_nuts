---
title: "Lab 2: Secrets and Config, Every Way"
description: Extend orders-api to consume configuration through every mechanism Kubernetes offers — env vars, Secrets, envFrom, mounted files, subPath — then prove by observation which ones update live and fix the rest with a checksum.
keywords:
  - inject configuration into kubernetes pods
  - configmap and secret mounted as files
  - envfrom with a prefix
  - which config channels update live
  - checksum annotation to roll pods on config change
  - subpath mount does not update
  - base64 secret is not encryption
  - spring config import from mounted files
  - layering values files per environment
sidebar:
  order: 4
---

Kubernetes gives you a menu of ways to get configuration into a container, and they do **not** behave the same. This lab extends `orders-api` to consume config through every mechanism at once, then runs the experiment most people never do: change the config and watch which channels update live, which freeze forever, and how a chart makes the frozen ones roll anyway.

**What you'll have at the end:** `orders-api:0.2.0` running as release `orders`, reading configuration through six channels — plain env, Secret-backed env, `envFrom`, a mounted ConfigMap file, a mounted Secret file, and a deliberate `subPath` trap — plus a checksum annotation that turns config changes into automatic rollouts, and first-hand proof of each channel's update behavior.

## Prerequisites

- [Lab 0](/labs/lab-0-cluster/) and [Lab 1](/labs/lab-1-java-api/) completed: release `orders` **installed** and still deployed (`helm list` shows it — this lab edits that live release), `~/k8s-labs/` containing `app/` and `charts/orders-api/`.
- The cluster running. If you paused since Lab 1, revive it:

```bash
limactl start docker && limactl start k3s
export DOCKER_HOST="unix://$HOME/.lima/docker/sock/docker.sock"
export KUBECONFIG="$HOME/.lima/k3s/copied-from-guest/kubeconfig.yaml"
kubectl get nodes
```

```console
NAME       STATUS   ROLES                  AGE   VERSION
lima-k3s   Ready    control-plane,master   2d    v1.31.5+k3s1
```

## Step 1: The menu

Here's what Kubernetes offers and what this lab does with each ([Configuration](/workloads/configuration/) is the map):

| # | Mechanism | We'll use it for | Updates live? |
|---|---|---|---|
| 1 | Plain `env` value in the pod spec | `GREETING` | *(to be proven)* |
| 2 | `env` via `valueFrom: secretKeyRef` | `API_KEY` | *(to be proven)* |
| 3 | `envFrom` a ConfigMap (bulk, prefixed) | `CFG_FEATURE_FLAG`, `CFG_LOG_LEVEL` | *(to be proven)* |
| 4 | ConfigMap mounted as files | `/etc/orders/config/message.txt` + a Spring YAML file | *(to be proven)* |
| 5 | Secret mounted as files, `defaultMode: 0440` | `/etc/orders/secret/api-token` | *(to be proven)* |
| 6 | `subPath` mount of a single key | `/etc/orders/message-subpath.txt` | *(to be proven)* |

The last column is the whole point of Step 6. Don't peek — you're going to *observe* the answers.

## Step 2: A Secret, three ways

First, the Secret the app will read `API_KEY` from. Way one — imperative, the way you'd do it in a pinch:

```bash
kubectl create secret generic orders-auth --from-literal=api-key=s3cr3t-lab-key
kubectl get secret orders-auth -o jsonpath='{.data.api-key}' | base64 -d && echo
```

```console
secret/orders-auth created
s3cr3t-lab-key
```

That round-trip is the base64-is-not-encryption moment: `kubectl get secret ... -o jsonpath` hands anyone with read access the base64 (`czNjcjN0LWxhYi1rZXk=`), and one pipe later it's plaintext. Base64 exists so arbitrary bytes survive JSON, nothing more; what actually protects Secrets is RBAC and encryption at rest — [Secrets](/workloads/secrets/) has the threat model.

Way two — declarative YAML with `stringData`: you write the plaintext, the API server encodes. This is the shape you put in a chart template — Step 4's chart-managed Secret uses exactly it. (Don't apply this one: `orders-auth` already exists, and Helm won't adopt resources it didn't create anyway.)

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: orders-auth
stringData:
  api-key: s3cr3t-lab-key
```

Way three — from a file, handy for certs and keys that already exist on disk. The `--dry-run=client -o yaml` output shows `data` identical to way one — three roads, one object:

```bash
printf 's3cr3t-lab-key' > /tmp/api-key
kubectl create secret generic orders-auth --from-file=api-key=/tmp/api-key --dry-run=client -o yaml
rm /tmp/api-key
```

:::caution[Secrets and git don't mix]
A Secret manifest — or a values file containing one — committed to git is a leaked credential with version history. This lab commits nothing, so we allow ourselves a token in `values.yaml` for teaching; real pipelines use Sealed Secrets, External Secrets, or a vault so the *reference* is committed and the *value* never is ([Secrets](/workloads/secrets/)).
:::

## Step 3: The app learns to report its own config (0.2.0)

To *see* six channels, the app must expose what it received: a `/api/config` endpoint reporting every value. Env vars are read at startup; files are read **per request** — that difference is what makes Step 6's experiment visible. First, teach Spring to import mounted config. Replace `app/src/main/resources/application.yaml`:

```yaml
spring.application.name: orders-api
spring.config.import:
  - optional:file:/etc/orders/config/application-extra.yaml
  - optional:configtree:/etc/orders/secret/
server.port: 8080
management:
  server.port: 8081
  endpoints.web.exposure.include: health,info
  endpoint.health.probes.enabled: true
```

Two imports, both `optional:` so the app still boots locally where the paths don't exist. `file:` reads a whole Spring YAML file the chart will mount; `configtree:` turns a directory into properties — each *filename* becomes a property name, each file's *content* its value, which is precisely the shape of a mounted Secret (it even follows the kubelet's symlink dance you'll meet in Step 6). Now give the app its reporting endpoint — a **new** controller, `app/src/main/java/com/example/orders/ConfigController.java`, next to Lab 1's two classes. A separate class on purpose: Lab 3 replaces `OrderController` wholesale, and this endpoint should outlive that. (`OrderController` keeps `/api/orders` and `/api/hello` untouched.)

```java
package com.example.orders;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.*;

@RestController
public class ConfigController {
    @Value("${GREETING:hello from the default}")
    private String greeting;               // channel 1: plain env
    @Value("${API_KEY:no-key-set}")
    private String apiKey;                 // channel 2: env from Secret
    @Value("${orders.motd:no motd configured}")
    private String motd;                   // channel 4b: mounted Spring YAML
    @Value("${api-token:no-token-file}")
    private String apiToken;               // channel 5: configtree over the Secret mount

    @GetMapping("/api/config")
    public Map<String, Object> config() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("greeting", greeting);
        out.put("apiKey", mask(apiKey));
        out.put("featureFlag",                    // channel 3: envFrom, prefixed
                System.getenv().getOrDefault("CFG_FEATURE_FLAG", "unset"));
        out.put("messageFile",                    // channel 4a: mounted file, read per request
                readFile("/etc/orders/config/message.txt"));
        out.put("messageSubPath",                 // channel 6: the subPath trap
                readFile("/etc/orders/message-subpath.txt"));
        out.put("motd", motd);
        out.put("apiToken", mask(apiToken));
        return out;
    }
    private static String readFile(String path) {
        try {
            return Files.readString(Path.of(path)).strip();
        } catch (IOException e) {
            return "file not found";
        }
    }
    private static String mask(String v) {
        return v.length() <= 4 ? "****" : v.substring(0, 4) + "****";
    }
}
```

Bump `<version>` in `app/pom.xml` to `0.2.0`, then rebuild and load — Lab 1's two commands, new tag:

```bash
cd ~/k8s-labs
docker build -t orders-api:0.2.0 app/
docker save orders-api:0.2.0 | limactl shell k3s sudo k3s ctr images import -
```

This rebuild re-downloads dependencies, by the way: changing `pom.xml` invalidated the cached `dependency:go-offline` layer — Lab 1's caching lesson in reverse.

## Step 4: The chart delivers, mechanism by mechanism

**4.1 — Values.** In `charts/orders-api/values.yaml`, change the image tag to `tag: 0.2.0`, then append:

```yaml
# Channel 1: rendered straight into an env value
greeting: "hello from values.yaml"
# Channels 3 + 4: rendered into the ConfigMap template
config:
  featureFlag: "beta-checkout"
  logLevel: "debug"
  message: "The mounted file says hi"
  motd: "Config imported the Spring way"
auth:
  # Channel 2: the hand-made Secret from Step 2 — referenced, NOT chart-managed
  envSecret: orders-auth
  # Channel 5: the chart-managed file Secret (lab-only shortcut; see Step 2's caution)
  fileToken: "s3cr3t-file-token"
```

**4.2 — The ConfigMap template.** Create `charts/orders-api/templates/configmap.yaml`. One ConfigMap, two personalities: env-style keys for `envFrom` (channel 3), file-style keys for the volume mount (channel 4):

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "orders-api.fullname" . }}-config
  labels:
    {{- include "orders-api.labels" . | nindent 4 }}
data:
  FEATURE_FLAG: {{ .Values.config.featureFlag | quote }}
  LOG_LEVEL: {{ .Values.config.logLevel | quote }}
  message.txt: {{ .Values.config.message | quote }}
  application-extra.yaml: |
    orders:
      motd: {{ .Values.config.motd | quote }}
```

**4.3 — The Secret template** (Step 2's "way two", now chart-managed — channel 5). Create `charts/orders-api/templates/secret.yaml`:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "orders-api.fullname" . }}-files
  labels:
    {{- include "orders-api.labels" . | nindent 4 }}
stringData:
  api-token: {{ .Values.auth.fileToken | quote }}
```

**4.4 — Env channels 1–3.** In `charts/orders-api/templates/deployment.yaml`, insert directly under the `imagePullPolicy:` line: a plain value from values (channel 1, the workhorse), a `secretKeyRef` so the pod spec holds a *reference* and never the secret itself (channel 2 — [Environment Variables](/workloads/environment-variables/)), and a bulk `envFrom` with a prefix so the import can't silently shadow anything (channel 3):

```yaml
          env:
            - name: GREETING
              value: {{ .Values.greeting | quote }}
            - name: API_KEY
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.auth.envSecret }}
                  key: api-key
          envFrom:
            - configMapRef:
                name: {{ include "orders-api.fullname" . }}-config
              prefix: CFG_
```

**4.5 — File channels 4–6.** Still in `deployment.yaml`: insert under the `resources:` block (aligned with `env:`):

```yaml
          volumeMounts:
            - name: config                # channel 4: whole ConfigMap as a directory
              mountPath: /etc/orders/config
              readOnly: true
            - name: config                # channel 6: ONE key via subPath — the trap
              mountPath: /etc/orders/message-subpath.txt
              subPath: message.txt
              readOnly: true
            - name: secret-files          # channel 5: Secret as files
              mountPath: /etc/orders/secret
              readOnly: true
```

…and at the very bottom, as a sibling of `containers:`:

```yaml
      volumes:
        - name: config
          configMap:
            name: {{ include "orders-api.fullname" . }}-config
        - name: secret-files
          secret:
            secretName: {{ include "orders-api.fullname" . }}-files
            defaultMode: 0440
```

…and one line pair under `spec:` in the pod template (just above `containers:`):

```yaml
      securityContext:
        fsGroup: 1001
```

Three fine points ([Config Files and Volumes](/workloads/config-files-and-volumes/) has the deep mechanics):

- **`defaultMode: 0440` needs `fsGroup: 1001`.** Mounted Secret files are owned by root; octal `0440` (owner+group read only) would lock out our non-root uid 1001. `fsGroup` makes the volume group-readable by the app's group — omit it and the app crashes at startup, unable to read the configtree.
- **`envFrom` silently skips invalid keys.** `message.txt` and `application-extra.yaml` contain dots, illegal in env var names, so channel 3 ignores them — one ConfigMap, two consumption modes, no conflict.
- **The `subPath` mount is a deliberate trap.** It projects a single key as a single file — genuinely useful when you must drop one file into a non-empty directory like `/etc/nginx/conf.d`. Its cost gets proven in Step 6.

**4.6 — Render check.** Before upgrading, verify placement — you should see four `kind:` lines, all three mounts, and `fsGroup`; if your indentation is off, `helm template` fails loudly here instead of the cluster failing quietly later:

```bash
helm template orders charts/orders-api | grep -E 'kind:|GREETING|API_KEY|prefix|mountPath|subPath|fsGroup'
```

## Step 5: Upgrade and verify every channel

```bash
helm upgrade orders charts/orders-api
kubectl rollout status deploy/orders-api
```

```console
Release "orders" has been upgraded. Happy Helming!
deployment "orders-api" successfully rolled out
```

Start a port-forward in a **second terminal** and leave it running:

```bash
kubectl port-forward svc/orders-api 8080:8080
```

:::note[Port-forwards die with their pod]
`kubectl port-forward` pins to one pod, and every rollout in this lab replaces the pods — when a `curl` suddenly fails after an upgrade, restart the port-forward before suspecting anything else.
:::

Now the reveal:

```bash
curl -s localhost:8080/api/config
```

```console
{"greeting":"hello from values.yaml","apiKey":"s3cr****","featureFlag":"beta-checkout","messageFile":"The mounted file says hi","messageSubPath":"The mounted file says hi","motd":"Config imported the Spring way","apiToken":"s3cr****"}
```

All six channels, one JSON object. Cross-check from inside the container:

```bash
kubectl exec deploy/orders-api -- env | grep -E 'GREETING|API_KEY|CFG_'
kubectl exec deploy/orders-api -- ls -lL /etc/orders/secret
```

```console
GREETING=hello from values.yaml
API_KEY=s3cr3t-lab-key
CFG_FEATURE_FLAG=beta-checkout
CFG_LOG_LEVEL=debug
-r--r----- 1 root 1001 16 Jul  3 15:12 api-token
```

Note `API_KEY` in plaintext: anyone who can `exec` (or read `/proc`) sees the secret — env-based secrets are convenient, not confidential. The Secret file is `0440`, group `1001` courtesy of `fsGroup`; `ls /etc/orders/config` likewise shows every ConfigMap key as a file.

## Step 6: The live-update experiment

The lab's payoff. To isolate what the **kubelet** does on a config change — with no Helm rollout muddying the water — change the ConfigMap directly, behind Helm's back. (We'll pay for this shortcut in a minute; that's part of the lesson.)

```bash
kubectl patch configmap orders-api-config --type merge -p '{"data":{"message.txt":"patched live, no restart"}}'
for i in $(seq 1 12); do
  kubectl exec deploy/orders-api -- cat /etc/orders/config/message.txt; echo " ($(date +%T))"; sleep 10
done
```

```console
The mounted file says hi (15:20:04)
The mounted file says hi (15:20:15)
patched live, no restart (15:20:26)
patched live, no restart (15:20:48)
```

Within about a minute (kubelet sync period plus cache), the file changed **inside a running container** — `curl -s localhost:8080/api/config` shows the new `messageFile` too, since the app reads it per request. The kubelet writes new content to a hidden timestamped directory and atomically swaps a symlink, so readers never see a half-written file. Now the other channels:

```bash
kubectl exec deploy/orders-api -- cat /etc/orders/message-subpath.txt && echo
kubectl exec deploy/orders-api -- env | grep GREETING
```

```console
The mounted file says hi
GREETING=hello from values.yaml
```

Wait as long as you like — these will *never* change. The `subPath` mount bound to the resolved path at container start, so the symlink swap happens without it; env vars were baked into the process environment at startup, and nothing in Kubernetes rewrites a running process's environment. Your observed results, completing Step 1's table:

| Channel | On ConfigMap/Secret change |
|---|---|
| Mounted ConfigMap/Secret directory | Updates in place, ~1 min, atomically |
| `subPath`-mounted file | **Never updates** |
| env / `envFrom` (any source) | **Never updates** — frozen at container start |

The rotation strategies built on these facts are in [ConfigMap and Secret Rotation](/operations/configmap-secret-rotation/).

**The fix: make config changes roll the pods.** Charts encode the standard trick — hash the rendered ConfigMap into a pod-template annotation, so any config change alters the pod template and triggers a rollout. In `charts/orders-api/templates/deployment.yaml`, give the pod template metadata an annotation:

```yaml
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
```

`include (print $.Template.BasePath "/configmap.yaml")` renders the ConfigMap template *inside* the deployment and hashes the result — the canonical idiom from [Authoring Best Practices](/helm/authoring-best-practices/). Prove it: in `values.yaml`, set `message: "rolled out by a checksum change"`, then:

```bash
helm upgrade orders charts/orders-api
kubectl rollout status deploy/orders-api
```

```console
deployment "orders-api" successfully rolled out
```

The ConfigMap changed, the checksum changed, the pods rolled — automatically. Restart your port-forward and curl `/api/config`: `messageFile` **and** `messageSubPath` both show the new message, because fresh containers re-resolve everything at start.

**And the bill for our shortcut.** What happened to `"patched live, no restart"`?

```bash
kubectl get configmap orders-api-config -o jsonpath='{.data.message\.txt}' && echo
```

```console
rolled out by a checksum change
```

Gone. The hand-patch was **drift** — a live object differing from its source of truth — and the next `helm upgrade` clobbered it without a warning, exactly as it should. Anything you `kubectl patch` behind your deployment tool's back lives only until the next deploy (in GitOps setups, not even that long). This failure mode has a whole article: [Drift and CI/CD](/operations/drift-and-cicd/).

## Step 7: Layering values files

One more Helm muscle: per-environment overrides. Create `~/k8s-labs/values-dev.yaml`:

```yaml
greeting: "hello from values-dev.yaml"
```

```bash
cd ~/k8s-labs
helm upgrade orders charts/orders-api -f values-dev.yaml
kubectl rollout status deploy/orders-api
curl -s localhost:8080/api/hello
```

```console
{"greeting":"hello from values-dev.yaml"}
```

(The pods rolled without any checksum this time — changing `GREETING` changes the pod template itself. And remember to restart the port-forward before the curl.) The precedence chain, lowest to highest: chart `values.yaml` → `-f` files in command-line order (last one wins) → `--set` on top of everything, as Lab 1's Step 8 showed. Stack a second `-f` file and it beats the first; add `--set greeting=...` and it beats them both.

Finally, back to chart defaults — and recall from Lab 1 that upgrades don't inherit previous overrides, so a plain `helm upgrade orders charts/orders-api` *is* the reset: `/api/hello` returns `"hello from values.yaml"` again. Full layering rules, including the `--reuse-values` foot-gun, in [Values and Overrides](/helm/values-and-overrides/).

## Troubleshooting

:::caution[When this lab's pods misbehave]
**`CreateContainerConfigError`** — the container can't even be created; almost always a dangling reference. `kubectl describe pod` says something like `secret "orders-authh" not found`: the name in `auth.envSecret` doesn't match Step 2's Secret, or you skipped Step 2. Fix it; the kubelet retries on its own.

**A file isn't where you expected** — `mountPath` vs `subPath` confusion. Mounting a volume at a path *replaces that whole directory* with the volume's contents; `subPath` projects one key onto one path, leaving the directory around it alone. `kubectl exec deploy/orders-api -- find /etc/orders` shows what actually landed.

**Env vars don't update after a config change** — not a bug; that's the design you proved in Step 6. Mount the value as a file, or make deploys roll the pods (the checksum annotation). Anyone whose app "picks up env changes live" is describing a restart they didn't notice.
:::

## Where you are now

Release `orders` runs `orders-api:0.2.0`, consuming config through all six channels, with a checksum annotation that turns every config change into a clean rollout. You've *watched* a mounted file update inside a live container, watched env and `subPath` stay frozen, and watched Helm erase manual drift. On disk: the updated `app/`, a chart with `configmap.yaml` and `secret.yaml` templates, and `values-dev.yaml`.

Pause with `limactl stop docker && limactl stop k3s` whenever you like — but keep the release installed: in [Lab 3](/labs/lab-3-backend-service/), `orders-api` stops being alone. You'll install a Valkey cache as a second Helm release and wire the two together the way real services find each other: a Service name and cluster DNS.
