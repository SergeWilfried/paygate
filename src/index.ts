import { adminApi } from './admin.ts';
import { handleProviderCallback } from './callbacks.ts';
import { ApiError } from './errors.ts';
import { checkFloat, loadFloat } from './float.ts';
import type { Kind } from './ids.ts';
import { createPayment, getRowFor, history, listPayments, refresh, view } from './payments.ts';
import { pispiEnabled, pispiPollEnabled, pispiRtpEnabled } from './providers/pispi.ts';
import { getProviders } from './providers/index.ts';
import type { Providers } from './providers/types.ts';
import { reconcile } from './reconcile.ts';
import { authenticate, type Tenant } from './tenants.ts';
import { deliverDue, queuePing } from './webhooks.ts';
import { log, on } from './util.ts';

const MAX_JSON_BYTES = 16 * 1024;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function readJson(request: Request): Promise<unknown> {
	if (Number(request.headers.get('content-length') ?? 0) > MAX_JSON_BYTES) throw new ApiError(413, 'payload_too_large', 'The request is too large');
	const text = await request.text();
	if (text.length > MAX_JSON_BYTES) throw new ApiError(413, 'payload_too_large', 'The request is too large');
	try { return JSON.parse(text); } catch { throw new ApiError(400, 'invalid_json', 'The body is not valid JSON'); }
}

const KIND: Record<string, Kind> = { collections: 'collection', disbursements: 'disbursement' };

/** The tenant API, `/v1/*`. Every read and write is scoped to the tenant the key belongs to. */
async function tenantApi(env: Env, request: Request, ctx: ExecutionContext, path: string, providers: Providers): Promise<Response> {
	const tenant: Tenant = await authenticate(env, request);
	const url = new URL(request.url);
	const wake = () => ctx.waitUntil(deliverDue(env).then(() => undefined, (e) => console.error(JSON.stringify({ msg: 'webhooks.failed', error: String(e) }))));
	let g: RegExpExecArray | null;

	if ((g = /^\/v1\/(collections|disbursements)$/.exec(path))) {
		const kind = KIND[g[1]!]!;
		if (request.method === 'POST') {
			const r = await createPayment(env, tenant, kind, await readJson(request), providers);
			wake();
			return json(r.payment, r.created ? 201 : 200);
		}
		if (request.method === 'GET') {
			const ref = url.searchParams.get('reference');
			if (ref) { // the payment with this reference of yours (not a list)
				const row = await getRowFor(env, tenant.id, kind, ref);
				if (!row || row.reference !== ref) throw new ApiError(404, 'not_found', 'No payment with this reference');
				return json(view(env, await refresh(env, row, providers)));
			}
			return json(await listPayments(env, tenant.id, kind, { status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') ?? 25) || 25, before: Number(url.searchParams.get('before')) || null }));
		}
		throw new ApiError(405, 'method_not_allowed', 'Method not allowed');
	}
	if ((g = /^\/v1\/(collections|disbursements)\/([A-Za-z0-9_-]{3,64})(\/events)?$/.exec(path))) {
		if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'Method not allowed');
		const row = await getRowFor(env, tenant.id, KIND[g[1]!]!, g[2]!);
		if (!row) throw new ApiError(404, 'not_found', 'No such payment');
		if (g[3]) return json({ data: await history(env, row) });
		return json(view(env, await refresh(env, row, providers)));
	}
	if (path === '/v1/methods' && request.method === 'GET') return json(await methods(env, url, providers));
	if (path === '/v1/float' && request.method === 'GET') return json(await loadFloat(env, providers));
	if (path === '/v1/webhooks/test' && request.method === 'POST') {
		if (!tenant.webhook_url) throw new ApiError(422, 'no_webhook', 'This account has no webhook URL');
		const id = await queuePing(env, tenant.id);
		wake();
		return json({ queued: id });
	}
	if (path === '/v1/me' && request.method === 'GET') return json({ id: tenant.id, name: tenant.name, webhookUrl: tenant.webhook_url, maxAmount: tenant.max_amount ?? Number(env.DEFAULT_MAX_AMOUNT), mode: providers.mode, live: on(env.LIVE) });
	throw new ApiError(404, 'not_found', 'No such endpoint');
}

/** Whether a way of paying is available, and its limits: ask BEFORE showing a customer an option they cannot use. */
async function methods(env: Env, url: URL, providers: Providers) {
	const rail = url.searchParams.get('rail') ?? 'mobile_money';
	if (rail === 'pispi_qr') return { rail, available: pispiEnabled(env), direction: 'collect', manualConfirmation: !pispiPollEnabled(env) };
	if (rail === 'pispi_rtp') return { rail, available: pispiRtpEnabled(env), direction: 'collect' };
	if (rail !== 'mobile_money') throw new ApiError(400, 'invalid_rail', 'rail is mobile_money, pispi_qr or pispi_rtp');
	const operator = url.searchParams.get('operator') ?? '', phone = (url.searchParams.get('phone') ?? '').replace(/[\s\-()]/g, '');
	const direction = url.searchParams.get('direction') === 'disburse' ? 'disburse' : 'collect';
	if (direction === 'disburse') {
		const amount = url.searchParams.get('amount') ? Number(url.searchParams.get('amount')) : undefined;
		const r = await providers.disburse.supports(operator, phone, amount);
		return { rail, direction, available: r === true, reason: r === true ? null : r };
	}
	const m = await providers.collect.method(operator, phone);
	if (!m) return { rail, direction, available: false, reason: 'This provider is not available for this number' };
	return { rail, direction, available: true, authType: m.authType, min: m.min, max: Number.isFinite(m.max) ? m.max : null, instructions: m.instructions, codeInstructions: m.codeInstructions };
}

export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	try {
		if (path === '/health') return json({ ok: true });
		const providers = getProviders(env);
		if (path === '/callbacks/pawapay/deposits' || path === '/callbacks/pawapay/payouts') {
			if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Method not allowed');
			const res = await handleProviderCallback(env, request, providers, path.endsWith('deposits') ? 'collection' : 'disbursement');
			ctx.waitUntil(deliverDue(env).then(() => undefined, () => undefined));
			return res;
		}
		if (path.startsWith('/v1/')) return await tenantApi(env, request, ctx, path, providers);
		if (path.startsWith('/admin/')) {
			const res = await adminApi(env, request, path, providers);
			if (res) return res;
		}
		throw new ApiError(404, 'not_found', 'No such endpoint');
	} catch (e) {
		if (e instanceof ApiError) return json({ error: { code: e.code, message: e.message, ...e.extra } }, e.status);
		console.error(JSON.stringify({ msg: 'request.failed', path, error: e instanceof Error ? e.message : String(e) }));
		return json({ error: { code: 'internal', message: 'Something went wrong on our side' } }, 500);
	}
}

export default {
	fetch: handle,

	/** Every minute: deliver webhooks, settle what the callbacks missed. Every fifth minute: check the float. Each step fails alone. */
	async scheduled(controller: ScheduledController, env: Env): Promise<void> {
		const run = async (name: string, f: () => Promise<unknown>) => { try { await f(); } catch (e) { console.error(JSON.stringify({ msg: 'cron.failed', step: name, error: e instanceof Error ? e.message : String(e) })); } };
		const providers = getProviders(env);
		await run('webhooks', () => deliverDue(env));
		await run('reconcile', () => reconcile(env, providers));
		if (new Date(controller.scheduledTime).getUTCMinutes() % 5 === 0) await run('float', () => checkFloat(env, providers));
		log('cron.done', {});
	},
} satisfies ExportedHandler<Env>;
