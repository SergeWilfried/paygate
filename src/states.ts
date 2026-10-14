import type { Kind } from './ids.ts';

/**
 * The payment lifecycle, as pure functions (no I/O), so every transition is unit-tested.
 *
 *   processing -> completed | failed | expired (collections only) | unknown (disbursements only)
 *   unknown    -> completed | failed          (the provider finally says; or a person decides)
 *   failed     -> completed                   (a LATE completion: the provider says the money did move after we had called it failed)
 *   expired    -> completed                   (the customer paid after the window)
 *   completed  -> nothing                     (final; repeats are harmless)
 *
 * The provider is the source of truth for money, so a completion is always honoured; a failure never overrides a completion.
 */
export type Status = 'processing' | 'completed' | 'failed' | 'expired' | 'unknown';

export type Observed =
	| { state: 'completed'; providerRef?: string }
	| { state: 'failed'; error: string; detail?: string }
	| { state: 'expired' }
	| { state: 'unknown'; detail: string };

export interface Decision {
	to: Status;
	/** the event recorded in payment_events */
	event: string;
	/** the webhook type sent to the tenant */
	webhook: 'payment.completed' | 'payment.failed' | 'payment.expired' | 'payment.unknown';
	/** a completion after the payment had already been reported failed or expired: the tenant may have acted on the earlier word */
	late: boolean;
}

export function decide(kind: Kind, from: Status, obs: Observed): Decision | null {
	if (from === 'completed') return null;
	switch (obs.state) {
		case 'completed': {
			const late = from === 'failed' || from === 'expired';
			return { to: 'completed', event: late ? 'late_completion' : 'completed', webhook: 'payment.completed', late };
		}
		case 'failed':
			return from === 'processing' || from === 'unknown' ? { to: 'failed', event: 'failed', webhook: 'payment.failed', late: false } : null;
		case 'expired':
			return kind === 'collection' && from === 'processing' ? { to: 'expired', event: 'expired', webhook: 'payment.expired', late: false } : null;
		case 'unknown':
			return kind === 'disbursement' && from === 'processing' ? { to: 'unknown', event: 'unknown', webhook: 'payment.unknown', late: false } : null;
	}
}

export const isFinal = (s: Status) => s === 'completed';
/** Statuses the reconciler asks the provider about. */
export const isOpen = (s: Status) => s === 'processing' || s === 'unknown';

/** How long a payment the provider has never heard of is given before it counts as failed to start. */
export const NOT_FOUND_GRACE_MS = 120_000;
/** The detail recorded when WE concluded a payment failed because the provider had no record of it (as opposed to the provider saying it failed). */
export const NOT_FOUND_DETAIL = 'The provider never received the request (NOT_FOUND)';
/** A failed or expired payment is looked at again for this long, because a lost or slow request can still complete later. */
export const RECHECK_FAILED_FOR_MS = 24 * 3_600_000;
export const RECHECK_FAILED_EVERY_MS = 3_600_000;
/** An expired PI-SPI payment is still honoured if the customer pays within this long. */
export const PISPI_LATE_MS = 7 * 24 * 3_600_000;
