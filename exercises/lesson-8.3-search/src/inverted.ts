import { z } from 'zod';
import { commentText, FILLER, STOPWORDS } from './data';

// Lesson 8.3 §1.5–1.6 — an inverted index, by hand, in memory. The core idea inside Postgres's GIN and
// Elasticsearch/Lucene is the same: flipping "which words are in which document" into "which documents contain which word".
//
//   1. build: analyzer (lowercase, split into words, drop stopwords, a small stemmer) → posting lists
//   2. search: a full scan vs the index — the same answer, how long each takes
//   3. two words together (AND): two ways to intersect posting lists, how many comparisons each takes
//   4. ranking: BM25 — which document is most relevant
// No Postgres needed — like.ts's same comments (the same formula), DOCS of them.

const cfg = z
	.object({ DOCS: z.coerce.number().int().positive().default(200_000) })
	.parse(process.env);

const STOP = new Set(STOPWORDS);

// A toy stemmer — a small imitation of a few Porter stemmer rules: deploying/deployment/deployed → deploy,
// invoices/invoice → invoic, received/receive → receiv. A real analyzer has many more rules (and per language).
export function stem(word: string): string {
	let w = word;
	if (w.length > 6 && w.endsWith('ment')) w = w.slice(0, -4);
	else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
	else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
	else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
	if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
	return w;
}

export function analyze(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z]+/)
		.filter((t) => t.length > 0 && !STOP.has(t))
		.map(stem);
}

// posting list: the ids of the documents containing the word (ascending), and how many times in each (term frequency)
type Postings = { docs: number[]; tf: number[] };

const ms = (start: number): string => `${(performance.now() - start).toFixed(1)} ms`;

function main(): void {
	// ── 1. build ────────────────────────────────────────────────
	const docs: string[] = [''];
	for (let i = 1; i <= cfg.DOCS; i++) docs.push(commentText(i));
	let t = performance.now();
	const index = new Map<string, Postings>();
	const docLength = new Int32Array(cfg.DOCS + 1);
	let droppedStop = 0;
	let allTokens = 0;
	for (let id = 1; id <= cfg.DOCS; id++) {
		const raw = (docs[id] ?? '')
			.toLowerCase()
			.split(/[^a-z]+/)
			.filter((x) => x.length > 0);
		allTokens += raw.length;
		droppedStop += raw.filter((x) => STOP.has(x)).length;
		const terms = analyze(docs[id] ?? '');
		docLength[id] = terms.length;
		const counts = new Map<string, number>();
		for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
		for (const [term, count] of counts) {
			let p = index.get(term);
			if (!p) index.set(term, (p = { docs: [], tf: [] }));
			p.docs.push(id); // ids arrive in increasing order — so the list is always sorted
			p.tf.push(count);
		}
	}
	const buildTime = ms(t);
	const postings = [...index.values()].reduce((sum, p) => sum + p.docs.length, 0);
	const longest = [...index.entries()]
		.sort(([, a], [, b]) => b.docs.length - a.docs.length)
		.slice(0, 5);
	// how long the stopwords' posting lists would have been if they were kept
	const stopDocs = STOPWORDS.slice(0, 3).map((s) => {
		let n = 0;
		for (let id = 1; id <= cfg.DOCS; id++)
			if (
				(docs[id] ?? '')
					.toLowerCase()
					.split(/[^a-z]+/)
					.includes(s)
			)
				n++;
		return `${s} ${Math.round((100 * n) / cfg.DOCS)}%`;
	});
	console.log(`\n── 1. Building the index: ${cfg.DOCS.toLocaleString('en')} comments ──`);
	console.log(
		`   time ${buildTime} · distinct terms ${index.size.toLocaleString('en')} · postings ${postings.toLocaleString('en')} (~${((postings * 8) / 1024 / 1024).toFixed(0)} MB, id + tf)`
	);
	console.log(
		`   stopwords dropped: ${droppedStop.toLocaleString('en')} / ${allTokens.toLocaleString('en')} words (${Math.round((100 * droppedStop) / allTokens)}%) — kept, each list would be huge; share of documents: ${stopDocs.join(', ')}`
	);
	console.log(
		`   longest posting lists: ${longest.map(([term, p]) => `${term} ${p.docs.length.toLocaleString('en')}`).join(' · ')}`
	);

	// ── 2. search: scan vs index ────────────────────────────────
	console.log('\n── 2. "deploy checklist" — comments containing both words ──');
	t = performance.now();
	let grep = 0;
	for (let id = 1; id <= cfg.DOCS; id++) {
		const d = (docs[id] ?? '').toLowerCase();
		if (d.includes('deploy') && d.includes('checklist')) grep++;
	}
	console.log(
		`   ${'full scan, substring (like LIKE)'.padEnd(44)}${ms(t).padStart(10)}   ${grep.toLocaleString('en')}`
	);
	t = performance.now();
	const want = analyze('deploy checklist');
	let scanned = 0;
	for (let id = 1; id <= cfg.DOCS; id++) {
		const terms = new Set(analyze(docs[id] ?? ''));
		if (want.every((w) => terms.has(w))) scanned++;
	}
	console.log(
		`   ${'full scan, with the same analyzer'.padEnd(44)}${ms(t).padStart(10)}   ${scanned.toLocaleString('en')}`
	);
	t = performance.now();
	const found = intersect(
		want.map((w) => index.get(w)?.docs ?? []),
		{ count: 0 }
	);
	console.log(
		`   ${'inverted index (intersecting posting lists)'.padEnd(44)}${ms(t).padStart(10)}   ${found.length.toLocaleString('en')}`
	);
	console.log(
		`   (more with substrings: "redeploy" matches "deploy" too; the index also matches "deploying"/"deployment" — the same stem)`
	);

	// ── 3. AND: two ways to intersect posting lists ─────────────
	const common = index.get(FILLER[0] ?? 'kax')?.docs ?? [];
	const rare = index.get('rollback')?.docs ?? [];
	console.log(
		`\n── 3. "${FILLER[0] ?? ''} AND rollback" — one very common (${common.length.toLocaleString('en')} docs), one rare (${rare.length.toLocaleString('en')}) ──`
	);
	const merge = { count: 0 };
	t = performance.now();
	const viaMerge = mergeBoth(common, rare, merge);
	console.log(
		`   ${'walking both lists side by side (merge)'.padEnd(44)}${ms(t).padStart(10)}   comparisons ${merge.count.toLocaleString('en').padStart(9)}   results ${viaMerge.length}`
	);
	const gallop = { count: 0 };
	t = performance.now();
	const viaSmall = intersect([common, rare], gallop);
	console.log(
		`   ${'start from the short list, binary search'.padEnd(44)}${ms(t).padStart(10)}   comparisons ${gallop.count.toLocaleString('en').padStart(9)}   results ${viaSmall.length}`
	);

	// ── 4. ranking: BM25 ────────────────────────────────────────
	console.log('\n── 4. The top 3 for "deploy checklist" — ordered by BM25 ──');
	const avgLen = [...docLength].reduce((a, b) => a + b, 0) / cfg.DOCS;
	const scores = bm25(want, found, index, docLength, avgLen, cfg.DOCS);
	for (const [id, score] of scores.slice(0, 3)) {
		console.log(
			`   #${id} score ${score.toFixed(2)} · ${docLength[id]} terms · "${(docs[id] ?? '').slice(0, 80)}${(docs[id] ?? '').length > 80 ? '…' : ''}"`
		);
	}
	const idf = (term: string): number => {
		const n = index.get(term)?.docs.length ?? 0;
		return Math.log(1 + (cfg.DOCS - n + 0.5) / (n + 0.5));
	};
	console.log(
		`   IDF (the rarer, the heavier): deploy ${idf('deploy').toFixed(2)} · checklist ${idf('checklist').toFixed(2)} · rollback ${idf('rollback').toFixed(2)} · ${FILLER[0] ?? ''} ${idf(FILLER[0] ?? '').toFixed(2)}`
	);
	console.log();
}

