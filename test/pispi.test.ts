import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { silence } from './helpers/env.ts';
import { setup, stubFetch, type Call } from './helpers/gateway.ts';
import { judge, pispiQr, type ReceivedPayment } from '../src/providers/pispi.ts';
import { clearPispiTokens } from '../src/providers/pispi.ts';
import { getProviders } from '../src/providers/index.ts';
import { reconcile } from '../src/reconcile.ts';

const ALIAS = '9b1b3499-3e50-435b-b757-ac7a83d8aa96';
const PAYER = '1c9e6f3a-5b7d-4e21-8a0c-2f4d6b8a1c3e';
const PISPI = {
  PISPI_ENABLED: 'true', PISPI_POLL: 'true', PISPI_RTP: 'true', PI_SPI_ACCOUNT_ALIAS: ALIAS, PI_SPI_PARTICIPANT: 'BFC999',
  PI_SPI_BUSINESS_API_URL: 'https://pispi.test', PI_SP_API_OAUTH_URL: 'https://auth.pispi.test/token', PI_SP_API_CLIENT_ID: 'id', PI_SP_API_CLIENT_SECRET: 'secret', PI_SPI_API_KEY: 'key',
};

let restore: () => void;
let net: ReturnType<typeof stubFetch>;
let received: ReceivedPayment[];
let rtpAnswer: () => Response;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
beforeEach(() => {
  restore = silence(); received = []; clearPispiTokens();
  rtpAnswer = () => json({ statut: 'ENVOYE', end2endId: 'E2E-RTP' });
  net = stubFetch((c: Call) => {
    const u = new URL(c.url);
    if (u.host === 'auth.pispi.test') return json({ access_token: 'tok' });
    if (u.host === 'pispi.test' && u.pathname.endsWith('/paiements-recus')) return json({ data: received.filter((p) => p.txId === u.searchParams.get('txId')) });
    if (u.host === 'pispi.test' && u.pathname.endsWith('/demandes-paiements')) return rtpAnswer();
    return undefined;
  });
});
afterEach(() => { net.restore(); restore(); });

const pay = (over: Partial<ReceivedPayment>): ReceivedPayment => ({ txId: 'PGX', payeAlias: ALIAS, montant: 5000, categorie: '400', statut: 'IRREVOCABLE', end2endId: 'E2E-1', ...over });

test('judge: paid only when irrevocable, on our alias, the right category and exactly the amount', () => {
  const p = { id: 'pgx', amount: 5000, rtp: false, payerAlias: '' };
  assert.deepEqual(judge(ALIAS, p, []), { kind: 'none' });
  assert.deepEqual(judge(ALIAS, p, [pay({ statut: 'ENVOYE' })]), { kind: 'pending' });
  assert.deepEqual(judge(ALIAS, p, [pay({ statut: 'REJETE' })]), { kind: 'none' });
  assert.deepEqual(judge(ALIAS, p, [pay({})]), { kind: 'paid', end2endId: 'E2E-1' });
  assert.equal(judge(ALIAS, p, [pay({ montant: 4000 })]).kind, 'mismatch', 'underpaid is for a person, never a settlement');
  assert.equal(judge(ALIAS, p, [pay({ categorie: '500' })]).kind, 'mismatch', 'a payment request cannot settle a QR payment');
  assert.deepEqual(judge(ALIAS, p, [pay({ payeAlias: 'someone-else' })]), { kind: 'none' }, 'not our alias');
  assert.deepEqual(judge(ALIAS, p, [pay({ txId: 'OTHER' })]), { kind: 'none' });
});

test('judge: a payment request must come from the payer it was sent to', () => {
  const p = { id: 'pgx', amount: 5000, rtp: true, payerAlias: PAYER };
  assert.equal(judge(ALIAS, p, [pay({ categorie: '500', payeurAlias: PAYER })]).kind, 'paid');
  assert.equal(judge(ALIAS, p, [pay({ categorie: '500', payeurAlias: 'a-stranger' })]).kind, 'none');
  assert.equal(judge(ALIAS, p, [pay({ categorie: '400', payeurAlias: PAYER })]).kind, 'mismatch');
});

