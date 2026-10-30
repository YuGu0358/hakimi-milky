import test from 'node:test';
import assert from 'node:assert/strict';
import {createMandate, mandateHash} from './mandate.mjs';
import {MINUTE_MS, USDM_UNIT} from '../shared/constants.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import agents from '../shared/fixtures/agents.json' with {type: 'json'};

const T0 = 1_793_340_000_000;
const base = {taskId: 'task-1', allowlist: agents, acceptance, startedAt: T0};

test('a standalone run delivers within 40 minutes and locks money for at most 60', () => {
  const mandate = createMandate(base);
  assert.equal(mandate.deliverBy, T0 + 40 * MINUTE_MS);
  assert.equal(mandate.lockUntil, T0 + 60 * MINUTE_MS);
});

test('a front desk task must deliver 3 minutes before the front desk deadline', () => {
  const deadline = T0 + 45 * MINUTE_MS;
  assert.equal(createMandate({...base, frontDeskDeadline: deadline}).deliverBy, deadline - 3 * MINUTE_MS);
});

test('the demo limits are 0.8 tUSDM in total, 0.4 per hire and 3 hires', () => {
  const mandate = createMandate(base);
  assert.deepEqual(mandate.budget, {[USDM_UNIT]: '800000'});
  assert.deepEqual(mandate.perHire, {[USDM_UNIT]: '400000'});
  assert.equal(mandate.maxHires, 3);
});

test('the allowlist keeps what the guard needs and drops the rest', () => {
  const [entry] = createMandate(base).allowlist;
  assert.deepEqual(Object.keys(entry).sort(), ['agentIdentifier', 'apiBaseUrl', 'name', 'role', 'sellerVkey']);
});

test('an empty allowlist is refused', () => {
  assert.throws(() => createMandate({...base, allowlist: []}));
});

test('the hash pins the terms: same terms same hash, other budget other hash', () => {
  const one = createMandate(base);
  assert.equal(mandateHash(one), mandateHash(createMandate(base)));
  const stricter = createMandate({...base, limits: {budget: '500000', perHire: '400000', maxHires: 3}});
  assert.notEqual(mandateHash(one), mandateHash(stricter));
});
