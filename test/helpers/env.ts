/**
 * A Worker environment for tests: a D1 stand-in over node:sqlite with the REAL migrations applied, an in-memory KV, and a fetch stub that
 * records the calls and answers from a handler. The code under test (src/payments.ts, reconcile.ts, webhooks.ts, ...) runs
 * unchanged against it, so the SQL it sends is the SQL that runs in production, minus D1 itself.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

type Row = Record<string, unknown>;
const plain = (r: unknown): Row => ({ ...(r as Row) });

class Statement {
	db: DatabaseSync; sql: string; binds: unknown[];
	constructor(db: DatabaseSync, sql: string, binds: unknown[] = []) { this.db = db; this.sql = sql; this.binds = binds; }
	bind(...values: unknown[]) {
		for (const v of values) if (v === undefined) throw new Error(`D1: undefined cannot be bound (${this.sql.slice(0, 60)})`);
		return new Statement(this.db, this.sql, values);
	}
	run() {
		const r = this.db.prepare(this.sql).run(...(this.binds as never[]));
		return Promise.resolve({ success: true, results: [] as Row[], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } });
	}
	first<T = Row>(col?: string): Promise<T | null> {
		const r = this.db.prepare(this.sql).get(...(this.binds as never[]));
		if (r === undefined) return Promise.resolve(null);
		return Promise.resolve((col ? (r as Row)[col] : plain(r)) as T);
	}
	all<T = Row>() {
		const rows = this.db.prepare(this.sql).all(...(this.binds as never[])).map(plain) as T[];
		return Promise.resolve({ success: true, results: rows, meta: { changes: 0 } });
	}
	/** used by batch(): runs synchronously inside the transaction */
	exec() {
		if (/^\s*(SELECT|WITH)/i.test(this.sql)) return { results: this.db.prepare(this.sql).all(...(this.binds as never[])).map(plain), meta: { changes: 0 } };
		const r = this.db.prepare(this.sql).run(...(this.binds as never[]));
		return { results: [] as Row[], meta: { changes: Number(r.changes) } };
	}
}

export function createDb() {
	const sqlite = new DatabaseSync(':memory:');
	for (const f of readdirSync(MIGRATIONS).sort()) sqlite.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
	return {
		sqlite,
		prepare: (sql: string) => new Statement(sqlite, sql),
		/** a D1 batch is one transaction: all of it, or none of it */
		async batch(stmts: Statement[]) {
			sqlite.exec('BEGIN');
			try { const out = stmts.map((s) => s.exec()); sqlite.exec('COMMIT'); return out; }
			catch (e) { sqlite.exec('ROLLBACK'); throw e; }
		},
	};
}

export function createKv() {
	const m = new Map<string, string>();
	return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); } };
}

export interface Call { url: string; method: string; body: string | null; headers: Record<string, string> }
type Handler = (c: Call) => Response | Promise<Response> | undefined;

/** Replaces global fetch. Unhandled calls to the alert webhook are recorded and answered 200; anything else unhandled throws, so a test never reaches the network. */
export function stubFetch(handler: Handler = () => undefined) {
	const real = globalThis.fetch;
	const calls: Call[] = [];
	globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string; headers?: HeadersInit }) => {
		const url = typeof input === 'string' ? input : (input as Request).url;
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
		const call: Call = { url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null, headers };
		calls.push(call);
		const res = await handler(call);
		if (res) return res;
		if (url.startsWith(ALERT_URL)) return new Response('ok');
		throw new Error(`unexpected fetch in a test: ${call.method} ${url}`);
	}) as typeof fetch;
	return {
		calls,
		restore: () => { globalThis.fetch = real; },
		/** the alerts sent to the webhook, in order */
		alerts: () => calls.filter((c) => c.url.startsWith(ALERT_URL)).map((c) => JSON.parse(c.body!) as { level: string; title: string; details: Record<string, unknown> }),
	};
}

export const ALERT_URL = 'https://alerts.test/hook';

export function createEnv(over: Record<string, unknown> = {}) {
	const db = createDb();
	const env = {
		DB: db, CACHE: createKv(),
		LIVE: 'false', PROVIDER_MODE: 'sandbox', PAWAPAY_BASE_URL: 'https://api.sandbox.pawapay.io', PAWAPAY_API_TOKEN: 'test-token',
		DEFAULT_MAX_AMOUNT: '2000000', FLOAT_FLOOR_XOF: '2000000',
		PISPI_ENABLED: 'false', PISPI_POLL: 'false', PISPI_RTP: 'false', PISPI_COUNTRY: 'BF', PI_SPI_PARTICIPANT: '', PI_SPI_BUSINESS_API_URL: '', PI_SP_API_OAUTH_URL: '',
		ADMIN_API_KEY: 'root-key-for-tests-0123456789', WEBHOOK_MASTER_SECRET: 'master-secret-for-tests-0123456789', ALERT_WEBHOOK_URL: ALERT_URL,
		...over,
	};
	return { env: env as unknown as Env, db, sqlite: db.sqlite, kv: env.CACHE };
}

/** quiet the structured logs the workflow code writes with console.log / error / warn, restoring on the returned function */
export function silence() {
	const saved = { log: console.log, error: console.error, warn: console.warn };
	console.log = console.error = console.warn = () => {};
	return () => { Object.assign(console, saved); };
}
