import {MINUTE_MS, NETWORK} from '../shared/constants.mjs';
import {resultHash} from '../shared/hash.mjs';
import {Job, isConfirmed, purchaseViewFrom} from '../shared/schemas.mjs';

// The seller's side of one job: wait for the funds, do the work, commit the result, then
// keep watching, because the buyer can still ask for a refund. A demo agent agrees to every
// refund on its own, so the refund path never waits for a person.

// Too close to the deadline, the submit transaction might not make it, as in the starter.
const MIN_TIME_TO_SUBMIT_MS = 2 * MINUTE_MS;
const WAITING = 'WaitingForExternalAction';
const REFUND_ASKED = new Set(['Disputed', 'RefundRequested']);
const FINISHED = new Set(['Withdrawn', 'RefundWithdrawn', 'DisputedWithdrawn']);
// Phases where the chain can still change something for this job.
const WATCHED = new Set([
  'waiting-payment',
  'model-pending',
  'submit-pending',
  'awaiting-result',
  'result-confirmed',
  'deadline-blocked',
  'no-show',
  'refund-authorize-pending',
  'refund-authorized',
]);

export function createSellerLoop({store, mps, work, fault = {}, clock = Date.now, log = console.error}) {
  const blockchainIdentifierOf = (job) => job.response.blockchainIdentifier;
  const failed = (job, phase) => store.save({...job, phase, status: 'failed'});

  async function submit(job) {
    if (clock() >= job.response.submitResultTime) return failed(job, 'deadline-blocked');
    await mps('/payment/submit-result', {
      network: NETWORK,
      blockchainIdentifier: blockchainIdentifierOf(job),
      submitResultHash: job.resultHash,
    });
    return store.save({...job, phase: 'awaiting-result'});
  }

  async function deliver(job) {
    if (clock() >= job.response.submitResultTime - MIN_TIME_TO_SUBMIT_MS) return failed(job, 'deadline-blocked');
    if (fault.noShow) return failed(job, 'no-show');
    const running = store.save({...job, phase: 'model-pending', status: 'running'});
    const result = await work({job: Job.parse(JSON.parse(job.input.prompt)), nonce: job.nonce});
    return submit(store.save({...running, phase: 'submit-pending', result, resultHash: resultHash(result, job.nonce)}));
  }

  // The first submit may have gone through. A hash already recorded means it did.
  function resumeSubmit(job, view, raw) {
    const isRecorded = view.resultHash === job.resultHash || raw.NextAction?.resultHash === job.resultHash;
    if (isRecorded) return store.save({...job, phase: 'awaiting-result'});
    return view.nextAction.requestedAction === WAITING ? submit(job) : job;
  }

  function awaitResult(job, view) {
    if (view.nextAction.errorType) log(`Job ${job.id}: the submit transaction failed: ${view.nextAction.errorNote}`);
    const isOurs = view.onChainState === 'ResultSubmitted' && view.resultHash === job.resultHash;
    return isOurs && isConfirmed(view, 'ResultSubmitted') ? store.save({...job, phase: 'result-confirmed', status: 'completed'}) : job;
  }

  function awaitPayment(job, view) {
    if (view.onChainState === 'FundsLocked' && isConfirmed(view, 'FundsLocked')) return deliver(job);
    return clock() >= job.response.submitResultTime ? failed(job, 'expired') : job;
  }

  async function authorizeRefund(job, view) {
    // Another transaction for this payment is in flight. The next tick looks again.
    if (view.nextAction.requestedAction !== WAITING) return job;
    const pending = store.save({...job, phase: 'refund-authorize-pending', status: job.status === 'completed' ? 'completed' : 'failed'});
    await mps('/payment/authorize-refund', {network: NETWORK, blockchainIdentifier: blockchainIdentifierOf(job)});
    return store.save({...pending, phase: 'refund-authorized'});
  }

  const nextByPhase = {
    'waiting-payment': awaitPayment,
    'model-pending': deliver,
    'submit-pending': resumeSubmit,
    'awaiting-result': awaitResult,
  };

  async function step(job) {
    const raw = await mps('/payment/resolve-blockchain-identifier', {
      network: NETWORK,
      blockchainIdentifier: blockchainIdentifierOf(job),
      includeHistory: 'true',
    });
    const view = purchaseViewFrom(raw);
    if (FINISHED.has(view.onChainState)) return store.save({...job, phase: 'settled', settledAs: view.onChainState});
    if (REFUND_ASKED.has(view.onChainState)) return authorizeRefund(job, view);
    if (view.onChainState === 'RefundAuthorized') return job.phase === 'refund-authorized' ? job : store.save({...job, phase: 'refund-authorized'});
    return nextByPhase[job.phase]?.(job, view, raw) ?? job;
  }

  let isRunning = false;

  return {
    async tick() {
      if (isRunning) return;
      isRunning = true;
      try {
        for (const job of store.list().filter(({phase}) => WATCHED.has(phase))) {
          try {
            await step(job);
          } catch (error) {
            log(`Job ${job.id} needs attention in ${job.phase}: ${error.message}`);
          }
        }
      } catch (error) {
        log(`Cannot read the saved jobs: ${error.message}`);
      } finally {
        isRunning = false;
      }
    },
  };
}
