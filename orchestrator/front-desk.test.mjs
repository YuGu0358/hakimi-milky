import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFrontDesk, formatResult, tableFromText} from './front-desk.mjs';
import {createMockPayments} from '../payments/mock.mjs';
import {MINUTE_MS} from '../shared/constants.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import agents from '../shared/fixtures/agents.json' with {type: 'json'};
import table from '../shared/fixtures/table.json' with {type: 'json'};

const T0 = 1_793_340_000_000;
const DEADLINE = T0 + 45 * MINUTE_MS;
const [standard, cheap, copy] = agents;
const COLUMNS = acceptance.required_columns;

const toCsv = (rows) => [COLUMNS.join(','), ...rows.map((row) => COLUMNS.map((column) => JSON.stringify(String(row[column]))).join(','))].join('\n');
const TASK_TEXT = `Please clean this for me.\n\n${toCsv(table)}\n\nThanks!`;

const plannerChoosing = (normalizer) => ({
  plan: async ({subtask, feedback}) => {
    const agent = subtask === 'copy' ? copy : normalizer(feedback);
    return {
      proposals: [{proposalId: `p-${subtask}-${feedback.length}`, subtask, agentIdentifier: agent.agentIdentifier, maxPrice: agent.price, reason: 'test'}],
      rejected: [],
    };
  },
});

function setup({faults = {}, planner = plannerChoosing(() => standard), ...overrides} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'front-desk-'));
  let now = T0;
  const clock = () => now;
  const sleep = async (ms) => {
    now += ms;
  };
  const payments = createMockPayments({clock, faults});
  const logs = [];
  const calls = {plain: 0, topUps: 0, parts: 0};
  const desk = createFrontDesk({
    answerPlainly: async () => {
      calls.plain += 1;
      return 'a plain answer';
    },
    createParts: () => {
      calls.parts += 1;
      return {
        directory,
        allowlist: agents,
        acceptance,
        payments,
        planner,
        review: async () => ({decision: 'allow', reason: 'fine'}),
        trackRecords: {},
        clock,
        sleep,
        pollMs: MINUTE_MS,
      };
    },
    topUp: async () => {
      calls.topUps += 1;
    },
    sleep,
    log: (text) => logs.push(text),
    ...overrides,
  });
  return {desk, calls, logs, directory};
}

test('a table is found in a task with prose around it', () => {
  const rows = tableFromText(TASK_TEXT, acceptance);

  assert.equal(rows.length, table.length);
  assert.equal(rows[0].sku, 'HM-001');
});

test('a table is found when the task text arrives on one line with bars between rows', () => {
  const text =
    'Clean this supplier table and write one short product text per row. Keep every row and SKU, and do not change prices. sku,name,category,unit,price | HM-001, Oat Milk Barista 1L,Milk,pcs,3.20 EUR | HM-002,Whole Milk UHT 1L ,MILK,PCS,2.10 | HM-003,Assam Black Tea,Tea,kg,18.50 EUR | HM-004,Jasmine Green Tea,tea ,KG,21.00 EUR';

  const rows = tableFromText(text, acceptance);

  assert.deepEqual(rows.map(({sku}) => sku), ['HM-001', 'HM-002', 'HM-003', 'HM-004']);
  assert.equal(rows[1].price, '2.10');
});

test('a table is found in a code fence saved on Windows, whatever the header case', () => {
  const text = `Clean this:\r\n\`\`\`csv\r\nSKU,Name,Category,Unit,Price\r\nHM-001,Oat Milk,Milk,pcs,3.20\r\n\`\`\`\r\nThanks`;

  const rows = tableFromText(text, acceptance);

  assert.deepEqual(rows, [{sku: 'HM-001', name: 'Oat Milk', category: 'Milk', unit: 'pcs', price: '3.20'}]);
});

const NOT_OUR_TABLES = {
  'no table at all': 'Suggest names for our hackathon team.',
  'a missing column': 'sku,name,category,unit\nHM-001,Oat Milk,Milk,pcs',
  'a column we do not know': 'sku,name,category,unit,price,supplier\nHM-001,Oat Milk,Milk,pcs,3.20,Acme',
  'a header with no rows': 'sku,name,category,unit,price\n',
  'rows of different lengths': 'sku,name,category,unit,price\nHM-001,Oat Milk,Milk,pcs,3.20,extra',
  'a category outside the list': 'sku,name,category,unit,price\nHM-001,Oat Milk,Furniture,pcs,3.20',
  'a price that is not positive': 'sku,name,category,unit,price\nHM-001,Oat Milk,Milk,pcs,free',
  'a repeated SKU': 'sku,name,category,unit,price\nHM-001,Oat Milk,Milk,pcs,3.20\nHM-001,Whole Milk,Milk,pcs,2.10',
  'more rows than one job takes': toCsv(Array.from({length: 51}, (_, index) => ({...table[0], sku: `HM-${index}`}))),
};

