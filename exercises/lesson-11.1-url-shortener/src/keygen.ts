import { createHash } from 'node:crypto';
import { decode, encode, keyspace } from './base62';
import { Permutation } from './scramble';
import { env, heading, mulberry32, n, pct, row, share } from './util';

const SEED = env('SEED', 11);
const LENGTH = env('SCALED_LENGTH', 4);
const PROBES = env('PROBES', 200_000);
const PER_YEAR = env('PER_YEAR', 1_200_000_000);
const SERVERS = env('SERVERS', 20);
const RESTARTS_PER_DAY = env('RESTARTS_PER_DAY', 1);
const CREATES_PER_DAY = env('CREATES_PER_DAY', 3_333_333);
const SECRET = env('SECRET', 20_261_004);
const REAL_FILL = env('REAL_FILL', 0.00341);

const K = keyspace(LENGTH);
const yearsToFill = (fill: number, length: number): string => {
	const years = (fill * keyspace(length)) / PER_YEAR;
	if (years < 1) return `${(years * 12).toFixed(1)} মাস`;
	return `${years < 100 ? years.toFixed(1) : n(years)} বছর`;
};

heading(
	`অংশ ক — random code + "নেওয়া কিনা" check: keyspace ছোট করে ${LENGTH} অক্ষর (${n(K)}), ভরা অনুযায়ী ${n(PROBES)}টা নতুন code`
);
console.log(
	row([
		['ভরা', 10],
		['গড় চেষ্টা', 12],
		['retry লাগল', 13],
		['সর্বোচ্চ চেষ্টা', 15],
		['৬ অক্ষরে কবে', 15],
		['৭ অক্ষরে কবে', 15]
	])
);
{
	const random = mulberry32(SEED);
	const taken = new Uint8Array(K);
	let filled = 0;
	for (const target of [REAL_FILL, 0.01, 0.1, 0.211, 0.5, 0.9]) {
		while (filled < target * K) {
			const slot = Math.floor(random() * K);
			if (taken[slot] === 0) {
				taken[slot] = 1;
				filled++;
			}
		}
		let attempts = 0;
		let retried = 0;
		let worst = 0;
		for (let p = 0; p < PROBES; p++) {
			let tries = 1;
			while (taken[Math.floor(random() * K)] === 1) tries++;
			attempts += tries;
			if (tries > 1) retried++;
			worst = Math.max(worst, tries);
		}
		console.log(
			row([
				[share(filled / K, target < 0.01 ? 3 : 1), 10],
				[(attempts / PROBES).toFixed(4), 12],
				[pct(retried, PROBES, 2), 13],
				[worst, 15],
				[yearsToFill(target, 6), 15],
				[yearsToFill(target, 7), 15]
			])
		);
	}
}
console.log('প্রতিটা চেষ্টা = database এ একটা INSERT ... ON CONFLICT DO NOTHING এর round trip।');

heading(
	`অংশ খ — URL এর hash (MD5) এর প্রথম ${LENGTH} অক্ষর: আলাদা আলাদা URL, collision হলে salt যোগ করে আবার hash`
);
console.log(
	row([
		['ভরা', 10],
		['link', 12],
		['collision হলো', 15],
		['% insert', 10],
		['birthday আন্দাজ', 17],
		['গড় চেষ্টা', 12]
	])
);
{
	const slotOf = (text: string): number => {
		const digest = createHash('md5').update(text).digest();
		return digest.readUIntBE(0, 6) % K;
	};
	const owner = new Int32Array(K).fill(-1);
	let inserted = 0;
	let collided = 0;
	let attempts = 0;
	for (const target of [REAL_FILL, 0.01, 0.1, 0.211]) {
		while (inserted < target * K) {
			const url = `https://example.com/post/${inserted}?utm=${inserted % 97}`;
			let salt = 0;
			let slot = slotOf(url);
			attempts++;
			if (owner[slot] !== -1) collided++;
			while (owner[slot] !== -1) {
				salt++;
				slot = slotOf(`${url}#${salt}`);
				attempts++;
			}
			owner[slot] = inserted;
			inserted++;
		}
		console.log(
			row([
				[share(inserted / K, target < 0.01 ? 3 : 1), 10],
				[n(inserted), 12],
				[n(collided), 15],
				[pct(collided, inserted, 3), 10],
				[n((inserted * inserted) / (2 * K)), 17],
				[(attempts / inserted).toFixed(4), 12]
			])
		);
	}
	console.log(
		'"birthday আন্দাজ" = N² / 2K — N টা জিনিস K টা ঘরে ফেললে মোটামুটি কয়টা জোড়া একই ঘরে পড়ে।'
	);
	const real = REAL_FILL * keyspace(7);
	console.log(
		`৭ অক্ষরে ১০ বছরে (${n(real)} link): আন্দাজে ${n((real * real) / (2 * keyspace(7)))}টা link এর collision সামলাতে হবে।`
	);
}

