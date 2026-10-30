import {randomBytes} from 'node:crypto';
import {MINUTE_MS} from '../shared/constants.mjs';
import {isConfirmed, jobPrompt} from '../shared/schemas.mjs';
import {accept} from './acceptance.mjs';
import {chainProgress} from './chain-progress.mjs';
import {checkProposal} from './guard.mjs';

const REFUND_MARGIN_MS = 5 * MINUTE_MS; // a refund request needs time to reach the chain before unlock
const RESULT_GRACE_MS = 2 * MINUTE_MS; // a result sent right at the deadline still has to confirm
const NODE_REFUND_WAIT_MS = 15 * MINUTE_MS; // the node refunds a no-show 10 minutes after the deadline
const COLLECT_WAIT_MS = 30 * MINUTE_MS; // the node collects for the seller 10 minutes after unlock
const RESULT_FETCH_ATTEMPTS = 3;
const DEFAULT_POLL_MS = 10_000;

const REFUND_UNDERWAY = new Set(['RefundRequested', 'Disputed', 'RefundAuthorized', 'RefundWithdrawn']);

const refsOf = ({quote, nonce}) => ({
  ...(nonce ? {nonce} : {}),
  ...(quote ? {jobId: quote.jobId, blockchainIdentifier: quote.blockchainIdentifier} : {}),
});

const summarize = (failures) => failures.map(({code, skus}) => (skus.length > 0 ? `${code} (${skus.join(', ')})` : code)).join('; ');

