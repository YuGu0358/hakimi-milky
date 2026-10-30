import test from 'node:test';
import assert from 'node:assert/strict';
import {accept} from '../orchestrator/acceptance.mjs';
import {MINUTE_MS} from '../shared/constants.mjs';
import {PaymentsError} from '../shared/errors.mjs';
import {resultHash} from '../shared/hash.mjs';
import {NONCE, jobOf, setupSpecialist} from './test-kit.mjs';
import {PROFILES} from './profiles.mjs';
import {createWork, parseFault} from './work.mjs';

const standardWork = () => createWork({profile: PROFILES.standard});
const SUBMIT = '/payment/submit-result';
const AUTHORIZE = '/payment/authorize-refund';

async function quoted(t, options = {}) {
  const kit = await setupSpecialist(t, {work: standardWork(), ...options});
  const {id, blockchainIdentifier} = await kit.start();
  return {...kit, id, bid: blockchainIdentifier, job: () => kit.store.load(id)};
}

async function delivered(t, options) {
  const kit = await quoted(t, options);
  kit.fake.chain.lockFunds(kit.bid);
  await kit.loop.tick();
  return kit;
}

async function completed(t, options) {
  const kit = await delivered(t, options);
  kit.fake.chain.confirmResult(kit.bid);
  await kit.loop.tick();
  return kit;
}

test('nothing happens until the funds are locked', async (t) => {
  const {loop, fake, job} = await quoted(t);

  await loop.tick();

  assert.equal(job().phase, 'waiting-payment');
  assert.equal(fake.callsTo(SUBMIT).length, 0);
});

test('funds that are locked but not confirmed start no work', async (t) => {
  const kit = await setupSpecialist(t, {
    work: standardWork(),
    mps: (fake) => async (path, body) => {
      const answer = await fake.request(path, body);
      if (path !== '/payment/resolve-blockchain-identifier') return answer;
      return {...answer, onChainState: 'FundsLocked', CurrentTransaction: {txHash: 'tx', status: 'Pending', newOnChainState: 'FundsLocked'}};
    },
  });
  const {id} = await kit.start();

  await kit.loop.tick();

  assert.equal(kit.store.load(id).phase, 'waiting-payment');
  assert.equal(kit.fake.callsTo(SUBMIT).length, 0);
});

test('locked funds: the agent works and commits the hash of its result', async (t) => {
  const {fake, job} = await delivered(t);

  const [{body}] = fake.callsTo(SUBMIT);

  assert.equal(job().phase, 'awaiting-result');
  assert.equal(body.submitResultHash, resultHash(job().result, NONCE));
  assert.equal(body.network, 'Preprod');
});

test('the result stays hidden until the chain confirms it, then passes acceptance', async (t) => {
  const kit = await delivered(t);
  const hidden = await kit.status(kit.id);

  kit.fake.chain.confirmResult(kit.bid);
  await kit.loop.tick();
  const shown = await kit.status(kit.id);

  assert.equal(hidden.result, undefined);
  assert.equal(shown.status, 'completed');
  const job = jobOf('normalize');
  const verdict = accept({
    kind: 'normalize',
    spec: job.acceptance,
    inputTable: job.table,
    resultText: shown.result,
    nonce: NONCE,
    onChainResultHash: kit.fake.chain.payment(kit.bid).resultHash,
  });
  assert.deepEqual(verdict.failures, []);
});

test('a result hash on chain that is not ours does not complete the job', async (t) => {
  const {loop, fake, bid, job} = await delivered(t);
  fake.chain.finish(bid, 'ResultSubmitted');

  await loop.tick();

  assert.equal(job().status, 'running');
});

test('a result on chain that is not confirmed yet does not complete the job', async (t) => {
  const kit = await setupSpecialist(t, {
    work: standardWork(),
    mps: (fake) => async (path, body) => {
      const answer = await fake.request(path, body);
      if (path !== '/payment/resolve-blockchain-identifier' || answer.onChainState !== 'ResultSubmitted') return answer;
      return {...answer, CurrentTransaction: {txHash: 'tx', status: 'Pending', newOnChainState: 'ResultSubmitted'}, TransactionHistory: []};
    },
  });
  const {id, blockchainIdentifier: bid} = await kit.start();
  kit.fake.chain.lockFunds(bid);
  await kit.loop.tick();
  kit.fake.chain.confirmResult(bid);

  await kit.loop.tick();

  assert.equal(kit.store.load(id).phase, 'awaiting-result');
  assert.equal(kit.store.load(id).status, 'running');
});

test('a submit transaction that failed is logged', async (t) => {
  const {loop, fake, bid, logged} = await delivered(t);
  fake.chain.setNextAction(bid, 'WaitingForManualAction', {errorType: 'NetworkError', errorNote: 'The transaction was rejected'});

  await loop.tick();

  assert.match(logged.join('\n'), /The transaction was rejected/);
});

