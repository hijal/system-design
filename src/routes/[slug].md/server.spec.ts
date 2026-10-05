import { describe, expect, it } from 'vitest';
import { catalogs } from '$lib/server/course';
import { GET } from './+server';
type Event = Parameters<typeof GET>[0];
function request(slug: string, query = '') {
	const url = new URL(`https://recall.hijal.dev/${slug}.md${query}`);
	return GET({ params: { slug }, url } as unknown as Event) as Response;
}
function redirectOf(slug: string, query = '') {
	try {
		request(slug, query);
	} catch (thrown) {
		return thrown as { status: number; location: string };
	}
	return null;
}
describe('lesson markdown route', () => {
	it('serves Bangla unless the URL asks for English, without varying on cookies', async () => {
		const bn = request('lesson-1.1');
		expect(bn.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
		expect(bn.headers.get('vary')).toBeNull();
		const bnText = await bn.text();
		const enText = await request('lesson-1.1', '?lang=en').text();
		expect(await request('lesson-1.1', '?lang=bn').text()).toBe(bnText);
		expect(bnText.startsWith('# Lesson 1.1')).toBe(true);
		expect(enText.startsWith('# Lesson 1.1')).toBe(true);
		expect(enText).not.toBe(bnText);
	});
	it('points search engines at the HTML page of the same edition', () => {
		expect(request('lesson-1.1').headers.get('link')).toBe(
			'<https://recall.hijal.dev/lesson-1.1?lang=bn>; rel="canonical"'
		);
		expect(request('lesson-1-challenge', '?lang=en').headers.get('link')).toBe(
			'<https://recall.hijal.dev/lesson-1-challenge?lang=en>; rel="canonical"'
		);
	});
	it('answers unknown or unwritten lessons with a plain-text 404 in the requested language', async () => {
		const missing = request('lesson-99.1');
		expect(missing.status).toBe(404);
		expect(missing.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(await missing.text()).toBe('এই lesson-টি পাওয়া যায়নি।\n');
		expect(await request('lesson-99.1', '?lang=en').text()).toBe('Lesson not found.\n');
		const unwritten = catalogs.bn.lessons.find((l) => !l.available);
		if (unwritten) expect(request(`lesson-${unwritten.id}`).status).toBe(404);
	});
	it('redirects a lesson number without the lesson- prefix to the real URL', () => {
		expect(redirectOf('1.1')).toMatchObject({ status: 308, location: '/lesson-1.1.md' });
		expect(redirectOf('1.1', '?lang=en')).toMatchObject({
			status: 308,
			location: '/lesson-1.1.md?lang=en'
		});
		expect(redirectOf('1-challenge')).toMatchObject({ location: '/lesson-1-challenge.md' });
		expect(redirectOf('lesson-1.1')).toBeNull();
		expect(request('99.1').status).toBe(404);
	});
});
