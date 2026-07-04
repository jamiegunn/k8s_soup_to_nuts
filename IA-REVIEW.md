# Information Architecture & Navigation Review

**Site:** K8s Soup to Nuts (Starlight, ~191 pages, 18 sections)
**Date:** 2026-07-04

## Verdict

The IA is fundamentally sound. Every section has a real overview page that maps its contents, titles are scannable, entry points (homepage, Solutions Index, Error Index, Learning Paths, Triage) serve the three audiences well, and cross-linking is dense — including bidirectional concept↔troubleshooting links. The issues below are ordering and discoverability refinements, not structural problems.

---

## High priority

### 1. `workloads/graceful-shutdown.md` is buried at order 19

It's foundational ("every pod you will ever run gets killed"), and Health Checks (order 6) and Rollouts (order 3) both depend on understanding the termination sequence. It reads as appended, not placed.

**Fix:** move to order 7 (after Health Checks), bump orders 7–18 by one. DaemonSets at 18 is fine where it is.

### 2. Troubleshooting interleaves tool guides with symptom playbooks

Orders 10–17 alternate between diagnostic tools (Debugging Toolbox 10, BusyBox 12, Error Index 13, Linux Inside the Pod 14) and symptom playbooks (Volume Failures 11, Front Door 5xx 15, It's Slow 16, Stuck Terminating 17). Mid-incident, a scanner can't tell which is which.

**Fix (either):**
- Reorder: symptoms 3–11 (add front-door-5xx, its-slow, stuck-terminating after volume-failures), then tools 12–16 (Debugging Toolbox, BusyBox, Linux Inside the Pod, Error Index) at the end.
- Or nest in `astro.config.mjs`: a collapsed "Diagnostic Tools" subgroup, mirroring how Sidecars nests under Workloads. Keep Error Message Index visible at top level — it's a primary lookup surface.

### 3. Tuning splits its natural pairs

Health Check Knobs (2) and Health Check Design (7) are five slots apart; Requests & Limits Knobs (4) and Brownfield Resources (6) similarly. The knobs/walkthroughs rationale is explained in the overview, but the sidebar doesn't show it — a reader tuning probes must discover the second page exists.

**Fix:** reorder to pair by topic: Health Check Knobs → Health Check Design → Requests & Limits Knobs → Brownfield Resources → Sizing Walkthrough → JVM Memory Knobs → Rollout & Shutdown Knobs → Timeout Budget.

### 4. Learning Paths is invisible from the homepage

`index.mdx` hero links Start Here, Solutions Index, Troubleshooting, and Field Notes — but not `/learning-paths/`, the page explicitly built to route new arrivals. Only 3 pages site-wide link to it (all in `start/`).

**Fix:** add a hero action (or a top CardGrid card) for Learning Paths, and link it from the Java, .NET, operations, and stateful overviews (each has a corresponding track).

---

## Medium priority

### 5. Field Notes (blog) is disconnected from the docs

12 case-study posts exist (`blog/`), each an incident narrative that pairs naturally with a concept page (e.g., `the-readiness-probe-that-took-down-prod` ↔ health checks; `oomkilled-but-the-heap-was-fine` ↔ OOMKilled/JVM memory). Only `start/solutions-index.md` links into the blog.

**Fix:** add a "Field note" callout or See Also link on each matching concept/troubleshooting page, and reference relevant posts as case studies in learning-path tracks.

### 6. Gateway API is at the end of Networking (order 15)

The overview frames it as the Ingress successor, yet readers finish Ingress and Routing (6) and ingress-nginx (12) without ever seeing it.

**Fix:** move to order 7 (right after Ingress and Routing), or at minimum add a prominent pointer from `ingress-and-routing.md` — verified: that page never mentions Gateway API at all.

### 7. "Knobs & Levers" — label and position

The tuning section is the last content group in the sidebar, below Labs, despite being a constant companion to Workloads/Java/Troubleshooting (which link to it heavily). The label is also the only top-level one that doesn't say what it contains.

**Fix:** rename to "Tuning: Knobs & Levers" (keeps the voice, adds the keyword) and consider moving it above Reference Architectures — after CI/Helm, near the operational material it supports.

### 8. Sidebar has ~20 top-level groups

Workable, but at the threshold. If more sections are added, group runtimes (Java/.NET) and delivery (CI/Helm/Day-2 Ops) the way Sidecars and Routing already nest. No action needed today.

---

## Low priority / no action

- **`networking/services-deep-dive.md`** explains kube-proxy inline but never links `routing/kube-proxy-and-the-dataplane.md`. One-line fix; the routing section is otherwise well linked (24 pages point into it).
- **`start/` order gap (9 → 11):** harmless; invisible to readers. Renumber day-1-checklist to 10 whenever convenient.
- **Cross-listing works well:** Emergency Playbooks appearing under both Troubleshooting and Day-2 Ops is good practice — consider the same for Error Message Index (e.g., also under Start Here, where the Solutions Index lives).
- **Title tone outliers** ("It's Slow, Not Down", "The BusyBox Toolkit") fit the section voice; keep.
- **Overview pages:** uniformly strong — real maps with symptom tables and reading order, not filler. This is the site's biggest IA asset; keep the pattern mandatory for new sections.

---

## What was checked

Sidebar config (`astro.config.mjs`), frontmatter order for all 191 pages, all 18 overview pages, entry points (homepage, learning-paths, solutions-index, error-index, about), cross-link presence across overlapping clusters (health checks, resources/memory, networking↔routing, graceful shutdown, stateful↔architectures, helm, observability), inbound links to `/routing/`, `/learning-paths/`, and `/blog/`, and title consistency per section. Internal links use root-relative paths rewritten by `rehype-base-links.mjs`; conventions are consistent and no broken targets were found in sampling.
