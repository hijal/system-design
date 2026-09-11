import { error } from '@sveltejs/kit';
import { catalogs } from '$lib/server/course';
import type { RequestHandler } from './$types';
import type { Locale } from '$lib/docs/i18n';

export const GET: RequestHandler = ({ params, url }) => {
	const locale: Locale = url.searchParams.get('lang') === 'en' ? 'en' : 'bn';
	const id = params.slug.replace(/^lesson-/, '');
	const catalog = catalogs[locale];
	const lesson = catalog.lessons.find((l) => l.id === id);
	if (!lesson || !lesson.available) error(404, 'Lesson not found');
	const raw = catalog.contents.get(`${id}:${locale}`) ?? '';
	return new Response(raw, {
		headers: {
			'content-type': 'text/markdown; charset=utf-8',
			'cache-control': 'public, max-age=300'
		}
	});
};
