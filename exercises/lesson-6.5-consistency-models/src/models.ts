import { eventual, MODELS, r, w, type History } from './checker';

// Lesson 6.5 — Module 6 এর সাতটা ঘটনা, consistency এর মই এ।
// প্রতিটা history ছোট আর হাতে বানানো — সময়গুলো ms এ; P1, P2, P3 তিনজন client।
// প্রতিটার পাশে কোন lesson এ এই ঘটনা দেখেছিলে।

const CASES: { name: string; lesson: string; history: History }[] = [
	{
		name: 'এক primary, সব স্বাভাবিক',
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
		name: 'লেখা চলার মাঝে পড়া নতুন মান পেল',
		lesson: '6.2',
		history: [
			w('P1', 'x', 1, 0, 50),
			r('P2', 'x', 1, 10, 20),
			r('P3', 'x', 1, 30, 40),
			r('P3', 'x', 1, 400, 405)
		]
	},
	{
		name: 'পুরনো leader থেকে পড়া',
		lesson: '6.2',
		history: [
			w('P1', 'x', 1, 0, 10),
			r('P2', 'x', 0, 100, 110),
			r('P2', 'x', 1, 500, 505),
			r('P1', 'x', 1, 510, 515)
		]
	},
	{
		name: 'Replica lag: নিজের লেখা নেই',
		lesson: '5.7',
		history: [w('P1', 'x', 1, 0, 10), r('P1', 'x', 0, 12, 15), r('P1', 'x', 1, 300, 305)]
	},
	{
		name: 'Refresh এ task উধাও',
		lesson: '6.3',
		history: [
			w('P2', 'x', 1, 0, 10),
			r('P1', 'x', 1, 20, 25),
			r('P1', 'x', 0, 30, 35),
			r('P1', 'x', 1, 300, 305)
		]
	},
	{
		name: 'উত্তর আছে, প্রশ্ন নেই',
		lesson: '6.3',
		history: [
			w('P1', 'q', 1, 0, 10), // রহিম: প্রশ্ন
			r('P2', 'q', 1, 20, 25), // করিম প্রশ্ন পড়ল
			w('P2', 'a', 1, 30, 40), // করিম: উত্তর
			r('P3', 'a', 1, 50, 55), // পাঠক উত্তর দেখল
			r('P3', 'q', 0, 60, 65), // … কিন্তু প্রশ্ন না
			r('P3', 'q', 1, 400, 405)
		]
	},
	{
		name: 'LWW: ঘড়ির ভুলে bot এর edit হারাল',
		lesson: '6.4',
		history: [
			w('P1', 'x', 1, 0, 10),
			r('P2', 'x', 1, 20, 25), // bot title দেখল
			w('P2', 'x', 2, 30, 40), // bot "[DONE]" লিখল — পিছিয়ে থাকা ঘড়ির replica তে
			r('P2', 'x', 1, 300, 305), // সবাই পুরনোটাই দেখছে
			r('P1', 'x', 1, 310, 315),
			r('P3', 'x', 1, 320, 325)
		]
	}
];

function main(): void {
	const tick = (ok: boolean | null): string => (ok === null ? '—' : ok ? '✓' : '✗');
	console.log(
		'\n   ঘটনা                                   lesson   linear.  sequential  causal  RYW  mono.read  eventual'
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
