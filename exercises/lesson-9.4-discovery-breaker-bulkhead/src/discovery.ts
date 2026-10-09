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
		`\n=== Lesson 9.4 - Service Discovery ===\n` +
			`   ${PORTS.length} billing instances · ${PHASE_REQUESTS} "create task" per phase · ${CONCURRENCY} at once\n` +
			`   heartbeat every ${HEARTBEAT_MS} ms · registry TTL ${TTL_MS} ms · call timeout ${TIMEOUT_MS} ms\n`
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

	console.log(`── a. One instance died (process crash - connection refused) ──`);
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
		`   time for the dead instance to leave the registry: ${convergence < 0 ? 'never left' : ms(convergence)} ` +
			`(heartbeat ${HEARTBEAT_MS} ms + TTL ${TTL_MS} ms)\n` +
			`   live instances in the static list: ${instances.length - 1} of ${staticTargets.length} - yet 1 in every ${PORTS.length} calls still went to the dead address\n`
	);

	const alive = instances.filter((i) => i.id !== victim.id);
	const sick = alive[0];
	if (!sick) throw new Error('no instance left to sicken');

	console.log(
		`── b. The instance didn't die, but it is sick - sending heartbeats, yet 500 on every call ──`
	);
	console.log(header('strategy', ['healthy', 'sick (500)']));

	const healthyAgain = await runPhase(PHASE_REQUESTS, registryResolver);
	sick.setMode('error');
	const sickPhase = await runPhase(PHASE_REQUESTS, registryResolver);

	console.log(row('registry + heartbeat/TTL', [healthyAgain, sickPhase]));
	console.log('');
	console.log(
		`   a heartbeat only says "the process is alive" - not "it is working". The registry still keeps ${sick.id} listed,\n` +
			`   so 1 in every ${alive.length} calls still goes to it. The answer is in the next two parts.\n`
	);

	beats.stopAll();
	for (const instance of instances) if (instance.id !== victim.id) await instance.stop();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
