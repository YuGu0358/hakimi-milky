import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync, mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLedger, deriveState, unfinished} from './ledger.mjs';
import {USDM_UNIT} from '../shared/constants.mjs';

const tempPath = () => join(mkdtempSync(join(tmpdir(), 'ledger-')), 'nested', 'task-1-evidence.jsonl');
const newLedger = (path = tempPath()) => createLedger({path, taskId: 'task-1', clock: () => 1_793_340_000_000});

const amount = {unit: USDM_UNIT, value: '300000'};
const terms = (unlockTime = 1_793_341_920_000, blockchainIdentifier = 'bid-1') => ({
  jobId: 'job-1',
  blockchainIdentifier,
  agentIdentifier: 'agent',
  sellerVkey: 'vkey',
  inputHash: 'ab',
  identifierFromPurchaser: 'cd',
  paymentSourceType: 'Web3CardanoV2',
  supportedPaymentSourceIndex: 0,
  payByTime: 1_793_340_480_000,
  submitResultTime: 1_793_341_020_000,
  unlockTime,
  externalDisputeUnlockTime: 1_793_342_820_000,
});
const reserved = (blockchainIdentifier = 'bid-1', unlockTime) => ({
  step: 'purchase.reserved',
  proposalId: 'p1',
  subtask: 'normalize',
  amount,
  terms: terms(unlockTime, blockchainIdentifier),
  refs: {blockchainIdentifier, nonce: 'cd'},
});
const onBid = (step, blockchainIdentifier = 'bid-1', extra = {}) => ({step, refs: {blockchainIdentifier}, ...extra});

const stateAfter = (...entries) => {
  const ledger = newLedger();
  entries.forEach((entry) => ledger.append(entry));
  return ledger.state();
};

test('an empty ledger has no money reserved and no hires', () => {
  assert.deepEqual(deriveState([]), {units: {}, hires: 0, subtasks: {}, purchases: {}});
});

test('a reservation locks the amount, counts a hire and opens the subtask', () => {
  const state = stateAfter(reserved());
  assert.deepEqual(state.units[USDM_UNIT], {spent: 0n, locked: 300000n});
  assert.equal(state.hires, 1);
  assert.equal(state.subtasks.normalize.status, 'open');
  assert.equal(state.purchases['bid-1'].status, 'reserved');
  assert.equal(state.purchases['bid-1'].nonce, 'cd');
});

test('a definite rejection releases the money and the hire', () => {
  const state = stateAfter(reserved(), onBid('purchase.rejected'));
  assert.deepEqual(state.units[USDM_UNIT], {spent: 0n, locked: 0n});
  assert.equal(state.hires, 0);
  assert.equal(state.subtasks.normalize.status, 'failed');
});

test('money stays reserved after a failed acceptance until the refund is back', () => {
  const failed = stateAfter(reserved(), onBid('purchase.funds_locked'), onBid('result.submitted'), onBid('acceptance.failed'));
  assert.equal(failed.subtasks.normalize.status, 'failed');
  assert.equal(failed.units[USDM_UNIT].locked, 300000n);
  const refunding = stateAfter(reserved(), onBid('acceptance.failed'), onBid('refund.requested'), onBid('refund.authorized'));
  assert.equal(refunding.units[USDM_UNIT].locked, 300000n);
  const back = stateAfter(reserved(), onBid('acceptance.failed'), onBid('refund.withdrawn'));
  assert.deepEqual(back.units[USDM_UNIT], {spent: 0n, locked: 0n});
  assert.equal(back.hires, 1);
});

test('a seller withdrawal moves the money from locked to spent', () => {
  const state = stateAfter(reserved(), onBid('acceptance.passed'), onBid('seller.withdrawn'));
  assert.deepEqual(state.units[USDM_UNIT], {spent: 300000n, locked: 0n});
  assert.equal(state.subtasks.normalize.status, 'accepted');
});

test('money from a refund is never released twice', () => {
  const state = stateAfter(reserved(), onBid('refund.withdrawn'), onBid('refund.withdrawn'));
  assert.equal(state.units[USDM_UNIT].locked, 0n);
});

