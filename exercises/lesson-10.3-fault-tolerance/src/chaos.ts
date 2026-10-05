import { heading, mulberry32, n, pct, percentile, row } from './random';

const RPS = Number(process.env.RPS ?? 500);
const BASE_ERROR = Number(process.env.BASE_ERROR ?? 0.0005);
const LOUD = Number(process.env.LOUD ?? 0.6);
const SUBTLE = Number(process.env.SUBTLE ?? 0.05);
const SLO_ALARM = Number(process.env.SLO_ALARM ?? 0.002);
const Z = Number(process.env.Z ?? 3);
const MAX_MINUTES = Number(process.env.MAX_MINUTES ?? 30);
const RUNS = Number(process.env.RUNS ?? 200);
const CHECK_EVERY = 10;

const RADII = [0.001, 0.01, 0.05, 0.25, 0.5, 1];

type Method = 'global' | 'control';

type Run = { detectedAt: number | null; harmed: number };

function binomial(random: () => number, trials: number, p: number): number {
	if (trials <= 0 || p <= 0) return 0;
	if (p >= 1) return trials;
	if (p > 0.5) return trials - binomial(random, trials, 1 - p);
	const mean = trials * p;
	if (mean > 25) {
		const u = 1 - random();
		const v = random();
		const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
		return Math.min(trials, Math.max(0, Math.round(mean + normal * Math.sqrt(mean * (1 - p)))));
	}
	const logQ = Math.log(1 - p);
	let count = 0;
	let position = Math.floor(Math.log(1 - random()) / logQ);
	while (position < trials) {
		count++;
		position += 1 + Math.floor(Math.log(1 - random()) / logQ);
	}
	return count;
}

function experiment(radius: number, method: Method, bugHits: number, seed: number): Run | null {
	if (method === 'control' && radius > 0.5) return null;
	const random = mulberry32(seed);
	const window: number[] = [];
	let expRequests = 0;
	let expFailures = 0;
	let ctlRequests = 0;
	let ctlFailures = 0;
	let harmed = 0;
	for (let second = 1; second <= MAX_MINUTES * 60; second++) {
		const exposed = binomial(random, RPS, radius);
		const control = radius < 1 ? binomial(random, RPS - exposed, radius / (1 - radius)) : 0;
		const rest = RPS - exposed - control;
		const expNatural = binomial(random, exposed, BASE_ERROR);
		const fault = binomial(random, exposed - expNatural, bugHits);
		const ctlNatural = binomial(random, control, BASE_ERROR);
		const restNatural = binomial(random, rest, BASE_ERROR);
		harmed += fault;
		expRequests += exposed;
		expFailures += expNatural + fault;
		ctlRequests += control;
		ctlFailures += ctlNatural;
		window.push(expNatural + fault + ctlNatural + restNatural);
		if (window.length > 60) window.shift();
		if (second % CHECK_EVERY !== 0) continue;
		if (method === 'global') {
			const failures = window.reduce((sum, value) => sum + value, 0);
			if (failures / (window.length * RPS) > SLO_ALARM) return { detectedAt: second, harmed };
			continue;
		}
		if (expFailures < 3 || ctlRequests === 0 || expRequests === 0) continue;
		const pe = expFailures / expRequests;
		const pc = ctlFailures / ctlRequests;
		const pooled = (expFailures + ctlFailures) / (expRequests + ctlRequests);
		const se = Math.sqrt(pooled * (1 - pooled) * (1 / expRequests + 1 / ctlRequests));
		if (se > 0 && (pe - pc) / se > Z) return { detectedAt: second, harmed };
	}
	return { detectedAt: null, harmed };
}

type Summary = { detectedShare: number; medianTime: number; medianHarmed: number };

function summarize(radius: number, method: Method, bugHits: number): Summary | null {
	const results: Run[] = [];
	for (let r = 0; r < RUNS; r++) {
		const result = experiment(radius, method, bugHits, 1_000 + r * 7 + Math.round(radius * 1e4));
		if (!result) return null;
		results.push(result);
	}
	const detected = results.filter((result) => result.detectedAt !== null);
	const times = detected.map((result) => result.detectedAt ?? 0).sort((a, b) => a - b);
	const harmed = results.map((result) => result.harmed).sort((a, b) => a - b);
	return {
		detectedShare: detected.length / results.length,
		medianTime: percentile(times, 50),
		medianHarmed: percentile(harmed, 50)
	};
}

const radiusLabel = (radius: number): string => (radius === 1 ? '100% (all)' : `${radius * 100}%`);

const duration = (seconds: number): string =>
	seconds >= 60 ? `${(seconds / 60).toFixed(1)} min` : `${seconds} s`;

function detectionTable(title: string, bugHits: number): void {
	heading(title);
	console.log(
		row([
			['blast radius', 14],
			['global: caught', 17],
			['when', 10],
			['harm', 9],
			['control: caught', 17],
			['when', 10],
			['harm', 9]
		])
	);
	for (const radius of RADII) {
		const cells = (summary: Summary | null): [string, number][] =>
			summary
				? [
						[pct(summary.detectedShare, 1, 0), 17],
						[summary.detectedShare > 0 ? duration(summary.medianTime) : '—', 10],
						[n(summary.medianHarmed), 9]
					]
				: [
						['—', 17],
						['—', 10],
						['—', 9]
					];
		console.log(
			row([
				[radiusLabel(radius), 14],
				...cells(summarize(radius, 'global', bugHits)),
				...cells(summarize(radius, 'control', bugHits))
			])
		);
	}
}

console.log(
	`Injecting a 2 s billing delay into the board; ${RPS} req/s, normal error rate ${BASE_ERROR * 100}%, at most ${MAX_MINUTES} minutes. Global alarm: stop if total errors in the last 60 s > ${SLO_ALARM * 100}%. Control group: an untouched group of equal size, stop if the error difference has z > ${Z}. Checked every ${CHECK_EVERY} s, median of ${RUNS} runs. "harm" = user requests failed by the fault before stopping (all ${MAX_MINUTES} minutes if never caught)`
);
detectionTable(
	`A. A loud bug — ${LOUD * 100}% of injected requests fail (plan badge on every paid board, no timeout)`,
	LOUD
);
detectionTable(
	`B. A subtle bug — ${SUBTLE * 100}% of injected requests fail (only on boards with 500+ tasks)`,
	SUBTLE
);

heading(`C. The code is fine, the fault harmless — yet stopped by mistake, in what % of runs`);
console.log(
	row([
		['blast radius', 14],
		['global: false stop', 20],
		['control: false stop', 21]
	])
);
for (const radius of RADII) {
	const global = summarize(radius, 'global', 0);
	const control = summarize(radius, 'control', 0);
	console.log(
		row([
			[radiusLabel(radius), 14],
			[global ? pct(global.detectedShare, 1, 1) : '—', 20],
			[control ? pct(control.detectedShare, 1, 1) : '—', 21]
		])
	);
}
