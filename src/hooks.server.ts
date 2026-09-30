import type { Handle } from '@sveltejs/kit';
export const handle: Handle = ({ event, resolve }) => {
	const requested = event.url.searchParams.get('lang');
	const saved = event.cookies.get('course-language');
	const locale =
		requested === 'en' || requested === 'bn' ? requested : saved === 'en' ? 'en' : 'bn';
	event.locals.courseLocale = locale;
	if (requested === 'en' || requested === 'bn')
		event.cookies.set('course-language', locale, {
			path: '/',
			maxAge: 60 * 60 * 24 * 365,
			sameSite: 'lax'
		});
	return resolve(event, {
		transformPageChunk: ({ html }) => html.replace('%course.lang%', locale)
	});
};