for (const phase of ['no-show', 'deadline-blocked']) {
  test(`a job in ${phase} still agrees to a refund`, async (t) => {
    const kit = await quoted(t);
    kit.fake.chain.lockFunds(kit.bid);
    kit.store.save({...kit.job(), phase, status: 'failed'});
    kit.fake.chain.askRefund(kit.bid);

    await kit.loop.tick();

    assert.equal(kit.fake.callsTo(AUTHORIZE).length, 1);
    assert.equal(kit.job().phase, 'refund-authorized');
  });
}

test('a no-show fault never submits', async (t) => {
  const fault = parseFault('no_show');
  const {loop, fake, job} = await delivered(t, {
    profile: PROFILES.cheap,
    fault,
    work: createWork({profile: PROFILES.cheap, fault}),
  });

  await loop.tick();

  assert.equal(job().phase, 'no-show');
  assert.equal(job().status, 'failed');
  assert.equal(fake.callsTo(SUBMIT).length, 0);
});

test('work is not started when the deadline is under two minutes away', async (t) => {
  const kit = await quoted(t);
  kit.fake.chain.lockFunds(kit.bid);
  kit.advance(15 * MINUTE_MS + 1);

  await kit.loop.tick();

  assert.equal(kit.job().phase, 'deadline-blocked');
  assert.equal(kit.job().status, 'failed');
  assert.equal(kit.fake.callsTo(SUBMIT).length, 0);
});

test('a result finished after the deadline is not submitted', async (t) => {
  const kit = await quoted(t, {
    work: async () => {
      kit.advance(20 * MINUTE_MS);
      return 'late';
    },
  });
  kit.fake.chain.lockFunds(kit.bid);

  await kit.loop.tick();

  assert.equal(kit.job().phase, 'deadline-blocked');
  assert.equal(kit.fake.callsTo(SUBMIT).length, 0);
});

test('a job whose funds never arrived expires and stops being polled', async (t) => {
  const {loop, fake, job, advance} = await quoted(t);
  advance(17 * MINUTE_MS);

  await loop.tick();
  const polled = fake.calls.length;
  await loop.tick();

  assert.equal(job().phase, 'expired');
  assert.equal(job().status, 'failed');
  assert.equal(fake.calls.length, polled);
});

test('a refund asked after the result is authorized once, and the result stays readable', async (t) => {
  const {loop, fake, bid, id, status, job} = await completed(t);
  fake.chain.askRefund(bid);

  await loop.tick();
  await loop.tick();

  assert.equal(fake.chain.payment(bid).onChainState, 'Disputed');
  assert.equal(fake.callsTo(AUTHORIZE).length, 1);
  assert.equal(fake.callsTo(AUTHORIZE)[0].body.blockchainIdentifier, bid);
  assert.equal(job().phase, 'refund-authorized');
  assert.equal((await status(id)).status, 'completed');
});

test('a refund asked before any result is authorized and no work is done', async (t) => {
  const {loop, fake, bid, job} = await quoted(t);
  fake.chain.lockFunds(bid);
  fake.chain.askRefund(bid);

  await loop.tick();

  assert.equal(fake.chain.payment(bid).onChainState, 'RefundRequested');
  assert.equal(fake.callsTo(AUTHORIZE).length, 1);
  assert.equal(fake.callsTo(SUBMIT).length, 0);
  assert.equal(job().status, 'failed');
});

test('no authorize call goes out while a transaction is in flight', async (t) => {
  const {loop, fake, bid} = await completed(t);
  fake.chain.askRefund(bid);
  fake.chain.setNextAction(bid, 'SubmitResultRequested');

  await loop.tick();

  assert.equal(fake.callsTo(AUTHORIZE).length, 0);
});

test('an authorize that failed is tried again, and only until the chain moves', async (t) => {
  let isDown = true;
  const kit = await setupSpecialist(t, {
    work: standardWork(),
    mps: (fake) => async (path, body) => {
      if (path === AUTHORIZE && isDown) throw new PaymentsError('Request timed out');
      return fake.request(path, body);
    },
  });
  const {id, blockchainIdentifier: bid} = await kit.start();
  kit.fake.chain.lockFunds(bid);
  kit.fake.chain.askRefund(bid);

  await kit.loop.tick();
  const afterFailure = kit.store.load(id).phase;
  isDown = false;
  await kit.loop.tick();
  kit.fake.chain.confirmRefundAuthorized(bid);
  await kit.loop.tick();

  assert.equal(afterFailure, 'refund-authorize-pending');
  assert.equal(kit.store.load(id).phase, 'refund-authorized');
  assert.match(kit.logged.join('\n'), /Request timed out/);
});

