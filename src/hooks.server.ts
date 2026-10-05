import type { Handle } from '@sveltejs/kit';
export const securityHeaders: Record<string, string> = {
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'x-frame-options': 'DENY',
	'strict-transport-security': 'max-age=31536000',
	'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()'
};
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
export const handle: Handle = async ({ event, resolve }) => {
	if (event.url.protocol === 'http:' && !localHosts.has(event.url.hostname)) {
		const secure = new URL(event.url);
		secure.protocol = 'https:';
		return new Response(null, { status: 301, headers: { location: secure.href } });
	}
	const requested = event.url.searchParams.get('lang');
	const saved = event.cookies.get('course-language');
	const locale =
		requested === 'en' || requested === 'bn' ? requested : saved === 'en' ? 'en' : 'bn';
	event.locals.courseLocale = locale;
	const isPage = event.route.id?.startsWith('/(docs)') ?? false;
	if (isPage && (requested === 'en' || requested === 'bn'))
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
