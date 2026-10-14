import { verifyCallback, type KeyFetcher } from './httpSig.ts';
import { parsePhone, providerCode } from './phone.ts';
import { on, safeUrl } from '../util.ts';
import type { CallbackEvent, CollectInit, CollectProvider, CollectRequest, CollectStatus, DisburseOutcome, DisburseProvider, DisburseRequest, DisburseStatus, Method, WalletBalance } from './types.ts';

/**
 * pawaPay (https://docs.pawapay.io/v2): collects FCFA (XOF) from a customer's mobile money (deposits) and pays it out (payouts).
 *  - The provider id (a UUIDv4 derived from the tenant's reference, see ids.ts) is the idempotency key: a retry can never charge or pay twice
 *    (pawaPay answers DUPLICATE_IGNORED).
 *  - ACCEPTED means "started", not done: the result comes by signed callback (RFC 9421) or by asking for the status.
 *  - REJECTED and 4xx are definitive (nothing happened). A timeout or a 5xx is NOT: we ask for the status first (pawaPay's own guidance), and only if
 *    that fails too is the outcome unknown (the adapter throws, and the caller must not retry on its own).
 *  - Deposits authenticate three ways, per provider: PROVIDER_AUTH (PIN on the phone), REDIRECT_AUTH (Wave: the customer is sent to an URL),
 *    PREAUTH (Orange Burkina Faso: the customer first gets a one-time code).
 *  - An unsigned callback is never trusted: refused outright with LIVE=true, otherwise its claim is confirmed with a status call.
 */

export const PRODUCTION_URL = 'https://api.pawapay.io';
export const SANDBOX_URL = 'https://api.sandbox.pawapay.io';

/** The base URL may be given with or without the API version (https://api.pawapay.io or https://api.pawapay.io/v2). */
export const normalizeBase = (u: string) => u.trim().replace(/\/+$/, '').replace(/\/v\d+$/, '');

/**
 * Money safety: the sandbox moves no money, so it can't be used with LIVE=true; the production API moves real money, so it can't be used while
 * LIVE is not true.
 */
export function assertSafeBase(base: string, live: boolean) {
	if (live && /sandbox/i.test(base)) throw new Error('PAWAPAY_BASE_URL points at the pawaPay sandbox but LIVE=true');
	if (!live && normalizeBase(base) === PRODUCTION_URL) throw new Error('PAWAPAY_BASE_URL is pawaPay production but LIVE is not true');
}

type Failure = { failureCode?: string; failureMessage?: string } | undefined;
const detailOf = (f: Failure) => [f?.failureCode, f?.failureMessage].filter(Boolean).join(': ') || 'no reason given';

// ---- messages a customer may see (the raw code stays in logs: some codes, like our own empty wallet, are not the customer's business) ----

export function friendlyDepositFailure(code: string | undefined): string {
	const c = code ?? '';
	if (c === 'PAYER_NOT_FOUND' || c === 'INVALID_PHONE_NUMBER') return 'This number is not registered with the selected mobile money provider';
	if (c === 'PAYMENT_NOT_APPROVED') return 'The payment was not approved on your phone';
	if (c === 'INSUFFICIENT_BALANCE') return 'Your mobile money balance is too low';
	if (c === 'PAYER_LIMIT_REACHED' || c === 'WALLET_LIMIT_REACHED') return 'A mobile money limit was reached';
	if (c === 'PAYMENT_IN_PROGRESS') return 'Another payment is already waiting on this number';
	if (/AUTH/.test(c) && /CODE|TOKEN|PRE/.test(c)) return 'The code is wrong or has expired';
	if (c === 'AMOUNT_OUT_OF_BOUNDS' || c === 'INVALID_AMOUNT') return 'This amount is outside the provider limits';
	if (c === 'PROVIDER_TEMPORARILY_UNAVAILABLE') return 'Mobile money is temporarily unavailable';
	return 'The payment could not be completed';
}

export function friendlyPayoutFailure(code: string | undefined): string {
	switch (code) {
		case 'RECIPIENT_NOT_FOUND': case 'INVALID_PHONE_NUMBER': return 'This number is not registered with the selected mobile money provider';
		case 'WALLET_LIMIT_REACHED': return 'The recipient has reached a mobile money limit';
		case 'AMOUNT_OUT_OF_BOUNDS': case 'INVALID_AMOUNT': return 'This amount is outside the provider limits';
		case 'PAWAPAY_WALLET_OUT_OF_FUNDS': case 'PROVIDER_TEMPORARILY_UNAVAILABLE': return 'Payouts are temporarily unavailable';
		default: return 'The payout could not be completed';
	}
}

