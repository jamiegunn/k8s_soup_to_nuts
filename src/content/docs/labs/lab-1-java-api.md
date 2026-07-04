---
title: "Lab 1: A Java API, Shipped with Helm"
description: Build a Spring Boot 3.3 / Java 21 API entirely inside Docker, stream it into your k3s cluster, and deploy it with a Helm chart you author from scratch — probes, resources, upgrades and all.
sidebar:
  order: 3
---

In [Lab 0](/labs/lab-0-cluster/) you built a cluster. Now you'll give it something to run: `orders-api`, a small Spring Boot REST service. You'll build the image without installing Java or Maven (the Dockerfile does both), get it into the cluster the one way that works, and then — the heart of this lab — author a Helm chart from an empty directory and use it to install, verify, and upgrade the app.

**What you'll have at the end:** `orders-api:0.1.0` running as a 3-replica Deployment in the `labs` namespace, installed as Helm release `orders` from a chart you wrote yourself, answering `curl` on `/api/orders` and passing actuator health probes.

## Prerequisites

- [Lab 0](/labs/lab-0-cluster/) completed: Lima VMs `docker` (builds) and `k3s` (the cluster), namespace `labs` as your context default, directory `~/k8s-labs/`.
- `DOCKER_HOST` and `KUBECONFIG` exported in **every new terminal** you open (Lab 0 suggested adding both to `~/.zshrc`).
- The cluster running. If you paused since Lab 0, revive it:

```bash
limactl start docker && limactl start k3s
export DOCKER_HOST="unix://$HOME/.lima/docker/sock/docker.sock"
export KUBECONFIG="$HOME/.lima/k3s/copied-from-guest/kubeconfig.yaml"
kubectl get nodes
```

```console
NAME       STATUS   ROLES                  AGE   VERSION
lima-k3s   Ready    control-plane,master   1d    v1.31.5+k3s1
```

## Step 1: The application source

Three files, no database, nothing beyond Spring Boot itself. Create the skeleton:

```bash
mkdir -p ~/k8s-labs/app/src/main/java/labs ~/k8s-labs/app/src/main/resources && cd ~/k8s-labs
```

First the build definition, `app/pom.xml` — two dependencies: `web` for REST endpoints, `actuator` for the health endpoints Kubernetes will probe, the standard Spring-on-K8s pairing ([Spring Boot on Kubernetes](/java/spring-boot/)):

```xml
<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.5</version>
  </parent>
  <groupId>labs</groupId>
  <artifactId>orders-api</artifactId>
  <version>0.1.0</version>
  <properties>
    <java.version>21</java.version>
  </properties>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-actuator</artifactId></dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin>
    </plugins>
  </build>
</project>
```

Next, the whole application in one file, `app/src/main/java/labs/OrdersApplication.java`. Note the `GREETING` line: it reads an environment variable nothing sets yet, so `/api/hello` returns the default — the hook [Lab 2](/labs/lab-2-config-and-secrets/) turns into a full tour of Kubernetes configuration:

```java
package labs;

import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.*;

@SpringBootApplication
@RestController
public class OrdersApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrdersApplication.class, args);
    }
    private static final List<Map<String, Object>> ORDERS = List.of(
            Map.of("id", 1, "item", "mechanical keyboard", "quantity", 1),
            Map.of("id", 2, "item", "usb-c dock", "quantity", 2),
            Map.of("id", 3, "item", "27-inch monitor", "quantity", 1));
    // Reads the GREETING env var, with a default. Lab 2 builds on this line.
    @Value("${GREETING:hello from the default}")
    private String greeting;

    @GetMapping("/api/orders")
    public List<Map<String, Object>> orders() {
        return ORDERS;
    }
    @GetMapping("/api/orders/{id}")
    public Map<String, Object> order(@PathVariable int id) {
        return ORDERS.stream().filter(o -> o.get("id").equals(id))
                .findFirst().orElse(Map.of("error", "no such order"));
    }
    @GetMapping("/api/hello")
    public Map<String, String> hello() {
        return Map.of("greeting", greeting);
    }
}
```

