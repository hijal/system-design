import { json } from '@sveltejs/kit';
import { catalogs } from '$lib/server/course';
import { buildSearchIndex, search } from '$lib/server/course/search';
import type { RequestHandler } from './$types';
import type { Locale } from '$lib/docs/i18n';

const indexes: Record<Locale, ReturnType<typeof buildSearchIndex>> = {
	bn: buildSearchIndex(catalogs.bn, 'bn'),
	en: buildSearchIndex(catalogs.en, 'en')
};

export const GET: RequestHandler = ({ url }) => {
	const locale: Locale = url.searchParams.get('lang') === 'en' ? 'en' : 'bn';
	return json(
		{ results: search(indexes[locale], url.searchParams.get('q') ?? '') },
		{ headers: { 'cache-control': 'public, max-age=300' } }
	);
};
