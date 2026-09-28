import { z } from 'zod';
import { commentText, FILLER, STOPWORDS } from './data';

// Lesson 8.3 §১.৫–১.৬ — একটা inverted index, নিজের হাতে, memory তে। Postgres এর GIN, Elasticsearch/Lucene এর
// ভেতরের মূল ধারণা একই: "কোন document এ কোন শব্দ" কে উল্টে "কোন শব্দ কোন কোন document এ"।
//
//   ১. বানানো: analyzer (ছোট হাতের অক্ষর, শব্দে ভাঙা, stopword বাদ, একটা ছোট stemmer) → posting list
//   ২. খোঁজা: পুরো scan বনাম index — একই উত্তর, সময় কত
//   ৩. দুটো শব্দ একসাথে (AND): posting list মেলানোর দুটো উপায়, কয়টা তুলনা লাগে
//   ৪. সাজানো: BM25 — কোন document সবচেয়ে প্রাসঙ্গিক
// Postgres লাগে না — like.ts এর একই comment (একই সূত্র), DOCS টা।

const cfg = z
	.object({ DOCS: z.coerce.number().int().positive().default(200_000) })
	.parse(process.env);

const STOP = new Set(STOPWORDS);

// খেলনা stemmer — Porter stemmer এর কয়েকটা নিয়মের ছোট নকল: deploying/deployment/deployed → deploy,
// invoices/invoice → invoic, received/receive → receiv। আসল analyzer এর নিয়ম অনেক বেশি (আর ভাষা ধরে)।
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

// posting list: শব্দটা আছে এমন document এর id (ছোট থেকে বড়), আর প্রতিটায় কতবার (term frequency)
type Postings = { docs: number[]; tf: number[] };

const ms = (start: number): string => `${(performance.now() - start).toFixed(1)} ms`;

