import { binomial, env, hashUnit, heading, minutes, mulberry32, n, pct, row, zScore } from './util';

const RPS = env('RPS', 300);
const USERS = env('USERS', 60_000);
const HORIZON = env('HORIZON_MINUTES', 120) * 60;
const SEGMENT_SHARE = env('SEGMENT_SHARE', 0.01);
const HUMAN_MINUTES = env('HUMAN_MINUTES', 10);
const STEP_MINUTES = env('STEP_MINUTES', 10);
const TRIALS = env('TRIALS', 400);
const SEED = env('SEED', 106);

const INSTANCES = 12;
const BASE_ERROR = 0.001;
const ALERT_WINDOW = 300;
const ALERT_ERROR = 0.01;
const ALERT_SLOW = 0.05;
const STEP_SECONDS = STEP_MINUTES * 60;
const CANARY_STEPS = [0.01, 0.05, 0.25, 1];
const Z = 3;

type Bug = {
	name: string;
	error: (segment: boolean, random: () => number) => boolean;
	slow: (random: () => number) => boolean;
};

const NO_BUG: Bug = { name: 'no bug', error: () => false, slow: () => false };
const BUGS: Bug[] = [
	{ name: '2% errors for everyone', error: (_s, r) => r() < 0.02, slow: () => false },
	{
		name: `20% errors on big business boards (${Math.round(SEGMENT_SHARE * 100)}% of traffic)`,
		error: (s, r) => s && r() < 0.2,
		slow: () => false
	},
	{ name: '10% of requests slow (> 1 s), no errors', error: () => false, slow: (r) => r() < 0.1 }
];

type Kind = 'bigbang' | 'rolling' | 'bluegreen' | 'canary';
type Gate = 'none' | 'errors' | 'full';
type Strategy = { name: string; kind: Kind; gate: Gate; sticky: boolean; extra: string };

const STRATEGIES: Strategy[] = [
	{ name: 'big-bang (all at once)', kind: 'bigbang', gate: 'none', sticky: false, extra: '0' },
	{
		name: 'rolling (one per 2 minutes)',
		kind: 'rolling',
		gate: 'none',
		sticky: false,
		extra: '−1'
	},
	{ name: 'blue-green', kind: 'bluegreen', gate: 'none', sticky: false, extra: '+12' },
	{
		name: 'canary, gate: error, random per request',
		kind: 'canary',
		gate: 'errors',
		sticky: false,
		extra: '+3'
	},
	{
		name: 'canary, gate: error, sticky per user',
		kind: 'canary',
		gate: 'errors',
		sticky: true,
		extra: '+3'
	},
	{
		name: 'canary, gate: error + latency + segment',
		kind: 'canary',
		gate: 'full',
		sticky: true,
		extra: '+3'
	}
];

const segmentOf = new Uint8Array(USERS);
const stickyKey = new Float64Array(USERS);
for (let u = 0; u < USERS; u++) {
	segmentOf[u] = hashUnit(`workspace-size:${u}`) < SEGMENT_SHARE ? 1 : 0;
	stickyKey[u] = hashUnit(`canary:${u}`);
}

type Counts = {
	total: number;
	err: number;
	slow: number;
	segTotal: number;
	segErr: number;
};
const emptyCounts = (): Counts => ({ total: 0, err: 0, slow: 0, segTotal: 0, segErr: 0 });

type Outcome = {
	hits: number;
	users: number;
	detectedAt: number | null;
	detectedBy: string;
	rolledBackAt: number | null;
	reachedFullAt: number | null;
};

function progress(kind: Kind, t: number, step: number): number {
	if (kind === 'bigbang') return Math.min(1, t / 60);
	if (kind === 'rolling') return Math.min(INSTANCES, Math.floor(t / 120) + 1) / INSTANCES;
	if (kind === 'bluegreen') return 1;
	return CANARY_STEPS[step] ?? 1;
}

function afterRollback(kind: Kind, start: number, at: number, t: number): number {
	const since = t - start;
	if (kind === 'bigbang') return since < 300 ? at : 0;
	if (kind === 'rolling') {
		const replaced = Math.round(at * INSTANCES);
		return Math.max(0, replaced - Math.floor(since / 30)) / INSTANCES;
	}
	return since < 30 ? at : 0;
}

