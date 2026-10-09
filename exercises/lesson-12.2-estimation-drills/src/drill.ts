import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { answerOf, drills, type Drill } from './drills';
import { env, factorOff, heading, num, row, times } from './util';

const LIMIT_S = env('LIMIT_S', 120);
const ONLY = env('ONLY', 0);

const suffixes: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

const answerPattern =
	/^([0-9][0-9,]*(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?)\s*(?:([kmbt])(?![a-z]))?[a-z%/ ]*$/;

const answerSchema = z
	.string()
	.trim()
	.toLowerCase()
	.regex(answerPattern, 'a number such as 70000, 70k, 7e4 or 20 GB')
	.transform((text) => {
		const match = answerPattern.exec(text);
		const digits = match?.[1] ?? '';
		const multiplier = suffixes[match?.[2] ?? ''] ?? 1;
		return Number(digits.replaceAll(',', '')) * multiplier;
	})
	.pipe(z.number().positive().finite());

type Attempt =
	| { kind: 'answered'; drill: Drill; value: number; seconds: number }
	| { kind: 'skipped'; drill: Drill; seconds: number };

function verdict(factor: number): string {
	if (factor <= 2) return 'close (within 2×)';
	if (factor <= 10) return 'right order of magnitude';
	return `off by ${times(factor)}`;
}

async function main(): Promise<void> {
	const rl = createInterface({ input: process.stdin, terminal: false });
	const lines = rl[Symbol.asyncIterator]();
	const chosen = drills.filter((drill) => ONLY === 0 || drill.id === ONLY);
	const attempts: Attempt[] = [];

	console.log(
		`${chosen.length} drills, ${LIMIT_S} s each. Work on paper first, then type one number.`
	);
	console.log('Accepted: 70000, 70,000, 70k, 7e4, 20 GB. An empty line skips the drill.');

	for (const drill of chosen) {
		heading(`Drill ${drill.id} - ${drill.title}`);
		for (const given of drill.givens) console.log(`  • ${given}`);
		console.log(`  ${drill.question}  [${drill.unit}]`);

		const started = performance.now();
		let attempt: Attempt | undefined;
		while (attempt === undefined) {
			process.stdout.write('your answer> ');
			const next = await lines.next();
			const seconds = (performance.now() - started) / 1_000;
			if (next.done === true || next.value.trim() === '') {
				if (next.done !== true) process.stdout.write('\n');
				attempt = { kind: 'skipped', drill, seconds };
				break;
			}
			const parsed = answerSchema.safeParse(next.value);
			if (!parsed.success) {
				console.log(`  not a number: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
				continue;
			}
			attempt = { kind: 'answered', drill, value: parsed.data, seconds };
		}
		attempts.push(attempt);

		const reference = answerOf(drill.exact);
		if (attempt.kind === 'answered') {
			const factor = factorOff(attempt.value, reference);
			console.log(
				`  yours ${num(attempt.value)} · reference ${num(reference)} ${drill.unit} · ${verdict(factor)}`
			);
		} else {
			console.log(`  skipped · reference ${num(reference)} ${drill.unit}`);
		}
		if (attempt.seconds > LIMIT_S)
			console.log(`  over the limit: ${Math.round(attempt.seconds)} s`);
		console.log(`  so: ${drill.so}`);
	}
	rl.close();

	heading('Summary');
	console.log(
		row([
			['drill', 34],
			['yours', 14],
			['reference', 14],
			['off by', 10],
			['seconds', 9]
		])
	);
	for (const attempt of attempts) {
		const reference = answerOf(attempt.drill.exact);
		const yours = attempt.kind === 'answered' ? num(attempt.value) : '-';
		const off = attempt.kind === 'answered' ? times(factorOff(attempt.value, reference)) : '-';
		console.log(
			row([
				[`${attempt.drill.id}. ${attempt.drill.title}`, 34],
				[yours, 14],
				[num(reference), 14],
				[off, 10],
				[Math.round(attempt.seconds), 9]
			])
		);
	}

	const answered = attempts.filter((attempt) => attempt.kind === 'answered');
	const factors = answered.map((attempt) =>
		factorOff(attempt.value, answerOf(attempt.drill.exact))
	);
	const close = factors.filter((factor) => factor <= 2).length;
	const order = factors.filter((factor) => factor <= 10).length;
	const slow = attempts.filter((attempt) => attempt.seconds > LIMIT_S).length;
	const total = attempts.reduce((sum, attempt) => sum + attempt.seconds, 0);
	console.log(
		`\nwithin 2×: ${close}/${attempts.length} · within 10×: ${order}/${attempts.length} · over ${LIMIT_S} s: ${slow} · total ${Math.round(total)} s`
	);
	console.log(
		'Within 2× is enough for a design decision. Anything past 10× is a slipped step, not rounding: run `npm run answers` and find it.'
	);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
