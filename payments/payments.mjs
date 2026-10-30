import {NETWORK, REGISTRY_POLICY} from '../shared/constants.mjs';
import {PaymentsError} from '../shared/errors.mjs';
import {Listing, jobPrompt, purchaseViewFrom, quoteFromStartJob} from '../shared/schemas.mjs';
import {createMps} from '../specialists/mps.mjs';

// The real payment client: the same six functions as mock.mjs, with the same return shapes.
// Purchases go through our Payment Service, the seller's API is called directly, and the
// registry is read from Blockfrost, because the service only lists its own agents.

const BLOCKFROST_URL = 'https://cardano-preprod.blockfrost.io/api/v0';
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const METADATA_CONCURRENCY = 8;
const PAYMENT_SOURCE_TYPE_V2 = 'Web3CardanoV2';

// Cardano metadata strings hold at most 64 bytes, so long ones arrive as lists of chunks.
const joined = (value) => (Array.isArray(value) ? value.join('') : value ?? '');

const isOurSource = (source) =>
  joined(source?.chain) === 'Cardano' && joined(source?.network) === NETWORK && joined(source?.settlement?.paymentSourceType) === PAYMENT_SOURCE_TYPE_V2;

function priceOf({pricingType, fixed}) {
  if (pricingType !== 'Fixed' || !fixed?.[0]) return null;
  const asset = joined(fixed[0].asset);
  return {unit: asset === 'lovelace' ? '' : asset, amount: String(fixed[0].amount)};
}

// Null for anything we cannot hire: an old format, another network, no address to call.
export function listingFromAsset(agentIdentifier, metadata) {
  const sources = metadata?.supported_payment_sources;
  if (!Array.isArray(sources)) return null;
  const index = sources.findIndex(isOurSource);
  if (index < 0) return null;
  const {pricing = {}} = sources[index];
  const parsed = Listing.safeParse({
    agentIdentifier,
    name: joined(metadata.name),
    apiBaseUrl: joined(metadata.api_base_url),
    pricingType: pricing.pricingType,
    price: priceOf(pricing),
    supportedPaymentSourceIndex: index,
    tags: (metadata.tags ?? []).map(joined),
  });
  return parsed.success ? parsed.data : null;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// A timeout or dropped connection has no status, which makes it an uncertain outcome.
async function getJson(url, init, describeError) {
  let response;
  try {
    response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...init});
  } catch (error) {
    throw new PaymentsError(`${url}: ${error.message}`);
  }
  const data = await readJson(response);
  if (!response.ok) throw new PaymentsError(`${url} answered HTTP ${response.status}: ${describeError(data)}`, {status: response.status});
  return data;
}

async function mapLimited(items, limit, work) {
  const results = [];
  for (let start = 0; start < items.length; start += limit) {
    results.push(...(await Promise.all(items.slice(start, start + limit).map(work))));
  }
  return results;
}

export const orderBody = (quote, metadata, amounts, network = NETWORK) => ({
  blockchainIdentifier: quote.blockchainIdentifier,
  network,
  paymentSourceType: quote.paymentSourceType,
  supportedPaymentSourceIndex: quote.supportedPaymentSourceIndex,
  inputHash: quote.inputHash,
  sellerVkey: quote.sellerVkey,
  agentIdentifier: quote.agentIdentifier,
  Amounts: amounts,
  payByTime: String(quote.payByTime),
  submitResultTime: String(quote.submitResultTime),
  unlockTime: String(quote.unlockTime),
  externalDisputeUnlockTime: String(quote.externalDisputeUnlockTime),
  identifierFromPurchaser: quote.identifierFromPurchaser,
  metadata: JSON.stringify(metadata),
});

export function createPayments({mpsUrl, token, blockfrostKey, blockfrostUrl = BLOCKFROST_URL, knownAgentIds = []}) {
  const mps = createMps({baseUrl: mpsUrl, token});
  if (!blockfrostKey) throw new Error('Set BLOCKFROST_API_KEY_PREPROD');

  const blockfrost = (path) =>
    getJson(`${blockfrostUrl}${path}`, {headers: {project_id: blockfrostKey}}, (data) => data?.message ?? 'no message');

  async function livingAssets() {
    const assets = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const items = await blockfrost(`/assets/policy/${REGISTRY_POLICY}?count=${PAGE_SIZE}&order=desc&page=${page}`);
      assets.push(...items.filter(({quantity}) => quantity !== '0').map(({asset}) => asset));
      if (items.length < PAGE_SIZE) break;
    }
    return assets;
  }

  async function listingOf(agentIdentifier) {
    try {
      const {onchain_metadata: metadata} = await blockfrost(`/assets/${agentIdentifier}`);
      return listingFromAsset(agentIdentifier, metadata);
    } catch (error) {
      if (error.kind === 'not-found') return null;
      throw error;
    }
  }

  const agentUrl = ({apiBaseUrl}, path) => `${apiBaseUrl.replace(/\/$/, '')}${path}`;
  const sellerError = (data) => data?.error ?? 'no message';

  return {
    async listAgents() {
      const ids = [...new Set([...knownAgentIds, ...(await livingAssets())])];
      const listings = await mapLimited(ids, METADATA_CONCURRENCY, listingOf);
      return listings.filter(Boolean);
    },

    // Never sent twice: a second try would be a second payment request at the seller.
    async startJob(agent, job, nonce) {
      const data = await getJson(
        agentUrl(agent, '/start_job'),
        {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({identifier_from_purchaser: nonce, input_data: {prompt: jobPrompt(job)}}),
        },
        sellerError,
      );
      return quoteFromStartJob(data);
    },

    async purchase(quote, metadata, amounts) {
      try {
        const order = await mps('/purchase', orderBody(quote, metadata, amounts));
        return{id: order.id, blockchainIdentifier: quote.blockchainIdentifier, nextAction: order.NextAction?.requestedAction ?? null, existed: false};
      } catch (error) {
        if (error.kind === 'conflict') return {id: null, blockchainIdentifier: quote.blockchainIdentifier, nextAction: null, existed: true};
        throw error;
      }
    },

    async getPurchase(blockchainIdentifier) {
      return purchaseViewFrom(await mps('/purchase/resolve-blockchain-identifier', {network: NETWORK, blockchainIdentifier, includeHistory: 'true'}));
    },

    async requestRefund(blockchainIdentifier) {
      const answer = await mps('/purchase/request-refund', {network: NETWORK, blockchainIdentifier});
      return {nextAction: answer.NextAction?.requestedAction ?? null, onChainState: answer.onChainState ?? null};
    },

    async getJobResult(agent, jobId) {
      const {status, result} = await getJson(agentUrl(agent, `/status?job_id=${encodeURIComponent(jobId)}`), {}, sellerError);
      return {status, result};
    },
  };
}
