# K8s Soup to Nuts

A static reference site + blog for dev/ops teams who own their applications
but **not** the Kubernetes cluster: deployments, HA, scaling, health checks,
Java debugging with JRE-only images, stateful apps (Valkey, PostgreSQL,
Oracle, MQ), networking, controllers/CRDs (MetalLB, F5 CIS), live patching
without breaking CI/CD, and symptom-first troubleshooting playbooks.

Built with [Astro](https://astro.build) + [Starlight](https://starlight.astro.build),
with full-text search via Pagefind (built in — works offline, no external service)
and a blog via [starlight-blog](https://github.com/HiDeoo/starlight-blog).

## Local development

```bash
npm install
npm run dev        # http://localhost:4321/k8s_soup_to_nuts
```

Note: search (Pagefind) only works on a production build:

```bash
npm run build
npm run preview
```

## Writing content

All content is markdown under `src/content/docs/`:

| Directory          | Sidebar section              |
| ------------------ | ---------------------------- |
| `start/`           | Start Here                   |
| `workloads/`       | Workloads & Deployments      |
| `java/`            | Java on Kubernetes           |
| `stateful/`        | Stateful Apps                |
| `networking/`      | Networking & Routing         |
| `controllers/`     | Controllers, CRDs & Operators|
| `observability/`   | Logging & Observability      |
| `troubleshooting/` | Troubleshooting              |
| `operations/`      | Day-2 Operations             |
| `blog/`            | Field Notes (dated posts)    |

Docs article frontmatter:

```yaml
---
title: Article Title
description: One sentence used by search and SEO.
sidebar:
  order: 3 # position within its section
---
```

Blog post frontmatter:

```yaml
---
title: Post Title
description: One sentence.
date: 2026-07-01
authors: editor
tags: [java, memory]
excerpt: Hook shown on the blog index.
---
```

Cross-link between articles with relative links: `../other-slug/` within a
section, `../../section/slug/` across sections.

## Deployment (GitHub Pages)

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds the
site and publishes it to GitHub Pages.

One-time setup in the GitHub repo: **Settings → Pages → Source: GitHub Actions**.

If the repo name or owner changes, update `site` and `base` in
`astro.config.mjs`.
