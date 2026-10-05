import { Sequelize } from 'sequelize';

const DATABASE_URL: string =
	process.env.DATABASE_URL ?? 'postgres://taskflow:taskflow@localhost:5434/taskflow';

export const sequelize = new Sequelize(DATABASE_URL, {
	logging: false,
	// Pool details in Lesson 5.6. Showing counter.ts's race needs more than one
	// connection — with a single connection the queries would line up and run one
	// at a time, and the race would never happen.
	pool: { max: 10, min: 0, idle: 10_000 }
});
