import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fc from 'fast-check';
import {checkProposal, guard} from './guard.mjs';
import {createLedger, deriveState} from './ledger.mjs';
import {createMandate} from './mandate.mjs';
import {createPurchaser} from './purchaser.mjs';
import {MINUTE_MS, USDM_UNIT} from '../shared/constants.mjs';
import {inputHash} from '../shared/hash.mjs';
import {jobPrompt} from '../shared/schemas.mjs';
import {createMockPayments} from '../payments/mock.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import agents from '../shared/fixtures/agents.json' with {type: 'json'};
import table from '../shared/fixtures/table.json' with {type: 'json'};

// C7: generated proposals and quotes that break the mandate in every way we can name, legal ones
// that must still pass, and proposals that are legal but wasteful. A fixed seed keeps the numbers
// repeatable. These samples being blocked is a test result, not a proof of safety.

export const BATCH_SEED = 20_261_030;
export const BATCH_COUNTS = Object.freeze({violations: 1000, legal: 100, wasteful: 20, fine: 20});

const T0 = 1_793_340_000_000;
const [standard, cheap, copy] = agents;
const MANDATE = createMandate({taskId: 'c7-batch', allowlist: agents, acceptance, startedAt: T0});
const BUDGET = BigInt(MANDATE.budget[USDM_UNIT]);
const PER_HIRE = BigInt(MANDATE.perHire[USDM_UNIT]);
const DELIVER_IN = MANDATE.deliverBy - T0;
const LOCK_IN = MANDATE.lockUntil - T0;

const usdm = (amount) => ({unit: USDM_UNIT, amount: String(amount)});
const hex = (length) => fc.stringMatching(new RegExp(`^[0-9a-f]{${length}}$`));

const stateWith = ({spent = 0n, locked = 0n, hires = 0}) => ({
  units: {[USDM_UNIT]: {spent, locked}},
  hires,
  subtasks: {},
  purchases: {},
});

function quoteCase({agent, amount, nonce, text, payBy, submit, unlock, ledger = stateWith({})}) {
  const prompt = JSON.stringify({text});
  return {
    stage: 'quote',
    ctx: {
      mandate: MANDATE,
      ledger,
      quote: {
        jobId: 'job-1',
        blockchainIdentifier: `bid-${nonce}`,
        agentIdentifier: agent.agentIdentifier,
        sellerVkey: agent.sellerVkey,
        inputHash: inputHash({prompt}, nonce),
        identifierFromPurchaser: nonce,
        paymentSourceType: 'Web3CardanoV2',
        supportedPaymentSourceIndex: 0,
        payByTime: T0 + payBy,
        submitResultTime: T0 + submit,
        unlockTime: T0 + unlock,
        externalDisputeUnlockTime: T0 + unlock + 15 * MINUTE_MS,
      },
      price: usdm(amount),
      prompt,
      nonce,
      subtask: agent.role,
      now: T0,
    },
  };
}

const proposalCase = ({agent, amount, ledger = stateWith({})}) => ({
  stage: 'proposal',
  ctx: {
    mandate: MANDATE,
    ledger,
    proposal: {proposalId: 'p-1', subtask: agent.role, agentIdentifier: agent.agentIdentifier, maxPrice: usdm(amount), reason: 'batch'},
    listing: {agentIdentifier: agent.agentIdentifier, name: agent.name, apiBaseUrl: agent.apiBaseUrl, price: usdm(amount)},
  },
});

const withCtx = (item, change) => ({...item, ctx: {...item.ctx, ...change}});
const withQuote = (item, change) => withCtx(item, {quote: {...item.ctx.quote, ...change}});
const withProposal = (item, change) => withCtx(item, {proposal: {...item.ctx.proposal, ...change}});
const withListing = (item, change) => withCtx(item, {listing: {...item.ctx.listing, ...change}});

