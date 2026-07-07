/**
 * Remark plugin that converts ```mermaid fenced code blocks into raw
 * `<pre class="mermaid">` HTML nodes.
 *
 * Starlight renders fenced code with Expressive Code, which would show a
 * Mermaid block as its *source text*, not a diagram. By rewriting the block at
 * the mdast stage (before Expressive Code runs) into a raw <pre>, the source is
 * handed straight to the self-hosted Mermaid client script bundled by
 * src/components/MarkdownContent.astro, which turns every `.mermaid` element
 * into an SVG.
 *
 * The raw source is HTML-escaped so the diagram text survives as element
 * textContent; if the script fails to run, the escaped source shows as a
 * readable fallback instead of a broken diagram.
 */
export function remarkMermaid() {
	const escape = (s) =>
		s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

	function walk(node) {
		if (!node.children) return;
		node.children = node.children.map((child) => {
			walk(child);
			if (child.type === 'code' && child.lang === 'mermaid') {
				return {
					type: 'html',
					value: `<pre class="mermaid">\n${escape(child.value)}\n</pre>`,
				};
			}
			return child;
		});
	}

	return (tree) => {
		walk(tree);
	};
}