// ---- reading pawaPay's answers (pure) ---------------------------------------------------------------------------------------

/** Finds `instructions: { en: [{text}], fr: [{text}] }` anywhere inside a configuration fragment (its exact nesting differs per flow). */
export function extractInstructions(node: unknown): { en: string[]; fr: string[] } | null {
	if (!node || typeof node !== 'object') return null;
	const o = node as Record<string, unknown>;
	const ins = o.instructions as Record<string, unknown> | undefined;
	if (ins && typeof ins === 'object' && (Array.isArray(ins.en) || Array.isArray(ins.fr))) {
		const lines = (v: unknown) => (Array.isArray(v) ? v.flatMap((x) => (typeof (x as { text?: unknown })?.text === 'string' ? [(x as { text: string }).text] : typeof x === 'string' ? [x] : [])) : []);
		const en = lines(ins.en), fr = lines(ins.fr);
		return { en: en.length ? en : fr, fr: fr.length ? fr : en };
	}
	for (const v of Object.values(o)) { const r = extractInstructions(v); if (r) return r; }
	return null;
}

/** pawaPay's active configuration (operationType DEPOSIT) -> the XOF deposit methods on this account. */
export function parseDepositConf(body: unknown): Map<string, Method> {
	const out = new Map<string, Method>();
	const countries = (body as { countries?: unknown[] } | null)?.countries;
	for (const c of Array.isArray(countries) ? countries : []) {
		for (const p of (c as { providers?: unknown[] }).providers ?? []) {
			const prov = p as { provider?: string; currencies?: { currency?: string; operationTypes?: { DEPOSIT?: Record<string, unknown> } }[] };
			const d = prov.currencies?.find((x) => x.currency === 'XOF')?.operationTypes?.DEPOSIT;
			if (!prov.provider || !d) continue;
			const authType = typeof d.authType === 'string' ? d.authType : 'PROVIDER_AUTH';
			out.set(prov.provider, {
				code: prov.provider, authType, status: typeof d.status === 'string' ? d.status : 'UNKNOWN',
				min: Number(d.minAmount ?? 0), max: Number(d.maxAmount ?? Infinity),
				instructions: extractInstructions(d.pinPromptInstructions),
				codeInstructions: extractInstructions(d.authTokenInstructions) ?? (authType === 'PREAUTH' ? extractInstructions(d) : null),
			});
		}
	}
	return out;
}

export interface PayoutConf { status: string; min: number; max: number }

/** pawaPay's active configuration (operationType PAYOUT) -> the XOF payout providers that exist on this account. */
export function parsePayoutConf(body: unknown): Map<string, PayoutConf> {
	const out = new Map<string, PayoutConf>();
	const countries = (body as { countries?: unknown[] } | null)?.countries;
	for (const c of Array.isArray(countries) ? countries : []) {
		for (const p of (c as { providers?: unknown[] }).providers ?? []) {
			const prov = p as { provider?: string; currencies?: { currency?: string; operationTypes?: { PAYOUT?: { status?: string; minAmount?: string; maxAmount?: string } } }[] };
			const payout = prov.currencies?.find((x) => x.currency === 'XOF')?.operationTypes?.PAYOUT;
			if (prov.provider && payout) out.set(prov.provider, { status: payout.status ?? 'UNKNOWN', min: Number(payout.minAmount ?? 0), max: Number(payout.maxAmount ?? Infinity) });
		}
	}
	return out;
}

/** OPERATIONAL and DELAYED providers take new payments or payouts; CLOSED and anything unknown cannot. */
export const takes = (c: { status: string } | undefined): boolean => !!c && (c.status === 'OPERATIONAL' || c.status === 'DELAYED');

