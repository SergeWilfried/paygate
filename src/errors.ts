/** An error the API turns into a JSON answer: `code` is stable and meant for programs, `message` for people. */
export class ApiError extends Error {
	status: number; code: string; extra: Record<string, unknown>;
	constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
