import type { Handle } from '@sveltejs/kit';
export const securityHeaders: Record<string, string> = {
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'x-frame-options': 'DENY',
	'strict-transport-security': 'max-age=31536000',
	'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()'
};
export const handle: Handle = async ({ event, resolve }) => {
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
	const response = await resolve(event, {
		transformPageChunk: ({ html }) => html.replace('%course.lang%', locale)
	});
	for (const [name, value] of Object.entries(securityHeaders)) response.headers.set(name, value);
	return response;
};
