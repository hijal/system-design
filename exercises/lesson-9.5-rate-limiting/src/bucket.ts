import { TokenBucket } from './limiters';
import { ms, padEnd, padLeft } from './random';

const CAPACITY = Number(process.env.CAPACITY ?? 10);
const RATE_PER_SEC = Number(process.env.RATE_PER_SEC ?? 10);
const BURST = Number(process.env.BURST ?? 30);
const TAIL_MS = Number(process.env.TAIL_MS ?? 3000);
const TAIL_RATE = Number(process.env.TAIL_RATE ?? 5);
const SLOT_MS = Number(process.env.SLOT_MS ?? 250);

const LABEL = 22;
const COL = 13;

class LeakyBucketQueue {
	readonly name = 'leaky bucket (queue)';
	readonly #capacity: number;
	readonly #intervalMs: number;
	#nextSlot = 0;
	#queued = 0;

	constructor(capacity: number, ratePerSecond: number) {
		this.#capacity = capacity;
		this.#intervalMs = 1000 / ratePerSecond;
	}

	admit(now: number): { admitted: boolean; leavesAt: number } {
		const earliest = Math.max(now, this.#nextSlot);
		const waiting = Math.ceil((earliest - now) / this.#intervalMs);
		if (waiting > this.#capacity) return { admitted: false, leavesAt: -1 };
		this.#nextSlot = earliest + this.#intervalMs;
		this.#queued = Math.max(this.#queued, waiting);
		return { admitted: true, leavesAt: earliest };
	}

	peakQueue(): number {
		return this.#queued;
	}
}

type Arrival = { at: number };

function arrivals(): Arrival[] {
	const list: Arrival[] = [];
	for (let i = 0; i < BURST; i += 1) list.push({ at: 0 });
	const gap = 1000 / TAIL_RATE;
	for (let at = gap; at <= TAIL_MS; at += gap) list.push({ at: Math.round(at) });
	return list;
}

function histogram(times: number[], slotMs: number, spanMs: number): number[] {
	const slots = new Array<number>(Math.ceil(spanMs / slotMs) + 1).fill(0);
	for (const at of times) {
		const index = Math.floor(at / slotMs);
		const current = slots[index];
		if (current !== undefined) slots[index] = current + 1;
	}
	return slots;
}

function bar(count: number): string {
	return '█'.repeat(Math.min(30, count)) + (count > 30 ? '…' : '');
}

function main(): void {
	const input = arrivals();
	console.log(
		`\n=== Lesson 9.5 — Token Bucket বনাম Leaky Bucket ===\n` +
			`   হার ${RATE_PER_SEC}/s · capacity ${CAPACITY} · আগমন: t=0 এ ${BURST} টার burst, তারপর ${TAIL_RATE}/s ${TAIL_MS} ms ধরে (মোট ${input.length})\n`
	);

	const token = new TokenBucket(CAPACITY, RATE_PER_SEC);
	const tokenPassed: number[] = [];
	let tokenDenied = 0;
	for (const arrival of input) {
		if (token.check('user-1', arrival.at).allowed) tokenPassed.push(arrival.at);
		else tokenDenied += 1;
	}

	const leaky = new LeakyBucketQueue(CAPACITY, RATE_PER_SEC);
	const leakyPassed: number[] = [];
	const leakyWaits: number[] = [];
	let leakyDenied = 0;
	for (const arrival of input) {
		const result = leaky.admit(arrival.at);
		if (result.admitted) {
			leakyPassed.push(result.leavesAt);
			leakyWaits.push(result.leavesAt - arrival.at);
		} else leakyDenied += 1;
	}

	console.log(`── ক. কে কতটা নিল, কে কী পেল ──`);
	console.log(
		`   ${padEnd('algorithm', LABEL)}${padLeft('passed', COL)}${padLeft('rejected', COL)}${padLeft('সবচেয়ে বেশি অপেক্ষা', COL + 8)}`
	);
	console.log(
		`   ${padEnd('token bucket', LABEL)}${padLeft(tokenPassed.length, COL)}${padLeft(tokenDenied, COL)}${padLeft('0 ms (অপেক্ষা নেই)', COL + 8)}`
	);
	const worstWait = leakyWaits.length > 0 ? Math.max(...leakyWaits) : 0;
	console.log(
		`   ${padEnd('leaky bucket (queue)', LABEL)}${padLeft(leakyPassed.length, COL)}${padLeft(leakyDenied, COL)}${padLeft(ms(worstWait), COL + 8)}`
	);

	const span = TAIL_MS + 1500;
	console.log(`\n── খ. বেরোনোর আকার — প্রতি ${SLOT_MS} ms এ কতটা downstream এ গেল ──`);
	const tokenHist = histogram(tokenPassed, SLOT_MS, span);
	const leakyHist = histogram(leakyPassed, SLOT_MS, span);
	console.log(`   token bucket — burst টা সাথে সাথে বেরিয়ে যায়:`);
	for (const [index, count] of tokenHist.entries())
		if (index < 8)
			console.log(
				`     ${padLeft(`${index * SLOT_MS} ms`, 8)}  ${padLeft(count, 3)}  ${bar(count)}`
			);
	console.log(`   leaky bucket — একই আগমন, সমান গতিতে বেরোয়:`);
	for (const [index, count] of leakyHist.entries())
		if (index < 8)
			console.log(
				`     ${padLeft(`${index * SLOT_MS} ms`, 8)}  ${padLeft(count, 3)}  ${bar(count)}`
			);
	console.log(
		`\n   downstream এ সর্বোচ্চ তাৎক্ষণিক চাপ (${SLOT_MS} ms এ): token bucket ${Math.max(...tokenHist)} · leaky bucket ${Math.max(...leakyHist)}\n`
	);

	console.log(`── গ. Token bucket এর capacity — burst সহনশীলতা বনাম downstream এর চাপ ──`);
	console.log(
		`   ${padEnd('capacity', LABEL)}${padLeft('passed', COL)}${padLeft('burst এ পাশ', COL + 4)}${padLeft(`চাপ/${SLOT_MS}ms`, COL + 4)}`
	);
	for (const capacity of [1, 5, CAPACITY, 50]) {
		const limiter = new TokenBucket(capacity, RATE_PER_SEC);
		const passed: number[] = [];
		let atZero = 0;
		for (const arrival of input)
			if (limiter.check('user-1', arrival.at).allowed) {
				passed.push(arrival.at);
				if (arrival.at === 0) atZero += 1;
			}
		const hist = histogram(passed, SLOT_MS, span);
		console.log(
			`   ${padEnd(String(capacity), LABEL)}${padLeft(passed.length, COL)}${padLeft(atZero, COL + 4)}${padLeft(Math.max(...hist), COL + 4)}`
		);
	}
	console.log('');
}

main();
