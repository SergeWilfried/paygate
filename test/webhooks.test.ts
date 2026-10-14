import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { silence } from './helpers/env.ts';
import { COLLECT, PAYOUT, setup, stubFetch } from './helpers/gateway.ts';
import { verifySignature } from '../src/signing.ts';
import { BACKOFF_MS, deliverDue, MAX_ATTEMPTS } from '../src/webhooks.ts';
import { applyObserved, getRow } from '../src/payments.ts';

let restore: () => void;
let net: ReturnType<typeof stubFetch>;
const HOOK = 'https://shop.test/paygate';
let status = 200;
beforeEach(() => { restore = silence(); status = 200; net = stubFetch((c) => (c.url === HOOK ? new Response('ok', { status }) : undefined)); });
afterEach(() => { net.restore(); restore(); });

const posts = () => net.calls.filter((c) => c.url === HOOK);

test('a payment change is delivered to the tenant, signed, with a stable event id', async () => {
  const g = await setup({}, { webhookUrl: HOOK });
  const c = await g.call('POST', '/v1/collections', COLLECT);
  assert.equal(posts().length, 0, 'nothing has changed yet');
  await g.call('GET', `/v1/collections/${c.body.id}`); // the sandbox completes it
  await g.settle();
  await deliverDue(g.env);
  const sent = posts();
  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0]!.body!);
  assert.equal(body.type, 'payment.completed');
  assert.equal(body.id, `evt_${c.body.id}_1`);
  assert.equal(body.data.id, c.body.id);
  assert.equal(body.data.status, 'completed');
  assert.equal(body.previousStatus, 'processing');
  assert.equal(body.late, false);
  assert.equal(sent[0]!.headers['paygate-event-id'], body.id);
  assert.equal(sent[0]!.headers['paygate-event-type'], 'payment.completed');
  // the tenant can verify it with the secret the operator hands over
  const secret = (await g.admin('GET', '/admin/tenants/shop/webhook-secret')).body.secret;
  assert.equal(await verifySignature(secret, sent[0]!.body!, sent[0]!.headers['paygate-signature']!), true);
  assert.equal(await verifySignature('whsec_wrong', sent[0]!.body!, sent[0]!.headers['paygate-signature']!), false);
  assert.ok(!sent[0]!.body!.includes('failureDetail') && !sent[0]!.body!.includes('providerId'), 'no internals in the payload');
});

test('a delivered event is not sent again', async () => {
  const g = await setup({}, { webhookUrl: HOOK });
  await g.call('POST', '/v1/disbursements', PAYOUT); // completes at once
  await deliverDue(g.env);
  await deliverDue(g.env, Date.now() + 3_600_000);
  assert.equal(posts().length, 1);
  assert.equal((g.sqlite.prepare(`SELECT status FROM webhook_deliveries`).get() as { status: string }).status, 'delivered');
});

test('a failing endpoint is retried with a growing delay, then the event is declared dead with a critical alert, and an operator can requeue it', async () => {
  const g = await setup({}, { webhookUrl: HOOK });
  status = 500;
  await g.call('POST', '/v1/disbursements', PAYOUT);
  let t = Date.now();
  await deliverDue(g.env, t);
  assert.equal(posts().length, 1);
  const next = () => (g.sqlite.prepare(`SELECT next_attempt_at, attempts, status FROM webhook_deliveries`).get() as { next_attempt_at: number; attempts: number; status: string });
  assert.equal(next().attempts, 1);
  assert.ok(Math.abs(next().next_attempt_at - (t + BACKOFF_MS[0]!)) < 50);

  await deliverDue(g.env, t + 5_000); // too early
  assert.equal(posts().length, 1);

  for (let i = 1; i < MAX_ATTEMPTS; i++) { t = next().next_attempt_at; await deliverDue(g.env, t); }
  assert.equal(next().status, 'dead');
  assert.equal(posts().length, MAX_ATTEMPTS);
  assert.ok(net.alerts().some((a) => a.level === 'critical' && /webhook/i.test(a.title)));
  const dead = await g.admin('GET', '/admin/webhooks/dead');
  assert.equal(dead.body.data.length, 1);

  status = 200;
  assert.equal((await g.admin('POST', `/admin/webhooks/${dead.body.data[0].id}/retry`)).status, 200);
  await deliverDue(g.env);
  assert.equal(next().status, 'delivered');
});