// One hire from proposal to verdict. The chain's slow part continues in `watch`, so a failed
// hire can be replaced at once while its refund finishes in the background.
export function createHirer({
  mandate,
  ledger,
  payments,
  purchaser,
  review,
  clock = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = DEFAULT_POLL_MS,
  newNonce = () => randomBytes(10).toString('hex'),
}) {
  const record = (ctx, step, extra = {}) =>
    ledger.append({step, proposalId: ctx.proposalId, subtask: ctx.subtask, refs: refsOf(ctx), ...extra});

  const hasLogged = (ctx, step) => {
    const id = ctx.quote.blockchainIdentifier;
    return ledger.lines().some((line) => line.step === step && line.refs?.blockchainIdentifier === id);
  };
  const recordOnce = (ctx, step, extra) => (hasLogged(ctx, step) ? undefined : record(ctx, step, extra));

  function logChainProgress(ctx, view) {
    for (const {step, reason, txHash} of chainProgress(view)) {
      recordOnce(ctx, step, {refs: {...refsOf(ctx), txHash}, reason});
    }
  }

  async function readPurchase(ctx) {
    try {
      return await payments.getPurchase(ctx.quote.blockchainIdentifier);
    } catch (error) {
      // A wallet-scoped key cannot see an order until the node has picked its wallet, about a minute in.
      if (error.kind === 'not-found') recordOnce(ctx, 'purchase.not_visible_yet', {reason: error.message});
      else record(ctx, 'purchase.lookup_failed', {reason: error.message});
      return null;
    }
  }

  async function pollUntil(ctx, isDone, deadline) {
    for (;;) {
      const view = await readPurchase(ctx);
      if (view) {
        logChainProgress(ctx, view);
        if (isDone(view)) return view;
      }
      if (clock() >= deadline) return null;
      await sleep(pollMs);
    }
  }

  async function fetchResult(ctx) {
    for (let attempt = 0; attempt < RESULT_FETCH_ATTEMPTS; attempt += 1) {
      try {
        const {status, result} = await payments.getJobResult(ctx.listing, ctx.quote.jobId);
        if (status === 'completed' && typeof result === 'string') return result;
      } catch (error) {
        record(ctx, 'result.fetch_failed', {reason: error.message});
      }
      await sleep(pollMs);
    }
    // No text can match the on-chain hash, so a seller that withholds the result fails A1.
    return '';
  }

  async function requestRefundUntil(ctx, latest) {
    for (;;) {
      try {
        await payments.requestRefund(ctx.quote.blockchainIdentifier);
        return true;
      } catch (error) {
        record(ctx, 'refund.request_failed', {reason: error.message});
        const view = await readPurchase(ctx);
        if (view && REFUND_UNDERWAY.has(view.onChainState)) return true;
        if (clock() >= latest) return false;
      }
      await sleep(pollMs);
    }
  }

  async function refundFlow(ctx) {
    const latest = ctx.quote.unlockTime - REFUND_MARGIN_MS;
    const tooLate = () => record(ctx, 'refund.too_late', {reason: 'The refund window closed before the request could reach the chain'});
    if (clock() >= latest) return tooLate();
    recordOnce(ctx, 'refund.pending');
    if (!(await requestRefundUntil(ctx, latest))) return tooLate();
    const view = await pollUntil(ctx, (current) => isConfirmed(current, 'RefundWithdrawn'), ctx.quote.externalDisputeUnlockTime);
    if (!view) record(ctx, 'refund.stuck', {reason: 'No money back by the external dispute time; it stays counted as locked'});
    return undefined;
  }

  async function watchSettlement(ctx) {
    const collected = (view) => isConfirmed(view, 'Withdrawn') || isConfirmed(view, 'DisputedWithdrawn');
    const view = await pollUntil(ctx, collected, ctx.quote.unlockTime + COLLECT_WAIT_MS);
    if (!view) record(ctx, 'settlement.pending', {reason: 'The seller has not collected yet; do not report this payment as settled'});
  }

  async function judge(ctx, view) {
    const result = await fetchResult(ctx);
    const verdict = accept({
      kind: ctx.job.kind,
      spec: ctx.job.acceptance,
      inputTable: ctx.job.table,
      resultText: result,
      nonce: ctx.nonce,
      onChainResultHash: view.resultHash,
    });
    if (verdict.ok) {
      recordOnce(ctx, 'acceptance.passed');
      return {status: 'accepted', subtask: ctx.subtask, result, watch: watchSettlement(ctx)};
    }
    const reason = summarize(verdict.failures);
    recordOnce(ctx, 'acceptance.failed', {reason, detail: {failures: verdict.failures}});
    return {status: 'failed', subtask: ctx.subtask, reason, watch: refundFlow(ctx)};
  }

  async function sellerNoShow(ctx) {
    const reason = 'SELLER_NO_SHOW: no result by the deadline';
    recordOnce(ctx, 'acceptance.failed', {reason});
    const refunded = (view) => isConfirmed(view, 'RefundWithdrawn');
    const watch = pollUntil(ctx, refunded, ctx.quote.submitResultTime + NODE_REFUND_WAIT_MS).then((view) => {
      if (!view) record(ctx, 'refund.stuck', {reason: 'The node has not refunded the no-show yet'});
    });
    return {status: 'failed', subtask: ctx.subtask, reason, watch};
  }

  async function followPurchase(ctx) {
    const hasResult = (view) => isConfirmed(view, 'ResultSubmitted') && view.resultHash !== null;
    const view = await pollUntil(ctx, hasResult, ctx.quote.submitResultTime + RESULT_GRACE_MS);
    return view ? judge(ctx, view) : sellerNoShow(ctx);
  }

  const notBought = (bought) =>
    bought.stop
      ? {status: 'stopped', reason: bought.reason}
      : {status: 'denied', rule: bought.rule, code: bought.code, reason: bought.reason};

  async function startAndFollow(base, proposal, listing, job) {
    const nonce = newNonce();
    const prompt = jobPrompt(job);
    const started = {...base, nonce, prompt, job, listing};
    record(started, 'job.pending');
    let quote;
    try {
      quote = await payments.startJob(listing, job, nonce);
    } catch (error) {
      record(started, 'job.failed', {reason: error.message});
      return {status: 'job_failed', reason: `${listing.name} did not take the job: ${error.message}`};
    }
    const ctx = {...started, quote, price: listing.price ?? proposal.maxPrice};
    record(ctx, 'job.started');
    const bought = await purchaser.buy(ctx);
    return bought.ok ? followPurchase(ctx) : notBought(bought);
  }

  async function hire({proposal, job, listings}) {
    const base = {proposalId: proposal.proposalId, subtask: proposal.subtask};
    const listed = listings.find((item) => item.agentIdentifier === proposal.agentIdentifier);
    const listing = listed ?? {agentIdentifier: proposal.agentIdentifier, name: proposal.agentIdentifier, apiBaseUrl: '', price: null};
    const check = checkProposal({mandate, ledger: ledger.state(), proposal, listing});
    record(base, 'proposal.checked', {
      decision: check.ok ? 'allow' : 'deny',
      rule: check.rule,
      code: check.code,
      reason: check.reason,
      detail: {agentIdentifier: proposal.agentIdentifier, maxPrice: proposal.maxPrice, why: proposal.reason},
    });
    if (!check.ok) return {status: 'denied', rule: check.rule, code: check.code, reason: check.reason};
    const reviewed = await review({mandate, proposal, listings});
    record(base, 'review.checked', {decision: reviewed.decision, reason: reviewed.reason, detail: reviewed.detail});
    if (reviewed.decision === 'veto') return {status: 'vetoed', reason: reviewed.reason};
    if (reviewed.decision !== 'allow') return {status: 'escalated', reason: reviewed.reason, unavailable: reviewed.unavailable === true};
    return startAndFollow(base, proposal, listing, job);
  }

  async function resumeOrder(ctx) {
    const bought = await purchaser.buy(ctx);
    if (bought.ok) return followPurchase(ctx);
    if (bought.stop) return notBought(bought);
    // The guard refused the retry, usually because the pay-by time passed. If no order exists the money is free again.
    try {
      await payments.getPurchase(ctx.quote.blockchainIdentifier);
      return followPurchase(ctx);
    } catch (error) {
      if (error.kind !== 'not-found') return {status: 'stopped', reason: error.message};
      record(ctx, 'purchase.rejected', {reason: `The order never went out and cannot be sent now: ${bought.reason}`});
      return notBought(bought);
    }
  }

  // Picks a purchase up from where the evidence log says it stopped after a restart.
  async function resume(purchase, {job, listings}) {
    const listing =
      listings.find((item) => item.agentIdentifier === purchase.terms.agentIdentifier) ??
      mandate.allowlist.find((entry) => entry.agentIdentifier === purchase.terms.agentIdentifier);
    const ctx = {
      proposalId: purchase.proposalId,
      subtask: purchase.subtask,
      job,
      prompt: jobPrompt(job),
      nonce: purchase.nonce,
      quote: purchase.terms,
      price: {unit: purchase.amount.unit, amount: purchase.amount.value},
      listing,
    };
    switch (purchase.status) {
      case 'reserved':
      case 'uncertain':
        return resumeOrder(ctx);
      case 'created':
      case 'funds_locked':
      case 'result_submitted':
        return followPurchase(ctx);
      // Judged again against the chain: the text a seller sends now may not be the text that passed,
      // and a seller also collects from a hire that failed its check if the refund never got through.
      case 'accepted':
      case 'withdrawn':
        return judge(ctx, await payments.getPurchase(ctx.quote.blockchainIdentifier));
      case 'acceptance_failed':
      case 'refund_pending':
      case 'refund_requested':
      case 'refund_authorized':
        return {status: 'failed', subtask: ctx.subtask, reason: 'Failed before the restart', watch: refundFlow(ctx)};
      default:
        return {status: 'finished', subtask: ctx.subtask, reason: `Already ${purchase.status}`};
    }
  }

  return {hire, resume};
}
