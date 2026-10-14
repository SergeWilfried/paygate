import { alert } from './alerts.ts';
import { applyObserved, getRow } from './payments.ts';
import type { Providers } from './providers/types.ts';
import { log } from './util.ts';

/**
 * Provider callbacks: ONE public URL per provider for all products (a provider allows only one callback URL per account, which is a main reason for a
 * shared gateway). Verified by the provider adapter (an unsigned callback is refused outright with LIVE=true). The payment is found by the provider's
 * id, which is a function of the tenant and its reference, so a callback can never touch another tenant's payment.
 * Every callback is stored as it arrived (bounded) so an unexpected payload can be read later.
 */
export const MAX_BODY = 64 * 1024;
const KEEP = 1000;

export async function handleProviderCallback(env: Env, request: Request, providers: Providers, expected: 'collection' | 'disbursement', now = Date.now()): Promise<Response> {
	const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	const raw = await request.text();
	if (raw.length > MAX_BODY) return reply(413, { error: 'Payload too large' });
	const url = new URL(request.url);

	const ev = await providers.parseCallback(raw, request.headers, url);
	await env.DB.prepare(`INSERT INTO provider_events (provider, path, accepted, body, received_at) VALUES (?, ?, ?, ?, ?)`).bind(providers.mode, url.pathname, ev ? 1 : 0, raw.slice(0, 8192), now).run();
	await env.DB.prepare(`DELETE FROM provider_events WHERE id <= (SELECT MAX(id) FROM provider_events) - ?`).bind(KEEP).run();
	if (!ev) return reply(401, { error: 'Invalid signature' });
	if (ev.direction !== expected || ev.state === 'ignore') return reply(200, { ok: true }); // genuine, but not for this endpoint or not final yet

	const found = await env.DB.prepare(`SELECT id FROM payments WHERE provider_id = ? AND kind = ?`).bind(ev.providerId, ev.direction).first<{ id: string }>();
	if (!found) {
		// answered 200 so the provider stops retrying; a person looks, because a payment of ours it knows and we do not is worth a look
		await alert(env, { level: 'warning', title: 'A provider callback arrived for a payment the gateway does not know', details: { direction: ev.direction, state: ev.state, clientReference: ev.clientReference } });
		return reply(200, { ok: true });
	}
	const row = (await getRow(env, found.id))!;
	const r = await applyObserved(env, row, ev.state === 'completed' ? { state: 'completed' } : { state: 'failed', error: ev.error ?? 'The payment could not be completed', detail: 'provider callback' }, 'callback', now);
	log('payment.callback', { id: row.id, state: ev.state, applied: r.applied });
	return reply(200, { ok: true });
}
