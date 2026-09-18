import { Task, sequelize } from './db';

const USER_ID = 7;
const TASK_COUNT = 5_000;

async function main(): Promise<void> {
	await sequelize.sync({ force: true });

	// যথেষ্ট row, যাতে DB query টার একটা মাপার মতো খরচ থাকে —
	// নাহলে cache আর DB এর পার্থক্য চোখেই পড়বে না।
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
