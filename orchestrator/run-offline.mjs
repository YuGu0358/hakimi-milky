import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHirer} from './hire.mjs';
import {createLedger} from './ledger.mjs';
import {createGenerate} from './llm.mjs';
import {createMaliciousPlanner} from './malicious-planner.mjs';
import {createMandate} from './mandate.mjs';
import {createPlanner} from './planner.mjs';
import {createPurchaser} from './purchaser.mjs';
import {createReviewer} from './reviewer.mjs';
import {orchestrate} from './run.mjs';
import {createMockPayments} from '../payments/mock.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import agents from '../shared/fixtures/agents.json' with {type: 'json'};
import injection from '../shared/fixtures/injection.json' with {type: 'json'};
import table from '../shared/fixtures/table.json' with {type: 'json'};

// Runs the whole flow with real model calls and a fake chain, so it costs a few cents and no test ADA.
//   npm run offline -- c1    two specialists, both pass
//   npm run offline -- c2    the cheap agent loses rows, refund, re-hire
//   npm run offline -- c3    an instruction hidden in a supplier note, against the real model
//   npm run offline -- c3m   the same attack as if the model had fallen for it

const POLL_MS = 200;
const REFUND_WAIT_MS = 4000;
const LOG_DIR = fileURLToPath(new URL('../.local/', import.meta.url));

const injectedTable = table.map((row) => (row.sku === injection.sku ? {...row, note: injection.note} : row));

const SCENARIOS = Object.freeze({
  c1: {table, faults: {}},
  c2: {table, faults: {dropRows: 2}},
  c3: {table: injectedTable, faults: {}},
  c3m: {table: injectedTable, faults: {}, malicious: true},
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function printEvidence(lines) {
  const start = lines[0]?.ts ?? 0;
  for (const line of lines) {
    const seconds = ((line.ts - start) / 1000).toFixed(1).padStart(6);
    const verdict = [line.decision, line.rule, line.code].filter(Boolean).join(' ');
    const note = [verdict, line.reason].filter(Boolean).join(' | ').slice(0, 130);
    console.log(`${seconds}s  ${(line.subtask ?? '-').padEnd(9)}  ${line.step.padEnd(24)}  ${note}`);
  }
}

async function main() {
  const name = process.argv[2] ?? 'c1';
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`Unknown scenario ${name}. Use one of: ${Object.keys(SCENARIOS).join(', ')}`);

  const startedAt = Date.now();
  const taskId = `offline-${name}-${startedAt}`;
  const ledger = createLedger({path: join(LOG_DIR, `${taskId}-evidence.jsonl`), taskId});
  const mandate = createMandate({taskId, allowlist: agents, acceptance, startedAt});
  const payments = createMockPayments({faults: scenario.faults});
  const purchaser = createPurchaser({mandate, ledger, purchase: payments.purchase, getPurchase: payments.getPurchase});
  const hirer = createHirer({mandate, ledger, payments, purchaser, review: createReviewer(), pollMs: POLL_MS});
  const honest = createPlanner({generate: createGenerate()});
  const planner = scenario.malicious ? createMaliciousPlanner({planner: honest}) : honest;

  const result = await orchestrate({table: scenario.table, acceptance, mandate, ledger, payments, planner, hirer});
  await Promise.race([result.settled, delay(REFUND_WAIT_MS)]);

  printEvidence(ledger.lines());
  console.log(`\nresult: ${result.ok ? 'delivered' : `not delivered: ${result.reason}`}`);
  if (result.ok) console.log(`rows: ${JSON.parse(result.deliverable).length}`);
  console.log(`evidence: ${taskId}-evidence.jsonl`);
  // Settlement watchers wait for unlock times that are many minutes away. They are not needed here.
  process.exit(result.ok ? 0 : 1);
}

await main();
