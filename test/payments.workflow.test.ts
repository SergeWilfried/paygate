import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { silence } from './helpers/env.ts';
import { COLLECT, PAYOUT, setup, stubFetch } from './helpers/gateway.ts';
import { reconcile } from '../src/reconcile.ts';
import { getProviders } from '../src/providers/index.ts';

let restore: () => void;
let net: ReturnType<typeof stubFetch>;
beforeEach(() => { restore = silence(); net = stubFetch(); });
afterEach(() => { net.restore(); restore(); });

// Sandbox behaviour follows the last digits of the phone number: ...0001 completes, ...0002 fails, ...0000 refused, ...9999 stays pending, ...5555 network error.
const num = (suffix: string) => `+22507000${suffix}`;

test('a collection is created processing, then completes when the provider says so', async () => {
  const g = await setup();
  const c = await g.call('POST', '/v1/collections', COLLECT);
  assert.equal(c.status, 201);
  assert.equal(c.body.status, 'processing');
  assert.equal(c.body.object, 'collection');
  assert.equal(c.body.amount, 5000);
  assert.match(c.body.id, /^pg[0-9a-f]{18}$/);
  assert.deepEqual(c.body.method.instructions.en, ['Approve the payment on your phone (sandbox)']);

  const got = await g.call('GET', `/v1/collections/${c.body.id}`);
  assert.equal(got.body.status, 'completed');
  assert.ok(got.body.settledAt);
  assert.equal(got.body.method, null, 'no instructions once it is over');
  assert.deepEqual(g.events(c.body.id).map((e) => e.type), ['created', 'accepted', 'completed']);
});

test('the same reference and details return the same payment (a retry), different details are a conflict', async () => {
  const g = await setup();
  const a = await g.call('POST', '/v1/collections', COLLECT);
  const b = await g.call('POST', '/v1/collections', COLLECT);
  assert.equal(b.status, 200);
  assert.equal(b.body.id, a.body.id);
  assert.equal((g.sqlite.prepare('SELECT COUNT(*) AS n FROM payments').get() as { n: number }).n, 1);
  const c = await g.call('POST', '/v1/collections', { ...COLLECT, amount: 9000 });
  assert.equal(c.status, 409);
  assert.equal(c.body.error.code, 'idempotency_conflict');
  const d = await g.call('POST', '/v1/collections', { ...COLLECT, phone: num('0003') });
  assert.equal(d.status, 409, 'a different payer under the same reference');
});

test('looking a payment up by your own reference works, and a missing one is 404', async () => {
  const g = await setup();
  const a = await g.call('POST', '/v1/collections', COLLECT);
  const r = await g.call('GET', `/v1/collections?reference=${COLLECT.reference}`);
  assert.equal(r.body.id, a.body.id);
  assert.equal((await g.call('GET', '/v1/collections?reference=nope-nope')).status, 404);
  const list = await g.call('GET', '/v1/collections');
  assert.equal(list.body.data.length, 1);
});

test('tenants are isolated: one cannot read, list or look up another, and the same reference is free in each', async () => {
  const g = await setup();
  const other = await g.addTenant('other');
  const mine = await g.call('POST', '/v1/collections', COLLECT);
  assert.equal((await other('GET', `/v1/collections/${mine.body.id}`)).status, 404);
  assert.equal((await other('GET', `/v1/collections?reference=${COLLECT.reference}`)).status, 404);
  assert.equal((await other('GET', '/v1/collections')).body.data.length, 0);
  const theirs = await other('POST', '/v1/collections', COLLECT);
  assert.equal(theirs.status, 201, 'the same reference in another product is a different payment');
  assert.notEqual(theirs.body.id, mine.body.id);
  const ids = g.sqlite.prepare('SELECT provider_id FROM payments').all() as { provider_id: string }[];
  assert.equal(new Set(ids.map((r) => r.provider_id)).size, 2, 'and never the same id at the provider');
  assert.equal((await other('GET', `/v1/disbursements/${mine.body.id}`)).status, 404, 'a collection is not reachable as a disbursement');
});

