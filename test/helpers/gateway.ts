import { createEnv, stubFetch, type Call } from './env.ts';
import { handle } from '../../src/index.ts';
import { createApiKey, createTenant } from '../../src/tenants.ts';

export const B64 = (u: Uint8Array) => { let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s); };

/** A Worker ExecutionContext that remembers what was handed to waitUntil, so a test can wait for it. */
export function fakeCtx() {
	const pending: Promise<unknown>[] = [];
	return { ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => {})); }, passThroughOnException() {} } as unknown as ExecutionContext, settle: () => Promise.all(pending) };
}

export type Harness = ReturnType<typeof createEnv>;

/** An env, a tenant with an API key, and a function that calls the Worker like a product would. */
export async function setup(over: Record<string, unknown> = {}, tenantInput: Record<string, unknown> = {}) {
	const e = createEnv(over);
	const tenant = await createTenant(e.env, { id: 'shop', name: 'Shop', ...tenantInput });
	const { key } = await createApiKey(e.env, tenant.id, 'test');
	const { ctx, settle } = fakeCtx();
	const call = async (method: string, path: string, body?: unknown, auth: string | null = key) => {
		const headers: Record<string, string> = {};
		if (auth) headers.authorization = `Bearer ${auth}`;
		if (body !== undefined) headers['content-type'] = 'application/json';
		const res = await handle(new Request(`https://gw.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), e.env, ctx);
		await settle();
		return { status: res.status, body: (await res.json().catch(() => null)) as any };
	};
	/** another product on the same gateway */
	const addTenant = async (id: string, input: Record<string, unknown> = {}) => {
		await createTenant(e.env, { id, name: id, ...input });
		const k = (await createApiKey(e.env, id, 'test')).key;
		return (method: string, path: string, body?: unknown) => call(method, path, body, k);
	};
	const admin = async (method: string, path: string, body?: unknown) => call(method, path, body, e.env.ADMIN_API_KEY as string);
	const row = (id: string) => e.sqlite.prepare('SELECT * FROM payments WHERE id = ?').get(id) as Record<string, any>;
	const events = (id: string) => e.sqlite.prepare('SELECT type, actor, version, detail FROM payment_events WHERE payment_id = ? ORDER BY id').all(id) as { type: string; actor: string; version: number | null; detail: string | null }[];
	return { ...e, tenant, key, call, admin, addTenant, row, events, settle, ctx };
}

export const COLLECT = { reference: 'order-0001', amount: 5000, operator: 'orange', phone: '+2250700000001' };
export const PAYOUT = { reference: 'payout-0001', amount: 5000, operator: 'orange', phone: '+2250700000001' };

export { stubFetch, type Call };

// ---- a pawaPay that signs its callbacks (RFC 9421, ecdsa-p256-sha256) ----------------------------------------------------------------

export async function signer() {
	const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
	const spki = new Uint8Array((await crypto.subtle.exportKey('spki', kp.publicKey)) as ArrayBuffer);
	const pem = `-----BEGIN PUBLIC KEY-----\n${B64(spki).match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
	return { kp, pem };
}

export async function signedCallbackRequest(body: string, kp: CryptoKeyPair, path: string, over: { created?: number; host?: string } = {}) {
	const created = over.created ?? Math.floor(Date.now() / 1000);
	const host = over.host ?? 'gw.test';
	const digest = `sha-512=:${B64(new Uint8Array(await crypto.subtle.digest('SHA-512', new TextEncoder().encode(body))))}:`;
	const covered = '"@method" "@authority" "@path" "signature-date" "content-digest" "content-type"';
	const params = `(${covered});alg="ecdsa-p256-sha256";keyid="HTTP_EC_P256_KEY:1";created=${created};expires=${created + 60}`;
	const date = '2026-10-03T10:00:00.123456Z';
	const lines: Record<string, string> = { '"@method"': 'POST', '"@authority"': host, '"@path"': path, '"signature-date"': date, '"content-digest"': digest, '"content-type"': 'application/json; charset=UTF-8' };
	const base = [...covered.matchAll(/"[^"]+"/g)].map((c) => `${c[0]}: ${lines[c[0]]}`).concat(`"@signature-params": ${params}`).join('\n');
	const sig = B64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(base))));
	return new Request(`https://${host}${path}`, {
		method: 'POST', body,
		headers: { signature: `sig-pp=:${sig}:`, 'signature-input': `sig-pp=${params}`, 'signature-date': date, 'content-digest': digest, 'content-type': 'application/json; charset=UTF-8' },
	});
}

/** pawaPay's API for a test: the account's configuration, deposits and payouts, with each answer settable. */
export interface PawapayState { depositAnswer?: () => Response; payoutAnswer?: () => Response; depositStatus?: unknown; payoutStatus?: unknown; pem?: string; balances?: unknown }
export function pawapayStub(state: PawapayState = {}) {
	const conf = (op: string) => ({ countries: [{ country: 'CIV', providers: [{ provider: 'ORANGE_CIV', currencies: [{ currency: 'XOF', operationTypes: { [op]: { status: 'OPERATIONAL', minAmount: '100', maxAmount: '1000000', authType: 'PROVIDER_AUTH', pinPromptInstructions: { instructions: { en: [{ text: 'Dial *144#' }], fr: [{ text: 'Composez *144#' }] } } } } }] }] }] });
	const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
	return (c: Call): Response | undefined => {
		const u = new URL(c.url);
		if (u.host !== 'api.sandbox.pawapay.io' && u.host !== 'api.pawapay.io') return undefined;
		if (u.pathname === '/v2/active-conf') return ok(conf(u.searchParams.get('operationType') ?? 'DEPOSIT'));
		if (u.pathname === '/v2/public-key/http') return ok(state.pem ? [{ id: 'HTTP_EC_P256_KEY:1', key: state.pem }] : []);
		if (u.pathname === '/v2/wallet-balances') return ok(state.balances ?? { balances: [] });
		if (u.pathname === '/v2/deposits' && c.method === 'POST') return state.depositAnswer?.() ?? ok({ status: 'ACCEPTED' });
		if (u.pathname === '/v2/payouts' && c.method === 'POST') return state.payoutAnswer?.() ?? ok({ status: 'ACCEPTED' });
		if (u.pathname.startsWith('/v2/deposits/')) return ok(state.depositStatus ?? { status: 'FOUND', data: { status: 'PROCESSING' } });
		if (u.pathname.startsWith('/v2/payouts/')) return ok(state.payoutStatus ?? { status: 'FOUND', data: { status: 'PROCESSING' } });
		return undefined;
	};
}
