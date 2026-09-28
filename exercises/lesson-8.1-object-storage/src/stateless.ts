import express, { type NextFunction, type Request, type Response } from 'express';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { checkServices, emptyBucket, env, getObject, pgPool, putObject } from './storage';
import { mulberry32 } from './random';

// Lesson 8.1 §১.৩ — attachment app server এর নিজের disk এ রাখলে কী হয়?
//
// দুটো Express instance (A আর B) একটা load balancer এর পেছনে — আসল TaskFlow এ ৬টা (Module 3)। একই
// route, শুধু file রাখার জায়গা আলাদা:
//   local  — প্রতিটা instance নিজের disk এর folder এ (data/instance-a, data/instance-b)
//   object — দুজনেই একই bucket এ
// Load balancer দুইভাবে: round robin, আর sticky (user ধরে একই instance — Lesson 3.4)।
//
// USERS জন user, প্রত্যেকে FILES_PER_USER টা file upload করে; তারপর (১) uploader নিজে আবার খোলে,
// (২) একজন teammate খোলে, (৩) instance A বদলানো হয় (deploy/scale-in — নতুন container, খালি disk), আবার খোলা।
// Seed দেওয়া — প্রতিবার হুবহু একই সংখ্যা।

const cfg = z
	.object({
		USERS: z.coerce.number().int().positive().default(20),
		FILES_PER_USER: z.coerce.number().int().positive().default(10),
		SEED: z.coerce.number().int().default(7)
	})
	.parse(process.env);

interface AttachmentStore {
	put(id: string, body: Buffer): Promise<void>;
	get(id: string): Promise<Buffer | null>;
	replaceInstance(): Promise<void>; // instance বদলালে তার নিজের storage এর কী হয়
}

class LocalDiskStore implements AttachmentStore {
	constructor(private readonly dir: string) {}
	async put(id: string, body: Buffer): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		await writeFile(path.join(this.dir, id), body);
	}
	async get(id: string): Promise<Buffer | null> {
		try {
			return await readFile(path.join(this.dir, id));
		} catch (error: unknown) {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
			throw error;
		}
	}
	async replaceInstance(): Promise<void> {
		// নতুন container এর disk খালি — পুরনোটার সাথে disk ও গেছে
		await rm(this.dir, { recursive: true, force: true });
	}
}

class ObjectStore implements AttachmentStore {
	async put(id: string, body: Buffer): Promise<void> {
		await putObject(env.BUCKET, `stateless/${id}`, body);
	}
	async get(id: string): Promise<Buffer | null> {
		return getObject(env.BUCKET, `stateless/${id}`);
	}
	async replaceInstance(): Promise<void> {
		// নতুন instance একই bucket এ কথা বলে — হারানোর কিছু নেই
	}
}

const idSchema = z.string().regex(/^[a-z0-9-]+$/);

// Express 4 async handler এর rejection নিজে ধরে না — ধরে next() এ দেওয়া, নইলে process crash
type Handler<P> = (req: Request<P>, res: Response) => Promise<void>;
const handle =
	<P>(fn: Handler<P>) =>
	(req: Request<P>, res: Response, next: NextFunction): void => {
		fn(req, res).catch(next);
	};

// seed দেওয়া shuffle — অনেক user একসাথে, তাই request গুলো ব্যবহারকারী ধরে সাজানো ক্রমে আসে না
function shuffled<T>(items: T[], random: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		const a = out[i];
		const b = out[j];
		if (a === undefined || b === undefined) continue;
		out[i] = b;
		out[j] = a;
	}
	return out;
}

// একটা TaskFlow API instance — শুধু attachment এর দুটো route
function startInstance(store: AttachmentStore): Promise<{ url: string; server: Server }> {
	const app = express();
	app.put(
		'/attachments/:id',
		express.raw({ type: '*/*', limit: '20mb' }),
		handle<{ id: string }>(async (req, res) => {
			const id = idSchema.parse(req.params.id);
			// express.raw এর body Buffer, কিন্তু type এ unknown — যাচাই করে নেওয়া
			const body = z.instanceof(Buffer).parse(req.body);
			await store.put(id, body);
			res.status(201).json({ id });
		})
	);
	app.get(
		'/attachments/:id',
		handle<{ id: string }>(async (req, res) => {
			const data = await store.get(idSchema.parse(req.params.id));
			if (!data) {
				res.status(404).json({ error: 'NOT_FOUND' });
				return;
			}
			res.type('application/octet-stream').send(data);
		})
	);
	return new Promise((resolve) => {
		const server = app.listen(0, () => {
			const { port } = server.address() as AddressInfo; // listen(0) এর পরে address() সবসময় AddressInfo
			resolve({ url: `http://127.0.0.1:${port}`, server });
		});
	});
}

