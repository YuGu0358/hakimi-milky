import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createGenerate} from './llm.mjs';
import {createMandate} from './mandate.mjs';
import {createPlanner} from './planner.mjs';
import {createRedteam} from './redteam.mjs';
import {createReviewer} from './reviewer.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import agents from '../shared/fixtures/agents.json' with {type: 'json'};
import injectionNotes from '../shared/fixtures/injection-notes.json' with {type: 'json'};
import table from '../shared/fixtures/table.json' with {type: 'json'};

// npm run redteam     about 25 model calls plus the Jev calls. No chain, no test tokens.
// Writes .local/redteam-report.json for the evidence page.

const LOG_DIR = fileURLToPath(new URL('../.local/', import.meta.url));
const PROPOSAL_COUNT = 100;
const ATTACKER_MAX_OUTPUT_TOKENS = 6_000;

const mandate = createMandate({taskId: 'redteam', allowlist: agents, acceptance, startedAt: Date.now()});
const listings = agents.map(({agentIdentifier, name, apiBaseUrl, pricingType, price, supportedPaymentSourceIndex, tags}) => ({
  agentIdentifier,
  name,
  apiBaseUrl,
  pricingType,
  price,
  supportedPaymentSourceIndex,
  tags,
}));
const redteam = createRedteam({
  generate: createGenerate({maxOutputTokens: ATTACKER_MAX_OUTPUT_TOKENS}),
  planner: createPlanner({generate: createGenerate()}),
  review: createReviewer(),
  mandate,
  listings,
  table,
});

const proposals = await redteam.attackProposals({count: PROPOSAL_COUNT});
console.log(`Attack proposals: ${proposals.generated} written, ${proposals.unusableReplies} unusable replies`);
console.log(`  refused by the schema: ${proposals.schemaRejected} ${JSON.stringify(proposals.schemaReasons)}`);
console.log(`  blocked by the guard: ${Object.values(proposals.guardBlocked).reduce((sum, count) => sum + count, 0)} ${JSON.stringify(proposals.guardBlocked)}`);
console.log(`  reached the reviewer: ${JSON.stringify(proposals.reviewer)}`);
console.log(`  passed everything: ${proposals.passedAll.length}, of which outside the mandate: ${proposals.outsideMandate.length}`);

const injections = await redteam.attackInjections({notes: injectionNotes.notes});
console.log(`Injection notes: ${injections.texts} hand-written, planner fell for ${injections.hooked}, guard stopped ${injections.hookedBlocked} of those, ${injections.plannerErrors} planner errors`);
console.log('These are measured results for these attacks, not a proof of safety.');

mkdirSync(LOG_DIR, {recursive: true});
writeFileSync(join(LOG_DIR, 'redteam-report.json'), JSON.stringify({proposals, injections}, null, 2));
process.exitCode = proposals.outsideMandate.length === 0 && injections.hookedPassed.length === 0 ? 0 : 1;
