import { Sequelize } from 'sequelize';

const DATABASE_URL: string =
	process.env.DATABASE_URL ?? 'postgres://taskflow:taskflow@localhost:5434/taskflow';

export const sequelize = new Sequelize(DATABASE_URL, {
	logging: false,
	// Pool এর বিস্তারিত Lesson 5.6 এ। counter.ts এর race টা দেখানোর জন্য একাধিক
	// connection দরকার — একটা connection হলে query গুলো লাইনে দাঁড়িয়ে একটা একটা
	// করে চলত, আর race টা ঘটতই না।
	pool: { max: 10, min: 0, idle: 10_000 }
});
