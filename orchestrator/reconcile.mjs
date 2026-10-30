import {chainProgress} from './chain-progress.mjs';
import {unfinished} from './ledger.mjs';

// Catches a run's evidence up with the chain. A run stops watching at a deadline, a restart or a lost
// network, and the money moves on anyway, so the record of it has to be fetched afterwards. It only
// ever adds what the chain confirms. Being unable to look says nothing about the seller.
export async function reconcileRun({ledger, getPurchase}) {
  const logged = new Set(ledger.lines().flatMap(({step, refs}) => (refs?.blockchainIdentifier ? [`${refs.blockchainIdentifier}:${step}`] : [])));
  const added = [];
  const failures = [];
  for (const purchase of unfinished(ledger.state())) {
    const {blockchainIdentifier, nonce, proposalId, subtask, terms} = purchase;
    try {
      const view = await getPurchase(blockchainIdentifier);
      for (const {step, reason, txHash} of chainProgress(view)) {
        if (logged.has(`${blockchainIdentifier}:${step}`)) continue;
        ledger.append({step, proposalId, subtask, refs: {jobId: terms.jobId, blockchainIdentifier, nonce, txHash}, reason, detail: {reconciled: true}});
        added.push(step);
      }
    } catch (error) {
      if (error.kind === 'not-found') continue;
      // The service is down or stuck. Asking about the rest would only wait out the same timeout for each.
      failures.push({blockchainIdentifier, reason: error.message});
      break;
    }
  }
  return {added, failures};
}
