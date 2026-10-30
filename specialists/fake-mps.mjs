import {MINUTE_MS} from '../shared/constants.mjs';
import {PaymentsError} from '../shared/errors.mjs';

// The seller side of the Payment Service, in memory, for tests. It enforces the rules read
// from the service's source at a846392, so a request the real one refuses fails here too.
// The chain helpers stand in for transactions confirming.

const WAITING = 'WaitingForExternalAction';
const REFUND_ASKED = ['Disputed', 'RefundRequested'];

const fail = (status, message) => {
  throw new PaymentsError(message, {status});
};

function checkPaymentRequest(body, now) {
  if (body.RequestedFunds != null) fail(400, 'For fixed pricing, RequestedFunds must be null');
  if (body.supportedPaymentSourceIndex == null) fail(400, 'V2 Cardano payments require supportedPaymentSourceIndex');
  const [payBy, submit, unlock, dispute] = [body.payByTime, body.submitResultTime, body.unlockTime, body.externalDisputeUnlockTime].map(Date.parse);
  if (payBy > submit - 5 * MINUTE_MS) fail(400, 'Pay by time must be before submit result time (min. 5 minutes)');
  if (payBy < now - 5 * MINUTE_MS) fail(400, 'Pay by time must be in the future (max. 5 minutes)');
  if (submit < now + 15 * MINUTE_MS) fail(400, 'Submit result time must be in the future (min. 15 minutes)');
  if (submit > unlock - 15 * MINUTE_MS) fail(400, 'Submit result time must be before unlock time with at least 15 minutes difference');
  if (dispute < unlock + 15 * MINUTE_MS) fail(400, 'External dispute unlock time must be after unlock time (min. 15 minutes difference)');
}

export function createFakeMps({clock = Date.now} = {}) {
  const payments = new Map();
  const calls = [];
  let counter = 0;

  const find = (id) => payments.get(id) ?? fail(404, 'Payment not found or in invalid state');
  const update = (id, change) => {
    const next = {...payments.get(id), ...change};
    payments.set(id, next);
    return next;
  };

  const confirm = (id, state, change = {}) => {
    const payment = payments.get(id);
    counter += 1;
    return update(id, {
      onChainState: state,
      NextAction: {requestedAction: WAITING, errorType: null, errorNote: null, resultHash: null},
      CurrentTransaction: {txHash: `tx-${counter}`, status: 'Confirmed', newOnChainState: state},
      TransactionHistory: payment.CurrentTransaction ? [...payment.TransactionHistory, payment.CurrentTransaction] : payment.TransactionHistory,
      ...change,
    });
  };

  const requireWaiting = (payment, allowedStates) => {
    const isAllowed = allowedStates.includes(payment.onChainState) && payment.NextAction.requestedAction === WAITING;
    if (!isAllowed) fail(404, 'Payment not found or in invalid state');
  };

  const routes = {
    '/payment': (body) => {
      checkPaymentRequest(body, clock());
      counter += 1;
      const payment = {
        blockchainIdentifier: `bid-${counter}`,
        payByTime: String(Date.parse(body.payByTime)),
        submitResultTime: String(Date.parse(body.submitResultTime)),
        unlockTime: String(Date.parse(body.unlockTime)),
        externalDisputeUnlockTime: String(Date.parse(body.externalDisputeUnlockTime)),
        inputHash: body.inputHash,
        identifierFromPurchaser: body.identifierFromPurchaser,
        agentIdentifier: body.agentIdentifier,
        onChainState: null,
        resultHash: '',
        NextAction: {requestedAction: WAITING, errorType: null, errorNote: null, resultHash: null},
        CurrentTransaction: null,
        TransactionHistory: [],
        WithdrawnForBuyer: [],
        WithdrawnForSeller: [],
      };
      payments.set(payment.blockchainIdentifier, payment);
      return payment;
    },
    '/payment/resolve-blockchain-identifier': ({blockchainIdentifier}) => find(blockchainIdentifier),
    '/payment/submit-result': ({blockchainIdentifier, submitResultHash}) => {
      requireWaiting(find(blockchainIdentifier), ['FundsLocked', ...REFUND_ASKED]);
      return update(blockchainIdentifier, {NextAction: {requestedAction: 'SubmitResultRequested', errorType: null, errorNote: null, resultHash: submitResultHash}});
    },
    '/payment/authorize-refund': ({blockchainIdentifier}) => {
      requireWaiting(find(blockchainIdentifier), REFUND_ASKED);
      return update(blockchainIdentifier, {NextAction: {requestedAction: 'AuthorizeRefundRequested', errorType: null, errorNote: null, resultHash: null}});
    },
  };

  const request = async (path, body) => {
    calls.push({path, body});
    return routes[path](body);
  };

  const chain = {
    lockFunds: (id) => confirm(id, 'FundsLocked'),
    confirmResult: (id) => confirm(id, 'ResultSubmitted', {resultHash: payments.get(id).NextAction.resultHash}),
    askRefund: (id) => confirm(id, payments.get(id).onChainState === 'ResultSubmitted' ? 'Disputed' : 'RefundRequested'),
    // The contract empties the result hash when the seller authorizes a refund.
    confirmRefundAuthorized: (id) => confirm(id, 'RefundAuthorized', {resultHash: ''}),
    finish: (id, state) => confirm(id, state),
    setNextAction: (id, requestedAction, change = {}) => update(id, {NextAction: {...payments.get(id).NextAction, requestedAction, ...change}}),
    payment: (id) => payments.get(id),
  };

  const callsTo = (path) => calls.filter((call) => call.path === path);

  return {request, chain, calls, callsTo};
}
