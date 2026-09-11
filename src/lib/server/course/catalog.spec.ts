import { describe, expect, it } from 'vitest';
import { createCatalog } from './catalog';
import { renderLesson } from './render';
const base = `## ৯. Curriculum
### Module 1: Fundamentals + Thinking Framework
- 1.1 **System Design আসলে কী**
- 1.2 The Design Framework
- **Module Exit Challenge**
### Module 2: Networking & Communication
- 2.1 DNS
## ১০. Interaction Commands`;
const sources = {
	'/course/module-01/lesson-1.1-topic.md': '# Lesson 1.1 — Topic\n\nবাংলায় lesson content।',
	'/course/module-01/lesson-1.1-topic.en.md': '# Lesson 1.1 — Topic\n\nEnglish lesson content.',
	'/course/module-01/lesson-1.2-framework.md': '# Lesson 1.2 — Placeholder',
	'/course/module-01/module-1-exit-challenge.md': '# Challenge\n\nDesign a system.'
};
describe('course discovery', () => {
	it('uses the base curriculum order, including missing files and exit challenges', () => {
		const course = createCatalog(base, sources);
		expect(course.lessons.map((l) => l.id)).toEqual(['1.1', '1.2', '1-challenge', '2.1']);
		expect(course.modules[0].title).toBe('Fundamentals + Thinking Framework');
		expect(course.lessons.map((l) => l.available)).toEqual([true, false, true, false]);
	});
	it('keeps language editions separate and links in the selected language', () => {
		const course = createCatalog(base, sources, 'en');
		expect(course.lessons[0]).toMatchObject({
			available: true,
			otherAvailable: true,
			href: '/lesson-1.1?lang=en',
			title: 'What is System Design?'
		});
		expect(course.lessons[2]).toMatchObject({ available: false, otherAvailable: true });
	});
	it('discovers a newly populated numbered file without a navigation edit', () => {
		const course = createCatalog(
			base,
			{
				...sources,
				'/course/module-02/lesson-2.1-any-title.en.md': '# DNS\n\nA new English lesson.'
			},
			'en'
		);
		expect(course.lessons[3]).toMatchObject({ available: true, href: '/lesson-2.1?lang=en' });
	});
	it('rejects ambiguous duplicate numbers in the same language', () => {
		expect(() =>
			createCatalog(base, { ...sources, '/course/module-01/lesson-1.1-other.md': '# Duplicate' })
		).toThrow('Duplicate course ID 1.1:bn');
	});
});
describe('lesson rendering', () => {
	it('preserves safe answer-key disclosures, code, and tables while removing executable HTML', () => {
		const rendered = renderLesson(
			'# Title\n\n<details>\n<summary>Answer</summary>\n\n**Explanation**\n\n</details>\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n```typescript\nconst value: number = 1;\n```\n\n| Key | Value |\n| --- | --- |\n| A | B |',
			'bn'
		);
		expect(rendered.html).toContain('<details>');
		expect(rendered.html).toContain('<strong>Explanation</strong>');
		expect(rendered.html).toContain('token keyword');
		expect(rendered.html).toContain('<table>');
		expect(rendered.html).not.toMatch(/<script|onerror/);
	});
	it('creates unique Bangla heading anchors and resolves relative lesson links', () => {
		const rendered = renderLesson(
			'# Title\n\n## নতুন বিষয়\n\n## নতুন বিষয়\n\n[Next](../module-02/lesson-2.1-dns.md#dns)',
			'en'
		);
		expect(rendered.headings.map((h) => h.id)).toEqual(['নতুন-বিষয়', 'নতুন-বিষয়-2']);
		expect(rendered.html).toContain('href="/lesson-2.1?lang=en#dns"');
	});
});
