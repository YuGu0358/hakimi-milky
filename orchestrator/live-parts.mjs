import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createGenerate} from './llm.mjs';
import {createPlanner} from './planner.mjs';
import {createReviewer} from './reviewer.mjs';
import {requireSavedRuntimeToken} from '../frontdesk/registration-config.mjs';
import {BUYER_TOKEN_PATH} from '../payments/buyer-key.mjs';
import {createPayments} from '../payments/payments.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import {ALLOWLIST_PATH} from '../specialists/paths.mjs';
import {TRACK_RECORDS_PATH} from '../track-record/track-record.mjs';

// The real Payment Service, the real models and the owner's list of agents, for one task on Preprod.

export const EVIDENCE_DIR = fileURLToPath(new URL('../.local/', import.meta.url));
const LIVE_POLL_MS = 15_000;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

export function createLiveParts() {
  const allowlist = readJson(ALLOWLIST_PATH);
  return {
    directory: EVIDENCE_DIR,
    allowlist,
    acceptance,
    payments: createPayments({
      mpsUrl: process.env.MPS_URL,
      token: requireSavedRuntimeToken(BUYER_TOKEN_PATH),
      blockfrostKey: process.env.BLOCKFROST_API_KEY_PREPROD,
      knownAgentIds: allowlist.map(({agentIdentifier}) => agentIdentifier),
    }),
    planner: createPlanner({generate: createGenerate()}),
    review: createReviewer(),
    trackRecords: existsSync(TRACK_RECORDS_PATH) ? readJson(TRACK_RECORDS_PATH) : {},
    pollMs: LIVE_POLL_MS,
  };
}
