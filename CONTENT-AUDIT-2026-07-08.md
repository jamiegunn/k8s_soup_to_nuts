# Content Audit — K8s Soup to Nuts

**Date:** 2026-07-08 · **Scope:** all 211 content pages (~482k words), read in full by nine section reviewers plus a site-wide gap analysis and automated link check. **Evaluation persona:** a rookie/junior engineer entrusted with managing a Kubernetes cluster.

---

## Verdict

The prose quality, technical accuracy, and internal cross-linking are already top-tier — reviewers repeatedly rated sections "unusually strong" and "best-in-class" (tuning/, promql-for-resources, template-language, external-database, the labs' pedagogy). The gap between this site and "best in the world" is **not writing quality**. It is five systemic, fixable deficits:

1. **Diagrams: 6 Mermaid diagrams across 211 pages** (all in 3 files), while dozens of pages carry ASCII art or prose "flowcharts in words" begging for conversion. The site built self-hosted Mermaid rendering and then barely used it.
2. **Authoritative links: ~109 external links site-wide, with essentially zero to kubernetes.io** (3 total). Whole sections (operations/ — 14 files, workloads/, stateful/) have no external links at all. Internal linking, by contrast, is excellent: 3,195 internal links, zero broken.
3. **Copy-paste correctness bugs** — a small number of examples that fail verbatim, which is fatal for a site whose explicit contract is "expected output shown, commands work." The labs have genuine continuity breaks.
4. **Audience tension** — the site *explicitly* excludes the cluster-owner persona ("Not a cluster administration guide… If you also run the cluster, you need more than this site"). The rookie who owns the cluster hits a mirror at every "ask your platform team."
5. **Navigation debt** — orphan pages, sidebar `order:` collisions, and overview tables that don't list their own section's pages.

---

## P0 — Correctness bugs (fix first; these break trust)

| # | Location | Bug |
|---|---|---|
| 1 | labs 1–3 (+4,5,7,8) | **Lab continuity break:** Labs 1–2 build `labs/OrdersApplication.java` (data ids 1,2,3); Lab 3 says "Replace `com/example/orders/OrderController.java`" — a file that never existed, new package, new data (1001–1003). Verbatim readers get 404s or duplicate-mapping startup crashes. Labs 4/5/7/8 depend on the Lab-3 shape. |
| 2 | labs 3, 7 (`ci-local.sh`) | `kubectl port-forward svc/orders-api 8088:8080` fails — the Service port is **80** (Lab 1 values). Lab 7's deliverable script fails its own final rung. |
| 3 | labs 1, 4, 5 | `--set probes.readiness.path=/nope` breaks: Lab 1 defined `probes.readiness` as a **string**, so the override renders `path: map[...]` and fails API validation instead of demonstrating endpoint drain. Restructure Lab 1 values to nested `path:` keys. |
| 4 | architectures/rabbitmq.md | Verification Job args are comma-joined YAML scalars (`- --producers, "2", --consumers, "2"`) — the flagship drill fails as pasted. Also unpinned `perf-test:latest`. |
| 5 | architectures/front-door.md | Wildcard Certificate references an issuer that "requires the DNS-01 solver," but the only ClusterIssuer shown has HTTP-01 only — issuance fails as applied. |
| 6 | start/rbac-explained.md (~line 151) | Claims the API **rejects** `create` + `resourceNames` — it doesn't; the rule is accepted and silently never matches. The current text invents a safety validation that doesn't exist. |
| 7 | troubleshooting/node-problems.md (~line 138) | `kubectl get pods -o wide \| awk '{print $8}'` prints the wrong column (NODE is $7, and $9 when RESTARTS renders as `6 (45s ago)`). Use `-o custom-columns=NODE:.spec.nodeName`. |
| 8 | helm/lifecycle-and-operations.md (~line 125) | Closing code fence has prose on the same line — the block never closes; the hook-delete-policies and stuck-release sections render inside a yaml block. |
| 9 | observability/tracing.md | Java-agent example points OTLP at `:4317` (gRPC) with no `OTEL_EXPORTER_OTLP_PROTOCOL`; agent 2.x defaults to http/protobuf:4318 — the example silently exports nothing, the exact failure the page's own troubleshooting lists. Also unpinned `latest` agent download. |
| 10 | java/actuator.md | `management.sanitize.additional-keys-to-sanitize` is not a real property — should be `management.endpoint.env.additional-keys-to-sanitize`. |
| 11 | sidecars/recipes.md (Recipe 2) | Stock `nginx:1.27` can't run `runAsUser: 101` (port 80, pid file), and `pkill -HUP -f '^/usr/sbin/nginx'` matches nothing (nginx rewrites its process title). Silent no-op — the failure mode the recipe itself warns about. |
| 12 | ci/reusable-workflows.md | Golden workflow **scans after push** while its comment and `cicd-pipeline-design.md` Stage 3 mandate scan-before-push. Reorder (`push: false, load: true` → scan → push). |
| 13 | dotnet/operational-endpoints.md | `Metrics__Providers__0__ProviderName` lacks the `DotnetMonitor_` env prefix used everywhere else — likely won't bind. |
| 14 | networking/ingress-nginx.md | No mention of the ingress-nginx project retirement (announced Nov 2025); "most clusters you'll ever touch" framing is now materially misleading. Add status callout + Gateway API pointer. |
| 15 | Smaller errata | keda-autoscaling drill targets port 9092 that the Strimzi build never exposes (TLS-only 9093) + name/image mismatches; `istioctl x describe` → `istioctl describe`; JKS trustStoreType flag contradicts the page's own PKCS12 advice (tls-and-corporate-cas); `/12` inferred from `10.96.0.1` (cluster-networking ×2, not inferable); AWS legacy `internal` annotation vs LB-controller `scheme`; cgroup-v2 `memory.oom.group` kills whole container (oomkilled + requests-limits phrasing); duplicate-key `readinessProbe` YAML (health-checks); "tain" typo (gpu); `bitnami/kubectl` image post-Broadcom (cost-and-rightsizing); verify `ghcr.io/jattach/jattach:v2.2` exists; verify in-place-resize "stable 1.35" claim; heap/thread-dump pages disagree on jattach size (30 KB/50 KB/"under 1 MB"). |

## P1 — Structural / navigation debt

- **Orphan pages/sections:** `ci/github-actions-deep-dive.md` has **zero inbound links** (not even ci/overview's map, which still says "these four articles"); the entire `cluster-networking/` section has zero inbound links from networking/ or routing/.
- **Sidebar `order:` collisions:** java (jattach-deep-dive vs heap-dumps-jre-only, both 4), workloads (pod-security vs securing-pods-best-practices, both 16), architectures (order 3 ×3 pages, order 4 ×2), ci (github-actions vs deep-dive, both 2), labs (lab-9 vs from-lab-to-prod, both 11).
- **Overview tables that omit their own pages:** architectures/overview misses 3 of 4 Valkey pages; labs/overview doesn't know Lab 9 exists ("nine labs", table, timing budget); workloads/overview omits securing-pods-best-practices and contradicts sidebar order; dotnet/overview omits operational-endpoints.
- **Blog:** two near-identically titled posts ("The Migration Job That Ran Twice" / "The Migration That Ran Twice") read as accidental duplicates — retitle one and cross-link as a pair. Two posts have zero internal links (migration-job, oracle). Oracle post uses GitHub `> [!TIP]` syntax that renders literally in Starlight.
- **Duplication to consolidate:** high-availability.md re-explains graceful shutdown it claims to have delegated; how-kubectl-works.md "Changing contexts" repeats commands from 30 lines earlier; coredns-deep-dive duplicates nodelocal-dnscache without linking it; github-actions.md ↔ deep-dive share near-verbatim permissions/concurrency/act material.
- **Reading-order contradictions:** networking/overview's article map vs sidebar vs "start with…" sentence; learning-paths Track 1 vs start/overview's stated order; start/overview's "six articles… remaining three" in a 10-page section.
- **solutions-index.md:** ~20 rows misfiled under "Debug a broken pod."

## P2 — Mermaid diagram pass (~40 candidates identified; top 15 by value)

1. its-slow.md — the section literally titled "The flowchart, in words" (pure transcription)
2. life-of-a-request.md — 8-hop sequence diagram (currently dense ASCII that will overflow mobile)
3. service-unreachable.md — the 12-hop chain with red failure exits per hop
4. how-kubernetes-works.md — control-plane ASCII → flowchart, + the reconcile loop (observe→compare→act)
5. life-of-a-deployment.md — pipeline with failure-signature branches (Forbidden, FailedScheduling, ImagePullBackOff…)
6. rbac-explained.md — Subject → Binding → Role → rules
7. workloads/overview.md — Deployment→ReplicaSet→Pod ownership
8. health-checks.md — probe lifecycle state machine (startup gate → readiness/liveness in parallel)
9. graceful-shutdown.md — the T0 two-path race (convert ASCII to sequence diagram)
10. kafka-strimzi.md — advertised-listener bootstrap-then-direct sequence (mirrors the Valkey MOVED diagram)
11. postgresql-ha.md — failover topology + operator-promotes sequence
12. metrics.md — scrape→store→query→alert pipeline (incl. kube-state-metrics/cAdvisor)
13. jvm-in-containers.md + dotnet-in-containers.md — twin "RSS budget vs container limit" stacked boxes (ASCII exists)
14. cicd-pipeline-design.md — 9-stage pipeline + digest-forward promotion flow
15. gitops-for-tenants.md — reconcile loop with selfHeal feedback arrow

Plus decision-tree conversions for the four troubleshooting "decision path" pages (crashloop, oomkilled 137-disambiguation, pod-pending, stuck-terminating), dns.md ndots walk, layers-and-vips "whole picture," nat.md census, memory-leaks triage tree, jattach attach-protocol sequence, drift decision matrix, helm release state machine, storage-pv-pvc binding flow, stateful decision framework, reconciliation loop, log pipeline, trace-context propagation, sidecar ordering with shared grace budget, lab architecture diagrams (Labs 3/4).

## P3 — Authoritative external-link pass (~100 links, batchable by section)

Rule of thumb from the audit: every page gets 2–5 links — the kubernetes.io concept/task page for its topic at first mention, plus official docs for every named third-party tool. Highest-value clusters:

- **troubleshooting/** (0 k8s.io links in 26 files): Debug Services, Debug Running Pods, kubectl debug reference, Troubleshooting Applications
- **workloads/**: probes task page, Pod Security Standards, scheduling concept trio + well-known-labels, Secrets tools (Sealed Secrets/SOPS/ESO/CSI — four named, zero linked), Job/CronJob concepts, sidecar-containers concept
- **operations/** (zero external links in 14 files): Argo CD + Flux docs, sigstore/cosign/trivy/syft/Kyverno (supply-chain names ~8 tools, links none), Deprecated API Migration Guide, pluto/kubent, ESO/Reloader, OpenCost
- **start/**: kubectl install (tools page — the minute-one link), RBAC reference, Components/architecture, version-skew policy; local-development.md names 9 installable tools with zero links
- **stateful/architectures/**: strimzi.io, rabbitmq.com, IBM MQ docs, valkey.io, velero.io, metallb.io, cert-manager.io, CNPG/Zalando/Crunchy
- **observability/**: prometheus.io querying basics, prometheus-operator, sre.google burn-rate chapter, opentelemetry.io, grafana.com Loki
- **java/dotnet/**: Spring Boot Actuator reference, Microsoft Learn GC runtime-config (proof for the hex claim), dotnet-monitor docs, OpenJDK -Xlog/G1, JDK Mission Control, CRaC/Leyden/GraalVM
- **networking/**: Services + Virtual IPs reference, DNS for Services and Pods, NetworkPolicy concepts + recipes repo, Ingress concepts, ingress-nginx annotations reference (domain appears as plain text, unlinked)

## P4 — Missing content, ranked

**Within the current site premise:**
1. **controllers/cert-manager.md** — referenced from 16 files, never explained. The #1 extension an app team consumes. (Secondary: a short external-dns page.)
2. **troubleshooting/dns-failures.md** — DNS is the most common 2am answer; currently split thin across three pages.
3. **"kubectl/API server itself is broken" playbook** — connection refused, Unauthorized vs unreachable, client-side throttling; error-index has no control-plane rows at all.
4. **HPA-not-scaling playbook** — FailedGetResourceMetric, `<unknown>` targets, metrics-server absent.
5. **Pod lifecycle primer** — phases, container states, restartPolicy backoff: used everywhere, defined nowhere.
6. **RBAC lab and NetworkPolicy lab** — the two highest-value lab gaps; both feed from-lab-to-prod.
7. **Glossary (100+ terms)** and per-topic printable cheatsheets — rookie retention + long-tail search.
8. Smaller: ExternalName Services (nowhere on site), `CreateContainerConfigError` home, rollout-stuck routing, `helm upgrade --reuse-values` trap, multi-arch builds in ci/, JVM crash handling (`hs_err_pid`), .NET Dockerfile, complete Argo CD Application + Flux HelmRelease examples, complete StorageClass YAML, StatefulSet snapshot-restore wrinkle, `podFailurePolicy`/`backoffLimitPerIndex`/`suspend`, PDB `unhealthyPodEvictionPolicy`, `PreferSameZone/PreferSameNode`, NodeLocal-vs-NetworkPolicy allow-DNS caution, dual-stack YAML, SLO/error-budget primer, kube-state-metrics introduction, OLM tenant surface, Node/Python/Go acknowledgment in the runtime sections.

**The audience pivot (biggest strategic decision):** the site targets "you own the apps but not the cluster"; the evaluation persona owns the cluster. The cheapest path is *adding the other seat*, not rewriting: a new `cluster-admin/` section that picks up every "ask your platform team" handoff, plus **learning-paths Track 7: "You own the cluster now."** Priority pages: etcd backup/restore; cluster upgrades; node lifecycle (cordon/drain/patch); control-plane troubleshooting; certificates & PKI; control-plane monitoring; multi-tenancy design (RBAC/quotas from the authoring side); admission policy (ValidatingAdmissionPolicy has zero coverage and is GA); CNI selection/debugging; node autoscaling (Cluster Autoscaler/Karpenter); cluster DR; audit logging & hardening (CIS/kube-bench). Add a one-line amendment to the tagline/about and "…or, if that's you, see X" cross-links from existing platform-team callouts.

---

## Per-section reports

Full per-page findings from each reviewer are preserved below the fold of this audit in the session transcript; the top-10 lists per section:

- **start/ + kubectl/**: RBAC accuracy fix; convert 2 ASCII diagrams; RBAC diagram; ~5 k8s.io links/page; reconcile-loop diagram; on-ramp gaps (kubectl install, container prereqs); de-dup how-kubectl-works; re-home solutions-index rows; add `apply` to survival kit; reconcile Track 1.
- **workloads/ + sidecars/**: fix nav bugs (order 16 collision, overview list); 6 diagrams; fix Recipe 2; pod-lifecycle primer; link pass; PDB `unhealthyPodEvictionPolicy`; Jobs modernization (`podFailurePolicy` etc.); de-dup graceful shutdown; small fixes; prerequisite one-liners.
- **networking/ ×3**: de-orphan cluster-networking; 6+ diagrams; ingress-nginx retirement; ~10 links; ExternalName; NodeLocal allow-DNS caution; kube-proxy modes wording + /12 fix; reconcile reading order; de-dup NodeLocal; accuracy sweep.
- **troubleshooting/ + tuning/**: its-slow flowchart; awk fix; hop-chain diagram; 4 decision trees; DNS playbook; k8s.io links; API-server-broken page; HPA playbook; overview routing fixes; cgroup-v2 oom.group + resize-version verification.
- **stateful/ + architectures/**: RabbitMQ Job YAML; sidebar renumber; KEDA↔Strimzi reconcile; front-door issuer; ~25 links; 6 diagrams; surface Valkey family in overview; StorageClass + snapshot-restore; rebalance valkey-data-access (§2 is pure Redis tutorial); StatefulSet updateStrategy pitfalls.
- **java/ + dotnet/**: accuracy bug batch; convert 4 ASCII diagrams; restart-spiral diagram; JVM/CLR vocabulary asides; ~12 links; .NET Dockerfile; JVM crash subsection; runtime-agnostic paragraph; CDS recipe; dotnet-counters output + starvation workflow.
- **ci/ + operations/ + helm/**: de-orphan deep-dive; helm fence fix; scan-before-push; persona boundary note in operations; Argo CD Application example; 4 diagrams; operations link pass; multi-arch subsection; `--reuse-values` + de-dup; pinning/currency sweep.
- **observability/ + controllers/ + labs/ + blog/**: lab skeleton fix; service-port fix; probes shape fix; cert-manager page; link pass; OTLP protocol fix; 4–6 diagrams; register Lab 9; blog hygiene; errata sweep.

## What NOT to touch

Reviewers were unanimous: the tuning/ section, promql-for-resources, template-language, external-database, Lab 2's config-channel experiment, Lab 5's drill design, Lab 8's measure-fix-measure loop, the events decoder, the error-index concept, the tenant-framing discipline on controllers pages, and the internal cross-link density are the site's crown jewels. Don't restructure them; extend the patterns they establish.
