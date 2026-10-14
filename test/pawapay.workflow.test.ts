import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { silence } from './helpers/env.ts';
import { COLLECT, PAYOUT, pawapayStub, type PawapayState, setup, signedCallbackRequest, signer, stubFetch } from './helpers/gateway.ts';
import { handle } from '../src/index.ts';
import { fakeCtx } from './helpers/gateway.ts';
import { providerIdFor } from '../src/ids.ts';
import { getProviders } from '../src/providers/index.ts';
import { reconcile } from '../src/reconcile.ts';
import { refresh, getRow } from '../src/payments.ts';

let restore: () => void;
let net: ReturnType<typeof stubFetch>;
let stub: ReturnType<typeof pawapayStub>;
let state: PawapayState;
const PAWAPAY = { PROVIDER_MODE: 'pawapay' };
beforeEach(() => { restore = silence(); state = {}; stub = pawapayStub(state); net = stubFetch((c) => stub(c)); });
afterEach(() => { net.restore(); restore(); });

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const sent = (path: string) => net.calls.filter((c) => c.method === 'POST' && new URL(c.url).pathname === path).map((c) => JSON.parse(c.body!));

test('a collection is started at pawaPay with the derived id, our payment id as the reference, and the instructions for the customer', async () => {
  const g = await setup(PAWAPAY);
  const r = await g.call('POST', '/v1/collections', COLLECT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'processing');
  assert.deepEqual(r.body.method.instructions.fr, ['Composez *144#']);
  const [dep] = sent('/v2/deposits');
  assert.equal(dep.depositId, await providerIdFor(g.tenant, 'collection', COLLECT.reference));
  assert.equal(dep.clientReferenceId, r.body.id);
  assert.equal(dep.amount, '5000');
  assert.equal(dep.currency, 'XOF');
  assert.deepEqual(dep.payer.accountDetails, { phoneNumber: '2250700000001', provider: 'ORANGE_CIV' });
  assert.ok(!JSON.stringify(r.body).includes(dep.depositId), 'the provider id is not exposed');
});

test('amount limits and unavailable providers are refused before anything is sent to pawaPay', async () => {
  const g = await setup(PAWAPAY);
  const low = await g.call('POST', '/v1/collections', { ...COLLECT, amount: 100_000_000 }); // above the tenant default first
  assert.equal(low.body.error.code, 'amount_too_large');
  const g2 = await setup(PAWAPAY, { maxAmount: 5_000_000 });
  const big = await g2.call('POST', '/v1/collections', { ...COLLECT, amount: 2_000_000 });
  assert.equal(big.status, 422);
  assert.equal(big.body.error.code, 'amount_out_of_bounds');
  assert.deepEqual([big.body.error.min, big.body.error.max], [100, 1_000_000]);
  const wave = await g2.call('POST', '/v1/collections', { ...COLLECT, operator: 'wave' }); // not enabled on the stubbed account
  assert.equal(wave.body.error.code, 'provider_unavailable');
  assert.equal(sent('/v2/deposits').length, 0);
});

test('a rejected deposit is a clean failure with a customer-safe message', async () => {
  state.depositAnswer = () => json({ status: 'REJECTED', failureReason: { failureCode: 'PAYER_NOT_FOUND', failureMessage: 'internal words' } });
  const g = await setup(PAWAPAY);
  const r = await g.call('POST', '/v1/collections', COLLECT);
  assert.equal(r.body.status, 'failed');
  assert.equal(r.body.failure, 'This number is not registered with the selected mobile money provider');
  assert.ok(!JSON.stringify(r.body).includes('internal words'));
});

test('a pawaPay 5xx on initiation is not assumed failed: the status decides', async () => {
  state.depositAnswer = () => json({}, 500);
  state.depositStatus = { status: 'FOUND', data: { status: 'PROCESSING' } };
  const g = await setup(PAWAPAY);
  const accepted = await g.call('POST', '/v1/collections', COLLECT);
  assert.equal(accepted.body.status, 'processing', 'it did reach pawaPay');

  state.depositStatus = { status: 'NOT_FOUND' };
  const g2 = await setup(PAWAPAY);
  const lost = await g2.call('POST', '/v1/collections', COLLECT);
  assert.equal(lost.body.status, 'failed', 'it never did, so nothing was charged');
});