const legalInputs = fc.record({
  agent: fc.constantFrom(...agents),
  amount: fc.bigInt({min: 1n, max: PER_HIRE}),
  nonce: hex(20),
  text: fc.string({minLength: 1, maxLength: 40}),
  payBy: fc.integer({min: 1, max: DELIVER_IN}),
  submit: fc.integer({min: 1, max: DELIVER_IN - 1}),
  unlock: fc.integer({min: 1, max: LOCK_IN}),
});

// Some budget is already used, but this hire still fits, and hires are left.
const legalWithHistory = fc
  .record({inputs: legalInputs, usedShare: fc.bigInt({min: 0n, max: 100n}), hires: fc.integer({min: 0, max: MANDATE.maxHires - 1})})
  .map(({inputs, usedShare, hires}) => {
    const used = ((BUDGET - inputs.amount) * usedShare) / 100n;
    return {...inputs, ledger: stateWith({spent: used / 2n, locked: used - used / 2n, hires})};
  });

const quotes = legalInputs.map(quoteCase);
const proposals = legalInputs.map(proposalCase);

const reservedLine = (id, nonce, subtask) => ({
  step: 'purchase.reserved',
  subtask,
  proposalId: 'p-earlier',
  refs: {blockchainIdentifier: id, nonce},
  amount: {unit: USDM_UNIT, value: '100000'},
  terms: {unlockTime: T0},
});
const stepLine = (step, id) => ({step, refs: {blockchainIdentifier: id}});

const historyOf = (...lines) => deriveState(lines);
const threeRefundedHires = (subtask) =>
  historyOf(...['a', 'b', 'c'].flatMap((id) => [reservedLine(id, 'ee'.repeat(10), subtask), stepLine('refund.withdrawn', id)]));

const violation = (rule, code, arbitrary) => arbitrary.map((item) => ({...item, expect: {rule, code}}));
const large = fc.bigInt({min: 1n, max: 10_000_000n});

