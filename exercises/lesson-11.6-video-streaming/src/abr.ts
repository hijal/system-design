import { LADDER } from './ladder';
import { env, heading, mulberry32, n, row } from './util';

const SEED = env('SEED', 11);
const SESSIONS = env('SESSIONS', 300);
const CONTENT_S = env('CONTENT_S', 600);
const SEGMENT_S = env('SEGMENT_S', 4);
const MAX_BUFFER_S = env('MAX_BUFFER_S', 30);
const RESERVOIR_S = env('RESERVOIR_S', 8);
const CUSHION_S = env('CUSHION_S', 24);
const SAFETY = env('SAFETY', 0.8);
const STATE_S = env('STATE_S', 6);
const STEP_S = 0.1;

const STATES = [0.4, 1.2, 2.5, 4, 7, 12];

function trace(random: () => number, seconds: number): number[] {
	const out: number[] = [];
	let state = 3;
	for (let t = 0; t < seconds; t += STEP_S) {
		if (random() < STEP_S / STATE_S)
			state = Math.max(0, Math.min(STATES.length - 1, state + (random() < 0.5 ? -1 : 1)));
		out.push((STATES[state] ?? 1) * (0.8 + 0.4 * random()));
	}
	return out;
}

interface View {
	buffer: number;
	throughputs: number[];
	last: number;
}

type Policy = { name: string; pick: (v: View) => number };

const top = LADDER.length - 1;
const highestUnder = (mbps: number): number => {
	let best = 0;
	LADDER.forEach((r, i) => {
		if (r.mbps <= mbps) best = i;
	});
	return best;
};
const harmonic = (values: number[]): number =>
	values.length === 0 ? 1 : values.length / values.reduce((s, v) => s + 1 / v, 0);

const policies: Policy[] = [
	{ name: 'সবসময় 1080p', pick: () => top },
	{ name: 'সবসময় 240p', pick: () => 0 },
	{
		name: `throughput: শেষ ৩টার হারের ${SAFETY * 100}% এর নিচে সর্বোচ্চ`,
		pick: (v) => highestUnder(harmonic(v.throughputs.slice(-3)) * SAFETY)
	},
	{
		name: `buffer: ${RESERVOIR_S} s এর নিচে সর্বনিম্ন, ${CUSHION_S} s এ সর্বোচ্চ`,
		pick: (v) =>
			v.buffer <= RESERVOIR_S
				? 0
				: Math.min(
						top,
						Math.floor(((v.buffer - RESERVOIR_S) / (CUSHION_S - RESERVOIR_S)) * (top + 1))
					)
	},
	{
		name: 'মিশ্র: throughput, buffer কম হলে নামো, ধাপে ধাপে ওঠো',
		pick: (v) => {
			if (v.buffer < RESERVOIR_S / 2) return 0;
			const target = highestUnder(harmonic(v.throughputs.slice(-3)) * SAFETY);
			return target > v.last ? Math.min(target, v.last + 1) : target;
		}
	}
];

heading(
	`${SESSIONS}টা session, প্রতিটা ${CONTENT_S / 60} মিনিটের video, ${SEGMENT_S} s এর টুকরো; mobile network ০.৪–১২ Mbps এর মধ্যে ওঠানামা করে`
);
console.log(
	row([
		['নীতি', 50],
		['শুরুর দেরি', 11],
		['আটকে থাকা', 11],
		['গড় bitrate', 12],
		['quality বদল', 12]
	])
);
for (const policy of policies) {
	const random = mulberry32(SEED);
	let startup = 0;
	let stalled = 0;
	let played = 0;
	let bits = 0;
	let switches = 0;
	for (let s = 0; s < SESSIONS; s++) {
		const bandwidth = trace(random, CONTENT_S * 4);
		let t = 0;
		let buffer = 0;
		let started = false;
		let fetched = 0;
		const view: View = { buffer: 0, throughputs: [], last: 0 };
		let playedHere = 0;
		while (playedHere < CONTENT_S && t < bandwidth.length * STEP_S - 1) {
			if (fetched < CONTENT_S / SEGMENT_S && buffer + SEGMENT_S <= MAX_BUFFER_S) {
				view.buffer = buffer;
				const choice = policy.pick(view);
				const rendition = LADDER[choice] ?? LADDER[0];
				if (rendition === undefined) break;
				if (fetched > 0 && choice !== view.last) switches++;
				view.last = choice;
				let remaining = rendition.mbps * SEGMENT_S;
				const began = t;
				while (remaining > 0) {
					const bw = bandwidth[Math.floor(t / STEP_S)] ?? 1;
					remaining -= bw * STEP_S;
					t += STEP_S;
					if (started) {
						if (buffer > 0) {
							const step = Math.min(STEP_S, buffer);
							buffer -= step;
							playedHere += step;
						} else stalled += STEP_S;
					}
				}
				view.throughputs.push((rendition.mbps * SEGMENT_S) / (t - began));
				buffer += SEGMENT_S;
				bits += rendition.mbps * SEGMENT_S;
				fetched++;
				if (!started) {
					started = true;
					startup += t;
				}
			} else {
				const step = Math.min(STEP_S, buffer);
				buffer -= step;
				playedHere += step;
				t += STEP_S;
				if (buffer <= 0 && fetched >= CONTENT_S / SEGMENT_S) break;
			}
		}
		played += playedHere;
	}
	console.log(
		row([
			[policy.name, 50],
			[`${(startup / SESSIONS).toFixed(1)} s`, 11],
			[`${((stalled / (played + stalled)) * 100).toFixed(2)}%`, 11],
			[`${(bits / (played + 1e-9)).toFixed(2)} Mbps`, 12],
			[(switches / SESSIONS).toFixed(1), 12]
		])
	);
}
console.log(
	`\n"আটকে থাকা" = দেখার সময়ের কত % buffer খালি হয়ে থেমে ছিল (rebuffer)। "quality বদল" = session প্রতি গড়ে কতবার resolution বদলাল। দর্শক ${n(CONTENT_S)} s দেখে।`
);
