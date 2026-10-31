import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {createHirer} from './hire.mjs';
import {createLedger} from './ledger.mjs';
import {createGenerate} from './llm.mjs';
import {EVIDENCE_DIR} from './live-parts.mjs';
import {loadOrCreateMandate} from './mandate.mjs';
import {withOwnerDecisions} from './owner-decisions.mjs';
import {createPlanner} from './planner.mjs';
import {createPurchaser} from './purchaser.mjs';
import {createReviewer} from './reviewer.mjs';
import {requireSavedRuntimeToken} from '../frontdesk/registration-config.mjs';
import {OLDER_TOKEN_PATH} from '../payments/buyer-key.mjs';
import {createPayments} from '../payments/payments.mjs';
import {checkAdmission} from '../registry/allow.mjs';
import {readPins} from '../registry/pins.mjs';
import {createBlockfrost} from '../shared/blockfrost.mjs';
import {USDM_UNIT} from '../shared/constants.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};

// npm run third-party -- <agentIdentifier> --field <inputField> --ask <text> [--name <name>] [--task <taskId>]
// Hires one agent we do not run, through the same planner, guard, reviewer and escrow as our own, on a
// mandate of its own. A stranger's deadlines are long, so this mandate allows a long lock and little money.

const LIMITS = Object.freeze({budget: '50000', perHire: '50000', maxHires: 1});
const DELIVER_MINUTES = 5 * 60;
const LOCK_MINUTES = 16 * 60;
const POLL_MS = 15_000;

async function main() {
  const {positionals, values} = parseArgs({
    allowPositionals: true,
    options: {field: {type: 'string'}, ask: {type: 'string'}, name: {type: 'string', default: 'Hired researcher'}, task: {type: 'string'}},
  });
  const [agentIdentifier] = positionals;
  if (!agentIdentifier || !values.field || !values.ask) throw new Error('Usage: npm run third-party -- <agentIdentifier> --field <inputField> --ask <text>');
  const taskId = values.task ?? `live-third-party-${Date.now()}`;
  const get = createBlockfrost({key: process.env.BLOCKFROST_API_KEY_PREPROD});
  const {onchain_metadata: metadata, quantity} = await get(`/assets/${agentIdentifier}`);
  const [holder] = await get(`/assets/${agentIdentifier}/addresses?order=desc&count=1`);
  const {entry, refused, reason} = checkAdmission({
    agentIdentifier,
    quantity,
    metadata,
    holderAddress: holder?.address,
    role: 'research',
    alias: values.name,
    shareTable: true,
    limits: {perHire: {[USDM_UNIT]: LIMITS.perHire}},
  });
  if (refused) throw new Error(`Refused (${refused}): ${reason}`);

  const mandate = loadOrCreateMandate({
    path: join(EVIDENCE_DIR, `${taskId}-mandate.json`),
    taskId,
    allowlist: [entry],
    acceptance,
    startedAt: Date.now(),
    limits: LIMITS,
    deliverMinutes: DELIVER_MINUTES,
    lockMinutes: LOCK_MINUTES,
  });
  const ledger = createLedger({path: join(EVIDENCE_DIR, `${taskId}-evidence.jsonl`), taskId});
  if (!ledger.lines().some(({step}) => step === 'mandate.confirmed')) ledger.append({step: 'mandate.confirmed', detail: {id: mandate.id}});
  const payments = createPayments({
    mpsUrl: process.env.MPS_URL,
    token: requireSavedRuntimeToken(OLDER_TOKEN_PATH),
    readAgents: (agentIdentifiers) => readPins({get, agentIdentifiers}),
  });
  const purchaser = createPurchaser({mandate, ledger, purchase: payments.purchase, getPurchase: payments.getPurchase});
  const hirer = createHirer({mandate, ledger, payments, purchaser, review: withOwnerDecisions(createReviewer(), ledger), pollMs: POLL_MS});
  const job = {kind: 'research', input: {[values.field]: values.ask}};
  const listings = (await payments.listAgents([agentIdentifier])).map((listing) => ({...listing, name: entry.name}));

  const [earlier] = Object.values(ledger.state().purchases);
  if (earlier) {
    const outcome = await hirer.resume(earlier, {job, listings});
    console.log(`Resumed: ${outcome.status}`);
    process.exit(0);
  }
  const planner = createPlanner({generate: createGenerate()});
  const {proposals, rejected} = await planner.plan({subtask: 'research', table: [{question: values.ask}], listings, feedback: []});
  rejected.forEach(({error}) => ledger.append({step: 'plan.rejected', subtask: 'research', reason: error}));
  const [proposal] = proposals;
  if (!proposal) throw new Error('The planner proposed nothing');
  ledger.append({step: 'plan.proposed', proposalId: proposal.proposalId, subtask: proposal.subtask, reason: proposal.reason, detail: {agentIdentifier: proposal.agentIdentifier, maxPrice: proposal.maxPrice}});

  const outcome = await hirer.hire({proposal, job, listings});
  console.log(`Outcome: ${outcome.status}${outcome.code ? ` ${outcome.code}` : ''}${outcome.reason ? `: ${outcome.reason}` : ''}`);
  ledger.append(outcome.status === 'accepted' ? {step: 'run.delivered'} : {step: 'run.failed', reason: outcome.reason ?? outcome.status});
  if (outcome.status === 'accepted') console.log(outcome.result.slice(0, 1500));
  console.log(`evidence: ${taskId}-evidence.jsonl. The seller collects after the escrow unlocks: run this again with --task ${taskId}.`);
  process.exit(outcome.status === 'accepted' ? 0 : 1);
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
