import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assembleRun} from './assemble.mjs';
import {MINUTE_MS} from '../shared/constants.mjs';
import {createMockPayments} from '../payments/mock.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import agents from '../shared/fixtures/agents.json' with {type: 'json'};
import table from '../shared/fixtures/table.json' with {type: 'json'};

const T0 = 1_793_340_000_000;
const [standard, , copy] = agents;
const AGENT_FOR = {normalize: standard, copy};

const planner = {
  plan: async ({subtask}) => ({
    proposals: [
      {
        proposalId: `p-${subtask}`,
        subtask,
        agentIdentifier: AGENT_FOR[subtask].agentIdentifier,
        maxPrice: AGENT_FOR[subtask].price,
        reason: 'test',
      },
    ],
    rejected: [],
  }),
};

// Time only moves when the code sleeps between polls, so a whole paid cycle runs instantly.
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'assemble-'));
  let now = T0;
  const clock = () => now;
  const sleep = async (ms) => {
    now += ms;
  };
  const payments = createMockPayments({clock});
  const assemble = (overrides = {}) =>
    assembleRun({
      taskId: 'task-1',
      directory,
      allowlist: agents,
      acceptance,
      table,
      payments,
      planner,
      review: async () => ({decision: 'allow', reason: 'fine'}),
      clock,
      sleep,
      pollMs: MINUTE_MS,
      ...overrides,
    });
  return {directory, assemble, clock};
}

test('a run delivers and leaves its mandate and evidence under the task id', async () => {
  const {directory, assemble} = setup();

  const result = await assemble().run();

  assert.equal(result.ok, true, result.reason);
  assert.equal(JSON.parse(result.deliverable).length, table.length);
  assert.equal(existsSync(join(directory, 'task-1-mandate.json')), true);
  assert.equal(existsSync(join(directory, 'task-1-evidence.jsonl')), true);
});

test('a crash in one job is reported only after the other job has stopped', async () => {
  const {assemble} = setup();
  const crashing = {
    plan: async (request) => {
      if (request.subtask === 'copy') throw new Error('the model is down');
      return planner.plan(request);
    },
  };
  const {ledger, run} = assemble({planner: crashing});

  await assert.rejects(run(), /the model is down/);

  assert.ok(ledger.lines().some(({step, subtask}) => step === 'acceptance.passed' && subtask === 'normalize'));
});

test('a restart of the same task keeps the mandate and hires nobody new', async () => {
  const {directory, assemble} = setup();
  const first = await assemble().run();
  await first.settled;
  const savedMandate = readFileSync(join(directory, 'task-1-mandate.json'), 'utf8');

  const restarted = assemble({limits: {budget: '9000000', perHire: '9000000', maxHires: 99}});
  const second = await restarted.run();

  const steps = restarted.ledger.lines().map((line) => line.step);
  assert.equal(second.ok, true, second.reason);
  assert.equal(steps.filter((step) => step === 'purchase.reserved').length, 2);
  assert.equal(steps.filter((step) => step === 'mandate.confirmed').length, 1);
  assert.equal(readFileSync(join(directory, 'task-1-mandate.json'), 'utf8'), savedMandate);
  assert.equal(restarted.mandate.maxHires, 3);
});

test('a front desk deadline tightens the delivery time', () => {
  const {assemble} = setup();

  const {mandate} = assemble({frontDeskDeadline: T0 + 45 * MINUTE_MS});

  assert.equal(mandate.deliverBy, T0 + 42 * MINUTE_MS);
});

test('a second task gets its own files', async () => {
  const {directory, assemble} = setup();

  assemble();
  assemble({taskId: 'task-2'});

  assert.equal(existsSync(join(directory, 'task-1-mandate.json')), true);
  assert.equal(existsSync(join(directory, 'task-2-mandate.json')), true);
});

test('the acceptance rules that count are the ones in the saved mandate', async () => {
  const {assemble} = setup();
  const first = assemble();

  const loosened = {...acceptance, required_columns: ['sku']};
  const second = assemble({acceptance: loosened});

  assert.deepEqual(second.mandate.acceptance, first.mandate.acceptance);
});
