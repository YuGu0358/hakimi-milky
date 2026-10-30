import {NETWORK} from '../shared/constants.mjs';
import {PaymentsError} from '../shared/errors.mjs';
import {mapLimited} from '../shared/map-limited.mjs';
import {jobPrompt, purchaseViewFrom, quoteFromStartJob} from '../shared/schemas.mjs';
import {listingFromAsset} from '../registry/listing.mjs';
import {createMps} from '../specialists/mps.mjs';

// The real payment client: the same six functions as mock.mjs, with the same return shapes.
// Purchases go through our Payment Service, the seller's API is called directly, and the
// asked-for agents are read from Blockfrost, because the service only lists its own agents.
// For every agent in the registries, see registry/catalog.mjs.

const BLOCKFROST_URL = 'https://cardano-preprod.blockfrost.io/api/v0';
const REQUEST_TIMEOUT_MS = 30_000;
const METADATA_CONCURRENCY = 8;

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

export function createPayments({mpsUrl, token, blockfrostKey, blockfrostUrl = BLOCKFROST_URL}) {
  const mps = createMps({baseUrl: mpsUrl, token});
  if (!blockfrostKey) throw new Error('Set BLOCKFROST_API_KEY_PREPROD');

  const blockfrost = (path) =>
    getJson(`${blockfrostUrl}${path}`, {headers: {project_id: blockfrostKey}}, (data) => data?.message ?? 'no message');

  async function listingOf(agentIdentifier) {
    try {
      const {onchain_metadata: metadata, quantity} = await blockfrost(`/assets/${agentIdentifier}`);
      return quantity === '0' ? null : listingFromAsset(agentIdentifier, metadata);
    } catch (error) {
      if (error.kind === 'not-found') return null;
      throw error;
    }
  }

  const agentUrl = ({apiBaseUrl}, path) => `${apiBaseUrl.replace(/\/$/, '')}${path}`;
  const sellerError = (data) => data?.error ?? 'no message';

  return {
    // A run reads exactly the agents on its mandate, however long ago they registered.
    async listAgents(agentIdentifiers = []) {
      const listings = await mapLimited([...new Set(agentIdentifiers)], METADATA_CONCURRENCY, listingOf);
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
