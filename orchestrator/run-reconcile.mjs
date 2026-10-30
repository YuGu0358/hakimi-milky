import {existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createLedger} from './ledger.mjs';
import {reconcileRun} from './reconcile.mjs';
import {requireSavedRuntimeToken} from '../frontdesk/registration-config.mjs';
import {BUYER_TOKEN_PATH} from '../payments/buyer-key.mjs';
import {createPayments} from '../payments/payments.mjs';

// npm run reconcile                 catch up every live run's evidence with the chain
// npm run reconcile -- <taskId>...  only these runs
// It reads the chain and adds evidence lines. It buys nothing.

const DIRECTORY = fileURLToPath(new URL('../.local/', import.meta.url));
const SUFFIX = '-evidence.jsonl';

const allTaskIds = () =>
  readdirSync(DIRECTORY)
    .filter((name) => name.endsWith(SUFFIX) && !name.startsWith('offline-'))
    .map((name) => name.slice(0, -SUFFIX.length));

async function main(givenTaskIds) {
  const payments = createPayments({
    mpsUrl: process.env.MPS_URL,
    token: requireSavedRuntimeToken(BUYER_TOKEN_PATH),
  });
  const taskIds = givenTaskIds.length > 0 ? givenTaskIds : allTaskIds();
  let failed = 0;
  for (const taskId of taskIds) {
    const path = join(DIRECTORY, `${taskId}${SUFFIX}`);
    if (!existsSync(path)) throw new Error(`No evidence for task ${taskId}`);
    const {added, failures} = await reconcileRun({ledger: createLedger({path, taskId}), getPurchase: payments.getPurchase});
    console.log(`${taskId}: ${added.length > 0 ? `added ${added.join(', ')}` : 'up to date'}`);
    failures.forEach(({reason}) => console.error(`  could not look: ${reason}`));
    failed += failures.length;
  }
  if (failed > 0) process.exitCode = 1;
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
