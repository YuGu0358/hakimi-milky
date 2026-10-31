import {NETWORK} from '../shared/constants.mjs';
import {PaymentsError} from '../shared/errors.mjs';
import {jobInput, purchaseViewFrom, quoteFromStartJob} from '../shared/schemas.mjs';
import {createMps} from '../specialists/mps.mjs';

// The real payment client: the same six functions as mock.mjs, with the same return shapes.
// Purchases go through our Payment Service and the seller's API is called directly. Who is
// registered comes from outside, through readAgents, so this file knows nothing about Blockfrost.

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_SELLER_BODY_BYTES = 1024 * 1024;

// A seller chooses how much it sends, so reading stops at the limit instead of filling the memory.
async function readLimitedText(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_SELLER_BODY_BYTES) throw new PaymentsError(`The answer is larger than ${MAX_SELLER_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseOrNull(text) {
  try {
    return JSON.parse(text);
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
  const data = parseOrNull(await readLimitedText(response));
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

export function createPayments({mpsUrl, token, readAgents = async () => []}) {
  const mps = createMps({baseUrl: mpsUrl, token});

  const agentUrl = ({apiBaseUrl}, path) => `${apiBaseUrl.replace(/\/$/, '')}${path}`;
  const sellerError = (data) => data?.error ?? 'no message';

  return {
    listAgents: (agentIdentifiers) => readAgents(agentIdentifiers),

    // Never sent twice: a second try would be a second payment request at the seller.
    async startJob(agent, job, nonce) {
      const data = await getJson(
        agentUrl(agent, '/start_job'),
        {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({identifier_from_purchaser: nonce, input_data: jobInput(job)}),
        },
        sellerError,
      );
      return quoteFromStartJob(data, agent);
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
