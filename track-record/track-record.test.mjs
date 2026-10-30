import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTrackRecords, spendsOf, tally, unreadTransactions} from './track-record.mjs';
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

const page = (start, count) => Array.from({length: count}, (_, index) => ({tx_hash: `t${start + index}`}));
const pagePath = (number) => `/addresses/${ESCROW_CONTRACT}/transactions?order=desc&count=100&page=${number}`;

test('pages are read until one comes back short', async () => {
  const {get, calls} = getFrom({[pagePath(1)]: page(0, 100), [pagePath(2)]: page(100, 40)});

  const {hashes, truncated} = await unreadTransactions({get});

  assert.equal(hashes.length, 140);
  assert.equal(truncated, false);
  assert.equal(calls.length, 2);
});

test('reading stops at the first transaction already known, because everything older was read before', async () => {
  const {get, calls} = getFrom({[pagePath(1)]: page(0, 100), [pagePath(2)]: page(100, 100)});

  const {hashes} = await unreadTransactions({get, cache: {t130: []}});

  assert.equal(hashes.length, 130);
  assert.equal(calls.length, 2);
});

test('the first read has a limit, and says when it cut something off', async () => {
  const {get} = getFrom({[pagePath(1)]: page(0, 100), [pagePath(2)]: page(100, 100)});

  const {hashes, truncated} = await unreadTransactions({get, limit: 150});

  assert.equal(hashes.length, 150);
  assert.equal(truncated, true);
});

test('later reads have no limit, or they would leave a gap that is never read', async () => {
  const {get} = getFrom({[pagePath(1)]: page(0, 100), [pagePath(2)]: page(100, 100), [pagePath(3)]: page(200, 10)});

  const {hashes, truncated} = await unreadTransactions({get, cache: {t205: []}, limit: 150});

  assert.equal(hashes.length, 205);
  assert.equal(truncated, false);
});

test('a refund stays on an agent’s record after it falls outside the newest transactions', async () => {
  const {get} = getFrom({[pagePath(1)]: [{tx_hash: 'new'}, {tx_hash: 'kept'}], '/txs/new/redeemers': []});
  const cache = {kept: [], old: [{agentIdentifier: 'agent', action: 3}]};

  const {records} = await buildTrackRecords({get, cache});

  assert.deepEqual(records, {agent: {completed: 0, refunded: 1, disputed: 0}});
});

test('a record kept from before empty ids were skipped does not count', () => {
  assert.deepEqual(tally([{agentIdentifier: '', action: 0}]), {});
});

test('a transaction already read is not read again, and still counts', async () => {
  const {get, calls} = getFrom({
    [pagePath(1)]: [{tx_hash: 'new'}, {tx_hash: 'old'}],
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
