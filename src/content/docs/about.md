---
title: About & Methodology
description: What this site is, how its content is written and verified, which Kubernetes versions it assumes, and how to report an error.
---

## What this site is

K8s Soup to Nuts is a field guide for dev/ops and application teams who deploy to Kubernetes but do **not** administer the cluster. A platform team owns the nodes, the CNI, RBAC, ingress controllers, and [CRDs](/controllers/crds-explained/); you own everything inside your namespace. Every page is written from that seat, and anything that crosses the boundary says so explicitly.

The assumed corporate topology, used consistently across examples and reference architectures: external clients → corporate VIP on a network-team load balancer (F5/NetScaler) → in-cluster MetalLB service IP → Service → pods.

## How content is written and verified

- **Kernel and OS claims are cited.** Anywhere an article explains cgroups, CFS scheduling, the OOM killer, conntrack, signals, or `/proc`, it links the authoritative source — [docs.kernel.org](https://docs.kernel.org/) or [man7.org](https://man7.org/) — rather than asking you to take our word for it.
- **Internal links are machine-checked.** Every build verifies all internal links resolve (currently ~33,000 checked per build, zero broken as a release gate). External citations are verified to resolve when added.
- **One running example.** The fictional `orders-api` Spring Boot service threads through the labs, the Golden Service architecture, the sizing walkthrough, and the CI section, so numbers and names stay consistent across pages.
- **Reference architectures state their failure modes.** Every build ships with a verification plan including kill-the-primary/drain drills, and an honest failure-modes table. A build you haven't broken in a drill is a diagram, not a system.
- **External review.** The site is periodically audited by independent technical review (accuracy sampling, information architecture, gap analysis), and findings are fixed rather than filed.

None of this makes the site error-free. When you find a mistake, please [report it](#reporting-an-error) — errors in incident playbooks are treated as the highest-priority class of bug.

## Version policy

- **Reference articles** assume Kubernetes **1.30 or newer** unless a page says otherwise. Features that arrived recently (native sidecars, in-place pod resize, kube-proxy nftables mode) are flagged with the version they landed in.
- **Hands-On Labs** pin their tool versions in Lab 0 (k3s via Lima, specific image tags) so the shown output matches what you see. Expect drift warnings in the labs when your versions are newer.
- **Third-party projects** (ingress-nginx, MetalLB, Strimzi, CloudNativePG, Argo, KEDA, Helm) move faster than Kubernetes itself. Articles name the CR versions and annotation prefixes they were written against; if a manifest is rejected, check the project's current API version first.
- Each page shows a **last-updated date** derived from its git history.

## Reporting an error

Found something wrong — a command that doesn't work, a claim that doesn't match your cluster, a manifest that won't apply?

- **Open an issue:** [github.com/jamiegunn/k8s_soup_to_nuts/issues](https://github.com/jamiegunn/k8s_soup_to_nuts/issues) — there's a template for content errors.
- **Or edit directly:** every page has an "Edit page" link that opens the markdown source on GitHub.

Please include the page URL, what the page claims, what you observed, and your Kubernetes version.

## License and reuse

Content is licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and the code snippets, manifests, and scripts are additionally offered under the [MIT License](https://opensource.org/license/mit) — copy-paste into your own repos, pipelines, and runbooks freely, with attribution appreciated for prose reuse. See the [LICENSE file](https://github.com/jamiegunn/k8s_soup_to_nuts/blob/main/LICENSE) for the exact terms.

## Colophon

Built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build); full-text search by Pagefind; hosted on GitHub Pages. The site is a static build — no analytics, no cookies, no accounts.