test('steps that carry no money leave the budget alone', () => {
  const state = stateAfter(reserved(), {step: 'guard.checked', decision: 'allow'}, onBid('purchase.created'));
  assert.equal(state.units[USDM_UNIT].locked, 300000n);
  assert.equal(state.purchases['bid-1'].status, 'created');
});

test('a purchase never moves backwards when a retry logs an earlier step again', () => {
  const state = stateAfter(reserved(), onBid('purchase.funds_locked'), onBid('purchase.created'));
  assert.equal(state.purchases['bid-1'].status, 'funds_locked');
});

test('a late rejection line cannot undo work that already passed', () => {
  const state = stateAfter(reserved(), onBid('purchase.created'), onBid('acceptance.passed'), onBid('purchase.rejected'));
  assert.equal(state.subtasks.normalize.status, 'accepted');
  assert.equal(state.units[USDM_UNIT].locked, 300000n);
  assert.equal(state.hires, 1);
});

test('the refund of an old hire does not reopen a subtask a newer hire now owns', () => {
  const state = stateAfter(reserved('bid-old'), onBid('acceptance.failed', 'bid-old'), reserved('bid-new'), onBid('refund.withdrawn', 'bid-old'));
  assert.equal(state.subtasks.normalize.status, 'open');
  assert.equal(state.subtasks.normalize.blockchainIdentifier, 'bid-new');
  assert.equal(state.units[USDM_UNIT].locked, 300000n);
});

test('money the chain says went to a seller counts as spent even on a purchase marked rejected', () => {
  const state = stateAfter(reserved(), onBid('purchase.rejected'), onBid('seller.withdrawn'));
  assert.deepEqual(state.units[USDM_UNIT], {spent: 300000n, locked: 0n});
});

test('unfinished lists open purchases with the nearest unlock first and skips finished ones', () => {
  const state = stateAfter(
    reserved('bid-late', 3_000_000_000_000),
    reserved('bid-near', 2_000_000_000_000),
    reserved('bid-done', 1_000_000_000_000),
    onBid('seller.withdrawn', 'bid-done'),
  );
  assert.deepEqual(unfinished(state).map((item) => item.blockchainIdentifier), ['bid-near', 'bid-late']);
});

test('the state survives a restart because it is rebuilt from the file', () => {
  const path = tempPath();
  newLedger(path).append(reserved());
  const restarted = newLedger(path);
  assert.equal(restarted.state().units[USDM_UNIT].locked, 300000n);
  assert.equal(restarted.lines().length, 1);
});

test('a line torn by a crash is dropped and the drop is recorded', () => {
  const path = tempPath();
  newLedger(path).append(reserved());
  appendFileSync(path, '{"ts":1793340000000,"taskId":"task-1","step":"purchase.cre');
  const restarted = newLedger(path);
  assert.deepEqual(restarted.lines().map((line) => line.step), ['purchase.reserved', 'ledger.torn_line_dropped']);
  restarted.append(onBid('purchase.created'));
  assert.equal(restarted.state().purchases['bid-1'].status, 'created');
});

test('a corrupt line in the middle stops the load instead of guessing', () => {
  const path = tempPath();
  newLedger(path).append(reserved());
  appendFileSync(path, 'garbage\n');
  newLedger(path);
  appendFileSync(path, `${JSON.stringify({ts: 1, taskId: 'task-1', step: 'x'})}\n`);
  assert.throws(() => newLedger(path).lines(), /evidence line 2/);
});

test('append refuses an invalid entry and writes nothing', () => {
  const path = tempPath();
  const ledger = newLedger(path);
  assert.throws(() => ledger.append({reason: 'no step'}));
  assert.equal(ledger.lines().length, 0);
});

test('the file holds one JSON object per line, stamped with task and time', () => {
  const path = tempPath();
  newLedger(path).append(reserved());
  const [line] = readFileSync(path, 'utf8').trim().split('\n').map((text) => JSON.parse(text));
  assert.equal(line.taskId, 'task-1');
  assert.equal(line.ts, 1_793_340_000_000);
  assert.equal(line.amount.value, '300000');
});
