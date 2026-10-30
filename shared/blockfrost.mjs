const BLOCKFROST_URL = 'https://cardano-preprod.blockfrost.io/api/v0';
const REQUEST_TIMEOUT_MS = 30_000;
const RATE_LIMITED = 429;
const RATE_LIMIT_WAIT_MS = 3_000;
const MAX_ATTEMPTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// For long reads of the chain. The Payment Service shares this project's rate limit, so a refused
// call waits before it tries again.
export const createBlockfrostGet =
  ({key, baseUrl = BLOCKFROST_URL}) =>
  async (path) => {
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: {project_id: key},
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return response.json();
      if (response.status !== RATE_LIMITED || attempt >= MAX_ATTEMPTS) throw new Error(`Blockfrost ${path} answered HTTP ${response.status}`);
      await sleep(RATE_LIMIT_WAIT_MS * attempt);
    }
  };
