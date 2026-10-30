import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Mandate,
  Proposal,
  isConfirmed,
  jobPrompt,
  purchaseViewFrom,
  quoteFromStartJob,
} from './schemas.mjs';
import {MAX_PROMPT_CHARS, USDM_UNIT} from './constants.mjs';
import agents from './fixtures/agents.json' with {type: 'json'};
import acceptance from './fixtures/acceptance.json' with {type: 'json'};
import table from './fixtures/table.json' with {type: 'json'};

const startJobResponse = {
  id: 'job-1',
  input_hash: 'ab'.repeat(32),
  identifierFromPurchaser: 'cd'.repeat(10),
  blockchainIdentifier: 'bid-1',
  agentIdentifier: agents[0].agentIdentifier,
  sellerVKey: agents[0].sellerVkey,
  paymentSourceType: 'Web3CardanoV2',
  supportedPaymentSourceIndex: 0,
  payByTime: '1793340480000',
  submitResultTime: 1793341020000,
  unlockTime: 1793341920000,
  externalDisputeUnlockTime: 1793342820000,
};

test('quoteFromStartJob maps the starter response names and normalizes times to numbers', () => {
  const quote = quoteFromStartJob(startJobResponse);
  assert.equal(quote.jobId, 'job-1');
  assert.equal(quote.inputHash, 'ab'.repeat(32));
  assert.equal(quote.sellerVkey, agents[0].sellerVkey);
  assert.equal(quote.payByTime, 1793340480000);
});

test('quoteFromStartJob rejects a response without a blockchain identifier', () => {
  assert.throws(() => quoteFromStartJob({...startJobResponse, blockchainIdentifier: undefined}));
});

test('jobPrompt returns JSON the demo table fits into', () => {
  const prompt = jobPrompt({kind: 'normalize', table, acceptance, key: 'sku'});
  assert.equal(JSON.parse(prompt).table.length, 20);
  assert.ok(prompt.length < MAX_PROMPT_CHARS);
});

test('jobPrompt refuses a prompt the seller API would reject', () => {
  const huge = [{sku: 'x'.repeat(MAX_PROMPT_CHARS)}];
  assert.throws(() => jobPrompt({kind: 'copy', table: huge, acceptance, key: 'sku'}), /limit/);
});

test('Proposal rejects extra fields a hijacked planner might add', () => {
  const proposal = {
    proposalId: 'p1',
    subtask: 'normalize',
    agentIdentifier: agents[0].agentIdentifier,
    maxPrice: {unit: USDM_UNIT, amount: '300000'},
    reason: 'cheapest clean record',
  };
  assert.equal(Proposal.parse(proposal).proposalId, 'p1');
  assert.throws(() => Proposal.parse({...proposal, payTo: 'addr_test1attacker'}));
});

test('Mandate accepts the demo shape and rejects a malformed amount', () => {
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
    deliverBy: 1793342520000,
    lockUntil: 1793343600000,
    acceptance,
    createdAt: 1793340000000,
  };
  assert.equal(Mandate.parse(mandate).maxHires, 3);
  assert.throws(() => Mandate.parse({...mandate, budget: {[USDM_UNIT]: '0.8'}}));
});

test('purchaseViewFrom treats an empty result hash as no result and isConfirmed checks both tx lists', () => {
  const view = purchaseViewFrom({
    blockchainIdentifier: 'bid-1',
    onChainState: 'FundsLocked',
    resultHash: '',
    NextAction: {requestedAction: 'WaitingForExternalAction', errorType: null, errorNote: null},
    CurrentTransaction: {txHash: 'tx2', status: 'Pending', newOnChainState: 'ResultSubmitted'},
    TransactionHistory: [{txHash: 'tx1', status: 'Confirmed', newOnChainState: 'FundsLocked'}],
    WithdrawnForBuyer: [],
    WithdrawnForSeller: [],
  });
  assert.equal(view.resultHash, null);
  assert.equal(isConfirmed(view, 'FundsLocked'), true);
  assert.equal(isConfirmed(view, 'ResultSubmitted'), false);
});
