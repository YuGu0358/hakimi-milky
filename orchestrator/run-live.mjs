import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assembleRun} from './assemble.mjs';
import {createGenerate} from './llm.mjs';
import {createMaliciousPlanner} from './malicious-planner.mjs';
import {createPlanner} from './planner.mjs';
import {createReviewer} from './reviewer.mjs';
import {printEvidence, scenarioNamed} from './scenarios.mjs';
import {requireSavedRuntimeToken} from '../frontdesk/registration-config.mjs';
import {acquireWorkerLock} from '../frontdesk/worker-lock.mjs';
import {BUYER_TOKEN_PATH} from '../payments/buyer-key.mjs';
import {createPayments} from '../payments/payments.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import {ALLOWLIST_PATH} from '../specialists/paths.mjs';

// The whole flow against the real Payment Service and Preprod. It spends test tokens.
//   npm run live -- c1
//   npm run live -- c1 <taskId>    resume a task after a crash
// c2 needs the cheap agent started with FAULT=drop_rows:2.

const LOG_DIR = fileURLToPath(new URL('../.local/', import.meta.url));
const TRACK_RECORDS_PATH = join(LOG_DIR, 'track-records.json');
const LIVE_POLL_MS = 15_000;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

async function main([name = 'c1', givenTaskId]) {
  const scenario = scenarioNamed(name);
  const taskId = givenTaskId ?? `live-${name}-${Date.now()}`;
  // One process per task, so a second one cannot resume the same purchases. Other tasks have
  // their own mandate, and the buyer key's credit still caps what all of them spend together.
  const release = acquireWorkerLock(join(LOG_DIR, 'locks', `${taskId}.lock`));
  process.once('exit', release);
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
  console.log(`Task ${taskId}. To resume after a crash: npm run live -- ${name} ${taskId}`);

  const allowlist = readJson(ALLOWLIST_PATH);
  const honest = createPlanner({generate: createGenerate()});
  const {ledger, run} = assembleRun({
    taskId,
    directory: LOG_DIR,
    allowlist,
    acceptance,
    table: scenario.table,
    payments: createPayments({
      mpsUrl: process.env.MPS_URL,
      token: requireSavedRuntimeToken(BUYER_TOKEN_PATH),
      blockfrostKey: process.env.BLOCKFROST_API_KEY_PREPROD,
      knownAgentIds: allowlist.map(({agentIdentifier}) => agentIdentifier),
    }),
    planner: scenario.malicious ? createMaliciousPlanner({planner: honest}) : honest,
    review: createReviewer(),
    trackRecords: existsSync(TRACK_RECORDS_PATH) ? readJson(TRACK_RECORDS_PATH) : {},
    pollMs: LIVE_POLL_MS,
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
