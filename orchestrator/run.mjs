import {MINUTE_MS, SPECIALIST_WINDOW_MINUTES} from '../shared/constants.mjs';
import {SUBTASKS} from '../shared/schemas.mjs';
import {failureText} from './failure-text.mjs';
import {unfinished} from './ledger.mjs';
import {mandateHash} from './mandate.mjs';

const MAX_PLAN_ROUNDS = 5;
const STOPS_THE_RUN = new Set(['escalated', 'stopped']);

export function mergeDeliverable(normalizedText, copyText) {
  const copy = JSON.parse(copyText);
  const rows = JSON.parse(normalizedText).map((row) => ({...row, copy: copy[String(row.sku).trim()]}));
  return JSON.stringify(rows, null, 2);
}

// Our own reviewer's words and our own codes only. Raw seller and service text stays in the evidence.
const OWN_WORDS = new Set(['vetoed', 'gave_up', 'escalated']);

const describe = (outcome, ownerKeys) => {
  if (outcome.failures) return `${outcome.status}: ${failureText(outcome.failures, ownerKeys)}`;
  return [outcome.status, outcome.code, OWN_WORDS.has(outcome.status) ? outcome.reason : null].filter(Boolean).join(': ');
};

const watchesOf = (outcomes) => outcomes.flatMap((outcome) => (outcome?.watch ? [outcome.watch] : []));

const COMPLETED = new Set(['accepted', 'withdrawn']);
const REFUNDED = new Set(['acceptance_failed', 'refund_pending', 'refund_requested', 'refund_authorized', 'refund_withdrawn']);

// What this run has seen so far, so a refund counts against an agent before it shows up on chain.
export function recordsFromLedger(state) {
  return Object.values(state.purchases).reduce((records, {terms, status}) => {
    const {completed, refunded} = records[terms.agentIdentifier] ?? {completed: 0, refunded: 0};
    return {
      ...records,
      [terms.agentIdentifier]: {
        completed: completed + (COMPLETED.has(status) ? 1 : 0),
        refunded: refunded + (REFUNDED.has(status) ? 1 : 0),
      },
    };
  }, {});
}

function withTrackRecord(listing, chainRecords, localRecords) {
  const chain = chainRecords[listing.agentIdentifier];
  const local = localRecords[listing.agentIdentifier];
  if (!chain && !local) return listing;
  return {
    ...listing,
    trackRecord: {
      completed: Math.max(chain?.completed ?? 0, local?.completed ?? 0),
      refunded: Math.max(chain?.refunded ?? 0, local?.refunded ?? 0),
    },
  };
}

// Every job stops before a crash is reported, so a caller that tries again never runs beside it.
async function allStopped(jobs) {
  const stopped = await Promise.allSettled(jobs);
  const crash = stopped.find(({status}) => status === 'rejected');
  if (crash) throw crash.reason;
  return stopped.map(({value}) => value);
}

