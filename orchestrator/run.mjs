import {SUBTASKS} from '../shared/schemas.mjs';
import {mandateHash} from './mandate.mjs';

const MAX_PLAN_ROUNDS = 5;
const STOPS_THE_RUN = new Set(['escalated', 'stopped']);

export function mergeDeliverable(normalizedText, copyText) {
  const copy = JSON.parse(copyText);
  const rows = JSON.parse(normalizedText).map((row) => ({...row, copy: copy[String(row.sku).trim()]}));
  return JSON.stringify(rows, null, 2);
}

const describe = (outcome) =>
  [outcome.status, outcome.code, outcome.reason].filter(Boolean).join(': ');

const watchesOf = (outcomes) => outcomes.flatMap((outcome) => (outcome?.watch ? [outcome.watch] : []));

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
  const hasLine = (step) => ledger.lines().some((line) => line.step === step);
  if (!hasLine('mandate.confirmed')) {
    ledger.append({step: 'mandate.confirmed', detail: {id: mandate.id, hash: mandateHash(mandate)}});
  }

  const listings = (await payments.listAgents()).map((listing) => ({
    ...listing,
    ...(trackRecords[listing.agentIdentifier] ? {trackRecord: trackRecords[listing.agentIdentifier]} : {}),
  }));

  // Pick up whatever a previous process left behind, the nearest unlock first.
  const earlier = Object.values(ledger.state().purchases).sort((a, b) => a.terms.unlockTime - b.terms.unlockTime);
  const resumed = await Promise.all(
    earlier.map(async (purchase) => ({
      subtask: purchase.subtask,
      outcome: await hirer.resume(purchase, {job: jobs[purchase.subtask], listings}),
    })),
  );

  async function nextProposal(subtask, feedback) {
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
    let feedback = before.filter((outcome) => outcome.status === 'failed').map(describe);
    for (let round = 0; round < MAX_PLAN_ROUNDS && clock() < mandate.deliverBy; round += 1) {
      const {proposal, errors} = await nextProposal(subtask, feedback);
      feedback = [...feedback, ...errors];
      if (proposal) {
        const outcome = await hirer.hire({proposal, job: jobs[subtask], listings});
        outcomes.push(outcome);
        if (outcome.status === 'accepted' || STOPS_THE_RUN.has(outcome.status)) return {final: outcome, outcomes};
        feedback = [...feedback, describe(outcome)];
      }
    }
    return {final: {status: 'gave_up', reason: `${subtask}: ${feedback.join(' | ') || 'no proposal'}`}, outcomes};
  }

  const results = await Promise.all(SUBTASKS.map(runSubtask));
  const settled = Promise.all(results.flatMap(({outcomes}) => watchesOf(outcomes))).then(() => undefined);
  const notDone = results.filter(({final}) => final.status !== 'accepted');
  if (notDone.length > 0) {
    const reason = notDone.map(({final}) => describe(final)).join(' || ');
    ledger.append({step: 'run.failed', reason});
    return {ok: false, reason, settled};
  }
  const [normalize, copy] = SUBTASKS.map((subtask) => results[SUBTASKS.indexOf(subtask)].final.result);
  const deliverable = mergeDeliverable(normalize, copy);
  ledger.append({step: 'run.delivered'});
  return {ok: true, deliverable, settled};
}