function simulate(strategy: Strategy, bug: Bug, seed: number): Outcome {
	const random = mulberry32(seed);
	const totals = new Uint32Array(HORIZON);
	const errors = new Uint32Array(HORIZON);
	const slows = new Uint32Array(HORIZON);
	const affected = new Set<number>();
	let hits = 0;
	let step = 0;
	let stepStart = 0;
	let canary = emptyCounts();
	let baseline = emptyCounts();
	let detectedAt: number | null = null;
	let detectedBy = '—';
	let rollbackStart: number | null = null;
	let rollbackFrom = 0;
	let rolledBackAt: number | null = null;
	let reachedFullAt: number | null = null;

	for (let t = 0; t < HORIZON; t++) {
		const fraction =
			rollbackStart !== null && t >= rollbackStart
				? afterRollback(strategy.kind, rollbackStart, rollbackFrom, t)
				: progress(strategy.kind, t, step);
		if (fraction >= 1 && reachedFullAt === null) reachedFullAt = t;
		if (rollbackStart !== null && fraction === 0 && rolledBackAt === null) rolledBackAt = t;

		for (let i = 0; i < RPS; i++) {
			const user = Math.floor(random() * USERS);
			const segment = segmentOf[user] === 1;
			const onNew = strategy.sticky ? (stickyKey[user] ?? 1) < fraction : random() < fraction;
			const bugError = onNew && bug.error(segment, random);
			const slow = onNew && bug.slow(random);
			const error = bugError || random() < BASE_ERROR;
			totals[t] = (totals[t] ?? 0) + 1;
			if (error) errors[t] = (errors[t] ?? 0) + 1;
			if (slow) slows[t] = (slows[t] ?? 0) + 1;
			if (bugError || slow) {
				hits++;
				affected.add(user);
			}
			if (strategy.kind === 'canary' && fraction > 0 && fraction < 1) {
				const bucket = onNew ? canary : baseline;
				bucket.total++;
				if (error) bucket.err++;
				if (slow) bucket.slow++;
				if (segment) {
					bucket.segTotal++;
					if (error) bucket.segErr++;
				}
			}
		}

		if (t % 60 !== 59 || rollbackStart !== null) continue;

		let windowTotal = 0;
		let windowErr = 0;
		let windowSlow = 0;
		for (let s = Math.max(0, t - ALERT_WINDOW + 1); s <= t; s++) {
			windowTotal += totals[s] ?? 0;
			windowErr += errors[s] ?? 0;
			windowSlow += slows[s] ?? 0;
		}
		if (
			windowTotal > 0 &&
			(windowErr / windowTotal > ALERT_ERROR || windowSlow / windowTotal > ALERT_SLOW)
		) {
			detectedAt = t;
			detectedBy = 'alert → human';
			rollbackStart = t + HUMAN_MINUTES * 60;
			rollbackFrom =
				rollbackStart < HORIZON ? progress(strategy.kind, rollbackStart, step) : fraction;
			continue;
		}

		if (strategy.kind !== 'canary' || strategy.gate === 'none' || fraction >= 1) continue;
		const errFail =
			canary.err >= 3 && zScore(canary.err, canary.total, baseline.err, baseline.total) > Z;
		const slowFail =
			strategy.gate === 'full' &&
			canary.slow >= 3 &&
			zScore(canary.slow, canary.total, baseline.slow, baseline.total) > Z;
		const segFail =
			strategy.gate === 'full' &&
			canary.segErr >= 3 &&
			zScore(canary.segErr, canary.segTotal, baseline.segErr, baseline.segTotal) > Z;
		if (errFail || slowFail || segFail) {
			detectedAt = t;
			detectedBy = `gate, at ${Math.round(fraction * 100)}%`;
			rollbackStart = t + 1;
			rollbackFrom = fraction;
			continue;
		}
		if (t + 1 - stepStart >= STEP_SECONDS) {
			step++;
			stepStart = t + 1;
			canary = emptyCounts();
			baseline = emptyCounts();
		}
	}
	return { hits, users: affected.size, detectedAt, detectedBy, rolledBackAt, reachedFullAt };
}

const totalRequests = RPS * HORIZON;
heading(
	`Part A — one bad version, six strategies (${RPS} req/s, ${n(USERS)} users, watched for ${HORIZON / 60} minutes; ${HUMAN_MINUTES} minutes for a human after the alert)`
);
for (const [index, bug] of BUGS.entries()) {
	console.log(`\n${bug.name}`);
	console.log(
		row([
			['strategy', 42],
			['bad requests', 14],
			['users hit', 16],
			['caught', 10],
			['caught by', 18],
			['reverted', 12]
		])
	);
	for (const strategy of STRATEGIES) {
		const o = simulate(strategy, bug, SEED + index);
		console.log(
			row([
				[strategy.name, 42],
				[n(o.hits), 14],
				[`${n(o.users)} (${pct(o.users, USERS, 0)})`, 16],
				[o.detectedAt === null ? 'missed' : minutes(o.detectedAt + 1), 10],
				[o.detectedBy, 18],
				[o.rolledBackAt === null ? '—' : minutes(o.rolledBackAt), 12]
			])
		);
	}
}
console.log(
	`\n(total requests ${n(totalRequests)}; "bad requests" = requests that hit the new version's bug)`
);

