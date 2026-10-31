import {join} from 'node:path';
import {createHirer} from './hire.mjs';
import {createLedger} from './ledger.mjs';
import {loadOrCreateMandate} from './mandate.mjs';
import {createPurchaser} from './purchaser.mjs';
import {withOwnerDecisions} from './owner-decisions.mjs';
import {orchestrate} from './run.mjs';

// Wires one task from its parts. Files are named by task id, so a restart with the same id
// finds the same mandate and the same evidence, and the evidence shows what was already bought.
export function assembleRun({
  taskId,
  directory,
  allowlist,
  acceptance,
  table,
  payments,
  planner,
  review,
  trackRecords,
  frontDeskDeadline,
  limits,
  clock = Date.now,
  sleep,
  pollMs,
}) {
  const mandate = loadOrCreateMandate({
    path: join(directory, `${taskId}-mandate.json`),
    taskId,
    allowlist,
    acceptance,
    startedAt: clock(),
    frontDeskDeadline,
    limits,
  });
  const ledger = createLedger({path: join(directory, `${taskId}-evidence.jsonl`), taskId, clock});
  const purchaser = createPurchaser({mandate, ledger, purchase: payments.purchase, getPurchase: payments.getPurchase, clock});
  const hirer = createHirer({mandate, ledger, payments, purchaser, review: withOwnerDecisions(review, ledger), clock, sleep, pollMs});
  return {
    mandate,
    ledger,
    run: () => orchestrate({table, acceptance: mandate.acceptance, mandate, ledger, payments, planner, hirer, clock, trackRecords}),
  };
}
