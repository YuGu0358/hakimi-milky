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

  const rejected = (ctx, error) => {
    record(ctx, 'purchase.rejected', {reason: error.message});
    return {ok: false, rule: 'payment-service', code: 'PURCHASE_REJECTED', reason: error.message};
  };

  const stopped = (ctx, error) => {
    const reason = `Cannot tell whether the order exists, stopping: ${error.message}`;
    record(ctx, 'stopped', {code: 'PURCHASE_UNCERTAIN', reason});
    return {ok: false, rule: 'payment-service', code: 'PURCHASE_UNCERTAIN', reason, stop: true};
  };

  const orderMetadata = ({proposalId, subtask}) => ({taskId: mandate.taskId, proposalId, subtask});

  // The response was lost. Look the order up first; send it again only if it is really absent,
  // and with the same identifiers, which the Payment Service treats as the same purchase.
  async function resolveUncertain(ctx, retry, firstError) {
    record(ctx, 'purchase.uncertain', {reason: firstError.message});
    try {
      await getPurchase(ctx.quote.blockchainIdentifier);
      return created(ctx, {blockchainIdentifier: ctx.quote.blockchainIdentifier, existed: true}, retry);
    } catch (lookupError) {
      if (lookupError.kind !== 'not-found') return stopped(ctx, lookupError);
    }
    try {
      return created(ctx, await purchase(ctx.quote, orderMetadata(ctx)), retry);
    } catch (resendError) {
      return isDefiniteRejection(resendError) ? rejected(ctx, resendError) : stopped(ctx, resendError);
    }
  }

  async function buyLocked(ctx) {
    const {quote, price, prompt, nonce, subtask} = ctx;
    const decision = guard({mandate, ledger: ledger.state(), quote, price, prompt, nonce, subtask, now: clock()});
    record(ctx, 'guard.checked', {
      decision: decision.ok ? 'allow' : 'deny',
      rule: decision.rule,
      code: decision.code,
      reason: decision.reason,
    });
    if (!decision.ok) return decision;
    if (!decision.retry) {
      record(ctx, 'purchase.reserved', {amount: {unit: price.unit, value: price.amount}, terms: quote});
    }
    try {
      return created(ctx, await purchase(quote, orderMetadata(ctx)), decision.retry);
    } catch (error) {
      return isDefiniteRejection(error) ? rejected(ctx, error) : resolveUncertain(ctx, decision.retry, error);
    }
  }

  return {buy: (ctx) => mutex.runExclusive(() => buyLocked(ctx))};
}
