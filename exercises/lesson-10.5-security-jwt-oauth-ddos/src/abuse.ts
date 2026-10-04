import { heading, mulberry32, n, pct, row } from './util';

const ATTEMPTS = Number(process.env.ATTEMPTS ?? 1_200_000);
const BOT_IPS = Number(process.env.BOT_IPS ?? 38_000);
const ATTACK_MINUTES = Number(process.env.ATTACK_MINUTES ?? 360);
const HIT_RATE = Number(process.env.HIT_RATE ?? 0.03);
const REUSE = Number(process.env.REUSE ?? 0.1);
const LEGIT_LOGINS = Number(process.env.LEGIT_LOGINS ?? 20_000);
const MFA = Number(process.env.MFA ?? 0.25);
const CORPUS = Number(process.env.CORPUS ?? 0.85);
const BOT_SOLVE = Number(process.env.BOT_SOLVE ?? 0.1);
const SEED = Number(process.env.SEED ?? 1_050);

const START = 60 * 60;
const END = START + ATTACK_MINUTES * 60 + 60 * 60;

type Attempt = {
	t: number;
	ip: string;
	email: string;
	bot: boolean;
	correct: boolean;
	breached: boolean;
	mfa: boolean;
	knownDevice: boolean;
};

const random = mulberry32(SEED);
const attempts: Attempt[] = [];
for (let i = 0; i < ATTEMPTS; i++) {
	const real = random() < HIT_RATE;
	const correct = real && random() < REUSE;
	attempts.push({
		t: START + random() * ATTACK_MINUTES * 60,
		ip: `bot-${Math.floor(random() * BOT_IPS)}`,
		email: real ? `user-${Math.floor(random() * 200_000)}` : `nobody-${i}`,
		bot: true,
		correct,
		breached: correct && random() < CORPUS,
		mfa: random() < MFA,
		knownDevice: false
	});
}
for (let i = 0; i < LEGIT_LOGINS; i++) {
	const office = random() < 0.3;
	const t = random() * END;
	const email = `user-${Math.floor(random() * 200_000)}`;
	const ip = office ? `office-${Math.floor(random() * 40)}` : `home-${i}`;
	const knownDevice = random() < 0.7;
	const breached = random() < 0.06;
	const mfa = random() < MFA;
	if (random() < 0.08)
		attempts.push({ t, ip, email, bot: false, correct: false, breached: false, mfa, knownDevice });
	attempts.push({ t: t + 20, ip, email, bot: false, correct: true, breached, mfa, knownDevice });
}
attempts.sort((a, b) => a.t - b.t);

class SlidingLog {
	readonly #log = new Map<string, number[]>();
	constructor(
		readonly limit: number,
		readonly windowSeconds: number
	) {}
	allow(key: string, t: number): boolean {
		let recent = this.#log.get(key);
		if (!recent) {
			recent = [];
			this.#log.set(key, recent);
		}
		while (recent.length > 0 && (recent[0] ?? t) <= t - this.windowSeconds) recent.shift();
		const allowed = recent.length < this.limit;
		if (allowed) recent.push(t);
		return allowed;
	}
}

type Policy = {
	name: string;
	ipLimit: number | null;
	emailLimit: number | null;
	breachCheck: boolean;
	detector: boolean;
	mfa: boolean;
};

const POLICIES: Policy[] = [
	{
		name: 'কোনো সীমা নেই',
		ipLimit: null,
		emailLimit: null,
		breachCheck: false,
		detector: false,
		mfa: false
	},
	{
		name: '9.5: IP ২০/ঘ + email ১০/ঘ',
		ipLimit: 20,
		emailLimit: 10,
		breachCheck: false,
		detector: false,
		mfa: false
	},
	{
		name: 'কঠোর: IP ৫/ঘ + email ১০/ঘ',
		ipLimit: 5,
		emailLimit: 10,
		breachCheck: false,
		detector: false,
		mfa: false
	},
	{
		name: '9.5 + breached password check',
		ipLimit: 20,
		emailLimit: 10,
		breachCheck: true,
		detector: false,
		mfa: false
	},
	{
		name: '9.5 + failure ratio → challenge',
		ipLimit: 20,
		emailLimit: 10,
		breachCheck: false,
		detector: true,
		mfa: false
	},
	{
		name: `সব + MFA (${Math.round(MFA * 100)}% user)`,
		ipLimit: 20,
		emailLimit: 10,
		breachCheck: true,
		detector: true,
		mfa: true
	}
];

