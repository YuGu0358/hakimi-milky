import {PaymentsError} from './errors.mjs';

// One way to read Blockfrost: one request at a time and slow, because the Payment Service shares this IP's limit.
// A refused or failing call waits and tries again. No answer at all is reported at once, so an outage does not hold anyone up.

const DEFAULT_URL = 'https://cardano-preprod.blockfrost.io/api/v0';
const REQUEST_TIMEOUT_MS = 30_000;
const MIN_GAP_MS = 500;
const MAX_ATTEMPTS = 5;
const RETRY_WAIT_MS = 3_000;
const MAX_RETRY_AFTER_MS = 60_000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRetryable = (status) => status === 429 || status >= 500;

export function createBlockfrost({key, baseUrl = DEFAULT_URL, sleep = wait, minGapMs = MIN_GAP_MS}) {
  if (!key) throw new Error('Set BLOCKFROST_API_KEY_PREPROD');
  let tail = Promise.resolve();

  async function once(path) {
    try {
      return await fetch(`${baseUrl}${path}`, {headers: {project_id: key}, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)});
    } catch (error) {
      throw new PaymentsError(`Blockfrost ${path}: ${error.message}`);
    }
  }

  async function read(path) {
    for (let attempt = 1; ; attempt += 1) {
      const response = await once(path);
      if (response.ok) return response.json();
      if (!isRetryable(response.status) || attempt >= MAX_ATTEMPTS) throw new PaymentsError(`Blockfrost ${path} answered HTTP ${response.status}`, {status: response.status});
      const asked = Number(response.headers.get('retry-after')) * 1000;
      await sleep(Math.min(asked > 0 ? asked : RETRY_WAIT_MS * attempt, MAX_RETRY_AFTER_MS));
    }
  }

  return function get(path) {
    const turn = tail.then(() => read(path));
    tail = turn.catch(() => undefined).then(() => sleep(minGapMs));
    return turn;
  };
}
