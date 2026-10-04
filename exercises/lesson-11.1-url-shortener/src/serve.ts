import { ConfigSchema, createShortener } from './app';

const config = ConfigSchema.parse(process.env);
const { app, clicks } = createShortener(config);

const flusher = setInterval(() => clicks.flush(), 1_000);
const server = app.listen(config.PORT, () => {
	console.log(`URL shortener চলছে: ${config.SHORT_ORIGIN} (port ${config.PORT})`);
});

const shutdown = (): void => {
	clearInterval(flusher);
	server.close(() => {
		clicks.flush();
		process.exit(0);
	});
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