function main(): void {
	// ── ১. বানানো ──────────────────────────────────────────────
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
			p.docs.push(id); // id বাড়তে থাকা ক্রমে আসে — তাই list সবসময় sorted
			p.tf.push(count);
		}
	}
	const buildTime = ms(t);
	const postings = [...index.values()].reduce((sum, p) => sum + p.docs.length, 0);
	const longest = [...index.entries()]
		.sort(([, a], [, b]) => b.docs.length - a.docs.length)
		.slice(0, 5);
	// stopword রাখলে তাদের posting list কত লম্বা হতো
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
	console.log(`\n── ১. Index বানানো: ${cfg.DOCS.toLocaleString('en')} টা comment ──`);
	console.log(
		`   সময় ${buildTime} · আলাদা term ${index.size.toLocaleString('en')} · posting ${postings.toLocaleString('en')} (~${((postings * 8) / 1024 / 1024).toFixed(0)} MB, id + tf)`
	);
	console.log(
		`   বাদ পড়া stopword: ${droppedStop.toLocaleString('en')} / ${allTokens.toLocaleString('en')} শব্দ (${Math.round((100 * droppedStop) / allTokens)}%) — রাখলে প্রতিটার list বিশাল, কত ভাগ document এ: ${stopDocs.join(', ')}`
	);
	console.log(
		`   সবচেয়ে লম্বা posting list: ${longest.map(([term, p]) => `${term} ${p.docs.length.toLocaleString('en')}`).join(' · ')}`
	);

	// ── ২. খোঁজা: scan বনাম index ─────────────────────────────
	console.log('\n── ২. "deploy checklist" — দুটো শব্দই আছে এমন comment ──');
	t = performance.now();
	let grep = 0;
	for (let id = 1; id <= cfg.DOCS; id++) {
		const d = (docs[id] ?? '').toLowerCase();
		if (d.includes('deploy') && d.includes('checklist')) grep++;
	}
	console.log(
		`   পুরো scan, substring (LIKE এর মতো)        ${ms(t).padStart(10)}   ${grep.toLocaleString('en')} টা`
	);
	t = performance.now();
	const want = analyze('deploy checklist');
	let scanned = 0;
	for (let id = 1; id <= cfg.DOCS; id++) {
		const terms = new Set(analyze(docs[id] ?? ''));
		if (want.every((w) => terms.has(w))) scanned++;
	}
	console.log(
		`   পুরো scan, একই analyzer দিয়ে             ${ms(t).padStart(10)}   ${scanned.toLocaleString('en')} টা`
	);
	t = performance.now();
	const found = intersect(
		want.map((w) => index.get(w)?.docs ?? []),
		{ count: 0 }
	);
	console.log(
		`   inverted index (দুটো posting list মেলানো) ${ms(t).padStart(10)}   ${found.length.toLocaleString('en')} টা`
	);
	console.log(
		`   (substring এ বেশি: "redeploy" ও "deploy" ধরে; index এ "deploying"/"deployment" ও মেলে — stem একই)`
	);

	// ── ৩. AND: posting list মেলানোর দুই উপায় ─────────────────
	const common = index.get(FILLER[0] ?? 'kax')?.docs ?? [];
	const rare = index.get('rollback')?.docs ?? [];
	console.log(
		`\n── ৩. "${FILLER[0] ?? ''} AND rollback" — একটা খুব সাধারণ (${common.length.toLocaleString('en')} টা doc), একটা বিরল (${rare.length.toLocaleString('en')} টা) ──`
	);
	const merge = { count: 0 };
	t = performance.now();
	const viaMerge = mergeBoth(common, rare, merge);
	console.log(
		`   দুটো list পাশাপাশি হাঁটা (merge)          ${ms(t).padStart(10)}   তুলনা ${merge.count.toLocaleString('en').padStart(9)}   ফল ${viaMerge.length}`
	);
	const gallop = { count: 0 };
	t = performance.now();
	const viaSmall = intersect([common, rare], gallop);
	console.log(
		`   ছোট list থেকে শুরু, বড়টায় binary search   ${ms(t).padStart(10)}   তুলনা ${gallop.count.toLocaleString('en').padStart(9)}   ফল ${viaSmall.length}`
	);

	// ── ৪. সাজানো: BM25 ────────────────────────────────────────
	console.log('\n── ৪. "deploy checklist" এর সেরা ৩টা — BM25 দিয়ে সাজানো ──');
	const avgLen = [...docLength].reduce((a, b) => a + b, 0) / cfg.DOCS;
	const scores = bm25(want, found, index, docLength, avgLen, cfg.DOCS);
	for (const [id, score] of scores.slice(0, 3)) {
		console.log(
			`   #${id} score ${score.toFixed(2)} · ${docLength[id]} টা term · "${(docs[id] ?? '').slice(0, 80)}${(docs[id] ?? '').length > 80 ? '…' : ''}"`
		);
	}
	const idf = (term: string): number => {
		const n = index.get(term)?.docs.length ?? 0;
		return Math.log(1 + (cfg.DOCS - n + 0.5) / (n + 0.5));
	};
	console.log(
		`   IDF (যত বিরল, তত ভারী): deploy ${idf('deploy').toFixed(2)} · checklist ${idf('checklist').toFixed(2)} · rollback ${idf('rollback').toFixed(2)} · ${FILLER[0] ?? ''} ${idf(FILLER[0] ?? '').toFixed(2)}`
	);
	console.log();
}

// দুটো sorted list, দুই আঙুলে পাশাপাশি — তুলনা ≈ দুটো list এর যোগফল
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

// সবচেয়ে ছোট list থেকে শুরু; প্রতিটা id বাকি list গুলোয় binary search — তুলনা ≈ ছোট × log(বড়)
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

// BM25: প্রতিটা শব্দের জন্য IDF × (tf এর একটা বাঁকানো রূপ, document এর দৈর্ঘ্য অনুযায়ী ঠিক করা)
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
