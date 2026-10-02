import { bytes, heading, mulberry32, n, row, zipfSampler } from './random';

const RPS = Number(process.env.RPS ?? 100);
const HOURS = Number(process.env.HOURS ?? 24);
const USERS = Number(process.env.USERS ?? 100_000);
const BOARDS = Number(process.env.BOARDS ?? 200_000);
const ROUTES = 40;
const BOARD_ROUTES = 10;
const INSTANCES = 6;
const BUCKETS = Number(process.env.BUCKETS ?? 12);
const BYTES_PER_SERIES = Number(process.env.BYTES_PER_SERIES ?? 3_000);
const SEED = Number(process.env.SEED ?? 17);

const methodOf = (route: number): number =>
	route % 5 === 0 ? 1 : route % 7 === 0 ? 2 : route % 11 === 0 ? 3 : 0;
const STATUSES = [0.9, 0.03, 0.02, 0.02, 0.01, 0.005, 0.008, 0.004, 0.002, 0.001];

function pick(random: () => number, weights: number[]): number {
	let roll = random();
	for (let i = 0; i < weights.length; i++) {
		roll -= weights[i] ?? 0;
		if (roll < 0) return i;
	}
	return weights.length - 1;
}

type Variant = { name: string; key: (r: Req) => number | null };
type Req = {
	method: number;
	status: number;
	instance: number;
	route: number;
	board: number;
	user: number;
	plan: number;
};

const base = (r: Req): number =>
	((r.method * STATUSES.length + r.status) * INSTANCES + r.instance) * ROUTES + r.route;

const VARIANTS: Variant[] = [
	{ name: 'method, route, status, instance', key: base },
	{ name: '+ plan (free/pro/business)', key: (r) => base(r) * 3 + r.plan },
	{
		name: 'route এর বদলে আসল path',
		key: (r) => base(r) * (BOARDS + 1) + (r.route < BOARD_ROUTES ? r.board + 1 : 0)
	},
	{ name: '+ user_id', key: (r) => base(r) * USERS + r.user },
	{ name: '+ trace_id', key: () => null }
];

const random = mulberry32(SEED);
const nextUser = zipfSampler(USERS, 1.0, random);
const nextBoard = zipfSampler(BOARDS, 0.9, random);
const nextRoute = zipfSampler(ROUTES, 1.2, random);
const total = RPS * HOURS * 3_600;
const seen = VARIANTS.map(() => new Set<number>());
for (let i = 0; i < total; i++) {
	const user = nextUser();
	const route = nextRoute();
	const req: Req = {
		method: methodOf(route),
		status: pick(random, STATUSES),
		instance: i % INSTANCES,
		route,
		board: nextBoard(),
		user,
		plan: user % 10 === 0 ? 2 : user % 3 === 0 ? 1 : 0
	};
	VARIANTS.forEach((variant, index) => {
		const key = variant.key(req);
		if (key !== null) seen[index]?.add(key);
	});
}

heading(
	`ক. একটা metric — http_requests — ${HOURS} ঘণ্টায় ${n(total)} request (${RPS} req/s), ${n(USERS)} user, ${n(BOARDS)} board; label এর সেট বদলে কয়টা time series`
);
console.log(
	row([
		['label', 34],
		['counter series', 16],
		[`histogram (×${BUCKETS + 3})`, 18],
		['আনুমানিক memory', 18]
	])
);
VARIANTS.forEach((variant, index) => {
	const series = variant.key === VARIANTS[4]?.key ? total : (seen[index]?.size ?? 0);
	const histogram = series * (BUCKETS + 3);
	console.log(
		row([
			[variant.name, 34],
			[n(series), 16],
			[n(histogram), 18],
			[bytes(histogram * BYTES_PER_SERIES), 18]
		])
	);
});
console.log(
	`   histogram এ প্রতিটা label এর সমন্বয়ে ${BUCKETS + 1}টা bucket (+Inf সহ) + _sum + _count = ${BUCKETS + 3}টা series; memory ধরে নেওয়া ~${n(BYTES_PER_SERIES)} byte/series`
);

heading('খ. প্রতি request এর ঘটনা কোথায় রাখলে কত — একদিনে');
const LOG_LINE = 350;
const DEBUG_LINES = 25;
const SPANS = 20;
const SPAN = 400;
console.log(
	row([
		['কী রাখছি', 40],
		['প্রতি request', 15],
		['প্রতি দিন', 12]
	])
);
const lines: [string, number][] = [
	['log, প্রতি request এ একটা JSON লাইন', LOG_LINE],
	[`log, debug চালু (${DEBUG_LINES}টা লাইন)`, LOG_LINE * DEBUG_LINES],
	[`trace, সব request (${SPANS}টা span)`, SPANS * SPAN],
	[`trace, ১% sample`, (SPANS * SPAN) / 100]
];
for (const [label, perRequest] of lines)
	console.log(
		row([
			[label, 40],
			[bytes(perRequest), 15],
			[bytes(perRequest * total), 12]
		])
	);
const baseline = (seen[0]?.size ?? 0) * (BUCKETS + 3);
const samplesPerDay = baseline * ((24 * 3_600) / 15);
console.log(
	`   log লাইন ~${LOG_LINE} byte, span ~${SPAN} byte — ধরে নেওয়া। Metric এর খরচ request এর সংখ্যায় না, series এর সংখ্যায়: প্রথম সারির ${n(baseline)}টা series, প্রতি ১৫ s এ একটা sample = দিনে ${n(samplesPerDay)} sample — traffic দ্বিগুণ হলেও একই, series দ্বিগুণ হলে দ্বিগুণ`
);
