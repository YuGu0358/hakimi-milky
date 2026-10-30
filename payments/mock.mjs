import {MINUTE_MS, PAYMENT_SOURCE_TYPE, SPECIALIST_WINDOW_MINUTES} from '../shared/constants.mjs';
import {PaymentsError} from '../shared/errors.mjs';
import {inputHash, resultHash} from '../shared/hash.mjs';
import {Listing, jobPrompt, purchaseViewFrom, quoteFromStartJob} from '../shared/schemas.mjs';
import {normalizeTable} from '../shared/table.mjs';
import agents from '../shared/fixtures/agents.json' with {type: 'json'};

// An offline stand-in for payments.mjs with the same six functions and the same return
// shapes. It builds Payment Service style responses and sends them through the same
// normalizers as the real client, so a shape mismatch shows up here first.
//
// Each getPurchase call moves a purchase one step along, like one more poll of the chain.
//
// faults:
//   dropRows: n                  the cheap agent delivers n rows short
//   noShow: true                 the cheap agent never submits a result
//   refuseRefund: true           the seller never authorizes a refund
//   rejectPurchase: message      every order gets a 400 with this message
//   loseNextPurchaseResponse     the next order is placed but its response is lost
//   dropNextPurchase             the next order never arrives and its response is lost

const CHEAP_AGENT = agents[1].agentIdentifier;

const copyText = (row) => `${String(row.name).trim()}, sold by ${String(row.unit).trim()}.`;

function buildResult(agentIdentifier, job, faults) {
  if (job.kind === 'copy') {
    return JSON.stringify(Object.fromEntries(job.table.map((row) => [String(row.sku).trim(), copyText(row)])));
  }
  const rows = normalizeTable(job.table);
  const short = agentIdentifier === CHEAP_AGENT && faults.dropRows;
  return JSON.stringify(short ? rows.slice(0, -faults.dropRows) : rows);
}

const nextState = (record, faults) => {
  const cheap = record.agentIdentifier === CHEAP_AGENT;
  switch (record.onChainState) {
    case null:
      return 'FundsLocked';
    case 'FundsLocked':
      if (record.refundRequested) return 'RefundRequested';
      return cheap && faults.noShow ? null : 'ResultSubmitted';
    case 'ResultSubmitted':
      return record.refundRequested ? 'Disputed' : null;
    case 'RefundRequested':
    case 'Disputed':
      return faults.refuseRefund ? null : 'RefundAuthorized';
    case 'RefundAuthorized':
      return 'RefundWithdrawn';
    default:
      return null;
  }
};

