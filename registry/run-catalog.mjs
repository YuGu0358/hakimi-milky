import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createBlockfrost} from '../shared/blockfrost.mjs';
import {readCatalog} from './catalog.mjs';

// npm run registry
// Counts every live agent in both registries. It reads the chain only, calls no agent and buys nothing.
// The first read takes minutes; after that only new agents are read. The names and addresses are text
// written by strangers, so they stay in the private file and are not printed.

const local = (name) => fileURLToPath(new URL(`../.local/${name}`, import.meta.url));
const CACHE_PATH = local('registry-metadata.json');
const CATALOG_PATH = local('registry-catalog.json');
const SUMMARY_PATH = local('registry-summary.json');
const PAUSE_BETWEEN_BATCHES_MS = 1_000; // Blockfrost allows 10 calls a second, shared with the Payment Service

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  writeFileSync(path, JSON.stringify(value, null, 2), {mode: 0o600});
}

async function main() {
  if (!process.env.BLOCKFROST_API_KEY_PREPROD) throw new Error('Set BLOCKFROST_API_KEY_PREPROD');
  const cache = new Map(existsSync(CACHE_PATH) ? Object.entries(JSON.parse(readFileSync(CACHE_PATH, 'utf8'))) : []);
  try {
    const {summary, entries} = await readCatalog({
      get: createBlockfrost({key: process.env.BLOCKFROST_API_KEY_PREPROD, minGapMs: 0}),
      cache,
      pause: () => sleep(PAUSE_BETWEEN_BATCHES_MS),
    });
    const readAt = new Date().toISOString();
    writePrivateJson(CATALOG_PATH, {readAt, summary, entries});
    writePrivateJson(SUMMARY_PATH, {readAt, summary});
    for (const {name, minted, live, fixedPrice, fixedPriceAndPublic, hireableHere, isConnected} of summary) {
      console.log(`${name.padEnd(8)} minted ${minted}, live ${live}, fixed price ${fixedPrice}, also a public address ${fixedPriceAndPublic}, hireable from here ${hireableHere}${isConnected ? '' : ' (contract not connected)'}`);
    }
    console.log(`Every agent is in ${CATALOG_PATH}`);
  } finally {
    writePrivateJson(CACHE_PATH, Object.fromEntries(cache));
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