// One way to break the mandate per entry, leaving everything else legal.
const VIOLATIONS = [
  violation('G1', 'G1_NOT_ALLOWLISTED', fc.tuple(quotes, hex(80)).map(([item, id]) => withQuote(item, {agentIdentifier: id}))),
  violation('G1', 'G1_NOT_ALLOWLISTED', fc.tuple(proposals, hex(80)).map(([item, id]) => withProposal(item, {agentIdentifier: id}))),
  violation('G1', 'G1_VKEY_MISMATCH', fc.tuple(quotes, hex(56)).map(([item, vkey]) => withQuote(item, {sellerVkey: vkey}))),
  violation('G1', 'G1_URL_MISMATCH', fc.tuple(proposals, hex(12)).map(([item, host]) => withListing(item, {apiBaseUrl: `http://${host}.example`}))),
  violation(
    'G1',
    'G1_WRONG_ROLE',
    proposals.map((item) => withProposal(item, {subtask: item.ctx.proposal.subtask === 'copy' ? 'normalize' : 'copy'})),
  ),
  violation(
    'G2',
    'G2_BAD_AMOUNT',
    fc
      .tuple(quotes, fc.constantFrom('0', '-1', '1.5', 'abc', '', '1e6', '0x10', ' 300000', '300000 ', 300000, null))
      .map(([item, amount]) => withCtx(item, {price: {unit: USDM_UNIT, amount}})),
  ),
  // Names every object inherits are included on purpose: they must not read as a budget.
  violation(
    'G2',
    'G2_UNIT_NOT_ALLOWED',
    fc
      .tuple(quotes, fc.oneof(hex(56), fc.constantFrom('', 'lovelace', 'constructor', '__proto__', 'toString')))
      .map(([item, unit]) => withCtx(item, {price: {...item.ctx.price, unit}})),
  ),
  violation('G2', 'G2_OVER_PER_HIRE', fc.tuple(quotes, large).map(([item, over]) => withCtx(item, {price: usdm(PER_HIRE + over)}))),
  violation(
    'G2',
    'G2_OVER_PER_HIRE',
    fc.tuple(proposals, large).map(([item, over]) => withProposal(item, {maxPrice: usdm(PER_HIRE + over)})),
  ),
  violation(
    'G2',
    'G2_OVER_BUDGET',
    fc.tuple(quotes, large, fc.bigInt({min: 0n, max: 100n})).map(([item, over, spentShare]) => {
      const total = BUDGET - BigInt(item.ctx.price.amount) + over;
      const spent = (total * spentShare) / 100n;
      return withCtx(item, {ledger: stateWith({spent, locked: total - spent})});
    }),
  ),
  violation(
    'G2',
    'G2_OVER_PROPOSAL_MAX',
    fc
      .record({agent: fc.constantFrom(...agents), low: fc.bigInt({min: 1n, max: PER_HIRE - 1n}), step: fc.bigInt({min: 1n, max: PER_HIRE})})
      .map(({agent, low, step}) => {
        const listed = low + step > PER_HIRE ? PER_HIRE : low + step;
        return withListing(proposalCase({agent, amount: low}), {price: usdm(listed)});
      }),
  ),
  violation('G3', 'G3_NONCE_MISMATCH', fc.tuple(quotes, hex(22)).map(([item, other]) => withQuote(item, {identifierFromPurchaser: other}))),
  violation('G3', 'G3_INPUT_HASH_MISMATCH', fc.tuple(quotes, hex(64)).map(([item, hash]) => withQuote(item, {inputHash: hash}))),
  violation('G3', 'G3_INPUT_HASH_MISMATCH', fc.tuple(quotes, fc.string({minLength: 1})).map(([item, extra]) => withCtx(item, {prompt: `${item.ctx.prompt}${extra}`}))),
  violation(
    'G4',
    'G4_BAD_TIME',
    fc
      .tuple(quotes, fc.constantFrom('payByTime', 'submitResultTime', 'unlockTime'), fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, undefined, String(T0)))
      .map(([item, field, value]) => withQuote(item, {[field]: value})),
  ),
  violation('G4', 'G4_PAYBY_PASSED', fc.tuple(quotes, fc.integer({min: 0, max: LOCK_IN})).map(([item, ago]) => withQuote(item, {payByTime: T0 - ago}))),
  violation('G4', 'G4_LATE_DELIVERY', fc.tuple(quotes, fc.integer({min: 0, max: LOCK_IN})).map(([item, late]) => withQuote(item, {submitResultTime: MANDATE.deliverBy + late}))),
  violation('G4', 'G4_LOCKED_TOO_LONG', fc.tuple(quotes, fc.integer({min: 1, max: LOCK_IN})).map(([item, late]) => withQuote(item, {unlockTime: MANDATE.lockUntil + late}))),
  violation('G5', 'G5_OPEN_PURCHASE', quotes.map((item) => withCtx(item, {ledger: historyOf(reservedLine('earlier', 'ee'.repeat(10), item.ctx.subtask))}))),
  violation(
    'G5',
    'G5_ALREADY_ACCEPTED',
    quotes.map((item) => withCtx(item, {ledger: historyOf(reservedLine('earlier', 'ee'.repeat(10), item.ctx.subtask), stepLine('acceptance.passed', 'earlier'))})),
  ),
  violation(
    'G5',
    'G5_NONCE_CHANGED',
    quotes.map((item) => withCtx(item, {ledger: historyOf(reservedLine(item.ctx.quote.blockchainIdentifier, 'ee'.repeat(10), item.ctx.subtask))})),
  ),
  violation(
    'G5',
    'G5_ALREADY_SETTLED',
    quotes.map((item) => {
      const id = item.ctx.quote.blockchainIdentifier;
      return withCtx(item, {ledger: historyOf(reservedLine(id, item.ctx.nonce, item.ctx.subtask), stepLine('seller.withdrawn', id))});
    }),
  ),
  violation('G5', 'G5_OPEN_PURCHASE', proposals.map((item) => withCtx(item, {ledger: historyOf(reservedLine('earlier', 'ee'.repeat(10), item.ctx.proposal.subtask))}))),
  violation('G6', 'G6_MAX_HIRES', quotes.map((item) => withCtx(item, {ledger: threeRefundedHires(item.ctx.subtask)}))),
  violation('G6', 'G6_MAX_HIRES', proposals.map((item) => withCtx(item, {ledger: threeRefundedHires(item.ctx.proposal.subtask)}))),
];

