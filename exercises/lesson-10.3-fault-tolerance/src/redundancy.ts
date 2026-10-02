import { exponential, heading, mulberry32, n, pct, row } from './random';

const YEARS = Number(process.env.YEARS ?? 40);
const SEED = Number(process.env.SEED ?? 7);
const INSTANCE_MTBF_DAYS = Number(process.env.INSTANCE_MTBF_DAYS ?? 30);
const INSTANCE_REPAIR = Number(process.env.INSTANCE_REPAIR ?? 30);
const AZ_OUTAGES_PER_YEAR = Number(process.env.AZ_OUTAGES_PER_YEAR ?? 0.5);
const AZ_OUTAGE = Number(process.env.AZ_OUTAGE ?? 120);
const DEPLOYS_PER_WEEK = Number(process.env.DEPLOYS_PER_WEEK ?? 3);
const BAD_DEPLOY = Number(process.env.BAD_DEPLOY ?? 0.03);
const LOUD_DETECT = Number(process.env.LOUD_DETECT ?? 5);
const QUIET_DETECT = Number(process.env.QUIET_DETECT ?? 15);
const ROLLBACK = Number(process.env.ROLLBACK ?? 10);
const BAKE = Number(process.env.BAKE ?? 10);

const MINUTES = 525_600 * YEARS;

type Cause = 'instance' | 'az' | 'deploy';
type Config = { name: string; instances: number; spreadAz: boolean; rolling: boolean };

const CONFIGS: Config[] = [
	{ name: '১টা instance', instances: 1, spreadAz: false, rolling: false },
	{ name: '৩টা, একই AZ, একসাথে deploy', instances: 3, spreadAz: false, rolling: false },
	{ name: '৩টা, ৩টা AZ, একসাথে deploy', instances: 3, spreadAz: true, rolling: false },
	{ name: '৩টা, ৩টা AZ, একটা একটা করে', instances: 3, spreadAz: true, rolling: true }
];

function intervals(seed: number, meanUp: number, meanDown: number): [number, number][] {
	const random = mulberry32(seed);
	const result: [number, number][] = [];
	let t = exponential(random, meanUp);
	while (t < MINUTES) {
		const end = t + Math.max(1, exponential(random, meanDown));
		result.push([Math.floor(t), Math.min(MINUTES, Math.ceil(end))]);
		t = end + exponential(random, meanUp);
	}
	return result;
}

type Deploy = { at: number; bad: boolean; loud: boolean };

function deploys(): Deploy[] {
	const random = mulberry32(SEED * 31 + 5);
	const mean = (7 * 24 * 60) / DEPLOYS_PER_WEEK;
	const result: Deploy[] = [];
	let t = exponential(random, mean);
	while (t < MINUTES) {
		const bad = random() < BAD_DEPLOY;
		const loud = random() < 0.5;
		result.push({ at: Math.floor(t), bad, loud });
		t += exponential(random, mean);
	}
	return result;
}

const CODE: Record<Cause, number> = { instance: 1, az: 2, deploy: 3 };
const CAUSES: Cause[] = ['instance', 'az', 'deploy'];

function mark(target: Uint8Array, from: number, to: number, value: number): void {
	for (let m = Math.max(0, from); m < Math.min(MINUTES, to); m++) if (!target[m]) target[m] = value;
}

type Result = { failed: Record<Cause, number>; fullOutage: number; events: Record<Cause, number> };

