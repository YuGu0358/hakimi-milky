import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMandate, loadOrCreateMandate, mandateHash} from './mandate.mjs';
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

const tempPath = () => join(mkdtempSync(join(tmpdir(), 'mandate-')), 'nested', 'task-1-mandate.json');

test('the first start writes the mandate and a restart reads the same one', () => {
  const path = tempPath();

  const first = loadOrCreateMandate({...base, path});
  const again = loadOrCreateMandate({...base, startedAt: T0 + 30 * MINUTE_MS, path});

  assert.equal(existsSync(path), true);
  assert.equal(mandateHash(again), mandateHash(first));
  assert.equal(again.lockUntil, T0 + 60 * MINUTE_MS);
});

test('a restart cannot widen a saved mandate', () => {
  const path = tempPath();
  loadOrCreateMandate({...base, path});

  const again = loadOrCreateMandate({...base, limits: {budget: '9000000', perHire: '9000000', maxHires: 99}, path});

  assert.deepEqual(again.budget, {[USDM_UNIT]: '800000'});
  assert.equal(again.maxHires, 3);
});

test('a saved mandate for another task is refused', () => {
  const path = tempPath();
  loadOrCreateMandate({...base, path});

  assert.throws(() => loadOrCreateMandate({...base, taskId: 'task-2', path}), /task-1/);
});

test('a damaged mandate file is refused, not replaced', () => {
  const path = tempPath();
  loadOrCreateMandate({...base, path});
  writeFileSync(path, '{"budget":');

  assert.throws(() => loadOrCreateMandate({...base, path}), /Cannot read the mandate/);
});

test('a mandate file with widened fields that break the schema is refused', () => {
  const path = tempPath();
  loadOrCreateMandate({...base, path});
  writeFileSync(path, JSON.stringify({taskId: 'task-1', budget: {[USDM_UNIT]: 'all of it'}}));

  assert.throws(() => loadOrCreateMandate({...base, path}), /Cannot read the mandate/);
});