test('a refund authorized on chain settles when the buyer collects', async (t) => {
  const {loop, fake, bid, job} = await completed(t);
  fake.chain.askRefund(bid);
  await loop.tick();
  fake.chain.confirmRefundAuthorized(bid);
  await loop.tick();
  const before = job().phase;

  fake.chain.finish(bid, 'RefundWithdrawn');
  await loop.tick();

  assert.equal(before, 'refund-authorized');
  assert.equal(job().phase, 'settled');
  assert.equal(job().settledAs, 'RefundWithdrawn');
});

test('a settled job stops being polled and keeps its result', async (t) => {
  const {loop, fake, bid, id, status} = await completed(t);
  fake.chain.finish(bid, 'Withdrawn');
  await loop.tick();
  const polled = fake.calls.length;

  await loop.tick();

  assert.equal(fake.calls.length, polled);
  assert.equal((await status(id)).status, 'completed');
});

test('restart while the model was working: the work runs again and is submitted once', async (t) => {
  const kit = await quoted(t);
  kit.fake.chain.lockFunds(kit.bid);
  kit.store.save({...kit.job(), phase: 'model-pending', status: 'running'});

  await kit.loop.tick();

  assert.equal(kit.job().phase, 'awaiting-result');
  assert.equal(kit.fake.callsTo(SUBMIT).length, 1);
});

test('restart after a submit that went through: it is not sent again', async (t) => {
  const kit = await delivered(t);
  kit.store.save({...kit.job(), phase: 'submit-pending'});

  await kit.loop.tick();

  assert.equal(kit.job().phase, 'awaiting-result');
  assert.equal(kit.fake.callsTo(SUBMIT).length, 1);
});

test('restart after a submit that was lost: it is sent', async (t) => {
  const kit = await quoted(t);
  kit.fake.chain.lockFunds(kit.bid);
  const result = 'saved result';
  kit.store.save({...kit.job(), phase: 'submit-pending', status: 'running', result, resultHash: resultHash(result, NONCE)});

  await kit.loop.tick();

  assert.equal(kit.job().phase, 'awaiting-result');
  assert.equal(kit.fake.callsTo(SUBMIT).length, 1);
});

test('restart while another transaction is in flight: nothing is sent yet', async (t) => {
  const kit = await quoted(t);
  kit.fake.chain.lockFunds(kit.bid);
  const result = 'saved result';
  kit.store.save({...kit.job(), phase: 'submit-pending', status: 'running', result, resultHash: resultHash(result, NONCE)});
  kit.fake.chain.setNextAction(kit.bid, 'SubmitResultInitiated');

  await kit.loop.tick();

  assert.equal(kit.fake.callsTo(SUBMIT).length, 0);
  assert.equal(kit.job().phase, 'submit-pending');
});

test('a submit with an unknown outcome is looked up before anything is sent again', async (t) => {
  let shouldLose = true;
  const kit = await setupSpecialist(t, {
    work: standardWork(),
    mps: (fake) => async (path, body) => {
      if (path !== SUBMIT || !shouldLose) return fake.request(path, body);
      shouldLose = false;
      await fake.request(path, body);
      throw new PaymentsError('Response lost');
    },
  });
  const {id, blockchainIdentifier: bid} = await kit.start();
  kit.fake.chain.lockFunds(bid);

  await kit.loop.tick();
  const afterLoss = kit.store.load(id).phase;
  await kit.loop.tick();

  assert.equal(afterLoss, 'submit-pending');
  assert.equal(kit.store.load(id).phase, 'awaiting-result');
  assert.equal(kit.fake.callsTo(SUBMIT).length, 1);
});

test('one job that fails does not hold up the others, and the failure is logged', async (t) => {
  const kit = await setupSpecialist(t, {
    work: standardWork(),
    mps: (fake) => async (path, body) => {
      if (path === '/payment/resolve-blockchain-identifier' && body.blockchainIdentifier === broken) throw new PaymentsError('Lookup failed', {status: 500});
      return fake.request(path, body);
    },
  });
  const first = await kit.start('normalize', 'aa'.repeat(10));
  const second = await kit.start('normalize', 'bb'.repeat(10));
  const broken = first.blockchainIdentifier;
  kit.fake.chain.lockFunds(first.blockchainIdentifier);
  kit.fake.chain.lockFunds(second.blockchainIdentifier);

  await kit.loop.tick();

  assert.equal(kit.store.load(second.id).phase, 'awaiting-result');
  assert.equal(kit.store.load(first.id).phase, 'waiting-payment');
  assert.match(kit.logged.join('\n'), /Lookup failed/);
});

test('two ticks at once do the work once', async (t) => {
  let runs = 0;
  const kit = await quoted(t, {
    work: async () => {
      runs += 1;
      return 'result';
    },
  });
  kit.fake.chain.lockFunds(kit.bid);

  await Promise.all([kit.loop.tick(), kit.loop.tick()]);

  assert.equal(runs, 1);
  assert.equal(kit.fake.callsTo(SUBMIT).length, 1);
});
