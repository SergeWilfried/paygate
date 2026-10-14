/** How a customer pays or is paid. */
export type Rail = 'mobile_money' | 'pispi_qr' | 'pispi_rtp';

/** A way to take payment, as the provider says it works (read from its live configuration). */
export interface Method {
	/** provider code, e.g. ORANGE_CIV */
	code: string;
	/** PROVIDER_AUTH = approve with a PIN on the phone; REDIRECT_AUTH = the customer is sent to the provider's app (Wave); PREAUTH = the customer first gets a one-time code (Orange Burkina Faso) */
	authType: string;
	status: string;
	min: number;
	max: number;
	/** PROVIDER_AUTH: steps to approve the payment if the prompt doesn't appear by itself (USSD), per language */
	instructions: { en: string[]; fr: string[] } | null;
	/** PREAUTH: steps to get the one-time code, per language */
	codeInstructions: { en: string[]; fr: string[] } | null;
}

// ---- collections (money in) ---------------------------------------------------------------------------------------------

export interface CollectRequest {
	/** the id the provider knows it by (a UUIDv4): the provider's idempotency key */
	providerId: string;
	/** our payment id, echoed back in the callback (clientReferenceId) */
	paymentId: string;
	amount: number;
	/** E.164 */
	phone: string;
	operator: string;
	/** PREAUTH only: the one-time code the customer was given */
	preAuthCode?: string;
	/** REDIRECT_AUTH only: where the provider sends the customer afterwards */
	successUrl?: string;
	failedUrl?: string;
}

export type CollectInit =
	| { state: 'accepted'; nextStep: string | null; authUrl: string | null }
	/** definitively not started (nothing was charged) */
	| { state: 'rejected'; error: string; detail: string };

export type CollectStatus =
	| { state: 'completed' }
	| { state: 'pending'; nextStep: string | null; authUrl: string | null }
	| { state: 'failed'; error: string; detail: string }
	| { state: 'not_found' };

export interface CollectProvider {
	readonly name: string;
	/** How this operator takes payment in this number's country, or null when it can't (unmapped, not enabled on the account, closed). */
	method(operator: string, phone: string): Promise<Method | null>;
	/** Throws only when the outcome is unknown (the request may have reached the provider). */
	initiate(req: CollectRequest): Promise<CollectInit>;
	/** `ctx` is the payment's own details; real providers ignore it (they look the id up), the sandbox decides from the number. */
	status(providerId: string, ctx?: { phone: string }): Promise<CollectStatus>;
}

// ---- disbursements (money out) ---------------------------------------------------------------------------------------------

export interface DisburseRequest {
	providerId: string;
	paymentId: string;
	amount: number;
	phone: string;
	operator: string;
}

export type DisburseOutcome =
	| { state: 'completed' }
	/** accepted but not final; the provider will call back (or the status recheck settles it) */
	| { state: 'pending' }
	/** definitively not sent. `error` is what the customer may see; `detail` is for logs and alerts only. */
	| { state: 'failed'; error: string; detail?: string };

/** What the provider says about a payout we already sent. `not_found` = the provider never received it. */
export type DisburseStatus = { state: 'completed' } | { state: 'pending' } | { state: 'failed'; error: string } | { state: 'not_found'; error: string };

export interface WalletBalance { country: string; currency: string; balance: number; provider?: string }

export interface DisburseProvider {
	readonly name: string;
	/** Throws on network/timeouts: the outcome is then UNKNOWN and must not be retried automatically. */
	send(req: DisburseRequest): Promise<DisburseOutcome>;
	/** `true`, or the reason this operator/number/amount can't be paid, in words a customer may read. */
	supports(operator: string, phone: string, amount?: number): Promise<true | string>;
	status(providerId: string, ctx?: { phone: string }): Promise<DisburseStatus>;
	/** Our prepaid balance with the provider, per country. */
	balances?(): Promise<WalletBalance[]>;
}

// ---- callbacks ---------------------------------------------------------------------------------------------------------------

/** A verified provider callback, reduced to what the gateway acts on. `ignore` = genuine but needs no action (not final yet, or not for this endpoint). */
export interface CallbackEvent {
	direction: 'collection' | 'disbursement';
	providerId: string;
	/** the clientReferenceId we sent (our payment id), when the provider echoes it */
	clientReference: string | null;
	state: 'completed' | 'failed' | 'ignore';
	error?: string;
}

export interface Providers {
	mode: string;
	collect: CollectProvider;
	disburse: DisburseProvider;
	/** Verifies and parses a pawaPay callback; null = reject (bad signature / unreadable). `url` is the URL the provider called (the signature covers host and path). */
	parseCallback(body: string, headers: Headers, url: URL): Promise<CallbackEvent | null>;
}
