import { fork, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { createServices, type ServiceEvent } from './services';

// Lesson 6.1 §১.৫–১.৬ — দুটো আসল Node process (A আর B) reminder job এর leader হওয়ার জন্য লড়ে।
// A প্রথমে leader হয়, তারপর batch 3 এ ২.৫ সেকেন্ডের জন্য থেমে যায়। Lease এর মেয়াদ ১ সেকেন্ড।
//
//   npm run split-brain  → storage token যাচাই করে না
//   npm run fenced       → storage fencing token যাচাই করে
//
// Experiment এর জন্য env দিয়ে বদলানো যায়: PAUSE_MS (A কতক্ষণ থামে), LEASE_MS (lease এর মেয়াদ)

const mode = z.enum(['unfenced', 'fenced']).parse(process.argv[2]);
const RUN_MS = 4000;
const { PAUSE_MS: pauseMs, LEASE_MS: leaseMs } = z
	.object({
		PAUSE_MS: z.coerce.number().int().positive().default(2500),
		LEASE_MS: z.coerce.number().int().positive().default(1000)
	})
	.parse(process.env);

type Line = { at: number; node: string; text: string };

function describe(event: ServiceEvent): Line {
	switch (event.kind) {
		case 'lease-granted':
			return { at: event.at, node: 'lock', text: `lease → ${event.node} (token ${event.token})` };
		case 'email':
			return {
				at: event.at,
				node: 'email',
				text: `batch ${event.batch} পাঠাল ${event.node}${event.duplicate ? '   ← আবার! duplicate' : ''}`
			};
		case 'cursor-write':
			return {
				at: event.at,
				node: 'store',
				text: `cursor ${event.from} → ${event.to}  (${event.node}, token ${event.token})${event.to <= event.from ? '   ← পিছনে গেল!' : ''}`
			};
		case 'cursor-rejected':
			return {
				at: event.at,
				node: 'store',
				text: `✗ ${event.node} এর লেখা প্রত্যাখ্যাত: token ${event.token} < ${event.highest}`
			};
	}
}

function startWorker(
	name: string,
	baseUrl: string,
	start: number,
	extra: Record<string, string>,
	lines: Line[]
): ChildProcess {
	const child = fork(path.join(__dirname, 'worker.js'), [], {
		env: { ...process.env, NODE_NAME: name, BASE_URL: baseUrl, START: String(start), ...extra },
		stdio: ['ignore', 'pipe', 'inherit', 'ipc']
	});
	if (child.stdout) {
		createInterface({ input: child.stdout }).on('line', (raw) => {
			const [at, ...rest] = raw.split('\t');
			lines.push({ at: Number(at), node: name, text: rest.join('\t') });
		});
	}
	return child;
}

async function main(): Promise<void> {
	const start = Date.now();
	const services = createServices(mode === 'fenced', start, leaseMs);
	const server = services.app.listen(0);
	await new Promise<void>((resolve) => server.once('listening', () => resolve()));
	// listen(0) এর পরে address() সবসময় AddressInfo (pipe না) — তাই এই assertion নিরাপদ
	const { port } = server.address() as AddressInfo;
	const baseUrl = `http://127.0.0.1:${port}`;

	const workerLines: Line[] = [];
	const a = startWorker(
		'A',
		baseUrl,
		start,
		{ PAUSE_AT_BATCH: '3', PAUSE_MS: String(pauseMs) },
		workerLines
	);
	await new Promise((resolve) => setTimeout(resolve, 100));
	const b = startWorker('B', baseUrl, start, {}, workerLines);

	await new Promise((resolve) => setTimeout(resolve, RUN_MS));
	a.kill();
	b.kill();
	server.close();

	console.log(
		`\n   ${mode === 'fenced' ? 'FENCED — storage token যাচাই করে' : 'UNFENCED — storage token দেখে না'}` +
			`   (lease ${leaseMs} ms, A থামে batch 3 এ, ${pauseMs} ms)\n`
	);
	const all = [...services.events.map(describe), ...workerLines].sort((x, y) => x.at - y.at);
	for (const line of all) {
		console.log(`   ${String(line.at).padStart(5)} ms  ${line.node.padEnd(5)}  ${line.text}`);
	}

	const duplicates = [...services.emailsSent.entries()].filter(([, senders]) => senders.length > 1);
	const totalEmails = [...services.emailsSent.values()].reduce((sum, s) => sum + s.length, 0);
	const rejected = services.events.filter((e) => e.kind === 'cursor-rejected').length;
	console.log('\n   ── ফল ──');
	console.log(
		`   reminder batch পাঠানো হয়েছে: ${totalEmails} বার, আলাদা batch ${services.emailsSent.size} টা`
	);
	console.log(
		`   একাধিকবার গেছে: ${duplicates.length} টা batch` +
			(duplicates.length
				? `  (${duplicates.map(([batch, s]) => `${batch}: ${s.join('+')}`).join(', ')})`
				: '')
	);
	console.log(`   storage এ প্রত্যাখ্যাত লেখা: ${rejected}`);
	console.log(`   শেষ cursor: ${services.finalCursor()}\n`);
}

void main();