type Outcome = {
	botsReached: number;
	takeovers: number;
	legitBlocked: number;
	legitFriction: number;
	legitTotal: number;
	detectedAt: number | null;
};

function simulate(policy: Policy): Outcome {
	const ipLog = policy.ipLimit === null ? null : new SlidingLog(policy.ipLimit, 3_600);
	const emailLog = policy.emailLimit === null ? null : new SlidingLog(policy.emailLimit, 3_600);
	const gate = mulberry32(SEED + 11);
	const perMinute = new Map<number, { total: number; failed: number }>();
	const taken = new Set<string>();
	let challenge = false;
	let detectedAt: number | null = null;
	const out: Outcome = {
		botsReached: 0,
		takeovers: 0,
		legitBlocked: 0,
		legitFriction: 0,
		legitTotal: 0,
		detectedAt: null
	};
	for (const a of attempts) {
		const minute = Math.floor(a.t / 60);
		if (policy.detector && !challenge) {
			let total = 0;
			let failed = 0;
			for (let m = minute - 10; m < minute; m++) {
				const bucket = perMinute.get(m);
				total += bucket?.total ?? 0;
				failed += bucket?.failed ?? 0;
			}
			if (total > 200 && failed / total > 0.25) {
				challenge = true;
				detectedAt = a.t;
			}
		}
		if (!a.bot && a.correct) out.legitTotal++;
		const bucket = perMinute.get(minute) ?? { total: 0, failed: 0 };
		perMinute.set(minute, bucket);
		bucket.total++;
		const blocked =
			(ipLog !== null && !ipLog.allow(a.ip, a.t)) ||
			(emailLog !== null && !emailLog.allow(a.email, a.t));
		if (blocked) {
			bucket.failed++;
			if (!a.bot && a.correct) out.legitBlocked++;
			continue;
		}
		if (challenge && !a.knownDevice) {
			const solved = gate() < (a.bot ? BOT_SOLVE : 0.97);
			if (!a.bot && a.correct) out.legitFriction++;
			if (!solved) {
				bucket.failed++;
				if (!a.bot && a.correct) out.legitBlocked++;
				continue;
			}
		}
		if (a.bot) out.botsReached++;
		if (!a.correct) {
			bucket.failed++;
			continue;
		}
		if (policy.breachCheck && a.breached) {
			if (!a.bot) out.legitFriction++;
			continue;
		}
		if (policy.mfa && a.mfa) continue;
		if (a.bot) taken.add(a.email);
	}
	out.takeovers = taken.size;
	out.detectedAt = detectedAt;
	return out;
}

const vulnerable = new Set(attempts.filter((a) => a.bot && a.correct).map((a) => a.email)).size;
const perIp = ATTEMPTS / BOT_IPS / (ATTACK_MINUTES / 60);
heading(
	`অংশ ক — credential stuffing: ${n(ATTEMPTS)} চেষ্টা, ${n(BOT_IPS)} IP, ${ATTACK_MINUTES / 60} ঘণ্টা; সাথে ${n(LEGIT_LOGINS)} বৈধ login`
);
console.log(
	`প্রতি IP গড়ে ঘণ্টায় ${perIp.toFixed(1)} চেষ্টা, প্রতি email গড়ে ১বার; তালিকার ${n(vulnerable)}টা account এর password সত্যিই মেলে\n`
);
console.log(
	row([
		['নীতি', 34],
		['bot password পর্যন্ত', 20],
		['account দখল', 14],
		['বৈধ login আটকাল', 18],
		['বৈধ user এ ঝামেলা', 18],
		['ধরা পড়ল', 12]
	])
);
for (const policy of POLICIES) {
	const r = simulate(policy);
	console.log(
		row([
			[policy.name, 34],
			[n(r.botsReached), 20],
			[n(r.takeovers), 14],
			[`${n(r.legitBlocked)} (${pct(r.legitBlocked, r.legitTotal)})`, 18],
			[n(r.legitFriction), 18],
			[r.detectedAt === null ? '—' : `${Math.round((r.detectedAt - START) / 60)} মি`, 12]
		])
	);
}
console.log('\n(বৈধ user এ ঝামেলা = challenge দেখল, বা breached password এর জন্য reset করতে হলো)');

