// @ts-check
import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightBlog from 'starlight-blog';
import { rehypeBaseLinks } from './src/plugins/rehype-base-links.mjs';
import { remarkMermaid } from './src/plugins/remark-mermaid.mjs';

// Shiki ships no PromQL grammar, so ```promql fences fell back to plain text
// (with a build warning each). This vendored TextMate grammar fixes that —
// provenance and local tweaks are documented in src/grammars/README.md.
const promqlGrammar = JSON.parse(
	readFileSync(new URL('./src/grammars/promql.tmLanguage.json', import.meta.url), 'utf8'),
);

// GitHub Pages: SITE is your GitHub Pages origin, BASE is the repo name.
// If you rename the repo or move to a custom domain, update these two lines.
// (Hero action links in src/content/docs/index.mdx hardcode BASE — update there too.)
const SITE = 'https://jamiegunn.github.io';
const BASE = '/k8s_soup_to_nuts';

// https://astro.build/config
export default defineConfig({
	site: SITE,
	base: BASE,
	markdown: {
		// remarkMermaid must run before Expressive Code so ```mermaid fences
		// become raw <pre class="mermaid"> for client-side rendering.
		remarkPlugins: [remarkMermaid],
		rehypePlugins: [rehypeBaseLinks(BASE)],
	},
	integrations: [
		starlight({
			title: 'K8s Soup to Nuts',
			description:
				'A field guide to running, debugging, and surviving Kubernetes when you own the apps but not the cluster.',
			// Mermaid rendering is bundled (self-hosted) via a client script in the
			// MarkdownContent override — see src/components/MarkdownContent.astro.
			// Override the markdown wrapper so per-page `keywords` frontmatter is
			// injected as hidden, Pagefind-indexed text. See the component and
			// src/content.config.ts for the full mechanism.
			components: {
				MarkdownContent: './src/components/MarkdownContent.astro',
			},
			expressiveCode: {
				shiki: {
					langs: [promqlGrammar],
				},
			},
			// Pagefind ranking tuned to favour relevance breadth over exact,
			// term-dense matches — so pages that pertain to a query surface even
			// when they mention it once. Values are Pagefind defaults unless noted.
			// See https://pagefind.app/docs/ranking/
			pagefind: {
				ranking: {
					// Lower (default 9): let fuzzy/partial/stemmed matches rank more
					// comparably to exact ones, broadening what surfaces.
					termSimilarity: 6,
					// Lower (default 0.1): reduce the reward for repeating a term, so a
					// page that mentions a concept once still competes with a term-dense
					// page. Improves recall of "pertaining" pages.
					termFrequency: 0.05,
					// Lower (default 0.1): reduce the short-page bias so long,
					// comprehensive reference/architecture pages aren't out-ranked for
					// length alone.
					pageLength: 0.05,
					// Default (range 0–2): how quickly repeated terms stop adding value.
					termSaturation: 2,
					// Weight the injected `keywords` metadata between title (5) and body
					// (~1): a keyword hit meaningfully boosts a page without overriding a
					// genuine title match.
					metaWeights: { title: 5, keywords: 3 },
				},
			},
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/jamiegunn/k8s_soup_to_nuts',
				},
			],
			customCss: ['./src/styles/custom.css'],
			editLink: {
				baseUrl: 'https://github.com/jamiegunn/k8s_soup_to_nuts/edit/main/',
			},
			lastUpdated: true,
			pagination: true,
			plugins: [
				starlightBlog({
					title: 'Field Notes',
					postCount: 7,
					recentPostCount: 5,
					authors: {
						editor: {
							name: 'The Editor',
							title: 'K8s Soup to Nuts',
						},
					},
				}),
			],
			sidebar: [
				{
					label: 'Start Here',
					items: [
						{ autogenerate: { directory: 'start' } },
						{ label: 'Error Message Index ↗', link: '/troubleshooting/error-index/' },
					],
				},
				{
					label: 'Learning Paths',
					link: '/learning-paths/',
				},
				{
					// Deliberately high in the sidebar: this is the section
					// people arrive needing, often mid-incident.
					label: 'Troubleshooting',
					items: [
						{ autogenerate: { directory: 'troubleshooting' } },
						{ label: 'Emergency Playbooks ↗', link: '/operations/emergency-playbooks/' },
					],
				},
				{
					label: 'kubectl Mastery',
					items: [{ autogenerate: { directory: 'kubectl' } }],
				},
				// Section order follows the learning progression: workloads (what you
				// run) → networking (how traffic reaches it) → state → the controller
				// machinery → observing → tuning → autoscaling (the feedback loop on
				// top of tuned resources) → operating → packaging (Helm) →
				// pipelines (CI) → runtime-specific (Java/.NET) → applied builds.
				// Runtime sections sit after the platform core deliberately: they're
				// specialty tracks, not prerequisites.
				{
					label: 'Workloads & Deployments',
					items: [
						{ autogenerate: { directory: 'workloads' } },
						{
							label: 'Sidecars',
							collapsed: true,
							items: [{ autogenerate: { directory: 'sidecars' } }],
						},
					],
				},
				{
					label: 'Networking & Routing',
					items: [
						{ autogenerate: { directory: 'networking' } },
						{
							// The internal fabric (pod network, Service/ClusterIP network,
							// cluster DNS) as distinct from the app-facing edge above.
							label: 'Cluster Networking (Internal Fabric)',
							items: [{ autogenerate: { directory: 'cluster-networking' } }],
						},
						{
							label: 'Under the Hood: Routing & DNS',
							collapsed: true,
							items: [{ autogenerate: { directory: 'routing' } }],
						},
					],
				},
				{
					label: 'Stateful Apps',
					items: [{ autogenerate: { directory: 'stateful' } }],
				},
				{
					label: 'Controllers, CRDs & Operators',
					items: [{ autogenerate: { directory: 'controllers' } }],
				},
				{
					label: 'Logging & Observability',
					items: [{ autogenerate: { directory: 'observability' } }],
				},
				{
					label: 'Tuning: Knobs & Levers',
					items: [{ autogenerate: { directory: 'tuning' } }],
				},
				{
					label: 'Autoscaling Playbook',
					items: [{ autogenerate: { directory: 'autoscaling' } }],
				},
				{
					label: 'Day-2 Operations',
					items: [{ autogenerate: { directory: 'operations' } }],
				},
				{
					label: 'Helm Deep Dive',
					items: [{ autogenerate: { directory: 'helm' } }],
				},
				{
					label: 'CI with GitHub & Artifactory',
					items: [{ autogenerate: { directory: 'ci' } }],
				},
				{
					label: 'Java on Kubernetes',
					items: [{ autogenerate: { directory: 'java' } }],
				},
				{
					label: '.NET on Kubernetes',
					items: [{ autogenerate: { directory: 'dotnet' } }],
				},
				{
					label: 'Reference Architectures',
					items: [{ autogenerate: { directory: 'architectures' } }],
				},
				{
					label: 'Hands-On Labs',
					items: [{ autogenerate: { directory: 'labs' } }],
				},
				{
					label: 'Pass the CKAD',
					items: [
						{ autogenerate: { directory: 'ckad' } },
						{ label: 'Vim for the CKAD ↗', link: '/kubectl/vim-for-ckad/' },
					],
				},
				{
					label: 'About & Methodology',
					link: '/about/',
				},
			],
		}),
	],
});
