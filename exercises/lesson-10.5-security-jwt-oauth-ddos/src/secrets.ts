import { duration, heading, lognormal, mulberry32, n, padEnd, pct, percentile, row } from './util';

const LEAKS = Number(process.env.LEAKS ?? 1_000);
const DETECT_MEDIAN_DAYS = Number(process.env.DETECT_MEDIAN_DAYS ?? 20);
const ROTATE_DAYS = Number(process.env.ROTATE_DAYS ?? 90);
const LEASE_MINUTES = Number(process.env.LEASE_MINUTES ?? 60);
const PUSH_PROTECTION = Number(process.env.PUSH_PROTECTION ?? 0.8);
const SEED = Number(process.env.SEED ?? 1_005);

type Commit = { id: string; message: string; files: Record<string, string | null> };
type Rule = { name: string; test: (line: string) => string | null };
type Finding = { commit: string; file: string; rule: string; value: string };

const seeded = mulberry32(SEED);
const fake = (alphabet: string, length: number): string =>
	Array.from({ length }, () => alphabet[Math.floor(seeded() * alphabet.length)] ?? 'x').join('');
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';
const B64 = `${ALNUM}+/`;

const jwtSecret = fake(HEX, 64);
const stripeLive = `tfsk_live_${fake(ALNUM, 24)}`;
const stripeTest = `tfsk_test_${fake(ALNUM, 24)}`;
const dbPassword = fake(ALNUM, 20);
const integrity = `sha512-${fake(B64, 86)}==`;

const HISTORY: Commit[] = [
	{
		id: 'a1c3e09',
		message: 'init billing service',
		files: {
			'src/billing.ts':
				'const stripe = new Stripe(env.TF_STRIPE_KEY);\nconst db = new Sequelize(env.DATABASE_URL);',
			'.env.example':
				'TF_STRIPE_KEY=changeme\nTF_JWT_SIGNING_SECRET=changeme\nDATABASE_URL=postgres://user:pass@localhost:5432/taskflow'
		}
	},
	{
		id: '7f20b4d',
		message: 'wip: local test',
		files: {
			'.env': `TF_STRIPE_KEY=${stripeLive}\nTF_JWT_SIGNING_SECRET=${jwtSecret}\nDATABASE_URL=postgres://taskflow:${dbPassword}@db-primary.internal:5432/taskflow`
		}
	},
	{ id: '9e41d77', message: 'oops remove .env', files: { '.env': null } },
	{
		id: 'c08a5f2',
		message: 'add lockfile and fixtures',
		files: {
			'package-lock.json': `"integrity": "${integrity}"`,
			'test/fixtures.ts': `export const stripeKey = '${stripeTest}';\nexport const boardId = '3f2b8c1e-9d4a-4f7e-b2c1-8a9e0d6f5b3c';`
		}
	}
];

function entropy(value: string): number {
	const counts = new Map<string, number>();
	for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let bits = 0;
	for (const count of counts.values()) {
		const p = count / value.length;
		bits -= p * Math.log2(p);
	}
	return bits;
}

const RULES: Rule[] = [
	{
		name: 'tfsk key এর ধরন',
		test: (line) => /tfsk_(live|test)_[A-Za-z0-9]{24}/.exec(line)?.[0] ?? null
	},
	{
		name: 'URL এ password',
		test: (line) => {
			const match = /[a-z]+:\/\/[^:\s/]+:([^@\s]+)@/.exec(line);
			const password = match?.[1];
			return password && entropy(password) > 3 ? password : null;
		}
	},
	{
		name: 'SECRET/KEY = উচ্চ entropy',
		test: (line) => {
			const value = /(?:SECRET|TOKEN|PASSWORD|_KEY)[A-Z_]*\s*=\s*(\S{16,})/.exec(line)?.[1];
			return value && entropy(value) > 3.5 ? value : null;
		}
	},
	{
		name: 'যেকোনো লম্বা উচ্চ entropy string',
		test: (line) => {
			const value = /[A-Za-z0-9+/=_-]{40,}/.exec(line)?.[0];
			return value && entropy(value) > 4.5 ? value : null;
		}
	}
];

function scan(snapshots: [string, string, string][]): Finding[] {
	const findings: Finding[] = [];
	const seen = new Set<string>();
	for (const [commit, file, content] of snapshots)
		for (const line of content.split('\n'))
			for (const rule of RULES) {
				const value = rule.test(line);
				if (value === null) continue;
				if (!seen.has(value)) findings.push({ commit, file, rule: rule.name, value });
				seen.add(value);
				break;
			}
	return findings;
}

const head = new Map<string, [string, string]>();
const everything: [string, string, string][] = [];
for (const commit of HISTORY)
	for (const [file, content] of Object.entries(commit.files)) {
		if (content === null) head.delete(file);
		else {
			head.set(file, [commit.id, content]);
			everything.push([commit.id, file, content]);
		}
	}

const verdict = (value: string): string => {
	if (value === stripeLive) return 'আসল — live payment key';
	if (value === jwtSecret) return 'আসল — token sign করার secret';
	if (value === dbPassword) return 'আসল — production DB';
	if (value === stripeTest) return 'test key — কম ঝুঁকি, তবু সরাও';
	return 'false positive (lockfile hash)';
};

