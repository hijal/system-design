import { startBilling, type BillingInstance } from './billing';
import { callService } from './http';
import { Heartbeats, Registry, RoundRobin } from './registry';
import { ms, pad, padEnd, padLeft, percentile, sleep } from './random';

const PORTS = [4101, 4102, 4103];
const PHASE_REQUESTS = Number(process.env.PHASE_REQUESTS ?? 300);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 300);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 100);
const TTL_MS = Number(process.env.TTL_MS ?? 300);

type PhaseResult = { ok: number; refused: number; failed: number; noTarget: number; p50: number };

type Resolver = () => string[];

async function runPhase(count: number, resolve: Resolver): Promise<PhaseResult> {
	const result: PhaseResult = { ok: 0, refused: 0, failed: 0, noTarget: 0, p50: 0 };
	const latencies: number[] = [];
	const picker = new RoundRobin();
	let issued = 0;

	async function worker(): Promise<void> {
		while (issued < count) {
			issued += 1;
			const targets = resolve();
			const target = picker.pick(targets);
			if (target === null) {
				result.noTarget += 1;
				result.failed += 1;
				continue;
			}
			const call = await callService(`${target}/reserve?ws=1`, TIMEOUT_MS);
			latencies.push(call.ms);
			if (call.outcome === 'ok') result.ok += 1;
			else {
				result.failed += 1;
				if (call.outcome === 'refused') result.refused += 1;
			}
		}
	}

	await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
	result.p50 = percentile(latencies, 50);
	return result;
}

const LABEL = 30;
const COL = 13;

function rate(phase: PhaseResult): string {
	return `${pad(phase.failed, 3)} (${pad(((phase.failed / PHASE_REQUESTS) * 100).toFixed(0), 2)}%)`;
}

function header(label: string, columns: string[]): string {
	return `   ${padEnd(label, LABEL)}${columns.map((c) => padLeft(c, COL)).join('')}`;
}

function row(label: string, phases: PhaseResult[], tail = ''): string {
	return `   ${padEnd(label, LABEL)}${phases.map((p) => padLeft(rate(p), COL)).join('')}${tail}`;
}

async function watchRemoval(registry: Registry, victimId: string): Promise<number> {
	const started = performance.now();
	for (;;) {
		const listed = registry.alive(performance.now()).some((entry) => entry.id === victimId);
		if (!listed) return performance.now() - started;
		if (performance.now() - started > 5000) return -1;
		await sleep(2);
	}
}

async function main(): Promise<void> {
	console.log(
		`\n=== Lesson 9.4 — Service Discovery ===\n` +
			`   billing এর ${PORTS.length} টা instance · প্রতি phase এ ${PHASE_REQUESTS} টা "task তৈরি" · ${CONCURRENCY} জন একসাথে\n` +
			`   heartbeat প্রতি ${HEARTBEAT_MS} ms · registry এর TTL ${TTL_MS} ms · call এর timeout ${TIMEOUT_MS} ms\n`
	);

	const instances: BillingInstance[] = [];
	for (const [index, port] of PORTS.entries())
		instances.push(await startBilling(`billing-${index + 1}`, port));

	const staticTargets = instances.map((i) => i.url);
	const registry = new Registry(TTL_MS);
	const beats = new Heartbeats();
	for (const instance of instances) {
		registry.register(instance.id, instance.url, performance.now());
		beats.start(HEARTBEAT_MS, () => registry.heartbeat(instance.id, performance.now()));
	}

	const staticResolver: Resolver = () => staticTargets;
	const registryResolver: Resolver = () =>
		registry.alive(performance.now()).map((entry) => entry.url);

	console.log(`── ক. একটা instance মারা গেল (process crash — connection refused) ──`);
	console.log(header('strategy', ['before', 'on death', 'after TTL']));

	const staticBefore = await runPhase(PHASE_REQUESTS, staticResolver);
	const registryBefore = await runPhase(PHASE_REQUESTS, registryResolver);

	const victim = instances[1];
	if (!victim) throw new Error('victim instance missing');
	beats.stopAll();
	for (const instance of instances)
		if (instance.id !== victim.id)
			beats.start(HEARTBEAT_MS, () => registry.heartbeat(instance.id, performance.now()));
	await victim.stop();
	const removal = watchRemoval(registry, victim.id);

	const staticDuring = await runPhase(PHASE_REQUESTS, staticResolver);
	const registryDuring = await runPhase(PHASE_REQUESTS, registryResolver);

	const convergence = await removal;
	await sleep(TTL_MS + HEARTBEAT_MS);

	const staticAfter = await runPhase(PHASE_REQUESTS, staticResolver);
	const registryAfter = await runPhase(PHASE_REQUESTS, registryResolver);

	console.log(row('static list', [staticBefore, staticDuring, staticAfter]));
	console.log(row('registry + heartbeat/TTL', [registryBefore, registryDuring, registryAfter]));
	console.log('');
	console.log(
		`   registry থেকে মরা instance সরতে লেগেছে: ${convergence < 0 ? 'সরেনি' : ms(convergence)} ` +
			`(heartbeat ${HEARTBEAT_MS} ms + TTL ${TTL_MS} ms)\n` +
			`   static list এ বেঁচে থাকা instance: ${staticTargets.length} টার মধ্যে ${instances.length - 1} টা — তবু প্রতি ${PORTS.length} টার 1 টা call মরা ঠিকানায় গেছে\n`
	);

	const alive = instances.filter((i) => i.id !== victim.id);
	const sick = alive[0];
	if (!sick) throw new Error('no instance left to sicken');

	console.log(
		`── খ. instance মরেনি, কিন্তু অসুস্থ — heartbeat পাঠাচ্ছে, অথচ প্রতিটা call এ 500 ──`
	);
	console.log(header('strategy', ['healthy', 'sick (500)']));

	const healthyAgain = await runPhase(PHASE_REQUESTS, registryResolver);
	sick.setMode('error');
	const sickPhase = await runPhase(PHASE_REQUESTS, registryResolver);

	console.log(row('registry + heartbeat/TTL', [healthyAgain, sickPhase]));
	console.log('');
	console.log(
		`   heartbeat শুধু বলে "process বেঁচে আছে" — "কাজ করছে" না। registry ${sick.id} কে এখনো তালিকায় রাখছে,\n` +
			`   তাই প্রতি ${alive.length} টার 1 টা call এখনো তার কাছেই যাচ্ছে। এর উত্তর পরের দুটো অংশে।\n`
	);

	beats.stopAll();
	for (const instance of instances) if (instance.id !== victim.id) await instance.stop();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
