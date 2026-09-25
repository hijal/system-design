import {
	DataTypes,
	Model,
	type CreationOptional,
	type ForeignKey,
	type InferAttributes,
	type InferCreationAttributes,
	type NonAttribute
} from 'sequelize';
import { sequelize } from '../db';

// Normalized schema (3NF) — প্রতিটা তথ্য ঠিক এক জায়গায়:
//
//   users ◄── tasks ──► projects          tasks ◄── task_tags ──► tags
//         assigneeId    projectId                (junction table, M:N)
//
// একমাত্র ব্যতিক্রম projects.openTaskCount — ইচ্ছাকৃত denormalization (§১.৪)।

export type TaskStatus = 'todo' | 'doing' | 'done';

export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
	declare id: CreationOptional<number>;
	declare name: string;
	declare email: string;
}

export class Project extends Model<InferAttributes<Project>, InferCreationAttributes<Project>> {
	declare id: CreationOptional<number>;
	declare name: string;
	// Derived data: tasks table থেকে গুনে বের করা যায়, কিন্তু dashboard দ্রুত করতে
	// আলাদা করে রাখা। Source of truth এখনো tasks table — এটা শুধু তার একটা কপি।
	declare openTaskCount: CreationOptional<number>;
}

export class Task extends Model<InferAttributes<Task>, InferCreationAttributes<Task>> {
	declare id: CreationOptional<number>;
	declare title: string;
	declare status: CreationOptional<TaskStatus>;
	declare projectId: ForeignKey<Project['id']>;
	declare assigneeId: ForeignKey<User['id']> | null;

	// include দিলে Sequelize এগুলো ভরে দেয় — DB column না, তাই NonAttribute
	declare assignee?: NonAttribute<User>;
	declare tags?: NonAttribute<Tag[]>;
}

export class Tag extends Model<InferAttributes<Tag>, InferCreationAttributes<Tag>> {
	declare id: CreationOptional<number>;
	declare name: string;
}

// Junction table — task আর tag এর M:N সম্পর্ক। Composite primary key (taskId, tagId),
// তাই একই task এ একই tag দুইবার বসানো DB নিজেই আটকায়।
export class TaskTag extends Model<InferAttributes<TaskTag>, InferCreationAttributes<TaskTag>> {
	declare taskId: ForeignKey<Task['id']>;
	declare tagId: ForeignKey<Tag['id']>;
}

User.init(
	{
		id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
		name: { type: DataTypes.STRING, allowNull: false },
		email: { type: DataTypes.STRING, allowNull: false, unique: true }
	},
	{ sequelize, tableName: 'users', timestamps: false }
);

Project.init(
	{
		id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
		name: { type: DataTypes.STRING, allowNull: false },
		openTaskCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
	},
	{ sequelize, tableName: 'projects', timestamps: false }
);

Task.init(
	{
		id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
		title: { type: DataTypes.STRING, allowNull: false },
		status: {
			type: DataTypes.ENUM('todo', 'doing', 'done'),
			allowNull: false,
			defaultValue: 'todo'
		}
	},
	{
		sequelize,
		tableName: 'tasks',
		timestamps: false,
		// Foreign key column এ Postgres নিজে থেকে index বানায় না — JOIN আর
		// "এই project এর task" query এর জন্য এটা হাতে দিতে হয় (Lesson 5.4)।
		indexes: [{ fields: ['projectId', 'status'] }, { fields: ['assigneeId'] }]
	}
);

Tag.init(
	{
		id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
		name: { type: DataTypes.STRING, allowNull: false, unique: true }
	},
	{ sequelize, tableName: 'tags', timestamps: false }
);

TaskTag.init(
	{
		taskId: { type: DataTypes.INTEGER, primaryKey: true },
		tagId: { type: DataTypes.INTEGER, primaryKey: true }
	},
	{ sequelize, tableName: 'task_tags', timestamps: false }
);

Project.hasMany(Task, { foreignKey: { name: 'projectId', allowNull: false }, onDelete: 'CASCADE' });
Task.belongsTo(Project, { foreignKey: { name: 'projectId', allowNull: false } });

User.hasMany(Task, { foreignKey: 'assigneeId', onDelete: 'SET NULL' });
Task.belongsTo(User, { as: 'assignee', foreignKey: 'assigneeId' });

Task.belongsToMany(Tag, { through: TaskTag, foreignKey: 'taskId', otherKey: 'tagId' });
Tag.belongsToMany(Task, { through: TaskTag, foreignKey: 'tagId', otherKey: 'taskId' });
