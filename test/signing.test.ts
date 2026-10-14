import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signBody, verifySignature } from '../src/signing.ts';

const SECRET = 'whsec_test';
const BODY = '{"id":"evt_1","type":"payment.completed"}';

test('a signed body verifies; any change to the body, the secret or the timestamp does not', async () => {
  const t = 1_800_000_000;
  const h = await signBody(SECRET, BODY, t);
  assert.match(h, /^t=1800000000,v1=[0-9a-f]{64}$/);
  assert.equal(await verifySignature(SECRET, BODY, h, t + 10), true);
  assert.equal(await verifySignature(SECRET, BODY + ' ', h, t + 10), false);
  assert.equal(await verifySignature('whsec_other', BODY, h, t + 10), false);
  assert.equal(await verifySignature(SECRET, BODY, h.replace('t=1800000000', 't=1800000001'), t + 10), false);
});

test('a signature older than the tolerance is refused (replay), and garbage never verifies', async () => {
  const t = 1_800_000_000;
  const h = await signBody(SECRET, BODY, t);
  assert.equal(await verifySignature(SECRET, BODY, h, t + 301), false);
  assert.equal(await verifySignature(SECRET, BODY, h, t - 301), false);
  assert.equal(await verifySignature(SECRET, BODY, null), false);
  assert.equal(await verifySignature(SECRET, BODY, 'v1=abc'), false);
});
