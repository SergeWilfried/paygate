import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, type Status } from '../src/states.ts';

const done = { state: 'completed' } as const;
const fail = { state: 'failed', error: 'x' } as const;

test('a processing payment settles to completed, failed, expired (collections) or unknown (disbursements)', () => {
  assert.equal(decide('collection', 'processing', done)?.to, 'completed');
  assert.equal(decide('collection', 'processing', fail)?.to, 'failed');
  assert.equal(decide('collection', 'processing', { state: 'expired' })?.to, 'expired');
  assert.equal(decide('disbursement', 'processing', { state: 'unknown', detail: 'net' })?.to, 'unknown');
});

test('expiry is for collections and an unknown outcome for disbursements, never the other way round', () => {
  assert.equal(decide('disbursement', 'processing', { state: 'expired' }), null);
  assert.equal(decide('collection', 'processing', { state: 'unknown', detail: 'net' }), null);
});

test('completed is final: nothing changes it, and a repeat is a no-op', () => {
  for (const o of [done, fail, { state: 'expired' } as const, { state: 'unknown', detail: 'x' } as const]) assert.equal(decide('collection', 'completed', o), null);
  assert.equal(decide('disbursement', 'completed', fail), null);
});

test('a completion after failed or expired is honoured and flagged late: the provider is the source of truth for money', () => {
  for (const from of ['failed', 'expired'] as Status[]) {
    const d = decide('collection', from, done)!;
    assert.equal(d.to, 'completed');
    assert.equal(d.late, true);
    assert.equal(d.event, 'late_completion');
    assert.equal(d.webhook, 'payment.completed');
  }
  assert.equal(decide('collection', 'processing', done)!.late, false);
  assert.equal(decide('disbursement', 'unknown', done)!.late, false, 'an unknown outcome that turns out paid is not "late": nobody had been told it failed');
});

test('a failure never overrides a failed, expired or already-settled payment', () => {
  assert.equal(decide('collection', 'failed', fail), null);
  assert.equal(decide('collection', 'expired', fail), null);
});

test('an unknown outcome can be settled either way by the provider (or a person)', () => {
  assert.equal(decide('disbursement', 'unknown', done)?.to, 'completed');
  assert.equal(decide('disbursement', 'unknown', fail)?.to, 'failed');
});