test('a tenant without a webhook URL gets no outbox rows (it reads the status instead)', async () => {
  const g = await setup();
  await g.call('POST', '/v1/disbursements', PAYOUT);
  assert.equal((g.sqlite.prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries`).get() as { n: number }).n, 0);
});

test('events go only to the tenant whose payment changed', async () => {
  const g = await setup({}, { webhookUrl: HOOK });
  await g.addTenant('quiet', { webhookUrl: 'https://quiet.test/hook' });
  await g.call('POST', '/v1/disbursements', PAYOUT);
  const rows = g.sqlite.prepare(`SELECT tenant_id FROM webhook_deliveries`).all() as { tenant_id: string }[];
  assert.deepEqual(rows.map((r) => r.tenant_id), ['shop']);
});

test('two callers racing to settle the same payment produce ONE change, one event, one webhook', async () => {
  const g = await setup({}, { webhookUrl: HOOK });
  const c = await g.call('POST', '/v1/collections', { ...COLLECT, phone: '+2250700009999' });
  const row = (await getRow(g.env, c.body.id))!;
  const results = await Promise.all([
    applyObserved(g.env, row, { state: 'completed' }, 'callback'),
    applyObserved(g.env, row, { state: 'completed' }, 'reconcile'),
    applyObserved(g.env, row, { state: 'failed', error: 'x' }, 'reconcile'),
  ]);
  assert.equal(results.filter((r) => r.applied).length, 1);
  assert.equal((g.sqlite.prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries`).get() as { n: number }).n, 1);
  assert.equal(g.events(c.body.id).filter((e) => e.version !== null).length, 1);
  assert.equal(g.row(c.body.id).version, 1);
});

test('the ping endpoint lets a tenant test its webhook and its signature check', async () => {
  const g = await setup({}, { webhookUrl: HOOK });
  const r = await g.call('POST', '/v1/webhooks/test');
  assert.equal(r.status, 200);
  await g.settle();
  const p = posts();
  assert.equal(p.length, 1);
  assert.equal(JSON.parse(p[0]!.body!).type, 'ping');
  const noHook = await setup();
  assert.equal((await noHook.call('POST', '/v1/webhooks/test')).status, 422);
});

test('a webhook URL must be https (localhost is allowed only outside LIVE)', async () => {
  const g = await setup();
  assert.equal((await g.admin('POST', '/admin/tenants', { id: 'bad', name: 'Bad', webhookUrl: 'http://evil.test/x' })).status, 400);
  assert.equal((await g.admin('POST', '/admin/tenants', { id: 'loc', name: 'Local', webhookUrl: 'http://localhost:8787/hook' })).status, 201);
  const live = await setup({ LIVE: 'true', PROVIDER_MODE: 'pawapay', PAWAPAY_BASE_URL: 'https://api.pawapay.io' });
  assert.equal((await live.admin('POST', '/admin/tenants', { id: 'loc', name: 'Local', webhookUrl: 'http://localhost:8787/hook' })).status, 400);
});

test('rotating the secret changes what future deliveries are signed with', async () => {
  const g = await setup({}, { webhookUrl: HOOK });
  const before = (await g.admin('GET', '/admin/tenants/shop/webhook-secret')).body;
  const after = (await g.admin('POST', '/admin/tenants/shop/webhook-secret')).body;
  assert.notEqual(before.secret, after.secret);
  assert.equal(after.version, before.version + 1);
  await g.call('POST', '/v1/disbursements', PAYOUT);
  await deliverDue(g.env);
  const sent = posts()[0]!;
  assert.equal(await verifySignature(after.secret, sent.body!, sent.headers['paygate-signature']!), true);
  assert.equal(await verifySignature(before.secret, sent.body!, sent.headers['paygate-signature']!), false);
});
