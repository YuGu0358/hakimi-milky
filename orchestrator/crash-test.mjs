import {spawn} from 'node:child_process';
import {appendFileSync, existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';

// npm run crash-test
// A real run on Preprod, killed with no warning as soon as its orders have gone out, then started
// again with the same task. One order per job means the restart bought nothing twice. It spends
// test tokens, so top up the key first. The money settles later; run npm run reconcile for that.

const LIVE = fileURLToPath(new URL('./run-live.mjs', import.meta.url));
const DIRECTORY = fileURLToPath(new URL('../.local/', import.meta.url));
const JOBS = 2;
const POLL_MS = 500;
const WAIT_FOR_ORDERS_MS = 5 * 60_000;
const WAIT_FOR_DELIVERY_MS = 30 * 60_000;
const PAUSE_BEFORE_RESTART_MS = 3_000;

const stamp = () => new Date().toTimeString().slice(0, 8);
const count = (lines, step) => lines.filter((line) => line.step === step).length;

export function orderCounts(lines) {
  const locksByOrder = lines.filter(({step}) => step === 'purchase.funds_locked').map(({refs}) => refs.blockchainIdentifier);
  return {
    reservations: count(lines, 'purchase.reserved'),
    distinctOrders: new Set(lines.filter(({step}) => step === 'purchase.reserved').map(({refs}) => refs.blockchainIdentifier)).size,
    locks: locksByOrder.length,
    doubleLocks: locksByOrder.length - new Set(locksByOrder).size,
  };
}

export function verdictOf({counts, delivered, jobs}) {
  const passed = delivered && counts.distinctOrders === jobs && counts.reservations === jobs && counts.doubleLocks === 0;
  const orders = `${counts.distinctOrders} orders for ${jobs} jobs, ${counts.locks} locks, ${delivered ? 'delivered' : 'not delivered'}`;
  return {passed, text: passed ? `PASSED: ${orders}, nothing bought twice` : `FAILED: ${orders}`};
}

async function main() {
  const taskId = `live-c6-${Date.now()}`;
  const evidencePath = join(DIRECTORY, `${taskId}-evidence.jsonl`);
  const logPath = join(DIRECTORY, `${taskId}-crash-test.log`);
  const log = (text) => {
    const line = `${stamp()} ${text}`;
    console.log(line);
    appendFileSync(logPath, `${line}\n`);
  };
  const readLines = () => (existsSync(evidencePath) ? readFileSync(evidencePath, 'utf8').split('\n').filter(Boolean).map((text) => JSON.parse(text)) : []);
  const start = () => {
    const child = spawn(process.execPath, [LIVE, 'c1', taskId], {env: process.env, stdio: ['ignore', 'pipe', 'pipe']});
    const relay = (chunk) => String(chunk).split('\n').filter(Boolean).forEach((text) => log(`  ${text}`));
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    return {child, exited: new Promise((resolve) => child.once('exit', resolve))};
  };
  const waitFor = async (isDone, waitMs, what) => {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (isDone(readLines())) return;
      await sleep(POLL_MS);
    }
    throw new Error(`Timed out waiting for ${what}`);
  };

  log(`Task ${taskId}. Starting the run.`);
  const first = start();
  await waitFor((lines) => count(lines, 'purchase.created') >= JOBS, WAIT_FOR_ORDERS_MS, 'the orders to go out');
  log(`Both orders have gone out. Killing the process ${first.child.pid} with no warning.`);
  first.child.kill('SIGKILL');
  await first.exited;
  log(`Killed. The evidence holds ${readLines().length} lines. ${JSON.stringify(orderCounts(readLines()))}`);
  await sleep(PAUSE_BEFORE_RESTART_MS);

  log('Starting again with the same task.');
  const second = start();
  await waitFor((lines) => count(lines, 'run.delivered') + count(lines, 'run.failed') > 0, WAIT_FOR_DELIVERY_MS, 'the run to end');
  const lines = readLines();
  const counts = orderCounts(lines);
  const {passed, text} = verdictOf({counts, delivered: count(lines, 'run.delivered') > 0, jobs: JOBS});
  log(JSON.stringify(counts));
  log(text);
  second.child.kill();
  await second.exited;
  log('Stopped watching. The sellers collect after the escrow unlocks: npm run reconcile records it.');
  process.exitCode = passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
