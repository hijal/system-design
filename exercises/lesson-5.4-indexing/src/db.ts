import { Sequelize } from 'sequelize';

const DATABASE_URL: string =
	process.env.DATABASE_URL ?? 'postgres://taskflow:taskflow@localhost:5435/taskflow';

export const sequelize = new Sequelize(DATABASE_URL, { logging: false });

// Every step of the lab starts from a completely clean state - no index except the primary key.
// So an earlier step's index doesn't muddy a later step's result.
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
