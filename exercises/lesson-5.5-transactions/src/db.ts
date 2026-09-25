import {
	DataTypes,
	Model,
	Sequelize,
	type CreationOptional,
	type InferAttributes,
	type InferCreationAttributes
} from 'sequelize';

const DATABASE_URL: string =
	process.env.DATABASE_URL ?? 'postgres://taskflow:taskflow@localhost:5436/taskflow';

// Pool এ ১০টা connection — দুটো transaction সত্যিই একসাথে চলতে হলে দুটো আলাদা
// connection লাগে। একটা transaction পুরো সময় তার connection ধরে রাখে (Lesson 5.6)।
export const sequelize = new Sequelize(DATABASE_URL, {
	logging: false,
	pool: { max: 10, min: 0, idle: 10_000 }
});

export class Project extends Model<InferAttributes<Project>, InferCreationAttributes<Project>> {
	declare id: CreationOptional<number>;
	declare name: string;
	declare openTaskCount: CreationOptional<number>;
	// Optimistic locking এর জন্য — `version: true` দিলে Sequelize প্রতিটা save এ এটা মিলিয়ে
	// দেখে আর এক বাড়ায় (lostupdate.ts এর কৌশল ৬)
	declare version: CreationOptional<number>;
}

export class Task extends Model<InferAttributes<Task>, InferCreationAttributes<Task>> {
	declare id: CreationOptional<number>;
	declare projectId: number;
	declare title: string;
}

export type MemberRole = 'admin' | 'member';

export class Member extends Model<InferAttributes<Member>, InferCreationAttributes<Member>> {
	declare id: CreationOptional<number>;
	declare projectId: number;
	declare name: string;
	declare role: MemberRole;
}

Project.init(
	{
		id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
		name: { type: DataTypes.STRING, allowNull: false },
		openTaskCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
		version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
	},
	{ sequelize, tableName: 'projects', timestamps: false, version: true }
);

Task.init(
	{
		id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
		projectId: { type: DataTypes.INTEGER, allowNull: false },
		title: { type: DataTypes.STRING, allowNull: false }
	},
	{ sequelize, tableName: 'tasks', timestamps: false }
);

Member.init(
	{
		id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
		projectId: { type: DataTypes.INTEGER, allowNull: false },
		name: { type: DataTypes.STRING, allowNull: false },
		role: { type: DataTypes.ENUM('admin', 'member'), allowNull: false }
	},
	{ sequelize, tableName: 'members', timestamps: false }
);

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