test('when even the status check fails, the collection stays processing (never guessed) and the reconciler settles it later', async () => {
  const g = await setup(PAWAPAY);
  net.restore();
  net = stubFetch((c) => {
    const u = new URL(c.url);
    if (u.pathname === '/v2/deposits' || u.pathname.startsWith('/v2/deposits/')) throw new Error('network down');
    return stub(c);
  });
  const r = await g.call('POST', '/v1/collections', COLLECT);
  assert.equal(r.body.status, 'processing');
  assert.ok(g.events(r.body.id).some((e) => e.type === 'initiate_unknown'));

  net.restore();
  state.depositStatus = { status: 'FOUND', data: { status: 'COMPLETED' } };
  net = stubFetch((c) => stub(c));
  const out = await reconcile(g.env, getProviders(g.env), Date.now() + 120_000);
  assert.equal(out.changed, 1);
  assert.equal(g.row(r.body.id).status, 'completed');
});

test('a payment pawaPay has no record of is given a grace period, then fails cleanly', async () => {
  state.depositAnswer = () => json({}, 500);
  state.depositStatus = { status: 'FOUND', data: { status: 'PROCESSING' } };
  const g = await setup(PAWAPAY);
  const r = await g.call('POST', '/v1/collections', COLLECT);
  state.depositStatus = { status: 'NOT_FOUND' };
  const p = getProviders(g.env);
  const early = await refresh(g.env, (await getRow(g.env, r.body.id))!, p, { force: true, now: g.row(r.body.id).created_at + 30_000 });
  assert.equal(early.status, 'processing');
  const late = await refresh(g.env, early, p, { force: true, now: g.row(r.body.id).created_at + 130_000 });
  assert.equal(late.status, 'failed');
});

test('a completion that arrives AFTER we reported failure is honoured, flagged late, alerted, and the tenant is told', async () => {
  state.depositAnswer = () => json({}, 500);
  state.depositStatus = { status: 'NOT_FOUND' };
  const g = await setup(PAWAPAY, { webhookUrl: 'https://shop.test/hook' });
  const r = await g.call('POST', '/v1/collections', COLLECT);
  assert.equal(r.body.status, 'failed');

  state.depositStatus = { status: 'FOUND', data: { status: 'COMPLETED' } };
  const out = await reconcile(g.env, getProviders(g.env), Date.now() + 2 * 3_600_000);
  assert.equal(out.changed, 1);
  assert.equal(g.row(r.body.id).status, 'completed');
  assert.deepEqual(g.events(r.body.id).map((e) => e.type), ['created', 'failed', 'late_completion']);
  const hooks = g.sqlite.prepare(`SELECT payload FROM webhook_deliveries ORDER BY rowid`).all() as { payload: string }[];
  const last = JSON.parse(hooks[hooks.length - 1]!.payload);
  assert.equal(last.type, 'payment.completed');
  assert.equal(last.late, true);
  assert.equal(last.previousStatus, 'failed');
  assert.ok(net.alerts().some((a) => a.level === 'critical' && /COMPLETED/.test(a.title)));
});

test('a disbursement: accepted, then settled by pawaPay\'s signed callback found by its provider id', async () => {
  const { kp, pem } = await signer();
  state.pem = pem;
  const g = await setup(PAWAPAY);
  const r = await g.call('POST', '/v1/disbursements', PAYOUT);
  assert.equal(r.body.status, 'processing');
  const [p] = sent('/v2/payouts');
  assert.equal(p.payoutId, await providerIdFor(g.tenant, 'disbursement', PAYOUT.reference));
  assert.equal(p.clientReferenceId, r.body.id);

  const { ctx } = fakeCtx();
  const body = JSON.stringify({ payoutId: p.payoutId, status: 'COMPLETED' });
  const res = await handle(await signedCallbackRequest(body, kp, '/callbacks/pawapay/payouts'), g.env, ctx);
  assert.equal(res.status, 200);
  assert.equal(g.row(r.body.id).status, 'completed');
  // delivered twice (pawaPay retries): harmless
  assert.equal((await handle(await signedCallbackRequest(body, kp, '/callbacks/pawapay/payouts'), g.env, ctx)).status, 200);
  assert.equal(g.row(r.body.id).version, 1);
});

test('a callback is found by provider id even without our reference, and a FAILED one fails the payout with a safe message', async () => {
  const { kp, pem } = await signer();
  state.pem = pem;
  const g = await setup(PAWAPAY);
  const r = await g.call('POST', '/v1/disbursements', PAYOUT);
  const body = JSON.stringify({ payoutId: (await providerIdFor(g.tenant, 'disbursement', PAYOUT.reference)), status: 'FAILED', failureReason: { failureCode: 'PAWAPAY_WALLET_OUT_OF_FUNDS' } });
  const res = await handle(await signedCallbackRequest(body, kp, '/callbacks/pawapay/payouts'), g.env, fakeCtx().ctx);
  assert.equal(res.status, 200);
  const got = await g.call('GET', `/v1/disbursements/${r.body.id}`);
  assert.equal(got.body.status, 'failed');
  assert.equal(got.body.failure, 'Payouts are temporarily unavailable', 'our own empty wallet is not the customer\'s business');
});

