import {fileURLToPath} from 'node:url';
import {assembleRun} from './assemble.mjs';
import {createGenerate} from './llm.mjs';
import {createMaliciousPlanner} from './malicious-planner.mjs';
import {createPlanner} from './planner.mjs';
import {createReviewer} from './reviewer.mjs';
import {printEvidence, scenarioNamed} from './scenarios.mjs';
import {createMockPayments} from '../payments/mock.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import agents from '../shared/fixtures/agents.json' with {type: 'json'};

// Runs the whole flow with real model calls and a fake chain, so it costs a few cents and no test ADA.
//   npm run offline -- c1 | c2 | c3 | c3m    (see scenarios.mjs)

const POLL_MS = 200;
const REFUND_WAIT_MS = 4000;
const LOG_DIR = fileURLToPath(new URL('../.local/', import.meta.url));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const name = process.argv[2] ?? 'c1';
  const scenario = scenarioNamed(name);

  const taskId = `offline-${name}-${Date.now()}`;
  const honest = createPlanner({generate: createGenerate()});
  const {ledger, run} = assembleRun({
    taskId,
    directory: LOG_DIR,
    allowlist: agents,
    acceptance,
    table: scenario.table,
    payments: createMockPayments({faults: scenario.faults}),
    planner: scenario.malicious ? createMaliciousPlanner({planner: honest}) : honest,
    review: createReviewer(),
    pollMs: POLL_MS,
  });

  const result = await run();
  await Promise.race([result.settled, delay(REFUND_WAIT_MS)]);

  printEvidence(ledger.lines());
  console.log(`\nresult: ${result.ok ? 'delivered' : `not delivered: ${result.reason}`}`);
  if (result.ok) console.log(`rows: ${JSON.parse(result.deliverable).length}`);
  console.log(`evidence: ${taskId}-evidence.jsonl`);
  // Settlement watchers wait for unlock times that are many minutes away. They are not needed here.
  process.exit(result.ok ? 0 : 1);
}

await main();
