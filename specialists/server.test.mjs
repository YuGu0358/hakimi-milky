import test from 'node:test';
import assert from 'node:assert/strict';
import {guard} from '../orchestrator/guard.mjs';
import {deriveState} from '../orchestrator/ledger.mjs';
import {createMandate} from '../orchestrator/mandate.mjs';
import {MINUTE_MS, USDM_UNIT} from '../shared/constants.mjs';
import {PaymentsError} from '../shared/errors.mjs';
import {inputHash} from '../shared/hash.mjs';
import {quoteFromStartJob} from '../shared/schemas.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import {NONCE, REGISTERED, START, jobOf, setupSpecialist} from './test-kit.mjs';
import {PROFILES} from './profiles.mjs';

const OTHER_NONCE = 'cd'.repeat(10);

test('availability and a one-field input schema, as the starter has them', async (t) => {
  const {base} = await setupSpecialist(t);

  const availability = await (await fetch(`${base}/availability`)).json();
  const schema = await (await fetch(`${base}/input_schema`)).json();

  assert.deepEqual(availability, {status: 'available', type: 'masumi-agent'});
  assert.deepEqual(schema.input_data.map((field) => field.id), ['prompt']);
});

test('start_job answers with a quote the buyer can parse, bound to the input and nonce', async (t) => {
  const {post, startBody} = await setupSpecialist(t);
  const body = startBody();

  const response = await post(body);
  const quote = quoteFromStartJob(await response.json());

  assert.equal(response.status, 200);
  assert.equal(quote.inputHash, inputHash(body.input_data, NONCE));
  assert.equal(quote.identifierFromPurchaser, NONCE);
  assert.equal(quote.agentIdentifier, REGISTERED.agentIdentifier);
  assert.equal(quote.sellerVkey, REGISTERED.sellerVkey);
  assert.equal(quote.supportedPaymentSourceIndex, 0);
  assert.equal(quote.payByTime, START + 8 * MINUTE_MS);
  assert.equal(quote.submitResultTime, START + 17 * MINUTE_MS);
  assert.equal(quote.unlockTime, START + 32 * MINUTE_MS);
  assert.equal(quote.externalDisputeUnlockTime, START + 47 * MINUTE_MS);
});

test('the payment request carries no RequestedFunds, because the price is fixed on chain', async (t) => {
  const {start, fake} = await setupSpecialist(t);

  await start();

  const [{body}] = fake.callsTo('/payment');
  assert.equal('RequestedFunds' in body, false);
  assert.equal(body.network, 'Preprod');
  assert.equal(body.paymentSourceType, 'Web3CardanoV2');
});

test('the buyer guard allows the quote under the demo mandate', async (t) => {
  const {startBody, post} = await setupSpecialist(t);
  const body = startBody();
  const quote = quoteFromStartJob(await (await post(body)).json());
  const mandate = createMandate({
    taskId: 'task-1',
    allowlist: [{...REGISTERED}],
    acceptance,
    startedAt: START,
    frontDeskDeadline: START + 45 * MINUTE_MS,
  });

  const decision = guard({
    mandate,
    ledger: deriveState([]),
    quote,
    price: {unit: USDM_UNIT, amount: PROFILES.standard.priceAmount},
    prompt: body.input_data.prompt,
    nonce: NONCE,
    subtask: 'normalize',
    now: START,
  });

  assert.equal(decision.ok, true, decision.reason);
});

test('the job is on disk before the payment write goes out', async (t) => {
  let phaseDuringWrite;
  const kit = await setupSpecialist(t, {
    mps: (fake) => async (path, body) => {
      if (path === '/payment') phaseDuringWrite = kit.store.list()[0]?.phase;
      return fake.request(path, body);
    },
  });

  await kit.start();

  assert.equal(phaseDuringWrite, 'payment-pending');
  assert.equal(kit.store.list()[0].phase, 'waiting-payment');
});

const BAD_REQUESTS = [
  ['a body that is not JSON', () => 'not json'],
  ['a missing nonce', (body) => ({input_data: body.input_data})],
  ['a nonce that is not hex', (body) => ({...body, identifier_from_purchaser: 'zz'.repeat(10)})],
  ['a nonce that is not a string', (body) => ({...body, identifier_from_purchaser: 12345678901234})],
  ['an extra input field', (body) => ({...body, input_data: {...body.input_data, extra: 'x'}})],
  ['an empty prompt', (body) => ({...body, input_data: {prompt: '  '}})],
  ['a prompt that is not JSON', (body) => ({...body, input_data: {prompt: 'clean my table'}})],
  ['a prompt that is not a job', (body) => ({...body, input_data: {prompt: '{"kind":"normalize"}'}})],
  ['a job of the wrong kind', (body) => ({...body, input_data: {prompt: JSON.stringify(jobOf('copy'))}})],
];

