import test from 'node:test';
import assert from 'node:assert/strict';
import {LOW_CREDIT, runRejections} from './rejections.mjs';
import {PaymentsError} from '../shared/errors.mjs';

const QUOTE = {
  jobId: 'job-1',
  blockchainIdentifier: 'order-1',
  agentIdentifier: 'agent-1',
  sellerVkey: 'seller-key',
  inputHash: 'ab',
  identifierFromPurchaser: 'cd',
  paymentSourceType: 'Web3CardanoV2',
  supportedPaymentSourceIndex: 0,
  payByTime: 1_793_340_000_000,
  submitResultTime: 1_793_340_600_000,
  unlockTime: 1_793_341_500_000,
  externalDisputeUnlockTime: 1_793_342_400_000,
};
const PRICE = {unit: 'usdm', amount: '200000'};

const refuse = (status, text) => {
  throw new PaymentsError(`Payment Service answered HTTP ${status}: ${text}`, {status});
};

// The service the key really talks to: too little credit, no seller wallet, Preprod only.
const serviceThatRefuses = async (path, body) => {
  if (body.network === 'Mainnet') refuse(401, 'Unauthorized, network not allowed');
  if (path === '/payment') refuse(404, 'Not found');
  if (path === '/purchase') refuse(400, 'Insufficient funds');
  throw new Error(`Unexpected call to ${path}`);
};

function keysStartingAt(before) {
  const sets = [];
  return {
    sets,
    setCredit: async (amount) => {
      sets.push(amount);
      return {before, after: amount};
    },
  };
}

test('all three calls are refused for the reason the limit is there', async () => {
  const keys = keysStartingAt('400000');

  const attempts = await runRejections({request: serviceThatRefuses, keys, quote: QUOTE, price: PRICE});

  assert.equal(attempts.length, 3);
  assert.ok(attempts.every(({ok}) => ok), JSON.stringify(attempts));
  assert.deepEqual(attempts.map(({actual}) => actual.status), [400, 404, 401]);
  assert.match(attempts[0].actual.message, /Insufficient funds/);
});

test('the order that must fail on credit asks for a real price with the credit below it', async () => {
  const seen = [];
  const keys = keysStartingAt('400000');
  const request = async (path, body) => {
    seen.push({path, body});
    return serviceThatRefuses(path, body);
  };

  await runRejections({request, keys, quote: QUOTE, price: PRICE});

  assert.ok(BigInt(LOW_CREDIT) < BigInt(PRICE.amount));
  assert.equal(keys.sets[0], LOW_CREDIT);
  const [order] = seen;
  assert.equal(order.path, '/purchase');
  assert.deepEqual(order.body.Amounts, [PRICE]);
  assert.equal(order.body.network, 'Preprod');
  assert.equal(order.body.blockchainIdentifier, QUOTE.blockchainIdentifier);
});

test('a call that goes through is reported as a failure', async () => {
  const request = async (path, body) => (path === '/purchase' && body.network === 'Preprod' ? {id: 'bought'} : serviceThatRefuses(path, body));

  const attempts = await runRejections({request, keys: keysStartingAt('400000'), quote: QUOTE, price: PRICE});

  assert.equal(attempts[0].ok, false);
  assert.equal(attempts[0].actual.status, 200);
});

test('a refusal for another reason is reported as a failure', async () => {
  const request = async () => refuse(500, 'Internal error');

  const attempts = await runRejections({request, keys: keysStartingAt('400000'), quote: QUOTE, price: PRICE});

  assert.ok(attempts.every(({ok}) => !ok));
});

test('an order refused with the right status but for another reason is a failure', async () => {
  const request = async (path, body) => (path === '/purchase' && body.network === 'Preprod' ? refuse(400, 'Invalid seller vkey') : serviceThatRefuses(path, body));

  const attempts = await runRejections({request, keys: keysStartingAt('400000'), quote: QUOTE, price: PRICE});

  assert.equal(attempts[0].ok, false);
});

test('the credit comes back afterwards', async () => {
  const keys = keysStartingAt('400000');

  await runRejections({request: serviceThatRefuses, keys, quote: QUOTE, price: PRICE});

  assert.deepEqual(keys.sets, [LOW_CREDIT, '400000']);
});

test('the credit comes back even when a call cannot be made at all', async () => {
  const keys = keysStartingAt('400000');
  const request = async () => {
    throw new TypeError('the code is wrong');
  };

  await assert.rejects(runRejections({request, keys, quote: QUOTE, price: PRICE}), /the code is wrong/);

  assert.deepEqual(keys.sets, [LOW_CREDIT, '400000']);
});
