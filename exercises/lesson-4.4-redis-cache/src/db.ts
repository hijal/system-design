import {
	DataTypes,
	Model,
	Sequelize,
	type CreationOptional,
	type InferAttributes,
	type InferCreationAttributes
} from 'sequelize';

const DATABASE_URL: string =
	process.env.DATABASE_URL ?? 'postgres://taskflow:taskflow@localhost:5433/taskflow';

export const sequelize = new Sequelize(DATABASE_URL, {
	logging: false,
	// We will talk about this pool option in detail in Lesson 5.6.
	pool: { max: 10, min: 0, idle: 10_000 }
});

// main.md §6 - a Sequelize model must never be left untyped.
// With InferAttributes / InferCreationAttributes TypeScript knows the model's fields
// by itself, with no separate interface to write.
export class Task extends Model<InferAttributes<Task>, InferCreationAttributes<Task>> {
	declare id: CreationOptional<number>;
	declare userId: number;
	declare title: string;
	declare completed: CreationOptional<boolean>;
}

Task.init(
	{
		id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
		userId: { type: DataTypes.INTEGER, allowNull: false },
		title: { type: DataTypes.STRING, allowNull: false },
		completed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
	},
	{ sequelize, tableName: 'tasks', timestamps: false, indexes: [{ fields: ['userId'] }] }
);
