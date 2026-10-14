import { alert } from './alerts.ts';
import { COUNTRIES } from './providers/phone.ts';
import type { Providers, WalletBalance } from './providers/types.ts';

/**
 * The payout float: our prepaid wallet with the payment provider, one per country. A payout debits the wallet of the RECIPIENT'S country and fails if
 * it is empty; a collection credits the wallet of the PAYER'S country. So the question that matters is not only "how much is in the wallet" but "does it
 * cover what is already committed", and how long it lasts at the current pace. The wallet is shared by every product on the gateway, so the figures are
 * the gateway's as a whole. (Commitments a product holds back on its side, such as payouts waiting for its own approval, are added by that product.)
 * `floatReport` is pure, so it is unit-tested.
 */
export interface FlowRow { kind: 'collection' | 'disbursement'; country: string | null; amount: number; status: string; settled_at: number | null }
export type FloatStatus = 'ok' | 'low' | 'critical';

export interface FloatRow {
	country: string; currency: string; balance: number | null; provider: string | null; floor: number;
	/** disbursements already accepted and not final: money the wallet must still cover */
	committed: number; committedCount: number;
	out24h: number; in24h: number; avgDailyOut: number;
	/** days the money left after the committed payouts lasts at that pace; null when nothing has been paid out lately */
	coverDays: number | null;
	status: FloatStatus; reasons: string[];
}

const DAY = 86_400_000;
const IN_FLIGHT = new Set(['processing', 'unknown']);

export function floatReport(i: { balances: WalletBalance[]; flows: FlowRow[]; floor: number; now: number; countries?: string[] }): FloatRow[] {
	return (i.countries ?? COUNTRIES).map((country) => {
		const wallet = i.balances.find((b) => b.country === country && b.currency === 'XOF');
		const out = i.flows.filter((f) => f.kind === 'disbursement' && f.country === country);
		const committed = out.filter((f) => IN_FLIGHT.has(f.status));
		const paid = out.filter((f) => f.status === 'completed' && f.settled_at !== null);
		const sum = (xs: { amount: number }[]) => xs.reduce((n, x) => n + x.amount, 0);
		const committedAmount = sum(committed);
		const out24h = sum(paid.filter((p) => i.now - p.settled_at! <= DAY));
		const avgDailyOut = Math.round(sum(paid.filter((p) => i.now - p.settled_at! <= 7 * DAY)) / 7);
		const in24h = sum(i.flows.filter((f) => f.kind === 'collection' && f.country === country && f.status === 'completed' && f.settled_at !== null && i.now - f.settled_at <= DAY));
		const balance = wallet ? wallet.balance : null;
		const free = balance === null ? null : balance - committedAmount;
		const reasons: string[] = [];
		let status: FloatStatus = 'ok';
		if (balance === null) { status = 'critical'; reasons.push('No XOF wallet for this country on the provider account'); }
		else if (balance <= 0) { status = 'critical'; reasons.push('The wallet is empty: every payout here will fail'); }
		else if (free! < 0) { status = 'critical'; reasons.push('Payouts already accepted need more than the wallet holds'); }
		else if (balance < i.floor) { status = 'low'; reasons.push('Below the minimum float'); }
		return {
			country, currency: 'XOF', balance, provider: wallet?.provider || null, floor: i.floor,
			committed: committedAmount, committedCount: committed.length, out24h, in24h, avgDailyOut,
			coverDays: free !== null && avgDailyOut > 0 ? Math.max(0, Math.round((free / avgDailyOut) * 10) / 10) : null,
			status, reasons,
		};
	});
}

export interface FloatView { provider: string; floor: number; generatedAt: number; rows: FloatRow[] | null }

/** `rows` is null when the provider reports no balance (the sandbox). */
export async function loadFloat(env: Env, providers: Providers, now = Date.now()): Promise<FloatView> {
	const floor = Number(env.FLOAT_FLOOR_XOF);
	if (!providers.disburse.balances) return { provider: providers.disburse.name, floor, generatedAt: now, rows: null };
	const { results } = await env.DB.prepare(`SELECT kind, country, amount, status, settled_at FROM payments WHERE rail = 'mobile_money' AND (status IN ('processing', 'unknown') OR (status = 'completed' AND settled_at >= ?))`).bind(now - 7 * DAY).all<FlowRow>();
	return { provider: providers.disburse.name, floor, generatedAt: now, rows: floatReport({ balances: await providers.disburse.balances(), flows: results, floor, now }) };
}

/** Alerts when a country's float is below the minimum or doesn't cover what is already committed, at most once per 12 hours per country and level. */
export async function checkFloat(env: Env, providers: Providers, now = Date.now()): Promise<{ low: string[] }> {
	const v = await loadFloat(env, providers, now);
	const low = (v.rows ?? []).filter((r) => r.status !== 'ok');
	for (const r of low) {
		const key = `float:alert:${r.country}:${r.status}`;
		if (await env.CACHE.get(key)) continue;
		await env.CACHE.put(key, String(now), { expirationTtl: 12 * 3600 });
		await alert(env, {
			level: 'critical',
			title: r.status === 'critical' ? `Payout wallet in ${r.country} cannot cover payouts: they will fail until it is topped up` : `Payout wallet low in ${r.country}: top it up before it runs out`,
			details: { country: r.country, balance: r.balance === null ? 'no wallet' : `${r.balance} XOF`, committed: `${r.committed} XOF in ${r.committedCount} payout(s)`, floor: `${r.floor} XOF`, coverDays: r.coverDays ?? 'n/a', why: r.reasons.join('; ') },
		});
	}
	return { low: low.map((r) => r.country) };
}
