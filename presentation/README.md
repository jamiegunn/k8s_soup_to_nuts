# Presentation — Kubernetes, from what you already know

A ~25 minute session for engineers with a strong development background and **no devops background**.
It teaches one model properly (the three questions Kubernetes asks about your app), then the two
skills that follow from it: reading a failure, and knowing which number to trust.

## What's here

| File | What it is |
|---|---|
| `index.html` | The deck as a self-contained web page — open it in any browser and present. No build step, no network, no dependencies. |
| `k8s-for-developers.pptx` | The same deck as PowerPoint, with the speaker notes in the notes pane. |
| `content.js` | **Single source of truth.** All slide copy and speaker notes live here; both outputs are generated from it. |
| `build-html.js` | Generates `index.html` from `content.js`. |
| `build-pptx.js` | Generates `k8s-for-developers.pptx` from `content.js`. |

## Presenting the HTML version

Open `index.html` and press **F** for fullscreen. Keys:

- `→` `space` `PageDown` — next · `←` `PageUp` — previous
- `N` — speaker notes panel · `O` — slide overview · `1`–`9` — jump to a slide
- `F` — fullscreen · `Home` / `End` — first / last

The slide number is in the URL hash, so you can link to or reload on a specific slide.
`Ctrl/Cmd-P` prints one slide per page if you want a PDF.

## Editing

Change the copy in `content.js`, then regenerate both outputs so they stay in step:

```bash
node build-html.js && node build-pptx.js
```

`build-pptx.js` needs `pptxgenjs`. Inside slide text, `` `backticks` `` render as code,
`**double asterisks**` as bold and `*single*` as italic, in both outputs.

## The arc

1. **You already know most of this** — a translation table from things they have built to Kubernetes names.
2. **Kubernetes asks three questions** — cost, truth, response, shown on a real annotated Deployment.
3. **Door 1 · Cost** — CPU is compressible, memory is not, and that decides both knobs.
4. **Door 2 · Truth** — three probes, three questions, and the readiness probe that causes outages.
5. **Door 3 · Response** — scale on what saturates; the ceiling is usually someone else's.
6. **Both numbers are correct** — the throttled app that looked idle, and the three places to stand.
7. **Five things Kubernetes does to your pod** — where each step writes down why it failed.
8. **Four things to do with your own service** — this week, without asking anyone's permission.

Deeper versions of every model live on the site: <https://jamiegunn.github.io/k8s_soup_to_nuts/>