export function classifyDeposit(body: unknown): CollectStatus {
	const b = body as { status?: string; data?: { status?: string; nextStep?: string; authorizationUrl?: string; failureReason?: Failure } } | null;
	if (b?.status === 'NOT_FOUND') return { state: 'not_found' };
	const d = b?.data;
	if (b?.status !== 'FOUND' || !d?.status) return { state: 'pending', nextStep: null, authUrl: null };
	if (d.status === 'COMPLETED') return { state: 'completed' };
	if (d.status === 'FAILED') return { state: 'failed', error: friendlyDepositFailure(d.failureReason?.failureCode), detail: detailOf(d.failureReason) };
	return { state: 'pending', nextStep: d.nextStep ?? null, authUrl: safeUrl(d.authorizationUrl) };
}

export function classifyPayout(body: unknown): DisburseStatus {
	const b = body as { status?: string; data?: { status?: string; failureReason?: Failure } } | null;
	if (b?.status === 'NOT_FOUND') return { state: 'not_found', error: 'pawaPay did not receive this payout' };
	const d = b?.data;
	if (b?.status !== 'FOUND' || !d?.status) return { state: 'pending' };
	if (d.status === 'COMPLETED') return { state: 'completed' };
	if (d.status === 'FAILED') return { state: 'failed', error: friendlyPayoutFailure(d.failureReason?.failureCode) };
	return { state: 'pending' }; // ACCEPTED, ENQUEUED, PROCESSING, IN_RECONCILIATION: still moving
}

// ---- the adapter ---------------------------------------------------------------------------------------------------------------

type Cache = { get(k: string): Promise<string | null>; put(k: string, v: string, o: { expirationTtl: number }): Promise<void> };
export interface PawapayDeps { fetch?: typeof fetch; cache?: Cache }
type PawapayEnv = Pick<Env, 'LIVE' | 'PAWAPAY_BASE_URL' | 'PAWAPAY_API_TOKEN'>;