heading('অংশ ক — secret scanner: শুধু HEAD বনাম পুরো history');
const headFindings = scan(
	[...head.entries()].map(([file, [commit, content]]) => [commit, file, content])
);
const historyFindings = scan(everything);
console.log(`শুধু HEAD (আজকের code):    ${headFindings.length}টা finding`);
console.log(`পুরো git history:          ${historyFindings.length}টা finding\n`);
console.log(`${padEnd('commit', 10)}${padEnd('file', 20)}${padEnd('rule', 32)}মূল্যায়ন`);
for (const f of historyFindings)
	console.log(
		`${padEnd(f.commit, 10)}${padEnd(f.file, 20)}${padEnd(f.rule, 32)}${verdict(f.value)}`
	);
const real = historyFindings.filter((f) => verdict(f.value).startsWith('আসল')).length;
const headReal = headFindings.filter((f) => verdict(f.value).startsWith('আসল')).length;
console.log(
	`\nআসল production secret: history তে ${real}টা, HEAD এ ${headReal}টা — "oops remove .env" commit কিছুই মোছেনি`
);

type Leak = {
	channel: string;
	detectDays: number;
	rotationPhase: number;
	leaseLeft: number;
	blocked: boolean;
};
const CHANNELS: [string, number][] = [
	['git commit', 0.4],
	['log / trace', 0.25],
	['CI output', 0.15],
	['laptop / backup', 0.2]
];
const leakRandom = mulberry32(SEED + 3);
const leaks: Leak[] = Array.from({ length: LEAKS }, () => {
	let pick = leakRandom();
	let channel = CHANNELS[0]?.[0] ?? 'git commit';
	for (const [name, share] of CHANNELS) {
		if (pick < share) {
			channel = name;
			break;
		}
		pick -= share;
	}
	return {
		channel,
		detectDays: Math.min(365, lognormal(leakRandom, DETECT_MEDIAN_DAYS, 1.5)),
		rotationPhase: leakRandom() * ROTATE_DAYS,
		leaseLeft: (leakRandom() * LEASE_MINUTES) / 1_440,
		blocked: channel === 'git commit' && leakRandom() < PUSH_PROTECTION
	};
});

type Policy = { name: string; exposure: (leak: Leak) => number };
const POLICIES: Policy[] = [
	{ name: 'স্থির secret, কখনো বদলায় না', exposure: (l) => l.detectDays },
	{
		name: `প্রতি ${ROTATE_DAYS} দিনে rotate`,
		exposure: (l) => Math.min(l.detectDays, l.rotationPhase)
	},
	{
		name: `${ROTATE_DAYS} দিন + push protection`,
		exposure: (l) => (l.blocked ? 0 : Math.min(l.detectDays, l.rotationPhase))
	},
	{
		name: `dynamic credential (${LEASE_MINUTES} মি lease)`,
		exposure: (l) => Math.min(l.detectDays, l.leaseLeft)
	}
];

heading(
	`অংশ খ — ${n(LEAKS)}টা ফাঁস, ধরা পড়তে median ${DETECT_MEDIAN_DAYS} দিন (ধরে নেওয়া): ফাঁস হওয়া secret কতদিন কাজ করে`
);
console.log(
	row([
		['নীতি', 34],
		['কাজ করা ফাঁস', 14],
		['median', 12],
		['p90', 12],
		['> ৭ দিন', 10],
		['মোট attacker-দিন', 18]
	])
);
for (const policy of POLICIES) {
	const exposures = leaks.map(policy.exposure);
	const usable = exposures.filter((d) => d > 0);
	const sorted = [...usable].sort((a, b) => a - b);
	const total = usable.reduce((a, b) => a + b, 0);
	console.log(
		row([
			[policy.name, 34],
			[n(usable.length), 14],
			[duration(percentile(sorted, 50) * 1_440), 12],
			[duration(percentile(sorted, 90) * 1_440), 12],
			[pct(usable.filter((d) => d > 7).length, LEAKS), 10],
			[n(total), 18]
		])
	);
}

const SERVICES: Record<string, string[]> = {
	gateway: ['JWKS_URL', 'INTERNAL_SIGNING_KEY'],
	'web-bff': ['INTERNAL_SIGNING_KEY', 'SESSION_COOKIE_KEY'],
	monolith: ['DATABASE_URL', 'REDIS_URL', 'INTERNAL_SIGNING_KEY', 'S3_ACCESS'],
	billing: ['STRIPE_KEY', 'STRIPE_WEBHOOK_SECRET', 'BILLING_DB_URL', 'INTERNAL_SIGNING_KEY'],
	files: ['S3_ACCESS', 'INTERNAL_SIGNING_KEY'],
	worker: ['DATABASE_URL', 'REDIS_URL', 'EMAIL_API_KEY', 'S3_ACCESS']
};
const allSecrets = new Set(Object.values(SERVICES).flat());

heading('অংশ গ — একটা service এর ভেতরে কেউ ঢুকলে কয়টা secret তার হাতে');
console.log(
	row([
		['ঢুকেছে', 12],
		['একটা ভাগ করা .env', 22],
		['service ধরে আলাদা', 22],
		['যা হাতে গেল', 44]
	])
);
for (const [service, scoped] of Object.entries(SERVICES))
	console.log(
		row([
			[service, 12],
			[allSecrets.size, 22],
			[scoped.length, 22],
			[
				scoped.includes('STRIPE_KEY')
					? 'STRIPE_KEY সহ'
					: scoped.includes('DATABASE_URL')
						? 'DATABASE_URL সহ'
						: 'payment/DB না',
				44
			]
		])
	);
