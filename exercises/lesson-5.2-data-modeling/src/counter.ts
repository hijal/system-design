import { sequelize } from './db';
import { Project, Task } from './models/good';
import { reconcile } from './reconcile';

// Lesson 5.2 §1.5 — why keeping a denormalized counter correct is hard.
// The same work ("create a new task, increment the counter") three ways, 200 at once.

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
	const verdict = stored === actual ? '✓ correct' : `✗ ${actual - stored} lost`;
	console.log(
		`  ${label.padEnd(34)} counter = ${String(stored).padStart(3)}   actual = ${actual}   ${verdict}`
	);
}

// a. Plain read-modify-write — "read it, +1 in JS, write it back".
// If two requests read the same value (say 41) both write 42 — one increment is lost.
// This is called a lost update, and why a transaction alone doesn't prevent it — that is in Lesson 5.5.
async function naive(projectId: number): Promise<void> {
	await Task.create({ title: 'naive', projectId, assigneeId: null });
	const project = await Project.findByPk(projectId);
	if (!project) throw new Error('project missing');
	project.openTaskCount = project.openTaskCount + 1;
	await project.save();
}

// b. Transaction + atomic increment — here Sequelize builds
//    UPDATE projects SET "openTaskCount" = "openTaskCount" + 1 WHERE id = ...
// The DB does the arithmetic itself, holding the row's lock — so nobody can wipe out someone else's write.
// And because of the transaction, creating the task and incrementing the counter — either both happen, or neither.
async function atomic(projectId: number): Promise<void> {
	await sequelize.transaction(async (transaction) => {
		await Task.create({ title: 'atomic', projectId, assigneeId: null }, { transaction });
		await Project.increment('openTaskCount', { by: 1, where: { id: projectId }, transaction });
	});
}

// c. Later someone wrote a new code path — bulk import from CSV — and forgot about
// the counter. Denormalization's most common real-world failure is this: not a race, forgetting.
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
	console.log(`\n  ${CONCURRENT} "create task + counter +1" at once:\n`);

	const a = await freshProject('Naive');
	await Promise.all(Array.from({ length: CONCURRENT }, () => naive(a.id)));
	await report('a. read-modify-write', a.id);

	const b = await freshProject('Atomic');
	await Promise.all(Array.from({ length: CONCURRENT }, () => atomic(b.id)));
	await report('b. transaction + increment', b.id);

	await bulkImport(b.id, 50);
	await report('c. 50 bulk imports after b', b.id);

	const fixed = await reconcile();
	console.log(`\n  ran reconcile() — ${fixed} projects had a wrong counter, fixed:\n`);
	await report('a. (after reconcile)', a.id);
	await report('b+c. (after reconcile)', b.id);
	console.log('');

	await sequelize.close();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('counter failed:', error instanceof Error ? error.message : String(error));
	await sequelize.close();
	process.exit(1);
});
