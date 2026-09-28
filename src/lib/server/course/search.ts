import type { Locale } from '../../docs/i18n';
import { lessonBody, type createCatalog } from './catalog';

type Catalog = ReturnType<typeof createCatalog>;
type SearchIndexEntry = {
	id: string;
	title: string;
	href: string;
	heading: string;
	haystack: string;
	plain: string;
};
export type SearchResult = { id: string; title: string; href: string; snippet: string };

function toPlainText(raw: string): string {
	return lessonBody(raw)
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`[^`]*`/g, ' ')
		.replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
		.replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
		.replace(/[#>*_~|]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export function buildSearchIndex(catalog: Catalog, locale: Locale): SearchIndexEntry[] {
	const entries: SearchIndexEntry[] = [];
	for (const lesson of catalog.lessons) {
		if (!lesson.available) continue;
		const plain = toPlainText(catalog.contents.get(`${lesson.id}:${locale}`) ?? '');
		const heading = `${lesson.id} ${lesson.title}`.toLocaleLowerCase();
		entries.push({
			id: lesson.id,
			title: lesson.title,
			href: lesson.href,
			heading,
			plain,
			haystack: `${heading} ${plain.toLocaleLowerCase()}`
		});
	}
	return entries;
}

function snippet(entry: SearchIndexEntry, query: string): string {
	const idx = entry.plain.toLocaleLowerCase().indexOf(query);
	if (idx === -1) return entry.plain.slice(0, 140);
	const start = Math.max(0, idx - 50);
	const end = Math.min(entry.plain.length, idx + query.length + 90);
	const prefix = start > 0 ? '…' : '';
	const suffix = end < entry.plain.length ? '…' : '';
	return `${prefix}${entry.plain.slice(start, end)}${suffix}`;
}

// Lessons whose number or title match rank above lessons that only mention the query;
// within each group the curriculum order is kept.
export function search(index: SearchIndexEntry[], rawQuery: string, limit = 20): SearchResult[] {
	const query = rawQuery.trim().toLocaleLowerCase();
	if (query.length < 2) return [];
	const matches = index.filter((entry) => entry.haystack.includes(query));
	const titled = matches.filter((entry) => entry.heading.includes(query));
	const mentioned = matches.filter((entry) => !entry.heading.includes(query));
	return [...titled, ...mentioned].slice(0, limit).map((entry) => ({
		id: entry.id,
		title: entry.title,
		href: entry.href,
		snippet: snippet(entry, query)
	}));
}
