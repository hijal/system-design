import { Sequelize } from 'sequelize';

const DATABASE_URL: string =
	process.env.DATABASE_URL ?? 'postgres://taskflow:taskflow@localhost:5435/taskflow';

export const sequelize = new Sequelize(DATABASE_URL, { logging: false });

// Lab এর প্রতিটা ধাপ শুরু হয় একদম খালি অবস্থা থেকে — primary key ছাড়া কোনো index নেই।
// তাই আগের ধাপের index পরের ধাপের ফলাফল ঘোলা করে না।
export async function dropSecondaryIndexes(): Promise<void> {
	await sequelize.query(`
		DO $$
		DECLARE r record;
		BEGIN
			FOR r IN SELECT indexname FROM pg_indexes
			         WHERE tablename = 'tasks' AND indexname <> 'tasks_pkey'
			LOOP
				EXECUTE format('DROP INDEX %I', r.indexname);
			END LOOP;
		END $$;
	`);
}
