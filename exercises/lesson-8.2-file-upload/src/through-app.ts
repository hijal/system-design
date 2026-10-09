import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { messageSchema } from './app';
import { emptyBucket, mb, ms, percentile, prepareBucket, sendPut } from './common';

// Lesson 8.2 §1.1 - what happens to the app when uploads go through it?
//
// UPLOADERS users at once, each sends ROUNDS files of FILE_MB, at CLIENT_MBPS per second (like good
// broadband). At the same time PINGERS keep calling a cheap route, like the board. Four steps:
//   ping only (for comparison) · buffer (8.1's path) · stream · presigned (the app only hands out a URL)
// The app is a separate process - its memory, event loop delay, and the number of uploads open at once are measured.

const cfg = z
	.object({
		UPLOADERS: z.coerce.number().int().positive().default(8),
		ROUNDS: z.coerce.number().int().positive().default(2),
		FILE_MB: z.coerce.number().positive().default(64),
		CLIENT_MBPS: z.coerce.number().nonnegative().default(16),
		PINGERS: z.coerce.number().int().positive().default(4)
	})
	.parse(process.env);

type Mode = 'none' | 'buffer' | 'stream' | 'presigned';
type Stats = Extract<z.infer<typeof messageSchema>, { type: 'stats' }>;
type Row = { name: string; stats: Stats; ping: number[]; uploadMs: number };

function startApp(): Promise<{ child: ChildProcess; url: string }> {
	const child = fork(path.join(__dirname, 'app.js'));
	return new Promise((resolve) => {
		child.once('message', (raw: unknown) => {
			const msg = messageSchema.parse(raw);
			if (msg.type === 'ready') resolve({ child, url: `http://127.0.0.1:${msg.port}` });
		});
	});
}

function stats(child: ChildProcess): Promise<Stats> {
	return new Promise((resolve) => {
		child.once('message', (raw: unknown) => {
			const msg = messageSchema.parse(raw);
			if (msg.type === 'stats') resolve(msg);
		});
		child.send('stats');
	});
}

async function run(name: string, mode: Mode, body: Buffer): Promise<Row> {
	const { child, url } = await startApp();
	let running = true;
	const ping: number[] = [];
	const pinger = async (): Promise<void> => {
		while (running) {
			const t = performance.now();
			const res = await fetch(`${url}/api/ping`);
			await res.json();
			ping.push(performance.now() - t);
		}
	};
	const pingers = Array.from({ length: cfg.PINGERS }, pinger);

	const start = performance.now();
	const uploader = async (user: number): Promise<void> => {
		for (let round = 0; round < cfg.ROUNDS; round++) {
			const id = `u${user}-r${round}`;
			if (mode === 'buffer' || mode === 'stream') {
				const r = await sendPut(`${url}/upload/${mode}/${id}`, body, {
					mbps: cfg.CLIENT_MBPS,
					headers: { 'content-type': 'application/octet-stream' }
				});
				if (r.kind !== 'done' || r.status !== 201)
					throw new Error(`upload failed: ${JSON.stringify(r)}`);
			} else if (mode === 'presigned') {
				// 1. ask the app: "I want to store a file of this size and this type"
				const res = await fetch(`${url}/uploads`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ size: body.length, contentType: 'application/pdf' })
				});
				const { url: signed } = z.object({ url: z.string().url() }).parse(await res.json());
				// 2. straight to object storage - the app is out of it
				const r = await sendPut(signed, body, {
					mbps: cfg.CLIENT_MBPS,
					headers: { 'content-type': 'application/pdf' }
				});
				if (r.kind !== 'done' || r.status !== 200)
					throw new Error(`upload failed: ${JSON.stringify(r)}`);
			}
		}
	};
	try {
		if (mode === 'none') await new Promise((resolve) => setTimeout(resolve, 3000));
		else await Promise.all(Array.from({ length: cfg.UPLOADERS }, (_, i) => uploader(i)));
		const uploadMs = performance.now() - start;
		running = false;
		await Promise.all(pingers);
		return { name, stats: await stats(child), ping, uploadMs };
	} finally {
		running = false;
		child.kill(); // so the app process doesn't linger even on failure
	}
}

async function main(): Promise<void> {
	await prepareBucket();
	await emptyBucket();
	const body = randomBytes(Math.round(cfg.FILE_MB * 1024 * 1024));
	const total = cfg.UPLOADERS * cfg.ROUNDS * body.length;
	console.log(
		`\n   ${cfg.UPLOADERS} users × ${cfg.ROUNDS} files × ${mb(body.length)}, each at ${cfg.CLIENT_MBPS} MB/s (${mb(total)} in total) · ${cfg.PINGERS} pinging nonstop\n`
	);
	const rows = [
		await run('ping only', 'none', body),
		await run('buffer (whole file in memory)', 'buffer', body),
		await run('stream (flows through the app)', 'stream', body),
		await run('presigned (straight to object storage)', 'presigned', body)
	];
	console.log(
		'   path                                      app memory start→peak     uploads open at once    through the app   ping p50 / p99          event loop p99 / max   uploads done'
	);
	for (const r of rows) {
		const s = r.stats;
		console.log(
			`   ${r.name.padEnd(40)} ${`${s.baseRssMb.toFixed(0)} → ${s.peakRssMb.toFixed(0)} MB`.padStart(22)} ${String(s.maxOpenUploads).padStart(24)} ${mb(s.bytesThroughApp).padStart(18)}   ${`${ms(percentile(r.ping, 50))} / ${ms(percentile(r.ping, 99))}`.padEnd(19)} ${`${ms(s.loopDelayP99)} / ${ms(s.loopDelayMax)}`.padStart(24)} ${(r.name === 'ping only' ? '-' : ms(r.uploadMs)).padStart(14)}`
		);
	}
	console.log();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
