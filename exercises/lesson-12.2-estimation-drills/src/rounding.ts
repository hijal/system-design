import { answerOf, drills } from './drills';
import { factorOff, heading, num, padEnd, padLeft, row, times } from './util';

heading('Part A — rounding: exact chain vs the powers-of-ten version you do in your head');
console.log(
	row([
		['drill', 34],
		['exact', 14],
		['in your head', 14],
		['off by', 10]
	])
);
let worstRounding = 1;
for (const drill of drills) {
	const exact = answerOf(drill.exact);
	const mental = answerOf(drill.mental);
	const factor = factorOff(mental, exact);
	worstRounding = Math.max(worstRounding, factor);
	console.log(
		row([
			[`${drill.id}. ${drill.title}`, 34],
			[num(exact), 14],
			[num(mental), 14],
			[times(factor), 10]
		])
	);
}
console.log(`worst rounding error: ${times(worstRounding)}`);

heading('Part B — slips: one wrong step in the same chains');
console.log(
	padEnd('drill', 34) + padEnd('the slip', 54) + padLeft('wrong answer', 16) + padLeft('off by', 10)
);
let smallestSlip = Number.POSITIVE_INFINITY;
for (const drill of drills) {
	if (drill.slip === undefined) continue;
	const factor = factorOff(drill.slip.value, answerOf(drill.exact));
	smallestSlip = Math.min(smallestSlip, factor);
	console.log(
		padEnd(`${drill.id}. ${drill.title}`, 34) +
			padEnd(drill.slip.label, 54) +
			padLeft(num(drill.slip.value), 16) +
			padLeft(times(factor), 10)
	);
}
console.log(`smallest slip: ${times(smallestSlip)}`);

heading('Part C — the constants worth rounding');
const constants: [string, number, number, string][] = [
	['seconds in a day', 86_400, 1e5, '10^5'],
	['seconds in a 30-day month', 2_592_000, 2.5e6, '2.5 × 10^6'],
	['seconds in a year', 31_536_000, 3e7, '3 × 10^7'],
	['days in a year', 365, 400, '400'],
	['minutes in a 30-day month', 43_200, 4e4, '4 × 10^4']
];
console.log(
	row([
		['constant', 34],
		['exact', 14],
		['rounded', 14],
		['off by', 10]
	])
);
for (const [label, exact, rounded, written] of constants) {
	console.log(
		row([
			[label, 34],
			[num(exact), 14],
			[written, 14],
			[times(factorOff(rounded, exact)), 10]
		])
	);
}
console.log(
	'Rounding moves an answer by a few tens of percent. A slipped step moves it by a factor. Fear the units, not the rounding.'
);
