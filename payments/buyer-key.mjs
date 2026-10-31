import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {NETWORK, PAYMENT_SOURCE_TYPE, USDM_UNIT} from '../shared/constants.mjs';
import {createMps} from '../specialists/mps.mjs';

// The orchestrator's Payment Service key, separate from the guard: even if our own code went wrong,
// this key cannot spend more than one run's budget, on another network, or from another wallet.
//   npm run payments:key            create it once
//   npm run payments:key -- top-up  refill it to the run limit before another run
// Credits are spent at the order and do not come back with a refund, so each run needs a top-up.

export const RUN_LIMIT = '800000';

export const BUYER_DIR = fileURLToPath(new URL('../.local/payments/', import.meta.url));
export const BUYER_TOKEN_PATH = `${BUYER_DIR}mps-runtime.env`;
export const OLDER_TOKEN_PATH = `${BUYER_DIR}older-runtime.env`;
const BUYER_STATE_PATH = `${BUYER_DIR}key.json`;

const EMPTY_STATE = Object.freeze({});
const isRefusal = (error) => error.status >= 400 && error.status < 500;

function writePrivateFile(path, text) {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  writeFileSync(path, text, {mode: 0o600});
}

const keyRequest = (walletId) => ({
  usageLimited: 'true',
  UsageCredits: [{unit: USDM_UNIT, amount: RUN_LIMIT}],
  NetworkLimit: [NETWORK],
  ChainIdLimit: [],
  canRead: true,
  canPay: true,
  canAdmin: false,
  walletScopeEnabled: true,
  WalletScopeHotWalletIds: [walletId],
  x402WalletScopeEnabled: true,
  X402WalletScopeEvmWalletIds: [],
});

export function createBuyerKeys({request, statePath, tokenPath}) {
  const load = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : EMPTY_STATE);
  const save = (state) => writePrivateFile(statePath, JSON.stringify(state, null, 2));

  async function purchasingWallet() {
    const {PaymentSources: sources} = await request('/payment-source?take=100');
    const source = sources.find(({network, paymentSourceType}) => network === NETWORK && paymentSourceType === PAYMENT_SOURCE_TYPE);
    if (!source) throw new Error(`No ${PAYMENT_SOURCE_TYPE} payment source on ${NETWORK}`);
    const {Wallets: wallets} = await request(`/wallet/list?walletType=Purchasing&paymentSourceId=${encodeURIComponent(source.id)}&take=100`);
    if (wallets.length !== 1) throw new Error(`Expected one purchasing wallet, found ${wallets.length}`);
    return wallets[0];
  }

  async function createKey(walletId) {
    save({...load(), walletId, keyWritePending: true});
    try {
      return await request('/api-key', keyRequest(walletId));
    } catch (error) {
      if (isRefusal(error)) save({...load(), keyWritePending: false});
      throw error;
    }
  }

  async function ensure() {
    const state = load();
    if (state.keyId) return {created: false, id: state.keyId};
    if (state.keyWritePending) throw new Error('An earlier key write has an unknown outcome. Look at the API keys in the Payment Service before trying again.');
    const wallet = await purchasingWallet();
    const key = await createKey(wallet.id);
    save({...load(), keyId: key.id, keyWritePending: false});
    if (typeof key.token !== 'string' || key.token.startsWith('*****')) throw new Error(`The token of key ${key.id} was not revealed. Update the key's token in the Payment Service.`);
    writePrivateFile(tokenPath, `MPS_RUNTIME_TOKEN=${key.token}\n`);
    return {created: true, id: key.id};
  }

  async function setCredit(amount) {
    const {keyId} = load();
    if (!keyId) throw new Error('There is no buyer key yet. Create it first.');
    const {ApiKeys: keys} = await request('/api-key?take=100');
    const credit = keys.find(({id}) => id === keyId)?.RemainingUsageCredits?.find(({unit}) => unit === USDM_UNIT);
    const before = credit?.amount ?? '0';
    const difference = BigInt(amount) - BigInt(before);
    if (difference !== 0n) {
      await request('/api-key', {id: keyId, UsageCreditsToAddOrRemove: [{unit: USDM_UNIT, amount: String(difference)}]}, {method: 'PATCH'});
    }
    return {before, after: amount};
  }

  return {ensure, setCredit, topUp: () => setCredit(RUN_LIMIT)};
}

export const savedKeys = ({baseUrl, adminKey}) =>
  createBuyerKeys({
    request: createMps({baseUrl, token: adminKey}),
    statePath: BUYER_STATE_PATH,
    tokenPath: BUYER_TOKEN_PATH,
  });

export const refillBuyerKey = (connection) => savedKeys(connection).topUp();

async function main([command = 'create']) {
  if (!process.env.ADMIN_KEY) throw new Error('Set ADMIN_KEY');
  const keys = savedKeys({baseUrl: process.env.MPS_URL, adminKey: process.env.ADMIN_KEY});
  if (command === 'create') {
    const {created, id} = await keys.ensure();
    console.log(created ? `Buyer key created: ${id}` : `Buyer key already saved: ${id}`);
    return;
  }
  if (command === 'top-up') {
    const {before, after} = await keys.topUp();
    console.log(`Buyer key credit: ${before} before, ${after} now`);
    return;
  }
  throw new Error('Usage: create | top-up');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
