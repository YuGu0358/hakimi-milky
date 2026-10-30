import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {MAX_PROMPT_CHARS, MINUTE_MS, NETWORK, PAYMENT_SOURCE_TYPE, SPECIALIST_WINDOW_MINUTES} from '../shared/constants.mjs';
import {inputHash, sha256} from '../shared/hash.mjs';
import {Job} from '../shared/schemas.mjs';

// The seller API, adapted from the starter's frontdesk/agent-api.mjs: the same four routes and
// the same rule that a job is saved before the payment write. Unlike the starter, the price is
// fixed on chain, so the payment request carries no RequestedFunds.

const MAX_BODY_BYTES = 64 * 1024;
const NONCE = /^[a-fA-F0-9]{14,26}$/;
const JOB_ID = /^[0-9a-f-]{36}$/;

const INPUT_SCHEMA = Object.freeze({
  input_data: [
    {
      id: 'prompt',
      type: 'string',
      name: 'Job',
      data: {description: 'A job as JSON: kind, table, acceptance and key.'},
      validations: [
        {validation: 'min', value: '1'},
        {validation: 'max', value: String(MAX_PROMPT_CHARS)},
      ],
    },
  ],
});

const respond = (res, [status, data]) => {
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify(data));
};

// Reads to the end even over the limit, because leaving early would close the socket before we answer.
async function readBody(req) {
  const parts = [];
  let bytes = 0;
  for await (const part of req) {
    bytes += part.length;
    if (bytes <= MAX_BODY_BYTES) parts.push(part);
  }
  return bytes > MAX_BODY_BYTES ? null : Buffer.concat(parts).toString('utf8');
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isValidPrompt = (data) =>
  typeof data?.prompt === 'string' && data.prompt.trim() !== '' && data.prompt.length <= MAX_PROMPT_CHARS && Object.keys(data).length === 1;

function parseRequest(text, profile) {
  const input = parseJson(text);
  const nonce = input?.identifier_from_purchaser ?? input?.identifierFromPurchaser;
  if (typeof nonce !== 'string' || !NONCE.test(nonce) || !isValidPrompt(input?.input_data)) {
    return {error: 'Expected a hex purchaser nonce and input_data.prompt'};
  }
  const job = Job.safeParse(parseJson(input.input_data.prompt));
  if (!job.success) return {error: 'input_data.prompt must be a job: kind, table, acceptance and key'};
  if (job.data.kind !== profile.role) return {error: `This agent takes ${profile.role} jobs, not ${job.data.kind}`};
  return {nonce, prompt: input.input_data.prompt};
}

const isDefiniteRefusal = (error) => error.kind === 'rejected' || error.kind === 'not-found';

export function createSpecialistServer({profile, store, mps, registration, clock = Date.now, log = console.error}) {
  const findByNonce = (nonce) => store.list().find((job) => job.nonceKey === sha256(nonce));

  function paymentRequest({agent, nonce, hash}) {
    const now = clock();
    const at = (minutes) => new Date(now + minutes * MINUTE_MS).toISOString();
    return {
      network: NETWORK,
      paymentSourceType: PAYMENT_SOURCE_TYPE,
      supportedPaymentSourceIndex: agent.supportedPaymentSourceIndex,
      agentIdentifier: agent.agentIdentifier,
      inputHash: hash,
      identifierFromPurchaser: nonce,
      payByTime: at(SPECIALIST_WINDOW_MINUTES.payBy),
      submitResultTime: at(SPECIALIST_WINDOW_MINUTES.submit),
      unlockTime: at(SPECIALIST_WINDOW_MINUTES.unlock),
      externalDisputeUnlockTime: at(SPECIALIST_WINDOW_MINUTES.dispute),
    };
  }

  const quoteFrom = ({job, agent, payment}) => ({
    id: job.id,
    input_hash: job.inputHash,
    identifierFromPurchaser: job.nonce,
    blockchainIdentifier: payment.blockchainIdentifier,
    agentIdentifier: agent.agentIdentifier,
    sellerVKey: agent.sellerVkey,
    paymentSourceType: PAYMENT_SOURCE_TYPE,
    supportedPaymentSourceIndex: agent.supportedPaymentSourceIndex,
    payByTime: Number(payment.payByTime),
    submitResultTime: Number(payment.submitResultTime),
    unlockTime: Number(payment.unlockTime),
    externalDisputeUnlockTime: Number(payment.externalDisputeUnlockTime),
  });

  function answerExisting(job, hash) {
    if (job.inputHash !== hash) return [409, {error: 'Nonce already used with another input'}];
    if (job.response) return [200, job.response];
    return [409, {error: job.phase === 'payment-rejected' ? 'This nonce was refused earlier, use a new one' : 'Payment outcome requires inspection'}];
  }

  async function createPayment(job, agent) {
    try {
      const payment = await mps('/payment', paymentRequest({agent, nonce: job.nonce, hash: job.inputHash}));
      const response = quoteFrom({job, agent, payment});
      store.save({...job, phase: 'waiting-payment', response});
      return [200, response];
    } catch (error) {
      log(`${profile.id}: payment for job ${job.id} failed: ${error.message}`);
      if (!isDefiniteRefusal(error)) return [500, {error: 'Request failed. Inspect the saved job state before retrying.'}];
      store.save({...job, phase: 'payment-rejected', status: 'failed', error: error.message});
      return [502, {error: `The Payment Service refused: ${error.message}`}];
    }
  }

  async function startJob(req) {
    const text = await readBody(req);
    if (text === null) return [413, {error: 'Request too large'}];
    const {error, nonce, prompt} = parseRequest(text, profile);
    if (error) return [400, {error}];
    const agent = registration();
    if (!agent) return [503, {error: 'Registration not confirmed'}];
    const hash = inputHash({prompt}, nonce);
    const existing = findByNonce(nonce);
    if (existing) return answerExisting(existing, hash);
    const job = store.save({
      id: randomUUID(),
      nonceKey: sha256(nonce),
      nonce,
      input: {prompt},
      inputHash: hash,
      status: 'awaiting_payment',
      phase: 'payment-pending',
    });
    return createPayment(job, agent);
  }

  function jobStatus(url) {
    const id = url.searchParams.get('job_id') ?? '';
    if (!JOB_ID.test(id)) return [400, {error: 'Invalid job_id'}];
    if (!store.has(id)) return [404, {error: 'Job not found'}];
    const job = store.load(id);
    return [200, {id, status: job.status, ...(job.status === 'completed' ? {result: job.result} : {})}];
  }

  async function route(req) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const target = `${req.method} ${url.pathname}`;
    if (target === 'GET /availability') return [200, {status: 'available', type: 'masumi-agent'}];
    if (target === 'GET /input_schema') return [200, INPUT_SCHEMA];
    if (target === 'GET /status') return jobStatus(url);
    if (target === 'POST /start_job') return startJob(req);
    return [404, {error: 'Route not found'}];
  }

  return createServer(async (req, res) => {
    try {
      respond(res, await route(req));
    } catch (error) {
      log(`${profile.id}: request failed: ${error.message}`);
      respond(res, [500, {error: 'Request failed. Inspect the saved job state before retrying.'}]);
    }
  });
}
