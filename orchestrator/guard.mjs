import {inputHash} from '../shared/hash.mjs';

// The guard is deterministic code with no model in it. It answers one question:
// does this owner's mandate allow this payment? Everything it needs arrives as input,
// including the current time, so every decision can be replayed in a test.

const allow = () => ({ok: true});
const deny = (rule, code, reason) => ({ok: false, rule, code, reason});

const findEntry = (mandate, agentIdentifier) =>
  mandate.allowlist.find((entry) => entry.agentIdentifier === agentIdentifier);
const isAtomic = (amount) => typeof amount === 'string' && /^[1-9]\d*$/.test(amount);
const usageOf = (ledger, unit) => ledger.units[unit] ?? {spent: 0n, locked: 0n};

const firstDenial = (checks) => {
  for (const check of checks) {
    const decision = check();
    if (!decision.ok) return decision;
  }
  return null;
};

function checkAllowlisted(mandate, agentIdentifier) {
  return findEntry(mandate, agentIdentifier)
    ? allow()
    : deny('G1', 'G1_NOT_ALLOWLISTED', `Agent ${agentIdentifier} is not on the mandate's allowlist`);
}

function checkSellerKey({mandate, quote}) {
  const entry = findEntry(mandate, quote.agentIdentifier);
  return entry.sellerVkey === quote.sellerVkey
    ? allow()
    : deny('G1', 'G1_VKEY_MISMATCH', `Quote names seller key ${quote.sellerVkey}, the mandate pinned ${entry.sellerVkey}`);
}

function checkSpend({mandate, ledger, price}) {
  if (!isAtomic(price.amount)) {
    return deny('G2', 'G2_BAD_AMOUNT', `Amount ${JSON.stringify(price.amount)} is not a positive integer`);
  }
  // hasOwn, because a planner could name a unit like "constructor" that every object inherits.
  const budget = Object.hasOwn(mandate.budget, price.unit) ? mandate.budget[price.unit] : undefined;
  const cap = Object.hasOwn(mandate.perHire, price.unit) ? mandate.perHire[price.unit] : undefined;
  if (budget === undefined || cap === undefined) {
    return deny('G2', 'G2_UNIT_NOT_ALLOWED', `The mandate has no budget in unit ${JSON.stringify(price.unit)}`);
  }
  const amount = BigInt(price.amount);
  if (amount > BigInt(cap)) {
    return deny('G2', 'G2_OVER_PER_HIRE', `Price ${amount} is above the per-hire cap ${cap}`);
  }
  const {spent, locked} = usageOf(ledger, price.unit);
  if (spent + locked + amount > BigInt(budget)) {
    return deny('G2', 'G2_OVER_BUDGET', `Spent ${spent} plus locked ${locked} plus price ${amount} is above the budget ${budget}`);
  }
  return allow();
}

function checkInput({quote, prompt, nonce}) {
  if (quote.identifierFromPurchaser !== nonce) {
    return deny('G3', 'G3_NONCE_MISMATCH', 'Quote does not echo the purchaser nonce we sent');
  }
  return quote.inputHash === inputHash({prompt}, nonce)
    ? allow()
    : deny('G3', 'G3_INPUT_HASH_MISMATCH', 'Quote is bound to a different input than the one we sent');
}

function checkTimes({mandate, quote, now}) {
  const {payByTime, submitResultTime, unlockTime} = quote;
  if (![payByTime, submitResultTime, unlockTime].every(Number.isFinite)) {
    return deny('G4', 'G4_BAD_TIME', 'Quote has an unusable time');
  }
  if (payByTime <= now) return deny('G4', 'G4_PAYBY_PASSED', 'The pay-by time has already passed');
  if (submitResultTime >= mandate.deliverBy) {
    return deny('G4', 'G4_LATE_DELIVERY', `Result deadline ${submitResultTime} is not before delivery deadline ${mandate.deliverBy}`);
  }
  if (unlockTime > mandate.lockUntil) {
    return deny('G4', 'G4_LOCKED_TOO_LONG', `Unlock time ${unlockTime} is after the lock limit ${mandate.lockUntil}`);
  }
  return allow();
}

