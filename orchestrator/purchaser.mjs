import {Mutex} from 'async-mutex';
import {guard} from './guard.mjs';

const refsOf = ({quote, nonce}) => ({
  jobId: quote.jobId,
  blockchainIdentifier: quote.blockchainIdentifier,
  nonce,
});

const isDefiniteRejection = (error) => error.kind === 'rejected' || error.kind === 'not-found';

// Check, reserve, count and order all happen under one lock, so two parallel hires cannot
// both take the last of the budget. The reservation is written before the order goes out:
// after a crash the log shows an order may exist, and a restart looks it up before anything else.
export function createPurchaser({mandate, ledger, purchase, getPurchase, clock = Date.now}) {
  const mutex = new Mutex();

  const record = (ctx, step, extra = {}) =>
    ledger.append({step, proposalId: ctx.proposalId, subtask: ctx.subtask, refs: refsOf(ctx), ...extra});

  const created = (ctx, order, retry) => {
    record(ctx, 'purchase.created', {reason: order.existed ? 'The Payment Service already had this order' : undefined});
    return {ok: true, created: order, retry};
  };

  const alreadyThere = (ctx, retry) => created(ctx, {blockchainIdentifier: ctx.quote.blockchainIdentifier, existed: true}, retry);

  const rejected = (ctx, error) => {
    record(ctx, 'purchase.rejected', {reason: error.message});
    return {ok: false, rule: 'payment-service', code: 'PURCHASE_REJECTED', reason: error.message};
  };

  const stopped = (ctx, error) => {
    const reason = `Cannot tell whether the order exists, stopping: ${error.message}`;
    record(ctx, 'stopped', {code: 'PURCHASE_UNCERTAIN', reason});
    return {ok: false, rule: 'payment-service', code: 'PURCHASE_UNCERTAIN', reason, stop: true};
  };

  // Sends the amount the guard checked. The Payment Service refuses any other: for a fixed
  // price it compares with the chain, for a dynamic one with what the seller signed.
  const sendOrder = ({quote, price, proposalId, subtask}) =>
    purchase(quote, {taskId: mandate.taskId, proposalId, subtask}, [{unit: price.unit, amount: price.amount}]);

  // Only a response naming this order proves it exists. An empty answer does not.
  async function lookUpOrder(ctx) {
    try {
      const view = await getPurchase(ctx.quote.blockchainIdentifier);
      return {found: view?.blockchainIdentifier === ctx.quote.blockchainIdentifier};
    } catch (error) {
      return error.kind === 'not-found' ? {found: false} : {error};
    }
  }

  async function resend(ctx, retry) {
    try {
      return created(ctx, await sendOrder(ctx), retry);
    } catch (error) {
      if (error.kind === 'conflict') return alreadyThere(ctx, retry);
      return isDefiniteRejection(error) ? rejected(ctx, error) : stopped(ctx, error);
    }
  }

  // A resend carries the same identifiers, which the Payment Service treats as the same purchase.
  async function resolveFromLookup(ctx, retry) {
    const {found, error} = await lookUpOrder(ctx);
    if (error) return stopped(ctx, error);
    return found ? alreadyThere(ctx, retry) : resend(ctx, retry);
  }

  async function placeOrder(ctx) {
    try {
      return created(ctx, await sendOrder(ctx), false);
    } catch (error) {
      if (error.kind === 'conflict') return alreadyThere(ctx, false);
      if (isDefiniteRejection(error)) return rejected(ctx, error);
      record(ctx, 'purchase.uncertain', {reason: error.message});
      return resolveFromLookup(ctx, false);
    }
  }

  async function buyLocked(ctx) {
    const {quote, price, prompt, nonce, subtask} = ctx;
    const decision = guard({mandate, ledger: ledger.state(), quote, price, prompt, nonce, subtask, expectedAgent: ctx.listing?.agentIdentifier, expectedSourceIndex: ctx.listing?.supportedPaymentSourceIndex, now: clock()});
    record(ctx, 'guard.checked', {
      decision: decision.ok ? 'allow' : 'deny',
      rule: decision.rule,
      code: decision.code,
      reason: decision.reason,
    });
    if (!decision.ok) return decision;
    if (decision.retry) return resolveFromLookup(ctx, true);
    record(ctx, 'purchase.reserved', {amount: {unit: price.unit, value: price.amount}, terms: quote});
    return placeOrder(ctx);
  }

  return {buy: (ctx) => mutex.runExclusive(() => buyLocked(ctx))};
}
