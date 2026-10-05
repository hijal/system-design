import { QueryTypes } from 'sequelize';
import { sequelize } from './db';

// Recomputing the counter from the source of truth (the tasks table).
// In production this is the "reconciliation job" — run regularly (say every night) to catch and fix
// counter drift. See Lesson 5.2 §1.5.
export async function reconcile(): Promise<number> {
	const [, affected] = await sequelize.query(
		`UPDATE projects p SET "openTaskCount" = fresh.open
		 FROM (
		   SELECT p2.id, count(t.id) AS open
		   FROM projects p2
		   LEFT JOIN tasks t ON t."projectId" = p2.id AND t.status <> 'done'
		   GROUP BY p2.id
		 ) fresh
		 WHERE fresh.id = p.id AND p."openTaskCount" <> fresh.open`,
		{ type: QueryTypes.UPDATE }
	);
	// With QueryTypes.UPDATE the second value is how many rows changed — i.e. how many counters were wrong.
	// Only the wrong ones are changed (WHERE ... <> fresh.open), so the number is a measure of the drift.
	return affected;
}