test('a forged, stale or wrongly addressed callback settles nothing', async () => {
  const { kp, pem } = await signer();
  const other = await signer();
  state.pem = pem;
  const g = await setup(PAWAPAY);
  const r = await g.call('POST', '/v1/disbursements', PAYOUT);
  const id = await providerIdFor(g.tenant, 'disbursement', PAYOUT.reference);
  const body = JSON.stringify({ payoutId: id, status: 'COMPLETED' });
  const { ctx } = fakeCtx();
  assert.equal((await handle(await signedCallbackRequest(body, other.kp, '/callbacks/pawapay/payouts'), g.env, ctx)).status, 401, 'signed by someone else');
  assert.equal((await handle(await signedCallbackRequest(body, kp, '/callbacks/pawapay/payouts', { created: Math.floor(Date.now() / 1000) - 3600 }), g.env, ctx)).status, 401, 'stale');
  const forGw = await signedCallbackRequest(body, kp, '/callbacks/pawapay/payouts'); // a genuine one, captured, replayed to another host
  assert.equal((await handle(new Request('https://evil.test/callbacks/pawapay/payouts', { method: 'POST', headers: forGw.headers, body }), g.env, ctx)).status, 401, 'signature covers the host');
  const tampered = await signedCallbackRequest(body, kp, '/callbacks/pawapay/payouts');
  assert.equal((await handle(new Request(tampered.url, { method: 'POST', headers: tampered.headers, body: body.replace('COMPLETED', 'FAILED') }), g.env, ctx)).status, 401, 'body changed after signing');
  assert.equal(g.row(r.body.id).status, 'processing');
  // a deposit callback sent to the payouts endpoint is not for it
  const dep = JSON.stringify({ depositId: id, status: 'COMPLETED' });
  assert.equal((await handle(await signedCallbackRequest(dep, kp, '/callbacks/pawapay/payouts'), g.env, ctx)).status, 200);
  assert.equal(g.row(r.body.id).status, 'processing');
});

test('an UNSIGNED callback: confirmed with a status call outside LIVE, refused outright with LIVE', async () => {
  const g = await setup(PAWAPAY);
  const r = await g.call('POST', '/v1/disbursements', PAYOUT);
  const id = await providerIdFor(g.tenant, 'disbursement', PAYOUT.reference);
  const body = JSON.stringify({ payoutId: id, status: 'COMPLETED' });
  const post = () => handle(new Request('https://gw.test/callbacks/pawapay/payouts', { method: 'POST', body }), g.env, fakeCtx().ctx);

  state.payoutStatus = { status: 'FOUND', data: { status: 'PROCESSING' } };
  assert.equal((await post()).status, 200);
  assert.equal(g.row(r.body.id).status, 'processing', 'its claim was not believed');
  state.payoutStatus = { status: 'FOUND', data: { status: 'COMPLETED' } };
  assert.equal((await post()).status, 200);
  assert.equal(g.row(r.body.id).status, 'completed');

  const live = await setup({ ...PAWAPAY, LIVE: 'true', PAWAPAY_BASE_URL: 'https://api.pawapay.io' });
  const before = net.calls.length;
  const res = await handle(new Request('https://gw.test/callbacks/pawapay/payouts', { method: 'POST', body }), live.env, fakeCtx().ctx);
  assert.equal(res.status, 401);
  assert.equal(net.calls.length, before, 'no status call was made for an anonymous caller');
});

test('a callback for a payment the gateway does not know is answered 200 (so pawaPay stops) and raises a warning', async () => {
  const { kp, pem } = await signer();
  state.pem = pem;
  const g = await setup(PAWAPAY);
  const body = JSON.stringify({ depositId: '11111111-1111-4111-8111-111111111111', clientReferenceId: 'ghost-1', status: 'COMPLETED' });
  const res = await handle(await signedCallbackRequest(body, kp, '/callbacks/pawapay/deposits'), g.env, fakeCtx().ctx);
  assert.equal(res.status, 200);
  assert.ok(net.alerts().some((a) => a.level === 'warning' && /does not know/.test(a.title)));
  assert.equal((g.sqlite.prepare(`SELECT COUNT(*) AS n FROM provider_events`).get() as { n: number }).n, 1, 'and it is kept for a person to read');
});

