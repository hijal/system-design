import { describe, expect, it } from 'vitest';
import { createCatalog } from './catalog';
import { buildSitemap } from './sitemap';
const base = `## ৯. Curriculum
### Module 1: Fundamentals
- 1.1 Both editions
- 1.2 Bangla only
- 1.3 Not written yet
- **Module Exit Challenge**
## ১০. Interaction Commands`;
const sources = {
	'/course/module-01/lesson-1.1-both.md': '# 1.1\n\nবাংলা body',
	'/course/module-01/lesson-1.1-both.en.md': '# 1.1\n\nEnglish body',
	'/course/module-01/lesson-1.2-bn.md': '# 1.2\n\nবাংলা body',
	'/course/module-01/lesson-1.3-draft.md': '# 1.3',
	'/course/module-01/module-1-exit-challenge.md': '# Challenge\n\nবাংলা challenge'
};
const catalogs = {
	bn: createCatalog(base, sources, 'bn'),
	en: createCatalog(base, sources, 'en')
};
const xml = buildSitemap('https://example.com', catalogs);
const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
describe('sitemap', () => {
	it('lists every written edition, and nothing that is unwritten', () => {
		expect(locs).toEqual([
			'https://example.com/?lang=bn',
			'https://example.com/?lang=en',
			'https://example.com/lesson-1.1?lang=bn',
			'https://example.com/lesson-1.1?lang=en',
			'https://example.com/lesson-1.2?lang=bn',
			'https://example.com/lesson-1-challenge?lang=bn'
		]);
	});
	it('links each page only to editions that exist', () => {
		const entry = (loc: string) =>
			xml.split('<url>').find((block) => block.includes(`<loc>${loc}</loc>`)) ?? '';
		const both = entry('https://example.com/lesson-1.1?lang=en');
		expect(both).toContain('hreflang="bn" href="https://example.com/lesson-1.1?lang=bn"');
		expect(both).toContain('hreflang="en" href="https://example.com/lesson-1.1?lang=en"');
		expect(both).toContain('hreflang="x-default" href="https://example.com/lesson-1.1"');
		const bnOnly = entry('https://example.com/lesson-1.2?lang=bn');
		expect(bnOnly).not.toContain('hreflang="en"');
	});
	it('is a well-formed urlset', () => {
		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset')).toBe(true);
		expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
		expect(xml.split('<url>').length - 1).toBe(xml.split('</url>').length - 1);
	});
});
