import { describe, expect, it } from 'vitest';
import { handle, securityHeaders } from './hooks.server';
type Input = Parameters<typeof handle>[0];
function run(path: string, cookie?: string) {
	const set: string[] = [];
	const event = {
		url: new URL(`http://localhost${path}`),
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
});
