import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {ESCROW_CONTRACT} from '../shared/constants.mjs';
import {ALLOWLIST_PATH} from '../specialists/paths.mjs';
import {createBlockfrost} from '../shared/blockfrost.mjs';

// What each agent did with its past jobs, read from the escrow contract on Preprod. Only the chain
// writes this record, so an agent cannot talk its way into a better one.
//   npm run track-record
// The planner reads the result on its next run. It needs BLOCKFROST_API_KEY_PREPROD.
// Plain fetch instead of the Blockfrost SDK: its got 11 retries are what stopped the Payment Service.

export const TRACK_RECORDS_PATH = fileURLToPath(new URL('../.local/track-records.json', import.meta.url));
const CACHE_PATH = fileURLToPath(new URL('../.local/track-record-cache.json', import.meta.url));

const PAGE_SIZE = 100;
const FIRST_READ_LIMIT = 300;
const PAUSE_BETWEEN_READS_MS = 300;

const AGENT_FIELD = 8; // agent_identifier in the V2 contract's Datum
const OUTCOME_OF_ACTION = Object.freeze({0: 'completed', 3: 'refunded', 4: 'disputed'}); // Withdraw, WithdrawRefund, the dispute's end

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Newest first, back to the first transaction already known, because everything older was read before.
// Only the very first read has a limit: a limit later on would leave a gap that is never read.
export async function unreadTransactions({get, cache = {}, address = ESCROW_CONTRACT, limit = FIRST_READ_LIMIT}) {
  const isFirstRead = Object.keys(cache).length === 0;
  const unread = [];
  for (let page = 1; ; page += 1) {
    const rows = await get(`/addresses/${address}/transactions?order=desc&count=${PAGE_SIZE}&page=${page}`);
    const hashes = rows.map(({tx_hash: hash}) => hash);
    const firstKnown = hashes.findIndex((hash) => Object.hasOwn(cache, hash));
    unread.push(...(firstKnown < 0 ? hashes : hashes.slice(0, firstKnown)));
    if (isFirstRead && unread.length >= limit) return {hashes: unread.slice(0, limit), truncated: rows.length === PAGE_SIZE || unread.length > limit};
    if (firstKnown >= 0 || rows.length < PAGE_SIZE) return {hashes: unread, truncated: false};
  }
}

const byOutputReference = (a, b) => {
  if (a.tx_hash !== b.tx_hash) return a.tx_hash < b.tx_hash ? -1 : 1;
  return a.output_index - b.output_index;
};

// A redeemer names its input by position in the ledger's sorted list, which leaves out collateral and reference inputs.
export async function spendsOf({get, txHash, address = ESCROW_CONTRACT}) {
  const redeemers = (await get(`/txs/${txHash}/redeemers`)).filter(({purpose}) => purpose === 'spend');
  if (redeemers.length === 0) return [];
  const {inputs} = await get(`/txs/${txHash}/utxos`);
  const spent = inputs.filter(({collateral, reference}) => !collateral && !reference).sort(byOutputReference);
  const spends = await Promise.all(
    redeemers.map(async ({tx_index: index, redeemer_data_hash: redeemerHash}) => {
      const input = spent[index];
      if (input?.address !== address || !input.data_hash) return null;
      const [datum, redeemer] = await Promise.all([get(`/scripts/datum/${input.data_hash}`), get(`/scripts/datum/${redeemerHash}`)]);
      const agentIdentifier = datum.json_value?.fields?.[AGENT_FIELD]?.bytes;
      const action = redeemer.json_value?.constructor;
      // Anyone can write to the contract, so a value of the wrong shape is skipped, not trusted.
      return typeof agentIdentifier === 'string' && agentIdentifier !== '' && Number.isInteger(action) ? {agentIdentifier, action} : null;
    }),
  );
  return spends.filter(Boolean);
}

export function tally(spends) {
  return spends.reduce((records, {agentIdentifier, action}) => {
    const outcome = OUTCOME_OF_ACTION[action];
    if (!outcome || !agentIdentifier) return records;
    const record = records[agentIdentifier] ?? {completed: 0, refunded: 0, disputed: 0};
    return {...records, [agentIdentifier]: {...record, [outcome]: record[outcome] + 1}};
  }, {});
}

// A transaction on chain does not change, so each one is read once and counts for good. Counting only the
// newest ones would wash an agent's refunds off its record as other people's traffic pushes them out.
export async function buildTrackRecords({get, cache = {}, limit = FIRST_READ_LIMIT, pause = async () => {}}) {
  const {hashes, truncated} = await unreadTransactions({get, cache, limit});
  const read = [];
  for (const hash of hashes) {
    read.push([hash, await spendsOf({get, txHash: hash})]);
    await pause();
  }
  const nextCache = {...cache, ...Object.fromEntries(read)};
  return {records: tally(Object.values(nextCache).flat()), cache: nextCache, transactions: Object.keys(nextCache).length, newlyRead: hashes.length, truncated};
}

const readJsonIfThere = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  writeFileSync(path, JSON.stringify(value, null, 2), {mode: 0o600});
}

async function main() {
  if (!process.env.BLOCKFROST_API_KEY_PREPROD) throw new Error('Set BLOCKFROST_API_KEY_PREPROD');
  const {records, cache, transactions, newlyRead, truncated} = await buildTrackRecords({
    get: createBlockfrost({key: process.env.BLOCKFROST_API_KEY_PREPROD, minGapMs: 0}),
    cache: readJsonIfThere(CACHE_PATH, {}),
    pause: () => sleep(PAUSE_BETWEEN_READS_MS),
    limit: Number(process.argv[2]) || FIRST_READ_LIMIT,
  });
  writePrivateJson(CACHE_PATH, cache);
  writePrivateJson(TRACK_RECORDS_PATH, records);
  console.log(`${transactions} escrow transactions known, ${newlyRead} of them new. ${Object.keys(records).length} agents have a record.`);
  if (truncated) console.log(`This first read stopped at the newest ${newlyRead}. For more, delete ${CACHE_PATH} and pass a higher limit.`);
  for (const {name, agentIdentifier} of readJsonIfThere(ALLOWLIST_PATH, [])) {
    const {completed = 0, refunded = 0, disputed = 0} = records[agentIdentifier] ?? {};
    console.log(`${name.padEnd(28)} completed ${completed}, refunded ${refunded}, disputed ${disputed}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
