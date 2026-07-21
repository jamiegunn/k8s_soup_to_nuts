# Copilot Review As Java Person

Cold-reader evaluation of the Autoscaling Playbook, performed on 2026-07-10.

Scope honored: read only `src/content/docs/autoscaling/` plus `src/content/docs/labs/lab-10-autoscaling.md`, with `astro.config.mjs` only for sidebar orientation.

## Persona A Verdict — Senior Java Developer

The senior Java developer would mostly succeed, and probably faster than they expected. The section repeatedly translates autoscaling into their files: `application.yaml`, Helm values, HikariCP, Tomcat threads, Actuator, probes, `@Scheduled`, and listener shutdown. Biggest friction: the docs still make them cross a PromQL/Kubernetes abstraction gap at the exact moment they want "tell me what to paste and what can hurt Oracle." Quick Start is good, but its copy-paste command and placeholder ceiling need stronger production-safe rails.

## Persona B Verdict — Java Technical Lead

The Java technical lead would succeed and would trust the section more than most vendor-style autoscaling docs. The governance page gives a real PR review artifact, and the reference architectures make `maxReplicas` a derivation rather than a vibe. Biggest friction: the section sometimes asks the lead to accept operational thresholds and PromQL snippets without enough derivation or validation, especially in capacity observability and "golden" defaults.

## Rubric Scores

| Rubric | Persona A | Persona B |
|---|---:|---:|
| First-60-seconds orientation | 5 - Overview and titles route directly to "Friday," "lunch slowdown," and "is my app ready." | 5 - Overview links "reviewing another team's HPA PR" directly to governance. |
| Mental-model match | 4 - Strong app-first framing, especially chart and Spring pages; PromQL still interrupts. | 5 - Risk, ceiling math, ledger, and PR checklist are where a lead would look. |
| Depth in Java territory | 4 - Deep on Hikari, Tomcat, probes, JVM memory, listeners; a few snippets/claims need tightening. | 4 - Credible enough for review, but some Java claims need more exactness. |
| Terminology handling | 4 - Most terms get plain explanations; gaps remain for `behavior`, CRD, PromQL pieces, burn rate. | 4 - SRE terms are usually handled, but some review-critical terms are linked rather than defined. |
| PromQL burden | 3 - Many queries explain "what it answers," but cheat-sheet/top queries assume too much. | 4 - Lead can skim and delegate, but still needs query confidence before approving alerts. |
| Actionability | 5 - Ends with chart edits, commands, values, checks, and lab practice. | 5 - Ends with a pasteable review checklist and required artifacts. |
| Trust | 4 - Most claims have rationale; some numbers and code snippets need proof or safer caveats. | 4 - High trust overall, lowered by a few unvalidated defaults and one broken Java snippet. |

## Findings

