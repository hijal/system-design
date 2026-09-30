import {
	BloomFilter,
	CountingBloomFilter,
	bitsForRate,
	falsePositives,
	optimalHashes,
	theoreticalRate
} from './bloom';
import { heading, pct, row } from './random';

const ITEMS = Number(process.env.ITEMS ?? 1_000_000);
const PROBES = Number(process.env.PROBES ?? 1_000_000);
const TARGET = Number(process.env.TARGET ?? 0.01);

const member = (i: number): string => `username:${i}`;
const kb = (bits: number): string => `${Math.round(bits / 8 / 1024).toLocaleString('en-US')} KB`;

function fill(filter: { add(key: string): void }, from: number, to: number): void {
	for (let i = from; i < to; i++) filter.add(member(i));
}

function bitsPerItem(): void {
	heading(
		`ক. ${ITEMS.toLocaleString('en-US')}টা নাম, আর ${PROBES.toLocaleString('en-US')}টা নাম যা কখনো ঢোকানো হয়নি — কতগুলোকে "হয়তো আছে" বলে?`
	);
	console.log(
		row([
			['bit / নাম', 12],
			['k', 5],
			['মাপা false positive', 22],
			['তত্ত্ব', 10],
			['memory', 12]
		])
	);
	for (const perItem of [4, 6, 8, 10, 12, 16, 20]) {
		const hashes = optimalHashes(perItem);
		const filter = new BloomFilter(ITEMS * perItem, hashes);
		fill(filter, 0, ITEMS);
		const wrong = falsePositives(filter, 'never', PROBES);
		console.log(
			row([
				[perItem, 12],
				[hashes, 5],
				[pct(wrong, PROBES, 3), 22],
				[pct(theoreticalRate(ITEMS * perItem, ITEMS, hashes) * PROBES, PROBES, 3), 10],
				[kb(ITEMS * perItem), 12]
			])
		);
	}
	const missed = (() => {
		const filter = new BloomFilter(ITEMS * 10, optimalHashes(10));
		fill(filter, 0, ITEMS);
		let count = 0;
		for (let i = 0; i < ITEMS; i++) if (!filter.has(member(i))) count++;
		return count;
	})();
	console.log(
		`   ঢোকানো ${ITEMS.toLocaleString('en-US')}টা নামের কয়টাকে "নেই" বলল (false negative): ${missed}`
	);
	console.log(
		`   ${pct(TARGET, 1, 1)} এর জন্য লাগে ${(bitsForRate(ITEMS, TARGET) / ITEMS).toFixed(2)} bit/নাম; ${pct(TARGET / 10, 1, 1)} এর জন্য ${(bitsForRate(ITEMS, TARGET / 10) / ITEMS).toFixed(2)}`
	);
}

function hashCount(): void {
	heading('খ. ১০ bit/নাম স্থির রেখে hash function এর সংখ্যা (k) বদলালে');
	console.log(
		row([
			['k', 5],
			['মাপা false positive', 22],
			['তত্ত্ব', 10],
			['bit এর কত % ১', 16]
		])
	);
	for (const hashes of [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16]) {
		const filter = new BloomFilter(ITEMS * 10, hashes);
		fill(filter, 0, ITEMS);
		const wrong = falsePositives(filter, 'never', PROBES);
		console.log(
			row([
				[hashes, 5],
				[pct(wrong, PROBES, 3), 22],
				[pct(theoreticalRate(ITEMS * 10, ITEMS, hashes) * PROBES, PROBES, 3), 10],
				[pct(filter.fillRatio(), 1, 1), 16]
			])
		);
	}
}

function overfill(): void {
	const filter = BloomFilter.forCapacity(ITEMS, TARGET);
	heading(
		`গ. ${ITEMS.toLocaleString('en-US')}টা নামের জন্য ${pct(TARGET, 1, 0)} ধরে বানানো filter (${kb(filter.size)}, k = ${filter.hashes}) — তারপর বেশি ঢোকালে`
	);
	console.log(
		row([
			['ঢোকানো', 14],
			['ধারণক্ষমতার', 13],
			['মাপা false positive', 22],
			['bit এর কত % ১', 16]
		])
	);
	let inserted = 0;
	for (const multiple of [0.5, 1, 1.5, 2, 3, 5]) {
		const target = Math.round(ITEMS * multiple);
		fill(filter, inserted, target);
		inserted = target;
		const wrong = falsePositives(filter, 'never', PROBES / 4);
		console.log(
			row([
				[inserted.toLocaleString('en-US'), 14],
				[`${multiple}x`, 13],
				[pct(wrong, PROBES / 4, 2), 22],
				[pct(filter.fillRatio(), 1, 1), 16]
			])
		);
	}
}

function deletion(): void {
	const removed = Math.round(ITEMS / 10);
	heading(
		`ঘ. ${removed.toLocaleString('en-US')}টা নাম মুছে ফেলা হলো (account delete) — বাকি ${(ITEMS - removed).toLocaleString('en-US')}টার কী হলো?`
	);
	console.log(
		row([
			['পদ্ধতি', 30],
			['memory', 12],
			['থাকা নাম কে "নেই"', 19],
			['মোছা নাম কে "আছে"', 19],
			['নতুন false positive', 21]
		])
	);
	const size = bitsForRate(ITEMS, TARGET);
	const hashes = optimalHashes(size / ITEMS);

	const untouched = new BloomFilter(size, hashes);
	fill(untouched, 0, ITEMS);
	const naive = new BloomFilter(size, hashes);
	fill(naive, 0, ITEMS);
	for (let i = 0; i < removed; i++) naive.clearBitsOf(member(i));
	const counting = new CountingBloomFilter(size, hashes);
	fill(counting, 0, ITEMS);
	for (let i = 0; i < removed; i++) counting.remove(member(i));

	const cases: [string, { has(key: string): boolean }, number][] = [
		['মুছি না, রেখে দিই', untouched, size],
		['সাধারণ bloom, bit মুছে', naive, size],
		['counting bloom (৪-bit counter)', counting, counting.memoryBits()]
	];
	for (const [label, filter, bits] of cases) {
		let lost = 0;
		for (let i = removed; i < ITEMS; i++) if (!filter.has(member(i))) lost++;
		let ghosts = 0;
		for (let i = 0; i < removed; i++) if (filter.has(member(i))) ghosts++;
		const wrong = falsePositives(filter, 'never', PROBES / 4);
		console.log(
			row([
				[label, 30],
				[kb(bits), 12],
				[lost.toLocaleString('en-US'), 19],
				[pct(ghosts, removed, 1), 19],
				[pct(wrong, PROBES / 4, 2), 21]
			])
		);
	}
	console.log(`   counting bloom এ ১৫ ছুঁয়ে আটকে যাওয়া counter: ${counting.saturated}`);
}

bitsPerItem();
hashCount();
overfill();
deletion();
