import test from 'node:test';
import assert from 'node:assert/strict';
import {ALL_DENIAL_CODES, BATCH_COUNTS, reviewBatch, runBatch} from './batch.mjs';

const report = await runBatch();

test('every out-of-mandate case is blocked, by the rule it breaks', () => {
  assert.equal(report.violations.total, BATCH_COUNTS.violations);
  assert.deepEqual(report.violations.escaped, []);
  assert.deepEqual(report.violations.wrongCode, []);
  assert.equal(report.violations.blocked, BATCH_COUNTS.violations);
});

test('every way of breaking the mandate gets tested', () => {
  assert.deepEqual(Object.keys(report.violations.byCode).sort(), [...ALL_DENIAL_CODES].sort());
});

test('the counts are grouped by rule, G1 to G6', () => {
  assert.deepEqual(Object.keys(report.violations.byRule).sort(), ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']);
  const total = Object.values(report.violations.byRule).reduce((sum, count) => sum + count, 0);
  assert.equal(total, BATCH_COUNTS.violations);
});

test('every legal case passes', () => {
  assert.equal(report.legal.total, BATCH_COUNTS.legal);
  assert.deepEqual(report.legal.blocked, []);
  assert.equal(report.legal.allowed, BATCH_COUNTS.legal);
});

test('each limit is exact: at the limit passes, one unit over does not', () => {
  assert.ok(report.boundaries.length >= 6);
  for (const {name, atLimit, overLimit} of report.boundaries) {
    assert.equal(atLimit, 'allow', `${name} at the limit`);
    assert.equal(overLimit, 'deny', `${name} one unit over`);
  }
});

test('legal but wasteful proposals pass the guard, which only judges the mandate', () => {
  assert.equal(report.wasteful.total, BATCH_COUNTS.wasteful);
  assert.equal(report.wasteful.allowed, BATCH_COUNTS.wasteful);
});

test('the same quote replayed ten times makes one order and counts one hire', () => {
  assert.deepEqual(report.replay, {attempts: 10, orders: 1, hires: 1});
});

test('two hires racing for the last of the budget: one passes', () => {
  assert.equal(report.parallel.attempts, 2);
  assert.equal(report.parallel.passed, 1);
  assert.equal(report.parallel.deniedCode, 'G2_OVER_BUDGET');
});

test('the same seed gives the same numbers', async () => {
  const again = await runBatch();

  assert.deepEqual(again.violations.byCode, report.violations.byCode);
});

test('another seed gives other cases and nothing escapes', async () => {
  const other = await runBatch({seed: 7});

  assert.notDeepEqual(other.violations.byCode, report.violations.byCode);
  assert.deepEqual(other.violations.escaped, []);
  assert.deepEqual(other.legal.blocked, []);
});

test('a guard that allows everything fails the batch', async () => {
  const allowAll = () => ({ok: true, retry: false});

  const broken = await runBatch({guardImpl: allowAll, checkProposalImpl: allowAll});

  assert.equal(broken.violations.escaped.length, BATCH_COUNTS.violations);
  assert.ok(broken.boundaries.some(({overLimit}) => overLimit === 'allow'));
});

test('a guard that blocks everything fails the batch too', async () => {
  const denyAll = () => ({ok: false, rule: 'G1', code: 'G1_NOT_ALLOWLISTED', reason: 'no'});

  const broken = await runBatch({guardImpl: denyAll, checkProposalImpl: denyAll});

  assert.equal(broken.legal.allowed, 0);
  assert.ok(broken.boundaries.some(({atLimit}) => atLimit === 'deny'));
});

test('a guard with a wrong limit is caught by the boundaries', async () => {
  const {guard} = await import('./guard.mjs');
  const offByOne = (ctx) => (ctx.price.amount === '400001' ? {ok: true, retry: false} : guard(ctx));

  const broken = await runBatch({guardImpl: offByOne});

  const perHire = broken.boundaries.find(({name}) => name === 'per-hire cap');
  assert.equal(perHire.overLimit, 'allow');
});

test('the reviewer batch counts what it stopped and what it stopped by mistake', async () => {
  const counts = await reviewBatch({review: async () => ({decision: 'veto', reason: 'no'})});

  assert.equal(counts.wasteful.total, 20);
  assert.equal(counts.wasteful.veto, 20);
  assert.equal(counts.fine.total, 20);
  assert.equal(counts.fine.veto, 20);
  assert.equal(counts.fine.allow, 0);
});

test('a reviewer that asks the owner is counted apart', async () => {
  const counts = await reviewBatch({review: async () => ({decision: 'escalate', reason: 'unsure'})});

  assert.equal(counts.wasteful.escalate, 20);
  assert.equal(counts.fine.escalate, 20);
});

test('every case given to the reviewer already passes the guard', async () => {
  const seen = [];
  await reviewBatch({
    review: async (input) => {
      seen.push(input);
      return {decision: 'allow', reason: 'fine'};
    },
  });

  const {checkProposal} = await import('./guard.mjs');
  const {deriveState} = await import('./ledger.mjs');
  assert.equal(seen.length, 40);
  for (const {mandate, proposal, listings} of seen) {
    const listing = listings.find((item) => item.agentIdentifier === proposal.agentIdentifier);
    const decision = checkProposal({mandate, ledger: deriveState([]), proposal, listing});
    assert.equal(decision.ok, true, decision.reason);
  }
});
