import test from 'node:test';
import assert from 'node:assert/strict';
import {checkProposal, guard} from './guard.mjs';
import {inputHash} from '../shared/hash.mjs';
import {MINUTE_MS, USDM_UNIT} from '../shared/constants.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import agents from '../shared/fixtures/agents.json' with {type: 'json'};

const T0 = 1_793_340_000_000;
const [standard, cheap, copy] = agents;
const nonce = 'ab'.repeat(10);
const otherNonce = 'cd'.repeat(10);
const prompt = JSON.stringify({kind: 'normalize', table: [{sku: 'HM-001'}], key: 'sku'});
const tusdm = (amount) => ({unit: USDM_UNIT, amount: String(amount)});

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

const quote = (overrides = {}) => ({
  jobId: 'job-1',
  blockchainIdentifier: 'bid-1',
  agentIdentifier: standard.agentIdentifier,
  sellerVkey: standard.sellerVkey,
  inputHash: inputHash({prompt}, nonce),
  identifierFromPurchaser: nonce,
  paymentSourceType: 'Web3CardanoV2',
  supportedPaymentSourceIndex: 0,
  payByTime: T0 + 8 * MINUTE_MS,
  submitResultTime: T0 + 17 * MINUTE_MS,
  unlockTime: T0 + 32 * MINUTE_MS,
  externalDisputeUnlockTime: T0 + 47 * MINUTE_MS,
  ...overrides,
});

const ledger = ({spent = 0n, locked = 0n, hires = 0, subtasks = {}, purchases = {}} = {}) => ({
  units: {[USDM_UNIT]: {spent, locked}},
  hires,
  subtasks,
  purchases,
});

const ctx = (overrides = {}) => ({
  mandate,
  ledger: ledger(),
  quote: quote(),
  price: tusdm(300000),
  prompt,
  nonce,
  subtask: 'normalize',
  now: T0,
  ...overrides,
});

const assertDenied = (decision, rule, code) => {
  assert.equal(decision.ok, false, JSON.stringify(decision));
  assert.equal(decision.rule, rule);
  assert.equal(decision.code, code);
  assert.ok(decision.reason.length > 0);
};

test('allows a quote that respects every rule', () => {
  assert.deepEqual(guard(ctx()), {ok: true, retry: false});
});

test('G1 denies an agent outside the allowlist', () => {
  const decision = guard(ctx({quote: quote({agentIdentifier: `${standard.agentIdentifier.slice(0, 56)}00ff`})}));
  assertDenied(decision, 'G1', 'G1_NOT_ALLOWLISTED');
});

test('G1 denies a swapped seller key on an allowlisted agent', () => {
  assertDenied(guard(ctx({quote: quote({sellerVkey: 'ff'.repeat(28)})})), 'G1', 'G1_VKEY_MISMATCH');
});

test('G2 allows the documented case: 0.3 with 0.2 already locked', () => {
  assert.equal(guard(ctx({ledger: ledger({locked: 200000n, hires: 1})})).ok, true);
});

test('G2 denies an asset that has no budget', () => {
  assertDenied(guard(ctx({price: {unit: '', amount: '300000'}})), 'G2', 'G2_UNIT_NOT_ALLOWED');
});

test('G2 denies a price above the per-hire cap and allows exactly the cap', () => {
  assert.equal(guard(ctx({price: tusdm(400000)})).ok, true);
  assertDenied(guard(ctx({price: tusdm(400001)})), 'G2', 'G2_OVER_PER_HIRE');
});

test('G2 counts spent plus locked plus this price against the budget', () => {
  const full = ledger({spent: 300000n, locked: 300000n, hires: 2});
  assertDenied(guard(ctx({ledger: full})), 'G2', 'G2_OVER_BUDGET');
  const exact = ledger({spent: 300000n, locked: 200000n, hires: 2});
  assert.equal(guard(ctx({ledger: exact})).ok, true);
});

test('G2 denies amounts that are not positive integers', () => {
  for (const amount of ['0', '-1', '0.3', 'abc', '']) {
    assertDenied(guard(ctx({price: {unit: USDM_UNIT, amount}})), 'G2', 'G2_BAD_AMOUNT');
  }
});

test('G3 denies a quote bound to another input', () => {
  assertDenied(guard(ctx({quote: quote({inputHash: 'ee'.repeat(32)})})), 'G3', 'G3_INPUT_HASH_MISMATCH');
});

