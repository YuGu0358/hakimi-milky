import test from 'node:test';
import assert from 'node:assert/strict';
import {orderCounts, verdictOf} from './crash-test.mjs';

const line = (step, id) => ({step, refs: {blockchainIdentifier: id}});
const JOBS = 2;

test('orders are counted per job, so a double purchase shows', () => {
  const counts = orderCounts([line('purchase.reserved', 'a'), line('purchase.created', 'a'), line('purchase.reserved', 'b'), line('purchase.created', 'b'), line('purchase.funds_locked', 'a'), line('purchase.funds_locked', 'b')]);

  assert.deepEqual(counts, {reservations: 2, distinctOrders: 2, locks: 2, doubleLocks: 0});
});

test('a lock seen twice for one order counts as a double', () => {
  assert.equal(orderCounts([line('purchase.reserved', 'a'), line('purchase.funds_locked', 'a'), line('purchase.funds_locked', 'a')]).doubleLocks, 1);
});

test('the test passes only with one order per job, delivered', () => {
  const clean = {reservations: 2, distinctOrders: 2, locks: 2, doubleLocks: 0};

  assert.equal(verdictOf({counts: clean, delivered: true, jobs: JOBS}).passed, true);
  assert.equal(verdictOf({counts: clean, delivered: false, jobs: JOBS}).passed, false);
  assert.equal(verdictOf({counts: {...clean, reservations: 3, distinctOrders: 3}, delivered: true, jobs: JOBS}).passed, false);
  assert.equal(verdictOf({counts: {...clean, doubleLocks: 1}, delivered: true, jobs: JOBS}).passed, false);
});

test('the verdict says what it found', () => {
  const {text} = verdictOf({counts: {reservations: 2, distinctOrders: 2, locks: 2, doubleLocks: 0}, delivered: true, jobs: JOBS});

  assert.match(text, /2 orders for 2 jobs/);
  assert.match(text, /nothing bought twice/);
});