export function createMockPayments({faults = {}, clock = Date.now} = {}) {
  const jobs = new Map();
  const purchases = new Map();
  const oneShot = new Set(['loseNextPurchaseResponse', 'dropNextPurchase'].filter((name) => faults[name]));
  let counter = 0;

  const useOneShot = (name) => oneShot.delete(name);
  const nextId = () => {
    counter += 1;
    return counter;
  };

  const withTransaction = (record, state) => ({
    ...record,
    onChainState: state,
    resultHash: state === 'ResultSubmitted' ? resultHash(jobs.get(record.jobId).result, record.nonce) : record.resultHash,
    transactions: [...record.transactions, {txHash: `mock-tx-${nextId()}`, status: 'Confirmed', newOnChainState: state}],
  });

  const toView = (record) => {
    const [current, ...earlier] = [...record.transactions].reverse();
    const funds = [{unit: record.price.unit, amount: record.price.amount}];
    return purchaseViewFrom({
      blockchainIdentifier: record.blockchainIdentifier,
      onChainState: record.onChainState,
      resultHash: record.resultHash,
      NextAction: {requestedAction: 'WaitingForExternalAction', errorType: null, errorNote: null},
      CurrentTransaction: current ?? null,
      TransactionHistory: earlier,
      WithdrawnForBuyer: record.onChainState === 'RefundWithdrawn' ? funds : [],
      WithdrawnForSeller: record.onChainState === 'Withdrawn' ? funds : [],
    });
  };

  const findPurchase = (blockchainIdentifier) => {
    const record = purchases.get(blockchainIdentifier);
    if (!record) throw new PaymentsError('Purchase not found', {status: 404});
    return record;
  };

  return {
    async listAgents() {
      return agents.map((agent) => Listing.parse(agent));
    },

    async startJob(agent, job, nonce) {
      const prompt = jobPrompt(job);
      const fixture = agents.find((item) => item.agentIdentifier === agent.agentIdentifier);
      if (!fixture) throw new PaymentsError(`Unknown agent ${agent.agentIdentifier}`, {status: 404});
      const id = nextId();
      const jobId = `mock-job-${id}`;
      const at = (minutes) => clock() + minutes * MINUTE_MS;
      jobs.set(jobId, {result: buildResult(agent.agentIdentifier, job, faults)});
      return quoteFromStartJob({
        id: jobId,
        input_hash: inputHash({prompt}, nonce),
        identifierFromPurchaser: nonce,
        blockchainIdentifier: `mock-bid-${id}`,
        agentIdentifier: agent.agentIdentifier,
        sellerVKey: fixture.sellerVkey,
        paymentSourceType: PAYMENT_SOURCE_TYPE,
        supportedPaymentSourceIndex: fixture.supportedPaymentSourceIndex,
        payByTime: at(SPECIALIST_WINDOW_MINUTES.payBy),
        submitResultTime: at(SPECIALIST_WINDOW_MINUTES.submit),
        unlockTime: at(SPECIALIST_WINDOW_MINUTES.unlock),
        externalDisputeUnlockTime: at(SPECIALIST_WINDOW_MINUTES.dispute),
      });
    },

    async purchase(quote, metadata = {}) {
      if (faults.rejectPurchase) throw new PaymentsError(faults.rejectPurchase, {status: 400});
      if (useOneShot('dropNextPurchase')) throw new PaymentsError('Request timed out');
      const existing = purchases.get(quote.blockchainIdentifier);
      if (existing) return {id: existing.id, blockchainIdentifier: quote.blockchainIdentifier, nextAction: 'FundsLockingRequested', existed: true};
      const fixture = agents.find((item) => item.agentIdentifier === quote.agentIdentifier);
      const record = {
        id: `mock-purchase-${nextId()}`,
        blockchainIdentifier: quote.blockchainIdentifier,
        agentIdentifier: quote.agentIdentifier,
        jobId: quote.jobId,
        nonce: quote.identifierFromPurchaser,
        price: fixture.price,
        metadata,
        onChainState: null,
        resultHash: null,
        refundRequested: false,
        transactions: [],
      };
      purchases.set(quote.blockchainIdentifier, record);
      if (useOneShot('loseNextPurchaseResponse')) throw new PaymentsError('Response lost');
      return {id: record.id, blockchainIdentifier: quote.blockchainIdentifier, nextAction: 'FundsLockingRequested', existed: false};
    },

    async getPurchase(blockchainIdentifier) {
      const record = findPurchase(blockchainIdentifier);
      const state = nextState(record, faults);
      const updated = state ? withTransaction(record, state) : record;
      purchases.set(blockchainIdentifier, updated);
      return toView(updated);
    },

    async getJobResult(_agent, jobId) {
      const job = jobs.get(jobId);
      if (!job) throw new PaymentsError('Job not found', {status: 404});
      return {status: 'completed', result: job.result};
    },

    async requestRefund(blockchainIdentifier) {
      const record = findPurchase(blockchainIdentifier);
      if (!['FundsLocked', 'ResultSubmitted'].includes(record.onChainState)) {
        throw new PaymentsError('Purchase not found or not in valid state', {status: 404});
      }
      purchases.set(blockchainIdentifier, {...record, refundRequested: true});
      return {nextAction: 'SetRefundRequestedRequested', onChainState: record.onChainState};
    },

    // Test helper: the unlock time has passed and the seller collected.
    settle(blockchainIdentifier) {
      purchases.set(blockchainIdentifier, withTransaction(findPurchase(blockchainIdentifier), 'Withdrawn'));
    },
  };
}
