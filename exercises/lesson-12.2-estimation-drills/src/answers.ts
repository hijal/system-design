import { answerOf, drills } from './drills';
import { env, heading, num, row } from './util';

const ONLY = env('ONLY', 0);

for (const drill of drills.filter((item) => ONLY === 0 || item.id === ONLY)) {
	heading(`Drill ${drill.id} - ${drill.title}`);
	for (const given of drill.givens) console.log(`  • ${given}`);
	console.log(`  ${drill.question}`);
	for (const item of drill.exact) {
		console.log(
			row([
				[`    ${item.label}`, 50],
				[num(item.value), 16]
			]) + `  ${item.unit}`
		);
	}
	console.log(`  answer: ${num(answerOf(drill.exact))} ${drill.unit}`);
	console.log(`  so: ${drill.so}`);
}
