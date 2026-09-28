import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { messageSchema } from './app';
import { emptyBucket, mb, ms, percentile, prepareBucket, sendPut } from './common';

// Lesson 8.2 §১.১ — upload app এর ভেতর দিয়ে গেলে app এর কী হয়?
//
// UPLOADERS জন user একসাথে, প্রত্যেকে ROUNDS টা FILE_MB এর file, প্রতি সেকেন্ডে CLIENT_MBPS গতিতে (ভালো
// broadband এর মতো)। একই সময়ে PINGERS জন board এর মতো একটা সস্তা route একটানা ডাকে। চার ধাপ:
//   শুধু ping (তুলনার জন্য) · buffer (8.1 এর পথ) · stream · presigned (app শুধু URL দেয়)
// App আলাদা process — তার memory, event loop এর দেরি, আর একসাথে খোলা upload এর সংখ্যা মাপা হয়।

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
				// ১. app কে জিজ্ঞেস: "এই আকারের, এই ধরনের একটা file রাখতে চাই"
				const res = await fetch(`${url}/uploads`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ size: body.length, contentType: 'application/pdf' })
				});
				const { url: signed } = z.object({ url: z.string().url() }).parse(await res.json());
				// ২. সরাসরি object storage এ — app আর নেই
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
		child.kill(); // ব্যর্থ হলেও app process যেন থেকে না যায়
	}
}

async function main(): Promise<void> {
	await prepareBucket();
	await emptyBucket();
	const body = randomBytes(Math.round(cfg.FILE_MB * 1024 * 1024));
	const total = cfg.UPLOADERS * cfg.ROUNDS * body.length;
	console.log(
		`\n   ${cfg.UPLOADERS} জন user × ${cfg.ROUNDS} টা file × ${mb(body.length)}, প্রত্যেকে ${cfg.CLIENT_MBPS} MB/s এ (মোট ${mb(total)}) · ${cfg.PINGERS} জন একটানা ping\n`
	);
	const rows = [
		await run('শুধু ping', 'none', body),
		await run('buffer (পুরো file memory তে)', 'buffer', body),
		await run('stream (app এর ভেতর দিয়ে বয়ে যায়)', 'stream', body),
		await run('presigned (সরাসরি object storage এ)', 'presigned', body)
	];
	console.log(
		'   পথ                                       app এর memory (শুরু → সর্বোচ্চ)   app এ একসাথে খোলা upload   app এর ভেতর দিয়ে   ping p50 / p99      event loop দেরি p99 / max   সব upload শেষ'
	);
	for (const r of rows) {
		const s = r.stats;
		console.log(
			`   ${r.name.padEnd(40)} ${`${s.baseRssMb.toFixed(0)} → ${s.peakRssMb.toFixed(0)} MB`.padStart(22)} ${String(s.maxOpenUploads).padStart(24)} ${mb(s.bytesThroughApp).padStart(18)}   ${`${ms(percentile(r.ping, 50))} / ${ms(percentile(r.ping, 99))}`.padEnd(19)} ${`${ms(s.loopDelayP99)} / ${ms(s.loopDelayMax)}`.padStart(24)} ${(r.name === 'শুধু ping' ? '—' : ms(r.uploadMs)).padStart(14)}`
		);
	}
	console.log();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