type Balancer = 'round-robin' | 'sticky';
type Row = { name: string; ownMiss: number; teamMiss: number; lost: number; total: number };

async function run(name: string, kind: 'local' | 'object', balancer: Balancer): Promise<Row> {
	const dataDir = path.join(__dirname, '..', 'data');
	const stores: AttachmentStore[] =
		kind === 'local'
			? [
					new LocalDiskStore(path.join(dataDir, 'instance-a')),
					new LocalDiskStore(path.join(dataDir, 'instance-b'))
				]
			: [new ObjectStore(), new ObjectStore()];
	for (const s of stores) await s.replaceInstance(); // পরিষ্কার শুরু
	const instances = await Promise.all(stores.map(startInstance));

	// Load balancer: কোন request কোন instance এ। Sticky = user এর id এর hash থেকে (cookie তে লেখা
	// instance এর মতো) — একই user সবসময় একই instance এ
	let turn = 0;
	const pick = (userId: number): string => {
		const hash = Math.imul(userId + 1, 2654435761) >>> 0;
		const index = balancer === 'sticky' ? hash % instances.length : turn++ % instances.length;
		return instances[index]?.url ?? '';
	};

	const random = mulberry32(cfg.SEED);
	const planned = Array.from({ length: cfg.USERS * cfg.FILES_PER_USER }, (_, i) => {
		const owner = Math.floor(i / cfg.FILES_PER_USER);
		// teammate: owner ছাড়া অন্য যেকোনো একজন — তার নিজের sticky instance আলাদা হতে পারে
		const teammate = (owner + 1 + Math.floor(random() * (cfg.USERS - 1))) % cfg.USERS;
		return {
			id: `u${owner}-f${i % cfg.FILES_PER_USER}`,
			owner,
			teammate,
			size: 10_000 + Math.floor(random() * 90_000)
		};
	});
	for (const u of shuffled(planned, random)) {
		const body = Buffer.alloc(u.size, u.owner);
		const res = await fetch(`${pick(u.owner)}/attachments/${u.id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/octet-stream' },
			body
		});
		if (res.status !== 201) throw new Error(`upload failed ${res.status}`);
	}

	const missing = async (viewer: 'owner' | 'teammate'): Promise<number> => {
		let miss = 0;
		for (const u of shuffled(planned, random)) {
			const res = await fetch(
				`${pick(viewer === 'owner' ? u.owner : u.teammate)}/attachments/${u.id}`
			);
			await res.arrayBuffer();
			if (res.status === 404) miss++;
		}
		return miss;
	};
	const ownMiss = await missing('owner');
	const teamMiss = await missing('teammate');

	await stores[0]?.replaceInstance(); // instance A বদলাল: deploy, crash, বা autoscaling এর scale-in
	const lost = await missing('owner');

	await Promise.all(instances.map((i) => new Promise((resolve) => i.server.close(resolve))));
	await rm(dataDir, { recursive: true, force: true }); // local disk এর folder গুলো পরিষ্কার
	return { name, ownMiss, teamMiss, lost, total: planned.length };
}

async function main(): Promise<void> {
	const pool = pgPool(1);
	await checkServices(pool); // S3 এর bucket নিশ্চিত করা
	await pool.end();
	await emptyBucket(env.BUCKET);

	const rows = [
		await run('local disk, round robin', 'local', 'round-robin'),
		await run('local disk, sticky (user ধরে)', 'local', 'sticky'),
		await run('object storage, round robin', 'object', 'round-robin')
	];
	const pct = (n: number, total: number): string => `${Math.round((100 * n) / total)}%`;
	console.log(
		`\n   ২টা instance · ${cfg.USERS} জন user × ${cfg.FILES_PER_USER} টা file = ${rows[0]?.total ?? 0} টা upload\n`
	);
	console.log(
		'   file কোথায় · load balancer          নিজে আবার খুলল: 404   teammate খুলল: 404   instance A বদলানোর পরে: নেই'
	);
	for (const r of rows) {
		console.log(
			`   ${r.name.padEnd(34)} ${pct(r.ownMiss, r.total).padStart(14)} ${pct(r.teamMiss, r.total).padStart(20)} ${`${r.lost} / ${r.total}`.padStart(26)}`
		);
	}
	console.log();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
