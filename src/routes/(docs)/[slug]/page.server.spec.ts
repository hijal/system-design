import { describe, expect, it } from 'vitest';
import { load } from './+page.server';
type Event = Parameters<typeof load>[0];
function redirectOf(slug: string, query = '', courseLocale: 'bn' | 'en' = 'bn') {
	try {
		load({
			params: { slug },
			locals: { courseLocale },
			url: new URL(`http://localhost/${slug}${query}`)
		} as unknown as Event);
	} catch (thrown) {
		return thrown as { status: number; location: string };
	}
	return null;
}
describe('lesson aliases', () => {
	it('redirect permanently without pinning the cookie language', () => {
		expect(redirectOf('caching', '', 'en')).toMatchObject({ status: 308, location: '/lesson-4.1' });
		expect(redirectOf('load-balancing')).toMatchObject({ status: 308, location: '/lesson-3.1' });
	});
	it('keep a language the URL asked for', () => {
		expect(redirectOf('caching', '?lang=en')).toMatchObject({
			status: 308,
			location: '/lesson-4.1?lang=en'
		});
		expect(redirectOf('caching', '?lang=xx')).toMatchObject({ location: '/lesson-4.1' });
	});
	it('send a lesson number without the lesson- prefix to the real URL', () => {
		expect(redirectOf('1.1')).toMatchObject({ status: 308, location: '/lesson-1.1' });
		expect(redirectOf('1.1', '?lang=en')).toMatchObject({
			status: 308,
			location: '/lesson-1.1?lang=en'
		});
		expect(redirectOf('1-challenge')).toMatchObject({ location: '/lesson-1-challenge' });
		expect(redirectOf('99.1')).toMatchObject({ status: 404 });
	});
	it('does not redirect real lessons', () => {
		expect(redirectOf('lesson-1.1')).toBeNull();
	});
});