heading(
	`অংশ গ — অনুমান করে খোঁজা: ${share(REAL_FILL, 3)} ভরা (৭ অক্ষরে ১০ বছরের সমান), নিজের code এর আগের ১০,০০০টা আর ১০,০০০টা random চেষ্টা`
);
{
	const count = Math.round(REAL_FILL * K);
	const random = mulberry32(SEED + 1);
	const perm = new Permutation(K, SECRET);
	const strategies: { name: string; codeOf: (id: number) => number }[] = [
		{ name: 'counter → base62', codeOf: (id) => id },
		{ name: 'random', codeOf: () => Math.floor(random() * K) },
		{ name: 'counter → গোপন permutation → base62', codeOf: (id) => perm.apply(id) }
	];
	console.log(
		row([
			['কৌশল', 40],
			['শেষ ৫টা code', 34],
			['আগেরগুলোয় মিলল', 17],
			['random এ মিলল', 15]
		])
	);
	for (const s of strategies) {
		const taken = new Uint8Array(K);
		const recent: number[] = [];
		for (let id = 0; id < count; id++) {
			let code = s.codeOf(id);
			while (taken[code] === 1) code = s.codeOf(id);
			taken[code] = 1;
			if (id >= count - 5) recent.push(code);
		}
		const mine = recent[recent.length - 1] ?? 0;
		let nearHits = 0;
		for (let d = 1; d <= 10_000; d++) if (taken[(mine - d + K) % K] === 1) nearHits++;
		const guess = mulberry32(SEED + 2);
		let randomHits = 0;
		for (let g = 0; g < 10_000; g++) if (taken[Math.floor(guess() * K)] === 1) randomHits++;
		console.log(
			row([
				[s.name, 40],
				[recent.map((c) => encode(c, LENGTH)).join(' '), 34],
				[pct(nearHits, 10_000, 2), 17],
				[pct(randomHits, 10_000, 2), 15]
			])
		);
	}
}

heading(
	`অংশ ঘ — counter কে ভাগ করা (range allocation): ${SERVERS}টা app server, দিনে ${n(CREATES_PER_DAY)} link, প্রতিটা server দিনে ${RESTARTS_PER_DAY} বার restart`
);
console.log(
	row([
		['block', 8],
		['sequence call / দিন', 21],
		['নষ্ট id / দিন', 16],
		['নষ্ট / বছর, ৭ অক্ষরের', 24],
		['সময়ের উল্টো ক্রম', 18]
	])
);
for (const block of [1, 100, 1_000, 10_000]) {
	const random = mulberry32(SEED + block);
	let sequence = 0;
	let calls = 0;
	let wasted = 0;
	const next = new Array<number>(SERVERS).fill(0);
	const end = new Array<number>(SERVERS).fill(0);
	const restartEvery = Math.floor(CREATES_PER_DAY / (SERVERS * RESTARTS_PER_DAY));
	let previous = -1;
	let outOfOrder = 0;
	for (let i = 0; i < CREATES_PER_DAY; i++) {
		const server = Math.floor(random() * SERVERS);
		if (i > 0 && i % restartEvery === 0) {
			const victim = Math.floor(i / restartEvery) % SERVERS;
			wasted += (end[victim] ?? 0) - (next[victim] ?? 0);
			next[victim] = 0;
			end[victim] = 0;
		}
		if ((next[server] ?? 0) >= (end[server] ?? 0)) {
			next[server] = sequence;
			end[server] = sequence + block;
			sequence += block;
			calls++;
		}
		const id = next[server] ?? 0;
		next[server] = id + 1;
		if (id < previous) outOfOrder++;
		previous = id;
	}
	console.log(
		row([
			[n(block), 8],
			[n(calls), 21],
			[n(wasted), 16],
			[share((wasted * 365) / keyspace(7), 5), 24],
			[pct(outOfOrder, CREATES_PER_DAY, 1), 18]
		])
	);
}
console.log(
	'"সময়ের উল্টো ক্রম" = পরের link এর id আগের link এর চেয়ে ছোট — code দিয়ে সময় ধরে সাজানো যায় না।'
);

heading('অংশ ঙ — গোপন permutation (Feistel + cycle walking) সত্যিই এক-এক কিনা');
{
	const small = keyspace(3);
	const perm = new Permutation(small, SECRET);
	const seen = new Uint8Array(small);
	let unique = 0;
	for (let id = 0; id < small; id++) {
		const out = perm.apply(id);
		if (seen[out] === 0) unique++;
		seen[out] = 1;
	}
	console.log(
		`৩ অক্ষরের পুরো domain (${n(small)}টা id): আলাদা output ${n(unique)}টা — ${unique === small ? 'কোনো collision নেই' : 'COLLISION!'}; বাড়তি round: ${n(perm.walks)} (${pct(perm.walks, small, 1)})`
	);
	const full = new Permutation(keyspace(7), SECRET);
	const codes = [1, 2, 3, 4, 5].map((id) => `${encode(id, 7)} → ${encode(full.apply(id), 7)}`);
	console.log(`৭ অক্ষরে id ১–৫:  ${codes.join('   ')}`);
	const back = decode(encode(full.apply(42), 7));
	console.log(
		`decode(code) একটা সংখ্যা ফেরত দেয় (${n(back)}), কিন্তু সেটা id না — id জানতে secret লাগে।`
	);
}
