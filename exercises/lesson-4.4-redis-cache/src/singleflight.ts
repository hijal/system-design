// Single-flight: একই key এর জন্য একসাথে অনেকগুলো load চললে, আসলে
// একটাই চলবে — বাকিরা সেই একই promise এর জন্য অপেক্ষা করবে।
// এটাই cache stampede এর সবচেয়ে সরাসরি ওষুধ (Lesson 4.6)।
const inFlight = new Map<string, Promise<unknown>>();

export async function single<T>(key: string, load: () => Promise<T>): Promise<T> {
	const running = inFlight.get(key);
	if (running !== undefined) {
		// অন্য কেউ ইতিমধ্যে এই key টা load করছে — নতুন DB query না করে
		// তার ফলাফলের জন্যই অপেক্ষা করো
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
