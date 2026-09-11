import { json } from '@sveltejs/kit';
import { catalogs } from '$lib/server/course';
import { lessonBody } from '$lib/server/course/catalog';
import type { RequestHandler } from './$types';
import type { Locale } from '$lib/docs/i18n';

type SearchIndexEntry = {
	id: string;
	title: string;
	href: string;
	haystack: string;
	plain: string;
};

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

function buildIndex(locale: Locale): SearchIndexEntry[] {
	const catalog = catalogs[locale];
	const entries: SearchIndexEntry[] = [];
	for (const lesson of catalog.lessons) {
		if (!lesson.available) continue;
		const raw = catalog.contents.get(`${lesson.id}:${locale}`) ?? '';
		const plain = toPlainText(raw);
		entries.push({
			id: lesson.id,
			title: lesson.title,
			href: lesson.href,
			plain,
			haystack: `${lesson.id} ${lesson.title} ${plain}`.toLocaleLowerCase()
		});
	}
	return entries;
}

const indexes: Record<Locale, SearchIndexEntry[]> = {
	bn: buildIndex('bn'),
	en: buildIndex('en')
};

function snippet(entry: SearchIndexEntry, query: string): string {
	const lower = entry.plain.toLocaleLowerCase();
	const idx = lower.indexOf(query);
	if (idx === -1) return entry.plain.slice(0, 140);
	const start = Math.max(0, idx - 50);
	const end = Math.min(entry.plain.length, idx + query.length + 90);
	const prefix = start > 0 ? '…' : '';
	const suffix = end < entry.plain.length ? '…' : '';
	return `${prefix}${entry.plain.slice(start, end)}${suffix}`;
}

export const GET: RequestHandler = ({ url }) => {
	const query = (url.searchParams.get('q') ?? '').trim().toLocaleLowerCase();
	const localeParam = url.searchParams.get('lang');
	const locale: Locale = localeParam === 'en' ? 'en' : 'bn';
	if (query.length < 2) return json({ results: [] });
	const results = indexes[locale]
		.filter((entry) => entry.haystack.includes(query))
		.slice(0, 20)
		.map((entry) => ({
			id: entry.id,
			title: entry.title,
			href: entry.href,
			snippet: snippet(entry, query)
		}));
	return json({ results });
};
