import { alert } from './alerts.ts';
import { signBody } from './signing.ts';
import { getTenant, webhookSecret } from './tenants.ts';
import { log, newId } from './util.ts';

/**
 * Delivers the events in the outbox to each tenant's webhook URL: at least once, signed, retried with a growing delay, and the same event id every time
 * (the tenant's dedupe key). An event is written in the same batch as the payment change it describes (see payments.ts), so none is lost or invented.
 * The tenant answers any 2xx to acknowledge. Redirects are not followed (the signed body must not travel to a URL nobody chose).
 */
export const BACKOFF_MS = [10_000, 60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 86_400_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const CLAIM_MS = 60_000;

interface Due { id: string; tenant_id: string; payment_id: string; type: string; payload: string; attempts: number }

export async function deliverDue(env: Env, now = Date.now(), limit = 20): Promise<{ delivered: number; retried: number; dead: number }> {
	const { results } = await env.DB.prepare(`SELECT id, tenant_id, payment_id, type, payload, attempts FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`).bind(now, limit).all<Due>();
	const out = { delivered: 0, retried: 0, dead: 0 };
	for (const d of results) {
		// claim: pushing the next attempt out first means two overlapping runs never send the same event at the same time
		const claim = await env.DB.prepare(`UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?`).bind(now + CLAIM_MS, d.id, now).run();
		if (!claim.meta.changes) continue;
		const r = await send(env, d, now);
		const attempts = d.attempts + 1;
		if (r.ok) {
			await env.DB.prepare(`UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_status = ?, last_error = NULL, delivered_at = ? WHERE id = ?`).bind(attempts, r.status, now, d.id).run();
			out.delivered++;
		} else if (attempts >= MAX_ATTEMPTS) {
			await env.DB.prepare(`UPDATE webhook_deliveries SET status = 'dead', attempts = ?, last_status = ?, last_error = ? WHERE id = ?`).bind(attempts, r.status, r.error, d.id).run();
			out.dead++;
			await alert(env, { level: 'critical', title: 'A webhook could not be delivered after every retry', details: { tenant: d.tenant_id, event: d.id, type: d.type, payment: d.payment_id, error: r.error } });
		} else {
			await env.DB.prepare(`UPDATE webhook_deliveries SET attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`).bind(attempts, r.status, r.error, now + BACKOFF_MS[attempts - 1]!, d.id).run();
			out.retried++;
		}
	}
	if (results.length) log('webhooks.run', out);
	return out;
}

async function send(env: Env, d: Due, now: number): Promise<{ ok: boolean; status: number | null; error: string | null }> {
	const tenant = await getTenant(env, d.tenant_id);
	if (!tenant?.webhook_url) return { ok: false, status: null, error: 'The tenant has no webhook URL' };
	try {
		const t = Math.floor(now / 1000);
		const res = await fetch(tenant.webhook_url, {
			method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8_000),
			headers: {
				'content-type': 'application/json', 'user-agent': 'Paygate-Webhooks/1',
				'paygate-signature': await signBody(await webhookSecret(env, tenant), d.payload, t),
				'paygate-event-id': d.id, 'paygate-event-type': d.type,
			},
			body: d.payload,
		});
		return res.status >= 200 && res.status < 300 ? { ok: true, status: res.status, error: null } : { ok: false, status: res.status, error: `HTTP ${res.status}` };
	} catch (e) { return { ok: false, status: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }; }
}

/** A test event so a tenant can check its endpoint and its signature check. It belongs to no payment. */
export async function queuePing(env: Env, tenantId: string, now = Date.now()): Promise<string> {
	const id = newId('evt_ping_');
	const payload = JSON.stringify({ id, type: 'ping', createdAt: now, data: null });
	await env.DB.prepare(`INSERT INTO webhook_deliveries (id, tenant_id, payment_id, type, payload, next_attempt_at, created_at) VALUES (?, ?, '-', 'ping', ?, ?, ?)`).bind(id, tenantId, payload, now, now).run();
	return id;
}

export async function listDead(env: Env, limit = 50) {
	const { results } = await env.DB.prepare(`SELECT id, tenant_id, payment_id, type, attempts, last_status, last_error, created_at FROM webhook_deliveries WHERE status = 'dead' ORDER BY created_at DESC LIMIT ?`).bind(limit).all();
	return results;
}

/** Puts a dead (or stuck) event back in the queue, from the start. */
export async function retryDelivery(env: Env, id: string, now = Date.now()): Promise<boolean> {
	return (await env.DB.prepare(`UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL WHERE id = ? AND status IN ('dead', 'pending')`).bind(now, id).run()).meta.changes > 0;
}
