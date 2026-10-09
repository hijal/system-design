import { z } from 'zod';
import { mulberry32 } from './random';

// Lesson 8.1 §1.5 - how an object survives: replication vs erasure coding, and failure domains.
// No Docker needed - a small model and a seeded simulation.
//
//   part A: arithmetic - for each scheme, how much disk storing 1 TB of data takes, how many dead disks it survives, and the
//          annual probability of losing an object (a simple model: disks die independently, repair takes a fixed time)
//   part B: OBJECTS objects on RACKS racks × DISKS_PER_RACK disks; when a whole rack (or several) goes down,
//          how many objects can no longer be read - with fragments on random disks, and with each on a different rack

const cfg = z
	.object({
		AFR: z.coerce.number().positive().max(1).default(0.02), // annual failure rate: the share of disks that die in a year
		REPAIR_HOURS: z.coerce.number().positive().default(24), // how long rebuilding a dead disk's data on other disks takes
		RACKS: z.coerce.number().int().positive().default(10),
		DISKS_PER_RACK: z.coerce.number().int().positive().default(12),
		OBJECTS: z.coerce.number().int().positive().default(100_000),
		SEED: z.coerce.number().int().default(7)
	})
	.parse(process.env);

// k data fragments + m parity; the whole object can be rebuilt from any k of them.
// Replication with r copies = k 1, m r−1 (any one copy is enough).
type Scheme = { name: string; k: number; m: number };
const schemes: Scheme[] = [
	{ name: '1 copy', k: 1, m: 0 },
	{ name: '2 copies', k: 1, m: 1 },
	{ name: '3 copies', k: 1, m: 2 },
	{ name: 'EC 4+2', k: 4, m: 2 },
	{ name: 'EC 6+3', k: 6, m: 3 },
	{ name: 'EC 10+4', k: 10, m: 4 }
];

function choose(n: number, r: number): number {
	let result = 1;
	for (let i = 1; i <= r; i++) result = (result * (n - r + i)) / i;
	return result;
}

// the annual probability of losing an object (approximate):
//   any one of its n disks dies (n × AFR times a year) - and before the repair finishes at least m of the
//   other n−1 die (each with probability q = AFR × repair time / one year)
function annualLoss(s: Scheme): number {
	const n = s.k + s.m;
	const q = (cfg.AFR * cfg.REPAIR_HOURS) / (365 * 24);
	let more = 0;
	for (let j = s.m; j <= n - 1; j++) more += choose(n - 1, j) * q ** j * (1 - q) ** (n - 1 - j);
	return n * cfg.AFR * more;
}

function partA(): void {
	console.log(
		`\n── A. Calculation (AFR ${(cfg.AFR * 100).toFixed(0)}%, ${cfg.REPAIR_HOURS} hours to repair, disks die independently) ──`
	);
	console.log(
		'   scheme          disk for 1 TB   survives     annual loss chance   durability        lost/yr of 1B objects'
	);
	for (const s of schemes) {
		const p = annualLoss(s);
		const nines = -Math.log10(p);
		const lost = p * 1e9;
		console.log(
			`   ${s.name.padEnd(10)} ${`${((s.k + s.m) / s.k).toFixed(2)} TB`.padStart(18)} ${`${s.m} disk${s.m === 1 ? '' : 's'}`.padStart(10)} ${p.toExponential(1).padStart(22)} ${`${nines.toFixed(1)} nines`.padStart(12)} ${(lost >= 1 ? lost.toFixed(0) : lost.toPrecision(1)).padStart(28)}`
		);
	}
}

type Placement = 'random' | 'rack-aware';

// which rack each of an object's n fragments is on
function place(s: Scheme, placement: Placement, random: () => number): number[] {
	const n = s.k + s.m;
	if (placement === 'rack-aware') {
		// n different racks (the first n of a Fisher–Yates shuffle)
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
	// n different disks, on any rack - without thinking about racks
	const disks = new Set<number>();
	while (disks.size < n) disks.add(Math.floor(random() * cfg.RACKS * cfg.DISKS_PER_RACK));
	return [...disks].map((d) => Math.floor(d / cfg.DISKS_PER_RACK));
}

function partB(): void {
	const down = [1, 2, 3];
	console.log(
		`\n── B. Failure domain (${cfg.RACKS} racks × ${cfg.DISKS_PER_RACK} disks, ${cfg.OBJECTS.toLocaleString('en')} objects) ──`
	);
	console.log(
		`   ${'scheme · where the fragments are'.padEnd(36)} ${'unreadable when down:'.padEnd(19)}${down.map((d) => `${d} rack${d === 1 ? '' : 's'}`.padStart(9)).join('')}`
	);
	for (const s of schemes.filter((x) => x.name === '3 copies' || x.name === 'EC 6+3')) {
		for (const placement of ['random', 'rack-aware'] as const) {
			if (placement === 'rack-aware' && s.k + s.m > cfg.RACKS) continue;
			const random = mulberry32(cfg.SEED);
			const objects = Array.from({ length: cfg.OBJECTS }, () => place(s, placement, random));
			const counts = down.map((d) => {
				// the first d racks down (power, a switch, fire)
				let unreadable = 0;
				for (const racks of objects) {
					const lostFragments = racks.filter((r) => r < d).length;
					if (lostFragments > s.m) unreadable++;
				}
				return unreadable;
			});
			const label = `${s.name} · ${placement === 'random' ? 'random disks' : 'each on a different rack'}`;
			console.log(
				`   ${label.padEnd(36)} ${''.padStart(19)}${counts.map((c) => c.toLocaleString('en').padStart(9)).join('')}`
			);
		}
	}
	console.log();
}

partA();
partB();