test('a tenant migrated from Relay: its in-flight payments keep their ids, so a callback for them still lands', async () => {
  const { kp, pem } = await signer();
  state.pem = pem;
  const g = await setup(PAWAPAY, { id: 'relay', idNamespace: 'relay' });
  const r = await g.call('POST', '/v1/collections', { ...COLLECT, reference: 'bu1abc234' });
  const [dep] = sent('/v2/deposits');
  // exactly the id Relay's own code would have used for this buy order
  assert.equal(dep.depositId, await providerIdFor({ id: 'relay', id_namespace: 'relay' }, 'collection', 'bu1abc234'));
  const body = JSON.stringify({ depositId: dep.depositId, clientReferenceId: 'bu1abc234', status: 'COMPLETED' }); // a legacy callback echoes Relay's reference
  assert.equal((await handle(await signedCallbackRequest(body, kp, '/callbacks/pawapay/deposits'), g.env, fakeCtx().ctx)).status, 200);
  assert.equal(g.row(r.body.id).status, 'completed');
});

test('PREAUTH and REDIRECT providers need their extra inputs, and say what is missing', async () => {
  const g = await setup(PAWAPAY);
  net.restore();
  net = stubFetch((c) => {
    const u = new URL(c.url);
    if (u.pathname === '/v2/active-conf') return json({ countries: [{ country: 'CIV', providers: [
      { provider: 'ORANGE_CIV', currencies: [{ currency: 'XOF', operationTypes: { DEPOSIT: { status: 'OPERATIONAL', minAmount: '100', maxAmount: '1000000', authType: 'PREAUTH', authTokenInstructions: { instructions: { en: [{ text: 'Dial #144*82#' }], fr: [{ text: 'Composez #144*82#' }] } } } } }] },
      { provider: 'WAVE_CIV', currencies: [{ currency: 'XOF', operationTypes: { DEPOSIT: { status: 'OPERATIONAL', minAmount: '100', maxAmount: '1000000', authType: 'REDIRECT_AUTH' } } }] },
    ] }] });
    return stub(c);
  });
  const pre = await g.call('POST', '/v1/collections', COLLECT);
  assert.equal(pre.status, 422);
  assert.equal(pre.body.error.code, 'pre_auth_code_required');
  assert.deepEqual(pre.body.error.codeInstructions.en, ['Dial #144*82#']);
  const ok = await g.call('POST', '/v1/collections', { ...COLLECT, preAuthCode: '123456' });
  assert.equal(ok.status, 201);
  assert.equal(sent('/v2/deposits')[0].preAuthorisationCode, '123456');

  const wave = await g.call('POST', '/v1/collections', { ...COLLECT, reference: 'order-0002', operator: 'wave' });
  assert.equal(wave.body.error.code, 'redirect_urls_required');
  state.depositAnswer = () => json({ status: 'ACCEPTED', authorizationUrl: 'https://pay.wave.com/c/abc' });
  const w = await g.call('POST', '/v1/collections', { ...COLLECT, reference: 'order-0003', operator: 'wave', successUrl: 'https://shop.test/ok', failedUrl: 'https://shop.test/no' });
  assert.equal(w.body.authUrl, 'https://pay.wave.com/c/abc');
  state.depositAnswer = () => json({ status: 'ACCEPTED', authorizationUrl: 'javascript:alert(1)' });
  const bad = await g.call('POST', '/v1/collections', { ...COLLECT, reference: 'order-0004', operator: 'wave', successUrl: 'https://shop.test/ok', failedUrl: 'https://shop.test/no' });
  assert.equal(bad.body.authUrl, null, 'a non-https redirect from a third party is dropped');
});

test('a disbursement whose request times out is checked with pawaPay; if that fails too the outcome is unknown and is not retried', async () => {
  const g = await setup(PAWAPAY);
  net.restore();
  net = stubFetch((c) => {
    const u = new URL(c.url);
    if (u.pathname === '/v2/payouts' || u.pathname.startsWith('/v2/payouts/')) throw new Error('timeout');
    return stub(c);
  });
  const r = await g.call('POST', '/v1/disbursements', PAYOUT);
  assert.equal(r.body.status, 'unknown');
  assert.equal(net.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/v2/payouts')).length, 1);
  await reconcile(g.env, getProviders(g.env), Date.now() + 600_000);
  assert.equal(net.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/v2/payouts')).length, 1, 'never sent a second time');
});

test('the float: balances against the floor, with what is committed and the cover in days', async () => {
  state.balances = { balances: [{ country: 'CIV', currency: 'XOF', balance: '1500000' }, { country: 'SEN', currency: 'XOF', balance: '9000000' }] };
  const g = await setup(PAWAPAY);
  await g.call('POST', '/v1/disbursements', PAYOUT); // accepted, in flight: 5000 committed in CIV
  const f = await g.call('GET', '/v1/float');
  const civ = f.body.rows.find((r: any) => r.country === 'CIV');
  assert.equal(civ.status, 'low');
  assert.equal(civ.committed, 5000);
  assert.equal(f.body.rows.find((r: any) => r.country === 'SEN').status, 'ok');
  assert.equal(f.body.rows.find((r: any) => r.country === 'BFA').status, 'critical', 'no wallet at all');
});
