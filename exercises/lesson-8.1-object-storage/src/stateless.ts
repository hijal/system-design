import express, { type NextFunction, type Request, type Response } from 'express';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { checkServices, emptyBucket, env, getObject, pgPool, putObject } from './storage';
import { mulberry32 } from './random';

// Lesson 8.1 §1.3 - what happens if attachments are kept on the app server's own disk?
//
// Two Express instances (A and B) behind a load balancer - 6 in the real TaskFlow (Module 3). The same
// route, only the place files are kept differs:
//   local  - each instance in a folder on its own disk (data/instance-a, data/instance-b)
//   object - both in the same bucket
// The load balancer two ways: round robin, and sticky (the same instance per user - Lesson 3.4).
//
// USERS users, each uploads FILES_PER_USER files; then (1) the uploader opens them again,
// (2) a teammate opens them, (3) instance A is replaced (deploy/scale-in - a new container, an empty disk), and they are opened again.
// Seeded - exactly the same numbers every time.

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
	replaceInstance(): Promise<void>; // what happens to its own storage when an instance is replaced
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
		// a new container's disk is empty - the disk went with the old one
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
		// the new instance talks to the same bucket - nothing to lose
	}
}

const idSchema = z.string().regex(/^[a-z0-9-]+$/);

// Express 4 doesn't catch an async handler's rejection itself - catch it and pass it to next(), otherwise the process crashes
type Handler<P> = (req: Request<P>, res: Response) => Promise<void>;
const handle =
	<P>(fn: Handler<P>) =>
	(req: Request<P>, res: Response, next: NextFunction): void => {
		fn(req, res).catch(next);
	};

// a seeded shuffle - many users at once, so the requests don't arrive grouped by user
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

// one TaskFlow API instance - only the two attachment routes
function startInstance(store: AttachmentStore): Promise<{ url: string; server: Server }> {
	const app = express();
	app.put(
		'/attachments/:id',
		express.raw({ type: '*/*', limit: '20mb' }),
		handle<{ id: string }>(async (req, res) => {
			const id = idSchema.parse(req.params.id);
			// express.raw's body is a Buffer, but unknown in the type - validate it
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
			const { port } = server.address() as AddressInfo; // after listen(0), address() is always an AddressInfo
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
	for (const s of stores) await s.replaceInstance(); // a clean start
	const instances = await Promise.all(stores.map(startInstance));

	// Load balancer: which request goes to which instance. Sticky = from a hash of the user's id (like an instance
	// written in a cookie) - the same user always on the same instance
	let turn = 0;
	const pick = (userId: number): string => {
		const hash = Math.imul(userId + 1, 2654435761) >>> 0;
		const index = balancer === 'sticky' ? hash % instances.length : turn++ % instances.length;
		return instances[index]?.url ?? '';
	};

	const random = mulberry32(cfg.SEED);
	const planned = Array.from({ length: cfg.USERS * cfg.FILES_PER_USER }, (_, i) => {
		const owner = Math.floor(i / cfg.FILES_PER_USER);
		// teammate: anyone other than the owner - their own sticky instance may be different
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

	await stores[0]?.replaceInstance(); // instance A replaced: a deploy, a crash, or an autoscaling scale-in
	const lost = await missing('owner');

	await Promise.all(instances.map((i) => new Promise((resolve) => i.server.close(resolve))));
	await rm(dataDir, { recursive: true, force: true }); // clean up the local disk folders
	return { name, ownMiss, teamMiss, lost, total: planned.length };
}

async function main(): Promise<void> {
	const pool = pgPool(1);
	await checkServices(pool); // make sure the S3 bucket exists
	await pool.end();
	await emptyBucket(env.BUCKET);

	const rows = [
		await run('local disk, round robin', 'local', 'round-robin'),
		await run('local disk, sticky (per user)', 'local', 'sticky'),
		await run('object storage, round robin', 'object', 'round-robin')
	];
	const pct = (n: number, total: number): string => `${Math.round((100 * n) / total)}%`;
	console.log(
		`\n   2 instances · ${cfg.USERS} users × ${cfg.FILES_PER_USER} files = ${rows[0]?.total ?? 0} uploads\n`
	);
	console.log(
		'   where files live · load balancer   own reopen 404    teammate open 404     lost after replacing A'
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
