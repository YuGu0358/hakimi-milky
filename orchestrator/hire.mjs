import {randomBytes} from 'node:crypto';
import {MINUTE_MS} from '../shared/constants.mjs';
import {PaymentsError} from '../shared/errors.mjs';
import {isConfirmed, jobInput} from '../shared/schemas.mjs';
import {accept} from './acceptance.mjs';
import {chainProgress} from './chain-progress.mjs';
import {checkProposal} from './guard.mjs';

const REFUND_MARGIN_MS = 5 * MINUTE_MS; // a refund request needs time to reach the chain before unlock
const RESULT_GRACE_MS = 2 * MINUTE_MS; // a result sent right at the deadline still has to confirm
const NODE_REFUND_WAIT_MS = 15 * MINUTE_MS; // the node refunds a no-show 10 minutes after the deadline
const COLLECT_WAIT_MS = 30 * MINUTE_MS; // the node collects for the seller 10 minutes after unlock
const RESULT_FETCH_ATTEMPTS = 3;
const RESULT_FETCH_WAIT_MS = 5 * MINUTE_MS; // a seller restarting is not a seller withholding
const REFUND_HEADROOM_MS = 2 * MINUTE_MS; // the wait for a result never eats the time a refund request needs
const MAX_BLIND_READS = 120; // failed reads in a row past a deadline before a wait gives up; a sleep does not count
const CATCH_UP_MS = 3 * MINUTE_MS; // after a gap, the service needs time to read the chain again
const DEFAULT_POLL_MS = 10_000;

const REFUND_UNDERWAY = new Set(['RefundRequested', 'Disputed', 'RefundAuthorized', 'RefundWithdrawn']);