Finally, `app/src/main/resources/application.yaml`:

```yaml
spring.application.name: orders-api
server.port: 8080
management:
  server.port: 8081
  endpoints.web.exposure.include: health,info
  endpoint.health.probes.enabled: true
```

Two decisions here matter for the chart in Step 5: management endpoints live on a **separate port, 8081**, so probes don't ride (or expose anything on) the traffic port; and `probes.enabled: true` gives you `/actuator/health/liveness` and `/actuator/health/readiness` as distinct, Kubernetes-shaped endpoints ([Spring Boot on Kubernetes](/java/spring-boot/)).

## Step 2: The Dockerfile, line by line

You don't have Java or Maven installed, and you don't need them — the image builds the app *and* runs it, in two stages. Create `app/Dockerfile`:

```dockerfile
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY pom.xml .
RUN mvn -q dependency:go-offline
COPY src ./src
RUN mvn -q package -DskipTests

FROM eclipse-temurin:21-jre
WORKDIR /app
RUN useradd --system --uid 1001 orders
USER 1001
COPY --from=build /build/target/orders-api-*.jar app.jar
EXPOSE 8080 8081
ENTRYPOINT ["java", "-jar", "app.jar"]
```

What to notice, line by line: **two `FROM` lines = two stages** — the first is a ~700 MB image with Maven and a JDK, the second a slim JRE, and only the second ships, without your source or build tools. **`COPY pom.xml` + `dependency:go-offline` *before* `COPY src`** is the classic layer-caching trick: Docker caches each layer keyed on its inputs, so the slow dependency download reruns only when `pom.xml` changes — editing a `.java` file invalidates only the compile layer, and your second build takes seconds. **`useradd` + `USER 1001`** because root containers are the default and the mistake; a non-root numeric uid is the cheapest hardening you'll ever do, and some clusters refuse root pods outright ([Supply Chain Security](/operations/supply-chain-security/)).

## Step 3: Build and smoke-test locally

Build — the first run takes several minutes of Maven downloads:

```bash
docker build -t orders-api:0.1.0 app/
```

```console
 => [build 6/6] RUN mvn -q package -DskipTests                          45.3s
 => => naming to docker.io/library/orders-api:0.1.0
```

Run it in plain Docker first — always smoke-test an image before involving Kubernetes, so a broken app and a broken deployment never look like the same problem:

```bash
docker run --rm -p 8080:8080 orders-api:0.1.0
```

Watch for `Started OrdersApplication in 2.317 seconds` in the log, then from a **second terminal**:

```bash
curl -s localhost:8080/api/orders
```

```console
[{"quantity":1,"item":"mechanical keyboard","id":1},{"quantity":2,"item":"usb-c dock","id":2},{"quantity":1,"item":"27-inch monitor","id":3}]
```

`Ctrl-C` the `docker run` when you're satisfied.

## Step 4: Stream the image into k3s

Here's the step everyone forgets once and never again. Your image exists in the **docker** VM's daemon — but the cluster runs in the *other* VM, where k3s has **its own** containerd image store. To the cluster, `orders-api:0.1.0` doesn't exist, and there's no registry to pull it from. So stream it across: `docker save` writes the image as a tar archive to stdout, and `limactl shell k3s` pipes it straight into k3s's bundled containerd importer in the cluster VM:

```bash
docker save orders-api:0.1.0 | limactl shell k3s sudo k3s ctr images import -
```

```console
unpacking docker.io/library/orders-api:0.1.0 (sha256:7c1e...)...done
```

:::caution[This step is not optional]
Skip it and your pods sit in `ImagePullBackOff` while Kubernetes tries to pull the image from Docker Hub, where it doesn't exist — the number-one local-cluster gotcha ([Local Development](/start/local-development/) has the image-visibility model, [ImagePullBackOff](/troubleshooting/imagepullbackoff/) the triage). Repeat this command after **every** rebuild.
:::

