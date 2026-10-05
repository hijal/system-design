import { redirect } from '@sveltejs/kit';
import { catalogs } from '$lib/server/course';
import { localizedHref, type Locale } from '$lib/docs/i18n';
import type { RequestHandler } from './$types';

const notFound: Record<Locale, string> = {
	bn: 'এই lesson-টি পাওয়া যায়নি।\n',
	en: 'Lesson not found.\n'
};

export const GET: RequestHandler = ({ params, url }) => {
	const requested = url.searchParams.get('lang');
	const locale: Locale = requested === 'en' ? 'en' : 'bn';
	const catalog = catalogs[locale];
	if (!params.slug.startsWith('lesson-') && catalog.lessons.some((l) => l.id === params.slug)) {
		const target = `/lesson-${params.slug}.md`;
		redirect(
			308,
			requested === 'bn' || requested === 'en' ? localizedHref(target, requested) : target
		);
	}
	const id = params.slug.replace(/^lesson-/, '');
	const lesson = catalog.lessons.find((l) => l.id === id);
	if (!lesson || !lesson.available)
		return new Response(notFound[locale], {
			status: 404,
			headers: { 'content-type': 'text/plain; charset=utf-8' }
		});
	const raw = catalog.contents.get(`${id}:${locale}`) ?? '';
	return new Response(raw, {
		headers: {
			'content-type': 'text/markdown; charset=utf-8',
			'cache-control': 'public, max-age=300',
			link: `<${url.origin}${lesson.href}>; rel="canonical"`
		}
	});
};
