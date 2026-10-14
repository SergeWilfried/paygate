import { alert } from './alerts.ts';
import { ApiError } from './errors.ts';
import { providerIdFor, type Kind } from './ids.ts';
import { OPERATORS, parsePhone } from './providers/phone.ts';
import { judge, PAYER_ALIAS, pispiAlias, pispiEnabled, pispiPollEnabled, pispiQr, pispiRtpEnabled, pispiTxId, receivedPaymentsFor, sendPaymentRequest, type PispiQr } from './providers/pispi.ts';
import type { Providers, Rail } from './providers/types.ts';
import { decide, isOpen, NOT_FOUND_DETAIL, NOT_FOUND_GRACE_MS, PISPI_LATE_MS, RECHECK_FAILED_FOR_MS, type Observed, type Status } from './states.ts';
import type { Tenant } from './tenants.ts';
import { canonical, log, newId, on, safeUrl, sha256Hex } from './util.ts';

export interface PaymentRow {
	id: string; tenant_id: string; kind: Kind; reference: string; rail: Rail; operator: string | null; country: string | null; counterparty: string;
	amount: number; currency: string; status: Status; version: number; provider: string; provider_id: string | null; provider_ref: string | null;
	auth_type: string | null; method: string | null; next_step: string | null; auth_url: string | null; failure: string | null; failure_detail: string | null;
	request_hash: string; metadata: string | null; attempts: number; last_checked_at: number | null; expires_at: number | null;
	created_at: number; updated_at: number; settled_at: number | null;
}

type Instructions = { en: string[]; fr: string[] };

/** What a tenant sees. Never the provider's ids, the failure detail, or another tenant's anything. */
export interface PaymentView {
	id: string; object: Kind; reference: string; rail: Rail; status: Status; amount: number; currency: string; operator: string | null; counterparty: string;
	nextStep: string | null; authUrl: string | null; qr: PispiQr | null;
	method: { authType: string | null; instructions: Instructions | null; codeInstructions: Instructions | null } | null;
	failure: string | null; metadata: unknown; createdAt: number; expiresAt: number | null; settledAt: number | null;
}

export function view(env: Env, r: PaymentRow): PaymentView {
	const open = r.status === 'processing';
	let method: PaymentView['method'] = null;
	if (r.method && open) {
		try {
			const m = JSON.parse(r.method) as { instructions?: Instructions | null; codeInstructions?: Instructions | null };
			method = { authType: r.auth_type, instructions: m.instructions ?? null, codeInstructions: m.codeInstructions ?? null };
		} catch { /* unreadable: no instructions */ }
	}
	return {
		id: r.id, object: r.kind, reference: r.reference, rail: r.rail, status: r.status, amount: r.amount, currency: r.currency, operator: r.operator, counterparty: r.counterparty,
		nextStep: open ? r.next_step : null, authUrl: open ? r.auth_url : null,
		qr: r.rail === 'pispi_qr' && open ? pispiQr(env, r) : null, method,
		failure: r.status === 'failed' ? r.failure : null,
		metadata: r.metadata ? JSON.parse(r.metadata) : null, createdAt: r.created_at, expiresAt: r.expires_at, settledAt: r.settled_at,
	};
}

export const getRow = (env: Env, id: string) => env.DB.prepare(`SELECT * FROM payments WHERE id = ?`).bind(id).first<PaymentRow>();
export const getRowFor = (env: Env, tenantId: string, kind: Kind, idOrReference: string) =>
	env.DB.prepare(`SELECT * FROM payments WHERE tenant_id = ? AND kind = ? AND (id = ? OR reference = ?) ORDER BY (id = ?) DESC LIMIT 1`).bind(tenantId, kind, idOrReference, idOrReference, idOrReference).first<PaymentRow>();

// ---- state changes ---------------------------------------------------------------------------------------------------------------

const SETTLES = new Set<Status>(['completed', 'failed', 'expired']);
const EVENT_ID = (paymentId: string, version: number) => `evt_${paymentId}_${version}`;

