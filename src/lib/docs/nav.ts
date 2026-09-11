export type DocMeta = {
	title: string;
	order?: number;
	summary?: string;
};

export type DocEntry = DocMeta & { slug: string };

const metaModules = import.meta.glob('/src/lib/docs/content/*.md', {
	eager: true,
	import: 'metadata'
}) as Record<string, DocMeta>;

export const docs: DocEntry[] = Object.entries(metaModules)
	.map(([path, meta]) => ({
		slug: path.split('/').pop()!.replace(/\.md$/, ''),
		...meta
	}))
	.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