| severity | page | quoted passage | what the reader experiences | suggested fix |
|---|---|---|---|---|
| BLOCKER | `src/content/docs/autoscaling/quick-start.md` | `helm upgrade payments charts/payments-api -n payments --set autoscaling.enabled=true` | Persona A will copy this in a real release. Without `--reuse-values` or an explicit values file, Helm can reset existing user-supplied values. This is the scariest bug in the "ship it" path. | Change to `helm upgrade payments charts/payments-api -n payments --reuse-values --set autoscaling.enabled=true`, or show the safer `-f values-prod.yaml` form and explain why. Lab 10 already uses `--reuse-values`; align Quick Start. |
| BLOCKER | `src/content/docs/autoscaling/getting-the-metrics.md` | `private final Counter ordersCompleted; { ordersCompleted = Counter.builder("orders_completed_total").register(registry); }` | The custom Micrometer example does not compile: `registry` is constructor-scoped but used in an instance initializer. A Java dev copy-pasting this loses trust fast. | Initialize `ordersCompleted` in the constructor: assign the `Counter` after the `Gauge.builder(...)` block. |
| MAJOR | `src/content/docs/autoscaling/quick-start.md` | `maxReplicas: 6 # = today x 2. A borrowing limit, not a plan.` | For an Oracle-backed service, this is the one number that can hurt other teams. The page warns about it, but still lets a deadline-driven dev ship a placeholder without a minimal session-budget check. | Add a tiny "before enabling on Oracle/MQ/Redis" ceiling gate: `current replicas x pool`, `proposed max x pool`, budget owner, yes/no. Make placeholder max acceptable only when the quick ceiling check passes. |
| MAJOR | `src/content/docs/autoscaling/rest-api-oracle.md` | `minimum-idle: 10 # fixed-size pool: fail at startup, not at peak.` | A Java expert may pause here. `minimum-idle=max` helps, but "fail at startup" depends on Hikari initialization behavior, DB availability, timeout settings, and readiness design. | Add the exact Hikari setting/behavior expected, for example `initializationFailTimeout`, plus a readiness check note proving the pool can acquire connections before traffic. |
| MAJOR | `src/content/docs/autoscaling/capacity-and-governance.md` | `sum by (namespace) ( kube_horizontalpodautoscaler_status_desired_replicas * ... avg by (namespace) (kube_pod_container_resource_requests{resource="cpu"}) )` | Persona B cannot safely use this as a "funded claims" query. Averaging requests by namespace and multiplying by HPA desired replicas can be wrong when multiple workloads have different pod sizes. | Mark it as a sketch, or provide a robust recording-rule pattern that joins HPA target deployment to that deployment's pod template/request. |
| MAJOR | `src/content/docs/autoscaling/scenarios.md` | `Path: prerequisites -> SLO -> signals catalog ... -> REST API + Oracle.` | For A2, the scenario names the right diagnosis, but routes the incident reader through SLOs before the explanation/fix. A dev with "CPU fine, service slow" wants the threads/Hikari explanation immediately. | In the lunchtime scenario, add "First useful answer" inline: CPU fine + latency high usually means busy threads or pool waits; check `tomcat_threads_busy_threads` and `hikaricp_connections_pending`, then follow the full path. |
| MAJOR | `src/content/docs/autoscaling/cheat-sheet.md` | `## Top-5 PromQL` | Persona A sees five dense queries with almost no "what this answers" or "what I do next." This undercuts the otherwise strong "no PromQL assumed" posture. | Add a one-line purpose and action under each query, matching the better tables elsewhere. |
| MAJOR | `src/content/docs/autoscaling/messaging-consumers.md` | `Handlers must be idempotent - dedup on a business key, upsert instead of insert, check-before-send on external effects` | Correct, but this stops where a senior Java dev's real review starts: transaction boundaries, ack timing, listener container settings, DLQ/redelivery policy, and how to prove idempotency. | Add a short Spring-specific "idempotency proof" checklist for `@JmsListener` and `@RabbitListener`, including ack mode, transaction boundary, dedup store, and redelivery test. |
| MAJOR | `src/content/docs/autoscaling/dynatrace-signals.md` | `decide your fallback replicas before the outage` | The page repeatedly says fallback matters, but does not give a concrete `fallback:` YAML block on the Dynatrace scaler page. | Add a minimal fallback example and explain how to pick fallback replicas for stale Dynatrace/WAN failure. |
| MINOR | `src/content/docs/autoscaling/spring-boot-scaling.md` | `The HPA adds a pod in about 30 seconds. Your Spring Boot pod becomes useful 90 seconds later.` | This is memorable, but too absolute. Image pulls, scheduling, startup, lazy init, DB connection, and JIT vary widely. | Rephrase as "measure yours; example timeline," then show the command/query to measure startup-to-ready and ready-to-useful. |
| MINOR | `src/content/docs/autoscaling/load-profile.md` | `A ratio of ~1.08 = +8%/quarter -> use ~1.15 as a two-quarter growth margin` | The growth margin is plausible, but the derivation is not visible. A lead will ask why two quarters of 8% becomes 15% rather than 16.6% or a policy margin. | Add the explicit formula or say "rounded policy margin." |
| MINOR | `src/content/docs/autoscaling/prerequisites.md` | `grep -rn "@Scheduled\|@EnableScheduling" src/main/java/ | head -3` | This fits a simple service repo, but many teams have generated code, Kotlin, multiple modules, or scheduling hidden in dependencies/config. | Add "this is a first pass, not proof" and include Kotlin/multi-module hints or recommend IDE/code search for `@Scheduled`, `SchedulingConfigurer`, Quartz beans. |
| MINOR | `src/content/docs/autoscaling/getting-the-metrics.md` | `labels: release: monitoring # must match the label your Prometheus selects on` | Good warning, but Persona A may not know how to discover the required selector. | Add the command to inspect the Prometheus `serviceMonitorSelector` or tell them what to ask platform for verbatim. |
| NIT | `src/content/docs/autoscaling/capacity-and-governance.md` | `every unchecked box is a conversation, not a rejection` | Nice culturally, but some boxes are hard blockers: idempotency, external ceiling math, load test, metrics pipeline. | Split checklist items into "blocking before merge" and "follow-up allowed only with explicit risk acceptance." |

