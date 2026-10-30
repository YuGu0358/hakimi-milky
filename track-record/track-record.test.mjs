import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTrackRecords, recentTransactions, spendsOf, tally} from './track-record.mjs';
import {ESCROW_CONTRACT} from '../shared/constants.mjs';

const OTHER_ADDRESS = 'addr_test1other';
const WITHDRAW = {json_value: {constructor: 0, fields: []}};
const WITHDRAW_REFUND = {json_value: {constructor: 3, fields: []}};
const DISPUTED = {json_value: {constructor: 4, fields: []}};
const SUBMIT_RESULT = {json_value: {constructor: 5, fields: []}};
const datumFor = (agent) => ({json_value: {constructor: 0, fields: [...Array(8).fill({bytes: 'aa'}), {bytes: agent}, {int: 1}]}});

// Answers only the paths a test names, so a call the code should not make fails loudly.
const getFrom = (routes) => {
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    if (!(path in routes)) throw new Error(`Unexpected call to ${path}`);
    return routes[path];
  };
  return {get, calls};
};

const input = (txHash, outputIndex, extra = {}) => ({tx_hash: txHash, output_index: outputIndex, address: ESCROW_CONTRACT, data_hash: `datum-${txHash}`, ...extra});

test('each redeemer is matched to its input by the order the ledger sorts inputs in', async () => {
  const {get} = getFrom({
    '/txs/t1/redeemers': [
      {purpose: 'spend', tx_index: 1, redeemer_data_hash: 'withdraw'},
      {purpose: 'spend', tx_index: 2, redeemer_data_hash: 'refund'},
    ],
    '/txs/t1/utxos': {
      inputs: [
        input('cc', 0),
        input('ee', 0, {collateral: true}),
        input('aa', 0, {address: OTHER_ADDRESS, data_hash: null}),
        input('bb', 7),
        input('ff', 0, {reference: true}),
      ],
    },
    '/scripts/datum/datum-bb': datumFor('agent-bb'),
    '/scripts/datum/datum-cc': datumFor('agent-cc'),
    '/scripts/datum/withdraw': WITHDRAW,
    '/scripts/datum/refund': WITHDRAW_REFUND,
  });

  const spends = await spendsOf({get, txHash: 't1'});

  assert.deepEqual(spends, [
    {agentIdentifier: 'agent-bb', action: 0},
    {agentIdentifier: 'agent-cc', action: 3},
  ]);
});

test('a transaction with no script spend costs one call and adds nothing', async () => {
  const {get, calls} = getFrom({'/txs/lock/redeemers': []});

  assert.deepEqual(await spendsOf({get, txHash: 'lock'}), []);
  assert.equal(calls.length, 1);
});

test('a script spend outside the escrow contract is left out', async () => {
  const {get} = getFrom({
    '/txs/t2/redeemers': [{purpose: 'spend', tx_index: 0, redeemer_data_hash: 'withdraw'}],
    '/txs/t2/utxos': {inputs: [input('aa', 0, {address: OTHER_ADDRESS})]},
  });

  assert.deepEqual(await spendsOf({get, txHash: 't2'}), []);
});

test('a minting redeemer is not read as a spend', async () => {
  const {get} = getFrom({'/txs/t3/redeemers': [{purpose: 'mint', tx_index: 0, redeemer_data_hash: 'withdraw'}]});

  assert.deepEqual(await spendsOf({get, txHash: 't3'}), []);
});

for (const [name, datum, redeemer] of [
  ['a datum without an agent', {json_value: {constructor: 0, fields: []}}, WITHDRAW],
  ['a redeemer without an action', datumFor('agent'), {json_value: {fields: []}}],
]) {
  test(`${name} is skipped, because anyone can write to the contract`, async () => {
    const {get} = getFrom({
      '/txs/t4/redeemers': [{purpose: 'spend', tx_index: 0, redeemer_data_hash: 'r'}],
      '/txs/t4/utxos': {inputs: [input('aa', 0)]},
      '/scripts/datum/datum-aa': datum,
      '/scripts/datum/r': redeemer,
    });

    assert.deepEqual(await spendsOf({get, txHash: 't4'}), []);
  });
}

test('only a final step counts toward a record', () => {
  const records = tally([
    {agentIdentifier: 'a', action: 0},
    {agentIdentifier: 'a', action: 0},
    {agentIdentifier: 'a', action: 3},
    {agentIdentifier: 'a', action: 5},
    {agentIdentifier: 'a', action: 6},
    {agentIdentifier: 'b', action: 4},
  ]);

  assert.deepEqual(records, {
    a: {completed: 2, refunded: 1, disputed: 0},
    b: {completed: 0, refunded: 0, disputed: 1},
  });
});

test('pages are read until the limit, or until one comes back short', async () => {
  const page = (start, count) => Array.from({length: count}, (_, index) => ({tx_hash: `t${start + index}`}));
  const path = (number) => `/addresses/${ESCROW_CONTRACT}/transactions?order=desc&count=100&page=${number}`;
  const {get, calls} = getFrom({[path(1)]: page(0, 100), [path(2)]: page(100, 40)});

  const hashes = await recentTransactions({get});

  assert.equal(hashes.length, 140);
  assert.equal(calls.length, 2);
  assert.equal((await recentTransactions({get, limit: 5})).length, 5);
});

test('a transaction already read is not read again, and still counts', async () => {
  const path = `/addresses/${ESCROW_CONTRACT}/transactions?order=desc&count=100&page=1`;
  const {get, calls} = getFrom({
    [path]: [{tx_hash: 'old'}, {tx_hash: 'new'}],
    '/txs/new/redeemers': [{purpose: 'spend', tx_index: 0, redeemer_data_hash: 'withdraw'}],
    '/txs/new/utxos': {inputs: [input('aa', 0)]},
    '/scripts/datum/datum-aa': datumFor('agent'),
    '/scripts/datum/withdraw': WITHDRAW,
  });

  const {records, cache} = await buildTrackRecords({get, cache: {old: [{agentIdentifier: 'agent', action: 3}]}});

  assert.deepEqual(records, {agent: {completed: 1, refunded: 1, disputed: 0}});
  assert.ok(!calls.includes('/txs/old/redeemers'));
  assert.deepEqual(Object.keys(cache).sort(), ['new', 'old']);
});

test('a disputed end is counted apart from a refund', () => {
  assert.deepEqual(tally([{agentIdentifier: 'a', action: DISPUTED.json_value.constructor}, {agentIdentifier: 'a', action: SUBMIT_RESULT.json_value.constructor}]), {
    a: {completed: 0, refunded: 0, disputed: 1},
  });
});