for (const [name, text] of Object.entries(NOT_OUR_TABLES)) {
  test(`no job for specialists comes from ${name}`, () => {
    assert.equal(tableFromText(text, acceptance), null);
  });
}

test('a task with no table is answered plainly and touches no money', async () => {
  const {desk, calls} = setup();

  const result = await desk('Suggest names for our team.', '.local/session.json', DEADLINE, 'task-1');

  assert.equal(result, 'a plain answer');
  assert.deepEqual(calls, {plain: 1, topUps: 0, parts: 0});
});

test('a table is sent to specialists and the result names every row and every hire', async () => {
  const {desk, calls} = setup();

  const result = await desk(TASK_TEXT, '.local/session.json', DEADLINE, 'task-1');

  assert.equal(calls.plain, 0);
  assert.equal(calls.topUps, 1);
  for (const {sku} of table) assert.ok(result.includes(`| ${sku} |`), `${sku} is missing`);
  assert.ok(result.includes(standard.name));
  assert.ok(result.includes(copy.name));
  assert.match(result, /preprod\.cardanoscan\.io\/transaction\//);
  assert.equal(result, result.trim());
});

test('a restart of the same task refills the key once and hires nobody new', async () => {
  const {desk, calls} = setup();
  const hiresIn = (text) => text.split('\n').filter((line) => line.startsWith('- '));
  const first = await desk(TASK_TEXT, '.local/session.json', DEADLINE, 'task-1');

  const second = await desk(TASK_TEXT, '.local/session.json', DEADLINE, 'task-1');

  assert.equal(calls.topUps, 1);
  assert.equal(hiresIn(first).length, 2);
  assert.equal(hiresIn(second).length, 2);
});

test('a hire that failed its check and was replaced shows up in the result', async () => {
  const {desk} = setup({
    faults: {dropRows: 2},
    planner: plannerChoosing((feedback) => (feedback.length === 0 ? cheap : standard)),
  });

  const result = await desk(TASK_TEXT, '.local/session.json', DEADLINE, 'task-1');

  assert.ok(result.includes(cheap.name));
  assert.match(result, /A3_MISSING/);
  assert.ok(result.includes(standard.name));
});

test('a job nobody could finish fails for good, and says why', async () => {
  const planner = {plan: async () => ({proposals: [], rejected: []})};
  const {desk} = setup({planner});

  await assert.rejects(desk(TASK_TEXT, '.local/session.json', DEADLINE, 'task-1'), (error) => {
    assert.equal(error.isFinal, true);
    assert.match(error.message, /no proposal/);
    return true;
  });
});

test('a passing trouble waits before it may be tried again, and is not final', async () => {
  let slept = 0;
  const {desk} = setup({
    topUp: async () => {
      throw new Error('Payment Service is down');
    },
    sleep: async (ms) => {
      slept += ms;
    },
  });

  await assert.rejects(desk(TASK_TEXT, '.local/session.json', DEADLINE, 'task-1'), (error) => {
    assert.notEqual(error.isFinal, true);
    assert.match(error.message, /Payment Service is down/);
    return true;
  });
  assert.ok(slept > 0);
});

test('money that fails to settle later is logged, not left to kill the worker', async () => {
  const {desk, logs} = setup({
    assemble: () => ({
      ledger: {lines: () => [], append: () => {}},
      run: async () => ({ok: true, deliverable: '[]', settled: Promise.reject(new Error('lost the connection'))}),
    }),
  });

  await desk(TASK_TEXT, '.local/session.json', DEADLINE, 'task-1');
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(logs.some((text) => text.includes('lost the connection')));
});

test('the front desk can pick a job up again after a crash', () => {
  assert.equal(setup().desk.canResume, true);
});

test('text from a supplier cannot break the table in the result', () => {
  const deliverable = JSON.stringify([{sku: 'A|1', name: 'Oat\nMilk', category: 'milk', unit: 'pcs', price: 3.2, stock: null, note: 'see | here', copy: 'Oat Milk per pcs'}]);

  const result = formatResult({deliverable, lines: [], names: {}});

  assert.ok(result.includes('| A\\|1 | Oat Milk | milk | pcs | 3.2 |  | see \\| here | Oat Milk per pcs |'));
});
