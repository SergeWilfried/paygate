import { ApiError } from './errors.ts';
import { hmacHex, newId, safeEqual, sha256Hex, safeUrl, on } from './util.ts';

export interface Tenant {
	id: string; name: string; status: 'active' | 'suspended'; webhook_url: string | null; webhook_version: number;
	max_amount: number | null; id_namespace: string | null; created_at: number;
}

const SLUG = /^[a-z][a-z0-9-]{1,31}$/;
const KEY = /^pgk_([0-9a-f]{12})_([0-9a-f]{64})$/;
const TOUCH_EVERY_MS = 10 * 60_000;

export interface TenantInput { id: unknown; name: unknown; webhookUrl?: unknown; maxAmount?: unknown; idNamespace?: unknown }

export async function createTenant(env: Env, input: TenantInput, now = Date.now()): Promise<Tenant> {
	if (typeof input.id !== 'string' || !SLUG.test(input.id)) throw new ApiError(400, 'invalid_tenant', 'id must be a lowercase slug of 2 to 32 characters (letters, digits, dashes)');
	if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new ApiError(400, 'invalid_tenant', 'name is required');
	const webhook = input.webhookUrl === undefined || input.webhookUrl === null ? null : webhookUrl(env, input.webhookUrl);
	const max = input.maxAmount === undefined || input.maxAmount === null ? null : maxAmount(input.maxAmount);
	const ns = input.idNamespace === undefined || input.idNamespace === null ? null : idNamespace(input.idNamespace);
	if (await getTenant(env, input.id)) throw new ApiError(409, 'tenant_exists', 'A tenant with this id already exists');
	await env.DB.prepare(`INSERT INTO tenants (id, name, webhook_url, max_amount, id_namespace, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(input.id, input.name.trim(), webhook, max, ns, now).run();
	return (await getTenant(env, input.id))!;
}

export const getTenant = (env: Env, id: string) => env.DB.prepare(`SELECT * FROM tenants WHERE id = ?`).bind(id).first<Tenant>();

function webhookUrl(env: Env, v: unknown): string {
	const u = safeUrl(v, { allowLocalHttp: !on(env.LIVE) });
	if (!u) throw new ApiError(400, 'invalid_webhook_url', 'webhookUrl must be an absolute https URL');
	return u;
}
function maxAmount(v: unknown): number {
	if (typeof v !== 'number' || !Number.isInteger(v) || v < 100) throw new ApiError(400, 'invalid_max_amount', 'maxAmount must be a whole number of XOF, at least 100');
	return v;
}
function idNamespace(v: unknown): string {
	if (typeof v !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(v)) throw new ApiError(400, 'invalid_id_namespace', 'idNamespace must be a lowercase slug');
	return v;
}

export async function updateTenant(env: Env, id: string, patch: { webhookUrl?: unknown; maxAmount?: unknown; status?: unknown; name?: unknown }): Promise<Tenant> {
	const t = await getTenant(env, id);
	if (!t) throw new ApiError(404, 'not_found', 'No such tenant');
	const next = {
		webhook_url: patch.webhookUrl === undefined ? t.webhook_url : patch.webhookUrl === null ? null : webhookUrl(env, patch.webhookUrl),
		max_amount: patch.maxAmount === undefined ? t.max_amount : patch.maxAmount === null ? null : maxAmount(patch.maxAmount),
		status: patch.status === undefined ? t.status : patch.status === 'active' || patch.status === 'suspended' ? patch.status : (() => { throw new ApiError(400, 'invalid_status', 'status is active or suspended'); })(),
		name: patch.name === undefined ? t.name : typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim() : (() => { throw new ApiError(400, 'invalid_tenant', 'name cannot be empty'); })(),
	};
	await env.DB.prepare(`UPDATE tenants SET webhook_url = ?, max_amount = ?, status = ?, name = ? WHERE id = ?`).bind(next.webhook_url, next.max_amount, next.status, next.name, id).run();
	return (await getTenant(env, id))!;
}

/** A new API key. The key is returned ONCE: only its hash is stored. */
export async function createApiKey(env: Env, tenantId: string, label: string | null, now = Date.now()): Promise<{ id: string; key: string }> {
	if (!(await getTenant(env, tenantId))) throw new ApiError(404, 'not_found', 'No such tenant');
	const id = newId('', 6);
	const key = `pgk_${id}_${newId('', 32)}`;
	await env.DB.prepare(`INSERT INTO api_keys (id, tenant_id, hash, label, created_at) VALUES (?, ?, ?, ?, ?)`).bind(id, tenantId, await sha256Hex(key), label?.slice(0, 80) ?? null, now).run();
	return { id, key };
}

export async function revokeApiKey(env: Env, tenantId: string, keyId: string, now = Date.now()): Promise<boolean> {
	return (await env.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`).bind(now, keyId, tenantId).run()).meta.changes > 0;
}

/** The tenant a request belongs to, from `Authorization: Bearer pgk_...`. Unknown, revoked and suspended all look the same to the caller. */
export async function authenticate(env: Env, request: Request, now = Date.now()): Promise<Tenant> {
	const bad = () => new ApiError(401, 'unauthorized', 'A valid API key is required');
	const m = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '');
	const parts = m ? KEY.exec(m[1]!) : null;
	if (!parts) throw bad();
	const row = await env.DB.prepare(`SELECT hash, tenant_id, revoked_at, last_used_at FROM api_keys WHERE id = ?`).bind(parts[1]!).first<{ hash: string; tenant_id: string; revoked_at: number | null; last_used_at: number | null }>();
	const hash = await sha256Hex(m![1]!);
	if (!row || row.revoked_at || !safeEqual(row.hash, hash)) throw bad();
	const tenant = await getTenant(env, row.tenant_id);
	if (!tenant || tenant.status !== 'active') throw bad();
	if (!row.last_used_at || now - row.last_used_at > TOUCH_EVERY_MS) await env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).bind(now, parts[1]!).run();
	return tenant;
}

/** The tenant's webhook signing secret: derived from the master secret, so nothing secret is stored. Rotating bumps the version. */
export async function webhookSecret(env: Env, tenant: Pick<Tenant, 'id' | 'webhook_version'>): Promise<string> {
	if (!env.WEBHOOK_MASTER_SECRET || env.WEBHOOK_MASTER_SECRET.length < 24) throw new Error('WEBHOOK_MASTER_SECRET is missing or too short');
	return `whsec_${await hmacHex(env.WEBHOOK_MASTER_SECRET, `webhook:${tenant.id}:${tenant.webhook_version}`)}`;
}

export async function rotateWebhookSecret(env: Env, tenantId: string): Promise<{ secret: string; version: number }> {
	await env.DB.prepare(`UPDATE tenants SET webhook_version = webhook_version + 1 WHERE id = ?`).bind(tenantId).run();
	const t = await getTenant(env, tenantId);
	if (!t) throw new ApiError(404, 'not_found', 'No such tenant');
	return { secret: await webhookSecret(env, t), version: t.webhook_version };
}
