import { Task, sequelize } from './db';

const USER_ID = 7;
const TASK_COUNT = 5_000;

async function main(): Promise<void> {
	await sequelize.sync({ force: true });

	// enough rows that the DB query has a measurable cost —
	// otherwise the difference between the cache and the DB won't even be visible.
	const rows = Array.from({ length: TASK_COUNT }, (_unused, index) => ({
		userId: USER_ID,
		title: `TaskFlow task #${index + 1}`,
		completed: index % 3 === 0
	}));
	await Task.bulkCreate(rows);

	const total = await Task.count({ where: { userId: USER_ID } });
	console.log(`seeded ${total} tasks for user ${USER_ID}`);
	await sequelize.close();
}

main().catch((error: unknown): void => {
	console.error('seed failed:', error instanceof Error ? error.message : String(error));
	process.exit(1);
});