test('G3 denies a quote that echoes another purchaser nonce', () => {
  assertDenied(guard(ctx({quote: quote({identifierFromPurchaser: otherNonce})})), 'G3', 'G3_NONCE_MISMATCH');
});

test('G4 requires delivery strictly before deliverBy', () => {
  assertDenied(guard(ctx({quote: quote({submitResultTime: mandate.deliverBy})})), 'G4', 'G4_LATE_DELIVERY');
  assertDenied(guard(ctx({quote: quote({submitResultTime: mandate.deliverBy + 1000})})), 'G4', 'G4_LATE_DELIVERY');
  assert.equal(guard(ctx({quote: quote({submitResultTime: mandate.deliverBy - 1})})).ok, true);
});

test('G4 allows unlock exactly at lockUntil and denies one millisecond later', () => {
  assert.equal(guard(ctx({quote: quote({unlockTime: mandate.lockUntil})})).ok, true);
  assertDenied(guard(ctx({quote: quote({unlockTime: mandate.lockUntil + 1})})), 'G4', 'G4_LOCKED_TOO_LONG');
});

test('G4 denies a quote whose pay-by time has passed or whose times are unusable', () => {
  assertDenied(guard(ctx({now: T0 + 8 * MINUTE_MS})), 'G4', 'G4_PAYBY_PASSED');
  assertDenied(guard(ctx({quote: quote({unlockTime: Number.NaN})})), 'G4', 'G4_BAD_TIME');
});

const openPurchase = {'bid-1': {nonce, subtask: 'normalize', status: 'funds_locked'}};
const openSubtask = {normalize: {status: 'open', blockchainIdentifier: 'bid-1'}};

test('G5 denies a second purchase while the subtask has one with no verdict', () => {
  const state = ledger({locked: 300000n, hires: 1, subtasks: openSubtask, purchases: openPurchase});
  const decision = guard(ctx({ledger: state, quote: quote({blockchainIdentifier: 'bid-2'})}));
  assertDenied(decision, 'G5', 'G5_OPEN_PURCHASE');
});

test('G5 treats the same identifier and nonce as a retry that reserves nothing new', () => {
  const state = ledger({locked: 300000n, hires: 3, subtasks: openSubtask, purchases: openPurchase});
  assert.deepEqual(guard(ctx({ledger: state})), {ok: true, retry: true});
});

test('G5 denies a retry that changed the nonce', () => {
  const state = ledger({locked: 300000n, hires: 1, subtasks: openSubtask, purchases: openPurchase});
  const changed = quote({identifierFromPurchaser: otherNonce, inputHash: inputHash({prompt}, otherNonce)});
  assertDenied(guard(ctx({ledger: state, quote: changed, nonce: otherNonce})), 'G5', 'G5_NONCE_CHANGED');
});

test('G5 allows hiring again after the previous purchase failed acceptance, money still reserved', () => {
  const state = ledger({
    locked: 200000n,
    hires: 1,
    subtasks: {normalize: {status: 'failed', blockchainIdentifier: 'bid-1'}},
    purchases: {'bid-1': {nonce, subtask: 'normalize', status: 'refund_requested'}},
  });
  assert.equal(guard(ctx({ledger: state, quote: quote({blockchainIdentifier: 'bid-2'})})).ok, true);
});

test('G5 denies paying again for a subtask that already passed acceptance', () => {
  const state = ledger({
    locked: 300000n,
    hires: 1,
    subtasks: {normalize: {status: 'accepted', blockchainIdentifier: 'bid-1'}},
    purchases: {'bid-1': {nonce, subtask: 'normalize', status: 'accepted'}},
  });
  const decision = guard(ctx({ledger: state, quote: quote({blockchainIdentifier: 'bid-2'})}));
  assertDenied(decision, 'G5', 'G5_ALREADY_ACCEPTED');
});

test('G6 allows the last hire and denies one more, even with budget left', () => {
  assert.equal(guard(ctx({ledger: ledger({hires: 2})})).ok, true);
  assertDenied(guard(ctx({ledger: ledger({hires: 3})})), 'G6', 'G6_MAX_HIRES');
});

const proposal = (overrides = {}) => ({
  proposalId: 'p1',
  subtask: 'normalize',
  agentIdentifier: standard.agentIdentifier,
  maxPrice: tusdm(300000),
  reason: 'clean record',
  ...overrides,
});
const proposalCtx = (overrides = {}) => ({mandate, ledger: ledger(), proposal: proposal(), listing: standard, ...overrides});

