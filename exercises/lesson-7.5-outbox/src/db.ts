import {
	DataTypes,
	Model,
	Sequelize,
	type CreationOptional,
	type InferAttributes,
	type InferCreationAttributes
} from 'sequelize';

const DATABASE_URL: string =
	process.env.DATABASE_URL ?? 'postgres://taskflow:taskflow@localhost:5443/taskflow';

export const sequelize = new Sequelize(DATABASE_URL, {
	logging: false,
	pool: { max: 5, min: 0, idle: 10_000 }
});

export class Comment extends Model<InferAttributes<Comment>, InferCreationAttributes<Comment>> {
	declare id: number; // the writer provides it - so that even after a crash we can match what happened to which comment
	declare taskId: number;
	declare body: string;
	declare createdAt: CreationOptional<Date>;
}

// Transactional outbox: "this event has to be sent" - written in the same transaction as the comment.
// The relay later reads from here and sends it to the broker, then sets publishedAt.
export class OutboxEvent extends Model<
	InferAttributes<OutboxEvent>,
	InferCreationAttributes<OutboxEvent>
> {
	declare id: CreationOptional<number>; // sequential - the relay sends in this order
	declare eventId: string;
	declare type: string;
	declare aggregateId: number; // which task the event is about - the partition/order key (Lesson 7.2)
	declare payload: object;
	declare createdAt: CreationOptional<Date>;
	declare publishedAt: Date | null;
}

Comment.init(
	{
		id: { type: DataTypes.INTEGER, primaryKey: true },
		taskId: { type: DataTypes.INTEGER, allowNull: false },
		body: { type: DataTypes.TEXT, allowNull: false },
		createdAt: DataTypes.DATE
	},
	{ sequelize, tableName: 'comments', updatedAt: false }
);

OutboxEvent.init(
	{
		id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
		eventId: { type: DataTypes.UUID, allowNull: false, unique: true },
		type: { type: DataTypes.STRING, allowNull: false },
		aggregateId: { type: DataTypes.INTEGER, allowNull: false },
		payload: { type: DataTypes.JSONB, allowNull: false },
		createdAt: DataTypes.DATE,
		publishedAt: { type: DataTypes.DATE, allowNull: true }
	},
	{
		sequelize,
		tableName: 'outbox_events',
		updatedAt: false,
		// the relay only looks for unsent rows - a partial index keeps that search small, however big the table gets
		indexes: [{ fields: ['id'], where: { publishedAt: null }, name: 'outbox_unpublished' }]
	}
);