function simulate(config: Config): Result {
	const meanUp = INSTANCE_MTBF_DAYS * 24 * 60;
	const events: Record<Cause, number> = { instance: 0, az: 0, deploy: 0 };
	const dead: Uint8Array[] = [];
	const wrong: Uint8Array[] = [];
	const azSeen = new Set<number>();
	for (let i = 0; i < config.instances; i++) {
		const down = new Uint8Array(MINUTES);
		const az = config.spreadAz ? i : 0;
		const azOutages = intervals(SEED * 1000 + az, 525_600 / AZ_OUTAGES_PER_YEAR, AZ_OUTAGE);
		for (const [from, to] of azOutages) mark(down, from, to, CODE.az);
		if (!azSeen.has(az)) events.az += azOutages.length;
		azSeen.add(az);
		const crashes = intervals(SEED * 100 + i, meanUp, INSTANCE_REPAIR);
		for (const [from, to] of crashes) mark(down, from, to, CODE.instance);
		events.instance += crashes.length;
		dead.push(down);
		wrong.push(new Uint8Array(MINUTES));
	}
	for (const deploy of deploys()) {
		if (!deploy.bad) continue;
		events.deploy++;
		if (!config.rolling) {
			const end = deploy.at + LOUD_DETECT + ROLLBACK;
			for (let i = 0; i < config.instances; i++) {
				const target = deploy.loud ? dead[i] : wrong[i];
				if (target) mark(target, deploy.at, end, CODE.deploy);
			}
			continue;
		}
		if (deploy.loud) {
			const first = dead[0];
			if (first) mark(first, deploy.at, deploy.at + LOUD_DETECT + ROLLBACK, CODE.deploy);
			continue;
		}
		const end = deploy.at + QUIET_DETECT + ROLLBACK;
		for (let i = 0; i < config.instances; i++) {
			const start = deploy.at + i * BAKE;
			const target = wrong[i];
			if (start < end && target) mark(target, start, end, CODE.deploy);
		}
	}
	const failed: Record<Cause, number> = { instance: 0, az: 0, deploy: 0 };
	let fullOutage = 0;
	for (let m = 0; m < MINUTES; m++) {
		let alive = 0;
		let erroring = 0;
		let justDied = 0;
		let cause: Cause = 'deploy';
		for (let i = 0; i < config.instances; i++) {
			const code = dead[i]?.[m] ?? 0;
			if (code) {
				cause = CAUSES[code - 1] ?? 'deploy';
				if (m === 0 || !dead[i]?.[m - 1]) justDied++;
				continue;
			}
			alive++;
			if (wrong[i]?.[m]) erroring++;
		}
		if (alive === 0) {
			fullOutage++;
			failed[cause] += 1;
			continue;
		}
		if (erroring > 0) failed.deploy += erroring / alive;
		if (justDied > 0) failed[cause] += (justDied / config.instances) * 0.5;
	}
	return { failed, fullOutage, events };
}

heading(
	`ক. Billing service, ${YEARS} বছর simulate করা — instance মরে (গড়ে ${INSTANCE_MTBF_DAYS} দিনে একবার, ${INSTANCE_REPAIR} মিনিট), AZ মরে (বছরে ${AZ_OUTAGES_PER_YEAR}বার, ${AZ_OUTAGE} মিনিট), deploy (সপ্তাহে ${DEPLOYS_PER_WEEK}টা, ${BAD_DEPLOY * 100}% খারাপ)`
);
const perInstance =
	(INSTANCE_MTBF_DAYS * 24 * 60) / (INSTANCE_MTBF_DAYS * 24 * 60 + INSTANCE_REPAIR);
console.log(
	row([
		['নকশা', 30],
		['সূত্রে বন্ধ/বছর', 18],
		['মাপা', 11],
		['ব্যর্থ মিনিট/বছর', 18],
		['instance', 10],
		['AZ', 8],
		['deploy', 9],
		['পুরো বন্ধ', 12]
	])
);
function formulaDowntime(availability: number): string {
	const minutes = (1 - availability) * 525_600;
	return minutes >= 1 ? `${n(minutes)} মি` : `${(minutes * 60).toFixed(3)} সে`;
}

let lastEvents: Record<Cause, number> = { instance: 0, az: 0, deploy: 0 };
for (const config of CONFIGS) {
	const { failed, fullOutage, events } = simulate(config);
	lastEvents = events;
	const totalFailed = failed.instance + failed.az + failed.deploy;
	const formula = 1 - Math.pow(1 - perInstance, config.instances);
	const perYear = (value: number): string => n(value / YEARS);
	console.log(
		row([
			[config.name, 30],
			[formulaDowntime(formula), 18],
			[pct(MINUTES - totalFailed, MINUTES, 3), 11],
			[perYear(totalFailed), 18],
			[perYear(failed.instance), 10],
			[perYear(failed.az), 8],
			[perYear(failed.deploy), 9],
			[`${perYear(fullOutage)} মি`, 12]
		])
	);
}
console.log(
	`   এক instance এর availability a = ${(perInstance * 100).toFixed(3)}%। "ব্যর্থ মিনিট" = প্রতি মিনিটে ব্যর্থ request এর ভগ্নাংশের যোগ (৩টার ১টা ভুল উত্তর দিলে ⅓ মিনিট)`
);
console.log(
	`   ${YEARS} বছরে ঘটেছে: instance crash ${n(lastEvents.instance)}টা (৩টা মিলে), AZ outage ${n(lastEvents.az)}টা (৩টা AZ মিলে), খারাপ deploy ${n(lastEvents.deploy)}টা`
);