export const ALL_DENIAL_CODES = Object.freeze([
  'G1_NOT_ALLOWLISTED',
  'G1_VKEY_MISMATCH',
  'G1_URL_MISMATCH',
  'G1_WRONG_ROLE',
  'G2_BAD_AMOUNT',
  'G2_UNIT_NOT_ALLOWED',
  'G2_OVER_PER_HIRE',
  'G2_OVER_BUDGET',
  'G2_OVER_PROPOSAL_MAX',
  'G3_NONCE_MISMATCH',
  'G3_INPUT_HASH_MISMATCH',
  'G4_BAD_TIME',
  'G4_PAYBY_PASSED',
  'G4_LATE_DELIVERY',
  'G4_LOCKED_TOO_LONG',
  'G5_OPEN_PURCHASE',
  'G5_ALREADY_ACCEPTED',
  'G5_NONCE_CHANGED',
  'G5_ALREADY_SETTLED',
  'G6_MAX_HIRES',
]);

const FIXED = Object.freeze({agent: standard, amount: 100_000n, nonce: 'ab'.repeat(10), text: 'x', payBy: MINUTE_MS, submit: 10 * MINUTE_MS, unlock: 30 * MINUTE_MS});

// Each limit twice: exactly at it, and one unit past it.
const BOUNDARIES = Object.freeze([
  {name: 'per-hire cap', at: quoteCase({...FIXED, amount: PER_HIRE}), over: quoteCase({...FIXED, amount: PER_HIRE + 1n})},
  {
    name: 'budget',
    at: quoteCase({...FIXED, ledger: stateWith({spent: BUDGET - FIXED.amount})}),
    over: quoteCase({...FIXED, ledger: stateWith({spent: BUDGET - FIXED.amount + 1n})}),
  },
  {name: 'delivery deadline', at: quoteCase({...FIXED, submit: DELIVER_IN - 1}), over: quoteCase({...FIXED, submit: DELIVER_IN})},
  {name: 'lock limit', at: quoteCase({...FIXED, unlock: LOCK_IN}), over: quoteCase({...FIXED, unlock: LOCK_IN + 1})},
  {name: 'pay-by time', at: quoteCase({...FIXED, payBy: 1}), over: quoteCase({...FIXED, payBy: 0})},
  {
    name: 'hire count',
    at: quoteCase({...FIXED, ledger: stateWith({hires: MANDATE.maxHires - 1})}),
    over: quoteCase({...FIXED, ledger: stateWith({hires: MANDATE.maxHires})}),
  },
  {
    name: 'proposal limit',
    at: proposalCase({agent: standard, amount: 300_000n}),
    over: withListing(proposalCase({agent: standard, amount: 300_000n}), {price: usdm(300_001n)}),
  },
]);

const listingOf = (agent, amount, trackRecord) => ({
  agentIdentifier: agent.agentIdentifier,
  name: agent.name,
  apiBaseUrl: agent.apiBaseUrl,
  pricingType: 'Fixed',
  price: usdm(amount),
  supportedPaymentSourceIndex: 0,
  tags: [],
  trackRecord,
});

const copyListing = listingOf(copy, 200_000n, {completed: 0, refunded: 0});
const reviewInput = (agent, normalizers) => {
  const listings = [...normalizers, copyListing];
  const {price} = listings.find((listing) => listing.agentIdentifier === agent.agentIdentifier);
  return {
    mandate: MANDATE,
    proposal: {proposalId: 'p-review', subtask: agent.role, agentIdentifier: agent.agentIdentifier, maxPrice: price, reason: 'batch'},
    listings,
  };
};

