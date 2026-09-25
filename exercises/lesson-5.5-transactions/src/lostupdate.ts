import { performance } from 'node:perf_hooks';
import { Transaction } from 'sequelize';
import { Project, sequelize } from './db';
import { withRetry, type RetryStats } from './retry';

// Lesson 5.5 §১.৬ — Lesson 5.2 এর counter race, এবার সাতটা কৌশলে।
// প্রতিটা কৌশলে ১০০টা "counter +1" একসাথে। শেষ মান ১০০ হলে সঠিক।

const CONCURRENT = 100;
const { READ_COMMITTED, REPEATABLE_READ, SERIALIZABLE } = Transaction.ISOLATION_LEVELS;

type Strategy = {
	label: string;
	increment: (projectId: number, stats: RetryStats) => Promise<void>;
};

const strategies: Strategy[] = [
	{
		// Lesson 5.2 এর (ক) — কোনো transaction নেই
		label: '১. read-modify-write, transaction ছাড়া',
		// Static Project.update — instance এর save() দিলে `version: true` এর কারণে Sequelize
		// নিজেই optimistic check করত (কৌশল ৬), তখন এটা আর "naive" থাকত না।
		increment: async (projectId) => {
			const p = await Project.findByPk(projectId);
			if (!p) throw new Error('missing');
			await Project.update({ openTaskCount: p.openTaskCount + 1 }, { where: { id: projectId } });
		}
	},
	{
		// Lesson 5.2 এর experiment ৩ — "transaction দিলেই তো নিরাপদ?"
		label: '২. একই, READ COMMITTED transaction এ',
		increment: (projectId) =>
			sequelize.transaction({ isolationLevel: READ_COMMITTED }, async (transaction) => {
				const p = await Project.findByPk(projectId, { transaction });
				if (!p) throw new Error('missing');
				await Project.update(
					{ openTaskCount: p.openTaskCount + 1 },
					{ where: { id: projectId }, transaction }
				);
			})
	},
	{
		// Pessimistic — পড়ার সময়েই row lock (SELECT ... FOR UPDATE)
		label: '৩. SELECT ... FOR UPDATE',
		increment: (projectId) =>
			sequelize.transaction({ isolationLevel: READ_COMMITTED }, async (transaction) => {
				const p = await Project.findByPk(projectId, { transaction, lock: transaction.LOCK.UPDATE });
				if (!p) throw new Error('missing');
				await Project.update(
					{ openTaskCount: p.openTaskCount + 1 },
					{ where: { id: projectId }, transaction }
				);
			})
	},
	{
		// হিসাবটা database কে দিয়ে দাও — SET x = x + 1 (Lesson 5.2 এর (খ))
		label: '৪. atomic UPDATE … SET x = x + 1',
		increment: async (projectId) => {
			await Project.increment('openTaskCount', { by: 1, where: { id: projectId } });
		}
	},
	{
		// Snapshot isolation — সংঘাত হলে Postgres error দেয়, আমরা পুরোটা আবার চালাই
		label: '৫. REPEATABLE READ + retry',
		increment: (projectId, stats) =>
			withRetry(
				() =>
					sequelize.transaction({ isolationLevel: REPEATABLE_READ }, async (transaction) => {
						const p = await Project.findByPk(projectId, { transaction });
						if (!p) throw new Error('missing');
						await Project.update(
							{ openTaskCount: p.openTaskCount + 1 },
							{ where: { id: projectId }, transaction }
						);
					}),
				stats
			)
	},
	{
		// Optimistic — lock নেই; লেখার সময় version মিলিয়ে দেখা (`version: true` model এ)
		// Sequelize বানায়: UPDATE ... SET version = version + 1 WHERE id = ? AND version = ?
		label: '৬. optimistic locking (version) + retry',
		increment: (projectId, stats) =>
			withRetry(async () => {
				const p = await Project.findByPk(projectId);
				if (!p) throw new Error('missing');
				p.openTaskCount = p.openTaskCount + 1;
				await p.save();
			}, stats)
	},
	{
		label: '৭. SERIALIZABLE + retry',
		increment: (projectId, stats) =>
			withRetry(
				() =>
					sequelize.transaction({ isolationLevel: SERIALIZABLE }, async (transaction) => {
						const p = await Project.findByPk(projectId, { transaction });
						if (!p) throw new Error('missing');
						await Project.update(
							{ openTaskCount: p.openTaskCount + 1 },
							{ where: { id: projectId }, transaction }
						);
					}),
				stats
			)
	}
];

async function main(): Promise<void> {
	await sequelize.sync({ force: true });
	console.log(`\n  প্রতিটা কৌশলে ${CONCURRENT}টা "counter +1" একসাথে (pool: ১০ connection):\n`);
	console.log(`  ${'কৌশল'.padEnd(40)}  শেষ মান      retry      সময়`);

	for (const strategy of strategies) {
		const project = await Project.create({ name: strategy.label });
		const stats: RetryStats = { retries: 0 };
		const started = performance.now();
		await Promise.all(
			Array.from({ length: CONCURRENT }, () => strategy.increment(project.id, stats))
		);
		const ms = performance.now() - started;
		const final = (await Project.findByPk(project.id))?.openTaskCount ?? -1;
		const mark = final === CONCURRENT ? '✓' : '✗';
		console.log(
			`  ${strategy.label.padEnd(40)}  ${mark} ${String(final).padStart(3)}/${CONCURRENT}  ${String(stats.retries).padStart(7)}  ${ms.toFixed(0).padStart(6)} ms`
		);
	}
	console.log('');
	await sequelize.close();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('lostupdate failed:', error instanceof Error ? error.message : String(error));
	await sequelize.close();
	process.exit(1);
});
