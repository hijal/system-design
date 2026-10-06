export type Email = {
	idempotencyKey: string;
	to: string;
	taskId: number;
};

export class FakeEmailProvider {
	readonly delivered = new Map<string, Email>();
	calls = 0;
	duplicateCalls = 0;

	async send(email: Email): Promise<void> {
		this.calls++;
		if (this.delivered.has(email.idempotencyKey)) {
			this.duplicateCalls++;
			return;
		}
		this.delivered.set(email.idempotencyKey, email);
	}

	reset(): void {
		this.delivered.clear();
		this.calls = 0;
		this.duplicateCalls = 0;
	}
}