## Step 5: Author the chart — from scratch

There are two honest ways to start a chart. `helm create charts/orders-api` generates a working scaffold — which you'd then strip, deleting `hpa.yaml`, `serviceaccount.yaml`, `ingress.yaml`, `tests/`, and half of `values.yaml`, because shipping template surface you don't understand is how charts rot. That delete-down workflow is legitimate. For learning we go the other way: **empty directory, five files, every line on purpose.**

```bash
mkdir -p ~/k8s-labs/charts/orders-api/templates
```

Create `charts/orders-api/Chart.yaml` — note `version` is the **chart's** version and `appVersion` the app's; they drift apart in real life ([Chart Anatomy](/helm/chart-anatomy/) dissects every field):

```yaml
apiVersion: v2
name: orders-api
description: The labs Spring Boot orders API
version: 0.1.0
appVersion: "0.1.0"
```

Create `charts/orders-api/values.yaml`:

```yaml
replicaCount: 2

image:
  repository: orders-api
  tag: 0.1.0
  pullPolicy: IfNotPresent

# Without this, resources are named <release>-<chart>: "orders-orders-api".
fullnameOverride: orders-api

service:
  port: 80
managementPort: 8081
probes:
  liveness: /actuator/health/liveness
  readiness: /actuator/health/readiness
resources:
  requests: {cpu: 100m, memory: 384Mi}
  limits: {memory: 512Mi}
```

*What to notice:* `values.yaml` is the chart's public API — everything a user may vary, with defaults. `pullPolicy: IfNotPresent` is **load-bearing for imported images**: `Always` makes the kubelet contact a registry even though the image is already in the node's containerd store, and fail. The JVM-ish resources (generous memory, no CPU limit) follow [Resources and QoS](/workloads/resources-and-qos/).

And `fullnameOverride` deserves its comment: Helm's conventional `fullname` helper names resources `<release>-<chart>` so two releases of one chart can coexist in a namespace — install release `orders` from chart `orders-api` and you'd get a Deployment named `orders-orders-api`. Correct, collision-proof, and silly-looking. This chart is only ever installed once per namespace here, so we override to the clean name `orders-api` — but keep the helper below, because it's the convention every chart you'll ever read uses.

Create `charts/orders-api/templates/_helpers.tpl`:

```yaml
{{- define "orders-api.fullname" -}}
{{- default (printf "%s-%s" .Release.Name .Chart.Name) .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end }}
{{- define "orders-api.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{ include "orders-api.selectorLabels" . }}
{{- end }}
{{- define "orders-api.selectorLabels" -}}
app.kubernetes.io/name: orders-api
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
```

*What to notice:* files starting with `_` render nothing; they hold named templates you `include` elsewhere. `selectorLabels` is split from `labels` deliberately — Deployment selectors are **immutable**, so the selector set must stay minimal and stable while the full label set can grow. The `{{-` chomping and `define`/`include` mechanics are the subject of [The Template Language](/helm/template-language/).

Create `charts/orders-api/templates/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "orders-api.fullname" . }}
  labels:
    {{- include "orders-api.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      {{- include "orders-api.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "orders-api.selectorLabels" . | nindent 8 }}
    spec:
      containers:
        - name: orders-api
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: 8080
            - name: management
              containerPort: {{ .Values.managementPort }}
          livenessProbe:
            httpGet:
              path: {{ .Values.probes.liveness }}
              port: management
            initialDelaySeconds: 10
          readinessProbe:
            httpGet:
              path: {{ .Values.probes.readiness }}
              port: management
            periodSeconds: 5
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
```

*What to notice:* the probes hit the actuator on the **named** `management` port, not the traffic port — liveness answers "restart me?", readiness answers "send me traffic?", and conflating them causes restart storms ([Health Checks](/workloads/health-checks/)). `toYaml .Values.resources | nindent 12` passes the whole block through from values verbatim — the standard idiom for structured values.