const isCollected = (view) => isConfirmed(view, 'Withdrawn') || isConfirmed(view, 'DisputedWithdrawn');

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

  // reached says the service answered at all, even if only to say it has no such order yet.
  async function readPurchase(ctx) {
    try {
      return {view: await payments.getPurchase(ctx.quote.blockchainIdentifier), reached: true};
    } catch (error) {
      // A wallet-scoped key cannot see an order until the node has picked its wallet, about a minute in.
      if (error.kind === 'not-found') {
        recordOnce(ctx, 'purchase.not_visible_yet', {reason: error.message});
        return {view: null, reached: true};
      }
      record(ctx, 'purchase.lookup_failed', {reason: error.message});
      return {view: null, reached: false};
    }
  }

  // A failed read says nothing about the chain, and neither does the first answer after a gap:
  // the service may still be catching up. A deadline only decides after unbroken watching.
  async function pollUntil(ctx, isDone, deadline) {
    const maxGap = 4 * pollMs;
    let blindReads = 0;
    let lastReadAt = null;
    let watchingSince = clock();
    for (;;) {
      const {view, reached} = await readPurchase(ctx);
      const now = clock();
      if (!reached || (lastReadAt !== null && now - lastReadAt > maxGap)) watchingSince = now;
      lastReadAt = now;
      if (view) {
        logChainProgress(ctx, view);
        if (isDone(view)) return view;
      }
      if (reached && now >= deadline && now - watchingSince >= CATCH_UP_MS) return null;
      blindReads = !reached && now >= deadline ? blindReads + 1 : 0;
      if (blindReads >= MAX_BLIND_READS) throw new PaymentsError('No answer from the Payment Service');
      await sleep(pollMs);
    }
  }

  async function fetchResult(ctx) {
    const giveUpAt = Math.min(clock() + RESULT_FETCH_WAIT_MS, ctx.quote.unlockTime - REFUND_MARGIN_MS - REFUND_HEADROOM_MS);
    for (let attempt = 1; ; attempt += 1) {
      try {
        const {status, result} = await payments.getJobResult(ctx.listing, ctx.quote.jobId);
        if (status === 'completed' && typeof result === 'string') return result;
      } catch (error) {
        record(ctx, 'result.fetch_failed', {reason: error.message});
      }
      // No text can match the on-chain hash, so a seller that withholds the result fails A1.
      if (attempt >= RESULT_FETCH_ATTEMPTS && clock() >= giveUpAt) return '';
      await sleep(pollMs);
    }
  }

  async function requestRefundUntil(ctx, latest) {
    for (;;) {
      try {
        await payments.requestRefund(ctx.quote.blockchainIdentifier);
        return true;
      } catch (error) {
        record(ctx, 'refund.request_failed', {reason: error.message});
        const {view} = await readPurchase(ctx);
        if (view && REFUND_UNDERWAY.has(view.onChainState)) return true;
        if (clock() >= latest) return false;
      }
      await sleep(pollMs);
    }
  }

  async function refundFlow(ctx) {
    const latest = ctx.quote.unlockTime - REFUND_MARGIN_MS;
    const tooLate = () => record(ctx, 'refund.too_late', {reason: 'The refund window closed before the request could reach the chain'});
    if (clock() >= latest) {
      // Look first: the money may have come back while this process was away.
      const {view} = await readPurchase(ctx);
      if (view) logChainProgress(ctx, view);
      return view && (REFUND_UNDERWAY.has(view.onChainState) || isCollected(view)) ? undefined : tooLate();
    }
    recordOnce(ctx, 'refund.pending');
    if (!(await requestRefundUntil(ctx, latest))) return tooLate();
    const view = await pollUntil(ctx, (current) => isConfirmed(current, 'RefundWithdrawn'), ctx.quote.externalDisputeUnlockTime).catch(() => null);
    if (!view) record(ctx, 'refund.stuck', {reason: 'No money back by the external dispute time; it stays counted as locked'});
    return undefined;
  }

  async function watchSettlement(ctx) {
    const view = await pollUntil(ctx, isCollected, ctx.quote.unlockTime + COLLECT_WAIT_MS).catch(() => null);
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
    return {status: 'failed', subtask: ctx.subtask, agent: ctx.listing?.name, reason, failures: verdict.failures, watch: refundFlow(ctx)};
  }

  async function sellerNoShow(ctx) {
    const reason = 'SELLER_NO_SHOW: no result by the deadline';
    recordOnce(ctx, 'acceptance.failed', {reason});
    const refunded = (view) => isConfirmed(view, 'RefundWithdrawn');
    const watch = pollUntil(ctx, refunded, ctx.quote.submitResultTime + NODE_REFUND_WAIT_MS).catch(() => null).then((view) => {
      if (!view) record(ctx, 'refund.stuck', {reason: 'The node has not refunded the no-show yet'});
    });
    return {status: 'failed', subtask: ctx.subtask, agent: ctx.listing?.name, code: 'SELLER_NO_SHOW', reason, watch};
  }

  async function followPurchase(ctx) {
    const hasResult = (view) => isConfirmed(view, 'ResultSubmitted') && view.resultHash !== null;
    try {
      const view = await pollUntil(ctx, hasResult, ctx.quote.submitResultTime + RESULT_GRACE_MS);
      return view ? judge(ctx, view) : sellerNoShow(ctx);
    } catch (error) {
      return {status: 'stopped', reason: error.message};
    }
  }

  const notBought = (bought) =>
    bought.stop
      ? {status: 'stopped', reason: bought.reason}
      : {status: 'denied', rule: bought.rule, code: bought.code, reason: bought.reason};

  async function startAndFollow(base, proposal, listing, job) {
    const nonce = newNonce();
    const started = {...base, nonce, input: jobInput(job), job, listing};
    record(started, 'job.pending');
    let quote;
    try {
      quote = await payments.startJob(listing, job, nonce);
    } catch (error) {
      record(started, 'job.failed', {reason: error.message});
      return {status: 'job_failed', agent: listing.name, code: 'JOB_FAILED', reason: `${listing.name} did not take the job: ${error.message}`};
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
      input: jobInput(job),
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
        return {status: 'failed', subtask: ctx.subtask, code: 'FAILED_BEFORE_RESTART', reason: 'Failed before the restart', watch: refundFlow(ctx)};
      default:
        return {status: 'finished', subtask: ctx.subtask, reason: `Already ${purchase.status}`};
    }
  }

  return {hire, resume};
}
