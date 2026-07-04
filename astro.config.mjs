// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightBlog from 'starlight-blog';
import { rehypeBaseLinks } from './src/plugins/rehype-base-links.mjs';

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
		rehypePlugins: [rehypeBaseLinks(BASE)],
	},
	integrations: [
		starlight({
			title: 'K8s Soup to Nuts',
			description:
				'A field guide to running, debugging, and surviving Kubernetes when you own the apps but not the cluster.',
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
					items: [{ autogenerate: { directory: 'start' } }],
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
					label: 'Java on Kubernetes',
					items: [{ autogenerate: { directory: 'java' } }],
				},
				{
					label: '.NET on Kubernetes',
					items: [{ autogenerate: { directory: 'dotnet' } }],
				},
				{
					label: 'Stateful Apps',
					items: [{ autogenerate: { directory: 'stateful' } }],
				},
				{
					label: 'Networking & Routing',
					items: [
						{ autogenerate: { directory: 'networking' } },
						{
							label: 'Under the Hood: Routing & DNS',
							collapsed: true,
							items: [{ autogenerate: { directory: 'routing' } }],
						},
					],
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
					label: 'Day-2 Operations',
					items: [{ autogenerate: { directory: 'operations' } }],
				},
				{
					label: 'CI with GitHub & Artifactory',
					items: [{ autogenerate: { directory: 'ci' } }],
				},
				{
					label: 'Helm Deep Dive',
					items: [{ autogenerate: { directory: 'helm' } }],
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
					label: 'Knobs & Levers',
					items: [{ autogenerate: { directory: 'tuning' } }],
				},
				{
					label: 'About & Methodology',
					link: '/about/',
				},
			],
		}),
	],
});