export function createPawapay(env: PawapayEnv, deps: PawapayDeps = {}): { collect: CollectProvider; disburse: DisburseProvider; parseCallback(body: string, headers: Headers, url: URL): Promise<CallbackEvent | null> } {
	const live = on(env.LIVE);
	const base = normalizeBase(env.PAWAPAY_BASE_URL || SANDBOX_URL);
	assertSafeBase(base, live);
	if (!env.PAWAPAY_API_TOKEN) throw new Error('PAWAPAY_API_TOKEN is not set');
	const doFetch = deps.fetch ?? fetch;
	const auth = { authorization: `Bearer ${env.PAWAPAY_API_TOKEN}`, 'content-type': 'application/json' };

	const depositStatus = async (providerId: string): Promise<CollectStatus> => {
		const res = await doFetch(`${base}/v2/deposits/${providerId}`, { headers: auth, signal: AbortSignal.timeout(10_000) });
		if (!res.ok) throw new Error(`pawaPay deposit status failed (${res.status})`);
		return classifyDeposit(await res.json());
	};
	const payoutStatus = async (providerId: string): Promise<DisburseStatus> => {
		const res = await doFetch(`${base}/v2/payouts/${providerId}`, { headers: auth, signal: AbortSignal.timeout(10_000) });
		if (!res.ok) throw new Error(`pawaPay payout status failed (${res.status})`);
		return classifyPayout(await res.json());
	};

	const publicKey: KeyFetcher = async (keyid) => {
		const cached = await deps.cache?.get(`pawapay:key:${keyid}`);
		if (cached) return cached;
		const res = await doFetch(`${base}/v2/public-key/http`, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) return null;
		const hit = ((await res.json()) as { id?: string; key?: string }[]).find((k) => k.id === keyid)?.key ?? null;
		if (hit) await deps.cache?.put(`pawapay:key:${keyid}`, hit, { expirationTtl: 3600 });
		return hit;
	};

	/** The account's configuration for one country and operation, cached 10 minutes. null = could not be read. */
	async function conf<T>(country: string, op: 'DEPOSIT' | 'PAYOUT', parse: (b: unknown) => Map<string, T>): Promise<Map<string, T> | null> {
		const key = `pawapay:conf:${op}:${country}`;
		const cached = await deps.cache?.get(key);
		if (cached) return new Map(JSON.parse(cached) as [string, T][]);
		const res = await doFetch(`${base}/v2/active-conf?country=${country}&operationType=${op}`, { headers: auth, signal: AbortSignal.timeout(8_000) });
		if (!res.ok) return null;
		const m = parse(await res.json());
		await deps.cache?.put(key, JSON.stringify([...m]), { expirationTtl: 600 });
		return m;
	}

	const collect: CollectProvider = {
		name: 'pawapay',

		async method(operator, phone) {
			const code = providerCode(operator, phone), info = parsePhone(phone);
			if (!code || !info) return null;
			try {
				const m = (await conf(info.country, 'DEPOSIT', parseDepositConf))?.get(code);
				return m && takes(m) ? m : null;
			} catch { return null; } // can't read the configuration: don't sell what we can't be sure we can collect
		},

		status: depositStatus,

		async initiate(req: CollectRequest): Promise<CollectInit> {
			const phone = parsePhone(req.phone), code = providerCode(req.operator, req.phone);
			if (!phone || !code) return { state: 'rejected', error: 'This provider is not available for your number', detail: 'no pawaPay provider for this operator and number' };
			const body: Record<string, unknown> = {
				depositId: req.providerId, amount: String(req.amount), currency: 'XOF',
				payer: { type: 'MMO', accountDetails: { phoneNumber: phone.msisdn, provider: code } },
				customerMessage: 'Payment', clientReferenceId: req.paymentId,
			};
			if (req.preAuthCode) body.preAuthorisationCode = req.preAuthCode;
			if (req.successUrl) body.successfulUrl = req.successUrl;
			if (req.failedUrl) body.failedUrl = req.failedUrl;
			try {
				const res = await doFetch(`${base}/v2/deposits`, { method: 'POST', headers: auth, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
				const j = (await res.json().catch(() => null)) as { status?: string; nextStep?: string; authorizationUrl?: string; failureReason?: Failure } | null;
				if (res.status === 200 && (j?.status === 'ACCEPTED' || j?.status === 'DUPLICATE_IGNORED')) return { state: 'accepted', nextStep: j.nextStep ?? null, authUrl: safeUrl(j.authorizationUrl) };
				if (j?.status === 'REJECTED' || (res.status >= 400 && res.status < 500))
					return { state: 'rejected', error: friendlyDepositFailure(j?.failureReason?.failureCode), detail: `${res.status} ${detailOf(j?.failureReason)}` };
				// 5xx or unreadable: not safe to assume it failed -> ask
			} catch { /* timeout or network error: same */ }
			let s: CollectStatus;
			try { s = await depositStatus(req.providerId); } catch (e) { throw new Error(`pawaPay deposit outcome unknown: ${e instanceof Error ? e.message : String(e)}`); }
			if (s.state === 'not_found') return { state: 'rejected', error: 'The payment could not be started', detail: 'pawaPay never received the request (NOT_FOUND)' };
			if (s.state === 'failed') return { state: 'rejected', error: s.error, detail: s.detail };
			return { state: 'accepted', nextStep: s.state === 'pending' ? s.nextStep : null, authUrl: s.state === 'pending' ? s.authUrl : null };
		},
	};

	const disburse: DisburseProvider = {
		name: 'pawapay',

		/** The operator must be in our mapping AND active on the account, not closed, and the amount within the provider's limits (Orange Senegal caps a payout far below others). If the configuration can't be read we fall back to the mapping alone, so a pawaPay hiccup never blocks everything. */
		async supports(operator, phone, amount) {
			const NOT_AVAILABLE = 'This provider is not available for your number';
			const code = providerCode(operator, phone);
			if (!code) return NOT_AVAILABLE;
			try {
				const all = await conf(parsePhone(phone)!.country, 'PAYOUT', parsePayoutConf);
				if (!all) return true; // the configuration could not be read
				const c = all.get(code);
				if (!c || !takes(c)) return NOT_AVAILABLE;
				if (amount !== undefined && (amount < c.min || amount > c.max)) return 'This amount is outside the provider limits';
				return true;
			} catch { return true; }
		},

		status: payoutStatus,

		async balances(): Promise<WalletBalance[]> {
			const res = await doFetch(`${base}/v2/wallet-balances`, { headers: auth, signal: AbortSignal.timeout(10_000) });
			if (!res.ok) throw new Error(`pawaPay wallet balances failed (${res.status})`);
			const j = (await res.json()) as { balances?: { country?: string; currency?: string; balance?: string; provider?: string }[] };
			return (j.balances ?? []).flatMap((b) => (b.country && b.currency && b.balance !== undefined && Number.isFinite(Number(b.balance)) ? [{ country: b.country, currency: b.currency, balance: Number(b.balance), provider: b.provider }] : []));
		},

		async send(req: DisburseRequest): Promise<DisburseOutcome> {
			const phone = parsePhone(req.phone), code = providerCode(req.operator, req.phone);
			if (!phone || !code) return { state: 'failed', error: 'This provider is not available for your country', detail: `no pawaPay provider for ${req.operator} ${req.phone.slice(0, 4)}` };
			const body = {
				payoutId: req.providerId, amount: String(req.amount), currency: 'XOF',
				recipient: { type: 'MMO', accountDetails: { phoneNumber: phone.msisdn, provider: code } },
				customerMessage: 'Payout', clientReferenceId: req.paymentId,
			};
			try {
				const res = await doFetch(`${base}/v2/payouts`, { method: 'POST', headers: auth, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
				const j = (await res.json().catch(() => null)) as { status?: string; failureReason?: Failure } | null;
				if (res.status === 200 && (j?.status === 'ACCEPTED' || j?.status === 'DUPLICATE_IGNORED')) return { state: 'pending' }; // already accepted earlier counts: its callback or the recheck settles it
				if (res.status === 200 && j?.status === 'REJECTED') return { state: 'failed', error: friendlyPayoutFailure(j.failureReason?.failureCode), detail: detailOf(j.failureReason) };
				if (res.status >= 400 && res.status < 500) return { state: 'failed', error: 'The payout could not be completed', detail: `pawaPay ${res.status}: ${detailOf(j?.failureReason)}` }; // our request or credentials are wrong: nothing was sent
				// 5xx or an unreadable answer: "not safe to assume the initiation has failed" -> fall through to the status check
			} catch { /* timeout or network error: same */ }
			let s: DisburseStatus;
			try { s = await payoutStatus(req.providerId); } catch (e) { throw new Error(`pawaPay outcome unknown: ${e instanceof Error ? e.message : String(e)}`); }
			if (s.state === 'completed') return { state: 'completed' };
			if (s.state === 'pending') return { state: 'pending' };
			return { state: 'failed', error: s.state === 'not_found' ? 'The payout could not be completed' : s.error, detail: s.state === 'not_found' ? 'pawaPay never received the request (status NOT_FOUND)' : s.error };
		},
	};

	async function parseCallback(body: string, headers: Headers, url: URL): Promise<CallbackEvent | null> {
		let v: { depositId?: string; payoutId?: string; clientReferenceId?: string; status?: string; failureReason?: Failure };
		try { v = JSON.parse(body); } catch { return null; }
		const direction = typeof v.depositId === 'string' ? 'collection' : typeof v.payoutId === 'string' ? 'disbursement' : null;
		if (!direction) return null;
		const providerId = (direction === 'collection' ? v.depositId : v.payoutId)!;
		const clientReference = typeof v.clientReferenceId === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(v.clientReferenceId) ? v.clientReferenceId : null;
		const signed = headers.has('signature') || headers.has('signature-input');
		// With real money a callback must be signed (callback signatures are on in pawaPay's dashboard). An unsigned one is refused before
		// anything else: it would otherwise cost us an outbound status call for any anonymous caller.
		if (!signed && live) { console.warn(JSON.stringify({ msg: 'pawapay.callback.unsigned_refused' })); return null; }
		if (signed) {
			if (!(await verifyCallback({ method: 'POST', url, headers, body }, publicKey))) return null;
			if (v.status === 'COMPLETED') return { direction, providerId, clientReference, state: 'completed' };
			if (v.status === 'FAILED') return { direction, providerId, clientReference, state: 'failed', error: direction === 'collection' ? friendlyDepositFailure(v.failureReason?.failureCode) : friendlyPayoutFailure(v.failureReason?.failureCode) };
			return { direction, providerId, clientReference, state: 'ignore' };
		}
		// Unsigned (sandbox only): never trust the body. Ask pawaPay what really happened.
		console.warn(JSON.stringify({ msg: 'pawapay.callback.unsigned', providerId }));
		try {
			const s = direction === 'collection' ? await depositStatus(providerId) : await payoutStatus(providerId);
			if (s.state === 'completed') return { direction, providerId, clientReference, state: 'completed' };
			if (s.state === 'failed') return { direction, providerId, clientReference, state: 'failed', error: s.error };
			return { direction, providerId, clientReference, state: 'ignore' };
		} catch { return null; }
	}

	return { collect, disburse, parseCallback };
}
