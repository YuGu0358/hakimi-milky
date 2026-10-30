import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {BUYER_TOKEN_PATH, savedKeys} from './buyer-key.mjs';
import {createPayments, orderBody} from './payments.mjs';
import {requireSavedRuntimeToken} from '../frontdesk/registration-config.mjs';
import {NETWORK, USDM_UNIT} from '../shared/constants.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import table from '../shared/fixtures/table.json' with {type: 'json'};
import {PaymentsError} from '../shared/errors.mjs';
import {createMps} from '../specialists/mps.mjs';
import {ALLOWLIST_PATH} from '../specialists/paths.mjs';
import {PROFILES} from '../specialists/profiles.mjs';

// Three calls the Payment Service has to refuse with the orchestrator's key, whatever our own code
// does. It shows the limit holds underneath the guard, in the service that signs the transactions.
//   npm run rejections
// It lowers the key's credit for a moment, so never run it during a paid task. It needs MPS_URL,
// ADMIN_KEY, BLOCKFROST_API_KEY_PREPROD and the specialists running. No money moves.

export const LOW_CREDIT = '100000'; // below every price, so a real order cannot go through

const REPORT_PATH = fileURLToPath(new URL('../.local/rejections.json', import.meta.url));
const SAMPLE_ROWS = 2;
const METADATA = Object.freeze({purpose: 'a call the Payment Service has to refuse'});

const iso = (ms) => new Date(ms).toISOString();

const sellerTerms = (quote) => ({
  network: NETWORK,
  agentIdentifier: quote.agentIdentifier,
  paymentSourceType: quote.paymentSourceType,
  supportedPaymentSourceIndex: quote.supportedPaymentSourceIndex,
  inputHash: quote.inputHash,
  identifierFromPurchaser: quote.identifierFromPurchaser,
  payByTime: iso(quote.payByTime),
  submitResultTime: iso(quote.submitResultTime),
  unlockTime: iso(quote.unlockTime),
  externalDisputeUnlockTime: iso(quote.externalDisputeUnlockTime),
});

const ATTEMPTS = Object.freeze([
  {
    name: 'An order above what the key may still spend',
    expected: {status: 400, text: 'Insufficient funds'},
    send: ({request, quote, price}) => request('/purchase', orderBody(quote, METADATA, [price])),
  },
  {
    name: "A seller's payment request, with the buyer's key",
    expected: {status: 404},
    send: ({request, quote}) => request('/payment', sellerTerms(quote)),
  },
  {
    name: 'An order on Mainnet',
    expected: {status: 401},
    send: ({request, quote, price}) => request('/purchase', orderBody(quote, METADATA, [price], 'Mainnet')),
  },
]);

async function tryOne({name, expected, send}, context) {
  try {
    await send(context);
    return {name, expected, actual: {status: 200, message: 'The service accepted it'}, ok: false};
  } catch (error) {
    if (!(error instanceof PaymentsError)) throw error;
    const ok = error.status === expected.status && error.message.includes(expected.text ?? '');
    return {name, expected, actual: {status: error.status, message: error.message}, ok};
  }
}

export async function runRejections({request, keys, quote, price}) {
  const {before} = await keys.setCredit(LOW_CREDIT);
  try {
    const attempts = [];
    for (const attempt of ATTEMPTS) attempts.push(await tryOne(attempt, {request, quote, price}));
    return attempts;
  } finally {
    await keys.setCredit(before);
  }
}

async function main() {
  if (!process.env.ADMIN_KEY) throw new Error('Set ADMIN_KEY');
  const token = requireSavedRuntimeToken(BUYER_TOKEN_PATH);
  const {cheap} = PROFILES;
  const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  const listing = allowlist.find(({name}) => name === cheap.name);
  if (!listing) throw new Error(`${cheap.name} is not on the allowlist`);
  const payments = createPayments({mpsUrl: process.env.MPS_URL, token, blockfrostKey: process.env.BLOCKFROST_API_KEY_PREPROD});
  const job = {kind: cheap.role, table: table.slice(0, SAMPLE_ROWS), acceptance, key: acceptance.key};
  const quote = await payments.startJob(listing, job, randomBytes(10).toString('hex'));
  const attempts = await runRejections({
    request: createMps({baseUrl: process.env.MPS_URL, token}),
    keys: savedKeys({baseUrl: process.env.MPS_URL, adminKey: process.env.ADMIN_KEY}),
    quote,
    price: {unit: USDM_UNIT, amount: cheap.priceAmount},
  });
  mkdirSync(dirname(REPORT_PATH), {recursive: true, mode: 0o700});
  writeFileSync(REPORT_PATH, JSON.stringify({ranAt: new Date().toISOString(), attempts}, null, 2), {mode: 0o600});
  for (const {name, ok, actual} of attempts) {
    console.log(`${ok ? 'refused' : 'NOT AS EXPECTED'}  ${name}\n         ${actual.message}`);
  }
  if (!attempts.every(({ok}) => ok)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
