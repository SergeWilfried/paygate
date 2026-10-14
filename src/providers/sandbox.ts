import type { CollectProvider, DisburseProvider } from './types.ts';

/**
 * The sandbox: no money moves, nothing is sent to anyone. For development and demos only (refused with LIVE=true, see providers/index.ts).
 * Behaviour is driven by the last digits of the phone number, so every path can be tried:
 *   ...0000  -> refused at once (collection) / definitive failure (payout)
 *   ...0002  -> accepted, then fails                 ...9999 -> accepted, never settles on its own (a person resolves it)
 *   ...5555  -> network error: the outcome is unknown (payout), accepted-but-unconfirmed (collection)
 *   anything else -> completes on the first status check (collection) / immediately (payout)
 * Collections have a PROVIDER_AUTH method with generic instructions; the limits are 100 to 1 000 000 XOF.
 */
export const sandboxCollect: CollectProvider = {
	name: 'sandbox',
	async method(operator, phone) {
		if (!/^\+(225|221|226)\d{8,}$/.test(phone) || !['orange', 'wave', 'moov'].includes(operator)) return null;
		return { code: `SANDBOX_${operator.toUpperCase()}`, authType: 'PROVIDER_AUTH', status: 'OPERATIONAL', min: 100, max: 1_000_000, instructions: { en: ['Approve the payment on your phone (sandbox)'], fr: ['Approuvez le paiement sur votre téléphone (sandbox)'] }, codeInstructions: null };
	},
	async initiate(req) {
		if (req.phone.endsWith('0000')) return { state: 'rejected', error: 'This number is not registered with the selected mobile money provider', detail: 'sandbox refusal' };
		if (req.phone.endsWith('5555')) throw new Error('Sandbox network error');
		return { state: 'accepted', nextStep: null, authUrl: null };
	},
	async status(_providerId, ctx) {
		const phone = ctx?.phone ?? '';
		if (phone.endsWith('0002') || phone.endsWith('0000')) return { state: 'failed', error: 'The payment was not approved on your phone', detail: 'sandbox failure' };
		if (phone.endsWith('9999') || phone.endsWith('5555')) return { state: 'pending', nextStep: null, authUrl: null };
		return { state: 'completed' };
	},
};

export const sandboxDisburse: DisburseProvider = {
	name: 'sandbox',
	async supports(operator, phone) { return /^\+(225|221|226)\d{8,}$/.test(phone) && ['orange', 'wave', 'moov'].includes(operator) ? true : 'This provider is not available for your number'; },
	async send({ phone }) {
		if (phone.endsWith('5555')) throw new Error('Sandbox network error');
		if (phone.endsWith('0000')) return { state: 'failed', error: 'This number is not registered with the selected mobile money provider' };
		if (phone.endsWith('9999')) return { state: 'pending' };
		return { state: 'completed' };
	},
	async status(_providerId, ctx) {
		const phone = ctx?.phone ?? '';
		if (phone.endsWith('0000')) return { state: 'failed', error: 'This number is not registered with the selected mobile money provider' };
		if (phone.endsWith('9999') || phone.endsWith('5555')) return { state: 'pending' };
		return { state: 'completed' };
	},
};
