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
	`Part A - ${n(ACCOUNTS)} wallets (${n(START)} cents in each), ${n(TRANSFERS)} transfers, ${n(RATE)} a second, ${HOT_SHARE * 100}% to one big merchant's wallet, DB round trip ~${DB_MS} ms, ${CRASH * 100}% crash midway`
);
console.log(
	row([
		['design', 60],
		['total change', 15],
		['negative wallets', 18],
		['lost midway', 14],
		['provable?', 16],
		['wait on locks', 15]
	])
);
for (const [mode, name] of [
	['read-write', 'balance column: read, compute, write'],
	['atomic-rows', 'balance column: each row atomic, two separate statements'],
	['ledger', 'double-entry: one transaction, locks on both accounts'],
	['ledger-debit-lock', 'double-entry: lock only the account paying out']
] as const) {
	const r = simulate(mode);
	console.log(
		row([
			[name, 60],
			[`${r.drift > 0 ? '+' : ''}${n(r.drift)}`, 15],
			[n(r.negative), 18],
			[n(r.vanished), 14],
			[r.detectable ? 'yes, Σ = 0' : 'no', 16],
			[ms(r.maxWait), 15]
		])
	);
}
console.log('"total change" should be zero - money only moves from one wallet to another.');

heading(`Part B - summing ${n(PRICES)} prices: dollars in float vs cents in integers`);
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
			['sum in float (dollars)', 46],
			[dollars.toFixed(6), 22]
		])
	);
	console.log(
		row([
			['sum in integers (cents) ÷ 100', 46],
			[(cents / 100).toFixed(6), 22]
		])
	);
	console.log(
		row([
			['difference', 46],
			[`${((dollars - cents / 100) * 100).toFixed(4)} cents`, 22]
		])
	);
	console.log(`0.1 + 0.2 = ${0.1 + 0.2}; 0.029 * 100 = ${0.029 * 100}`);
	console.log(
		`\nfee 2.9%: rounding each then summing ${n(feePerItem)} cents, rounding once on the total ${n(feeOnce)} cents - difference ${n(feePerItem - feeOnce)} cents`
	);
	console.log(
		'both are "right" - but which one is the rule has to be written down, or two systems\' books never match.'
	);
}
