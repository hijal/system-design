import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { heading, n, percentile, row } from './random';
import {
	call,
	childSpan,
	log,
	logs,
	parseTraceparent,
	spans,
	withSpan,
	type Span
} from './tracing';

const REQUESTS = Number(process.env.REQUESTS ?? 30);
const STALL_FROM = Number(process.env.STALL_FROM ?? 18);
const STALL_TO = Number(process.env.STALL_TO ?? 23);
const STALL_MS = Number(process.env.STALL_MS ?? 1_200);

type Handler = (path: string) => Promise<{ status: number; body: unknown }>;

const servers: Server[] = [];

async function service(name: string, handler: Handler): Promise<string> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const path = req.url ?? '/';
		const route = path.replace(/\/\d+/g, '/:id');
		void withSpan(
			name,
			`${req.method ?? 'GET'} ${route}`,
			parseTraceparent(req.headers.traceparent),
			{ 'http.route': route },
			async (span) => {
				const result = await handler(path);
				span.attributes['http.status_code'] = result.status;
				if (result.status >= 500) span.status = 'error';
				res.writeHead(result.status, { 'content-type': 'application/json' });
				res.end(JSON.stringify(result.body));
			}
		);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

let replicaTurn = 0;
let requestNumber = 0;

async function replicaQuery(board: number): Promise<number> {
	const replica = (replicaTurn++ % 3) + 1;
	const stalled = replica === 3 && requestNumber >= STALL_FROM && requestNumber <= STALL_TO;
	return childSpan(
		'db.query tasks',
		{ 'db.replica': `r${replica}`, 'board.id': board },
		async () => {
			await sleep(stalled ? STALL_MS : 8);
			if (stalled) log('warn', 'slow query', { replica: `r${replica}`, board });
			return 40 + (board % 7);
		}
	);
}

async function start(propagate: boolean): Promise<string> {
	const billing = await service('billing', async () => {
		await sleep(15);
		return { status: 200, body: { plan: 'pro' } };
	});
	const work = await service('work', async (path) => {
		const board = Number(path.split('/').pop());
		await childSpan('cache.get board', { 'cache.hit': 0 }, async () => sleep(1));
		const tasks = await replicaQuery(board);
		log('info', 'board loaded', { board, tasks });
		return { status: 200, body: { board, tasks } };
	});
	const bff = await service('bff', async (path) => {
		const board = Number(path.split('/').pop());
		const [tasks, plan] = await Promise.all([
			call('work', `${work}/api/boards/${board}`, propagate),
			call('billing', `${billing}/plan/${board % 50}`, propagate)
		]);
		log('info', 'page composed', { board });
		return { status: 200, body: { tasks: tasks.body, plan: plan.body } };
	});
	return service('gateway', async (path) => {
		const result = await call('bff', `${bff}${path}`);
		log('info', 'request done', { path, status: result.status });
		return result;
	});
}

function waterfall(traceId: string): void {
	const members = spans.filter((span) => span.traceId === traceId);
	const root = members.find((span) => span.parentId === null) ?? members[0];
	if (!root) return;
	const width = 40;
	const scale = width / Math.max(1, root.end - root.start);
	const children = (parent: Span): Span[] =>
		members.filter((span) => span.parentId === parent.spanId).sort((a, b) => a.start - b.start);
	const draw = (span: Span, depth: number): void => {
		const offset = Math.round((span.start - root.start) * scale);
		const length = Math.max(1, Math.round((span.end - span.start) * scale));
		const bar = ' '.repeat(offset) + '█'.repeat(Math.min(length, width - offset));
		const label = `${'  '.repeat(depth)}${span.service} · ${span.name}`;
		const extra = span.attributes['db.replica'] ? ` ${span.attributes['db.replica']}` : '';
		console.log(
			row([
				[label + extra, 42],
				[`${n(span.end - span.start)} ms`, 10],
				[`  |${bar.padEnd(width)}|`, 44]
			])
		);
		for (const child of children(span)) draw(child, depth + 1);
	};
	draw(root, 0);
}

