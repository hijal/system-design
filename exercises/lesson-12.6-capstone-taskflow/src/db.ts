import {
	DataTypes,
	Model,
	Sequelize,
	type CreationOptional,
	type InferAttributes,
	type InferCreationAttributes
} from 'sequelize';
import { config } from './config';

export const sequelize = new Sequelize(config.DATABASE_URL, {
	logging: false,
	pool: { max: 10, min: 0, idle: 10_000 },
	define: { underscored: true }
});

export class Task extends Model<InferAttributes<Task>, InferCreationAttributes<Task>> {
	declare id: CreationOptional<number>;
	declare boardId: number;
	declare title: string;
	declare column: string;
	declare position: number;
	declare assigneeId: string | null;
	declare version: CreationOptional<number>;
	declare createdAt: CreationOptional<Date>;
	declare updatedAt: CreationOptional<Date>;
}

export class IdempotencyKey extends Model<
	InferAttributes<IdempotencyKey>,
	InferCreationAttributes<IdempotencyKey>
> {
	declare key: string;
	declare requestHash: string;
	declare statusCode: number;
	declare responseBody: object;
	declare createdAt: CreationOptional<Date>;
}

export class OutboxEvent extends Model<
	InferAttributes<OutboxEvent>,
	InferCreationAttributes<OutboxEvent>
> {
	declare id: CreationOptional<number>;
	declare eventId: string;
	declare type: string;
	declare taskId: number;
	declare payload: object;
	declare createdAt: CreationOptional<Date>;
	declare publishedAt: Date | null;
}

export class Notification extends Model<
	InferAttributes<Notification>,
	InferCreationAttributes<Notification>
> {
	declare eventId: string;
	declare taskId: number;
	declare recipientId: string;
	declare status: 'pending' | 'sent';
	declare createdAt: CreationOptional<Date>;
}

Task.init(
	{
		id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
		boardId: { type: DataTypes.INTEGER, allowNull: false },
		title: { type: DataTypes.STRING(200), allowNull: false },
		column: { type: DataTypes.STRING(40), allowNull: false },
		position: { type: DataTypes.INTEGER, allowNull: false },
		assigneeId: { type: DataTypes.STRING(40), allowNull: true },
		version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
		createdAt: DataTypes.DATE,
		updatedAt: DataTypes.DATE
	},
	{
		sequelize,
		tableName: 'tasks',
		indexes: [{ fields: ['board_id', 'column', 'position'] }]
	}
);

IdempotencyKey.init(
	{
		key: { type: DataTypes.STRING(100), primaryKey: true },
		requestHash: { type: DataTypes.STRING(64), allowNull: false },
		statusCode: { type: DataTypes.INTEGER, allowNull: false },
		responseBody: { type: DataTypes.JSONB, allowNull: false },
		createdAt: DataTypes.DATE
	},
	{ sequelize, tableName: 'idempotency_keys', updatedAt: false }
);

OutboxEvent.init(
	{
		id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
		eventId: { type: DataTypes.UUID, allowNull: false, unique: true },
		type: { type: DataTypes.STRING(40), allowNull: false },
		taskId: { type: DataTypes.INTEGER, allowNull: false },
		payload: { type: DataTypes.JSONB, allowNull: false },
		createdAt: DataTypes.DATE,
		publishedAt: { type: DataTypes.DATE, allowNull: true }
	},
	{
		sequelize,
		tableName: 'outbox_events',
		updatedAt: false,
		indexes: [{ fields: ['id'], where: { published_at: null }, name: 'outbox_unpublished' }]
	}
);

Notification.init(
	{
		eventId: { type: DataTypes.UUID, primaryKey: true },
		taskId: { type: DataTypes.INTEGER, allowNull: false },
		recipientId: { type: DataTypes.STRING(40), allowNull: false },
		status: { type: DataTypes.STRING(10), allowNull: false },
		createdAt: DataTypes.DATE
	},
	{ sequelize, tableName: 'notifications', updatedAt: false }
);

export async function resetDatabase(): Promise<void> {
	await sequelize.sync({ force: true });
}
