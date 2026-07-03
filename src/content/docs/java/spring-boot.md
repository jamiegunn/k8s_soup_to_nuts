---
title: Spring Boot on Kubernetes
description: Actuator health groups wired to probes, graceful shutdown that actually drains, configtree config, Micrometer metrics, startup tuning, layered images, and a fully annotated reference Deployment.
sidebar:
  order: 10
---

Spring Boot ships more Kubernetes integration out of the box than any other JVM framework — and most teams wire half of it, wrong. This page is the Spring-specific playbook: what to turn on, what to skip, and the reference Deployment at the bottom that puts it all together. Generic JVM-in-a-container mechanics (heap sizing, container awareness, GC) live in [The JVM in Containers](/java/jvm-in-containers/) — this page assumes them.

:::tip[Actuator is bigger than probes]
This article wires actuator into probes and metrics. The full operational surface — runtime log-level changes, heap/thread dumps over HTTP, config inspection, endpoint security — has its own deep dive: [Spring Boot Actuator as an Ops Surface](/java/actuator/).
:::

## Actuator is your Kubernetes integration surface

Everything Kubernetes needs from your app — probes, metrics, graceful-shutdown signals — flows through Actuator. Two decisions up front:

**Split the management port.** Serve Actuator on its own port so probes and metrics never compete with (or leak to) application traffic:

```yaml
# application.yaml
management:
  server:
    port: 8081
  endpoints:
    web:
      exposure:
        include: health,prometheus,info
```

Why it matters: with a shared port, a saturated request thread pool makes liveness time out — Kubernetes then kills a pod that was merely *busy*, exactly when you can least afford it. (On the management port, probes get their own connector and thread pool.) It also keeps `/actuator/**` off your ingress without path gymnastics.

**Use the built-in health groups.** When Spring Boot detects Kubernetes (via the `KUBERNETES_SERVICE_HOST` env var), it automatically exposes:

- `/actuator/health/liveness` — backed by the `livenessState` indicator only
- `/actuator/health/readiness` — backed by `readinessState` only

Note the defaults: **neither group includes your DB, Redis, or disk-space indicators.** They reflect Spring's internal `AvailabilityState` — the app context is up and hasn't declared itself broken. Everything else, you opt into:

```properties
management.endpoint.health.group.readiness.include=readinessState,db
management.endpoint.health.probes.add-additional-paths=true   # also serve on main port at /livez,/readyz if you want
```

**The one rule that is not negotiable: liveness must never include external dependencies.** If the database is down and your liveness check pings the database, Kubernetes restart-loops every pod in the fleet — turning a database blip into a full outage of your tier, and hammering the recovering DB with a stampede of restarting connection pools. Liveness answers exactly one question: is *this process* wedged beyond recovery?

Readiness-with-db is the honest debate. Including `db` means pods stop taking traffic during a DB outage — reasonable if requests are useless without it, harmful if you serve cached/degraded responses, and dangerous if *every* pod goes unready simultaneously (some ingresses then fail closed entirely). My default: include the DB in readiness only when the app is 100% useless without it, and even then prefer failing fast at the request layer. Probe YAML mechanics and tuning live in [Health Checks](/workloads/health-checks/).

```yaml
livenessProbe:
  httpGet: { path: /actuator/health/liveness, port: 8081 }
  periodSeconds: 10
  failureThreshold: 3
readinessProbe:
  httpGet: { path: /actuator/health/readiness, port: 8081 }
  periodSeconds: 5
  failureThreshold: 3
```

## Graceful shutdown done right

Every deploy kills pods. Without graceful shutdown, every deploy drops in-flight requests. Two lines fix it:

```yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 25s
```

The full sequence on pod deletion, worth understanding once:

