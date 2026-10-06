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
	it('ranks a lesson whose glossary defines the query above lessons that only mention it', () => {
		const glossaryBase = `## ৯. Curriculum
### Module 2: Data
- 2.1 Replication
- 2.2 Transactions
- 2.3 Lost updates in depth
## ১০. Interaction Commands`;
		const glossaryIndex = buildSearchIndex(
			createCatalog(
				glossaryBase,
				{
					'/course/module-02/lesson-2.1-replication.md':
						'# 2.1\n\nA replica can show a lost update when two writers race, and not a term is mentioned here.\n\n## ৪. নতুন Term (Glossary)\n\n| Term | অর্থ |\n| --- | --- |\n| **Replica** | a copy |',
					'/course/module-02/lesson-2.2-transactions.md':
						'# 2.2\n\nIsolation levels.\n\n## ৪. নতুন Term (Glossary)\n\n| Term | অর্থ |\n| --- | --- |\n| **Lost Update** | one write silently wipes out another |\n\n## ৫. Reflection Questions\n\n| **Not a term** | x |',
					'/course/module-02/lesson-2.3-lost-updates.md': '# 2.3\n\nMore about a lost update.'
				},
				'bn'
			),
			'bn'
		);
		expect(search(glossaryIndex, 'lost update').results.map((r) => r.id)).toEqual([
			'2.3',
			'2.2',
			'2.1'
		]);
		expect(search(glossaryIndex, 'not a term').results.map((r) => r.id)).toEqual(['2.1', '2.2']);
		expect(search(glossaryIndex, 'replica').results.map((r) => r.id)).toEqual(['2.1']);
	});
	it('only looks at the first 100 characters of a query', () => {
		expect(search(index, `keep hot ${'x'.repeat(5000)}`)).toEqual({ results: [], total: 0 });
		expect(search(index, `${' '.repeat(5)}keep hot${' '.repeat(5000)}x`).total).toBe(1);
	});
});
