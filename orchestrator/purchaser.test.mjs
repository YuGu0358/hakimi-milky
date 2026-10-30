import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPurchaser} from './purchaser.mjs';
import {createLedger} from './ledger.mjs';
import {PaymentsError} from '../shared/errors.mjs';
import {MINUTE_MS, USDM_UNIT} from '../shared/constants.mjs';
import {jobPrompt} from '../shared/schemas.mjs';
import {createMockPayments} from '../payments/mock.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import agents from '../shared/fixtures/agents.json' with {type: 'json'};
import table from '../shared/fixtures/table.json' with {type: 'json'};

const T0 = 1_793_340_000_000;
const clock = () => T0;
const [standard, cheap] = agents;

const mandate = {
  id: 'm1',
  taskId: 'task-1',
  budget: {[USDM_UNIT]: '800000'},
  perHire: {[USDM_UNIT]: '400000'},
  maxHires: 3,
  allowlist: agents.map(({agentIdentifier, sellerVkey, name, apiBaseUrl, role}) => ({
    agentIdentifier,
    sellerVkey,
    name,
    apiBaseUrl,
    role,
  })),
  deliverBy: T0 + 42 * MINUTE_MS,
  lockUntil: T0 + 60 * MINUTE_MS,
  acceptance,
  createdAt: T0,
};

const job = {kind: 'normalize', table, acceptance, key: 'sku'};
const prompt = jobPrompt(job);
const nonceFor = (index) => String(index).padStart(2, '0').repeat(10);

function setup({faults = {}, overrides = {}} = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'purchaser-')), 'evidence.jsonl');
  const ledger = createLedger({path, taskId: 'task-1', clock});
  const payments = createMockPayments({faults, clock});
  const calls = {purchase: 0};
  const purchase = (...args) => {
    calls.purchase += 1;
    return (overrides.purchase ?? payments.purchase)(...args);
  };
  const getPurchase = overrides.getPurchase ?? payments.getPurchase;
  const purchaser = createPurchaser({mandate, ledger, purchase, getPurchase, clock});
  return {ledger, payments, purchaser, calls, path};
}

const steps = (ledger) => ledger.lines().map((line) => line.step);
const locked = (ledger) => ledger.state().units[USDM_UNIT]?.locked ?? 0n;

const buyContext = async (payments, agent, index, subtask = 'normalize') => {
  const nonce = nonceFor(index);
  const quote = await payments.startJob(agent, job, nonce);
  const price = agent.price;
  return {quote, price, prompt, nonce, subtask, proposalId: `p${index}`};
};

test('a clean quote is reserved, then bought, and both steps are in the evidence', async () => {
  const {ledger, payments, purchaser, calls} = setup();
  const result = await purchaser.buy(await buyContext(payments, standard, 1));
  assert.equal(result.ok, true);
  assert.equal(calls.purchase, 1);
  assert.deepEqual(steps(ledger), ['guard.checked', 'purchase.reserved', 'purchase.created']);
  assert.equal(locked(ledger), 300000n);
});

test('a denied quote never reaches the Payment Service', async () => {
  const {ledger, payments, purchaser, calls} = setup();
  const context = await buyContext(payments, standard, 1);
  const result = await purchaser.buy({...context, quote: {...context.quote, sellerVkey: 'ff'.repeat(28)}});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'G1_VKEY_MISMATCH');
  assert.equal(calls.purchase, 0);
  assert.deepEqual(steps(ledger), ['guard.checked']);
  assert.equal(ledger.lines()[0].decision, 'deny');
  assert.equal(ledger.lines()[0].rule, 'G1');
});

test('two parallel purchases cannot both take the last of the budget', async () => {
  const {ledger, payments, purchaser, calls} = setup();
  const first = await buyContext(payments, cheap, 1, 'copy-a');
  await purchaser.buy(first);
  assert.equal(locked(ledger), 200000n);
  const big = {unit: USDM_UNIT, amount: '400000'};
  const a = {...(await buyContext(payments, standard, 2, 'normalize')), price: big};
  const b = {...(await buyContext(payments, standard, 3, 'copy')), price: big};
  const results = await Promise.all([purchaser.buy(a), purchaser.buy(b)]);
  assert.deepEqual(results.map((result) => result.ok).sort(), [false, true]);
  assert.equal(results.find((result) => !result.ok).code, 'G2_OVER_BUDGET');
  assert.equal(calls.purchase, 2);
  assert.equal(locked(ledger), 600000n);
});

test('a definite rejection releases the reservation and the hire', async () => {
  const {ledger, payments, purchaser} = setup({faults: {rejectPurchase: 'Insufficient funds'}});
  const result = await purchaser.buy(await buyContext(payments, standard, 1));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PURCHASE_REJECTED');
  assert.match(result.reason, /Insufficient funds/);
  assert.equal(locked(ledger), 0n);
  assert.equal(ledger.state().hires, 0);
});

test('a lost response is resolved by looking up the purchase, with no second order', async () => {
  const {ledger, payments, purchaser, calls} = setup({faults: {loseNextPurchaseResponse: true}});
  const result = await purchaser.buy(await buyContext(payments, standard, 1));
  assert.equal(result.ok, true);
  assert.equal(calls.purchase, 1);
  assert.deepEqual(steps(ledger), ['guard.checked', 'purchase.reserved', 'purchase.uncertain', 'purchase.created']);
  assert.equal(locked(ledger), 300000n);
});

test('when the order never arrived it is sent again with the same identifiers', async () => {
  const {ledger, payments, purchaser, calls} = setup({faults: {dropNextPurchase: true}});
  const result = await purchaser.buy(await buyContext(payments, standard, 1));
  assert.equal(result.ok, true);
  assert.equal(calls.purchase, 2);
  assert.equal(locked(ledger), 300000n);
  assert.equal(ledger.state().hires, 1);
});

test('when the outcome cannot be determined it stops and keeps the money reserved', async () => {
  const uncertain = () => {
    throw new PaymentsError('timeout');
  };
  const {ledger, payments, purchaser} = setup({overrides: {purchase: uncertain, getPurchase: uncertain}});
  const result = await purchaser.buy(await buyContext(payments, standard, 1));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PURCHASE_UNCERTAIN');
  assert.equal(result.stop, true);
  assert.equal(steps(ledger).at(-1), 'stopped');
  assert.equal(locked(ledger), 300000n);
  assert.equal(ledger.state().hires, 1);
});

test('retrying after a crash reuses the reservation and places no second order', async () => {
  const {ledger, payments, purchaser} = setup();
  const context = await buyContext(payments, standard, 1);
  await purchaser.buy(context);
  const again = await purchaser.buy(context);
  assert.equal(again.ok, true);
  assert.equal(again.created.existed, true);
  assert.equal(locked(ledger), 300000n);
  assert.equal(ledger.state().hires, 1);
});

test('replaying the same quote ten times yields one reservation', async () => {
  const {ledger, payments, purchaser} = setup();
  const context = await buyContext(payments, standard, 1);
  const results = await Promise.all(Array.from({length: 10}, () => purchaser.buy(context)));
  assert.ok(results.every((result) => result.ok));
  assert.equal(ledger.state().hires, 1);
  assert.equal(locked(ledger), 300000n);
});
