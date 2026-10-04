import { Scheduler } from './scheduler';
import { env, heading, lognormal, ms, mulberry32, n, row } from './util';

const SEED = env('SEED', 11);
const ACCOUNTS = env('ACCOUNTS', 1_000);
const START = env('START', 10_000);
const TRANSFERS = env('TRANSFERS', 200_000);
const RATE = env('RATE', 2_000);
const DB_MS = env('DB_MS', 2);
const CRASH = env('CRASH', 0.001);
const PRICES = env('PRICES', 10_000_000);
const HOT_SHARE = env('HOT_SHARE', 0.3);

type Mode = 'read-write' | 'atomic-rows' | 'ledger' | 'ledger-debit-lock';

interface Outcome {
	drift: number;
	negative: number;
	vanished: number;
	detectable: boolean;
	maxWait: number;
}

function simulate(mode: Mode): Outcome {
	const random = mulberry32(SEED);
	const s = new Scheduler();
	const balance = new Array<number>(ACCOUNTS).fill(START);
	const lockedUntil = new Array<number>(ACCOUNTS).fill(0);
	let ledgerSum = 0;
	let vanished = 0;
	let maxWait = 0;
	for (let i = 0; i < TRANSFERS; i++) {
		const at = (i / RATE) * 1_000;
		const from = Math.floor(random() * ACCOUNTS);
		let to = random() < HOT_SHARE ? 0 : Math.floor(random() * ACCOUNTS);
		if (to === from) to = (to + 1) % ACCOUNTS;
		const amount = 1 + Math.floor(random() * 500);
		const delay = lognormal(random, DB_MS, 0.5);
		const crash = random() < CRASH;
		if (mode === 'read-write') {
			s.at(at, () => {
				const seenFrom = balance[from] ?? 0;
				const seenTo = balance[to] ?? 0;
				if (seenFrom < amount) return;
				s.at(at + delay, () => {
					balance[from] = seenFrom - amount;
					if (crash) {
						vanished++;
						return;
					}
					balance[to] = seenTo + amount;
				});
			});
		} else if (mode === 'atomic-rows') {
			s.at(at, () => {
				if ((balance[from] ?? 0) < amount) return;
				balance[from] = (balance[from] ?? 0) - amount;
				if (crash) {
					vanished++;
					return;
				}
				s.at(at + delay, () => {
					balance[to] = (balance[to] ?? 0) + amount;
				});
			});
		} else {
			const lockTo = mode === 'ledger';
			const start = Math.max(at, lockedUntil[from] ?? 0, lockTo ? (lockedUntil[to] ?? 0) : 0);
			maxWait = Math.max(maxWait, start - at);
			lockedUntil[from] = start + delay;
			if (lockTo) lockedUntil[to] = start + delay;
			s.at(start + delay, () => {
				if (crash) return;
				if ((balance[from] ?? 0) < amount) return;
				balance[from] = (balance[from] ?? 0) - amount;
				balance[to] = (balance[to] ?? 0) + amount;
				ledgerSum += -amount + amount;
			});
		}
	}
	s.run();
	const total = balance.reduce((a, b) => a + b, 0);
	return {
		drift: total - ACCOUNTS * START,
		negative: balance.filter((b) => b < 0).length,
		vanished,
		detectable: mode !== 'read-write' && mode !== 'atomic-rows' && ledgerSum === 0,
		maxWait
	};
}

heading(
	`অংশ ক — ${n(ACCOUNTS)}টা wallet (প্রতিটায় ${n(START)} পয়সা), ${n(TRANSFERS)}টা transfer, সেকেন্ডে ${n(RATE)}, ${HOT_SHARE * 100}% একটা বড় merchant এর wallet এ, DB এর round trip ~${DB_MS} ms, ${CRASH * 100}% মাঝপথে crash`
);
console.log(
	row([
		['নকশা', 52],
		['মোট টাকার বদল', 15],
		['ঋণাত্মক wallet', 15],
		['মাঝপথে হারাল', 14],
		['প্রমাণ করা যায়?', 16],
		['lock এ অপেক্ষা', 14]
	])
);
for (const [mode, name] of [
	['read-write', 'balance column: পড়ো, হিসাব করো, লেখো'],
	['atomic-rows', 'balance column: প্রতিটা row atomic, দুটো আলাদা'],
	['ledger', 'double-entry: এক transaction, দুই account lock'],
	['ledger-debit-lock', 'double-entry: শুধু টাকা যে দেয় তার lock']
] as const) {
	const r = simulate(mode);
	console.log(
		row([
			[name, 52],
			[`${r.drift > 0 ? '+' : ''}${n(r.drift)}`, 15],
			[n(r.negative), 15],
			[n(r.vanished), 14],
			[r.detectable ? 'হ্যাঁ, Σ = 0' : 'না', 16],
			[ms(r.maxWait), 14]
		])
	);
}
console.log('"মোট টাকার বদল" শূন্য হওয়ার কথা — টাকা শুধু এক wallet থেকে আরেকটায় যায়।');

heading(`অংশ খ — ${n(PRICES)}টা দাম যোগ: float এ dollar বনাম integer এ পয়সা`);
{
	const random = mulberry32(SEED + 7);
	let dollars = 0;
	let cents = 0;
	let feePerItem = 0;
	let feeTotalBase = 0;
	for (let i = 0; i < PRICES; i++) {
		const c = 100 + Math.floor(random() * 9_900);
		dollars += c / 100;
		cents += c;
		feePerItem += Math.round(c * 0.029);
		feeTotalBase += c;
	}
	const feeOnce = Math.round(feeTotalBase * 0.029);
	console.log(
		row([
			['float এ যোগ (dollar)', 46],
			[dollars.toFixed(6), 22]
		])
	);
	console.log(
		row([
			['integer এ যোগ (পয়সা) ÷ 100', 46],
			[(cents / 100).toFixed(6), 22]
		])
	);
	console.log(
		row([
			['পার্থক্য', 46],
			[`${((dollars - cents / 100) * 100).toFixed(4)} পয়সা`, 22]
		])
	);
	console.log(`0.1 + 0.2 = ${0.1 + 0.2}; 0.029 * 100 = ${0.029 * 100}`);
	console.log(
		`\nfee ২.৯%: প্রতিটায় round করে যোগ ${n(feePerItem)} পয়সা, মোটের উপর একবার round ${n(feeOnce)} পয়সা — পার্থক্য ${n(feePerItem - feeOnce)} পয়সা`
	);
	console.log(
		'দুটোই "ঠিক" — কিন্তু কোনটা নিয়ম, সেটা লিখে রাখতে হয়, নইলে দুই system এর হিসাব কখনো মেলে না।'
	);
}
