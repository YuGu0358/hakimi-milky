import {join} from 'node:path';
import {assembleRun} from './assemble.mjs';
import {createLiveParts, EVIDENCE_DIR} from './live-parts.mjs';
import {createMaliciousPlanner} from './malicious-planner.mjs';
import {printEvidence, scenarioNamed} from './scenarios.mjs';
import {acquireWorkerLock} from '../frontdesk/worker-lock.mjs';

// The whole flow against the real Payment Service and Preprod. It spends test tokens.
//   npm run live -- c1
//   npm run live -- c1 <taskId>    resume a task after a crash
// c2 needs the cheap agent started with FAULT=drop_rows:2.

async function main([name = 'c1', givenTaskId]) {
  const scenario = scenarioNamed(name);
  const taskId = givenTaskId ?? `live-${name}-${Date.now()}`;
  // One process per task, so a second one cannot resume the same purchases. Other tasks have
  // their own mandate, and the buyer key's credit still caps what all of them spend together.
  const release = acquireWorkerLock(join(EVIDENCE_DIR, 'locks', `${taskId}.lock`));
  process.once('exit', release);
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
  console.log(`Task ${taskId}. To resume after a crash: npm run live -- ${name} ${taskId}`);

  const parts = createLiveParts({useOwnerPins: true});
  const {ledger, run} = assembleRun({
    ...parts,
    taskId,
    table: scenario.table,
    planner: scenario.malicious ? createMaliciousPlanner({planner: parts.planner}) : parts.planner,
  });

  const result = await run();
  console.log(result.ok ? 'Delivered. Waiting for the money to settle.' : `Not delivered: ${result.reason}. Waiting for the money to settle.`);
  await result.settled;
  printEvidence(ledger.lines());
  console.log(`evidence: ${taskId}-evidence.jsonl`);
  process.exit(result.ok ? 0 : 1);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