test('PI-SPI is off unless enabled with our alias', async () => {
  const g = await setup();
  const r = await g.call('POST', '/v1/collections', { reference: 'q-1', amount: 5000, rail: 'pispi_qr' });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'provider_unavailable');
  assert.equal(pispiQr({ PI_SPI_ACCOUNT_ALIAS: 'not-a-uuid' } as never, { id: 'a', amount: 1 }), null);
});

test('a QR collection returns the QR fields, is settled by PI-SPI\'s own record, and one received payment settles one payment only', async () => {
  const g = await setup(PISPI);
  const a = await g.call('POST', '/v1/collections', { reference: 'q-1', amount: 5000, rail: 'pispi_qr' });
  assert.equal(a.status, 201);
  assert.equal(a.body.status, 'processing');
  assert.deepEqual(a.body.qr, { alias: ALIAS, countryCode: 'BF', qrType: 'DYNAMIC', referenceLabel: a.body.id.toUpperCase(), amount: 5000 });
  assert.ok(a.body.qr.referenceLabel.length <= 25);

  assert.equal((await g.call('GET', `/v1/collections/${a.body.id}`)).body.status, 'processing', 'nothing arrived yet');
  received.push(pay({ txId: a.body.id.toUpperCase(), end2endId: 'E2E-A' }));
  g.sqlite.prepare('UPDATE payments SET last_checked_at = NULL').run();
  const done = await g.call('GET', `/v1/collections/${a.body.id}`);
  assert.equal(done.body.status, 'completed');
  assert.equal(done.body.qr, null);
  assert.equal(g.row(a.body.id).provider_ref, 'E2E-A');

  // the same bank payment cannot settle a second order
  const b = await g.call('POST', '/v1/collections', { reference: 'q-2', amount: 5000, rail: 'pispi_qr' });
  received.push(pay({ txId: b.body.id.toUpperCase(), end2endId: 'E2E-A' }));
  assert.equal((await g.call('GET', `/v1/collections/${b.body.id}`)).body.status, 'processing');
});

test('a payment for the wrong amount settles nothing, raises one critical alert (not one per check), and tells the tenant', async () => {
  const g = await setup(PISPI, { webhookUrl: 'https://shop.test/hook' });
  const a = await g.call('POST', '/v1/collections', { reference: 'q-1', amount: 5000, rail: 'pispi_qr' });
  received.push(pay({ txId: a.body.id.toUpperCase(), montant: 4000, end2endId: 'E2E-X' }));
  for (let i = 0; i < 3; i++) { g.sqlite.prepare('UPDATE payments SET last_checked_at = NULL').run(); await g.call('GET', `/v1/collections/${a.body.id}`); }
  assert.equal(g.row(a.body.id).status, 'processing');
  assert.equal(net.alerts().filter((x) => /does not match/.test(x.title)).length, 1);
  const hooks = g.sqlite.prepare(`SELECT type FROM webhook_deliveries`).all() as { type: string }[];
  assert.deepEqual(hooks.map((h) => h.type), ['payment.mismatch']);
});

test('an unpaid QR collection expires, and a payment that arrives afterwards is still honoured (flagged late)', async () => {
  const g = await setup(PISPI);
  const a = await g.call('POST', '/v1/collections', { reference: 'q-1', amount: 5000, rail: 'pispi_qr', expiresInSeconds: 60 });
  const created = g.row(a.body.id).created_at;
  const p = getProviders(g.env);
  await reconcile(g.env, p, created + 120_000);
  assert.equal(g.row(a.body.id).status, 'expired');
  received.push(pay({ txId: a.body.id.toUpperCase(), end2endId: 'E2E-LATE' }));
  await reconcile(g.env, p, created + 120_000 + 2 * 3_600_000);
  assert.equal(g.row(a.body.id).status, 'completed');
  assert.deepEqual(g.events(a.body.id).map((e) => e.type), ['created', 'expired', 'late_completion']);
});