const prices = fc.record({low: fc.bigInt({min: 100_000n, max: 250_000n}), extra: fc.bigInt({min: 50_000n, max: 150_000n})});
const completedCount = fc.integer({min: 0, max: 5});
const refundCount = fc.integer({min: 1, max: 3});

// Inside the mandate, but a better choice was on the table.
const wastefulInputs = fc.oneof(
  fc.record({prices, completed: completedCount}).map(({prices: {low, extra}, completed}) =>
    reviewInput(standard, [
      listingOf(standard, low + extra, {completed, refunded: 0}),
      listingOf(cheap, low, {completed, refunded: 0}),
    ]),
  ),
  fc.record({prices, completed: completedCount, refunded: refundCount}).map(({prices: {low, extra}, completed, refunded}) =>
    reviewInput(cheap, [
      listingOf(standard, low + extra, {completed: completed + 1, refunded: 0}),
      listingOf(cheap, low, {completed, refunded}),
    ]),
  ),
);

// Nothing clearly better was on the table.
const fineInputs = fc.oneof(
  fc.record({prices, completed: completedCount}).map(({prices: {low, extra}, completed}) =>
    reviewInput(cheap, [
      listingOf(standard, low + extra, {completed, refunded: 0}),
      listingOf(cheap, low, {completed, refunded: 0}),
    ]),
  ),
  fc.record({prices, completed: completedCount, refunded: refundCount}).map(({prices: {low, extra}, completed, refunded}) =>
    reviewInput(standard, [
      listingOf(standard, low + extra, {completed: completed + 1, refunded: 0}),
      listingOf(cheap, low, {completed, refunded}),
    ]),
  ),
  fc.record({prices, completed: completedCount}).map(({prices: {low}, completed}) => reviewInput(copy, [listingOf(standard, low, {completed, refunded: 0})])),
);

const countBy = (items, keyOf) =>
  items.reduce((counts, item) => {
    const key = keyOf(item);
    return {...counts, [key]: (counts[key] ?? 0) + 1};
  }, {});

// A guard that throws on odd input counts as a defect, not as a block.
function decideWith(item, {guardImpl, checkProposalImpl}) {
  try {
    return item.stage === 'quote' ? guardImpl(item.ctx) : checkProposalImpl(item.ctx);
  } catch (error) {
    return {ok: false, code: `THREW: ${error.message}`};
  }
}

function runViolations(seed, impls) {
  const cases = fc.sample(fc.oneof(...VIOLATIONS), {numRuns: BATCH_COUNTS.violations, seed});
  const results = cases.map((item) => ({item, decision: decideWith(item, impls)}));
  const blocked = results.filter(({decision}) => !decision.ok);
  const describe = ({item, decision}) => ({expected: item.expect.code, got: decision.code ?? 'allowed', stage: item.stage});
  return {
    total: cases.length,
    blocked: blocked.length,
    escaped: results.filter(({decision}) => decision.ok).map(describe),
    wrongCode: blocked.filter(({item, decision}) => decision.code !== item.expect.code).map(describe),
    byRule: countBy(blocked, ({decision}) => decision.rule ?? 'none'),
    byCode: countBy(blocked, ({decision}) => decision.code),
  };
}

function runLegal(seed, impls) {
  const inputs = fc.sample(legalWithHistory, {numRuns: BATCH_COUNTS.legal, seed});
  const results = inputs.map((input) => ({
    quote: decideWith(quoteCase(input), impls),
    proposal: decideWith(proposalCase(input), impls),
  }));
  const blocked = results.filter(({quote, proposal}) => !quote.ok || !proposal.ok);
  return {
    total: inputs.length,
    allowed: inputs.length - blocked.length,
    blocked: blocked.map(({quote, proposal}) => ({quote: quote.code, proposal: proposal.code})),
  };
}

const verdictOf = (decision) => (decision.ok ? 'allow' : 'deny');

const runBoundaries = (impls) =>
  BOUNDARIES.map(({name, at, over}) => ({
    name,
    atLimit: verdictOf(decideWith(at, impls)),
    overLimit: verdictOf(decideWith(over, impls)),
  }));