1. Kubernetes marks the pod Terminating and **in parallel**: removes it from Service endpoints, and runs your `preStop` hook.
2. Endpoint removal propagates to kube-proxy/ingress asynchronously — for a few seconds, **new requests still arrive**. This is why you add `preStop: sleep 5`: not superstition, it holds SIGTERM back until routing catches up.
3. After preStop, kubelet sends SIGTERM. Spring's graceful shutdown kicks in: the web server stops accepting new connections but lets in-flight requests finish, up to `timeout-per-shutdown-phase`.
4. If everything drains, the JVM exits cleanly. If `terminationGracePeriodSeconds` (default 30s) expires first, kubelet sends SIGKILL — no appeals.

The arithmetic must hold: **`preStop sleep + timeout-per-shutdown-phase + a few seconds of context-close slack < terminationGracePeriodSeconds`**. The defaults (5 + 25 + slack vs 30) do *not* hold — bump the grace period to 40 as in the reference YAML below. Symptom of getting this wrong: a small burst of 502/connection-reset errors on every single deploy, invisible in tests, obvious in production error budgets.

## Config from Kubernetes, the Spring way

Spring's relaxed binding makes env vars first-class: `SPRING_DATASOURCE_URL` binds to `spring.datasource.url`, `MYAPP_FEATURE_FLAGS_NEW_CHECKOUT` to `myapp.feature-flags.new-checkout`. For a handful of values, env vars from a ConfigMap/Secret are the simplest path — mechanics in [Environment Variables](/workloads/environment-variables/).

For anything beyond a handful, mount files and use **configtree**:

```yaml
spring:
  config:
    import: "optional:configtree:/etc/config/"
```

Every file under `/etc/config/` becomes a property named after its path: `/etc/config/spring/datasource/password` → `spring.datasource.password`. This pairs perfectly with ConfigMap/Secret volume mounts, keeps secrets out of `kubectl describe pod` output, and — unlike env vars — mounted files update in place when the ConfigMap changes. `optional:` means local dev without the mount still boots. Mount patterns in [Config Files and Volumes](/workloads/config-files-and-volumes/).

Profiles map cleanly to environments — one image, per-environment overlay:

```yaml
env:
  - name: SPRING_PROFILES_ACTIVE
    value: "prod,gcp"
```

**Spring Cloud Kubernetes, honestly.** It offers live config reload by watching ConfigMaps from inside your app (or via its config-watcher component). The cost: your pods need RBAC to read/watch ConfigMaps (a request to the platform team), you've added a dependency with its own CVE and upgrade cadence, and "config changed live under a running bean" is a class of production surprise most teams don't want — half your beans read config at startup anyway, so a live reload gives you a *partially* updated app. For most teams the boring pattern wins: change the ConfigMap, roll the pods via a checksum annotation, get a clean restart through the graceful-shutdown path you already built. Full treatment in [ConfigMap and Secret Rotation](/operations/configmap-secret-rotation/).

## Observability wiring

**Metrics.** Add `micrometer-registry-prometheus`, expose the endpoint (already in the exposure list above), and `/actuator/prometheus` on the management port serves scrape-ready text — JVM, HTTP server, Hikari pool, and Tomcat metrics with zero code. How it gets scraped depends on your cluster: `prometheus.io/*` annotations or a `ServiceMonitor` — ask which your platform runs; both patterns and the tradeoffs are in [Java Observability](/java/java-observability/).

**Tracing.** `micrometer-tracing-bridge-otel` + `opentelemetry-exporter-otlp` gives you W3C `traceparent` propagation automatically across RestClient/WebClient/Kafka — inbound headers continue upstream traces, outbound calls carry yours. Set the sampling rate deliberately (`management.tracing.sampling.probability: 0.1`); 1.0 in production is a bill, not an insight.

**Logs.** Emit JSON so trace IDs land as queryable fields. Spring Boot 3.4+ makes it one property:

```properties
logging.structured.format.console=ecs
```

(Older versions: `logstash-logback-encoder` in `logback-spring.xml`.) With tracing on the classpath, `trace_id`/`span_id` appear in every log line — the click-from-trace-to-logs workflow that makes 3 a.m. debugging humane.

## Startup performance in a pod

Spring Boot starts slower than the runtimes your platform team benchmarks probes against. Three levers, in order of effort:

- **CDS / AOT.** Spring Boot 3.3+ buildpacks enable CDS with a training run at build time; typically 30–40% faster startup, free. Full GraalVM native image is the nuclear option — sub-second startup, but a build-pipeline and reflection-compatibility project of its own. `spring.main.lazy-initialization=true` looks tempting and mostly isn't: it moves the cost (and the failures!) from startup into the first requests, which then trip your readiness/latency alerting instead.
- **Size the startupProbe with arithmetic, not vibes.** Measure real in-cluster startup (`Started Application in 34.2 seconds`), then give headroom: budget = `failureThreshold × periodSeconds`. For a 35s typical start, `failureThreshold: 24, periodSeconds: 5` = 120s budget. While the startup probe runs, liveness is suspended — this is what lets you keep liveness tight (10s period) without killing slow starters.
- **CPU at startup dominates everything.** Spring startup is aggressively parallel classloading and bean wiring; a pod throttled at `500m` boots 3–4× slower than one with 2 cores. Concrete guidance: request **at least 1 CPU** for any Spring Boot service, and if your cluster sets CPU limits, don't set the limit below 2 for services where deploy speed matters. If you're stuck with small requests, size the startup probe for the *throttled* reality, not your laptop. Why throttling hits the JVM this hard: [The JVM in Containers](/java/jvm-in-containers/).

## The image story: layers matter

A Spring Boot fat jar is 80–200MB where 95% is dependencies that change once a month and 5% is your code that changes ten times a day. Ship it as one `COPY app.jar` layer and every deploy re-pushes and re-pulls the whole thing; node image caches get nothing. Boot's layered-jar support fixes this. Two routes:

**Buildpacks** — `./gradlew bootBuildImage` (or the Maven equivalent): zero Dockerfile, layered automatically, memory-calculated JVM flags, CDS support. Great default if your CI can run it and you don't need OS-level customization.

**Hand-rolled multi-stage** — full control, and the pattern to know:

```dockerfile
FROM eclipse-temurin:21-jdk AS build
WORKDIR /app
COPY build/libs/app.jar .
RUN java -Djarmode=tools -jar app.jar extract --layers --destination extracted

FROM eclipse-temurin:21-jre
WORKDIR /app
# least → most volatile: only changed layers get pushed/pulled
COPY --from=build /app/extracted/dependencies/ ./
COPY --from=build /app/extracted/spring-boot-loader/ ./
COPY --from=build /app/extracted/snapshot-dependencies/ ./
COPY --from=build /app/extracted/application/ ./
USER 1000
ENTRYPOINT ["java", "-jar", "app.jar"]
```

A code-only change now pushes a few hundred KB instead of 150MB — faster CI, faster pod scheduling on cold nodes, happier registry.

Note the runtime stage is **JRE-only**: no `jmap`, no `jcmd`, no `jstack`. That's the right production choice, and it's exactly why this section documents getting heap and thread dumps without JDK tooling — see [Heap Dumps on JRE-only Images](/java/heap-dumps-jre-only/) before you need it at 3 a.m., not after.

## Common Spring-on-k8s failures, ranked

1. **Readiness flapping from a slow dependency indicator.** You added `db` (or worse, a custom indicator that calls a third-party API) to the readiness group; under load it exceeds the probe timeout, pods drop from endpoints, survivors get more load, *their* checks slow down — a self-inflicted cascade. Fix: strip slow indicators from readiness, or make the indicator cache its result.
2. **OOMKilled from default heap + tight limit.** Default `MaxRAMPercentage` is 25%; Spring's non-heap appetite (Metaspace, code cache, threads) eats the rest fast, or someone sets 75% and forgets non-heap entirely. Restart counter climbs, exit code 137. The sizing rules are in [The JVM in Containers](/java/jvm-in-containers/).
3. **"Connection reset" / stale connections from pool vs pod churn.** Hikari holds connections to a pod (PgBouncer, a proxy, another service) that got replaced; the first borrow after a deploy explodes. Set `maxLifetime` *below* any idle timeout in the path (e.g. `spring.datasource.hikari.max-lifetime: 240000` against a 300s proxy timeout) and keep `keepaliveTime` on.
4. **`spring-boot-devtools` in the prod image.** Restart classloader weirdness, disabled caching, an open LiveReload port. It's supposed to auto-disable in fully-packaged jars, but buildpack and exploded-layer setups have shipped it live. Make the build exclude it: `developmentOnly` configuration in Gradle, `<optional>true</optional>` in Maven — then verify it's absent from the image.
5. **No graceful shutdown = dropped requests on every deploy.** The most common and most fixable. Two properties and a preStop, as above. If your error-rate graph has a spike synced to every rollout, this is it.