// two sorted lists, two fingers walking side by side — comparisons ≈ the sum of the two lists
function mergeBoth(a: number[], b: number[], counter: { count: number }): number[] {
	const out: number[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		counter.count++;
		const x = a[i] ?? 0;
		const y = b[j] ?? 0;
		if (x === y) {
			out.push(x);
			i++;
			j++;
		} else if (x < y) i++;
		else j++;
	}
	return out;
}

// start from the shortest list; binary search every id in the other lists — comparisons ≈ short × log(long)
function intersect(lists: number[][], counter: { count: number }): number[] {
	if (lists.length === 0) return [];
	const sorted = [...lists].sort((a, b) => a.length - b.length);
	const [smallest, ...rest] = sorted;
	return (smallest ?? []).filter((id) =>
		rest.every((list) => {
			let lo = 0;
			let hi = list.length - 1;
			while (lo <= hi) {
				counter.count++;
				const mid = (lo + hi) >> 1;
				const v = list[mid] ?? 0;
				if (v === id) return true;
				if (v < id) lo = mid + 1;
				else hi = mid - 1;
			}
			return false;
		})
	);
}

// BM25: for each word IDF × (a bent form of tf, adjusted for the document's length)
function bm25(
	terms: string[],
	candidates: number[],
	index: Map<string, Postings>,
	docLength: Int32Array,
	avgLen: number,
	total: number,
	k1 = 1.2,
	b = 0.75
): [number, number][] {
	const tfOf = (p: Postings, id: number): number => {
		let lo = 0;
		let hi = p.docs.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const v = p.docs[mid] ?? 0;
			if (v === id) return p.tf[mid] ?? 0;
			if (v < id) lo = mid + 1;
			else hi = mid - 1;
		}
		return 0;
	};
	return candidates
		.map((id): [number, number] => {
			let score = 0;
			for (const term of terms) {
				const p = index.get(term);
				if (!p) continue;
				const n = p.docs.length;
				const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5));
				const tf = tfOf(p, id);
				const len = docLength[id] ?? avgLen;
				score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / avgLen)));
			}
			return [id, score];
		})
		.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
}

main();
