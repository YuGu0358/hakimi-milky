import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {accept} from '../orchestrator/acceptance.mjs';
import {jobPrompt, quoteFromStartJob} from '../shared/schemas.mjs';
import {createFakeMps} from './fake-mps.mjs';
import {serveFake} from './mps-http.mjs';
import {NONCE, REGISTERED, jobOf} from './test-kit.mjs';

// These run the real entry point as its own process, so CI shows it works on each operating system.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WAIT_MS = 15_000;
const POLL_MS = 20;

function agentDirectory({hasToken = true} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'specialist-process-'));
  if (hasToken) writeFileSync(join(directory, 'mps-runtime.env'), 'MPS_RUNTIME_TOKEN=test-token\n');
  writeFileSync(join(directory, 'registration.json'), JSON.stringify({agents: {standard: {...REGISTERED, state: 'RegistrationConfirmed'}}}));
  return directory;
}

function startProcess(t, env) {
  const child = spawn(process.execPath, ['specialists/start.mjs', 'standard'], {
    cwd: REPO_ROOT,
    env: {...process.env, FAULT: '', SPECIALIST_TEST_PORT: '0', SPECIALIST_POLL_MS: String(POLL_MS), ...env},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = {text: ''};
  child.stdout.on('data', (chunk) => {
    output.text += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output.text += chunk;
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(async () => {
    child.kill();
    await exited;
  });
  return {output, exited};
}

async function waitFor(check, label) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const listeningUrl = ({output}) => waitFor(() => /on (http:\/\/127\.0\.0\.1:\d+)/.exec(output.text)?.[1], 'the agent to listen');

test('a started agent takes a job, delivers on locked funds and agrees to a refund', async (t) => {
  const fake = createFakeMps();
  const {baseUrl, tokens} = await serveFake(t, fake.request);
  const agent = startProcess(t, {SPECIALISTS_DIR: agentDirectory(), MPS_URL: baseUrl});
  const base = await listeningUrl(agent);
  const job = jobOf('normalize');

  const response = await fetch(`${base}/start_job`, {
    method: 'POST',
    body: JSON.stringify({identifier_from_purchaser: NONCE, input_data: {prompt: jobPrompt(job)}}),
  });
  const quote = quoteFromStartJob(await response.json());
  const bid = quote.blockchainIdentifier;
  fake.chain.lockFunds(bid);
  await waitFor(() => fake.callsTo('/payment/submit-result').length === 1, 'the result to be committed');
  fake.chain.confirmResult(bid);
  const status = () => fetch(`${base}/status?job_id=${quote.jobId}`).then((answer) => answer.json());
  const {result} = await waitFor(async () => {
    const answer = await status();
    return answer.status === 'completed' && answer;
  }, 'the job to complete');
  fake.chain.askRefund(bid);
  await waitFor(() => fake.callsTo('/payment/authorize-refund').length === 1, 'the refund to be authorized');

  const verdict = accept({kind: 'normalize', spec: job.acceptance, inputTable: job.table, resultText: result, nonce: NONCE, onChainResultHash: fake.chain.payment(bid).resultHash});
  assert.deepEqual(verdict.failures, []);
  assert.ok(tokens.every((token) => token === 'test-token'));
});

test('a second process for the same agent refuses to start', async (t) => {
  const directory = agentDirectory();
  const fake = createFakeMps();
  const {baseUrl} = await serveFake(t, fake.request);
  const env = {SPECIALISTS_DIR: directory, MPS_URL: baseUrl};
  await listeningUrl(startProcess(t, env));

  const second = startProcess(t, env);

  assert.equal(await second.exited, 1);
  assert.match(second.output.text, /already running/);
});

test('without the runtime key it says so and exits', async (t) => {
  const agent = startProcess(t, {SPECIALISTS_DIR: agentDirectory({hasToken: false}), MPS_URL: 'http://127.0.0.1:1'});

  assert.equal(await agent.exited, 1);
  assert.match(agent.output.text, /private token/);
});

test('a fault meant for the cheap agent does not stop the standard one', async (t) => {
  const fake = createFakeMps();
  const {baseUrl} = await serveFake(t, fake.request);
  const agent = startProcess(t, {SPECIALISTS_DIR: agentDirectory(), MPS_URL: baseUrl, FAULT: 'drop_rows:2'});

  const base = await listeningUrl(agent);

  assert.equal((await fetch(`${base}/availability`)).status, 200);
});

test('an unknown fault stops it at the start', async (t) => {
  const agent = startProcess(t, {SPECIALISTS_DIR: agentDirectory(), MPS_URL: 'http://127.0.0.1:1', FAULT: 'lie'});

  assert.equal(await agent.exited, 1);
  assert.match(agent.output.text, /Unknown FAULT/);
});
