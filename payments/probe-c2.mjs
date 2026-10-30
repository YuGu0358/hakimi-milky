import {randomBytes} from 'node:crypto';
import {appendFileSync, mkdirSync, readFileSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {accept} from '../orchestrator/acceptance.mjs';
import {guard} from '../orchestrator/guard.mjs';
import {deriveState} from '../orchestrator/ledger.mjs';
import {createMandate} from '../orchestrator/mandate.mjs';
import {NETWORK, USDM_UNIT} from '../shared/constants.mjs';
import {isConfirmed, jobPrompt, purchaseViewFrom, quoteFromStartJob} from '../shared/schemas.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import table from '../shared/fixtures/table.json' with {type: 'json'};
import {createMps} from '../specialists/mps.mjs';
import {ALLOWLIST_PATH} from '../specialists/paths.mjs';
import {PROFILES} from '../specialists/profiles.mjs';

// npm run probe:c2
// One real paid hire of the cheap agent that ends in a refund, to measure the path on Preprod.
// It spends test tokens from the purchasing wallet and needs MPS_URL, ADMIN_KEY and
// BLOCKFROST_API_KEY_PREPROD, with the specialists running and the cheap one on FAULT=drop_rows:2.
// Its calls to /purchase, its lookup and /purchase/request-refund have all run for real.

const POLL_MS = 15_000;
const RESULT_WAIT_MS = 25 * 60_000;
const REFUND_WAIT_MS = 45 * 60_000;
const FETCH_RESULT_WAIT_MS = 3 * 60_000;
const REFUND_REQUEST_WAIT_MS = 5 * 60_000;
const FINISHED = ['RefundWithdrawn', 'DisputedWithdrawn', 'Withdrawn'];

const LOG_DIR = fileURLToPath(new URL('../.local/', import.meta.url));
const LOG = `${LOG_DIR}probe-c2-${Date.now()}.jsonl`;
const log = (step, detail = {}) => {
  const line = JSON.stringify({ts: new Date().toISOString(), step, ...detail});
  appendFileSync(LOG, `${line}\n`);
  console.log(line);
};

const admin = createMps({baseUrl: process.env.MPS_URL, token: process.env.ADMIN_KEY});
const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
const agent = allowlist.find((entry) => entry.name === PROFILES.cheap.name);

async function buyerBalance(address) {
  const response = await fetch(`https://cardano-preprod.blockfrost.io/api/v0/addresses/${address}`, {
    headers: {project_id: process.env.BLOCKFROST_API_KEY_PREPROD},
  });
  const {amount = []} = await response.json();
  const of = (unit) => amount.find((item) => item.unit === unit)?.quantity ?? '0';
  return {lovelace: of('lovelace'), usdm: of(USDM_UNIT)};
}

const resolve = (blockchainIdentifier) =>
  admin('/purchase/resolve-blockchain-identifier', {network: NETWORK, blockchainIdentifier, includeHistory: 'true'});

const stateOf = (raw) => ({
  onChainState: raw.onChainState,
  nextAction: raw.NextAction?.requestedAction,
  errorType: raw.NextAction?.errorType ?? undefined,
  errorNote: raw.NextAction?.errorNote ?? undefined,
  txHash: raw.CurrentTransaction?.txHash,
  txStatus: raw.CurrentTransaction?.status,
  resultHash: raw.resultHash || undefined,
});

async function pollUntil(blockchainIdentifier, isDone, waitMs, label) {
  const deadline = Date.now() + waitMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const raw = await resolve(blockchainIdentifier);
      const state = JSON.stringify(stateOf(raw));
      if (state !== last) log('state', stateOf(raw));
      last = state;
      if (isDone(raw)) return raw;
    } catch (error) {
      log('poll_error', {message: error.message});
    }
    await sleep(POLL_MS);
  }
  log('timeout', {waitingFor: label});
  return null;
}

async function fetchResult(jobId) {
  const deadline = Date.now() + FETCH_RESULT_WAIT_MS;
  while (Date.now() < deadline) {
    const answer = await (await fetch(`${agent.apiBaseUrl}/status?job_id=${jobId}`)).json();
    if (answer.status === 'completed') return answer.result;
    await sleep(5_000);
  }
  return null;
}

