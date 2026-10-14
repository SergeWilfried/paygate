import { applyObserved, getRow, refresh, startDisbursement, type PaymentRow } from './payments.ts';
import type { Providers } from './providers/types.ts';
import { PISPI_LATE_MS, RECHECK_FAILED_EVERY_MS, RECHECK_FAILED_FOR_MS } from './states.ts';
import { log } from './util.ts';

/**
 * Settles what the callbacks missed, by asking the provider (a lost callback, a callback sent to the wrong URL, an unknown outcome after a network error):
 *  - open payments (processing, unknown) not looked at for a minute;
 *  - a disbursement that was recorded but never sent (the Worker stopped in between) is sent now: safe, the provider id is the idempotency key;
 *  - failed and expired payments from the last day (a week for PI-SPI), at most once an hour each, so a late completion cannot go unnoticed.
 */
const OPEN_AFTER_MS = 60_000;
const UNSENT_AFTER_MS = 60_000;

export async function reconcile(env: Env, providers: Providers, now = Date.now()): Promise<{ checked: number; changed: number }> {
	const open = (await env.DB.prepare(`SELECT * FROM payments WHERE status IN ('processing', 'unknown') AND (last_checked_at IS NULL OR last_checked_at < ?) ORDER BY COALESCE(last_checked_at, 0) LIMIT 25`).bind(now - OPEN_AFTER_MS).all<PaymentRow>()).results;
	const recheck = (await env.DB.prepare(`SELECT * FROM payments WHERE status IN ('failed', 'expired') AND updated_at > ? AND (last_checked_at IS NULL OR last_checked_at < ?) AND (rail = 'mobile_money' AND updated_at > ? OR rail <> 'mobile_money') ORDER BY updated_at DESC LIMIT 10`)
		.bind(now - Math.max(PISPI_LATE_MS, RECHECK_FAILED_FOR_MS), now - RECHECK_FAILED_EVERY_MS, now - RECHECK_FAILED_FOR_MS).all<PaymentRow>()).results;
	let changed = 0;
	for (const r of [...open, ...recheck]) {
		let next: PaymentRow;
		if (r.kind === 'disbursement' && r.status === 'processing' && r.attempts === 0 && now - r.created_at > UNSENT_AFTER_MS) next = await startDisbursement(env, r, providers, now);
		else next = await refresh(env, r, providers, { force: true, now });
		if (next.status !== r.status) changed++;
	}
	if (open.length + recheck.length) log('reconcile.run', { open: open.length, recheck: recheck.length, changed });
	return { checked: open.length + recheck.length, changed };
}

/** A person's decision for a payment the provider will not settle (an unknown outcome, a PI-SPI payment confirmed off-line). */
export async function resolvePayment(env: Env, id: string, outcome: 'completed' | 'failed', note: string, adminName: string, now = Date.now()): Promise<PaymentRow | null> {
	const row = await getRow(env, id);
	if (!row) return null;
	const r = await applyObserved(env, row, outcome === 'completed' ? { state: 'completed', providerRef: `manual: ${note}`.slice(0, 120) } : { state: 'failed', error: 'The payment could not be completed', detail: `manual: ${note}` }, `admin:${adminName}`, now);
	return r.applied ? r.row : null;
}
