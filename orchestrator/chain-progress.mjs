import {isConfirmed} from '../shared/schemas.mjs';

// Which evidence step each state confirmed on chain stands for.
const CHAIN_STEPS = Object.freeze([
  ['FundsLocked', 'purchase.funds_locked'],
  ['ResultSubmitted', 'result.submitted'],
  ['RefundRequested', 'refund.requested'],
  ['Disputed', 'refund.requested'],
  ['RefundAuthorized', 'refund.authorized'],
  ['RefundWithdrawn', 'refund.withdrawn'],
  ['Withdrawn', 'seller.withdrawn'],
  ['DisputedWithdrawn', 'seller.withdrawn'],
]);

const confirmedTx = (view, state) =>
  [view.current, ...view.history].find((tx) => tx?.status === 'Confirmed' && tx?.newOnChainState === state)?.txHash ?? undefined;

// The steps a purchase has reached on chain, each once, with the transaction that proves it.
export function chainProgress(view) {
  const confirmed = CHAIN_STEPS.filter(([state]) => isConfirmed(view, state)).map(([state, step]) => ({step, reason: state, txHash: confirmedTx(view, state)}));
  return confirmed.filter(({step}, index) => confirmed.findIndex((other) => other.step === step) === index);
}