for (const [label, build] of BAD_REQUESTS) {
  test(`start_job refuses ${label} and writes no payment`, async (t) => {
    const {post, startBody, fake} = await setupSpecialist(t);

    const response = await post(build(startBody()));

    assert.equal(response.status, 400);
    assert.equal(fake.calls.length, 0);
  });
}

test('start_job refuses a body over the size limit', async (t) => {
  const {post, fake} = await setupSpecialist(t);

  const response = await post('x'.repeat(70_000));

  assert.equal(response.status, 413);
  assert.equal(fake.calls.length, 0);
});

test('start_job refuses until the registration is confirmed', async (t) => {
  const {post, startBody, fake} = await setupSpecialist(t, {registration: () => null});

  const response = await post(startBody());

  assert.equal(response.status, 503);
  assert.equal(fake.calls.length, 0);
});

test('the same nonce and input get the same quote and no second payment', async (t) => {
  const {post, startBody, fake} = await setupSpecialist(t);

  const first = await (await post(startBody())).json();
  const second = await (await post(startBody())).json();

  assert.deepEqual(second, first);
  assert.equal(fake.callsTo('/payment').length, 1);
});

test('two requests at once with one nonce make one payment', async (t) => {
  const {post, startBody, fake} = await setupSpecialist(t);

  await Promise.all([post(startBody()), post(startBody())]);

  assert.equal(fake.callsTo('/payment').length, 1);
});

test('the same nonce with another input is refused', async (t) => {
  const {post, startBody, fake} = await setupSpecialist(t);
  await post(startBody());
  const changed = {...jobOf('normalize'), key: 'name'};

  const response = await post({identifier_from_purchaser: NONCE, input_data: {prompt: JSON.stringify(changed)}});

  assert.equal(response.status, 409);
  assert.equal(fake.callsTo('/payment').length, 1);
});

test('a payment write with an unknown outcome is never replayed', async (t) => {
  const {post, startBody, fake, store} = await setupSpecialist(t, {
    mps: (fake) => async (path, body) => {
      fake.calls.push({path, body});
      throw new PaymentsError('Request timed out');
    },
  });

  const first = await post(startBody());
  const second = await post(startBody());

  assert.equal(first.status, 500);
  assert.equal(second.status, 409);
  assert.equal(fake.callsTo('/payment').length, 1);
  assert.equal(store.list()[0].phase, 'payment-pending');
});

test('a definite refusal fails the job and says why', async (t) => {
  const {post, startBody, store, logged} = await setupSpecialist(t, {
    mps: () => async () => {
      throw new PaymentsError('The agentIdentifier is not of the specified payment source', {status: 404});
    },
  });

  const response = await post(startBody());
  const {error} = await response.json();

  assert.equal(response.status, 502);
  assert.match(error, /not of the specified payment source/);
  assert.equal(store.list()[0].phase, 'payment-rejected');
  assert.equal(store.list()[0].status, 'failed');
  assert.match(logged.join('\n'), /not of the specified payment source/);
});

test('a second try after a definite refusal needs a new nonce', async (t) => {
  let isDown = true;
  const {post, startBody} = await setupSpecialist(t, {
    mps: (fake) => async (path, body) => {
      if (isDown) throw new PaymentsError('Refused', {status: 400});
      return fake.request(path, body);
    },
  });
  await post(startBody());
  isDown = false;

  const sameNonce = await post(startBody());
  const newNonce = await post(startBody('normalize', OTHER_NONCE));

  assert.equal(sameNonce.status, 409);
  assert.equal(newNonce.status, 200);
});

test('status refuses a bad id and does not know an unknown one', async (t) => {
  const {base} = await setupSpecialist(t);

  const bad = await fetch(`${base}/status?job_id=../../secret`);
  const unknown = await fetch(`${base}/status?job_id=00000000-0000-4000-8000-000000000000`);

  assert.equal(bad.status, 400);
  assert.equal(unknown.status, 404);
});

test('status holds the result back until the job is completed', async (t) => {
  const {start, status, store} = await setupSpecialist(t);
  const {id} = await start();
  const job = store.load(id);

  store.save({...job, result: 'done', status: 'running'});
  const running = await status(id);
  store.save({...job, result: 'done', status: 'completed'});
  const completed = await status(id);

  assert.deepEqual(running, {id, status: 'running'});
  assert.deepEqual(completed, {id, status: 'completed', result: 'done'});
});

test('an unknown route is a 404', async (t) => {
  const {base} = await setupSpecialist(t);

  assert.equal((await fetch(`${base}/payTo`)).status, 404);
  assert.equal((await fetch(`${base}/start_job`)).status, 404);
});
