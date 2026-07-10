# Cold-Reader Evaluation: Autoscaling Playbook

**Reviewer:** Claude (cold read — no plan files or notes consulted)
**Date:** 2026-07-10
**Material:** `src/content/docs/autoscaling/` (16 pages) + `src/content/docs/labs/lab-10-autoscaling.md`
**Method:** Two personas (A: senior Java/Spring Boot developer with minimal Kubernetes; B: Java technical lead, risk-first skimmer), five in-character tasks, rubric-scored. All PromQL/link/arithmetic findings below were verified before reporting — including one suspected PromQL parse error that turned out to be **valid** (tested against promtool in a Prometheus container) and is therefore *not* a finding.

---

## 1. Verdicts

**Persona A — Senior Java developer: SUCCEEDS, unusually comfortably.** A1 took exactly one page: the quick-start's title self-selects from the sidebar, its gate is four copy-paste commands, and the recipe is two chart edits genuinely shippable by Friday — with every value's *reason and trade* written in the comments where they'd be pasted. A2 took three pages (overview → scenarios → signals catalog) and the diagnosis landed squarely in Java vocabulary: "a thread blocked on a 2-second query costs almost no CPU while consuming 1/200th of your entire capacity to accept work" is the sentence this persona would have written themselves, and the fix names `server.tomcat.threads.max`, `mbeanregistry`, and `hikaricp_connections_pending`, not abstract "saturation." **The single biggest friction:** the moment the reader outgrows CPU scaling, the real fix (thread-signal HPA) fans out across three pages (catalog → pipeline → Spring page) and terminates in a platform dependency (KEDA or adapter) — the docs are honest about that, but the "dev who wants to finish this week" hits a wall the quick-start's cheerfulness doesn't foreshadow. And in exactly the places where the persona would paste Java-side config (Rabbit listener shutdown, the web-tier RPS knob), the docs stop one property short of working — see findings 1 and 3.

**Persona B — Java technical lead: SUCCEEDS, and would assign this.** The overview's ways-in table has a literal "Reviewing another team's HPA PR" row; scenarios repeats it with an effort estimate ("20 minutes per review once you've read the checklist's links; the first one takes an evening" — which matches experience of docs that lie about this, i.e., it doesn't). The review checklist is a 13-item copyable text block, not prose, and for the B1 scenario (maxReplicas: 20 on an Oracle-backed API) it hands the lead exactly the right demands: derivation with a named DBA and ticket, pool-size-×-ceiling arithmetic, load test *with the autoscaler on*, graceful shutdown drilled not asserted. The skeptic sweep reads as: this section assumes the team is competent but unmeasured, and it respects their time (every page opens "You are here if:", every trade is priced, every number carries its ancestry). **The single biggest friction:** a burned lead spot-checks the flagship config — and finds the Oracle reference architecture's own memory limit fails the Spring page's own split math (finding 2). One arithmetic self-contradiction in the page you're told to copy costs disproportionate trust in a section whose whole brand is "every number has a derivation."

---

## 2. Findings table

