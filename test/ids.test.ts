import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { providerIdFor } from '../src/ids.ts';

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// how Relay derives its pawaPay ids today (worker/deposit/pawapay.ts depositUuid, worker/payout/pawapay.ts payoutUuid)
function relayUuid(input: string) {
  const h = createHash('sha256').update(input).digest().subarray(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x40; h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

test('provider ids are valid UUIDv4s and stable', async () => {
  const t = { id: 'courtly', id_namespace: null };
  const a = await providerIdFor(t, 'collection', 'order-1');
  assert.match(a, UUID4);
  assert.equal(a, await providerIdFor(t, 'collection', 'order-1'));
  assert.notEqual(a, await providerIdFor(t, 'collection', 'order-2'));
});

test('two tenants can use the same reference without ever sharing a provider id; a collection and a disbursement differ too', async () => {
  const a = await providerIdFor({ id: 'one', id_namespace: null }, 'collection', 'ref-1');
  const b = await providerIdFor({ id: 'two', id_namespace: null }, 'collection', 'ref-1');
  const c = await providerIdFor({ id: 'one', id_namespace: null }, 'disbursement', 'ref-1');
  assert.equal(new Set([a, b, c]).size, 3);
});

test('a migrated tenant keeps the ids its old product derived, so payments in flight at the cutover still resolve', async () => {
  const relay = { id: 'relay', id_namespace: 'relay' };
  assert.equal(await providerIdFor(relay, 'collection', 'bu1abc234'), relayUuid('relay-deposit:bu1abc234'));
  assert.equal(await providerIdFor(relay, 'disbursement', 'poord001'), relayUuid('relay-payout:poord001'));
});