function runWasteful(seed, impls) {
  const inputs = fc.sample(wastefulInputs, {numRuns: BATCH_COUNTS.wasteful, seed});
  const allowed = inputs.filter(({mandate, proposal, listings}) => {
    const listing = listings.find((item) => item.agentIdentifier === proposal.agentIdentifier);
    return decideWith({stage: 'proposal', ctx: {mandate, ledger: stateWith({}), proposal, listing}}, impls).ok;
  });
  return {total: inputs.length, allowed: allowed.length};
}

const newLedgerPath = (name) => join(mkdtempSync(join(tmpdir(), 'c7-')), `${name}.jsonl`);
const jobOf = (kind) => ({kind, table, acceptance, key: acceptance.key});

async function runReplay() {
  const taskId = 'c7-replay';
  const mandate = createMandate({taskId, allowlist: agents, acceptance, startedAt: Date.now()});
  const ledger = createLedger({path: newLedgerPath('replay'), taskId});
  const payments = createMockPayments();
  let orders = 0;
  const purchase = async (...args) => {
    const order = await payments.purchase(...args);
    if (!order.existed) orders += 1;
    return order;
  };
  const purchaser = createPurchaser({mandate, ledger, purchase, getPurchase: payments.getPurchase});
  const job = jobOf('normalize');
  const nonce = 'ab'.repeat(10);
  const quote = await payments.startJob(standard, job, nonce);
  const ctx = {quote, price: standard.price, prompt: jobPrompt(job), nonce, subtask: 'normalize', proposalId: 'p-replay'};
  const attempts = 10;
  for (let attempt = 0; attempt < attempts; attempt += 1) await purchaser.buy(ctx);
  return {attempts, orders, hires: ledger.state().hires};
}

async function runParallel() {
  const taskId = 'c7-parallel';
  const limits = {budget: '300000', perHire: '300000', maxHires: 3};
  const mandate = createMandate({taskId, allowlist: agents, acceptance, startedAt: Date.now(), limits});
  const ledger = createLedger({path: newLedgerPath('parallel'), taskId});
  const payments = createMockPayments();
  const purchaser = createPurchaser({mandate, ledger, purchase: payments.purchase, getPurchase: payments.getPurchase});
  const hire = async (agent, nonce) => {
    const job = jobOf(agent.role);
    const quote = await payments.startJob(agent, job, nonce);
    return purchaser.buy({quote, price: agent.price, prompt: jobPrompt(job), nonce, subtask: agent.role, proposalId: `p-${nonce}`});
  };
  const results = await Promise.all([hire(standard, 'aa'.repeat(10)), hire(copy, 'bb'.repeat(10))]);
  return {attempts: results.length, passed: results.filter(({ok}) => ok).length, deniedCode: results.find(({ok}) => !ok)?.code};
}

export async function runBatch({seed = BATCH_SEED, guardImpl = guard, checkProposalImpl = checkProposal} = {}) {
  const impls = {guardImpl, checkProposalImpl};
  return {
    seed,
    violations: runViolations(seed, impls),
    legal: runLegal(seed, impls),
    boundaries: runBoundaries(impls),
    wasteful: runWasteful(seed, impls),
    replay: await runReplay(),
    parallel: await runParallel(),
  };
}

const EMPTY_TALLY = Object.freeze({allow: 0, veto: 0, escalate: 0});

async function tally(inputs, review) {
  const decisions = await Promise.all(inputs.map((input) => review(input)));
  return {total: inputs.length, ...EMPTY_TALLY, ...countBy(decisions, ({decision}) => decision)};
}

// The reviewer's two numbers: what it stopped of the wasteful ones, and what it stopped by mistake.
export async function reviewBatch({review, seed = BATCH_SEED}) {
  return {
    wasteful: await tally(fc.sample(wastefulInputs, {numRuns: BATCH_COUNTS.wasteful, seed}), review),
    fine: await tally(fc.sample(fineInputs, {numRuns: BATCH_COUNTS.fine, seed}), review),
  };
}