## Praise, With Evidence

- `src/content/docs/autoscaling/overview.md`: `Find your way in. Nobody reads a playbook cover to cover:` - excellent cold-reader routing.
- `src/content/docs/autoscaling/signals-catalog.md`: `CPU will sit there reading 30% while your thread pool suffocates.` - exactly Persona A's vocabulary.
- `src/content/docs/autoscaling/classify-your-app.md`: `a scheduled job living inside a horizontally-scaled API is a passenger who grabs the wheel.` - vivid, correct, memorable.
- `src/content/docs/autoscaling/messaging-consumers.md`: `terminationGracePeriodSeconds >= preStop + (prefetch x worst-case per-message time) + margin` - concrete and reviewable.
- `src/content/docs/autoscaling/capacity-and-governance.md`: `AUTOSCALING REVIEW - <service> <date>` - the section becomes operational here.

## What I Couldn't Find

- A safe mini Oracle/MQ/Redis ceiling check inside Quick Start before enabling `maxReplicas: today x 2`.
- A filled example PR containing classification card, state table, values comments, and review checklist.
- A Spring-specific idempotency proof for listeners: ack mode, transactions, dedup table, redelivery test, DLQ policy.
- A copyable Dynatrace/KEDA `fallback:` example.
- A robust capacity-ledger query that correctly sums each workload's `maxReplicas x actual pod requests`.
- A clear way for Persona A to discover the correct `ServiceMonitor` selector without already knowing Prometheus Operator internals.
- A code-level graceful shutdown example for `@JmsListener` / `@RabbitListener`, beyond the conceptual lifecycle and properties.

## Terminology Gaps

Persona A likely would not know these at first hit, and the first use does not always explain them in one plain sentence:

- `CPU request` in Quick Start: explained well in Overview/Prerequisites, but Quick Start's first gate uses it before defining it in-place.
- `behavior:` block: Quick Start says no behavior block and links away; a one-sentence HPA behavior definition would help.
- `CRD`: Prerequisites uses `kubectl get crd scaledobjects.keda.sh` without defining CustomResourceDefinition.
- `ScaledObject`: used heavily in KEDA contexts; explained in cheat sheet, but not always at first task-oriented entry.
- `TriggerAuthentication`: explained later in pipeline, but appears in YAML-heavy KEDA pages where a Java dev may enter directly.
- `ScalingLimited`: scenarios and lab use it; lab explains it well, scenarios does not.
- PromQL parts in early queries: `histogram_quantile`, `rate`, `sum by (le)`, and `le` are explained well in Getting the Metrics, but Quick Start exposes the p95 query before that explanation.
- `burn rate`: SLO page says alert on burn rate, but the phrase needs a one-sentence definition there.
- `knee`: used as a central sizing concept; generally inferable, but should be defined once as "the load point where latency starts rising sharply."

I did not find explanations that were meaningfully condescending to Java knowledge. The "what is a connection pool" and percentile material is basic for many senior devs, but it earns its keep by connecting familiar concepts to autoscaling math.

## Reading-Order Verdict

I would not assign the team the sidebar order exactly. I would split by role.

For application developers shipping a first HPA:

1. `src/content/docs/autoscaling/overview.md`
2. `src/content/docs/autoscaling/quick-start.md`
3. `src/content/docs/autoscaling/prerequisites.md`
4. `src/content/docs/autoscaling/classify-your-app.md`
5. `src/content/docs/autoscaling/signals-catalog.md`
6. `src/content/docs/autoscaling/spring-boot-scaling.md`
7. Their reference architecture: Oracle, messaging, or web/worker
8. `src/content/docs/labs/lab-10-autoscaling.md`

For technical leads/reviewers:

1. `src/content/docs/autoscaling/overview.md`
2. `src/content/docs/autoscaling/capacity-and-governance.md`
3. `src/content/docs/autoscaling/classify-your-app.md`
4. `src/content/docs/autoscaling/load-profile.md`
5. `src/content/docs/autoscaling/slos-for-scaling.md`
6. `src/content/docs/autoscaling/signals-catalog.md`
7. Relevant reference architecture
8. `src/content/docs/autoscaling/cheat-sheet.md`

## Task Journals

### A1 - Dev, Deadline Entry

