import { QueryTypes } from 'sequelize';
import { sequelize } from './db';

// Counter টা source of truth (tasks table) থেকে নতুন করে হিসাব করা।
// Production এ এটাই "reconciliation job" — নিয়মিত (যেমন প্রতি রাতে) চালিয়ে counter drift
// ধরা আর ঠিক করা। Lesson 5.2 §১.৫ দেখো।
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
	// QueryTypes.UPDATE দিলে দ্বিতীয় মানটা হয় কয়টা row বদলেছে — মানে কয়টা counter ভুল ছিল।
	// শুধু ভুলগুলোই বদলানো হয় (WHERE ... <> fresh.open), তাই সংখ্যাটা drift এর মাপ।
	return affected;
}
