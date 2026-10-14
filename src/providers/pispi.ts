/**
 * PI-SPI (the BCEAO instant payment system), Business API. Collections only:
 *  - a DYNAMIC QR code for the gateway's own alias, paid from the customer's bank app, or
 *  - a payment request (RTP, category 500, no confirmation step) that the customer approves in their bank app.
 * The payment is confirmed by PI-SPI's own record of received payments (`GET /<participant>/paiements-recus`, scope paiement.read), never by the
 * customer's word. The participant code (for example BFC999) is part of the path: `/v1/...` is a different, empty namespace.
 * Reading and sending are separate switches: PISPI_POLL reads, PISPI_RTP also sends requests. Neither moves money out.
 */
import { on } from '../util.ts';

type PispiEnv = Pick<Env, 'PISPI_ENABLED' | 'PISPI_POLL' | 'PISPI_RTP' | 'PISPI_COUNTRY' | 'PI_SPI_PARTICIPANT' | 'PI_SPI_BUSINESS_API_URL' | 'PI_SP_API_OAUTH_URL' | 'PI_SP_API_CLIENT_ID' | 'PI_SP_API_CLIENT_SECRET' | 'PI_SPI_API_KEY' | 'PI_SPI_ACCOUNT_ALIAS'>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** What the QR format and the payer's bank allow as the payment reference. */
export const PISPI_REF_MAX = 25;
/** The payer alias a payment request is addressed to: a UUID. */
export const PAYER_ALIAS = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function pispiAlias(env: PispiEnv): string | null {
	const a = env.PI_SPI_ACCOUNT_ALIAS?.trim();
	return a && UUID_V4.test(a) ? a.toLowerCase() : null;
}
export const pispiEnabled = (env: PispiEnv): boolean => on(env.PISPI_ENABLED) && pispiAlias(env) !== null;
export const pispiPollEnabled = (env: PispiEnv): boolean =>
	pispiEnabled(env) && on(env.PISPI_POLL) && !!(env.PI_SPI_PARTICIPANT && env.PI_SPI_BUSINESS_API_URL && env.PI_SP_API_OAUTH_URL && env.PI_SP_API_CLIENT_ID && env.PI_SP_API_CLIENT_SECRET && env.PI_SPI_API_KEY);
export const pispiRtpEnabled = (env: PispiEnv): boolean => pispiPollEnabled(env) && on(env.PISPI_RTP);

/** The reference the payer's bank shows with the payment, and the txId we match on: our payment id, upper case. */
export const pispiTxId = (paymentId: string) => paymentId.toUpperCase();

export interface PispiQr { alias: string; countryCode: string; qrType: 'DYNAMIC'; referenceLabel: string; amount: number }

export function pispiQr(env: PispiEnv, p: { id: string; amount: number }): PispiQr | null {
	const alias = pispiAlias(env);
	if (!alias) return null;
	return { alias, countryCode: (env.PISPI_COUNTRY ?? 'BF').toUpperCase(), qrType: 'DYNAMIC', referenceLabel: pispiTxId(p.id), amount: p.amount };
}

// an access token lasts 24 hours: kept for 23, per scope, per isolate (it is not request data)
const tokens = new Map<string, { token: string; until: number }>();
async function accessToken(env: PispiEnv, scope: string, now: number): Promise<string> {
	const key = `${env.PI_SP_API_CLIENT_ID}:${scope}`;
	const hit = tokens.get(key);
	if (hit && hit.until > now) return hit.token;
	const res = await fetch(env.PI_SP_API_OAUTH_URL, {
		method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.PI_SP_API_CLIENT_ID!, client_secret: env.PI_SP_API_CLIENT_SECRET!, scope }).toString(),
	});
	const j = (await res.json().catch(() => ({}))) as { access_token?: string };
	if (!res.ok || !j.access_token) throw new Error(`PI-SPI token: ${res.status}`);
	tokens.set(key, { token: j.access_token, until: now + 23 * 3_600_000 });
	return j.access_token;
}
export const clearPispiTokens = () => tokens.clear();

/** PI-SPI's own explanation of an error (its `detail`, else `title`), short, for the logs: a bare status says nothing about what to fix. */
async function reason(res: Response): Promise<string> {
	const j = (await res.json().catch(() => ({}))) as { detail?: unknown; title?: unknown; 'invalid-params'?: { name?: string; reason?: string }[] };
	const text = typeof j.detail === 'string' ? j.detail : typeof j.title === 'string' ? j.title : '';
	const params = Array.isArray(j['invalid-params']) ? j['invalid-params'].map((x) => `${x.name ?? '?'}: ${x.reason ?? '?'}`).join('; ') : '';
	return [text, params].filter(Boolean).join(' | ').slice(0, 300);
}

export interface ReceivedPayment { txId: string; payeurAlias?: string; payeAlias: string; montant: number; categorie: string; statut: string; end2endId: string; dateIrrevocabilite?: string }

