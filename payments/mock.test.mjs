import test from 'node:test';
import assert from 'node:assert/strict';
import {createMockPayments} from './mock.mjs';
import {resultHash} from '../shared/hash.mjs';
import {isConfirmed} from '../shared/schemas.mjs';
import {USDM_UNIT} from '../shared/constants.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import table from '../shared/fixtures/table.json' with {type: 'json'};

const nonce = 'ab'.repeat(10);
const job = {kind: 'normalize', table, acceptance, key: 'sku'};
const T0 = 1_793_340_000_000;
const clock = () => T0;

const advanceTo = async (payments, id, state) => {
  for (let i = 0; i < 10; i += 1) {
    const view = await payments.getPurchase(id);
    if (view.onChainState === state) return view;
  }
  throw new Error(`never reached ${state}`);
};

test('listAgents returns the three fixed-price demo agents', async () => {
  const listings = await createMockPayments({clock}).listAgents();
  assert.equal(listings.length, 3);
  assert.ok(listings.every((listing) => listing.pricingType === 'Fixed' && listing.price.unit === USDM_UNIT));
});

test('startJob returns a quote with the specialist window', async () => {
  const payments = createMockPayments({clock});
  const [standard] = await payments.listAgents();
  const quote = await payments.startJob(standard, job, nonce);
  assert.equal(quote.identifierFromPurchaser, nonce);
  assert.equal(quote.submitResultTime - T0, 17 * 60_000);
  assert.equal(quote.unlockTime - T0, 32 * 60_000);
});

test('the normal path ends with the seller paid and the result matching the chain hash', async () => {
  const payments = createMockPayments({clock});
  const [standard] = await payments.listAgents();
  const quote = await payments.startJob(standard, job, nonce);
  const created = await payments.purchase(quote, {taskId: 'task-1'});
  assert.equal(created.existed, false);
  const submitted = await advanceTo(payments, quote.blockchainIdentifier, 'ResultSubmitted');
  assert.equal(isConfirmed(submitted, 'FundsLocked'), true);
  const {status, result} = await payments.getJobResult(standard, quote.jobId);
  assert.equal(status, 'completed');
  assert.equal(submitted.resultHash, resultHash(result, nonce));
  payments.settle(quote.blockchainIdentifier);
  const settled = await payments.getPurchase(quote.blockchainIdentifier);
  assert.equal(settled.onChainState, 'Withdrawn');
  assert.equal(settled.withdrawnForSeller[0].amount, standard.price.amount);
});

test('ordering the same quote twice reports the existing purchase', async () => {
  const payments = createMockPayments({clock});
  const [standard] = await payments.listAgents();
  const quote = await payments.startJob(standard, job, nonce);
  await payments.purchase(quote, {});
  assert.equal((await payments.purchase(quote, {})).existed, true);
});

test('the refund path after a submitted result goes through Disputed to money back', async () => {
  const payments = createMockPayments({clock, faults: {dropRows: 2}});
  const [, cheap] = await payments.listAgents();
  const quote = await payments.startJob(cheap, job, nonce);
  await payments.purchase(quote, {});
  await advanceTo(payments, quote.blockchainIdentifier, 'ResultSubmitted');
  const {result} = await payments.getJobResult(cheap, quote.jobId);
  assert.equal(JSON.parse(result).length, 18);
  await payments.requestRefund(quote.blockchainIdentifier);
  const seen = [];
  for (let i = 0; i < 3; i += 1) seen.push((await payments.getPurchase(quote.blockchainIdentifier)).onChainState);
  assert.deepEqual(seen, ['Disputed', 'RefundAuthorized', 'RefundWithdrawn']);
  const back = await payments.getPurchase(quote.blockchainIdentifier);
  assert.equal(back.withdrawnForBuyer[0].amount, cheap.price.amount);
  assert.equal(isConfirmed(back, 'RefundWithdrawn'), true);
});

test('dropRows only affects the cheap agent, the standard agent stays honest', async () => {
  const payments = createMockPayments({clock, faults: {dropRows: 2}});
  const [standard] = await payments.listAgents();
  const quote = await payments.startJob(standard, job, nonce);
  const {result} = await payments.getJobResult(standard, quote.jobId);
  assert.equal(JSON.parse(result).length, 20);
});

test('a refund request in the wrong state is a 404, like the Payment Service', async () => {
  const payments = createMockPayments({clock});
  const [standard] = await payments.listAgents();
  const quote = await payments.startJob(standard, job, nonce);
  await payments.purchase(quote, {});
  await assert.rejects(payments.requestRefund(quote.blockchainIdentifier), (error) => error.status === 404);
});

test('looking up an unknown purchase is a not-found error', async () => {
  const payments = createMockPayments({clock});
  await assert.rejects(payments.getPurchase('nope'), (error) => error.kind === 'not-found');
});

test('the copy job returns a JSON object with one text per SKU', async () => {
  const payments = createMockPayments({clock});
  const [, , copy] = await payments.listAgents();
  const quote = await payments.startJob(copy, {...job, kind: 'copy'}, nonce);
  const {result} = await payments.getJobResult(copy, quote.jobId);
  assert.equal(Object.keys(JSON.parse(result)).length, 20);
});
