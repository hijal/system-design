import {
	HashRing,
	ModuloRouter,
	type Router,
	loadByNode,
	movedKeys,
	nodeList,
	spread
} from './ring';
import { heading, keyNames, pct, ratio, row } from './random';

const KEYS = Number(process.env.KEYS ?? 100_000);
const VNODES = Number(process.env.VNODES ?? 160);
const keys = keyNames('tasks:board', KEYS);

function addNode(): void {
	const before = nodeList('cache', 4);
	const after = nodeList('cache', 5);
	const newcomer = after[4]?.id ?? '';
	heading(
		`ক. ৪টা cache node থেকে ৫টা — ${KEYS.toLocaleString('en-US')}টা key এর কতগুলো জায়গা বদলায়, আর কোথায় যায়`
	);
	console.log(
		row([
			['routing', 26],
			['সরল', 10],
			['নতুন node এ', 14],
			['পুরনোদের মধ্যে', 17]
		])
	);
	const pairs: [Router, Router][] = [
		[new ModuloRouter(before), new ModuloRouter(after)],
		[new HashRing(before, 1), new HashRing(after, 1)],
		[new HashRing(before, VNODES), new HashRing(after, VNODES)]
	];
	for (const [old, next] of pairs) {
		const moved = movedKeys(old, next, keys);
		const toNewcomer = moved.filter((key) => next.route(key) === newcomer).length;
		console.log(
			row([
				[old.label, 26],
				[pct(moved.length, KEYS), 10],
				[pct(toNewcomer, moved.length), 14],
				[pct(moved.length - toNewcomer, moved.length), 17]
			])
		);
	}
	console.log(`   আদর্শ: শুধু নতুন node এর ভাগ = ১/৫ = 20.0%, আর সবটা নতুন node এ`);
}

function removeNode(): void {
	const before = nodeList('cache', 5);
	const lost = before[2]?.id ?? '';
	const after = before.filter((spec) => spec.id !== lost);
	heading(`খ. ${lost} মরে গেল — তার key গুলো কে নিল, আর সবচেয়ে ভারী node এর উপর কত চাপ`);
	console.log(
		row([
			['routing', 26],
			...after.map((spec): [string, number] => [spec.id, 10]),
			['সবচেয়ে ভারী', 14]
		])
	);
	for (const vnodes of [1, VNODES]) {
		const old = new HashRing(before, vnodes);
		const next = new HashRing(after, vnodes);
		const orphans = keys.filter((key) => old.route(key) === lost);
		const absorbed = loadByNode(next, orphans);
		const { max } = spread(loadByNode(next, keys), after);
		console.log(
			row([
				[old.label, 26],
				...after.map((spec): [string, number] => [
					pct(absorbed.get(spec.id) ?? 0, orphans.length, 0),
					10
				]),
				[ratio(max), 14]
			])
		);
	}
	console.log(
		'   (কলামগুলো = মরা node এর key এর কত ভাগ কে নিল; "সবচেয়ে ভারী" = ন্যায্য ভাগের কত গুণ)'
	);
}

addNode();
removeNode();
