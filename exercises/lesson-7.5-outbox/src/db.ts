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
	declare id: number; // writer নিজে দেয় — যাতে crash এর পরেও কোন comment এর কী হলো মেলানো যায়
	declare taskId: number;
	declare body: string;
	declare createdAt: CreationOptional<Date>;
}

// Transactional outbox: "এই event টা পাঠাতে হবে" — comment এর সাথে একই transaction এ লেখা।
// relay পরে এখান থেকে পড়ে broker এ পাঠায়, তারপর publishedAt বসায়।
export class OutboxEvent extends Model<
	InferAttributes<OutboxEvent>,
	InferCreationAttributes<OutboxEvent>
> {
	declare id: CreationOptional<number>; // ক্রমিক — relay এই ক্রমে পাঠায়
	declare eventId: string;
	declare type: string;
	declare aggregateId: number; // কোন task এর ঘটনা — partition/ক্রমের key (Lesson 7.2)
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
		// relay শুধু না-পাঠানো গুলো খোঁজে — partial index সেই খোঁজকে ছোট রাখে, table যত বড়ই হোক
		indexes: [{ fields: ['id'], where: { publishedAt: null }, name: 'outbox_unpublished' }]
	}
);
