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
	terms: string[];
};
export type SearchResult = { id: string; title: string; href: string; snippet: string };
export type SearchResponse = { results: SearchResult[]; total: number };
const maxQueryLength = 100;

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

const glossaryHeading = /^##\s+[৪4]\.\s.*Glossary.*$/m;

function glossaryTerms(raw: string): string[] {
	const match = glossaryHeading.exec(raw);
	if (!match) return [];
	const rest = raw.slice(match.index + match[0].length);
	const end = rest.search(/^##\s/m);
	const section = end === -1 ? rest : rest.slice(0, end);
	return [...section.matchAll(/^\|\s*\*\*([^*]+)\*\*\s*\|/gm)].map((term) =>
		(term[1] ?? '').trim().toLocaleLowerCase()
	);
}

export function buildSearchIndex(catalog: Catalog, locale: Locale): SearchIndexEntry[] {
	const entries: SearchIndexEntry[] = [];
	for (const lesson of catalog.lessons) {
		if (!lesson.available) continue;
		const raw = catalog.contents.get(`${lesson.id}:${locale}`) ?? '';
		const plain = toPlainText(raw);
		const heading = `${lesson.id} ${lesson.title}`.toLocaleLowerCase();
		entries.push({
			id: lesson.id,
			title: lesson.title,
			href: lesson.href,
			heading,
			plain,
			haystack: `${heading} ${plain.toLocaleLowerCase()}`,
			terms: glossaryTerms(raw)
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

// Lessons whose number or title match rank first, then lessons whose glossary defines the query,
// then lessons that only mention it; within each group the curriculum order is kept.
export function search(index: SearchIndexEntry[], rawQuery: string, limit = 20): SearchResponse {
	const query = rawQuery.slice(0, maxQueryLength).trim().toLocaleLowerCase();
	if (query.length < 2) return { results: [], total: 0 };
	const matches = index.filter((entry) => entry.haystack.includes(query));
	const titled = matches.filter((entry) => entry.heading.includes(query));
	const defined = matches.filter(
		(entry) => !titled.includes(entry) && entry.terms.some((term) => term.includes(query))
	);
	const mentioned = matches.filter((entry) => !titled.includes(entry) && !defined.includes(entry));
	return {
		total: matches.length,
		results: [...titled, ...defined, ...mentioned].slice(0, limit).map((entry) => ({
			id: entry.id,
			title: entry.title,
			href: entry.href,
			snippet: snippet(entry, query)
		}))
	};
}
