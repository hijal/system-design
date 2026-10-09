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
		name: 'the real path instead of the route',
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
	`A. One metric - http_requests - ${n(total)} requests in ${HOURS} hours (${RPS} req/s), ${n(USERS)} users, ${n(BOARDS)} boards; how many time series as the label set changes`
);
console.log(
	row([
		['label', 38],
		['counter series', 16],
		[`histogram (×${BUCKETS + 3})`, 18],
		['approx. memory', 18]
	])
);
VARIANTS.forEach((variant, index) => {
	const series = variant.key === VARIANTS[4]?.key ? total : (seen[index]?.size ?? 0);
	const histogram = series * (BUCKETS + 3);
	console.log(
		row([
			[variant.name, 38],
			[n(series), 16],
			[n(histogram), 18],
			[bytes(histogram * BYTES_PER_SERIES), 18]
		])
	);
});
console.log(
	`   in a histogram, each label combination has ${BUCKETS + 1} buckets (with +Inf) + _sum + _count = ${BUCKETS + 3} series; memory assumed ~${n(BYTES_PER_SERIES)} bytes/series`
);

heading("B. What each request's event costs depending on where it is kept - in a day");
const LOG_LINE = 350;
const DEBUG_LINES = 25;
const SPANS = 20;
const SPAN = 400;
console.log(
	row([
		['what we keep', 40],
		['per request', 15],
		['per day', 12]
	])
);
const lines: [string, number][] = [
	['log, one JSON line per request', LOG_LINE],
	[`log, debug on (${DEBUG_LINES} lines)`, LOG_LINE * DEBUG_LINES],
	[`trace, every request (${SPANS} spans)`, SPANS * SPAN],
	[`trace, 1% sample`, (SPANS * SPAN) / 100]
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
	`   a log line ~${LOG_LINE} bytes, a span ~${SPAN} bytes - assumed. A metric's cost is not in the number of requests but in the number of series: the first row's ${n(baseline)} series, one sample every 15 s = ${n(samplesPerDay)} samples a day - the same if traffic doubles, double if the series double`
);
