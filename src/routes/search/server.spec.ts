import { describe, expect, it } from 'vitest';
import { GET } from './+server';
type Event = Parameters<typeof GET>[0];
function request(query: string) {
	const url = new URL(`http://localhost/search?${query}`);
	return GET({ url } as unknown as Event) as Response;
}
describe('search route', () => {
	it('returns lessons for the requested edition, cacheable for a short while', async () => {
		const response = request('q=redis&lang=en');
		expect(response.headers.get('cache-control')).toBe('public, max-age=300');
		const body = (await response.json()) as { results: { id: string; href: string }[] };
		expect(body.results.length).toBeGreaterThan(0);
		expect(body.results.every((r) => r.href.endsWith('lang=en'))).toBe(true);
	});
	it('returns nothing for an empty or one-character query', async () => {
		expect(await request('q=').json()).toEqual({ results: [] });
		expect(await request('q=a').json()).toEqual({ results: [] });
	});
});
