#!/usr/bin/env node
// Content lint for K8s Soup to Nuts.
// Enforces the invariants that keep 265+ pages from rotting:
//   1. Internal links resolve to a real page (root-relative, trailing slash).
//   2. Every doc has title + description frontmatter.
//   3. Code fences are balanced.
//   4. (warning) Kubernetes version claims don't assert a not-yet-stable release.
//
// Errors (1-3) fail the build (exit 1). Version issues (4) print as warnings.
// Run: `npm run lint`  (or `node scripts/lint-content.mjs`)
//
// MAINTENANCE: bump CURRENT_STABLE_MINOR the day the platform's newest stable
// release lands. That single constant is what turns "audit 265 pages for version
// drift" into "change one number."
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_STABLE_MINOR = 36; // Kubernetes 1.36 — bump on each new stable.

const DOCS = fileURLToPath(new URL('../src/content/docs/', import.meta.url));

// --- collect all markdown files ------------------------------------------
async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (['.md', '.mdx'].includes(extname(e.name))) out.push(p);
  }
  return out;
}

function routeOf(absPath) {
  let rel = relative(DOCS, absPath).replace(/\\/g, '/').replace(/\.(md|mdx)$/, '');
  if (rel === 'index') return '/';
  if (rel.endsWith('/index')) rel = rel.slice(0, -'/index'.length);
  return '/' + rel + '/';
}

const files = await walk(DOCS);
const routes = new Set(files.map(routeOf));
routes.add('/blog/'); // starlight-blog index (plugin-generated, no file)
const sectionRoots = new Set(
  [...routes].map((r) => '/' + r.split('/').filter(Boolean)[0] + '/'),
);

const LINK = /\]\((\/[^)\s]+)\)/g;
const FM = /^---\n([\s\S]*?)\n---\n/;
// Version claim: a K8s-context verb immediately before a 1.NN token. The verb
// anchor is what makes this ignore `busybox:1.37` image tags and `× 1.35`
// headroom multipliers — those have no "since/in/GA/..." in front of them.
const VER =
  /\b(?:since|in|stable in|stable since|GA in|GA since|graduated[^.]{0,20}?in|beta in|beta since|alpha in|added in|introduced in|available in|enabled by default in)\s+(?:Kubernetes\s+|K8s\s+|v)?1\.(\d{2})\b/gi;
const FORWARD = /(remov|deprecat|plan|target|upcoming|\bwill\b|expected|plann)/i;

let errors = 0;
let warnings = 0;
const report = (level, file, msg) => {
  console.log(`  ${level === 'err' ? 'ERROR' : 'warn '}  ${file}: ${msg}`);
  if (level === 'err') errors++;
  else warnings++;
};

for (const f of files) {
  const rel = relative(DOCS, f).replace(/\\/g, '/');
  const text = await readFile(f, 'utf8');

  // 2. frontmatter
  const m = text.match(FM);
  const fm = m ? m[1] : '';
  if (!/^title:/m.test(fm) || !/^description:/m.test(fm))
    report('err', rel, 'missing title/description frontmatter');

  // 3. fence balance
  if (((text.match(/^```/gm) || []).length) % 2 !== 0)
    report('err', rel, 'unbalanced code fences');

  // 1. internal links
  for (const [, link] of text.matchAll(LINK)) {
    let base = link.split('#')[0];
    if (!base.endsWith('/')) {
      report('err', rel, `internal link missing trailing slash: ${link}`);
      base += '/';
    }
    if (!routes.has(base) && !sectionRoots.has(base))
      report('err', rel, `broken internal link target: ${link}`);
  }

  // 4. version currency (warning) — ignore fenced code so kubectl examples
  // and image tags never trip it.
  const prose = text.replace(/```[\s\S]*?```/g, '');
  for (const mm of prose.matchAll(VER)) {
    const minor = Number(mm[1]);
    if (minor <= CURRENT_STABLE_MINOR) continue;
    const ctx = prose.slice(Math.max(0, mm.index - 60), mm.index + 40);
    if (FORWARD.test(ctx)) continue; // "removed in 1.37" etc. is fine
    report(
      'warn',
      rel,
      `claims availability in 1.${minor}, past current stable 1.${CURRENT_STABLE_MINOR}: "…${mm[0]}…" (mark it forward-looking, or bump CURRENT_STABLE_MINOR)`,
    );
  }
}

console.log(
  `\ncontent-lint: ${files.length} pages, ${routes.size} routes — ${errors} error(s), ${warnings} warning(s).`,
);
process.exit(errors > 0 ? 1 : 0);
