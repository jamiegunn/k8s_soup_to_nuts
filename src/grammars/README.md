# Vendored TextMate grammars

Custom syntax-highlighting grammars registered with Expressive Code / Shiki in
`astro.config.mjs` (Shiki has no bundled PromQL grammar, so without this every
` ```promql ` fence fell back to plain text with a build warning).

## promql.tmLanguage.json

Derived from the PromQL grammar in
[prometheus-community/vscode-promql](https://github.com/prometheus-community/vscode-promql)
(`syntaxes/promql.tmlanguage.yml`), licensed **Apache-2.0**. Vendored rather
than fetched at build time so builds are hermetic.

Deviations from upstream, made during the YAML→JSON conversion:

- Added the `name`/`displayName` fields Shiki requires to register a language.
- Fixed a stray trailing apostrophe in the aggregator scope name.
- Added `\b` word boundaries to the aggregator rule and reordered
  `count_values` before `count` so longer names win.
- Extended the function list to current PromQL (histogram_*, `sgn`,
  `*_over_time` additions, `double_exponential_smoothing`, …), added `ms` to
  the duration units, and added the missing comparison operators
  (`==`, `<`, `>`, `<=`, `>=`).

The grammar is intentionally lexical (no parsing); metric and label names both
render as identifiers, which is fine for docs. If highlighting ever looks off
in a code block, tweak here and rebuild — nothing is fetched from the network.
