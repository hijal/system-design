import { latency, mulberry32, percentile } from './random';

// Lesson 6.1 §1.3 - "is the other one dead, or just silent?" - the heartbeat and timeout trade-off.
//
// The primary sends the monitor a heartbeat every 100 ms. The monitor's rule is simple:
// "if no heartbeat arrives for TIMEOUT ms, the primary is dead - start a failover."
//
// The primary is **alive** for the full 24 hours - it never crashes. Yet it is sometimes silent:
//   - packets are lost on the network (1%)
//   - the process stops - short pauses (GC, 200 ms on average) often, and now and then long ones
//     (VM migration, swap, disk stall - 1 to 8 seconds)
// These numbers are an assumed model, not measured values of any particular system - the shape is what matters.
//
// Two questions for each timeout:
//   1. how many times a day the living primary was wrongly declared "dead" (each = a needless failover)
//   2. if the primary really crashes, how long the monitor takes to notice

const HOURS = 24;
const INTERVAL_MS = 100;
const LOSS = 0.01;
const PAUSE_PROBABILITY = 1 / 2000; // per heartbeat - one pause every ~200 seconds on average
const TIMEOUTS_MS = [150, 300, 500, 1000, 2000, 5000, 10_000];

function pauseMs(random: () => number): number {
	// 90% short (like GC, 200 ms on average), 10% long (1–8 s)
	return random() < 0.9 ? -200 * Math.log(1 - random()) : 1000 + random() * 7000;
}

// when the living primary's heartbeats reached the monitor (ms)
function arrivals(): number[] {
	const random = mulberry32(61);
	const end = HOURS * 3600 * 1000;
	const result: number[] = [];
	let sentAt = 0;
	while (sentAt < end) {
		if (random() < PAUSE_PROBABILITY) sentAt += pauseMs(random); // the process was stopped
		const lost = random() < LOSS;
		const arrive = sentAt + latency(random, 0.5, 1);
		if (!lost) result.push(arrive);
		sentAt += INTERVAL_MS;
	}
	return result.sort((a, b) => a - b);
}

// if the primary really crashes: the monitor notices once TIMEOUT passes after the last heartbeat
function detectionTimes(timeout: number): number[] {
	const random = mulberry32(62);
	const times: number[] = [];
	for (let i = 0; i < 10_000; i++) {
		const sinceLastBeat = random() * INTERVAL_MS; // the crash can happen any time between two heartbeats
		const lastArrival = -sinceLastBeat + latency(random, 0.5, 1);
		times.push(lastArrival + timeout); // the crash happened at time 0
	}
	return times;
}

function main(): void {
	const beats = arrivals();
	const gaps: number[] = [];
	for (let i = 1; i < beats.length; i++) gaps.push((beats[i] ?? 0) - (beats[i - 1] ?? 0));
	const longest = gaps.reduce((max, gap) => Math.max(max, gap), 0);

	console.log(`\n   Primary alive for ${HOURS} hours, a heartbeat every ${INTERVAL_MS} ms`);
	console.log(
		`   heartbeats arrived: ${beats.length.toLocaleString('en-US')}; the longest silence between two: ${(longest / 1000).toFixed(2)} s`
	);
	console.log(
		`   (seeded - the same result every time; the pause/loss rates are an assumed model, not measured)\n`
	);
	console.log(
		'   timeout     false "dead" calls / day     time to notice a real crash (p50 / p99)'
	);
	for (const timeout of TIMEOUTS_MS) {
		const falseAlarms = gaps.filter((gap) => gap > timeout).length / (HOURS / 24);
		const detect = detectionTimes(timeout);
		const fmt = (ms: number): string =>
			ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
		console.log(
			`   ${fmt(timeout).padStart(8)}   ${String(Math.round(falseAlarms)).padStart(12)}              ${fmt(percentile(detect, 50)).padStart(8)} / ${fmt(percentile(detect, 99)).padStart(8)}`
		);
	}
	console.log('\n   No timeout gives both "zero false calls" and "fast detection" at once.');
	console.log(
		`   And with any timeout shorter than ${(longest / 1000).toFixed(1)} s, the living primary was declared "dead" at least once.\n`
	);
}

main();
