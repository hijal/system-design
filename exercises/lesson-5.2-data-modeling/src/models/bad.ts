import {
	DataTypes,
	Model,
	type CreationOptional,
	type InferAttributes,
	type InferCreationAttributes
} from 'sequelize';
import { sequelize } from '../db';

// ইচ্ছা করে খারাপ করে বানানো table — একটা "সব কিছু এক জায়গায়" schema, যেটা
// প্রথম দিনে সহজ লাগে। Lesson 5.2 §১.২ এর তিনটা anomaly এখান থেকেই জন্মায়।
//
//   projectName  → project এর তথ্য task এর ভেতরে কপি (delete anomaly)
//   assigneeName → user এর তথ্য task এর ভেতরে কপি (update anomaly)
//   tags         → "bug,urgent" — একটা cell এ একাধিক মান (1NF ভাঙা)
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
