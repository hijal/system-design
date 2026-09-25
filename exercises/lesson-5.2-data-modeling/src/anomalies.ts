import { Op, QueryTypes } from 'sequelize';
import { z } from 'zod';
import { sequelize } from './db';
import { BadTask } from './models/bad';
import { Project, Tag, Task, TaskTag, User } from './models/good';

// Lesson 5.2 §১.২ — একই তিনটা কাজ দুটো schema তে করে দেখা:
//   ১. Rahim নিজের নাম বদলাল        (update anomaly)
//   ২. "bug" tag এর সব task খোঁজো   (1NF ভাঙা)
//   ৩. একটা project এর শেষ task মুছলাম (delete anomaly)

// Raw query এর ফলাফল runtime input — Zod দিয়ে parse করা হয় (main.md §৬)
const nameRows = z.array(z.object({ assigneeName: z.string() }));
const projectRows = z.array(z.object({ projectName: z.string() }));

function heading(text: string): void {
	console.log(`\n━━ ${text} ${'━'.repeat(Math.max(0, 60 - text.length))}`);
}

async function denormalized(): Promise<void> {
	heading('Denormalized (bad_tasks) — সব এক table এ');

	await BadTask.bulkCreate([
		{
			title: 'Login bug ঠিক করো',
			projectName: 'Website',
			assigneeEmail: 'rahim@taskflow.app',
			assigneeName: 'Rahim',
			tags: 'bug,urgent'
		},
		{
			title: 'Logging যোগ করো',
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

	// ১. Update anomaly — profile page এর code শুধু "এই task টা" update করল,
	// কারণ নামটা যে আরও অনেক row এ কপি হয়ে আছে সেটা কেউ মনে রাখেনি।
	await BadTask.update({ assigneeName: 'Rahim Uddin' }, { where: { id: 1 } });
	const names = nameRows.parse(
		await sequelize.query(
			`SELECT DISTINCT "assigneeName" FROM bad_tasks WHERE "assigneeEmail" = 'rahim@taskflow.app'`,
			{ type: QueryTypes.SELECT }
		)
	);
	console.log(
		`১. rahim@taskflow.app এর নাম কয়টা?    ${names.length} টা → ${names.map((n) => `"${n.assigneeName}"`).join(', ')}`
	);

	// ২. 1NF ভাঙা — "bug,urgent" একটা string, তাই খুঁজতে হয় LIKE দিয়ে।
	// "debug" এর ভেতরেও "bug" আছে।
	const bugTasks = await BadTask.findAll({ where: { tags: { [Op.like]: '%bug%' } } });
	console.log(
		`২. "bug" tag এর task কয়টা?           ${bugTasks.length} টা → ${bugTasks.map((t) => `"${t.title}"`).join(', ')}`
	);

	// ৩. Delete anomaly — Marketing project এর একমাত্র task মুছলাম।
	await BadTask.destroy({ where: { projectName: 'Marketing' } });
	const projects = projectRows.parse(
		await sequelize.query(`SELECT DISTINCT "projectName" FROM bad_tasks ORDER BY 1`, {
			type: QueryTypes.SELECT
		})
	);
	console.log(
		`৩. Task মোছার পর project কয়টা?       ${projects.length} টা → ${projects.map((p) => p.projectName).join(', ')}  (Marketing উধাও!)`
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
		title: 'Login bug ঠিক করো',
		projectId: website.id,
		assigneeId: rahim.id
	});
	const logging = await Task.create({
		title: 'Logging যোগ করো',
		projectId: website.id,
		assigneeId: rahim.id
	});
	const campaign = await Task.create({
		title: 'Q3 campaign plan',
		projectId: marketing.id,
		assigneeId: karim.id
	});
	// belongsToMany দিলে Sequelize runtime এ `task.addTag()` জাতীয় method যোগ করে,
	// কিন্তু declare না করলে type এ দেখায় না — তাই junction table এ সরাসরি লেখা হচ্ছে।
	await TaskTag.bulkCreate([
		{ taskId: login.id, tagId: bug.id },
		{ taskId: login.id, tagId: urgent.id },
		{ taskId: logging.id, tagId: debugTag.id },
		{ taskId: campaign.id, tagId: planning.id }
	]);

	// ১. নাম বদলানো — একটাই জায়গায়, একটাই row
	await User.update({ name: 'Rahim Uddin' }, { where: { id: rahim.id } });
	const rahimTasks = await Task.findAll({
		where: { assigneeId: rahim.id },
		include: [{ model: User, as: 'assignee' }]
	});
	const seen = [...new Set(rahimTasks.map((t) => t.assignee?.name ?? '?'))];
	console.log(
		`১. rahim@taskflow.app এর নাম কয়টা?    ${seen.length} টা → ${seen.map((n) => `"${n}"`).join(', ')}`
	);

	// ২. Tag খোঁজা — junction table দিয়ে exact match, LIKE না
	const bugTasks = await Task.findAll({
		include: [{ model: Tag, where: { name: 'bug' } }]
	});
	console.log(
		`২. "bug" tag এর task কয়টা?           ${bugTasks.length} টা → ${bugTasks.map((t) => `"${t.title}"`).join(', ')}`
	);

	// ৩. Marketing এর একমাত্র task মুছলাম — project নিজে আলাদা row, তাই টিকে থাকে
	await Task.destroy({ where: { id: campaign.id } });
	const allProjects = await Project.findAll({ order: [['name', 'ASC']] });
	console.log(
		`৩. Task মোছার পর project কয়টা?       ${allProjects.length} টা → ${allProjects.map((p) => p.name).join(', ')}`
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