test('a payment request is sent to the customer\'s alias, with our payment id as the txId, and is settled when the customer approves', async () => {
  const g = await setup(PISPI);
  const r = await g.call('POST', '/v1/collections', { reference: 'r-1', amount: 5000, rail: 'pispi_rtp', payerAlias: PAYER.toUpperCase() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'processing');
  const sent = net.calls.find((c) => c.url.endsWith('/demandes-paiements'))!;
  const body = JSON.parse(sent.body!);
  assert.equal(body.txId, r.body.id.toUpperCase());
  assert.equal(body.payeurAlias, PAYER, 'normalised to lower case');
  assert.equal(body.payeAlias, ALIAS);
  assert.equal(body.montant, 5000);
  assert.equal(body.categorie, '500');
  received.push(pay({ txId: r.body.id.toUpperCase(), categorie: '500', payeurAlias: PAYER, end2endId: 'E2E-R' }));
  g.sqlite.prepare('UPDATE payments SET last_checked_at = NULL').run();
  assert.equal((await g.call('GET', `/v1/collections/${r.body.id}`)).body.status, 'completed');
});

test('payment requests: a rejected one fails cleanly, a PI-SPI error is not blamed on the customer, and a customer is not asked over and over', async () => {
  const g = await setup(PISPI);
  rtpAnswer = () => json({ statut: 'REJETE', statutRaison: 'AC03' });
  const rej = await g.call('POST', '/v1/collections', { reference: 'r-1', amount: 5000, rail: 'pispi_rtp', payerAlias: PAYER });
  assert.equal(rej.body.status, 'failed');
  assert.equal(rej.body.failure, 'The payment request was declined');

  rtpAnswer = () => json({ title: 'Forbidden' }, 403);
  const err = await g.call('POST', '/v1/collections', { reference: 'r-2', amount: 5000, rail: 'pispi_rtp', payerAlias: PAYER });
  assert.equal(err.body.status, 'failed');
  assert.equal(err.body.failure, 'The payment could not be started', 'not "declined": it was our problem');
  assert.ok(net.alerts().some((a) => /could not be sent/.test(a.title)));

  rtpAnswer = () => json({ statut: 'ENVOYE', end2endId: 'E' });
  await g.call('POST', '/v1/collections', { reference: 'r-3', amount: 5000, rail: 'pispi_rtp', payerAlias: PAYER });
  const fourth = await g.call('POST', '/v1/collections', { reference: 'r-4', amount: 5000, rail: 'pispi_rtp', payerAlias: PAYER });
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.error.code, 'rtp_limit');
  assert.equal((await g.call('POST', '/v1/collections', { reference: 'r-5', amount: 5000, rail: 'pispi_rtp', payerAlias: 'not-an-alias' })).body.error.code, 'invalid_payer_alias');
});

test('PI-SPI is never available for payouts, and the methods endpoint reflects the switches', async () => {
  const g = await setup(PISPI);
  assert.equal((await g.call('POST', '/v1/disbursements', { reference: 'p-1', amount: 5000, rail: 'pispi_qr' })).body.error.code, 'invalid_rail');
  assert.deepEqual((await g.call('GET', '/v1/methods?rail=pispi_qr')).body, { rail: 'pispi_qr', available: true, direction: 'collect', manualConfirmation: false });
  const noPoll = await setup({ ...PISPI, PISPI_POLL: 'false' });
  assert.equal((await noPoll.call('GET', '/v1/methods?rail=pispi_qr')).body.manualConfirmation, true, 'without polling a person must confirm');
  assert.equal((await noPoll.call('GET', '/v1/methods?rail=pispi_rtp')).body.available, false, 'requests need polling too');
});
