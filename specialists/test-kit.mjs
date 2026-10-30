import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {jobPrompt} from '../shared/schemas.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import table from '../shared/fixtures/table.json' with {type: 'json'};
import {createFakeMps} from './fake-mps.mjs';
import {createSellerLoop} from './loop.mjs';
import {PROFILES} from './profiles.mjs';
import {createSpecialistServer} from './server.mjs';
import {createJobStore} from './store.mjs';

export const START = 1_793_340_000_000;
export const NONCE = 'ab'.repeat(10);
export const REGISTERED = Object.freeze({
  agentIdentifier: `${'67'.repeat(28)}${'73'.repeat(8)}`,
  sellerVkey: 'b1'.repeat(28),
  supportedPaymentSourceIndex: 0,
  name: 'Registered agent',
  apiBaseUrl: 'http://127.0.0.1:4101',
  role: 'normalize',
});

export const jobOf = (kind) => ({kind, table, acceptance, key: acceptance.key});

// A specialist on a free port, a fake Payment Service and a clock the test moves by hand.
export async function setupSpecialist(t, {profile = PROFILES.standard, work, fault, mps, registration = () => REGISTERED} = {}) {
  const store = createJobStore(mkdtempSync(join(tmpdir(), 'specialist-')));
  let now = START;
  const clock = () => now;
  const fake = createFakeMps({clock});
  const logged = [];
  const log = (line) => logged.push(line);
  const request = mps ? mps(fake) : fake.request;
  const server = createSpecialistServer({profile, store, mps: request, registration, clock, log});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const loop = createSellerLoop({store, mps: request, work: work ?? (async () => 'unused'), fault, clock, log});

  const post = (body) =>
    fetch(`${base}/start_job`, {method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body)});
  const startBody = (kind = profile.role, nonce = NONCE) => ({identifier_from_purchaser: nonce, input_data: {prompt: jobPrompt(jobOf(kind))}});
  const start = async (kind, nonce) => (await post(startBody(kind, nonce))).json();
  const status = async (id) => (await fetch(`${base}/status?job_id=${id}`)).json();

  return {
    base,
    store,
    fake,
    loop,
    logged,
    post,
    startBody,
    start,
    status,
    advance: (ms) => {
      now += ms;
    },
  };
}
