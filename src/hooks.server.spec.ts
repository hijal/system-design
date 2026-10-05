import { describe, expect, it } from 'vitest';
import { handle, securityHeaders } from './hooks.server';
type Input = Parameters<typeof handle>[0];
function run(
	path: string,
	cookie?: string,
	routeId: string | null = '/(docs)/[slug]',
	origin = 'http://localhost'
) {
	const set: string[] = [];
	const event = {
		url: new URL(`${origin}${path}`),
		route: { id: routeId },
		cookies: { get: () => cookie, set: (_: string, value: string) => set.push(value) },
		locals: {}
	};
	const resolve = (
		_: unknown,
		opts?: { transformPageChunk?: (input: { html: string }) => string }
	) => new Response(opts?.transformPageChunk?.({ html: '<html lang="%course.lang%">' }) ?? '');
	return {
		event,
		set,
		response: handle({ event, resolve } as unknown as Input) as Promise<Response>
	};
}
describe('server hook', () => {
	it('adds the security headers to every response', async () => {
		const response = await run('/lesson-1.1').response;
		for (const [name, value] of Object.entries(securityHeaders))
			expect(response.headers.get(name)).toBe(value);
	});
	it('resolves the locale from the query first, then the cookie, then Bangla', async () => {
		const query = run('/?lang=en', 'bn');
		expect(await (await query.response).text()).toBe('<html lang="en">');
		expect(query.set).toEqual(['en']);
		const cookie = run('/', 'en');
		expect(await (await cookie.response).text()).toBe('<html lang="en">');
		expect(cookie.set).toEqual([]);
		expect(await (await run('/').response).text()).toBe('<html lang="bn">');
	});
	it('remembers the language only on page navigation, never on cacheable endpoints', async () => {
		for (const routeId of ['/search', '/[slug].md', '/sitemap.xml', '/llms.txt', '/robots.txt']) {
			const endpoint = run('/x?lang=en', undefined, routeId);
			await endpoint.response;
			expect(endpoint.set).toEqual([]);
		}
		const page = run('/lesson-1.1?lang=en', undefined, '/(docs)/[slug]');
		await page.response;
		expect(page.set).toEqual(['en']);
	});
	it('redirects plain HTTP to HTTPS with the same path and query', async () => {
		const response = await run(
			'/lesson-1.1?lang=en',
			undefined,
			'/(docs)/[slug]',
			'http://recall.hijal.dev'
		).response;
		expect(response.status).toBe(301);
		expect(response.headers.get('location')).toBe('https://recall.hijal.dev/lesson-1.1?lang=en');
	});
	it('does not redirect HTTPS or local development hosts', async () => {
		expect((await run('/', undefined, '/(docs)', 'https://recall.hijal.dev').response).status).toBe(
			200
		);
		for (const origin of ['http://localhost:8787', 'http://127.0.0.1:5173', 'http://[::1]:8787'])
			expect((await run('/', undefined, '/(docs)', origin).response).status).toBe(200);
	});
});