Create `charts/orders-api/templates/service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ include "orders-api.fullname" . }}
  labels:
    {{- include "orders-api.labels" . | nindent 4 }}
spec:
  selector:
    {{- include "orders-api.selectorLabels" . | nindent 4 }}
  ports:
    - name: http
      port: {{ .Values.service.port }}
      targetPort: http
```

*What to notice:* the Service's `selector` uses the **same** `selectorLabels` helper as the pod template — one source of truth, so they can never drift and silently select nothing. `port: 80` outside, `targetPort: http` (the named container port, 8080) inside. That's the whole chart — five files ([Chart Anatomy](/helm/chart-anatomy/) has the full tour).

## Step 6: Render first, install second

Never install a template you haven't read. `helm template` renders locally, touching nothing:

```bash
helm template orders charts/orders-api | less
```

You should see exactly one Service and one Deployment, both named `orders-api`, image `orders-api:0.1.0`, replicas `2`, probes on port `management`. The render is exactly what Helm will send to the API server, so read it *here*, not in `kubectl describe` after the fact — rule one of [Release Lifecycle and Operations](/helm/lifecycle-and-operations/). Happy? Install:

```bash
helm install orders charts/orders-api
```

```console
NAME: orders
NAMESPACE: labs
STATUS: deployed
REVISION: 1
```

Note `NAMESPACE: labs` — Helm honored your context default from Lab 0 — and `REVISION: 1`, a counter Step 8 will increment.

## Step 7: Verify it's really up

```bash
kubectl get pods,svc
```

```console
NAME                              READY   STATUS    RESTARTS   AGE
pod/orders-api-7d9c6b58d4-8kwzr   1/1     Running   0          40s
pod/orders-api-7d9c6b58d4-tj6mp   1/1     Running   0          40s
NAME                 TYPE        CLUSTER-IP     EXTERNAL-IP   PORT(S)   AGE
service/orders-api   ClusterIP   10.43.114.23   <none>        80/TCP    40s
```

(Pods showing `0/1` for a few seconds is the readiness probe doing its job.) Thanks to `fullnameOverride`, the Service is `orders-api`, not `orders-orders-api`. Port-forward through it — backgrounded, so one terminal suffices — and hit the API:

```bash
kubectl port-forward svc/orders-api 8080:80 >/dev/null & PF_PID=$!
sleep 2
curl -s localhost:8080/api/orders/2
curl -s localhost:8080/api/hello
kill $PF_PID
```

```console
{"quantity":2,"item":"usb-c dock","id":2}
{"greeting":"hello from the default"}
```