test('requests without a valid key are refused, and so are revoked keys and suspended tenants', async () => {
  const g = await setup();
  assert.equal((await g.call('GET', '/v1/collections', undefined, null)).status, 401);
  assert.equal((await g.call('GET', '/v1/collections', undefined, 'pgk_000000000000_' + '0'.repeat(64))).status, 401);
  assert.equal((await g.call('GET', '/v1/collections', undefined, g.env.ADMIN_API_KEY as string)).status, 401, 'the admin key is not a tenant key');
  assert.equal((await g.call('GET', '/v1/collections')).status, 200);
  const keyId = (g.sqlite.prepare('SELECT id FROM api_keys').get() as { id: string }).id;
  assert.equal((await g.admin('DELETE', `/admin/tenants/shop/keys/${keyId}`)).status, 200);
  assert.equal((await g.call('GET', '/v1/collections')).status, 401);
  const k = await g.admin('POST', '/admin/tenants/shop/keys', { label: 'new' });
  assert.equal(k.status, 201);
  assert.equal((await g.call('GET', '/v1/collections', undefined, k.body.key)).status, 200);
  await g.admin('PATCH', '/admin/tenants/shop', { status: 'suspended' });
  assert.equal((await g.call('GET', '/v1/collections', undefined, k.body.key)).status, 401);
});

test('the admin API is closed to everyone without the admin key', async () => {
  const g = await setup();
  assert.equal((await g.call('GET', '/admin/tenants', undefined, null)).status, 401);
  assert.equal((await g.call('GET', '/admin/tenants')).status, 401, 'a tenant key is not an admin key');
  assert.equal((await g.admin('GET', '/admin/tenants')).status, 200);
});

test('invalid requests are refused with a reason and nothing is recorded', async () => {
  const g = await setup({}, { maxAmount: 100_000 });
  const bad = async (over: Record<string, unknown>, code: string, status = 400) => {
    const r = await g.call('POST', '/v1/collections', { ...COLLECT, ...over });
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.equal(r.body.error.code, code);
  };
  await bad({ reference: 'x' }, 'invalid_reference');
  await bad({ amount: 50 }, 'invalid_amount');
  await bad({ amount: 100.5 }, 'invalid_amount');
  await bad({ amount: 200_000 }, 'amount_too_large', 422);
  await bad({ currency: 'EUR' }, 'invalid_currency');
  await bad({ operator: 'mtn' }, 'invalid_operator');
  await bad({ phone: '0700000001' }, 'invalid_phone');
  await bad({ phone: '+33612345678' }, 'invalid_phone');
  await bad({ rail: 'card' }, 'invalid_rail');
  await bad({ metadata: [1] }, 'invalid_metadata');
  await bad({ successUrl: 'javascript:alert(1)' }, 'invalid_url');
  await bad({ expiresInSeconds: 5 }, 'invalid_expiry');
  assert.equal((await g.call('POST', '/v1/collections', undefined)).status, 400);
  assert.equal((await g.call('POST', '/v1/disbursements', { ...PAYOUT, rail: 'pispi_qr' })).body.error.code, 'invalid_rail');
  assert.equal((g.sqlite.prepare('SELECT COUNT(*) AS n FROM payments').get() as { n: number }).n, 0);
});

test('metadata comes back as given', async () => {
  const g = await setup();
  const r = await g.call('POST', '/v1/collections', { ...COLLECT, metadata: { orderId: 'A1', note: 'x' } });
  assert.deepEqual(r.body.metadata, { orderId: 'A1', note: 'x' });
});

test('a collection the provider refuses fails at once with a customer-safe message and no internal detail', async () => {
  const g = await setup();
  const r = await g.call('POST', '/v1/collections', { ...COLLECT, phone: num('0000') });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'failed');
  assert.match(r.body.failure, /not registered/);
  assert.equal('failureDetail' in r.body, false);
  assert.ok(g.row(r.body.id).failure_detail, 'the detail is kept for the operator');
  const admin = await g.admin('GET', `/admin/payments/${r.body.id}`);
  assert.ok(admin.body.failureDetail);
});

test('a collection that fails at the provider is reported failed; the failure is final', async () => {
  const g = await setup();
  const r = await g.call('POST', '/v1/collections', { ...COLLECT, phone: num('0002') });
  assert.equal(r.body.status, 'processing');
  const got = await g.call('GET', `/v1/collections/${r.body.id}`);
  assert.equal(got.body.status, 'failed');
  assert.match(got.body.failure, /not approved/);
});

