import { performance } from 'node:perf_hooks';
import { Transaction } from 'sequelize';
import { Project, sequelize } from './db';
import { withRetry, type RetryStats } from './retry';

// Lesson 5.5 §1.6 - Lesson 5.2's counter race, now with seven strategies.
// Each strategy runs 100 "counter +1" at once. A final value of 100 means correct.

const CONCURRENT = 100;
const { READ_COMMITTED, REPEATABLE_READ, SERIALIZABLE } = Transaction.ISOLATION_LEVELS;

type Strategy = {
	label: string;
	increment: (projectId: number, stats: RetryStats) => Promise<void>;
};

const strategies: Strategy[] = [
	{
		// Lesson 5.2's (a) - no transaction
		label: '1. read-modify-write, no transaction',
		// Static Project.update - with the instance's save() Sequelize would do an optimistic check itself
		// because of `version: true` (strategy 6), and then this would no longer be "naive".
		increment: async (projectId) => {
			const p = await Project.findByPk(projectId);
			if (!p) throw new Error('missing');
			await Project.update({ openTaskCount: p.openTaskCount + 1 }, { where: { id: projectId } });
		}
	},
	{
		// Lesson 5.2's experiment 3 - "surely a transaction makes it safe?"
		label: '2. same, in a READ COMMITTED transaction',
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
		// Pessimistic - a row lock at read time (SELECT ... FOR UPDATE)
		label: '3. SELECT ... FOR UPDATE',
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
		// hand the arithmetic to the database - SET x = x + 1 (Lesson 5.2's (b))
		label: '4. atomic UPDATE … SET x = x + 1',
		increment: async (projectId) => {
			await Project.increment('openTaskCount', { by: 1, where: { id: projectId } });
		}
	},
	{
		// Snapshot isolation - on a conflict Postgres raises an error, and we rerun the whole thing
		label: '5. REPEATABLE READ + retry',
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
		// Optimistic - no lock; the version is checked at write time (`version: true` on the model)
		// Sequelize builds: UPDATE ... SET version = version + 1 WHERE id = ? AND version = ?
		label: '6. optimistic locking (version) + retry',
		increment: (projectId, stats) =>
			withRetry(async () => {
				const p = await Project.findByPk(projectId);
				if (!p) throw new Error('missing');
				p.openTaskCount = p.openTaskCount + 1;
				await p.save();
			}, stats)
	},
	{
		label: '7. SERIALIZABLE + retry',
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
	console.log(`\n  ${CONCURRENT} "counter +1" at once for each strategy (pool: 10 connections):\n`);
	console.log(`  ${'strategy'.padEnd(40)}final value  retries      time`);

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
