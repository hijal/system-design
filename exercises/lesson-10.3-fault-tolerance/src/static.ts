import { exponential, heading, mulberry32, n, pct, row } from './random';

const INSTANCES = Number(process.env.INSTANCES ?? 8);
const CAPACITY = Number(process.env.CAPACITY ?? 100);
const BASE_RPS = Number(process.env.BASE_RPS ?? 600);
const PEAK_RPS = Number(process.env.PEAK_RPS ?? 1_000);
const OUTAGE_FROM = Number(process.env.OUTAGE_FROM ?? 30) * 60;
const OUTAGE_TO = Number(process.env.OUTAGE_TO ?? 75) * 60;
const PEAK_FROM = 50 * 60;
const PEAK_TO = 80 * 60;
const TTL = Number(process.env.TTL ?? 300);
const REFRESH = 30;
const BOOT = 60;
const CRASH_RETRY = 30;
const RESTARTS_PER_HOUR = Number(process.env.RESTARTS_PER_HOUR ?? 0.5);
const DURATION = 120 * 60;
const SEED = Number(process.env.SEED ?? 5);

type Design = {
	name: string;
	perRequest: boolean;
	ttl: number;
	snapshot: boolean;
};

const DESIGNS: Design[] = [
	{ name: 'প্রতি request এ জিজ্ঞেস', perRequest: true, ttl: 0, snapshot: false },
	{ name: `cache, TTL ${TTL / 60} মিনিট`, perRequest: false, ttl: TTL, snapshot: false },
	{
		name: 'last-known-good',
		perRequest: false,
		ttl: Number.POSITIVE_INFINITY,
		snapshot: false
	},
	{
		name: 'last-known-good + snapshot',
		perRequest: false,
		ttl: Number.POSITIVE_INFINITY,
		snapshot: true
	}
];

type Instance = { bootDoneAt: number; configAt: number | null; serving: boolean };

const controlPlaneUp = (t: number): boolean => t < OUTAGE_FROM || t >= OUTAGE_TO;
const traffic = (t: number): number => (t >= PEAK_FROM && t < PEAK_TO ? PEAK_RPS : BASE_RPS);

function crashSchedule(): Map<number, number[]> {
	const random = mulberry32(SEED);
	const schedule = new Map<number, number[]>();
	for (let id = 0; id < 32; id++) {
		let t = exponential(random, 3_600 / RESTARTS_PER_HOUR);
		while (t < DURATION) {
			const second = Math.floor(t);
			schedule.set(second, [...(schedule.get(second) ?? []), id]);
			t += exponential(random, 3_600 / RESTARTS_PER_HOUR);
		}
	}
	return schedule;
}

type Result = {
	requests: number;
	failed: number;
	worstMinute: number;
	failedBootAttempts: number;
	maxStaleness: number;
	minutesShort: number;
	crashes: number;
	launched: number;
};

function simulate(design: Design, crashes: Map<number, number[]>): Result {
	const fleet: Instance[] = Array.from({ length: INSTANCES }, () => ({
		bootDoneAt: 0,
		configAt: 0,
		serving: true
	}));
	const result: Result = {
		requests: 0,
		failed: 0,
		worstMinute: 0,
		failedBootAttempts: 0,
		maxStaleness: 0,
		minutesShort: 0,
		crashes: 0,
		launched: 0
	};
	let minuteRequests = 0;
	let minuteFailed = 0;
	let snapshotAt = 0;

	const boot = (instance: Instance, t: number): void => {
		instance.serving = false;
		instance.configAt = null;
		instance.bootDoneAt = t + BOOT;
	};

	for (let t = 0; t < DURATION; t++) {
		const up = controlPlaneUp(t);
		if (up) snapshotAt = t;
		for (const id of crashes.get(t) ?? []) {
			const instance = fleet[id];
			if (!instance) continue;
			result.crashes++;
			boot(instance, t);
		}
		if (t % 30 === 0) {
			const desired = Math.ceil(traffic(t) / (CAPACITY * 0.75));
			while (fleet.length < desired) {
				const instance: Instance = { bootDoneAt: 0, configAt: null, serving: false };
				boot(instance, t);
				fleet.push(instance);
				result.launched++;
			}
		}
		let serving = 0;
		for (const instance of fleet) {
			if (!instance.serving && t >= instance.bootDoneAt) {
				if (design.perRequest || up) {
					instance.serving = true;
					instance.configAt = t;
				} else if (design.snapshot) {
					instance.serving = true;
					instance.configAt = snapshotAt;
				} else {
					result.failedBootAttempts++;
					instance.bootDoneAt = t + CRASH_RETRY;
				}
			}
			if (!instance.serving) continue;
			if (up && t % REFRESH === 0) instance.configAt = t;
			const age = t - (instance.configAt ?? t);
			const ok = design.perRequest ? up : age <= design.ttl;
			if (ok) {
				serving++;
				if (!design.perRequest) result.maxStaleness = Math.max(result.maxStaleness, age);
			}
		}
		const demand = traffic(t);
		const failed = Math.max(0, demand - serving * CAPACITY);
		if (failed > 0 && t % 60 === 0) result.minutesShort++;
		result.requests += demand;
		result.failed += failed;
		minuteRequests += demand;
		minuteFailed += failed;
		if (t % 60 === 59) {
			result.worstMinute = Math.max(result.worstMinute, minuteFailed / minuteRequests);
			minuteRequests = 0;
			minuteFailed = 0;
		}
	}
	return result;
}

const crashes = crashSchedule();
heading(
	`ক. Flags/config service (control plane) মিনিট ${OUTAGE_FROM / 60} থেকে ${OUTAGE_TO / 60} পর্যন্ত মরা; মিনিট ${PEAK_FROM / 60}–${PEAK_TO / 60} এ traffic ${BASE_RPS} → ${PEAK_RPS} req/s, autoscaler নতুন instance তোলে; instance মাঝে মাঝে crash করে restart নেয়`
);
console.log(
	`   শুরুতে ${INSTANCES}টা instance, প্রতিটা ${CAPACITY} req/s; boot ${BOOT} s; config ছাড়া boot ব্যর্থ হলে ${CRASH_RETRY} s পরে আবার; ${DURATION / 60} মিনিট simulate করা`
);
console.log(
	row([
		['নকশা', 28],
		['ব্যর্থ request', 15],
		['সবচেয়ে খারাপ মিনিট', 20],
		['ঘাটতির মিনিট', 14],
		['ব্যর্থ boot', 12],
		['config এর বয়স (সর্বোচ্চ)', 25]
	])
);
let summary: Result | undefined;
for (const design of DESIGNS) {
	const result = simulate(design, crashes);
	summary = result;
	console.log(
		row([
			[design.name, 28],
			[pct(result.failed, result.requests, 2), 15],
			[pct(result.worstMinute, 1), 20],
			[result.minutesShort, 14],
			[n(result.failedBootAttempts), 12],
			[design.perRequest ? '—' : `${(result.maxStaleness / 60).toFixed(0)} মিনিট`, 25]
		])
	);
}
if (summary)
	console.log(
		`   এই run এ: crash/restart ${summary.crashes}টা, autoscaler নতুন instance তুলেছে ${summary.launched}টা; ব্যর্থ request = পুরো ${DURATION / 60} মিনিটের মোটের %`
	);
