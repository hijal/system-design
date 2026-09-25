import { sequelize } from './db';
import { Project, Task } from './models/good';
import { reconcile } from './reconcile';

// Lesson 5.2 §১.৫ — denormalized counter কে ঠিক রাখা কেন কঠিন।
// একই কাজ ("একটা নতুন task তৈরি করো, counter এক বাড়াও") তিনভাবে, ২০০টা একসাথে।

const CONCURRENT = 200;

async function freshProject(name: string): Promise<Project> {
	return Project.create({ name });
}

async function actualOpen(projectId: number): Promise<number> {
	return Task.count({ where: { projectId, status: ['todo', 'doing'] } });
}

async function report(label: string, projectId: number): Promise<void> {
	const project = await Project.findByPk(projectId);
	const actual = await actualOpen(projectId);
	const stored = project?.openTaskCount ?? -1;
	const verdict = stored === actual ? '✓ ঠিক আছে' : `✗ ${actual - stored} টা হারিয়েছে`;
	console.log(
		`  ${label.padEnd(34)} counter = ${String(stored).padStart(3)}   আসল = ${actual}   ${verdict}`
	);
}

// ক. সরল read-modify-write — "পড়ো, JS এ +1 করো, লিখে দাও"।
// দুটো request একই মান (ধরো ৪১) পড়লে দুজনেই ৪২ লেখে — একটা বৃদ্ধি হারিয়ে যায়।
// এর নাম lost update, আর কেন transaction একাই এটা আটকায় না — সেটা Lesson 5.5 এ।
async function naive(projectId: number): Promise<void> {
	await Task.create({ title: 'naive', projectId, assigneeId: null });
	const project = await Project.findByPk(projectId);
	if (!project) throw new Error('project missing');
	project.openTaskCount = project.openTaskCount + 1;
	await project.save();
}

// খ. Transaction + atomic increment — Sequelize এখানে বানায়
//    UPDATE projects SET "openTaskCount" = "openTaskCount" + 1 WHERE id = ...
// হিসাবটা DB নিজে করে, row টা lock রেখে — তাই কেউ কারো লেখা মুছে দিতে পারে না।
// আর transaction থাকায় task তৈরি আর counter বাড়ানো — হয় দুটোই হবে, নয়তো কোনোটাই না।
async function atomic(projectId: number): Promise<void> {
	await sequelize.transaction(async (transaction) => {
		await Task.create({ title: 'atomic', projectId, assigneeId: null }, { transaction });
		await Project.increment('openTaskCount', { by: 1, where: { id: projectId }, transaction });
	});
}

// গ. পরে কেউ একটা নতুন code path লিখল — CSV থেকে bulk import — আর counter এর কথা
// ভুলে গেল। Denormalization এর সবচেয়ে সাধারণ বাস্তব ব্যর্থতা এটাই: race না, ভুলে যাওয়া।
async function bulkImport(projectId: number, count: number): Promise<void> {
	await Task.bulkCreate(
		Array.from({ length: count }, (_unused, i) => ({
			title: `imported #${i + 1}`,
			projectId,
			assigneeId: null
		}))
	);
}

async function main(): Promise<void> {
	await sequelize.sync({ force: true });
	console.log(`\n  ${CONCURRENT}টা "task তৈরি + counter +1" একসাথে:\n`);

	const a = await freshProject('Naive');
	await Promise.all(Array.from({ length: CONCURRENT }, () => naive(a.id)));
	await report('ক. read-modify-write', a.id);

	const b = await freshProject('Atomic');
	await Promise.all(Array.from({ length: CONCURRENT }, () => atomic(b.id)));
	await report('খ. transaction + increment', b.id);

	await bulkImport(b.id, 50);
	await report('গ. খ এর পরে ৫০টা bulk import', b.id);

	const fixed = await reconcile();
	console.log(
		`\n  reconcile() চালানো হলো — ${fixed} টা project এর counter ভুল ছিল, ঠিক করা হয়েছে:\n`
	);
	await report('ক. (reconcile এর পরে)', a.id);
	await report('খ+গ. (reconcile এর পরে)', b.id);
	console.log('');

	await sequelize.close();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('counter failed:', error instanceof Error ? error.message : String(error));
	await sequelize.close();
	process.exit(1);
});