| # | Severity | Page | Quoted passage | What the reader experiences | Suggested fix |
|---|---|---|---|---|---|
| 1 | **MAJOR** | `messaging-consumers.md:202` | `timeout-per-shutdown-phase: 30s # in-flight handlers get up to 30s` | A Java expert knows Spring AMQP's `SimpleMessageListenerContainer` stops waiting for workers after its **own** `shutdownTimeout` — default **5 s**, and there's no first-class Boot property; it needs a container-factory customizer. As written, the 30 s promise never reaches a `@RabbitListener` handler: a 20 s message gets cut at ~5 s and requeued anyway. This is precisely "stops where my real question starts" on the page's self-declared "heart" | Add the container `shutdownTimeout` (and the JMS `DefaultMessageListenerContainer` equivalent) to the handshake config, with the constraint chain: container timeout ≤ lifecycle phase ≤ tGPS |
| 2 | **MAJOR** | `rest-api-oracle.md:100` | `memory: 768Mi # heap 60% + non-heap budget (JVM page's split)` | 60 % of 768 Mi = ~460 Mi heap → ~307 Mi non-heap. The Spring page's own worked example prices 200 thread stacks at ~200 Mi and calls a ~256 Mi non-heap budget "a fleet-wide OOMKill lottery." 307 Mi minus 200 Mi of stacks leaves ~107 Mi for metaspace + code cache + buffers — under-water by the section's own arithmetic, in the config readers are told to copy | Either raise the example limit to 1 Gi (matching the Spring page's example) or lower `threads.max`/`MaxRAMPercentage` in the fragment and show the split math inline |
| 3 | **MAJOR** | `web-worker-and-caches.md:63` | `targetRPSPerPod: 45 # derivation: knee 60 rps/pod at p95→1s, ×0.75 lag headroom` | The value exists, but nothing consumes it: no template, no ScaledObject, no query. The take-away section offers the Oracle page's HPA (CPU-based — doesn't use RPS) or the pipeline's ScaledObject (busy-threads query, threshold 0.75 — not RPS 45). The RPS-per-pod path, this page's *chosen* signal, is left as an unmarked exercise | Add the prometheus-scaler trigger for RPS wired to `web.autoscaling.targetRPSPerPod` |
| 4 | MINOR | `quick-start.md:47` | "**3. Probes exist.** … `/actuator/health/readiness`" | Checks 1, 2, and 4 each state the failure action ("Empty … → stop"); check 3 shows only the happy output. A Friday-deadline reader with empty output has no explicit stop instruction on the one gate whose failure ships 502s | Add the same "empty → [prerequisites #3], stop" line |
| 5 | MINOR | `quick-start.md:112` | `enabled: true` (values.yaml) | Contradicts the governance page's golden values — `enabled: false # off by default: turning it on is a REVIEWED act` — and is redundant with the very next command's `--set autoscaling.enabled=true`. The section's own citizenship story says the values default should be off | Ship `enabled: false` in the pasted values; let the `--set` be the deliberate act (it's already there) |
| 6 | MINOR | `load-profile.md:46` | `…[14d:5m])` after "each label explained since this is the section's first big range query" | The annotation explains `rate`, `sum`, and the counter — and skips the one piece of syntax a PromQL-never reader can't guess: the `[14d:5m]` subquery. Same gap for `[7d:]`/`[1d:]` on the capacity page | One comment line: "`[14d:5m]` = evaluate the inner expression every 5 min across 14 days (a 'subquery')" |
| 7 | MINOR | `signals-catalog.md:212` | "# Graph all four; the leading signal is the one that moves first" | The "signal audit" code block contains only comments; the reader must assemble four queries with four different units (%, rps, ratio, seconds) into "one Grafana panel with a shared time axis" — which, unnormalized, is unreadable. The audit is the page's actionable payoff and it's the one thing not runnable | Provide the four queries verbatim (or a dashboard JSON link) and one sentence on normalizing/stacking mixed units |
| 8 | MINOR | `messaging-consumers.md:182` | "prefetched messages leave the queue's visible depth, so depth under-reports … by `prefetch × pods`" | True for MQ `CURDEPTH` and RabbitMQ `messages_ready` — but `rabbitmq_queue_messages` (the metric this very section's alerts use) **includes** unacked/prefetched messages. A lead verifying the claim against the alert two screens down finds an apparent contradiction | Name the metric split: `messages_ready` (excludes prefetched) vs `messages` (includes) and say which one KEDA's QueueLength reads |
| 9 | MINOR | `quick-start.md:113` | "`minReplicas: 3 # = today's replicaCount. NEVER lower on day one`" | A service running `replicaCount: 1` follows this literally and gets a floor of 1 — which the rest of the section calls "an outage with extra steps." The HA floor of 2 appears on four other pages but not here | Append "…(but never below 2 — one pod is an outage with extra steps)" |
| 10 | MINOR | `lab-10-autoscaling.md:514` | `watch -n2 'kubectl exec … valkey-cli -a labs-valkey-pw …'` | Every other step reads the password from the `valkey-auth` Secret; this one hardcodes it — it breaks silently for anyone whose Lab 9 password differs, and models password-in-argv | Read it from the Secret like step 8 does (`$(kubectl get secret valkey-auth -o jsonpath=…)`) |
| 11 | MINOR | `slos-for-scaling.md:39` | "Grafana's RED-style dashboards" | RED (Rate, Errors, Duration) is SRE jargon never expanded — one of very few terms in the section that isn't. Same page: "Recording-rule sketches" (line 150) uses "recording rule" cold | Expand each once, parenthetically |
| 12 | NIT | `quick-start.md:28` | `containers[*].resources.requests` | With a sidecar, the jsonpath prints two JSON objects run together with no separator; the gate's "empty or no cpu key" reading becomes ambiguous — and sidecar-bearing pods are exactly where request problems hide | Use the prerequisites page's per-container `{range}` form here too |
| 13 | NIT | `rest-api-oracle.md:50` | "A **connection pool** (HikariCP is Spring Boot's default) keeps a fixed set of database connections open and lends them to request threads" | This explains the reader's own home turf to them — an 8-year Spring dev tunes HikariCP in their sleep. Same pattern: "Micrometer is the metrics library inside Spring Boot Actuator" (pipeline page), the thread-pool explainer (catalog). All are one sentence and hedged, so it reads as inclusive rather than condescending — but it's the only direction the section ever over-explains | Fine to keep; if trimming, these three sentences are the cuts |
| 14 | NIT | `signals-catalog.md:154` | "metrics-server / cAdvisor" | cAdvisor appears once, in a table cell, never introduced. Likewise "Valkey speaks RESP" (`lab-10-autoscaling.md:430`) | Parenthetical or drop the term |

### Praise (page + quote, max 5)

1. `quick-start.md:113` — "floor-at-today means enabling the HPA cannot reduce your capacity, so the worst case of this whole exercise is 'nothing changes'." The single best anxiety-removal sentence in the section; it's *why* a skeptical dev ships this.
2. `lab-10-autoscaling.md:180` — "the HPA looks insane while doing arithmetic perfectly." The `-keepalive=false` note preempts the #1 way this experiment fails and connects it to a production ambush.
3. `messaging-consumers.md:193` — "and if that formula yields 10 minutes, your prefetch is too high — fix the input, don't request a 10-minute grace." Formula plus the anti-gaming clause; exactly how a reviewer thinks.
4. `signals-catalog.md:101` — "If you take one verdict from this page, take this one." The memory-ratchet box is the section's most valuable danger callout, and it's repeated on the Spring page with a *reason* for the repetition.
5. `rest-api-oracle.md:231` — "If you copy the numbers themselves, you've copied another team's database." Take-this-with-you blocks that police their own misuse are rare.

---

## 3. What I couldn't find

- **Reactive/WebFlux apps.** The thread-saturation signal — "the honest signal for most of this stack" — assumes servlet Tomcat. A Netty/Reactor service has no `tomcat_threads_busy_threads`; no page says what the wait-bound signal is there.
- **Virtual threads (Java 21+).** With `spring.threads.virtual.enabled`, the 200-thread pool ceiling and the 1 MiB-stack math both dissolve; a 2026 Java lead will ask, and the section (which knows Boot 3.3 CDS exists) is silent.
- **Sidecars vs. the HPA's CPU average.** Prerequisite #1 warns a request-less sidecar blinds the HPA, but nothing covers a *requesting* sidecar (service mesh proxy) diluting the utilization average, or the `ContainerResource` metric type that fixes it.
- **The knee measurement's Oracle problem.** The whole derivation chain rests on load-testing one pod to its knee — against what database? A pre-prod Oracle with 10 % of prod's data has a different knee. Prerequisite #8 requires pre-prod but never addresses representativeness.
- **Rollout surge × quota × HPA.** A deploy's `maxSurge` pods draw the same quota the scale-up needs; nobody says whether the review's Σ(max × requests) math should include surge.
- **What if the DBA can't give a number?** Every ceiling derivation assumes the external owner produces a budget. The "ask well" protocol exists, but there's no fallback for "the answer was a shrug" — measure it yourself? assume what?

---

## 4. Terminology gaps (rubric 4)

Terms Persona A wouldn't know that were **not** explained in one plain sentence at first use:

| Term | Where first hit | State |
|---|---|---|
| PromQL subquery `[14d:5m]`, `[7d:]` | load-profile, capacity | Never explained (finding 6) |
| RED (dashboards) | slos-for-scaling:39 | Never expanded (finding 11) |
| Recording rule | slos-for-scaling:150 | Named, not defined |
| cAdvisor | signals-catalog table | Never introduced |
| RESP | lab-10 | Never expanded |
| "knee" | signals-catalog (RPS entry) | Defined only implicitly ("what one pod can handle at acceptable latency") — workable but a plain "the load level where latency bends upward" would land it |
| MQSC / `CURDEPTH` | signals-catalog | Half-explained ("in MQSC terms") |
| Preemption | capacity-and-governance | One clause + link; borderline |

Everything else braced for was handled: *request* (defined 3×, consistently), SLI/SLO/SLA (one sentence each), p95 (twice, memorably: "your unluckiest 1-in-20 user"), error budget ("~7 hours of slow-or-failing checkout allowed per month"), burn rate ("spending the error budget too fast"), ServiceMonitor, allocatable, `le`, ScaledObject/TriggerAuthentication, prefetch, OneAgent — all explained in place, most with a "what to do about it" attached. This is the strongest terminology discipline I've seen in internal docs.

**Condescension:** three spots explain Java to a Java dev (finding 13) — all one sentence, all hedged; a smirk, not an eye-roll.

**PromQL burden (rubric 5): 4/5.** Nearly every query carries a plain-words statement of what it answers and a decide-table or "Healthy / If not" column saying what to do with the result — Persona A could *use* every query in the quick-start's watch table without being able to write one. The two failures: the subquery syntax (finding 6) and the signal audit's assemble-it-yourself panel (finding 7). The percentile query is taught properly once (pipeline page, "read it inside-out") and pages before it honestly defer rather than fake-explain.

---

## 5. Rubric scores

| # | Criterion | A | B | Evidence in one line |
|---|---|---|---|---|
| 1 | First-60-seconds orientation | 5 | 5 | Ways-in table row for both personas; both entries worked first try; three redundant ways in (role, symptom, artifact) |
| 2 | Mental-model match | 5 | 5 | The gate greps *my* `src/main/java`; fixes are `application.yaml` before YAML. Lead finds trades, failure-mode tables, and effort estimates exactly where skimming lands |
| 3 | Depth in Java territory | 4 | — | Deepest: prefetch/grace arithmetic; MaxRAMPercentage split with thread-stack math; cold-pod herd + behavior tuning. Shallowest: Rabbit/JMS container shutdown internals (finding 1); "pool-fill responds to pool warmup config" — which config is never named; startup levers compressed to one paragraph (acknowledged) |
| 4 | Terminology | 4 | 5 | See §4; discipline is excellent, gaps are peripheral |
| 5 | PromQL burden | 4 | — | See §4 |
| 6 | Actionability | 5 / 4 | 5 | A1: paste-ready. A2: diagnosis 5, fix 4 (three-page fan-out + platform dependency). B1: the checklist is the artifact |
| 7 | Trust | 4 | 4 | See below; the flagship-config arithmetic slip (finding 2) taxes trust beyond its size |

**Claims taken on faith:** the cast's measured numbers (60 rps knee, 40/20 msg-min drains) — clearly labeled illustrative and always marked "say the knee lands at…", so honest; Lab 10's console outputs (192 % at 120 qps depends on the rig — the lab hedges "the lesson is the wall, not the number"); "~70 bucket series" per histogram endpoint; "CDS cuts context time meaningfully" (no number); Dynatrace DQL-variant token scopes and the 1–2 min ingest latency (authority link given, at least); "MQ admin REST frequently not enabled on-prem"; failover headroom "≈ 4 pods' pools" (mechanism explained, sizing not derived); Lettuce per-node connections against Redis Cluster (~6×).

For balance: the cold-pod detector PromQL (`spring-boot-scaling.md:171`) was adversarially checked expecting a parse error (`2 * on() group_left()` with a scalar operand) and it **parses and evaluates cleanly** under promtool; and all 29 cross-page links plus every same-section anchor followed resolve to real pages and headings.

---

## 6. Reading-order verdict

The sidebar order is defensible but platform-shaped in one spot. For a Java team, assign:

1. **overview** → 2. **quick-start** (do it on a low-stakes service) → 3. **Lab 10** (feel it — the lab is buried in another sidebar section; surface it here) → 4. **prerequisites** → 5. **classify-your-app** → 6. **spring-boot-scaling** ← *moved up from 10th; it's the team's home turf, it builds trust, and it motivates everything the signals catalog then says* → 7. **slos** → 8. **load-profile** → 9. **signals-catalog** → 10. **getting-the-metrics** → 11. *your archetype page only* → 12. **cheat-sheet** (pin it).

Leads additionally: **capacity-and-governance** (checklist first, invariant second) before their first review. **scenarios** and **dynatrace-signals** are lookup pages, not reading; don't assign them.

---

## 7. Task journals (appendix)

**A1 — deadline entry.** Entered: sidebar title list only → "The 15-Minute Conservative HPA" (obvious; only time-boxed title). Read it start to finish, no jumps needed. Gate: 4 commands, ran mentally against our chart — check 4's `grep @Scheduled` genuinely anticipated my question ("wait, our nightly report…"). Paste-list: the `{{- if not }}` replicas guard, `templates/hpa.yaml`, the values block (renaming `payments-api.fullname` to our helper — stated once at top, would've liked a reminder at the include). Confusion moments: none fatal; check 3's missing fail-action (finding 4), and `enabled: true` + `--set enabled=true` made me pause ("which one is load-bearing?"). Could I ship safely by Friday? **Yes.** Time to first useful answer: **1 page.**

