import { eventual, MODELS, r, w, type History } from './checker';

// Lesson 6.5 — seven incidents from Module 6, on the consistency ladder.
// Every history is small and hand-made — times in ms; P1, P2, P3 are three clients.
// Next to each, the lesson where you saw this incident.

const CASES: { name: string; lesson: string; history: History }[] = [
	{
		name: 'one primary, all normal',
		lesson: '5.x',
		history: [
			w('P1', 'x', 1, 0, 10),
			r('P2', 'x', 1, 20, 25),
			w('P2', 'x', 2, 30, 40),
			r('P1', 'x', 2, 50, 55),
			r('P3', 'x', 2, 400, 405)
		]
	},
	{
		name: 'read during a write got the new value',
		lesson: '6.2',
		history: [
			w('P1', 'x', 1, 0, 50),
			r('P2', 'x', 1, 10, 20),
			r('P3', 'x', 1, 30, 40),
			r('P3', 'x', 1, 400, 405)
		]
	},
	{
		name: 'read from the old leader',
		lesson: '6.2',
		history: [
			w('P1', 'x', 1, 0, 10),
			r('P2', 'x', 0, 100, 110),
			r('P2', 'x', 1, 500, 505),
			r('P1', 'x', 1, 510, 515)
		]
	},
	{
		name: 'replica lag: own write missing',
		lesson: '5.7',
		history: [w('P1', 'x', 1, 0, 10), r('P1', 'x', 0, 12, 15), r('P1', 'x', 1, 300, 305)]
	},
	{
		name: 'task vanishes on refresh',
		lesson: '6.3',
		history: [
			w('P2', 'x', 1, 0, 10),
			r('P1', 'x', 1, 20, 25),
			r('P1', 'x', 0, 30, 35),
			r('P1', 'x', 1, 300, 305)
		]
	},
	{
		name: 'answer present, question missing',
		lesson: '6.3',
		history: [
			w('P1', 'q', 1, 0, 10), // Rahim: the question
			r('P2', 'q', 1, 20, 25), // Karim read the question
			w('P2', 'a', 1, 30, 40), // Karim: the answer
			r('P3', 'a', 1, 50, 55), // a reader saw the answer
			r('P3', 'q', 0, 60, 65), // … but not the question
			r('P3', 'q', 1, 400, 405)
		]
	},
	{
		name: "LWW: bot's edit lost to a clock error",
		lesson: '6.4',
		history: [
			w('P1', 'x', 1, 0, 10),
			r('P2', 'x', 1, 20, 25), // the bot saw the title
			w('P2', 'x', 2, 30, 40), // the bot wrote "[DONE]" — on the replica with the lagging clock
			r('P2', 'x', 1, 300, 305), // everyone still sees the old one
			r('P1', 'x', 1, 310, 315),
			r('P3', 'x', 1, 320, 325)
		]
	}
];

function main(): void {
	const tick = (ok: boolean | null): string => (ok === null ? '—' : ok ? '✓' : '✗');
	console.log(
		'\n   incident                               lesson   linear.  sequential  causal  RYW  mono.read  eventual'
	);
	for (const c of CASES) {
		const cells = MODELS.map(([, check]) => check(c.history));
		const [lin, seq, cau, ryw, mono] = cells;
		console.log(
			`   ${c.name.padEnd(38)} ${c.lesson.padEnd(6)}   ${tick(lin ?? null).padEnd(7)}  ${tick(seq ?? null).padEnd(10)}  ${tick(cau ?? null).padEnd(6)}  ${tick(ryw ?? null).padEnd(3)}  ${tick(mono ?? null).padEnd(9)}  ${tick(eventual(c.history))}`
		);
	}
	console.log('\n   linear. = linearizable, RYW = read-your-writes, mono.read = monotonic reads\n');
}

main();