test('a collection nobody pays stays processing until its window ends, then expires', async () => {
  const g = await setup();
  const r = await g.call('POST', '/v1/collections', { ...COLLECT, phone: num('9999'), expiresInSeconds: 60 });
  assert.equal(r.body.status, 'processing');
  const row = g.row(r.body.id);
  const { refresh, getRow } = await import('../src/payments.ts');
  const p = getProviders(g.env);
  const still = await refresh(g.env, (await getRow(g.env, r.body.id))!, p, { force: true, now: row.created_at + 30_000 });
  assert.equal(still.status, 'processing');
  const gone = await refresh(g.env, still, p, { force: true, now: row.created_at + 61_000 });
  assert.equal(gone.status, 'expired');
});

test('a disbursement is sent once and completes; a refusal is a clean failure', async () => {
  const g = await setup();
  const ok = await g.call('POST', '/v1/disbursements', PAYOUT);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.status, 'completed');
  const refused = await g.call('POST', '/v1/disbursements', { ...PAYOUT, reference: 'payout-0002', phone: num('0000') });
  assert.equal(refused.body.status, 'failed');
  assert.match(refused.body.failure, /not registered/);
  assert.deepEqual(g.events(ok.body.id).map((e) => e.type), ['created', 'completed']);
});

test('an accepted disbursement stays processing and is settled by the reconciler', async () => {
  const g = await setup();
  const r = await g.call('POST', '/v1/disbursements', { ...PAYOUT, phone: num('9999') });
  assert.equal(r.body.status, 'processing');
  const out = await reconcile(g.env, getProviders(g.env), Date.now() + 120_000);
  assert.equal(out.checked, 1);
  assert.equal(out.changed, 0, 'the sandbox keeps ...9999 pending');
});

test('a disbursement whose outcome is unknown is NOT retried, raises a critical alert, and a person resolves it', async () => {
  const g = await setup();
  const r = await g.call('POST', '/v1/disbursements', { ...PAYOUT, phone: num('5555') });
  assert.equal(r.body.status, 'unknown');
  assert.equal(net.alerts().filter((a) => a.level === 'critical').length, 1);
  assert.match(net.alerts()[0]!.title, /unknown/i);
  assert.equal(g.row(r.body.id).attempts, 1, 'the provider was called exactly once');

  // the reconciler does not send it again
  await reconcile(g.env, getProviders(g.env), Date.now() + 600_000);
  assert.equal(g.row(r.body.id).attempts, 1);

  const resolved = await g.admin('POST', `/admin/payments/${r.body.id}/resolve`, { outcome: 'completed', note: 'seen in the pawaPay dashboard' });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.status, 'completed');
  assert.ok(g.events(r.body.id).some((e) => e.actor === 'admin:operator' && e.type === 'completed'));
  assert.equal((await g.admin('POST', `/admin/payments/${r.body.id}/resolve`, { outcome: 'failed', note: 'oops' })).status, 409, 'a completed payment cannot be flipped to failed');
  assert.equal((await g.admin('POST', `/admin/payments/${r.body.id}/resolve`, { outcome: 'bogus', note: 'x' })).status, 400);
});

test('a disbursement recorded but never sent (the Worker stopped in between) is sent by the reconciler, once', async () => {
  const g = await setup();
  const r = await g.call('POST', '/v1/disbursements', { ...PAYOUT, phone: num('9999') });
  g.sqlite.prepare(`UPDATE payments SET attempts = 0 WHERE id = ?`).run(r.body.id); // as if the send never happened
  await reconcile(g.env, getProviders(g.env), Date.now() + 120_000);
  assert.equal(g.row(r.body.id).attempts, 1);
  await reconcile(g.env, getProviders(g.env), Date.now() + 240_000);
  assert.equal(g.row(r.body.id).attempts, 1, 'not sent again');
});

test('the methods endpoint says whether a way of paying is available, with its limits', async () => {
  const g = await setup();
  const ok = await g.call('GET', '/v1/methods?operator=orange&phone=%2B2250700000001');
  assert.equal(ok.body.available, true);
  assert.equal(ok.body.authType, 'PROVIDER_AUTH');
  const no = await g.call('GET', '/v1/methods?operator=moov&phone=%2B33612345678');
  assert.equal(no.body.available, false);
  assert.equal((await g.call('GET', '/v1/methods?rail=pispi_qr')).body.available, false, 'PI-SPI is off by default');
  assert.equal((await g.call('GET', '/v1/methods?rail=card')).status, 400);
});

test('the sandbox is refused outright when LIVE is true', async () => {
  const g = await setup({ LIVE: 'true' });
  const r = await g.call('POST', '/v1/collections', COLLECT);
  assert.equal(r.status, 500, 'fails closed rather than pretending to take real money');
});
