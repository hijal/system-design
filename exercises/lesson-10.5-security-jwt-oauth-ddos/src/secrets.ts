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
		name: 'tfsk key pattern',
		test: (line) => /tfsk_(live|test)_[A-Za-z0-9]{24}/.exec(line)?.[0] ?? null
	},
	{
		name: 'password in a URL',
		test: (line) => {
			const match = /[a-z]+:\/\/[^:\s/]+:([^@\s]+)@/.exec(line);
			const password = match?.[1];
			return password && entropy(password) > 3 ? password : null;
		}
	},
	{
		name: 'SECRET/KEY = high entropy',
		test: (line) => {
			const value = /(?:SECRET|TOKEN|PASSWORD|_KEY)[A-Z_]*\s*=\s*(\S{16,})/.exec(line)?.[1];
			return value && entropy(value) > 3.5 ? value : null;
		}
	},
	{
		name: 'any long high-entropy string',
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
	if (value === stripeLive) return 'real - live payment key';
	if (value === jwtSecret) return 'real - the token signing secret';
	if (value === dbPassword) return 'real - production DB';
	if (value === stripeTest) return 'test key - low risk, remove it anyway';
	return 'false positive (lockfile hash)';
};

heading('Part A - secret scanner: HEAD only vs the whole history');
const headFindings = scan(
	[...head.entries()].map(([file, [commit, content]]) => [commit, file, content])
);
const historyFindings = scan(everything);
console.log(`HEAD only (today's code):  ${headFindings.length} findings`);
console.log(`whole git history:         ${historyFindings.length} findings\n`);
console.log(`${padEnd('commit', 10)}${padEnd('file', 20)}${padEnd('rule', 32)}verdict`);
for (const f of historyFindings)
	console.log(
		`${padEnd(f.commit, 10)}${padEnd(f.file, 20)}${padEnd(f.rule, 32)}${verdict(f.value)}`
	);
const real = historyFindings.filter((f) => verdict(f.value).startsWith('real')).length;
const headReal = headFindings.filter((f) => verdict(f.value).startsWith('real')).length;
console.log(
	`\nreal production secrets: ${real} in history, ${headReal} at HEAD - the "oops remove .env" commit deleted nothing`
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
	{ name: 'static secret, never changes', exposure: (l) => l.detectDays },
	{
		name: `rotate every ${ROTATE_DAYS} days`,
		exposure: (l) => Math.min(l.detectDays, l.rotationPhase)
	},
	{
		name: `${ROTATE_DAYS} days + push protection`,
		exposure: (l) => (l.blocked ? 0 : Math.min(l.detectDays, l.rotationPhase))
	},
	{
		name: `dynamic credential (${LEASE_MINUTES} min lease)`,
		exposure: (l) => Math.min(l.detectDays, l.leaseLeft)
	}
];

heading(
	`Part B - ${n(LEAKS)} leaks, median ${DETECT_MEDIAN_DAYS} days to detect (assumed): how long a leaked secret keeps working`
);
console.log(
	row([
		['policy', 34],
		['working leaks', 15],
		['median', 12],
		['p90', 12],
		['> 7 days', 10],
		['total attacker-days', 21]
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
			[n(usable.length), 15],
			[duration(percentile(sorted, 50) * 1_440), 12],
			[duration(percentile(sorted, 90) * 1_440), 12],
			[pct(usable.filter((d) => d > 7).length, LEAKS), 10],
			[n(total), 21]
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

heading('Part C - how many secrets someone holds after getting inside one service');
console.log(
	row([
		['got into', 12],
		['one shared .env', 22],
		['separate per service', 23],
		['what they got', 44]
	])
);
for (const [service, scoped] of Object.entries(SERVICES))
	console.log(
		row([
			[service, 12],
			[allSecrets.size, 22],
			[scoped.length, 23],
			[
				scoped.includes('STRIPE_KEY')
					? 'incl. STRIPE_KEY'
					: scoped.includes('DATABASE_URL')
						? 'incl. DATABASE_URL'
						: 'no payment/DB',
				44
			]
		])
	);
