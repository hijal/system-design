import { startBilling } from './billing';
import { Bulkhead } from './bulkhead';
import { callService } from './http';
import { mulberry32, ms, padEnd, percentile, sleep } from './random';

const PORT = Number(process.env.PORT ?? 4301);
const REQUESTS = Number(process.env.REQUESTS ?? 600);
const CLIENTS = Number(process.env.CLIENTS ?? 40);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 300);
const SLOW_MS = Number(process.env.SLOW_MS ?? 2000);
const WORKERS = Number(process.env.WORKERS ?? 16);
const BOARD_SHARE = Number(process.env.BOARD_SHARE ?? 0.3);

const LABEL = 24;
const COL = 12;

const padLeft = (value: string | number, width: number): string => String(value).padStart(width);

type Outcome = { kind: 'create' | 'board'; ok: boolean; totalMs: number };

type Summary = {
	ok: number;
	failed: number;
	shed: number;
	p50: number;
	p99: number;
};

function summarise(outcomes: Outcome[], kind: Outcome['kind'], shed: number): Summary {
	const mine = outcomes.filter((o) => o.kind === kind);
	const times = mine.map((o) => o.totalMs);
	return {
		ok: mine.filter((o) => o.ok).length,
		failed: mine.filter((o) => !o.ok).length,
		shed,
		p50: percentile(times, 50),
		p99: percentile(times, 99)
	};
}

function header(label: string, columns: string[]): string {
	return `   ${padEnd(label, LABEL)}${columns.map((c) => padLeft(c, COL)).join('')}`;
}

function line(label: string, summary: Summary): string {
	return (
		`   ${padEnd(label, LABEL)}` +
		padLeft(summary.ok, COL) +
		padLeft(summary.failed, COL) +
		padLeft(summary.shed, COL) +
		padLeft(ms(summary.p50), COL) +
		padLeft(ms(summary.p99), COL)
	);
}

async function localBoardWork(): Promise<void> {
	await sleep(2);
}

async function drive(
	createPool: Bulkhead,
	boardPool: Bulkhead
): Promise<{ outcomes: Outcome[]; wallMs: number }> {
	const outcomes: Outcome[] = [];
	const random = mulberry32(42);
	const plan: Outcome['kind'][] = Array.from({ length: REQUESTS }, () =>
		random() < BOARD_SHARE ? 'board' : 'create'
	);
	let issued = 0;
	const started = performance.now();

	async function client(): Promise<void> {
		while (issued < REQUESTS) {
			const kind = plan[issued] ?? 'create';
			issued += 1;
			const at = performance.now();
			if (kind === 'board') {
				const run = await boardPool.run(localBoardWork);
				outcomes.push({ kind, ok: run.admitted, totalMs: performance.now() - at });
			} else {
				const run = await createPool.run(async () => {
					const call = await callService(`http://127.0.0.1:${PORT}/reserve?ws=1`, TIMEOUT_MS);
					return call.outcome === 'ok';
				});
				outcomes.push({
					kind,
					ok: run.admitted && run.value === true,
					totalMs: performance.now() - at
				});
			}
		}
	}

	await Promise.all(Array.from({ length: CLIENTS }, () => client()));
	return { outcomes, wallMs: performance.now() - started };
}

async function main(): Promise<void> {
	console.log(
		`\n=== Lesson 9.4 — Bulkhead ===\n` +
			`   work service এর ${WORKERS} টা worker slot · ${REQUESTS} টা request · ${CLIENTS} জন client একসাথে\n` +
			`   মিশ্রণ: ${Math.round((1 - BOARD_SHARE) * 100)}% "task তৈরি" (billing কে ডাকে) · ${Math.round(BOARD_SHARE * 100)}% "board খোলা" (শুধু নিজের কাজ)\n` +
			`   billing ধীর: প্রতি উত্তরে ${SLOW_MS} ms · call এর timeout ${TIMEOUT_MS} ms\n`
	);

	const billing = await startBilling('billing-1', PORT, { healthyMs: 3, slowMs: SLOW_MS });
	billing.setMode('slow');

	const sharedPool = new Bulkhead(WORKERS, REQUESTS);
	const shared = await drive(sharedPool, sharedPool);

	const createPool = new Bulkhead(WORKERS - 4, REQUESTS);
	const boardPool = new Bulkhead(4, REQUESTS);
	const split = await drive(createPool, boardPool);

	console.log(`── ক. "board খোলা" — যে কাজটার billing এর সাথে কোনো সম্পর্ক নেই ──`);
	console.log(header('pool', ['ok', 'failed', 'shed', 'p50', 'p99']));
	console.log(
		line(`shared (${WORKERS})`, summarise(shared.outcomes, 'board', sharedPool.rejected()))
	);
	console.log(line(`bulkhead (4 board)`, summarise(split.outcomes, 'board', boardPool.rejected())));
	console.log('');

	console.log(`── খ. "task তৈরি" — যে কাজটা সত্যিই ধীর billing এর উপর নির্ভর করে ──`);
	console.log(header('pool', ['ok', 'failed', 'shed', 'p50', 'p99']));
	console.log(
		line(`shared (${WORKERS})`, summarise(shared.outcomes, 'create', sharedPool.rejected()))
	);
	console.log(
		line(
			`bulkhead (${WORKERS - 4} create)`,
			summarise(split.outcomes, 'create', createPool.rejected())
		)
	);
	console.log('');

	const sharedBoard = summarise(shared.outcomes, 'board', 0);
	const splitBoard = summarise(split.outcomes, 'board', 0);
	console.log(
		`   shared pool এ board এর p99 ${ms(sharedBoard.p99)} — ${WORKERS} টা slot ই ধীর billing এর জন্য অপেক্ষা করছে,\n` +
			`   board কে line এ দাঁড়াতে হচ্ছে। আলাদা pool এ board এর p99 ${ms(splitBoard.p99)} — একই ধীর billing, একই চাপ।\n` +
			`   মোট সময়: shared ${ms(shared.wallMs)} · bulkhead ${ms(split.wallMs)}\n`
	);

	await billing.stop();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
