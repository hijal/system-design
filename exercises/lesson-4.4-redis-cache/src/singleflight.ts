// Single-flight: when many loads for the same key run at once, only one
// actually runs - the rest wait for that same promise.
// This is the most direct cure for a cache stampede (Lesson 4.6).
const inFlight = new Map<string, Promise<unknown>>();

export async function single<T>(key: string, load: () => Promise<T>): Promise<T> {
	const running = inFlight.get(key);
	if (running !== undefined) {
		// someone else is already loading this key - instead of a new DB query,
		// wait for their result
		return (await running) as T;
	}

	const promise = load().finally(() => {
		inFlight.delete(key);
	});
	inFlight.set(key, promise);
	return promise;
}

export function inFlightCount(): number {
	return inFlight.size;
}