## The reference Deployment, annotated

Everything above, assembled. Copy, adjust names, keep the comments.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
spec:
  replicas: 3
  selector:
    matchLabels: { app: orders-api }
  template:
    metadata:
      labels: { app: orders-api }
      annotations:
        # Checksum of the ConfigMap: config change => new template hash => clean rollout.
        # (Templated by Helm/Kustomize; the boring-but-reliable rotation pattern.)
        checksum/config: "{{ include (print $.Template.BasePath \"/configmap.yaml\") . | sha256sum }}"
    spec:
      # preStop(5) + spring graceful timeout(25) + context-close slack < 40. Math must hold.
      terminationGracePeriodSeconds: 40
      containers:
        - name: app
          image: registry.example.com/orders-api:1.42.0   # layered image, JRE-only runtime
          ports:
            - name: http
              containerPort: 8080        # application traffic
            - name: management
              containerPort: 8081        # actuator: probes + metrics, NOT on the ingress
          env:
            - name: SPRING_PROFILES_ACTIVE
              value: "prod"              # one image, per-env profile
            - name: JAVA_TOOL_OPTIONS    # heap % of container limit; details in jvm-in-containers
              value: "-XX:MaxRAMPercentage=60 -XX:+ExitOnOutOfMemoryError"
            - name: SPRING_DATASOURCE_URL   # relaxed binding -> spring.datasource.url
              valueFrom:
                configMapKeyRef: { name: orders-api-config, key: datasource-url }
          volumeMounts:
            - name: config-tree           # spring.config.import=optional:configtree:/etc/config/
              mountPath: /etc/config
              readOnly: true
          resources:
            requests:
              cpu: "1"                    # Spring boots 3-4x slower when throttled below this
              memory: 1Gi
            limits:
              memory: 1Gi                 # limit=request: no memory overcommit surprises
          startupProbe:                   # covers slow start; liveness suspended until it passes
            httpGet: { path: /actuator/health/liveness, port: management }
            periodSeconds: 5
            failureThreshold: 24          # 24 x 5s = 120s budget for a ~35s measured start
          livenessProbe:                  # livenessState ONLY - never external dependencies
            httpGet: { path: /actuator/health/liveness, port: management }
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:                 # readinessState (+db only if truly useless without it)
            httpGet: { path: /actuator/health/readiness, port: management }
            periodSeconds: 5
            failureThreshold: 3
          lifecycle:
            preStop:                      # hold SIGTERM until endpoint removal propagates
              exec:
                command: ["sh", "-c", "sleep 5"]
          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
            allowPrivilegeEscalation: false
      volumes:
        - name: config-tree
          projected:                      # ConfigMap + Secret merged into one configtree
            sources:
              - configMap: { name: orders-api-config }
              - secret: { name: orders-api-secrets }
```

And the matching application config:

```yaml
# application.yaml (baked into the image; env-specific values come from k8s)
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 25s
  config:
    import: "optional:configtree:/etc/config/"
management:
  server:
    port: 8081
  endpoints:
    web:
      exposure:
        include: health,prometheus,info
  endpoint:
    health:
      group:
        readiness:
          include: readinessState        # add ',db' only after reading the debate above
  tracing:
    sampling:
      probability: 0.1
logging:
  structured:
    format:
      console: ecs
```

:::tip
Deploy this, then verify the shutdown path once: `kubectl delete pod <pod>` while running a load test, and watch for zero errors. Five minutes of validation buys you confidence on every future rollout.
:::