heading('Part B — a good version: how long to 100%, how many extra instances');
console.log(
	row([
		['strategy', 42],
		['reaches 100%', 16],
		['extra capacity', 16],
		['bad rollback', 14]
	])
);
for (const strategy of STRATEGIES) {
	const o = simulate(strategy, NO_BUG, SEED + 50);
	console.log(
		row([
			[strategy.name, 42],
			[o.reachedFullAt === null ? '—' : minutes(o.reachedFullAt), 16],
			[strategy.extra, 16],
			[o.detectedAt === null ? 'no' : `yes (${o.detectedBy})`, 14]
		])
	);
}

heading(`Part C — canary statistics: baseline error 0.1%, z > ${Z}, ${n(TRIALS)} runs per cell`);
console.log(
	row([
		['canary', 8],
		['time', 8],
		['canary request', 16],
		['+0.2% hit', 12],
		['+1% hit', 12],
		['false pos.', 12],
		['checked per minute', 20],
		['+1% damage', 14]
	])
);
const stats = mulberry32(SEED + 900);
for (const share of [0.01, 0.05, 0.25]) {
	for (const window of [5, 10, 30]) {
		const perMinuteCanary = Math.round(RPS * 60 * share);
		const perMinuteBase = Math.round(RPS * 60) - perMinuteCanary;
		const detect = (delta: number): { end: number; peek: number } => {
			let end = 0;
			let peek = 0;
			for (let trial = 0; trial < TRIALS; trial++) {
				let cBad = 0;
				let cTotal = 0;
				let bBad = 0;
				let bTotal = 0;
				let peeked = false;
				let z = 0;
				for (let minute = 0; minute < window; minute++) {
					cBad += binomial(stats, perMinuteCanary, BASE_ERROR + delta);
					bBad += binomial(stats, perMinuteBase, BASE_ERROR);
					cTotal += perMinuteCanary;
					bTotal += perMinuteBase;
					z = cBad >= 3 ? zScore(cBad, cTotal, bBad, bTotal) : 0;
					if (z > Z) peeked = true;
				}
				if (z > Z) end++;
				if (peeked) peek++;
			}
			return { end, peek };
		};
		const small = detect(0.002);
		const big = detect(0.01);
		const none = detect(0);
		const canaryRequests = perMinuteCanary * window;
		console.log(
			row([
				[`${share * 100}%`, 8],
				[`${window} min`, 8],
				[n(canaryRequests), 16],
				[pct(small.end, TRIALS, 0), 12],
				[pct(big.end, TRIALS, 0), 12],
				[pct(none.end, TRIALS, 1), 12],
				[pct(none.peek, TRIALS, 1), 20],
				[n(canaryRequests * 0.01), 14]
			])
		);
	}
}
console.log(
	'\n("hit" = checked once at the end, z > 3; "checked per minute" = checked every minute, z > 3 at any point, with no bug)'
);

heading('Part D — canary at 5% for an hour: random per request vs sticky per user');
console.log(
	row([
		['routing', 26],
		['saw the new version', 22],
		['switched between versions', 28]
	])
);
for (const sticky of [false, true]) {
	const random = mulberry32(SEED + 700);
	const seenNew = new Uint8Array(USERS);
	const seenOld = new Uint8Array(USERS);
	for (let i = 0; i < RPS * 3_600; i++) {
		const user = Math.floor(random() * USERS);
		const onNew = sticky ? (stickyKey[user] ?? 1) < 0.05 : random() < 0.05;
		if (onNew) seenNew[user] = 1;
		else seenOld[user] = 1;
	}
	let touched = 0;
	let flipped = 0;
	for (let u = 0; u < USERS; u++) {
		if (seenNew[u] === 1) touched++;
		if (seenNew[u] === 1 && seenOld[u] === 1) flipped++;
	}
	console.log(
		row([
			[sticky ? 'sticky per user' : 'random per request', 26],
			[`${n(touched)} (${pct(touched, USERS, 0)})`, 22],
			[`${n(flipped)} (${pct(flipped, USERS, 0)})`, 28]
		])
	);
}