async function requestRefund(blockchainIdentifier) {
  const deadline = Date.now() + REFUND_REQUEST_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      log('refund.requested', stateOf(await admin('/purchase/request-refund', {network: NETWORK, blockchainIdentifier})));
      return true;
    } catch (error) {
      log('refund.request_failed', {message: error.message});
      await sleep(POLL_MS);
    }
  }
  return false;
}

async function startJob(job, nonce) {
  const started = await fetch(`${agent.apiBaseUrl}/start_job`, {
    method: 'POST',
    body: JSON.stringify({identifier_from_purchaser: nonce, input_data: {prompt: jobPrompt(job)}}),
  });
  if (started.status !== 200) throw new Error(`start_job answered ${started.status}: ${await started.text()}`);
  return quoteFromStartJob(await started.json());
}

const placeOrder = (quote, nonce, price) =>
  admin('/purchase', {
    blockchainIdentifier: quote.blockchainIdentifier,
    network: NETWORK,
    paymentSourceType: quote.paymentSourceType,
    supportedPaymentSourceIndex: quote.supportedPaymentSourceIndex,
    inputHash: quote.inputHash,
    sellerVkey: quote.sellerVkey,
    agentIdentifier: quote.agentIdentifier,
    Amounts: [price],
    unlockTime: String(quote.unlockTime),
    externalDisputeUnlockTime: String(quote.externalDisputeUnlockTime),
    submitResultTime: String(quote.submitResultTime),
    payByTime: String(quote.payByTime),
    identifierFromPurchaser: nonce,
    metadata: JSON.stringify({probe: 'c2'}),
  });

async function main() {
  if (!agent) throw new Error(`${PROFILES.cheap.name} is not on the allowlist yet`);
  const {Wallets: wallets} = await admin('/wallet/list?walletType=Purchasing&take=100');
  const buyer = wallets[0].walletAddress;
  log('start', {agent: agent.name, log: LOG, buyerBefore: await buyerBalance(buyer)});

  const nonce = randomBytes(10).toString('hex');
  const job = {kind: 'normalize', table, acceptance, key: acceptance.key};
  const quote = await startJob(job, nonce);
  log('job.started', {jobId: quote.jobId, submitInMinutes: Math.round((quote.submitResultTime - Date.now()) / 60_000)});

  const now = Date.now();
  const mandate = createMandate({taskId: 'probe-c2', allowlist, acceptance, startedAt: now});
  const price = {unit: USDM_UNIT, amount: PROFILES.cheap.priceAmount};
  const decision = guard({mandate, ledger: deriveState([]), quote, price, prompt: jobPrompt(job), nonce, subtask: 'normalize', now});
  log('guard.checked', {ok: decision.ok, code: decision.code, reason: decision.reason});
  if (!decision.ok) throw new Error(`The guard refused the quote: ${decision.reason}`);

  const order = await placeOrder(quote, nonce, price);
  log('purchase.created', {id: order.id, ...stateOf(order)});

  const bid = quote.blockchainIdentifier;
  const hasResult = (raw) => raw.onChainState === 'ResultSubmitted' && raw.resultHash && isConfirmed(purchaseViewFrom(raw), 'ResultSubmitted');
  const submitted = await pollUntil(bid, hasResult, RESULT_WAIT_MS, 'the seller result');
  if (!submitted) throw new Error('No confirmed result in time');

  const result = await fetchResult(quote.jobId);
  const verdict = accept({kind: 'normalize', spec: acceptance, inputTable: table, resultText: result ?? '', nonce, onChainResultHash: submitted.resultHash});
  log('acceptance', {ok: verdict.ok, failures: verdict.failures.map(({code, skus}) => ({code, skus}))});
  if (verdict.ok) throw new Error('Acceptance passed: is the cheap agent running with FAULT=drop_rows:2?');

  if (!(await requestRefund(bid))) throw new Error('The refund request never went through');
  const finished = await pollUntil(bid, (raw) => FINISHED.includes(raw.onChainState), REFUND_WAIT_MS, 'the money to come back');
  log('finished', {
    onChainState: finished?.onChainState ?? 'not finished',
    current: finished?.CurrentTransaction?.txHash,
    history: (finished?.TransactionHistory ?? []).map((tx) => ({txHash: tx.txHash, state: tx.newOnChainState, status: tx.status})),
    buyerAfter: await buyerBalance(buyer),
  });
}

mkdirSync(LOG_DIR, {recursive: true});
try {
  await main();
} catch (error) {
  log('failed', {message: error.message});
  process.exitCode = 1;
}
