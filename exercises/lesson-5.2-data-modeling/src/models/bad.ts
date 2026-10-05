import {
	DataTypes,
	Model,
	type CreationOptional,
	type InferAttributes,
	type InferCreationAttributes
} from 'sequelize';
import { sequelize } from '../db';

// A table built badly on purpose — an "everything in one place" schema, which
// feels easy on day one. Lesson 5.2 §1.2's three anomalies are born here.
//
//   projectName  → project data copied into the task (delete anomaly)
//   assigneeName → user data copied into the task (update anomaly)
//   tags         → "bug,urgent" — several values in one cell (1NF broken)
export class BadTask extends Model<InferAttributes<BadTask>, InferCreationAttributes<BadTask>> {
	declare id: CreationOptional<number>;
	declare title: string;
	declare projectName: string;
	declare assigneeEmail: string;
	declare assigneeName: string;
	declare tags: string;
}

BadTask.init(
	{
		id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
		title: { type: DataTypes.STRING, allowNull: false },
		projectName: { type: DataTypes.STRING, allowNull: false },
		assigneeEmail: { type: DataTypes.STRING, allowNull: false },
		assigneeName: { type: DataTypes.STRING, allowNull: false },
		tags: { type: DataTypes.STRING, allowNull: false, defaultValue: '' }
	},
	{ sequelize, tableName: 'bad_tasks', timestamps: false }
);
