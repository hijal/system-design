import { Op, QueryTypes } from 'sequelize';
import { z } from 'zod';
import { sequelize } from './db';
import { BadTask } from './models/bad';
import { Project, Tag, Task, TaskTag, User } from './models/good';

// Lesson 5.2 §1.2 — doing the same three things on two schemas:
//   1. Rahim changed his name          (update anomaly)
//   2. find every task with the "bug" tag   (1NF broken)
//   3. deleted a project's last task   (delete anomaly)

// The result of a raw query is runtime input — parsed with Zod (main.md §6)
const nameRows = z.array(z.object({ assigneeName: z.string() }));
const projectRows = z.array(z.object({ projectName: z.string() }));

function heading(text: string): void {
	console.log(`\n━━ ${text} ${'━'.repeat(Math.max(0, 60 - text.length))}`);
}

async function denormalized(): Promise<void> {
	heading('Denormalized (bad_tasks) — everything in one table');

	await BadTask.bulkCreate([
		{
			title: 'Fix the login bug',
			projectName: 'Website',
			assigneeEmail: 'rahim@taskflow.app',
			assigneeName: 'Rahim',
			tags: 'bug,urgent'
		},
		{
			title: 'Add logging',
			projectName: 'Website',
			assigneeEmail: 'rahim@taskflow.app',
			assigneeName: 'Rahim',
			tags: 'debug'
		},
		{
			title: 'Q3 campaign plan',
			projectName: 'Marketing',
			assigneeEmail: 'karim@taskflow.app',
			assigneeName: 'Karim',
			tags: 'planning'
		}
	]);

	// 1. Update anomaly — the profile page code updated only "this task",
	// because nobody remembered the name is copied into many more rows.
	await BadTask.update({ assigneeName: 'Rahim Uddin' }, { where: { id: 1 } });
	const names = nameRows.parse(
		await sequelize.query(
			`SELECT DISTINCT "assigneeName" FROM bad_tasks WHERE "assigneeEmail" = 'rahim@taskflow.app'`,
			{ type: QueryTypes.SELECT }
		)
	);
	console.log(
		`1. How many names does rahim@taskflow.app have?  ${names.length} → ${names.map((n) => `"${n.assigneeName}"`).join(', ')}`
	);

	// 2. 1NF broken — "bug,urgent" is one string, so searching needs LIKE.
	// "debug" contains "bug" too.
	const bugTasks = await BadTask.findAll({ where: { tags: { [Op.like]: '%bug%' } } });
	console.log(
		`2. How many tasks with the "bug" tag?            ${bugTasks.length} → ${bugTasks.map((t) => `"${t.title}"`).join(', ')}`
	);

	// 3. Delete anomaly — deleted the Marketing project's only task.
	await BadTask.destroy({ where: { projectName: 'Marketing' } });
	const projects = projectRows.parse(
		await sequelize.query(`SELECT DISTINCT "projectName" FROM bad_tasks ORDER BY 1`, {
			type: QueryTypes.SELECT
		})
	);
	console.log(
		`3. How many projects after deleting the task?    ${projects.length} → ${projects.map((p) => p.projectName).join(', ')}  (Marketing is gone!)`
	);
}

async function normalized(): Promise<void> {
	heading('Normalized (users / projects / tasks / tags)');

	const [rahim, karim] = await User.bulkCreate([
		{ name: 'Rahim', email: 'rahim@taskflow.app' },
		{ name: 'Karim', email: 'karim@taskflow.app' }
	]);
	const [website, marketing] = await Project.bulkCreate([
		{ name: 'Website' },
		{ name: 'Marketing' }
	]);
	const [bug, urgent, debugTag, planning] = await Tag.bulkCreate([
		{ name: 'bug' },
		{ name: 'urgent' },
		{ name: 'debug' },
		{ name: 'planning' }
	]);
	if (!rahim || !karim || !website || !marketing || !bug || !urgent || !debugTag || !planning) {
		throw new Error('seed failed');
	}

	const login = await Task.create({
		title: 'Fix the login bug',
		projectId: website.id,
		assigneeId: rahim.id
	});
	const logging = await Task.create({
		title: 'Add logging',
		projectId: website.id,
		assigneeId: rahim.id
	});
	const campaign = await Task.create({
		title: 'Q3 campaign plan',
		projectId: marketing.id,
		assigneeId: karim.id
	});
	// With belongsToMany Sequelize adds methods like `task.addTag()` at runtime,
	// but without declare they don't show in the type — so the junction table is written directly.
	await TaskTag.bulkCreate([
		{ taskId: login.id, tagId: bug.id },
		{ taskId: login.id, tagId: urgent.id },
		{ taskId: logging.id, tagId: debugTag.id },
		{ taskId: campaign.id, tagId: planning.id }
	]);

	// 1. changing the name — in one place, one row
	await User.update({ name: 'Rahim Uddin' }, { where: { id: rahim.id } });
	const rahimTasks = await Task.findAll({
		where: { assigneeId: rahim.id },
		include: [{ model: User, as: 'assignee' }]
	});
	const seen = [...new Set(rahimTasks.map((t) => t.assignee?.name ?? '?'))];
	console.log(
		`1. How many names does rahim@taskflow.app have?  ${seen.length} → ${seen.map((n) => `"${n}"`).join(', ')}`
	);

	// 2. searching by tag — an exact match through the junction table, not LIKE
	const bugTasks = await Task.findAll({
		include: [{ model: Tag, where: { name: 'bug' } }]
	});
	console.log(
		`2. How many tasks with the "bug" tag?            ${bugTasks.length} → ${bugTasks.map((t) => `"${t.title}"`).join(', ')}`
	);

	// 3. deleted Marketing's only task — the project itself is a separate row, so it survives
	await Task.destroy({ where: { id: campaign.id } });
	const allProjects = await Project.findAll({ order: [['name', 'ASC']] });
	console.log(
		`3. How many projects after deleting the task?    ${allProjects.length} → ${allProjects.map((p) => p.name).join(', ')}`
	);
}

async function main(): Promise<void> {
	await sequelize.sync({ force: true });
	await denormalized();
	await normalized();
	console.log('');
	await sequelize.close();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('anomalies failed:', error instanceof Error ? error.message : String(error));
	await sequelize.close();
	process.exit(1);
});
