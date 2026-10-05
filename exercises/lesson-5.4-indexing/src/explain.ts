import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { sequelize } from './db';

// The output of EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) is a tree — under every node
// more nodes (Plans). This is runtime input too, so it is parsed with Zod (main.md §6).
// A recursive schema needs the TypeScript type written first, with z.lazy.
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
	shape: string; // e.g. "Limit → Index Scan Backward [tasks_project_created]"
	ms: number; // the median execution time over several runs
	pages: number; // how many pages (8 KB) were touched in total — from cache or disk
	rows: number; // how many rows the topmost node returned
};

function describe(node: PlanNode): string {
	const direction = node['Scan Direction'] === 'Backward' ? ' Backward' : '';
	const index = node['Index Name'] ? ` [${node['Index Name']}]` : '';
	return `${node['Node Type']}${direction}${index}`;
}

// The tree on one line: walking down the first branch. That is enough for this lab's queries.
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
	// Even after .length(1) TypeScript doesn't know index 0 exists (noUncheckedIndexedAccess) —
	// so it is checked honestly here, not silenced with `!`.
	const top = result[0]?.['QUERY PLAN'][0];
	if (!top) throw new Error('unexpected EXPLAIN output');
	return { plan: top.Plan, ms: top['Execution Time'] };
}

export async function explain(sql: string, runs = 5): Promise<PlanSummary> {
	await runOnce(sql); // warm-up — bringing the pages into the buffer pool (Lesson 4.1, 5.3)
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
