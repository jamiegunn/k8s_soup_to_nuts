import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { blogSchema } from 'starlight-blog/schema';

// Extra, search-only vocabulary for a page: synonyms, symptoms, error strings,
// and adjacent concepts that real readers type but that don't appear in the
// visible prose. These are injected as hidden, Pagefind-indexed text by the
// MarkdownContent override (src/components/MarkdownContent.astro), so a page
// surfaces for what it's *about*, not only for words it literally contains.
const searchKeywords = z.object({
	keywords: z.array(z.string()).optional(),
});

export const collections = {
	docs: defineCollection({
		loader: docsLoader(),
		// docsSchema composes `extend` with the built-in schema via a Zod
		// intersection (`.and`), so we intersect the blog schema with our
		// keywords field the same way to keep both sets of fields.
		schema: docsSchema({
			extend: (context) => blogSchema(context).and(searchKeywords),
		}),
	}),
};