async function client(gateway: string): Promise<{ trace: string; ms: number }[]> {
	const results: { trace: string; ms: number }[] = [];
	for (let i = 1; i <= REQUESTS; i++) {
		requestNumber = i;
		const started = performance.now();
		const response = await fetch(`${gateway}/boards/${100 + i}`);
		await response.json();
		const ms = performance.now() - started;
		const gatewaySpans = spans.filter(
			(span) => span.service === 'gateway' && span.parentId === null
		);
		results.push({ trace: gatewaySpans[gatewaySpans.length - 1]?.traceId ?? '', ms });
	}
	return results;
}

async function stop(): Promise<void> {
	for (const server of servers) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	servers.length = 0;
}

async function main(): Promise<void> {
	const gateway = await start(true);
	const results = await client(gateway);
	await stop();
	const slowest = [...results].sort((a, b) => b.ms - a.ms)[0];
	const durations = results.map((result) => result.ms).sort((a, b) => a - b);

	heading(
		`A. ${REQUESTS} board requests — gateway → bff → (work, billing); work's replica r3 stalls ${n(STALL_MS)} ms during requests ${STALL_FROM}–${STALL_TO}`
	);
	console.log(
		`   p50 ${n(percentile(durations, 50))} ms, slowest ${n(slowest?.ms ?? 0)} ms; ${spans.length} spans in total, ${new Set(spans.map((span) => span.traceId)).size} distinct traces`
	);
	if (!slowest) return;
	console.log(`\n   the slowest request's trace — ${slowest.trace}`);
	waterfall(slowest.trace);

	heading("B. Searching four services' logs by the same trace_id");
	for (const line of logs.filter((entry) => entry.trace_id === slowest.trace))
		console.log(
			`   ${JSON.stringify({ ...line, trace_id: `${line.trace_id?.slice(0, 8)}…`, span_id: `${line.span_id?.slice(0, 6)}…` })}`
		);
	console.log(
		`   ${logs.length} log lines in total; ${logs.filter((entry) => entry.trace_id === slowest.trace).length} for this trace`
	);

	heading('C. db.query spans from every trace, by replica');
	console.log(
		row([
			['replica', 10],
			['query', 8],
			['p50', 10],
			['max', 10]
		])
	);
	for (const replica of ['r1', 'r2', 'r3']) {
		const values = spans
			.filter((span) => span.name === 'db.query tasks' && span.attributes['db.replica'] === replica)
			.map((span) => span.end - span.start)
			.sort((a, b) => a - b);
		console.log(
			row([
				[replica, 10],
				[values.length, 8],
				[`${n(percentile(values, 50))} ms`, 10],
				[`${n(values[values.length - 1] ?? 0)} ms`, 10]
			])
		);
	}

	const before = { spans: spans.length, traces: new Set(spans.map((span) => span.traceId)).size };
	spans.length = 0;
	logs.length = 0;
	replicaTurn = 0;
	const brokenGateway = await start(false);
	const broken = await client(brokenGateway);
	await stop();
	const brokenSlowest = [...broken].sort((a, b) => b.ms - a.ms)[0];
	const traces = new Set(spans.map((span) => span.traceId));
	const slowQuery = spans
		.filter((span) => span.name === 'db.query tasks')
		.sort((a, b) => b.end - b.start - (a.end - a.start))[0];

	heading('D. If bff forgets to pass traceparent — the same 30 requests');
	console.log(
		row([
			['', 26],
			['span', 8],
			['trace', 8]
		])
	);
	console.log(
		row([
			['with the header', 26],
			[before.spans, 8],
			[before.traces, 8]
		])
	);
	console.log(
		row([
			['bff without the header', 26],
			[spans.length, 8],
			[traces.size, 8]
		])
	);
	if (brokenSlowest && slowQuery) {
		console.log(`\n   the slowest request's gateway trace — ${brokenSlowest.trace}`);
		waterfall(brokenSlowest.trace);
		console.log(`\n   the slow query is in a different trace — ${slowQuery.traceId}`);
		waterfall(slowQuery.traceId);
	}
}

void main();
