import {
	DataTypes,
	Model,
	type CreationOptional,
	type ForeignKey,
	type InferAttributes,
	type InferCreationAttributes,
	type NonAttribute,
	type Sequelize
} from 'sequelize';

// Lesson 5.2 এর normalized TaskFlow schema এর ছোট রূপ।
export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
	declare id: CreationOptional<number>;
	declare name: string;
}

export class Project extends Model<InferAttributes<Project>, InferCreationAttributes<Project>> {
	declare id: CreationOptional<number>;
	declare name: string;
	declare tasks?: NonAttribute<Task[]>;
	declare members?: NonAttribute<Member[]>;
}

export class Task extends Model<InferAttributes<Task>, InferCreationAttributes<Task>> {
	declare id: CreationOptional<number>;
	declare title: string;
	declare projectId: ForeignKey<Project['id']>;
	declare assigneeId: ForeignKey<User['id']>;
	declare assignee?: NonAttribute<User>;
}

export class Member extends Model<InferAttributes<Member>, InferCreationAttributes<Member>> {
	declare id: CreationOptional<number>;
	declare projectId: ForeignKey<Project['id']>;
	declare userId: ForeignKey<User['id']>;
}

export function initModels(sequelize: Sequelize): void {
	const id = { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true };
	User.init(
		{ id, name: { type: DataTypes.STRING, allowNull: false } },
		{ sequelize, tableName: 'users', timestamps: false }
	);
	Project.init(
		{ id, name: { type: DataTypes.STRING, allowNull: false } },
		{ sequelize, tableName: 'projects', timestamps: false }
	);
	Task.init(
		{ id, title: { type: DataTypes.STRING, allowNull: false } },
		{ sequelize, tableName: 'tasks', timestamps: false, indexes: [{ fields: ['projectId'] }] }
	);
	Member.init(
		{ id },
		{ sequelize, tableName: 'members', timestamps: false, indexes: [{ fields: ['projectId'] }] }
	);

	Project.hasMany(Task, { as: 'tasks', foreignKey: { name: 'projectId', allowNull: false } });
	Task.belongsTo(Project, { foreignKey: { name: 'projectId', allowNull: false } });
	Task.belongsTo(User, { as: 'assignee', foreignKey: { name: 'assigneeId', allowNull: false } });
	Project.hasMany(Member, { as: 'members', foreignKey: { name: 'projectId', allowNull: false } });
	Member.belongsTo(User, { foreignKey: { name: 'userId', allowNull: false } });
}