test('checkProposal allows an allowlisted agent at a listed price within limits', () => {
  assert.deepEqual(checkProposal(proposalCtx()), {ok: true});
});

test('checkProposal stops data going to an agent outside the allowlist', () => {
  const stranger = {...standard, agentIdentifier: `${standard.agentIdentifier.slice(0, 56)}00ff`};
  const decision = checkProposal(proposalCtx({proposal: proposal({agentIdentifier: stranger.agentIdentifier}), listing: stranger}));
  assertDenied(decision, 'G1', 'G1_NOT_ALLOWLISTED');
});

test('checkProposal stops data going to a URL other than the pinned one', () => {
  const moved = {...standard, apiBaseUrl: 'https://evil.example'};
  assertDenied(checkProposal(proposalCtx({listing: moved})), 'G1', 'G1_URL_MISMATCH');
});

test('checkProposal denies an agent asked to do another role', () => {
  const decision = checkProposal(proposalCtx({proposal: proposal({agentIdentifier: copy.agentIdentifier}), listing: copy}));
  assertDenied(decision, 'G1', 'G1_WRONG_ROLE');
});

test('checkProposal denies the injected 5 tUSDM offer even when the agent is allowlisted', () => {
  assertDenied(checkProposal(proposalCtx({proposal: proposal({maxPrice: tusdm(5000000)})})), 'G2', 'G2_OVER_PER_HIRE');
});

test('checkProposal denies a listed price above what the planner agreed to', () => {
  const decision = checkProposal(proposalCtx({proposal: proposal({maxPrice: tusdm(200000)})}));
  assertDenied(decision, 'G2', 'G2_OVER_PROPOSAL_MAX');
});

test('checkProposal denies when the subtask is already open or hires are used up', () => {
  const open = ledger({locked: 200000n, hires: 1, subtasks: {normalize: {status: 'open', blockchainIdentifier: 'bid-9'}}});
  assertDenied(checkProposal(proposalCtx({ledger: open})), 'G5', 'G5_OPEN_PURCHASE');
  assertDenied(checkProposal(proposalCtx({ledger: ledger({hires: 3})})), 'G6', 'G6_MAX_HIRES');
});

test('checkProposal lets the cheap agent through when it is the one proposed', () => {
  const decision = checkProposal(
    proposalCtx({proposal: proposal({agentIdentifier: cheap.agentIdentifier, maxPrice: tusdm(200000)}), listing: cheap}),
  );
  assert.equal(decision.ok, true);
});

test('a retry skips only the budget checks: key, input and pay-by still apply', () => {
  const state = ledger({locked: 300000n, hires: 3, subtasks: openSubtask, purchases: openPurchase});
  assertDenied(guard(ctx({ledger: state, quote: quote({sellerVkey: 'ff'.repeat(28)})})), 'G1', 'G1_VKEY_MISMATCH');
  assertDenied(guard(ctx({ledger: state, quote: quote({inputHash: 'ee'.repeat(32)})})), 'G3', 'G3_INPUT_HASH_MISMATCH');
  assertDenied(guard(ctx({ledger: state, now: T0 + 8 * MINUTE_MS})), 'G4', 'G4_PAYBY_PASSED');
});

test('a purchase the service rejected earlier is treated as new, not as a retry', () => {
  const state = ledger({
    subtasks: {normalize: {status: 'failed', blockchainIdentifier: 'bid-1'}},
    purchases: {'bid-1': {nonce, subtask: 'normalize', status: 'rejected', settled: true}},
  });
  assert.deepEqual(guard(ctx({ledger: state})), {ok: true, retry: false});
});

test('a purchase that already finished is denied', () => {
  const state = ledger({
    subtasks: {normalize: {status: 'failed', blockchainIdentifier: 'bid-1'}},
    purchases: {'bid-1': {nonce, subtask: 'normalize', status: 'refund_withdrawn', settled: true}},
  });
  assertDenied(guard(ctx({ledger: state})), 'G5', 'G5_ALREADY_SETTLED');
});

test('guard does not mutate the context it receives', () => {
  const input = ctx({ledger: ledger({locked: 200000n, hires: 1, subtasks: openSubtask, purchases: openPurchase})});
  const before = structuredClone(input);
  guard({...input, quote: quote({blockchainIdentifier: 'bid-2'})});
  checkProposal({mandate: input.mandate, ledger: input.ledger, proposal: proposal(), listing: standard});
  assert.deepEqual(input, before);
});
