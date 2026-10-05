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

// Normalized schema (3NF) — every fact in exactly one place:
//
//   users ◄── tasks ──► projects          tasks ◄── task_tags ──► tags
//         assigneeId    projectId                (junction table, M:N)
//
// The only exception is projects.openTaskCount — deliberate denormalization (§1.4).

export type TaskStatus = 'todo' | 'doing' | 'done';

export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
	declare id: CreationOptional<number>;
	declare name: string;
	declare email: string;
}

export class Project extends Model<InferAttributes<Project>, InferCreationAttributes<Project>> {
	declare id: CreationOptional<number>;
	declare name: string;
	// Derived data: it can be counted from the tasks table, but it is kept separately
	// to make the dashboard fast. The source of truth is still the tasks table — this is just a copy of it.
	declare openTaskCount: CreationOptional<number>;
}

export class Task extends Model<InferAttributes<Task>, InferCreationAttributes<Task>> {
	declare id: CreationOptional<number>;
	declare title: string;
	declare status: CreationOptional<TaskStatus>;
	declare projectId: ForeignKey<Project['id']>;
	declare assigneeId: ForeignKey<User['id']> | null;

	// Sequelize fills these in with include — they are not DB columns, hence NonAttribute
	declare assignee?: NonAttribute<User>;
	declare tags?: NonAttribute<Tag[]>;
}

export class Tag extends Model<InferAttributes<Tag>, InferCreationAttributes<Tag>> {
	declare id: CreationOptional<number>;
	declare name: string;
}

// Junction table — the M:N relationship between task and tag. Composite primary key (taskId, tagId),
// so the DB itself prevents the same tag being put on the same task twice.
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
		// Postgres doesn't create an index on a foreign key column by itself — for JOINs and
		// "this project's tasks" queries it has to be added by hand (Lesson 5.4).
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