**A2 — incident entry.** Entered: section root (overview). The ways-in table's first row is literally my situation → scenarios → first heading is my sentence ("My API slows down every lunchtime") — and its second sentence already names the diagnosis ("it's usually threads waiting on Oracle, not CPU"). Followed to signals-catalog → CPU entry's Decide paragraph ("traffic doubles, latency climbs, and CPU *stays low* — your app spends its time **waiting**") is the explanation, in my vocabulary (threads, Oracle, blocking). Fix: thread-ratio signal → wiring on the Spring page → ScaledObject on the pipeline page. Gave up: never; but the fix required 3 pages and ends at "ask platform for KEDA." Time to explanation: **3 pages.** Vocabulary verdict: **mine, not ops'.**

**A3 — code-depth probe.** Interrogated: probes block (correct, incl. liveness-must-not-check-deps — a trap I've personally hit), MaxRAMPercentage split (arithmetic checks out: 1 Gi × 60 % = 614 Mi; 200 × 1 MiB stacks correct for default `-Xss`), `mbeanregistry.enabled` (correct, and genuinely obscure — I learned it), Hikari fixed-pool `minimum-idle = maximumPoolSize` (correct, matches Hikari's own guidance), CDS in Boot 3.3 (correct), `@Cacheable(sync=true)` as single-flight (correct, and honest that it's per-pod). Smirk moments: the Rabbit shutdown 30 s claim (finding 1 — this is the one place I *knew* more than the page); the Oracle page's 768 Mi limit (finding 2 — checked it against the page that taught me the math 20 minutes earlier); "pool warmup config" named but never specified. Explained-what-I-know moments: finding 13's three sentences. Net: **I learned things (mbeanregistry, prefetch-as-blast-radius, the cold-pod herd mechanism), which almost never happens in ops docs.**

**B1 — review entry.** Entered: overview ways-in table → "Reviewing another team's HPA PR" → capacity-and-governance. Jumped straight to "The review checklist" (skimmed headings to find it; scenarios' direct anchor would've been faster — noted both routes work). For the maxReplicas: 20 Oracle PR my demands, straight off the checklist: derivation naming the session budget + DBA + ticket date; `maximum-pool-size` shown as the partner number; classification card; load test with autoscaler enabled; the ledger delta. The Oracle page's "pool math" gave me the arithmetic to check the 20 myself: 20 × pool 10 = 200 sessions — against whose budget? That's the PR comment, written for me. **Checklist, not prose: yes.** Time: **2 pages.**

**B2 — skeptic sweep.** Skimmed all 16: headings, tables, callouts, code comments. Opinion of my team: capable, unmeasured, over-trusting of defaults — accurate and never sneering; the "citizenship" framing moralizes slightly but earns it with arithmetic. Respects time: "You are here if" on every page, effort estimates on scenarios, every trade priced in you-gain/you-pay tables. Over-explains: only the Java one-liners (finding 13). Hand-waves: the signal-audit panel (finding 7), the RPS web-tier scaler (finding 3), "the DBA will give you a number" (couldn't-find list). Would I assign it: **yes, in the §6 order.** The tell that won me over: the section repeatedly tells you what it *doesn't* do — the quick-start's "what this deliberately doesn't do" box and the lab's closing "what the lab deliberately left out" are the two most credibility-buying blocks in the whole thing.