Entry from page list only: I picked "The 15-Minute Conservative HPA" because the title exactly matches "enable autoscaling by Friday."

Jumps: Quick Start -> Prerequisites link for requests/probes -> classify link for `@Scheduled` if grep hits -> Oracle link for real ceiling.

Confusion quote: `maxReplicas: 6 # = today x 2. A borrowing limit, not a plan.` This is clear as a warning, but unclear as a production go/no-go for an Oracle-backed app.

Anticipated question: `Here is the smallest setup that won't hurt anyone` plus the four-command gate was exactly what I wanted.

First useful answer: 1 page.

Could I ship safe by Friday? Yes, if the gate passes and I add a minimal dependency ceiling check. I would not approve the raw Helm command as written.

What I would paste, with safer command discipline:

```yaml
# templates/deployment.yaml
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
```

```yaml
autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 6
  targetCPU: 70
```

Then I would add the HPA template from Quick Start, but deploy with `helm upgrade ... --reuse-values --set autoscaling.enabled=true`, and I would replace `maxReplicas: 6` with a value checked against Hikari/MQ/Redis limits if the service has any external dependency.

### A2 - Dev, Incident Entry

Entry: colleague links section root.

Jumps: Overview -> Scenarios -> "My API slows down every lunchtime" -> Signals Catalog -> REST API + Oracle -> Spring Boot page.

Moment that landed: `it's usually threads waiting on Oracle, not CPU`. This is exactly my vocabulary.

Moment of friction: the scenario path sends me to SLOs before the "CPU fine but slow" technical explanation.

First useful answer: 2 pages, because Scenarios states the likely diagnosis. First actionable fix: 3 pages, at Signals.

Diagnosis verdict: it lands in Java vocabulary: Tomcat busy threads, Hikari pending connections, blocking I/O, Oracle session ceilings. The ops vocabulary is present, but I do not have to translate the core idea.

### A3 - Dev, Code-Depth Probe

Deepest moments:

- Hikari pool math: `maxReplicas x maximumPoolSize <= your session budget - failover headroom`.
- Tomcat thread saturation: blocked request threads as the leading signal for wait-bound Spring apps.
- RabbitMQ prefetch and shutdown math: prefetch directly becomes scale-in blast radius.

Shallowest or smirk-worthy moments:

- The custom Micrometer `Counter` snippet does not compile.
- `minimum-idle: 10` is described as "fail at startup" without enough Hikari initialization detail.
- Listener idempotency is correct but stops before Spring ack/transaction/redelivery mechanics.

Over-explaining Java? Not much. The docs explain connection pools and percentiles, but mostly to tie them to autoscaling math. That is acceptable.

### B1 - Lead, Review Entry

Entry: from page list I picked "Capacity, Quotas, and Rolling Autoscaling Out to Teams."

Jumps: Capacity review checklist -> Oracle pool math -> Load Profile -> Signals.

First useful answer: 1 page.

What I would demand before approving `maxReplicas: 20` on an Oracle-backed API:

- Classification card attached and safety audit passed.
- State table with low, steady, peak, burst, growth.
- Per-pod capacity measurement.
- Oracle session budget from DBA, including failover headroom and other consumers.
- `20 x maximumPoolSize` shown to fit the session budget.
- Signal justified, especially if CPU is used.
- Load test with autoscaler enabled.
- Graceful shutdown under load.
- Metrics pipeline and alerts.
- Ledger delta fits namespace quota.
- `priorityClassName` justified by SLO tier.

Did I find a checklist? Yes. The governance checklist is usable verbatim. I would only make it stricter by marking blockers.

### B2 - Lead, Skeptic Sweep

Sweep style: headings, tables, callouts, code comments across all 16 autoscaling pages plus Lab 10.

What is the section's opinion of my team's competence? It assumes the team is competent but busy, and that they need artifacts more than theory. It is firm about bad defaults without sounding like it distrusts developers.

Does it respect time? Mostly yes: routing tables, scenario page, quick start, summary tables, and review checklist are strong. The repeated "citizenship" and "fixed pool" lesson is a little heavy, but probably intentionally so.

Where it over-explains: repeated external ceiling theme, repeated HPA/KEDA boundary, some percentile basics.

Where it hand-waves: production-safe Quick Start ceiling, robust capacity ledger query, Spring listener idempotency proof, Dynatrace fallback YAML.

Would I assign it? Yes. I would assign by role, not sidebar order, and I would ask the author to fix the two blocker copy-paste issues before broad rollout.