`$!` is the PID of the command you just backgrounded; capturing it in `PF_PID` means the `kill` targets exactly that port-forward. (You'll see `kill %1` in the wild — it kills *job number one*, which is the wrong job the moment an earlier retry left something else running in the background.)

Now the management port. It's deliberately not on the Service — probes and internals shouldn't ride the traffic port — so target the Deployment directly:

```bash
kubectl port-forward deploy/orders-api 8081:8081 >/dev/null & PF_PID=$!
sleep 2
curl -s localhost:8081/actuator/health/readiness
kill $PF_PID
```

```console
{"status":"UP"}
```

That's the exact URL the kubelet polls every 5 seconds to decide whether this pod belongs behind the Service.

:::tip[When a step fails]
Retries are part of lab life, and two errors greet every retrying reader:

**`Error: INSTALL FAILED: cannot re-use a name that is still in use`** — a previous `helm install orders` (even a failed one) already created the release. Either `helm uninstall orders` and install fresh, or — the better habit — make the command idempotent: `helm upgrade --install orders charts/orders-api` installs when the release doesn't exist and upgrades when it does, safe to run any number of times.

**`bind: address already in use`** on port-forward — a stale forward from an earlier attempt still owns the port. Kill it with the PID you captured (`kill $PF_PID`), or if that shell is long gone, `pkill -f "port-forward.*8080"`.
:::

## Step 8: Upgrade — and the `--set` discipline

Two replicas to three. The quick way is a flag:

```bash
helm upgrade orders charts/orders-api --set replicaCount=3
kubectl rollout status deploy/orders-api
```

```console
Release "orders" has been upgraded. Happy Helming!
REVISION: 2
deployment "orders-api" successfully rolled out
```

`kubectl rollout status` blocks until the new replica is Ready — the observable form of the surge-and-drain dance in [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/).

But `--set` has a catch: it lives only in that release revision, invisible to anyone reading your files. Run a plain `helm upgrade orders charts/orders-api` tomorrow and — since each upgrade replaces the previous values wholesale — `replicaCount` snaps back to 2. Flags are for experiments; **files are for decisions.** Persist it: edit `charts/orders-api/values.yaml`, set `replicaCount: 3`, and run `helm upgrade orders charts/orders-api` again. Revision 3, same manifests, and now the file is the truth. The full precedence rules (`-f` stacks, `--set`, `--reuse-values`) live in [Values and Overrides](/helm/values-and-overrides/) — Lab 2 exercises them.

## Step 9: Inspect the release

Where does Helm keep all this state? In the cluster:

```bash
helm list
helm get values orders
kubectl get secrets -l owner=helm
```

```console
NAME    NAMESPACE  REVISION  UPDATED                   STATUS    CHART             APP VERSION
orders  labs       3         2026-07-03 14:33:10 ...   deployed  orders-api-0.1.0  0.1.0
USER-SUPPLIED VALUES:
null
NAME                          TYPE                 DATA   AGE
sh.helm.release.v1.orders.v1  helm.sh/release.v1   1      12m
sh.helm.release.v1.orders.v2  helm.sh/release.v1   1      4m
sh.helm.release.v1.orders.v3  helm.sh/release.v1   1      1m
```

`helm get values` shows `null` because revision 3 used pure chart defaults — the `--set` from revision 2 is gone, which is exactly Step 8's point. Each `sh.helm.release.v1.orders.vN` Secret is one revision: chart, values, and rendered manifests, gzipped. One Secret per revision — you've made three (install, `--set` upgrade, file-backed upgrade), so all three are there, which is how `helm rollback` can replay any of them. That's Helm's entire memory, and it's what `helm rollback` replays — full story in [Release Lifecycle and Operations](/helm/lifecycle-and-operations/).

## Troubleshooting

:::caution[When the pods don't come up]
**`ImagePullBackOff`** — you forgot `docker save orders-api:0.1.0 | limactl shell k3s sudo k3s ctr images import -`, or `pullPolicy` isn't `IfNotPresent`. `kubectl describe pod <name>` shows a pull error against Docker Hub. [ImagePullBackOff](/troubleshooting/imagepullbackoff/).

**`CrashLoopBackOff`** — the container starts and dies. `kubectl logs <pod> --previous` shows the dead container's last words; a Java stack trace usually means a typo in `application.yaml` or the controller. Rebuild, re-import (Step 4's pipe), `kubectl rollout restart deploy/orders-api`. [CrashLoopBackOff](/troubleshooting/crashloopbackoff/).

**Pods `Running` but never `1/1` Ready** — probe failures. `kubectl describe pod` shows `Readiness probe failed: connection refused` when the probe port and the app's management port disagree: `managementPort` in values must match `management.server.port: 8081` in `application.yaml`.
:::

## Where you are now

Running in the `labs` namespace: Helm release `orders`, revision 3 — a 3-replica Deployment of `orders-api:0.1.0` with actuator-backed probes, behind ClusterIP Service `orders-api:80`. On disk: `~/k8s-labs/app/` and `~/k8s-labs/charts/orders-api/`.

Stopping for the day? `limactl stop docker && limactl stop k3s` pauses everything; the revival snippet at the top brings it back. `helm uninstall orders` would remove the release cleanly — **but don't**: [Lab 2](/labs/lab-2-config-and-secrets/) picks up with `orders` installed and teaches it to consume configuration every way Kubernetes knows how.