function checkSubtaskFree({ledger, subtask}) {
  const status = ledger.subtasks[subtask]?.status;
  if (status === 'open') return deny('G5', 'G5_OPEN_PURCHASE', `Subtask ${subtask} has a purchase with no verdict yet`);
  if (status === 'accepted') return deny('G5', 'G5_ALREADY_ACCEPTED', `Subtask ${subtask} already passed acceptance`);
  return allow();
}

function checkNotDuplicate({ledger, quote, nonce, subtask}) {
  const existing = ledger.purchases[quote.blockchainIdentifier];
  if (existing && existing.nonce !== nonce) {
    return deny('G5', 'G5_NONCE_CHANGED', 'A retry must reuse the nonce of the original order');
  }
  if (existing?.settled && existing.status !== 'rejected') {
    return deny('G5', 'G5_ALREADY_SETTLED', `This purchase already finished as ${existing.status}`);
  }
  return checkSubtaskFree({ledger, subtask});
}

function checkHires({mandate, ledger}) {
  return ledger.hires < mandate.maxHires
    ? allow()
    : deny('G6', 'G6_MAX_HIRES', `Already hired ${ledger.hires} times, the mandate allows ${mandate.maxHires}`);
}

const isRetry = ({ledger, quote, nonce}) => {
  const existing = ledger.purchases[quote.blockchainIdentifier];
  return existing?.nonce === nonce && !existing.settled;
};

// Runs before paying. A retry of an order whose money is still reserved skips the budget and
// hire checks because it adds nothing new; it still has to match the mandate and the input.
// An order the service rejected holds no money any more, so trying it again counts as new.
export function guard(ctx) {
  const retry = isRetry(ctx);
  const checks = [
    () => checkAllowlisted(ctx.mandate, ctx.quote.agentIdentifier),
    () => checkSellerKey(ctx),
    ...(retry ? [] : [() => checkSpend(ctx)]),
    () => checkInput(ctx),
    () => checkTimes(ctx),
    ...(retry ? [] : [() => checkNotDuplicate(ctx), () => checkHires(ctx)]),
  ];
  return firstDenial(checks) ?? {ok: true, retry};
}

// Runs before any data leaves. The seller key is only known once a quote comes back, so
// G1 checks the allowlist and the pinned URL here and the seller key again in guard().
export function checkProposal({mandate, ledger, proposal, listing}) {
  const {agentIdentifier, maxPrice, subtask} = proposal;
  const entry = findEntry(mandate, agentIdentifier);
  const price = listing.price ?? maxPrice;
  const denied = firstDenial([
    () => checkAllowlisted(mandate, agentIdentifier),
    () =>
      entry.apiBaseUrl === listing.apiBaseUrl
        ? allow()
        : deny('G1', 'G1_URL_MISMATCH', `Registry URL ${listing.apiBaseUrl} differs from the pinned ${entry.apiBaseUrl}`),
    () =>
      entry.role === subtask
        ? allow()
        : deny('G1', 'G1_WRONG_ROLE', `Agent ${entry.name} is allowed for ${entry.role}, not ${subtask}`),
    () => checkSpend({mandate, ledger, price: maxPrice}),
    () => checkSpend({mandate, ledger, price}),
    () =>
      price.unit === maxPrice.unit && BigInt(price.amount) <= BigInt(maxPrice.amount)
        ? allow()
        : deny('G2', 'G2_OVER_PROPOSAL_MAX', `Listed price ${price.amount} is above the proposal's limit ${maxPrice.amount}`),
    () => checkSubtaskFree({ledger, subtask}),
    () => checkHires({mandate, ledger}),
  ]);
  return denied ?? allow();
}
