import {choice, noul, TypeSafeClient} from '@typesafe-ai/sdk';
import {formatPrice} from '../shared/money.mjs';

// The reviewer can only tighten. It sees proposals the guard already allowed and may veto them
// or ask the owner. It can never approve what the guard denied, because such a proposal never
// gets here. A wrong veto costs a retry; it cannot cost money.

export const JEV_MODEL = 'jev-latest';
export const CONFIDENCE_THRESHOLD = 0.8;

const QUESTIONS = Object.freeze({
  within_mandate: noul(
    'The proposal stays within the mandate: price under the per-hire cap and the budget, and the agent on the allowlist.',
    {true: 'Every mandate limit is respected.', false: 'At least one mandate limit is violated.'},
  ),
  lowest_price: noul("The proposed agent's price is the lowest among the quotes."),
  has_refund: noul('The proposed agent has at least one refund in its track record.'),
  // The rubric is spelled out because a decision model is only as sure as its criteria:
  // on six test scenarios this wording got all six right at confidence 0.84 or higher.
  verdict: choice(
    "The guard already confirmed this hire fits the mandate. The quotes are all the agents able to do this subtask. Decide only whether the proposal wastes the owner's money.",
    {
      approve: 'No quote is clearly better than the proposed agent. This is the default.',
      veto: 'Another quote is clearly better: it costs less with a track record at least as good, or the proposed agent has a refund on record and another quote has none.',
    },
  ),
});

function jevDecide() {
  let client;
  return ({state, questions}) => {
    client ??= new TypeSafeClient();
    return client.systemOne({model: JEV_MODEL, state, questions});
  };
}

const NO_RECORD = Object.freeze({completed: 0, refunded: 0});
const pricesIn = (amounts) =>
  Object.entries(amounts)
    .map(([unit, amount]) => formatPrice({unit, amount}))
    .join(', ');

function buildState({mandate, proposal, listings}) {
  const named = listings.find((listing) => listing.agentIdentifier === proposal.agentIdentifier);
  const able = new Set(mandate.allowlist.filter((entry) => entry.role === proposal.subtask).map((entry) => entry.agentIdentifier));
  return {
    mandate: {
      budget: pricesIn(mandate.budget),
      per_hire_max: pricesIn(mandate.perHire),
      max_hires: mandate.maxHires,
      allowlist: mandate.allowlist.map((entry) => entry.name),
    },
    quotes: listings.filter((listing) => able.has(listing.agentIdentifier)).map((listing) => ({
      agent: listing.name,
      price: listing.price ? formatPrice(listing.price) : 'set per job',
      track_record: listing.trackRecord ?? NO_RECORD,
    })),
    proposal: {
      subtask: proposal.subtask,
      agent: named?.name ?? proposal.agentIdentifier,
      price: formatPrice(named?.price ?? proposal.maxPrice),
      reason: proposal.reason,
    },
  };
}

const factsAgainst = ({has_refund: hasRefund, lowest_price: lowestPrice}) =>
  [hasRefund >= 0.5 ? 'this agent has a refund on record' : null, lowestPrice < 0.5 ? 'it is not the lowest price' : null]
    .filter(Boolean)
    .join('; ');

function decisionFrom(response) {
  const {answers = {}, model} = response ?? {};
  const {choice: pick, confidence} = answers.verdict ?? {};
  if (!['approve', 'veto'].includes(pick) || typeof confidence !== 'number') {
    return {decision: 'escalate', reason: 'The reviewer gave no usable answer, so the owner has to decide'};
  }
  const facts = {
    within_mandate: answers.within_mandate?.noul,
    lowest_price: answers.lowest_price?.noul,
    has_refund: answers.has_refund?.noul,
  };
  const detail = {model, verdict: pick, confidence, answers: facts};
  if (confidence < CONFIDENCE_THRESHOLD) {
    return {decision: 'escalate', reason: `The reviewer is unsure (confidence ${confidence}), so the owner has to decide`, detail};
  }
  if (pick === 'veto') {
    return {decision: 'veto', reason: `Jev vetoed (confidence ${confidence}): ${factsAgainst(facts) || 'poor use of the money'}`, detail};
  }
  if (!(facts.within_mandate >= 0.5)) {
    return {decision: 'escalate', reason: 'The reviewer approved but doubts the proposal fits the mandate', detail};
  }
  return {decision: 'allow', reason: `Jev approved (confidence ${confidence})`, detail};
}

// Fails closed: if Jev cannot answer, the owner decides. Nothing is approved by default.
export function createReviewer({decide = jevDecide()} = {}) {
  return async ({mandate, proposal, listings}) => {
    try {
      return decisionFrom(await decide({state: buildState({mandate, proposal, listings}), questions: QUESTIONS}));
    } catch (error) {
      return {decision: 'escalate', reason: `The reviewer is unavailable: ${error.message}`};
    }
  };
}