type Flood = {
	name: string;
	attack: number;
	legit: number;
	capacity: number;
	reaches: (attack: number) => number;
};
const share = (f: Flood): number => {
	const load = f.legit + f.reaches(f.attack);
	return Math.min(1, f.capacity / load);
};

heading(
	'অংশ খ — volumetric: ৩০০ Gbps UDP reflection, origin এর link ১০ Gbps, বৈধ traffic ০.৮ Gbps'
);
const volumetric: Flood[] = [
	{ name: 'origin সরাসরি internet এ', attack: 300, legit: 0.8, capacity: 10, reaches: (x) => x },
	{ name: 'origin এ app rate limit', attack: 300, legit: 0.8, capacity: 10, reaches: (x) => x },
	{
		name: 'anycast CDN/scrubbing এর পেছনে',
		attack: 300,
		legit: 0.8,
		capacity: 10,
		reaches: () => 0
	},
	{
		name: 'CDN, কিন্তু origin IP ফাঁস (পুরনো DNS)',
		attack: 300,
		legit: 0.8,
		capacity: 10,
		reaches: (x) => x
	},
	{
		name: 'ফাঁস IP + origin firewall এ CDN allowlist',
		attack: 300,
		legit: 0.8,
		capacity: 10,
		reaches: (x) => x
	},
	{
		name: 'নতুন origin IP, শুধু CDN এর tunnel দিয়ে',
		attack: 300,
		legit: 0.8,
		capacity: 10,
		reaches: () => 0
	}
];
console.log(
	row([
		['নকশা', 46],
		['link এ আসে', 14],
		['বৈধ traffic পৌঁছায়', 20]
	])
);
for (const f of volumetric)
	console.log(
		row([
			[f.name, 46],
			[`${(f.legit + f.reaches(f.attack)).toFixed(1)} Gbps`, 14],
			[pct(share(f), 1), 20]
		])
	);

heading(
	'অংশ গ — L7 flood: public share page /s/:token, ২০,০০০ IP × ৩ req/s, origin এর ক্ষমতা ২,০০০ req/s'
);
const ATTACK_RPS = 20_000 * 3;
const LEGIT_RPS = 400;
const l7: Flood[] = [
	{ name: 'কিছু নেই', attack: ATTACK_RPS, legit: LEGIT_RPS, capacity: 2_000, reaches: (x) => x },
	{
		name: 'per-IP ১০ req/s',
		attack: ATTACK_RPS,
		legit: LEGIT_RPS,
		capacity: 2_000,
		reaches: (x) => x
	},
	{
		name: 'CDN cache (৬০ s, ৩০০ PoP), attacker ৫টা আসল token',
		attack: ATTACK_RPS,
		legit: LEGIT_RPS * 0.2,
		capacity: 2_000,
		reaches: () => (5 * 300) / 60
	},
	{
		name: 'CDN cache, কিন্তু ?x=এলোমেলো দিয়ে cache ভাঙা',
		attack: ATTACK_RPS,
		legit: LEGIT_RPS * 0.2,
		capacity: 2_000,
		reaches: (x) => x
	},
	{
		name: 'cache key normalize (অজানা query বাদ)',
		attack: ATTACK_RPS,
		legit: LEGIT_RPS * 0.2,
		capacity: 2_000,
		reaches: () => (5 * 300) / 60
	},
	{
		name: 'edge এ challenge (bot ৫% পার), cache ছাড়া',
		attack: ATTACK_RPS,
		legit: LEGIT_RPS,
		capacity: 2_000,
		reaches: (x) => x * 0.05
	}
];
console.log(
	row([
		['নকশা', 46],
		['origin এ req/s', 16],
		['বৈধ request সফল', 18]
	])
);
for (const f of l7)
	console.log(
		row([
			[f.name, 46],
			[n(f.legit + f.reaches(f.attack)), 16],
			[pct(share(f), 1), 18]
		])
	);
console.log(
	'\n(সরল fluid model: origin ক্ষমতার বেশি পেলে সবাইকে সমান ভাগে ফেলে; আসল overload এ timeout আর retry এ ফল আরও খারাপ)'
);
