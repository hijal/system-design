import { describe, expect, it } from 'vitest';
import { createCatalog } from './catalog';
import { buildSearchIndex, search } from './search';
const base = `## ৯. Curriculum
### Module 1: Fundamentals
- 1.1 Caching basics
- 1.2 Queues
- 1.3 Not written yet
## ১০. Interaction Commands`;
const sources = {
	'/course/module-01/lesson-1.1-caching.md': '# 1.1\n\nKeep hot data close. See `redis` below.',
	'/course/module-01/lesson-1.2-queues.md':
		'# 1.2\n\nA queue sits in front of a slow worker, like a cache sits in front of a database.',
	'/course/module-01/lesson-1.3-draft.md': '# 1.3'
};
const index = buildSearchIndex(createCatalog(base, sources, 'bn'), 'bn');
describe('lesson search', () => {
	it('ranks title matches above lessons that only mention the query', () => {
		expect(search(index, 'queue').results.map((r) => r.id)).toEqual(['1.2']);
		expect(search(index, 'cach').results.map((r) => r.id)).toEqual(['1.1', '1.2']);
		expect(search(index, 'database').results.map((r) => r.id)).toEqual(['1.2']);
	});
	it('matches case-insensitively and by lesson number', () => {
		expect(search(index, 'KEEP HOT').results[0]?.id).toBe('1.1');
		expect(search(index, '1.2').results[0]?.id).toBe('1.2');
	});
	it('ignores short queries, unwritten lessons, and inline code', () => {
		expect(search(index, 'c')).toEqual({ results: [], total: 0 });
		expect(search(index, 'not written')).toEqual({ results: [], total: 0 });
		expect(search(index, 'redis')).toEqual({ results: [], total: 0 });
	});
	it('returns a snippet around the match', () => {
		expect(search(index, 'database').results[0]?.snippet).toContain('in front of a database');
	});
	it('reports the total number of matches even when the list is cut', () => {
		const response = search(index, 'cach', 1);
		expect(response.results.map((r) => r.id)).toEqual(['1.1']);
		expect(response.total).toBe(2);
	});
	it('only looks at the first 100 characters of a query', () => {
		expect(search(index, `keep hot ${'x'.repeat(5000)}`)).toEqual({ results: [], total: 0 });
		expect(search(index, `${' '.repeat(5)}keep hot${' '.repeat(5000)}x`).total).toBe(1);
	});
});
