import { env, exponential, heading, lognormal, mulberry32, n, normal, pct, row } from './util';

const SEED = env('SEED', 11);
const MESSAGES = env('MESSAGES', 200_000);
const DROP = env('DROP', 0.03);
const EVENTS = env('EVENTS', 50_000);
const MEMBERS = env('MEMBERS', 5);
const CLOCK_SD_MS = env('CLOCK_SD_MS', 500);
const WRONG_CLOCK = env('WRONG_CLOCK', 0.02);
const SERVERS = env('SERVERS', 3);
const SERVER_SD_MS = env('SERVER_SD_MS', 30);
const LATENCY_MS = env('LATENCY_MS', 80);
const THINK_MS = env('THINK_MS', 2_000);
const REPLY_SHARE = env('REPLY_SHARE', 0.5);

type Policy = { name: string; retry: boolean; dedupe: boolean };

const policies: Policy[] = [
	{ name: 'send once, no ack (at-most-once)', retry: false, dedupe: false },
	{ name: 'resend if no ack (at-least-once)', retry: true, dedupe: false },
	{ name: 'resend + drop by client_msg_id and seq', retry: true, dedupe: true }
];

heading(
	`Part A — A → server → B, ${n(MESSAGES)} messages, each packet lost ${(DROP * 100).toFixed(0)}% of the time (mobile network)`
);
console.log(
	row([
		['policy', 46],
		['B missed it', 12],
		['B saw it twice', 15],
		['stored twice', 19],
		['packet / message', 17]
	])
);
for (const policy of policies) {
	const random = mulberry32(SEED);
	const delivered = (): boolean => random() >= DROP;
	let missing = 0;
	let shownTwice = 0;
	let storedTwice = 0;
	let packets = 0;
	for (let m = 0; m < MESSAGES; m++) {
		let stored = 0;
		for (;;) {
			packets++;
			if (delivered()) stored++;
			packets++;
			const acked = stored > 0 && delivered();
			if (acked || !policy.retry) break;
		}
		const copies = policy.dedupe ? Math.min(stored, 1) : stored;
		if (copies > 1) storedTwice++;
		let shown = 0;
		for (let c = 0; c < copies; c++) {
			let received = 0;
			for (;;) {
				packets++;
				if (delivered()) received++;
				packets++;
				const acked = received > 0 && delivered();
				if (acked || !policy.retry) break;
			}
			shown += policy.dedupe ? Math.min(received, 1) : received;
		}
		if (shown === 0) missing++;
		if (shown > 1) shownTwice++;
	}
	console.log(
		row([
			[policy.name, 46],
			[pct(missing, MESSAGES, 2), 12],
			[pct(shownTwice, MESSAGES, 2), 15],
			[pct(storedTwice, MESSAGES, 2), 19],
			[(packets / MESSAGES).toFixed(2), 17]
		])
	);
}

heading(
	`Part B — ordering in a group: ${MEMBERS} people, phone clocks ±${CLOCK_SD_MS} ms (${(WRONG_CLOCK * 100).toFixed(0)}% of phones a minute or so off), ${SERVERS} chat servers (±${SERVER_SD_MS} ms)`
);
type Order = 'client' | 'arrival' | 'server' | 'seq';
const orders: [Order, string][] = [
	['client', "sorted by the sending phone's clock"],
	['arrival', 'shown in the order they arrived'],
	['server', "sorted by the chat server's clock"],
	['seq', 'per-conversation seq (one sequencer)']
];
console.log(
	row([
		['order', 44],
		['answer above question', 23],
		['members see different orders', 31]
	])
);
for (const [order, name] of orders) {
	const random = mulberry32(SEED + 5);
	const phoneSkew = (): number =>
		random() < WRONG_CLOCK
			? (random() < 0.5 ? -1 : 1) * (30_000 + random() * 120_000)
			: normal(random) * CLOCK_SD_MS;
	const serverSkew = Array.from({ length: SERVERS }, () => normal(random) * SERVER_SD_MS);
	const hop = (): number => lognormal(random, LATENCY_MS, 0.6);
	let replies = 0;
	let replyAbove = 0;
	let concurrent = 0;
	let diverged = 0;
	for (let e = 0; e < EVENTS; e++) {
		const skewA = phoneSkew();
		const skewC = phoneSkew();
		const isReply = random() < REPLY_SHARE;
		const sentA = 0;
		const atServerA = sentA + hop();
		const serverA = Math.floor(random() * SERVERS);
		const sentC = isReply
			? atServerA + hop() + exponential(random, THINK_MS)
			: (random() - 0.5) * 100;
		const atServerC = sentC + hop();
		const serverC = Math.floor(random() * SERVERS);
		const seqA = atServerA <= atServerC ? 1 : 2;
		const seqC = 3 - seqA;
		const keyA =
			order === 'client'
				? sentA + skewA
				: order === 'server'
					? atServerA + (serverSkew[serverA] ?? 0)
					: seqA;
		const keyC =
			order === 'client'
				? sentC + skewC
				: order === 'server'
					? atServerC + (serverSkew[serverC] ?? 0)
					: seqC;
		const views: boolean[] = [];
		for (let r = 0; r < MEMBERS - 2; r++) {
			const arriveA = atServerA + hop();
			const arriveC = atServerC + hop();
			views.push(
				order === 'arrival'
					? arriveA < arriveC
					: keyA < keyC || (keyA === keyC && arriveA < arriveC)
			);
		}
		const aFirstEverywhere = views.every((v) => v);
		const sameEverywhere = views.every((v) => v === views[0]);
		if (isReply) {
			replies++;
			if (!aFirstEverywhere) replyAbove++;
		} else {
			concurrent++;
			if (!sameEverywhere) diverged++;
		}
	}
	console.log(
		row([
			[name, 44],
			[pct(replyAbove, replies, 2), 23],
			[pct(diverged, concurrent, 2), 31]
		])
	);
}
console.log(
	'"answer above question" = C saw the question and answered, but on at least one screen the answer comes first. "different orders" = two messages sent almost together, seen in different orders by members.'
);
