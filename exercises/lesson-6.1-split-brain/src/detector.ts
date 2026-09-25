import { latency, mulberry32, percentile } from './random';

// Lesson 6.1 §১.৩ — "অন্যটা মৃত, নাকি শুধু চুপ?" — heartbeat আর timeout এর trade-off।
//
// Primary প্রতি 100 ms এ monitor কে একটা heartbeat পাঠায়। Monitor এর নিয়ম সরল:
// "TIMEOUT ms ধরে কোনো heartbeat না এলে primary মৃত — failover শুরু করো।"
//
// Primary পুরো ২৪ ঘণ্টা **জীবিত** — কখনো crash করে না। তবু মাঝে মাঝে চুপ থাকে:
//   - network এ packet হারায় (1%)
//   - process থেমে যায় — ছোট pause (GC, গড় 200 ms) প্রায়ই, আর কখনো কখনো লম্বা
//     (VM migration, swap, disk stall — 1 থেকে 8 সেকেন্ড)
// এই সংখ্যাগুলো একটা ধরে নেওয়া মডেল, কোনো নির্দিষ্ট system এর মাপা মান না — আকৃতিটাই আসল।
//
// প্রতিটা timeout এর জন্য দুটো প্রশ্ন:
//   ১. জীবিত primary কে দিনে কতবার ভুল করে "মৃত" ঘোষণা করা হলো (প্রতিটা = একটা অকারণ failover)
//   ২. primary সত্যিই crash করলে monitor টের পেতে কত সময় লাগে

const HOURS = 24;
const INTERVAL_MS = 100;
const LOSS = 0.01;
const PAUSE_PROBABILITY = 1 / 2000; // প্রতি heartbeat এ — গড়ে প্রতি ~২০০ সেকেন্ডে একটা pause
const TIMEOUTS_MS = [150, 300, 500, 1000, 2000, 5000, 10_000];

function pauseMs(random: () => number): number {
	// ৯০% ছোট (GC এর মতো, গড় 200 ms), ১০% লম্বা (1–8 s)
	return random() < 0.9 ? -200 * Math.log(1 - random()) : 1000 + random() * 7000;
}

// জীবিত primary এর heartbeat monitor এ কখন কখন পৌঁছাল (ms)
function arrivals(): number[] {
	const random = mulberry32(61);
	const end = HOURS * 3600 * 1000;
	const result: number[] = [];
	let sentAt = 0;
	while (sentAt < end) {
		if (random() < PAUSE_PROBABILITY) sentAt += pauseMs(random); // process থেমে ছিল
		const lost = random() < LOSS;
		const arrive = sentAt + latency(random, 0.5, 1);
		if (!lost) result.push(arrive);
		sentAt += INTERVAL_MS;
	}
	return result.sort((a, b) => a - b);
}

// primary সত্যিই crash করলে: শেষ heartbeat এর পরে TIMEOUT পেরোলেই monitor টের পায়
function detectionTimes(timeout: number): number[] {
	const random = mulberry32(62);
	const times: number[] = [];
	for (let i = 0; i < 10_000; i++) {
		const sinceLastBeat = random() * INTERVAL_MS; // crash দুটো heartbeat এর মাঝে যেকোনো সময়
		const lastArrival = -sinceLastBeat + latency(random, 0.5, 1);
		times.push(lastArrival + timeout); // crash হয়েছে সময় ০ তে
	}
	return times;
}

function main(): void {
	const beats = arrivals();
	const gaps: number[] = [];
	for (let i = 1; i < beats.length; i++) gaps.push((beats[i] ?? 0) - (beats[i - 1] ?? 0));
	const longest = gaps.reduce((max, gap) => Math.max(max, gap), 0);

	console.log(`\n   Primary ${HOURS} ঘণ্টা জীবিত, heartbeat প্রতি ${INTERVAL_MS} ms`);
	console.log(
		`   heartbeat পৌঁছেছে ${beats.length.toLocaleString('en-US')} টা; দুটোর মধ্যে সবচেয়ে লম্বা নীরবতা ${(longest / 1000).toFixed(2)} s`
	);
	console.log(
		`   (seed দেওয়া — প্রতিবার একই ফল; pause/loss এর হার একটা ধরে নেওয়া মডেল, মাপা না)\n`
	);
	console.log('   timeout     ভুল "মৃত" ঘোষণা / দিন     আসল crash টের পেতে (p50 / p99)');
	for (const timeout of TIMEOUTS_MS) {
		const falseAlarms = gaps.filter((gap) => gap > timeout).length / (HOURS / 24);
		const detect = detectionTimes(timeout);
		const fmt = (ms: number): string =>
			ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
		console.log(
			`   ${fmt(timeout).padStart(8)}   ${String(Math.round(falseAlarms)).padStart(12)}              ${fmt(percentile(detect, 50)).padStart(8)} / ${fmt(percentile(detect, 99)).padStart(8)}`
		);
	}
	console.log('\n   কোনো timeout ই "ভুল ঘোষণা শূন্য" আর "দ্রুত টের পাওয়া" দুটো একসাথে দেয় না।');
	console.log(
		`   আর ${(longest / 1000).toFixed(1)} s এর চেয়ে ছোট যেকোনো timeout এ জীবিত primary অন্তত একবার "মৃত" হয়েছে।\n`
	);
}

main();
