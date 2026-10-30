import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {parseArgs} from 'node:util';
import {DEMO_LIMITS} from '../orchestrator/mandate.mjs';
import {createBlockfrost} from '../shared/blockfrost.mjs';
import {USDM_UNIT} from '../shared/constants.mjs';
import {checkAdmission} from './allow.mjs';
import {OWNER_PINS_PATH} from './paths.mjs';

// npm run registry:allow -- <agentIdentifier> <normalize|copy> --share-table [--name <name>] [--dry-run]
// Puts one agent on the owner's list. It reads the chain, calls no agent and buys nothing.

const SUFFIX_LENGTH = 8;

const readPins = () => (existsSync(OWNER_PINS_PATH) ? JSON.parse(readFileSync(OWNER_PINS_PATH, 'utf8')) : []);

function savePins(pins) {
  mkdirSync(dirname(OWNER_PINS_PATH), {recursive: true, mode: 0o700});
  const draft = `${OWNER_PINS_PATH}.tmp`;
  writeFileSync(draft, JSON.stringify(pins, null, 2), {mode: 0o600});
  renameSync(draft, OWNER_PINS_PATH);
}

async function main() {
  const {positionals, values} = parseArgs({
    allowPositionals: true,
    options: {'share-table': {type: 'boolean', default: false}, 'dry-run': {type: 'boolean', default: false}, name: {type: 'string'}},
  });
  const [agentIdentifier, role] = positionals;
  if (!agentIdentifier || !role) throw new Error('Usage: npm run registry:allow -- <agentIdentifier> <normalize|copy> --share-table [--name <name>] [--dry-run]');
  const get = createBlockfrost({key: process.env.BLOCKFROST_API_KEY_PREPROD});
  const {onchain_metadata: metadata, quantity} = await get(`/assets/${agentIdentifier}`);
  const [holder] = quantity === '0' ? [] : await get(`/assets/${agentIdentifier}/addresses?order=desc&count=1`);
  const {entry, refused, reason} = checkAdmission({
    agentIdentifier,
    quantity,
    metadata,
    holderAddress: holder?.address,
    role,
    alias: values.name ?? `pin-${agentIdentifier.slice(-SUFFIX_LENGTH)}`,
    shareTable: values['share-table'],
    limits: {perHire: {[USDM_UNIT]: DEMO_LIMITS.perHire}},
  });
  if (refused) throw new Error(`Refused (${refused}): ${reason}`);
  console.log(`${entry.name}, for ${entry.role}, at ${new URL(entry.apiBaseUrl).hostname}`);
  console.log('The owner\'s table will be sent to this address before any payment. A refund after a result needs the seller\'s agreement.');
  if (values['dry-run']) {
    console.log('Dry run: nothing was saved.');
    return;
  }
  savePins([...readPins().filter((pin) => pin.agentIdentifier !== entry.agentIdentifier), entry]);
  console.log(`Saved to ${OWNER_PINS_PATH}. New runs can now hire it.`);
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