/** The received payments carrying this txId. Throws when PI-SPI cannot be reached or answers an error. */
export async function receivedPaymentsFor(env: PispiEnv, txId: string, now = Date.now()): Promise<ReceivedPayment[]> {
	const url = `${env.PI_SPI_BUSINESS_API_URL}/${encodeURIComponent(env.PI_SPI_PARTICIPANT)}/paiements-recus?txId=${encodeURIComponent(txId)}`;
	const call = async (token: string) => fetch(url, { headers: { authorization: `Bearer ${token}`, 'x-api-key': env.PI_SPI_API_KEY! } });
	let res = await call(await accessToken(env, 'piz/paiement.read', now));
	if (res.status === 401) { tokens.clear(); res = await call(await accessToken(env, 'piz/paiement.read', now)); } // a token revoked early
	if (!res.ok) throw new Error(`PI-SPI paiements-recus: ${res.status} ${await reason(res)}`.trim());
	const j = (await res.json()) as { data?: ReceivedPayment[] };
	return Array.isArray(j.data) ? j.data : [];
}

export type RequestResult = { state: 'sent'; end2endId: string | null } | { state: 'rejected'; reason: string };

/**
 * Sends the customer a payment request. The payment id is the txId. A duplicate txId (DU03) means an earlier try already got through, so it counts
 * as sent. Throws when PI-SPI cannot be reached or answers an error that is ours to fix (credentials, the payee alias): the caller must not tell
 * the customer it was rejected.
 */
export async function sendPaymentRequest(env: PispiEnv, input: { txId: string; payerAlias: string; amount: number; label: string }, now = Date.now()): Promise<RequestResult> {
	const url = `${env.PI_SPI_BUSINESS_API_URL}/${encodeURIComponent(env.PI_SPI_PARTICIPANT)}/demandes-paiements`;
	const body = JSON.stringify({ txId: input.txId, confirmation: false, categorie: '500', payeurAlias: input.payerAlias, payeAlias: pispiAlias(env), montant: input.amount, motif: input.label });
	const call = async () => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${await accessToken(env, 'piz/demande_paiement.write', now)}`, 'x-api-key': env.PI_SPI_API_KEY!, 'content-type': 'application/json' }, body });
	let res = await call();
	if (res.status === 401) { tokens.clear(); res = await call(); }
	if (!res.ok) throw new Error(`PI-SPI demandes-paiements: ${res.status} ${await reason(res)}`.trim());
	const j = (await res.json().catch(() => ({}))) as { statut?: string; statutRaison?: string; end2endId?: string };
	if (j.statut === 'REJETE') return j.statutRaison === 'DU03' ? { state: 'sent', end2endId: null } : { state: 'rejected', reason: j.statutRaison ?? 'REJETE' };
	if (j.statut === 'ENVOYE' || j.statut === 'INITIE' || j.statut === 'CONFIRME' || j.statut === 'IRREVOCABLE') return { state: 'sent', end2endId: j.end2endId ?? null };
	throw new Error(`PI-SPI demandes-paiements: unexpected status ${String(j.statut)}`);
}

export type Verdict = { kind: 'none' } | { kind: 'pending' } | { kind: 'paid'; end2endId: string } | { kind: 'mismatch'; reason: string; end2endId: string };

/**
 * What the received payments say about a payment. Paid only when one of them is irrevocable, on our alias, from a dynamic QR (400) or a payment
 * request (500), for exactly the payment's amount (and, for a payment request, from the payer it was sent to). Money that arrived for a different
 * amount or by another route is a mismatch for a person, never a settlement.
 */
export function judge(alias: string | null, p: { id: string; amount: number; rtp: boolean; payerAlias: string }, payments: ReceivedPayment[]): Verdict {
	const category = p.rtp ? '500' : '400';
	const mine = payments.filter((x) => x.txId?.toLowerCase() === p.id.toLowerCase() && x.payeAlias?.toLowerCase() === alias && (!p.rtp || !p.payerAlias || x.payeurAlias?.toLowerCase() === p.payerAlias.toLowerCase()));
	if (!mine.length) return { kind: 'none' };
	const final = mine.filter((x) => x.statut === 'IRREVOCABLE');
	if (!final.length) return mine.some((x) => x.statut === 'REJETE') && !mine.some((x) => x.statut === 'ENVOYE' || x.statut === 'CONFIRME') ? { kind: 'none' } : { kind: 'pending' };
	const exact = final.find((x) => x.categorie === category && x.montant === p.amount);
	if (exact) return { kind: 'paid', end2endId: exact.end2endId };
	const odd = final[0]!;
	return { kind: 'mismatch', end2endId: odd.end2endId, reason: odd.categorie !== category ? `category ${odd.categorie}, expected ${category}` : `${odd.montant} XOF received, ${p.amount} expected` };
}
