import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {registrationUrl, requireAgentAuthor, requireSavedRuntimeToken} from '../frontdesk/registration-config.mjs';
import {NETWORK, PAYMENT_SOURCE_TYPE, USDM_UNIT} from '../shared/constants.mjs';
import {PROFILES} from './profiles.mjs';

// Makes the specialists' Payment Service key and registers them, adapted from the starter's
// frontdesk/payment-registration.mjs. Each write is marked pending before it goes out.
// A write with an unknown outcome is never sent again: status looks for it first.

// Each agent advertises exactly one payment source.
const SOURCE_INDEX = 0;
const CONFIRMED = 'RegistrationConfirmed';
const EMPTY_STATE = Object.freeze({agents: {}});

const isRefusal = (error) => error.status >= 400 && error.status < 500;
const readState = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : EMPTY_STATE);

function writePrivateFile(path, text) {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  writeFileSync(path, text, {mode: 0o600});
}

export function confirmedRegistration(statePath, profileId) {
  const agent = readState(statePath).agents[profileId];
  return agent?.state === CONFIRMED ? agent : null;
}

export const buildRegistrationBody = ({profile, walletVkey, contractAddress, author}) => ({
  network: NETWORK,
  type: 'Standard',
  sellingWalletVkey: walletVkey,
  supportedPaymentSources: [
    {
      chain: 'Cardano',
      network: NETWORK,
      paymentSourceType: PAYMENT_SOURCE_TYPE,
      address: contractAddress,
      // No decimals: the Payment Service refuses them on Cardano fixed pricing.
      pricing: {pricingType: 'Fixed', fixed: [{asset: USDM_UNIT, amount: profile.priceAmount}]},
    },
  ],
  ExampleOutputs: [],
  Tags: [...profile.tags],
  name: profile.name,
  description: profile.description,
  Capability: {...profile.capability},
  Author: {name: author},
  apiBaseUrl: registrationUrl(profile.port),
});

const keyRequest = (walletId) => ({
  usageLimited: 'false',
  UsageCredits: [],
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

function chooseWallet(wallets, walletVkey) {
  if (wallets.length === 0) throw new Error('No selling wallet on the payment source');
  if (walletVkey) {
    const chosen = wallets.find((wallet) => wallet.walletVkey === walletVkey);
    if (!chosen) throw new Error('SELLING_WALLET_VKEY matches no selling wallet on the payment source');
    return chosen;
  }
  if (wallets.length > 1) throw new Error('There are several selling wallets. Set SELLING_WALLET_VKEY to choose one.');
  return wallets[0];
}

function findEntry(assets, saved, profile) {
  const byId = assets.find(({id}) => id === saved.registrationId);
  if (byId || !saved.writePending) return byId;
  return assets.find(({name, apiBaseUrl}) => name === profile.name && apiBaseUrl === registrationUrl(profile.port));
}

const agentFrom = (saved, entry, profile) => ({
  ...saved,
  registrationId: entry.id,
  writePending: false,
  state: entry.state,
  agentIdentifier: entry.agentIdentifier,
  sellerVkey: entry.SmartContractWallet?.walletVkey,
  supportedPaymentSourceIndex: SOURCE_INDEX,
  apiBaseUrl: registrationUrl(profile.port),
  name: profile.name,
  role: profile.role,
  error: entry.error ?? null,
});

const allowlistEntry = ({agentIdentifier, sellerVkey, name, apiBaseUrl, role}) => ({agentIdentifier, sellerVkey, name, apiBaseUrl, role});

export function createRegistrar({request, author, statePath, tokenPath, allowlistPath, sellingWalletVkey}) {
  const authorName = requireAgentAuthor(author);
  const load = () => readState(statePath);
  const save = (state) => {
    writePrivateFile(statePath, JSON.stringify(state, null, 2));
    return state;
  };
  const saveAgent = (profileId, change) => {
    const state = load();
    return save({...state, agents: {...state.agents, [profileId]: {...state.agents[profileId], ...change}}});
  };

  async function findSeller() {
    const {PaymentSources: sources} = await request('/payment-source?take=100');
    const source = sources.find(({network, paymentSourceType}) => network === NETWORK && paymentSourceType === PAYMENT_SOURCE_TYPE);
    if (!source) throw new Error(`No ${PAYMENT_SOURCE_TYPE} payment source on ${NETWORK}`);
    const {Wallets: wallets} = await request(`/wallet/list?walletType=Selling&paymentSourceId=${encodeURIComponent(source.id)}&take=100`);
    return {source, wallet: chooseWallet(wallets, sellingWalletVkey)};
  }

  async function createKey(walletId) {
    save({...load(), keyWritePending: true});
    try {
      return await request('/api-key', keyRequest(walletId));
    } catch (error) {
      if (isRefusal(error)) save({...load(), keyWritePending: false});
      throw error;
    }
  }

  async function ensureKey() {
    const state = load();
    if (state.runtimeKeyId) {
      requireSavedRuntimeToken(tokenPath);
      return {created: false, id: state.runtimeKeyId};
    }
    if (state.keyWritePending) throw new Error('An earlier key write has an unknown outcome. Look at the API keys in the Payment Service before trying again.');
    const {wallet} = await findSeller();
    const key = await createKey(wallet.id);
    save({
      ...load(),
      runtimeKeyId: key.id,
      keyWritePending: false,
      keyEvidence: {canRead: key.canRead, canPay: key.canPay, canAdmin: key.canAdmin, NetworkLimit: key.NetworkLimit},
    });
    if (typeof key.token !== 'string' || key.token.startsWith('*****')) throw new Error(`The token of key ${key.id} was not revealed. Update the key's token in the Payment Service.`);
    writePrivateFile(tokenPath, `MPS_RUNTIME_TOKEN=${key.token}\n`);
    return {created: true, id: key.id};
  }

  async function register(profile) {
    const saved = load().agents[profile.id];
    if (saved?.registrationId) return {created: false, id: saved.registrationId};
    if (saved?.writePending) throw new Error(`An earlier registration of ${profile.id} has an unknown outcome. Run status to look for it before trying again.`);
    const {source, wallet} = await findSeller();
    const body = buildRegistrationBody({profile, walletVkey: wallet.walletVkey, contractAddress: source.smartContractAddress, author: authorName});
    saveAgent(profile.id, {writePending: true});
    try {
      const entry = await request('/registry', body);
      saveAgent(profile.id, {registrationId: entry.id, writePending: false, state: entry.state});
      return {created: true, id: entry.id};
    } catch (error) {
      if (isRefusal(error)) saveAgent(profile.id, {writePending: false, lastError: error.message});
      throw error;
    }
  }

  async function refresh() {
    const state = load();
    const {Assets: assets} = await request(`/registry?network=${NETWORK}&filterPaymentSourceType=${PAYMENT_SOURCE_TYPE}&limit=100`);
    const agents = Object.values(PROFILES).reduce((current, profile) => {
      const saved = current[profile.id];
      const entry = saved && findEntry(assets, saved, profile);
      return entry ? {...current, [profile.id]: agentFrom(saved, entry, profile)} : current;
    }, state.agents);
    const allowlist = Object.values(PROFILES).flatMap(({id}) => (agents[id]?.state === CONFIRMED ? [allowlistEntry(agents[id])] : []));
    save({...state, agents});
    writePrivateFile(allowlistPath, JSON.stringify(allowlist, null, 2));
    return {agents, allowlist};
  }

  return {ensureKey, register, refresh};
}
