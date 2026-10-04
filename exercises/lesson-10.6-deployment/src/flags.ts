import { env, hashUnit, heading, minutes, mulberry32, n, pct, row } from './util';

const USERS = env('USERS', 60_000);
const VIEWS = env('VIEWS_PER_DAY', 20);
const RPS = env('RPS', 300);
const FEATURE_SHARE = env('FEATURE_SHARE', 1 / 3);
const FEATURE_ERROR = env('FEATURE_ERROR', 0.2);
const POLL_SECONDS = env('POLL_SECONDS', 30);
const TRIALS = env('TRIALS', 200);
const SEED = env('SEED', 1_060);

type Method = { name: string; on: (flag: string, user: number, percent: number) => boolean };

function methods(random: () => number): Method[] {
	return [
		{ name: 'প্রতি request এ এলোমেলো', on: (_f, _u, p) => random() * 100 < p },
		{ name: 'hash(user)', on: (_f, u, p) => hashUnit(`user:${u}`) * 100 < p },
		{ name: 'hash(flag + user)', on: (f, u, p) => hashUnit(`${f}:${u}`) * 100 < p }
	];
}

heading(
	`অংশ ক — percentage rollout: ${n(USERS)} user, দিনে ${VIEWS}টা page, দুটো আলাদা flag, ১০% করে`
);
console.log(
	row([
		['কীভাবে ভাগ', 26],
		['নতুনটা দেখেছে', 16],
		['দুটোই দেখেছে (লাফ)', 20],
		['দুই flag এই আছে', 18]
	])
);
for (const method of methods(mulberry32(SEED))) {
	let saw = 0;
	let flipped = 0;
	let both = 0;
	for (let u = 0; u < USERS; u++) {
		let on = 0;
		let editor = 0;
		for (let v = 0; v < VIEWS; v++) {
			if (method.on('new-board', u, 10)) on++;
			if (method.on('new-editor', u, 10)) editor++;
		}
		if (on > 0) saw++;
		if (on > 0 && on < VIEWS) flipped++;
		if (on > 0 && editor > 0) both++;
	}
	console.log(
		row([
			[method.name, 26],
			[`${n(saw)} (${pct(saw, USERS, 0)})`, 16],
			[n(flipped), 20],
			[n(both), 18]
		])
	);
}
console.log(
	'\n("দুই flag এই আছে" — দুটো আলাদা ১০% experiment এ একই user; স্বাধীন হলে আশা ~১% = ৬০০ জন)'
);

type Switch = { name: string; delay: (instance: number, random: () => number) => number };
const SWITCHES: Switch[] = [
	{ name: 'flag, ৫ মিনিটে poll', delay: (_i, r) => r() * 300 },
	{ name: `flag, ${POLL_SECONDS} s এ poll`, delay: (_i, r) => r() * POLL_SECONDS },
	{ name: 'flag, streaming push', delay: (_i, r) => 1 + r() * 2 },
	{ name: 'flag নেই: rollback deploy', delay: (i) => 300 + 30 * (i + 1) }
];
const INSTANCES = 12;
heading(
	`অংশ খ — kill switch: ${INSTANCES} instance, নতুন feature এ ${Math.round(FEATURE_SHARE * RPS)} req/s, তার ${Math.round(FEATURE_ERROR * 100)}% error; বন্ধ করার সিদ্ধান্তের পরে`
);
console.log(
	row([
		['কীভাবে বন্ধ', 30],
		['সব instance বন্ধ (গড়)', 22],
		['সবচেয়ে খারাপ', 16],
		['খারাপ request (গড়)', 20]
	])
);
for (const sw of SWITCHES) {
	const random = mulberry32(SEED + 3);
	let lastSum = 0;
	let lastMax = 0;
	let badSum = 0;
	for (let trial = 0; trial < TRIALS; trial++) {
		let last = 0;
		let bad = 0;
		for (let i = 0; i < INSTANCES; i++) {
			const d = sw.delay(i, random);
			last = Math.max(last, d);
			bad += ((RPS * FEATURE_SHARE) / INSTANCES) * d * FEATURE_ERROR;
		}
		lastSum += last;
		lastMax = Math.max(lastMax, last);
		badSum += bad;
	}
	console.log(
		row([
			[sw.name, 30],
			[minutes(lastSum / TRIALS), 22],
			[minutes(lastMax), 16],
			[n(badSum / TRIALS), 20]
		])
	);
}

type Eval = {
	name: string;
	bffPoll: boolean;
	apiPoll: boolean;
	apiKey: 'user' | 'session';
	header: boolean;
};
const EVALS: Eval[] = [
	{
		name: 'দুজনেই hash(user), একই মুহূর্তে config',
		bffPoll: false,
		apiPoll: false,
		apiKey: 'user',
		header: false
	},
	{
		name: 'BFF hash(user), API hash(session)',
		bffPoll: false,
		apiPoll: false,
		apiKey: 'session',
		header: false
	},
	{
		name: `দুজনেই hash(user), প্রত্যেকে নিজে ${POLL_SECONDS} s poll`,
		bffPoll: true,
		apiPoll: true,
		apiKey: 'user',
		header: false
	},
	{
		name: 'BFF একবার ঠিক করে, header এ পাঠায়',
		bffPoll: true,
		apiPoll: true,
		apiKey: 'user',
		header: true
	}
];
const SERVICE_INSTANCES = 6;
const WINDOW = 600;
const RAMP_AT = 300;
heading(
	`অংশ গ — দুই service, একটা flag: BFF নতুন UI দেখায়, API নতুন আকারের উত্তর দেয়; ${WINDOW / 60} মিনিট, ${RAMP_AT / 60} মিনিটে ১০% → ৫০%`
);
console.log(
	row([
		['কে কীভাবে ঠিক করে', 48],
		['request', 12],
		['UI আর API অমিল', 18]
	])
);
for (const e of EVALS) {
	const random = mulberry32(SEED + 9);
	const bffLag = Array.from({ length: SERVICE_INSTANCES }, () =>
		e.bffPoll ? random() * POLL_SECONDS : 0
	);
	const apiLag = Array.from({ length: SERVICE_INSTANCES }, () =>
		e.apiPoll ? random() * POLL_SECONDS : 0
	);
	const percentAt = (t: number, lag: number): number => (t >= RAMP_AT + lag ? 50 : 10);
	let total = 0;
	let mismatch = 0;
	for (let t = 0; t < WINDOW; t++) {
		for (let i = 0; i < RPS; i++) {
			const user = Math.floor(random() * USERS);
			const session = Math.floor(random() * 3);
			const bff = Math.floor(random() * SERVICE_INSTANCES);
			const api = Math.floor(random() * SERVICE_INSTANCES);
			const bffOn = hashUnit(`task-api-v2:${user}`) * 100 < percentAt(t, bffLag[bff] ?? 0);
			const apiKey = e.apiKey === 'user' ? `task-api-v2:${user}` : `task-api-v2:${user}:${session}`;
			const apiOn = e.header ? bffOn : hashUnit(apiKey) * 100 < percentAt(t, apiLag[api] ?? 0);
			total++;
			if (bffOn !== apiOn) mismatch++;
		}
	}
	console.log(
		row([
			[e.name, 48],
			[n(total), 12],
			[`${n(mismatch)} (${pct(mismatch, total, 2)})`, 18]
		])
	);
}
