import { describe, expect, it } from 'vitest';
import { catalogs } from '$lib/server/course';
import { GET } from './+server';
import type { Locale } from '$lib/docs/i18n';
type Event = Parameters<typeof GET>[0];
function request(slug: string, courseLocale: Locale = 'bn') {
	const url = new URL(`http://localhost/${slug}.md`);
	return GET({ params: { slug }, url, locals: { courseLocale } } as unknown as Event) as Response;
}
describe('lesson markdown route', () => {
	it('serves the edition the request resolved to, and varies on the language cookie', async () => {
		const bn = request('lesson-1.1');
		expect(bn.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
		expect(bn.headers.get('vary')).toBe('Cookie');
		const bnText = await bn.text();
		const enText = await request('lesson-1.1', 'en').text();
		expect(bnText.startsWith('# Lesson 1.1')).toBe(true);
		expect(enText.startsWith('# Lesson 1.1')).toBe(true);
		expect(enText).not.toBe(bnText);
	});
	it('404s for lessons that are unknown or not written yet', () => {
		expect(() => request('lesson-99.1')).toThrow();
		const unwritten = catalogs.bn.lessons.find((l) => !l.available);
		if (unwritten) expect(() => request(`lesson-${unwritten.id}`)).toThrow();
	});
});
