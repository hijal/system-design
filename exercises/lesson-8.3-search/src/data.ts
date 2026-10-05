import { Pool } from 'pg';
import { z } from 'zod';

// Lesson 8.3 — TaskFlow's comments, from a fixed formula. Comment number i always has the same text — so
// the text kept in Postgres and the text in inverted.ts's own index match exactly.
//
// Every comment is 6–25 words: 35% short common words (the, to, and — "stopwords"), 15% TaskFlow work
// words (deploy, invoice, bug …), the rest from 5000 made-up words in a Zipf distribution (a few very common,
// most rare — like a real language).

export const env = z
	.object({
		DATABASE_URL: z.string().default('postgres://taskflow:taskflow@localhost:5446/taskflow'),
		ROWS: z.coerce.number().int().positive().default(1_000_000)
	})
	.parse(process.env);

export function pgPool(max = 4): Pool {
	return new Pool({ connectionString: env.DATABASE_URL, max });
}

function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export const STOPWORDS = [
	'the',
	'a',
	'to',
	'and',
	'is',
	'for',
	'on',
	'in',
	'of',
	'this',
	'we',
	'it',
	'with',
	'be',
	'please',
	'can',
	'after',
	'before',
	'our',
	'should'
];

// TaskFlow's work words, and how often they appear (relative weight). A few are there on purpose:
// deploy/deployment/deploying/redeploy (stemming), login/blog/catalog (substrings of "log"),
// start/party/article/smart/art (substrings of "art"), receive (will be searched misspelled)
export const DOMAIN: ReadonlyArray<readonly [string, number]> = [
	['deploy', 20],
	['deployment', 8],
	['deploying', 6],
	['redeploy', 2],
	['checklist', 8],
	['invoice', 10],
	['invoices', 4],
	['receive', 6],
	['received', 4],
	['release', 15],
	['notes', 10],
	['bug', 20],
	['fix', 18],
	['login', 8],
	['blog', 2],
	['catalog', 2],
	['timeout', 6],
	['database', 8],
	['migration', 6],
	['start', 10],
	['started', 5],
	['party', 1],
	['article', 2],
	['art', 1],
	['smart', 2],
	['review', 12],
	['design', 10],
	['mockup', 5],
	['customer', 12],
	['payment', 6],
	['refund', 3],
	['urgent', 5],
	['staging', 6],
	['production', 7],
	['rollback', 1]
];

const SYLLABLES = [
	'ka',
	'lo',
	'mi',
	'ra',
	'to',
	'ne',
	'su',
	'vi',
	'po',
	'da',
	'ze',
	'fu',
	'ri',
	'no',
	'ba',
	'te'
];

// 5000 made-up words — each distinct, and none matches a real word (they end in "x")
export const FILLER = Array.from({ length: 5000 }, (_, i) => {
	let n = i;
	let word = '';
	do {
		word += SYLLABLES[n % SYLLABLES.length] ?? '';
		n = Math.floor(n / SYLLABLES.length);
	} while (n > 0);
	return `${word}x`;
});

function cumulative(weights: number[]): Float64Array {
	const out = new Float64Array(weights.length);
	let sum = 0;
	weights.forEach((w, i) => (out[i] = sum += w));
	return out.map((x) => x / sum);
}

function pick(cdf: Float64Array, r: number): number {
	let lo = 0;
	let hi = cdf.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((cdf[mid] ?? 1) < r) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

const fillerCdf = cumulative(FILLER.map((_, rank) => 1 / (rank + 1))); // Zipf
const domainCdf = cumulative(DOMAIN.map(([, w]) => w));

// the text of comment number i (from 1)
export function commentText(i: number): string {
	const random = mulberry32(Math.imul(i, 2654435761) ^ 0x5bd1e995);
	const length = 6 + Math.floor(random() * 20);
	const words: string[] = [];
	for (let w = 0; w < length; w++) {
		const r = random();
		if (r < 0.35) words.push(STOPWORDS[Math.floor(random() * STOPWORDS.length)] ?? 'the');
		else if (r < 0.5) words.push(DOMAIN[pick(domainCdf, random())]?.[0] ?? 'bug');
		else words.push(FILLER[pick(fillerCdf, random())] ?? 'kax');
	}
	const text = words.join(' ');
	return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}
