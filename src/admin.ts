import { ApiError } from './errors.ts';
import { createApiKey, createTenant, getTenant, revokeApiKey, rotateWebhookSecret, updateTenant, webhookSecret, type TenantInput } from './tenants.ts';
import { getRow, view, type PaymentRow } from './payments.ts';
import { listDead, retryDelivery } from './webhooks.ts';
import { resolvePayment } from './reconcile.ts';
import { loadFloat } from './float.ts';
import type { Providers } from './providers/types.ts';
import { safeEqual } from './util.ts';

/**
 * The operator API (`Authorization: Bearer <ADMIN_API_KEY>`): tenants, their keys and webhook secrets, payments that need a person, undeliverable events.
 * One shared operator key for now; there is no UI yet. Never reachable with a tenant key.
 */
export function requireAdmin(env: Env, request: Request): string {
	const m = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '');
	const key = env.ADMIN_API_KEY;
	if (!key || key.length < 24) throw new ApiError(503, 'admin_disabled', 'ADMIN_API_KEY is not set (24 characters at least)');
	if (!m || !safeEqual(m[1]!, key)) throw new ApiError(401, 'unauthorized', 'A valid admin key is required');
	return 'operator';
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const body = async (request: Request): Promise<Record<string, unknown>> => {
	try { const v = await request.json(); if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>; } catch { /* below */ }
	throw new ApiError(400, 'invalid_request', 'A JSON object is required');
};

/** What the operator sees of a payment: the tenant's view plus the detail a tenant never gets. */
const adminView = (env: Env, r: PaymentRow) => ({ ...view(env, r), tenant: r.tenant_id, provider: r.provider, providerId: r.provider_id, providerRef: r.provider_ref, failureDetail: r.failure_detail, attempts: r.attempts, version: r.version });

export async function adminApi(env: Env, request: Request, path: string, providers: Providers): Promise<Response | null> {
	const admin = requireAdmin(env, request);
	const url = new URL(request.url);
	const m = request.method;
	let g: RegExpExecArray | null;

	if (path === '/admin/tenants' && m === 'POST') return json(await createTenant(env, (await body(request)) as unknown as TenantInput), 201);
	if (path === '/admin/tenants' && m === 'GET') return json({ data: (await env.DB.prepare(`SELECT * FROM tenants ORDER BY created_at`).all()).results });
	if ((g = /^\/admin\/tenants\/([a-z0-9-]+)$/.exec(path))) {
		if (m === 'GET') { const t = await getTenant(env, g[1]!); if (!t) throw new ApiError(404, 'not_found', 'No such tenant'); return json(t); }
		if (m === 'PATCH') return json(await updateTenant(env, g[1]!, await body(request)));
	}
	if ((g = /^\/admin\/tenants\/([a-z0-9-]+)\/keys$/.exec(path))) {
		if (m === 'POST') { const b: Record<string, unknown> = await body(request).catch(() => ({})); return json(await createApiKey(env, g[1]!, typeof b.label === 'string' ? b.label : null), 201); } // the key is shown once
		if (m === 'GET') return json({ data: (await env.DB.prepare(`SELECT id, label, created_at, last_used_at, revoked_at FROM api_keys WHERE tenant_id = ? ORDER BY created_at`).bind(g[1]!).all()).results });
	}
	if ((g = /^\/admin\/tenants\/([a-z0-9-]+)\/keys\/([0-9a-f]{12})$/.exec(path)) && m === 'DELETE') {
		if (!(await revokeApiKey(env, g[1]!, g[2]!))) throw new ApiError(404, 'not_found', 'No such active key');
		return json({ revoked: true });
	}
	if ((g = /^\/admin\/tenants\/([a-z0-9-]+)\/webhook-secret$/.exec(path))) {
		const t = await getTenant(env, g[1]!);
		if (!t) throw new ApiError(404, 'not_found', 'No such tenant');
		if (m === 'GET') return json({ secret: await webhookSecret(env, t), version: t.webhook_version });
		if (m === 'POST') return json(await rotateWebhookSecret(env, t.id)); // rotate
	}
	if (path === '/admin/payments' && m === 'GET') {
		const where: string[] = [], binds: unknown[] = [];
		for (const [param, col] of [['status', 'status'], ['tenant', 'tenant_id'], ['kind', 'kind']] as const) { const v = url.searchParams.get(param); if (v) { where.push(`${col} = ?`); binds.push(v); } }
		const { results } = await env.DB.prepare(`SELECT * FROM payments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 100`).bind(...binds).all<PaymentRow>();
		return json({ data: results.map((r) => adminView(env, r)) });
	}
	if ((g = /^\/admin\/payments\/(pg[0-9a-f]{18})$/.exec(path)) && m === 'GET') {
		const r = await getRow(env, g[1]!);
		if (!r) throw new ApiError(404, 'not_found', 'No such payment');
		const events = (await env.DB.prepare(`SELECT type, actor, detail, created_at FROM payment_events WHERE payment_id = ? ORDER BY id`).bind(r.id).all()).results;
		return json({ ...adminView(env, r), events });
	}
	if ((g = /^\/admin\/payments\/(pg[0-9a-f]{18})\/resolve$/.exec(path)) && m === 'POST') {
		const b = await body(request);
		if ((b.outcome !== 'completed' && b.outcome !== 'failed') || typeof b.note !== 'string' || !b.note.trim()) throw new ApiError(400, 'invalid_request', 'outcome (completed|failed) and note are required');
		const r = await resolvePayment(env, g[1]!, b.outcome, b.note.trim().slice(0, 300), admin);
		if (!r) throw new ApiError(409, 'not_resolvable', 'The payment does not exist or its status cannot move to that outcome');
		return json(adminView(env, r));
	}
	if (path === '/admin/webhooks/dead' && m === 'GET') return json({ data: await listDead(env) });
	if ((g = /^\/admin\/webhooks\/([A-Za-z0-9_]+)\/retry$/.exec(path)) && m === 'POST') {
		if (!(await retryDelivery(env, g[1]!))) throw new ApiError(404, 'not_found', 'No such undelivered event');
		return json({ queued: true });
	}
	if (path === '/admin/float' && m === 'GET') return json(await loadFloat(env, providers));
	if (path === '/admin/provider-events' && m === 'GET') return json({ data: (await env.DB.prepare(`SELECT id, provider, path, accepted, body, received_at FROM provider_events ORDER BY id DESC LIMIT 100`).all()).results });
	return null;
}
