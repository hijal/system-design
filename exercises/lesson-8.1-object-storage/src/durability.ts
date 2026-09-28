import { z } from 'zod';
import { mulberry32 } from './random';

// Lesson 8.1 §১.৫ — একটা object কীভাবে টিকে থাকে: replication বনাম erasure coding, আর failure domain।
// Docker লাগে না — একটা ছোট model আর একটা seed দেওয়া simulation।
//
//   অংশ ক: হিসাব — প্রতিটা পদ্ধতিতে ১ TB data রাখতে কত disk লাগে, কয়টা disk মরা সহ্য করে, আর বছরে
//          একটা object হারানোর সম্ভাবনা (একটা সরল model: disk গুলো স্বাধীনভাবে মরে, মেরামতে নির্দিষ্ট সময়)
//   অংশ খ: RACKS টা rack × DISKS_PER_RACK টা disk এ OBJECTS টা object; পুরো একটা (বা কয়েকটা) rack বন্ধ হলে
//          কয়টা object আর পড়া যায় না — fragment এলোমেলো disk এ বসালে, আর প্রতিটা আলাদা rack এ বসালে

const cfg = z
	.object({
		AFR: z.coerce.number().positive().max(1).default(0.02), // annual failure rate: বছরে কত ভাগ disk মরে
		REPAIR_HOURS: z.coerce.number().positive().default(24), // মরা disk এর data অন্য disk এ আবার বানাতে কত সময়
		RACKS: z.coerce.number().int().positive().default(10),
		DISKS_PER_RACK: z.coerce.number().int().positive().default(12),
		OBJECTS: z.coerce.number().int().positive().default(100_000),
		SEED: z.coerce.number().int().default(7)
	})
	.parse(process.env);

// k টা data fragment + m টা parity; যেকোনো k টা থেকে পুরো object আবার বানানো যায়।
// Replication r কপি = k 1, m r−1 (যেকোনো একটা কপিই যথেষ্ট)।
type Scheme = { name: string; k: number; m: number };
const schemes: Scheme[] = [
	{ name: '১ কপি', k: 1, m: 0 },
	{ name: '২ কপি', k: 1, m: 1 },
	{ name: '৩ কপি', k: 1, m: 2 },
	{ name: 'EC 4+2', k: 4, m: 2 },
	{ name: 'EC 6+3', k: 6, m: 3 },
	{ name: 'EC 10+4', k: 10, m: 4 }
];

function choose(n: number, r: number): number {
	let result = 1;
	for (let i = 1; i <= r; i++) result = (result * (n - r + i)) / i;
	return result;
}

// বছরে একটা object হারানোর সম্ভাবনা (আনুমানিক):
//   তার n টা disk এর যেকোনো একটা মরে (বছরে n × AFR বার) — আর মেরামত শেষ হওয়ার আগে বাকি n−1 টার
//   অন্তত m টা মরে (প্রতিটার সম্ভাবনা q = AFR × মেরামতের সময় / এক বছর)
function annualLoss(s: Scheme): number {
	const n = s.k + s.m;
	const q = (cfg.AFR * cfg.REPAIR_HOURS) / (365 * 24);
	let more = 0;
	for (let j = s.m; j <= n - 1; j++) more += choose(n - 1, j) * q ** j * (1 - q) ** (n - 1 - j);
	return n * cfg.AFR * more;
}

function partA(): void {
	console.log(
		`\n── ক. হিসাব (AFR ${(cfg.AFR * 100).toFixed(0)}%, মেরামতে ${cfg.REPAIR_HOURS} ঘণ্টা, disk গুলো স্বাধীনভাবে মরে) ──`
	);
	console.log(
		'   পদ্ধতি       ১ TB রাখতে disk এ   সহ্য করে   বছরে হারানোর সম্ভাবনা   durability   ১০০ কোটি object এ বছরে হারায়'
	);
	for (const s of schemes) {
		const p = annualLoss(s);
		const nines = -Math.log10(p);
		const lost = p * 1e9;
		console.log(
			`   ${s.name.padEnd(10)} ${`${((s.k + s.m) / s.k).toFixed(2)} TB`.padStart(18)} ${`${s.m} টা disk`.padStart(10)} ${p.toExponential(1).padStart(22)} ${`${nines.toFixed(1)} nines`.padStart(12)} ${(lost >= 1 ? lost.toFixed(0) : lost.toPrecision(1)).padStart(28)}`
		);
	}
}

type Placement = 'random' | 'rack-aware';

// প্রতিটা object এর n টা fragment কোন rack এ
function place(s: Scheme, placement: Placement, random: () => number): number[] {
	const n = s.k + s.m;
	if (placement === 'rack-aware') {
		// n টা আলাদা rack (Fisher–Yates এর প্রথম n টা)
		const racks = Array.from({ length: cfg.RACKS }, (_, i) => i);
		for (let i = 0; i < n; i++) {
			const j = i + Math.floor(random() * (cfg.RACKS - i));
			const a = racks[i];
			const b = racks[j];
			if (a === undefined || b === undefined) continue;
			racks[i] = b;
			racks[j] = a;
		}
		return racks.slice(0, n);
	}
	// n টা আলাদা disk, যেকোনো rack এ — rack এর কথা না ভেবে
	const disks = new Set<number>();
	while (disks.size < n) disks.add(Math.floor(random() * cfg.RACKS * cfg.DISKS_PER_RACK));
	return [...disks].map((d) => Math.floor(d / cfg.DISKS_PER_RACK));
}

function partB(): void {
	const down = [1, 2, 3];
	console.log(
		`\n── খ. Failure domain (${cfg.RACKS} টা rack × ${cfg.DISKS_PER_RACK} টা disk, ${cfg.OBJECTS.toLocaleString('en')} টা object) ──`
	);
	console.log(
		`   পদ্ধতি · fragment কোথায়             পড়া যায় না যখন বন্ধ: ${down.map((d) => `${d} rack`.padStart(9)).join('')}`
	);
	for (const s of schemes.filter((x) => x.name === '৩ কপি' || x.name === 'EC 6+3')) {
		for (const placement of ['random', 'rack-aware'] as const) {
			if (placement === 'rack-aware' && s.k + s.m > cfg.RACKS) continue;
			const random = mulberry32(cfg.SEED);
			const objects = Array.from({ length: cfg.OBJECTS }, () => place(s, placement, random));
			const counts = down.map((d) => {
				// প্রথম d টা rack বন্ধ (power, switch, আগুন)
				let unreadable = 0;
				for (const racks of objects) {
					const lostFragments = racks.filter((r) => r < d).length;
					if (lostFragments > s.m) unreadable++;
				}
				return unreadable;
			});
			const label = `${s.name} · ${placement === 'random' ? 'এলোমেলো disk' : 'প্রতিটা আলাদা rack'}`;
			console.log(
				`   ${label.padEnd(36)} ${''.padStart(19)}${counts.map((c) => c.toLocaleString('en').padStart(9)).join('')}`
			);
		}
	}
	console.log();
}

partA();
partB();