/** One webhook outbox row, written only for a tenant that has a webhook URL. */
function outbox(env: Env, tenantId: string, id: string, paymentId: string, type: string, data: PaymentView, extra: Record<string, unknown>, now: number) {
	const payload = JSON.stringify({ id, type, createdAt: now, data, ...extra });
	return env.DB.prepare(`INSERT OR IGNORE INTO webhook_deliveries (id, tenant_id, payment_id, type, payload, next_attempt_at, created_at) SELECT ?, id, ?, ?, ?, ?, ? FROM tenants WHERE id = ? AND webhook_url IS NOT NULL`)
		.bind(id, paymentId, type, payload, now, now, tenantId);
}

export interface Applied { applied: boolean; row: PaymentRow }

/**
 * Applies what the provider (or a person) says. A conditional, versioned update: only one caller can move a payment from version v to v+1, and the event
 * and the webhook for that move are written in the same batch, so a change is never reported twice and never lost. A repeated, late or contradicting
 * answer is simply not applied. `actor` is recorded in the history.
 */
export async function applyObserved(env: Env, row: PaymentRow, obs: Observed, actor: string, now = Date.now()): Promise<Applied> {
	const d = decide(row.kind, row.status, obs);
	if (!d) return { applied: false, row };
	const version = row.version + 1;
	const patch: Partial<PaymentRow> = { status: d.to, settled_at: SETTLES.has(d.to) ? now : null };
	if (obs.state === 'completed') { patch.failure = null; patch.failure_detail = null; if (obs.providerRef) patch.provider_ref = obs.providerRef; }
	if (obs.state === 'failed') { patch.failure = obs.error; patch.failure_detail = obs.detail ?? obs.error; }
	if (obs.state === 'unknown') patch.failure_detail = obs.detail;
	const next: PaymentRow = { ...row, ...patch, version, updated_at: now };
	const detail = obs.state === 'failed' ? (obs.detail ?? obs.error) : obs.state === 'unknown' ? obs.detail : obs.state === 'completed' ? obs.providerRef ?? null : null;
	const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
	const results = await env.DB.batch([
		env.DB.prepare(`UPDATE payments SET ${sets}, version = ?, updated_at = ? WHERE id = ? AND version = ?`).bind(...Object.values(patch), version, now, row.id, row.version),
		env.DB.prepare(`INSERT OR IGNORE INTO payment_events (payment_id, version, type, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(row.id, version, d.event, actor, detail, now),
		outbox(env, row.tenant_id, EVENT_ID(row.id, version), row.id, d.webhook, view(env, next), { previousStatus: row.status, late: d.late }, now),
	]);
	if (!results[0]!.meta.changes) return { applied: false, row: (await getRow(env, row.id)) ?? row }; // someone else moved it first
	log('payment.transition', { id: row.id, tenant: row.tenant_id, kind: row.kind, from: row.status, to: d.to, actor });
	await notifyOperator(env, next, row.status, d, obs);
	return { applied: true, row: next };
}

async function notifyOperator(env: Env, r: PaymentRow, from: Status, d: NonNullable<ReturnType<typeof decide>>, obs: Observed) {
	const base = { payment: r.id, tenant: r.tenant_id, kind: r.kind, amount: r.amount, rail: r.rail };
	if (d.late) await alert(env, { level: 'critical', title: `A payment reported ${from} was actually COMPLETED by the provider: the ${r.kind === 'collection' ? 'customer was charged' : 'recipient was paid'}`, details: { ...base, was: from } });
	else if (d.to === 'unknown') await alert(env, { level: 'critical', title: 'Disbursement outcome unknown: money may have moved, check the provider', details: base });
	else if (d.to === 'failed' && r.kind === 'disbursement') await alert(env, { level: 'warning', title: 'Disbursement failed', details: { ...base, error: obs.state === 'failed' ? (obs.detail ?? obs.error) : undefined } });
}

/** An event that changes no status (for example a payment that arrived for the wrong amount). Deduplicated by `key`, so a re-check never repeats it. */
async function note(env: Env, row: PaymentRow, type: string, key: string, detail: string, now: number): Promise<boolean> {
	const evtId = `evt_${row.id}_n_${(await sha256Hex(key)).slice(0, 12)}`;
	const seen = await env.DB.prepare(`SELECT 1 AS x FROM payment_events WHERE payment_id = ? AND type = ? AND detail = ?`).bind(row.id, type, detail).first();
	if (seen) return false;
	await env.DB.batch([
		env.DB.prepare(`INSERT INTO payment_events (payment_id, version, type, actor, detail, created_at) VALUES (?, NULL, ?, 'provider', ?, ?)`).bind(row.id, type, detail, now),
		outbox(env, row.tenant_id, evtId, row.id, `payment.${type}`, view(env, row), { detail: undefined }, now),
	]);
	return true;
}

const event = (env: Env, id: string, type: string, actor: string, detail: string | null, now = Date.now()) =>
	env.DB.prepare(`INSERT INTO payment_events (payment_id, version, type, actor, detail, created_at) VALUES (?, NULL, ?, ?, ?, ?)`).bind(id, type, actor, detail, now).run();

// ---- creating ---------------------------------------------------------------------------------------------------------------------

const REFERENCE = /^[A-Za-z0-9_-]{3,64}$/;
const MIN_AMOUNT = 100;
const MAX_METADATA = 2048;
const EXPIRY: Record<Rail, number> = { mobile_money: 15 * 60, pispi_qr: 3 * 3600, pispi_rtp: 3600 };
const RTP_PER_ALIAS_DAY = 3;
const DAY = 86_400_000;

interface Normalised {
	reference: string; rail: Rail; operator: string | null; counterparty: string; country: string | null; amount: number; metadata: string | null;
	preAuthCode?: string; successUrl?: string; failedUrl?: string; expiresInSeconds: number;
}

function normalise(env: Env, tenant: Tenant, kind: Kind, body: unknown): Normalised {
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_request', 'A JSON object is required');
	const b = body as Record<string, unknown>;
	const bad = (message: string, code = 'invalid_request') => new ApiError(400, code, message);

	if (typeof b.reference !== 'string' || !REFERENCE.test(b.reference)) throw bad('reference is required: 3 to 64 letters, digits, dashes or underscores. It is your own id for this payment and makes the call safe to retry.', 'invalid_reference');
	const max = tenant.max_amount ?? Number(env.DEFAULT_MAX_AMOUNT);
	if (typeof b.amount !== 'number' || !Number.isInteger(b.amount) || b.amount < MIN_AMOUNT) throw bad(`amount must be a whole number of XOF, at least ${MIN_AMOUNT}`, 'invalid_amount');
	if (b.amount > max) throw new ApiError(422, 'amount_too_large', `amount is above the limit for this account (${max} XOF)`);
	if (b.currency !== undefined && b.currency !== 'XOF') throw bad('Only XOF is supported', 'invalid_currency');

	const rail = (b.rail ?? 'mobile_money') as Rail;
	if (rail !== 'mobile_money' && rail !== 'pispi_qr' && rail !== 'pispi_rtp') throw bad('rail is mobile_money, pispi_qr or pispi_rtp', 'invalid_rail');
	if (kind === 'disbursement' && rail !== 'mobile_money') throw bad('Disbursements are mobile_money only', 'invalid_rail');

	let metadata: string | null = null;
	if (b.metadata !== undefined && b.metadata !== null) {
		if (typeof b.metadata !== 'object' || Array.isArray(b.metadata)) throw bad('metadata must be an object', 'invalid_metadata');
		metadata = JSON.stringify(b.metadata);
		if (metadata.length > MAX_METADATA) throw bad(`metadata is limited to ${MAX_METADATA} characters`, 'invalid_metadata');
	}

	let operator: string | null = null, counterparty = '', country: string | null = null;
	if (rail === 'mobile_money') {
		operator = typeof b.operator === 'string' ? b.operator : null;
		if (!operator || !OPERATORS.has(operator)) throw bad('operator is orange, wave or moov', 'invalid_operator');
		counterparty = typeof b.phone === 'string' ? b.phone.replace(/[\s\-()]/g, '') : '';
		const p = parsePhone(counterparty);
		if (!p) throw bad('phone must be an E.164 number in Côte d\'Ivoire, Senegal or Burkina Faso, e.g. +2250789458900', 'invalid_phone');
		country = p.country;
	} else if (rail === 'pispi_rtp') {
		counterparty = typeof b.payerAlias === 'string' ? b.payerAlias.trim().toLowerCase() : '';
		if (!PAYER_ALIAS.test(counterparty)) throw bad('payerAlias is the customer\'s PI-SPI alias, a UUID like 9b1b3499-3e50-435b-b757-ac7a83d8aa96', 'invalid_payer_alias');
	}

	const out: Normalised = { reference: b.reference, rail, operator, counterparty, country, amount: b.amount, metadata, expiresInSeconds: EXPIRY[rail] };
	if (kind === 'collection') {
		if (b.expiresInSeconds !== undefined) {
			if (typeof b.expiresInSeconds !== 'number' || !Number.isInteger(b.expiresInSeconds) || b.expiresInSeconds < 60 || b.expiresInSeconds > 86_400) throw bad('expiresInSeconds is 60 to 86400', 'invalid_expiry');
			out.expiresInSeconds = b.expiresInSeconds;
		}
		if (typeof b.preAuthCode === 'string' && b.preAuthCode) {
			if (!/^[A-Za-z0-9]{3,16}$/.test(b.preAuthCode)) throw bad('preAuthCode looks wrong', 'invalid_pre_auth_code');
			out.preAuthCode = b.preAuthCode;
		}
		for (const k of ['successUrl', 'failedUrl'] as const) {
			if (b[k] === undefined) continue;
			const u = safeUrl(b[k], { allowLocalHttp: !on(env.LIVE) });
			if (!u) throw bad(`${k} must be an absolute https URL`, 'invalid_url');
			out[k] = u;
		}
	}
	return out;
}

/** What makes two requests "the same" for idempotency: everything that decides who is charged or paid, how much, and how. The metadata and the one-time code are not part of it. */
const requestHash = (n: Normalised) => sha256Hex(canonical({ rail: n.rail, operator: n.operator, counterparty: n.counterparty, amount: n.amount }));

export interface Created { payment: PaymentView; created: boolean }

export async function createPayment(env: Env, tenant: Tenant, kind: Kind, body: unknown, providers: Providers, now = Date.now()): Promise<Created> {
	const n = normalise(env, tenant, kind, body);
	const hash = await requestHash(n);

	const existing = await getRowFor(env, tenant.id, kind, n.reference);
	if (existing && existing.reference === n.reference) {
		if (existing.request_hash !== hash) throw new ApiError(409, 'idempotency_conflict', 'A payment with this reference already exists with different details. Use a new reference for a new payment.');
		return { payment: view(env, await refresh(env, existing, providers, { now })), created: false };
	}

	// the provider must be able to do this, and the amount must fit its limits: refused now, before anything is recorded or any money moves
	let methodJson: string | null = null, authType: string | null = null, provider = providers.collect.name;
	if (n.rail === 'mobile_money' && kind === 'collection') {
		const m = await providers.collect.method(n.operator!, n.counterparty);
		if (!m) throw new ApiError(422, 'provider_unavailable', 'This provider is not available for this number');
		if (n.amount < m.min || n.amount > m.max) throw new ApiError(422, 'amount_out_of_bounds', 'This amount is outside the provider limits', { min: m.min, max: m.max });
		if (m.authType === 'PREAUTH' && !n.preAuthCode) throw new ApiError(422, 'pre_auth_code_required', 'The customer must first get a one-time code, then send it as preAuthCode', { codeInstructions: m.codeInstructions });
		if (m.authType === 'REDIRECT_AUTH' && (!n.successUrl || !n.failedUrl)) throw new ApiError(422, 'redirect_urls_required', 'successUrl and failedUrl are required for this provider (the customer is sent to its app and then back)');
		methodJson = JSON.stringify({ instructions: m.instructions, codeInstructions: m.codeInstructions });
		authType = m.authType;
	} else if (n.rail === 'mobile_money') {
		const ok = await providers.disburse.supports(n.operator!, n.counterparty, n.amount);
		if (ok !== true) throw new ApiError(422, 'provider_unavailable', ok);
		provider = providers.disburse.name;
	} else {
		provider = 'pispi';
		if (!pispiEnabled(env)) throw new ApiError(422, 'provider_unavailable', 'PI-SPI is not available');
		if (n.rail === 'pispi_rtp') {
			if (!pispiRtpEnabled(env)) throw new ApiError(422, 'provider_unavailable', 'PI-SPI payment requests are not available');
			// a payment request lands on a stranger's phone: a customer is not asked over and over
			const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM payments WHERE rail = 'pispi_rtp' AND counterparty = ? AND created_at > ?`).bind(n.counterparty, now - DAY).first<{ n: number }>();
			if ((recent?.n ?? 0) >= RTP_PER_ALIAS_DAY) throw new ApiError(429, 'rtp_limit', 'This customer has been sent too many payment requests today');
		}
	}

	const id = newId('pg');
	const providerId = n.rail === 'mobile_money' ? await providerIdFor(tenant, kind, n.reference) : null;
	const insert = await env.DB.prepare(`INSERT OR IGNORE INTO payments (id, tenant_id, kind, reference, rail, operator, country, counterparty, amount, status, provider, provider_id, auth_type, method, request_hash, metadata, expires_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.bind(id, tenant.id, kind, n.reference, n.rail, n.operator, n.country, n.counterparty, n.amount, provider, providerId, authType, methodJson, hash, n.metadata, kind === 'collection' ? now + n.expiresInSeconds * 1000 : null, now, now).run();
	if (!insert.meta.changes) { // a concurrent call with the same reference won: it starts the payment, we return it
		const won = (await getRowFor(env, tenant.id, kind, n.reference))!;
		if (won.request_hash !== hash) throw new ApiError(409, 'idempotency_conflict', 'A payment with this reference already exists with different details.');
		return { payment: view(env, won), created: false };
	}
	await event(env, id, 'created', `tenant:${tenant.id}`, null, now);

	let row = (await getRow(env, id))!;
	if (kind === 'collection') row = await startCollection(env, row, n, providers, now);
	else row = await startDisbursement(env, row, providers, now);
	return { payment: view(env, row), created: true };
}

async function startCollection(env: Env, row: PaymentRow, n: Normalised, providers: Providers, now: number): Promise<PaymentRow> {
	if (row.rail === 'pispi_qr') return row; // nothing to start: the customer scans the code; the payment is found by polling (or confirmed by a person)
	if (row.rail === 'pispi_rtp') {
		try {
			const r = await sendPaymentRequest(env, { txId: pispiTxId(row.id), payerAlias: row.counterparty, amount: row.amount, label: 'Payment' }, now);
			if (r.state === 'rejected') return (await applyObserved(env, row, { state: 'failed', error: 'The payment request was declined', detail: `PI-SPI ${r.reason}` }, 'provider', now)).row;
			await env.DB.prepare(`UPDATE payments SET attempts = 1, provider_ref = COALESCE(?, provider_ref) WHERE id = ?`).bind(r.end2endId, row.id).run();
			await event(env, row.id, 'accepted', 'provider', r.end2endId, now);
		} catch (e) { // ours to fix (credentials, the alias): the customer is not told they were rejected
			const detail = e instanceof Error ? e.message : String(e);
			await alert(env, { level: 'warning', title: 'PI-SPI payment request could not be sent', details: { payment: row.id, tenant: row.tenant_id, error: detail.slice(0, 200) } });
			return (await applyObserved(env, row, { state: 'failed', error: 'The payment could not be started', detail }, 'provider', now)).row;
		}
		return (await getRow(env, row.id))!;
	}
	try {
		const init = await providers.collect.initiate({ providerId: row.provider_id!, paymentId: row.id, amount: row.amount, phone: row.counterparty, operator: row.operator!, preAuthCode: n.preAuthCode, successUrl: n.successUrl, failedUrl: n.failedUrl });
		if (init.state === 'rejected') return (await applyObserved(env, row, { state: 'failed', error: init.error, detail: init.detail }, 'provider', now)).row;
		await env.DB.prepare(`UPDATE payments SET attempts = 1, next_step = ?, auth_url = ?, updated_at = ? WHERE id = ?`).bind(init.nextStep, init.authUrl, now, row.id).run();
		await event(env, row.id, 'accepted', 'provider', null, now);
	} catch (e) {
		// The request may or may not have reached the provider. Nothing is assumed: the payment stays processing and the status check decides.
		await env.DB.prepare(`UPDATE payments SET attempts = 1 WHERE id = ?`).bind(row.id).run();
		await event(env, row.id, 'initiate_unknown', 'provider', e instanceof Error ? e.message.slice(0, 300) : String(e), now);
		log('payment.initiate_unknown', { id: row.id });
	}
	return (await getRow(env, row.id))!;
}

/** Sends a disbursement once. Only the caller that moves attempts 0 -> 1 calls the provider, so it is never called twice concurrently. */
export async function startDisbursement(env: Env, row: PaymentRow, providers: Providers, now = Date.now()): Promise<PaymentRow> {
	const claim = await env.DB.prepare(`UPDATE payments SET attempts = 1, updated_at = ? WHERE id = ? AND attempts = 0 AND status = 'processing'`).bind(now, row.id).run();
	if (!claim.meta.changes) return (await getRow(env, row.id)) ?? row;
	try {
		const out = await providers.disburse.send({ providerId: row.provider_id!, paymentId: row.id, amount: row.amount, phone: row.counterparty, operator: row.operator! });
		if (out.state === 'completed') return (await applyObserved(env, row, { state: 'completed' }, 'provider', now)).row;
		if (out.state === 'failed') return (await applyObserved(env, row, { state: 'failed', error: out.error, detail: out.detail }, 'provider', now)).row;
		await event(env, row.id, 'accepted', 'provider', null, now); // pending: the callback or the recheck settles it
	} catch (e) {
		// Unknown outcome: money may have moved. Left for the status check and then a person; NEVER retried automatically.
		return (await applyObserved(env, row, { state: 'unknown', detail: `UNKNOWN OUTCOME: ${e instanceof Error ? e.message : String(e)}` }, 'provider', now)).row;
	}
	return (await getRow(env, row.id))!;
}

// ---- reading and re-checking ------------------------------------------------------------------------------------------------------

const CHECK_EVERY_MS = 4_000;

/** Whether the provider is worth asking about this payment now. */
export function worthChecking(r: PaymentRow, now: number): boolean {
	if (isOpen(r.status)) return true;
	if (r.status === 'expired') return r.rail === 'mobile_money' ? now - r.updated_at < RECHECK_FAILED_FOR_MS : now - r.updated_at < PISPI_LATE_MS;
	if (r.status === 'failed') return r.rail === 'mobile_money' && now - r.updated_at < RECHECK_FAILED_FOR_MS; // a clean "never started" failure can still complete if the request was merely slow
	return false;
}

/** Asks the provider where a payment stands and applies the answer. A provider that can't be reached changes nothing. */
export async function refresh(env: Env, r: PaymentRow, providers: Providers, opts: { force?: boolean; now?: number } = {}): Promise<PaymentRow> {
	const now = opts.now ?? Date.now();
	if (!worthChecking(r, now)) return r;
	if (!opts.force && r.last_checked_at && now - r.last_checked_at < CHECK_EVERY_MS) return r;
	await env.DB.prepare(`UPDATE payments SET last_checked_at = ? WHERE id = ?`).bind(now, r.id).run();
	r = { ...r, last_checked_at: now };
	try { return r.rail === 'mobile_money' ? await refreshMobileMoney(env, r, providers, now) : await refreshPispi(env, r, now); }
	catch (e) { log('payment.refresh_failed', { id: r.id, error: e instanceof Error ? e.message : String(e) }); return r; } // unreachable: the next check asks again
}

async function refreshMobileMoney(env: Env, r: PaymentRow, providers: Providers, now: number): Promise<PaymentRow> {
	const ctx = { phone: r.counterparty };
	const failedToStart = { state: 'failed' as const, error: r.kind === 'collection' ? 'The payment could not be started' : 'The payout could not be completed', detail: NOT_FOUND_DETAIL };
	let next: { state: 'pending'; nextStep: string | null; authUrl: string | null } | null = null;
	let s: { state: 'completed' } | { state: 'failed'; error: string; detail: string } | { state: 'not_found' } | { state: 'pending' };
	if (r.kind === 'collection') {
		const c = await providers.collect.status(r.provider_id!, ctx);
		if (c.state === 'pending') next = c;
		s = c;
	} else {
		const d = await providers.disburse.status(r.provider_id!, ctx);
		s = d.state === 'failed' ? { state: 'failed', error: d.error, detail: d.error } : d.state === 'not_found' ? { state: 'not_found' } : d;
	}
	if (s.state === 'completed') return (await applyObserved(env, r, { state: 'completed' }, 'reconcile', now)).row; // also a late completion of a failed or expired one
	if (r.status !== 'processing' && r.status !== 'unknown') return r; // failed or expired: only a completion changes anything
	if (s.state === 'failed') return (await applyObserved(env, r, { state: 'failed', error: s.error, detail: s.detail }, 'reconcile', now)).row;
	if (s.state === 'not_found') {
		// the provider never heard of it: after a grace period (a request can still be on its way) that is a clean failure to start
		return now - r.created_at > NOT_FOUND_GRACE_MS ? (await applyObserved(env, r, failedToStart, 'reconcile', now)).row : r;
	}
	if (next) {
		await env.DB.prepare(`UPDATE payments SET next_step = COALESCE(?, next_step), auth_url = COALESCE(?, auth_url) WHERE id = ? AND status = 'processing'`).bind(next.nextStep, next.authUrl, r.id).run();
		if (r.expires_at && now > r.expires_at) return (await applyObserved(env, r, { state: 'expired' }, 'reconcile', now)).row;
	}
	return (await getRow(env, r.id)) ?? r;
}

/**
 * PI-SPI: asks PI-SPI whether the payment arrived (only when PISPI_POLL is on) and settles it only if it is irrevocable, on our alias, for exactly the
 * amount. Anything else is left for a person (a mismatch also alerts). A late payment on an expired one is honoured. One received payment settles one order.
 */
async function refreshPispi(env: Env, r: PaymentRow, now: number): Promise<PaymentRow> {
	if (!pispiPollEnabled(env)) return r;
	const verdict = judge(pispiAlias(env), { id: r.id, amount: r.amount, rtp: r.rail === 'pispi_rtp', payerAlias: r.counterparty }, await receivedPaymentsFor(env, pispiTxId(r.id), now));
	if (verdict.kind === 'paid') {
		const used = await env.DB.prepare(`SELECT id FROM payments WHERE provider_ref = ? AND id <> ? AND provider = 'pispi'`).bind(verdict.end2endId, r.id).first();
		if (used) return r;
		return (await applyObserved(env, r, { state: 'completed', providerRef: verdict.end2endId }, 'reconcile', now)).row;
	}
	if (verdict.kind === 'mismatch') {
		if (await note(env, r, 'mismatch', verdict.end2endId, `${verdict.end2endId}: ${verdict.reason}`, now))
			await alert(env, { level: 'critical', title: 'A PI-SPI payment arrived but does not match its order: check it by hand', details: { payment: r.id, tenant: r.tenant_id, endToEndId: verdict.end2endId, reason: verdict.reason, expected: r.amount } });
		return r;
	}
	if (r.status === 'processing' && r.expires_at && now > r.expires_at) return (await applyObserved(env, r, { state: 'expired' }, 'reconcile', now)).row;
	return r;
}

// ---- listing ------------------------------------------------------------------------------------------------------------------------

export async function listPayments(env: Env, tenantId: string, kind: Kind, q: { status?: string | null; limit?: number; before?: number | null }): Promise<{ data: PaymentView[]; next: number | null }> {
	const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
	const where = [`tenant_id = ?`, `kind = ?`], binds: unknown[] = [tenantId, kind];
	if (q.status) { where.push(`status = ?`); binds.push(q.status); }
	if (q.before) { where.push(`created_at < ?`); binds.push(q.before); }
	const { results } = await env.DB.prepare(`SELECT * FROM payments WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).bind(...binds, limit + 1).all<PaymentRow>();
	const page = results.slice(0, limit);
	return { data: page.map((r) => view(env, r)), next: results.length > limit ? page[page.length - 1]!.created_at : null };
}

/** The history of one payment, oldest first (tenant-visible fields only). */
export async function history(env: Env, row: PaymentRow): Promise<{ type: string; actor: string; at: number }[]> {
	const { results } = await env.DB.prepare(`SELECT type, actor, created_at FROM payment_events WHERE payment_id = ? ORDER BY id`).bind(row.id).all<{ type: string; actor: string; created_at: number }>();
	return results.map((e) => ({ type: e.type, actor: e.actor.startsWith('admin:') ? 'operator' : e.actor.startsWith('tenant:') ? 'you' : e.actor, at: e.created_at }));
}
