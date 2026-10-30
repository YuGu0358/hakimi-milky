import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLedger} from './ledger.mjs';
import {reconcileRun} from './reconcile.mjs';
import {PaymentsError} from '../shared/errors.mjs';
import {USDM_UNIT} from '../shared/constants.mjs';

const T0 = 1_793_340_000_000;
const TX = (letter) => letter.repeat(64);
const tx = (state, letter) => ({status: 'Confirmed', newOnChainState: state, txHash: TX(letter)});
const QUOTE = {
  jobId: 'job-1',
  blockchainIdentifier: 'order-1',
  agentIdentifier: 'a'.repeat(60),
  sellerVkey: 'seller',
  inputHash: 'ab',
  identifierFromPurchaser: 'cd',
  paymentSourceType: 'Web3CardanoV2',
  supportedPaymentSourceIndex: 0,
  payByTime: T0,
  submitResultTime: T0,
  unlockTime: T0,
  externalDisputeUnlockTime: T0,
};

function ledgerWithOrder(extra = []) {
  const directory = mkdtempSync(join(tmpdir(), 'reconcile-'));
  const ledger = createLedger({path: join(directory, 'task-evidence.jsonl'), taskId: 'task', clock: () => T0});
  const refs = {jobId: QUOTE.jobId, blockchainIdentifier: QUOTE.blockchainIdentifier, nonce: 'n1'};
  ledger.append({step: 'purchase.reserved', proposalId: 'p1', subtask: 'copy', refs, amount: {unit: USDM_UNIT, value: '200000'}, terms: QUOTE});
  extra.forEach((entry) => ledger.append({proposalId: 'p1', subtask: 'copy', refs, ...entry}));
  return ledger;
}

const view = (history) => ({onChainState: history.at(-1)?.newOnChainState ?? null, current: history.at(-1) ?? null, history: history.slice(0, -1)});
const stepsOf = (ledger) => ledger.lines().map(({step}) => step);

test('a seller who collected after the watcher gave up gets its line, with the transaction', async () => {
  const ledger = ledgerWithOrder([{step: 'purchase.funds_locked', refs: {blockchainIdentifier: 'order-1', txHash: TX('a')}, reason: 'FundsLocked'}, {step: 'settlement.pending', reason: 'not yet'}]);
  const getPurchase = async () => view([tx('FundsLocked', 'a'), tx('ResultSubmitted', 'b'), tx('Withdrawn', 'c')]);

  const {added, failures} = await reconcileRun({ledger, getPurchase});

  assert.deepEqual(failures, []);
  assert.deepEqual(added, ['result.submitted', 'seller.withdrawn']);
  const collected = ledger.lines().find(({step}) => step === 'seller.withdrawn');
  assert.equal(collected.refs.txHash, TX('c'));
  assert.equal(collected.subtask, 'copy');
  assert.equal(collected.detail.reconciled, true);
  assert.equal(ledger.state().purchases['order-1'].status, 'withdrawn');
});

test('a refund that came back by itself is recorded, and the money is no longer counted as locked', async () => {
  const ledger = ledgerWithOrder();
  const getPurchase = async () => view([tx('FundsLocked', 'a'), tx('RefundWithdrawn', 'd')]);

  await reconcileRun({ledger, getPurchase});

  const state = ledger.state();
  assert.equal(state.purchases['order-1'].status, 'refund_withdrawn');
  assert.equal(state.units[USDM_UNIT].locked, 0n);
});

test('running it twice adds nothing the second time', async () => {
  const ledger = ledgerWithOrder();
  const getPurchase = async () => view([tx('FundsLocked', 'a')]);

  await reconcileRun({ledger, getPurchase});
  const {added} = await reconcileRun({ledger, getPurchase});

  assert.deepEqual(added, []);
  assert.equal(stepsOf(ledger).filter((step) => step === 'purchase.funds_locked').length, 1);
});

test('a finished purchase is not looked up again', async () => {
  const ledger = ledgerWithOrder([{step: 'seller.withdrawn', refs: {blockchainIdentifier: 'order-1', txHash: TX('c')}, reason: 'Withdrawn'}]);
  let calls = 0;

  await reconcileRun({
    ledger,
    getPurchase: async () => {
      calls += 1;
      return view([]);
    },
  });

  assert.equal(calls, 0);
});

test('states that mean the same step are written once', async () => {
  const ledger = ledgerWithOrder();
  const getPurchase = async () => view([tx('RefundRequested', 'e'), tx('Disputed', 'f')]);

  const {added} = await reconcileRun({ledger, getPurchase});

  assert.deepEqual(added, ['refund.requested']);
});

test('a lookup that fails is reported and blames nobody', async () => {
  const ledger = ledgerWithOrder();
  const before = stepsOf(ledger);

  const {added, failures} = await reconcileRun({
    ledger,
    getPurchase: async () => {
      throw new PaymentsError('fetch failed');
    },
  });

  assert.deepEqual(added, []);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /fetch failed/);
  assert.deepEqual(stepsOf(ledger), before);
});

test('an order the service never saw is left alone', async () => {
  const ledger = ledgerWithOrder();

  const {added, failures} = await reconcileRun({
    ledger,
    getPurchase: async () => {
      throw new PaymentsError('Purchase not found', {status: 404});
    },
  });

  assert.deepEqual(added, []);
  assert.deepEqual(failures, []);
});
