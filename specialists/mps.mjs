import {PaymentsError} from '../shared/errors.mjs';

const REQUEST_TIMEOUT_MS = 30_000;

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// Calls the Payment Service. With a body it is a POST, without one a GET.
// A timeout or a dropped connection has no status, which makes it an uncertain outcome.
export function createMps({baseUrl, token}) {
  if (!baseUrl) throw new Error('Set MPS_URL');
  if (!token) throw new Error('The Payment Service key is missing');
  return async (path, body) => {
    let response;
    try {
      response = await fetch(`${baseUrl}/api/v1${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {token, 'content-type': 'application/json'},
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new PaymentsError(`Payment Service ${path}: ${error.message}`);
    }
    const data = await readJson(response);
    if (!response.ok || data?.status !== 'success') {
      const reason = data?.error?.message ?? data?.message ?? 'no message';
      throw new PaymentsError(`Payment Service ${path} answered HTTP ${response.status}: ${reason}`, {status: response.status});
    }
    return data.data;
  };
}
