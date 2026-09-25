import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { sequelize } from './db';

// EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) এর output একটা গাছ — প্রতিটা node এর নিচে
// আরও node (Plans)। এটাও runtime input, তাই Zod দিয়ে parse (main.md §৬)।
// Recursive schema এর জন্য TypeScript এর type আগে লিখে দিতে হয়, z.lazy দিয়ে।
type PlanNode = {
	'Node Type': string;
	'Index Name'?: string | undefined;
	'Scan Direction'?: string | undefined;
	'Actual Rows': number;
	'Shared Hit Blocks': number;
	'Shared Read Blocks': number;
	Plans?: PlanNode[] | undefined;
};

const planNode: z.ZodType<PlanNode> = z.lazy(() =>
	z.object({
		'Node Type': z.string(),
		'Index Name': z.string().optional(),
		'Scan Direction': z.string().optional(),
		'Actual Rows': z.number(),
		'Shared Hit Blocks': z.number(),
		'Shared Read Blocks': z.number(),
		Plans: z.array(planNode).optional()
	})
);

const explainRows = z
	.array(
		z.object({
			'QUERY PLAN': z.array(z.object({ Plan: planNode, 'Execution Time': z.number() })).length(1)
		})
	)
	.length(1);

export type PlanSummary = {
	shape: string; // যেমন "Limit → Index Scan Backward [tasks_project_created]"
	ms: number; // কয়েকবার চালানোর median execution time
	pages: number; // মোট কতগুলো page (৮ KB) ছুঁয়েছে — cache বা disk থেকে
	rows: number; // সবচেয়ে উপরের node কতগুলো row ফেরত দিল
};

function describe(node: PlanNode): string {
	const direction = node['Scan Direction'] === 'Backward' ? ' Backward' : '';
	const index = node['Index Name'] ? ` [${node['Index Name']}]` : '';
	return `${node['Node Type']}${direction}${index}`;
}

// গাছটাকে এক লাইনে: প্রথম শাখা ধরে নিচে নামা। এই lab এর query গুলোতে এটাই যথেষ্ট।
function shape(node: PlanNode): string {
	const parts: string[] = [];
	let current: PlanNode | undefined = node;
	while (current) {
		parts.push(describe(current));
		current = current.Plans?.[0];
	}
	return parts.join(' → ');
}

async function runOnce(sql: string): Promise<{ plan: PlanNode; ms: number }> {
	const result = explainRows.parse(
		await sequelize.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, {
			type: QueryTypes.SELECT
		})
	);
	// .length(1) এর পরেও TypeScript জানে না index 0 আছে (noUncheckedIndexedAccess) —
	// তাই এখানে সৎভাবে যাচাই করা হচ্ছে, `!` দিয়ে চাপা দেওয়া হচ্ছে না।
	const top = result[0]?.['QUERY PLAN'][0];
	if (!top) throw new Error('unexpected EXPLAIN output');
	return { plan: top.Plan, ms: top['Execution Time'] };
}

export async function explain(sql: string, runs = 5): Promise<PlanSummary> {
	await runOnce(sql); // warm-up — page গুলো buffer pool এ আনা (Lesson 4.1, 5.3)
	const samples: { plan: PlanNode; ms: number }[] = [];
	for (let i = 0; i < runs; i++) samples.push(await runOnce(sql));
	samples.sort((a, b) => a.ms - b.ms);
	const median = samples[Math.floor(samples.length / 2)];
	if (!median) throw new Error('no samples');
	return {
		shape: shape(median.plan),
		ms: median.ms,
		pages: median.plan['Shared Hit Blocks'] + median.plan['Shared Read Blocks'],
		rows: median.plan['Actual Rows']
	};
}
