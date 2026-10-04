import { HOURS_PER_MONTH, PRICE as P } from './prices';
import { env, mulberry32, normal } from './util';

export const AVG_RPS = env('RPS', 300);
export const PER_INSTANCE = env('INSTANCE_RPS', 75);
export const TARGET = env('TARGET_UTIL', 0.6);
export const BOOT_MINUTES = env('BOOT_MINUTES', 5);
const COOLDOWN_MINUTES = env('COOLDOWN_MINUTES', 15);
const MIN_INSTANCES = env('MIN_INSTANCES', 3);
const SPIKE_RPS = env('SPIKE_RPS', 700);
export const SPOT_FRACTION = env('SPOT_FRACTION', 0.7);
const SPOT_HAZARD_PER_HOUR = env('SPOT_HAZARD', 0.02);
const SEED = env('SEED', 1_071);

export const WEEK = 7 * 1_440;
const SPIKE_START = 2 * 1_440 + 10 * 60;

function regular(t: number): number {
	const day = Math.floor(t / 1_440);
	const hour = (t % 1_440) / 60;
	const daytime = Math.exp(-((hour - 14) ** 2) / (2 * 3.5 ** 2));
	const weekday = day >= 5 ? 0.45 : 1;
	return (0.3 + 0.7 * daytime) * weekday;
}

const rawRegular = Array.from({ length: WEEK }, (_, t) => regular(t));
const scale = AVG_RPS / (rawRegular.reduce((a, b) => a + b, 0) / WEEK);
const noiseRandom = mulberry32(SEED);
let drift = 0;
export const predicted = rawRegular.map((v) => v * scale);
export const demand = predicted.map((v, t) => {
	drift = 0.9 * drift + 0.03 * normal(noiseRandom);
	const since = t - SPIKE_START;
	const spike =
		since < 0
			? 0
			: since < 10
				? (SPIKE_RPS * since) / 10
				: SPIKE_RPS * Math.exp(-(since - 10) / 40);
	return Math.max(0, v * (1 + drift) + spike);
});
export const peak = Math.max(...demand);

export type Policy = {
	name: string;
	kind: 'fixed' | 'reactive' | 'scheduled' | 'spot';
};
export const POLICIES: Policy[] = [
	{ name: 'স্থির: peak + ২৫%, ২৪/৭', kind: 'fixed' },
	{ name: `reactive autoscale (লক্ষ্য ${Math.round(TARGET * 100)}%)`, kind: 'reactive' },
	{ name: 'scheduled (জানা ছক) + reactive', kind: 'scheduled' },
	{ name: `reactive, ${Math.round(SPOT_FRACTION * 100)}% spot`, kind: 'spot' }
];

export type Result = {
	cost: number;
	instanceMinutes: number;
	overloadedMinutes: number;
	excessRequests: number;
	utilization: number;
	interruptions: number;
	hourly: number[];
	spikeExcess: number;
};

const desiredFor = (rps: number): number =>
	Math.max(MIN_INSTANCES, Math.ceil(rps / (PER_INSTANCE * TARGET)));

export function simulate(policy: Policy): Result {
	const random = mulberry32(SEED + 7);
	const fixed = Math.ceil((peak * 1.25) / PER_INSTANCE);
	let onDemand = policy.kind === 'fixed' ? fixed : MIN_INSTANCES;
	let spot = 0;
	const pending: { ready: number; spot: boolean }[] = [];
	const recent: number[] = [];
	let cost = 0;
	let instanceMinutes = 0;
	let overloadedMinutes = 0;
	let excessRequests = 0;
	let served = 0;
	let capacityTotal = 0;
	let interruptions = 0;
	let spikeExcess = 0;
	const hourly: number[] = [];
	let hourSum = 0;

	for (let t = 0; t < WEEK; t++) {
		for (let i = pending.length - 1; i >= 0; i--) {
			const p = pending[i];
			if (p && p.ready <= t) {
				if (p.spot) spot++;
				else onDemand++;
				pending.splice(i, 1);
			}
		}
		if (policy.kind === 'spot' && spot > 0) {
			let lost = 0;
			for (let s = 0; s < spot; s++) if (random() < SPOT_HAZARD_PER_HOUR / 60) lost++;
			if (lost > 0) {
				spot -= lost;
				interruptions += lost;
				for (let k = 0; k < lost; k++) pending.push({ ready: t + BOOT_MINUTES, spot: true });
			}
		}

		const active = onDemand + spot;
		const d = demand[t] ?? 0;
		const capacity = active * PER_INSTANCE;
		const excess = Math.max(0, d - capacity);
		if (excess > 0) overloadedMinutes++;
		excessRequests += excess * 60;
		if (t >= SPIKE_START && t < SPIKE_START + 180) spikeExcess += excess * 60;
		served += Math.min(d, capacity);
		capacityTotal += capacity;
		instanceMinutes += active;
		hourSum += active;
		if (t % 60 === 59) {
			hourly.push(hourSum / 60);
			hourSum = 0;
		}
		cost += (onDemand * P.appInstanceHour + spot * P.appInstanceHour * P.spotShare) / 60;

		if (policy.kind === 'fixed') continue;
		const observed = demand[t - 1] ?? d;
		let want = desiredFor(observed);
		if (policy.kind === 'scheduled') {
			const ahead = predicted[t + BOOT_MINUTES] ?? predicted[t] ?? 0;
			want = Math.max(want, desiredFor(ahead * 1.1));
		}
		recent.push(want);
		if (recent.length > COOLDOWN_MINUTES) recent.shift();
		const inFlight = pending.length;
		if (want > active + inFlight) {
			for (let k = 0; k < want - active - inFlight; k++) {
				const total = active + inFlight + k;
				const useSpot =
					policy.kind === 'spot' && total >= MIN_INSTANCES && random() < SPOT_FRACTION;
				pending.push({ ready: t + BOOT_MINUTES, spot: useSpot });
			}
		} else {
			const keepAtLeast = Math.max(...recent);
			if (active > keepAtLeast && pending.length === 0) {
				if (spot > 0) spot--;
				else if (onDemand > MIN_INSTANCES) onDemand--;
			}
		}
	}
	return {
		cost,
		instanceMinutes,
		overloadedMinutes,
		excessRequests,
		utilization: served / capacityTotal,
		interruptions,
		hourly,
		spikeExcess
	};
}

export function commitmentCost(
	usage: readonly number[],
	commit: number
): { cost: number; wasted: number } {
	const weeks = HOURS_PER_MONTH / 168;
	let cost = 0;
	let wasted = 0;
	for (const u of usage) {
		cost +=
			commit * P.appInstanceHour * (1 - P.commitDiscount) +
			Math.max(0, u - commit) * P.appInstanceHour;
		wasted += Math.max(0, commit - u) * P.appInstanceHour * (1 - P.commitDiscount);
	}
	return { cost: cost * weeks, wasted: wasted * weeks };
}

export function bestCommitment(usage: readonly number[]): number {
	const maxUse = Math.ceil(Math.max(...usage));
	let best = 0;
	for (let c = 0; c <= maxUse; c++)
		if (commitmentCost(usage, c).cost < commitmentCost(usage, best).cost) best = c;
	return best;
}

export const monthly = (weekCost: number): number => (weekCost / 168) * HOURS_PER_MONTH;