export async function orchestrate({
  table,
  acceptance,
  mandate,
  ledger,
  payments,
  planner,
  hirer,
  clock = Date.now,
  trackRecords = {},
}) {
  const jobs = Object.fromEntries(SUBTASKS.map((kind) => [kind, {kind, table, acceptance, key: acceptance.key}]));
  const ownerKeys = new Set(table.map((row) => String(row[acceptance.key]).trim()));
  const hasLine = (step) => ledger.lines().some((line) => line.step === step);
  if (!hasLine('mandate.confirmed')) {
    ledger.append({step: 'mandate.confirmed', detail: {id: mandate.id, hash: mandateHash(mandate)}});
  }

  // Anyone can register, so names in the registry are text written by strangers. The planner
  // reads them, and it has no reason to see an agent the owner did not put on the list.
  const entryOf = ({agentIdentifier}) => mandate.allowlist.find((entry) => entry.agentIdentifier === agentIdentifier);
  const canBePaid = ({price}) => price !== null && Object.hasOwn(mandate.budget, price.unit);

  // Pick up whatever a previous process left behind, the nearest unlock first. This needs only the
  // Payment Service, so an outage of the registry cannot hold up a refund that is owed.
  const earlier = Object.values(ledger.state().purchases).sort((a, b) => a.terms.unlockTime - b.terms.unlockTime);
  const resumed = await allStopped(
    earlier.map(async (purchase) => ({
      subtask: purchase.subtask,
      outcome: await hirer.resume(purchase, {job: jobs[purchase.subtask], listings: []}),
    })),
  );

  const isDecided = (outcome) => outcome.status === 'accepted' || STOPS_THE_RUN.has(outcome.status);
  const needsHire = SUBTASKS.some((subtask) => !resumed.some((item) => item.subtask === subtask && isDecided(item.outcome)));
  const pinned = needsHire ? await payments.listAgents(mandate.allowlist.map(({agentIdentifier}) => agentIdentifier)) : [];
  // Only what the owner wrote and plain numbers reach a model. The name in the registry is a stranger's text.
  const registered = pinned.filter(entryOf).filter(canBePaid).map((listing) => ({...listing, name: entryOf(listing).name}));
  const hasNamed = (agentIdentifier) => ledger.lines().some((line) => line.step === 'agent.unavailable' && line.detail?.agentIdentifier === agentIdentifier);
  if (needsHire) {
    mandate.allowlist
      .map(({agentIdentifier}) => agentIdentifier)
      .filter((id) => !registered.some(({agentIdentifier}) => agentIdentifier === id) && !hasNamed(id))
      .forEach((agentIdentifier) =>
        ledger.append({step: 'agent.unavailable', reason: 'On the list, but the registry has no hireable listing for it', detail: {agentIdentifier}}),
      );
  }
  const currentListings = () => {
    const localRecords = recordsFromLedger(ledger.state());
    return registered.map((listing) => withTrackRecord(listing, trackRecords, localRecords));
  };

  // A new quote gives the seller this long. Past that point no hire can pass G4, so asking is wasted.
  const canStillHire = () => clock() + SPECIALIST_WINDOW_MINUTES.submit * MINUTE_MS < mandate.deliverBy;

  async function nextProposal(subtask, feedback, listings) {
    const {proposals, rejected} = await planner.plan({subtask, table, listings, feedback});
    rejected.forEach(({error}) => ledger.append({step: 'plan.rejected', subtask, reason: error}));
    const [proposal] = proposals;
    if (proposal) {
      ledger.append({
        step: 'plan.proposed',
        proposalId: proposal.proposalId,
        subtask,
        reason: proposal.reason,
        detail: {agentIdentifier: proposal.agentIdentifier, maxPrice: proposal.maxPrice},
      });
    }
    return {proposal, errors: rejected.map(({error}) => `Rejected plan: ${error}`)};
  }

  async function runSubtask(subtask) {
    const before = resumed.filter((item) => item.subtask === subtask).map((item) => item.outcome);
    const done = before.find((outcome) => outcome.status === 'accepted' || STOPS_THE_RUN.has(outcome.status));
    if (done) return {final: done, outcomes: before};
    const outcomes = [...before];
    let feedback = before.filter((outcome) => outcome.status === 'failed').map((outcome) => describe(outcome, ownerKeys));
    if (needsHire && registered.length === 0) return {final: {status: 'gave_up', code: 'NO_AGENTS', reason: `${subtask}: none of the owner's agents can be hired`}, outcomes};
    for (let round = 0; round < MAX_PLAN_ROUNDS && canStillHire(); round += 1) {
      const listings = currentListings();
      const {proposal, errors} = await nextProposal(subtask, feedback, listings);
      feedback = [...feedback, ...errors];
      if (proposal) {
        const outcome = await hirer.hire({proposal, job: jobs[subtask], listings});
        outcomes.push(outcome);
        if (outcome.status === 'accepted' || STOPS_THE_RUN.has(outcome.status)) return {final: outcome, outcomes};
        feedback = [...feedback, describe(outcome, ownerKeys)];
      }
    }
    return {final: {status: 'gave_up', reason: `${subtask}: ${feedback.join(' | ') || 'no proposal'}`}, outcomes};
  }

  const results = await allStopped(SUBTASKS.map(runSubtask));
  // Resolves to how many purchases stayed open when the watching ended, so nobody reports money as settled that is not.
  const settled = Promise.all(results.flatMap(({outcomes}) => watchesOf(outcomes))).then(() => unfinished(ledger.state()).length);
  const notDone = results.filter(({final}) => final.status !== 'accepted');
  if (notDone.length > 0) {
    const reason = notDone.map(({final}) => describe(final, ownerKeys)).join(' || ');
    ledger.append({step: 'run.failed', reason});
    // A reviewer that answered and wants the owner to decide. Trying again would only ask it until it agrees.
    const blind = notDone.some(({final}) => final.status === 'stopped');
    const ownerMustDecide = notDone.some(({final}) => final.status === 'escalated' && !final.unavailable) || (!blind && !canStillHire());
    return {ok: false, reason, settled, ownerMustDecide};
  }
  const [normalize, copy] = SUBTASKS.map((subtask) => results[SUBTASKS.indexOf(subtask)].final.result);
  const deliverable = mergeDeliverable(normalize, copy);
  ledger.append({step: 'run.delivered'});
  return {ok: true, deliverable, settled};
}
