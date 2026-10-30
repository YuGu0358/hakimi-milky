import test from 'node:test';
import assert from 'node:assert/strict';
import {createReviewer} from './reviewer.mjs';
import {createMandate} from './mandate.mjs';
import {USDM_UNIT} from '../shared/constants.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import agents from '../shared/fixtures/agents.json' with {type: 'json'};

const T0 = 1_793_340_000_000;
const mandate = createMandate({taskId: 'task-1', allowlist: agents, acceptance, startedAt: T0});
const [standard, cheap] = agents;
const proposal = {
  proposalId: 'p1',
  subtask: 'normalize',
  agentIdentifier: cheap.agentIdentifier,
  maxPrice: {unit: USDM_UNIT, amount: '200000'},
  reason: 'cheapest',
};
const listings = agents.map((agent) => ({...agent, trackRecord: {completed: 0, refunded: 1}}));

// The same shape the Jev API returned when we tried it.
const jevAnswer = ({verdict = 'approve', confidence = 0.94, withinMandate = 0.97} = {}) => ({
  model: 'jev-1.14.0',
  answers: {
    within_mandate: {type: 'noul', noul: withinMandate},
    lowest_price: {type: 'noul', noul: 0.98},
    has_refund: {type: 'noul', noul: 0.99},
    verdict: {type: 'choice', choice: verdict, confidence, probabilities: {approve: 0.5, veto: 0.5}},
  },
  usage: {input_tokens: 755, output_tokens: 102},
});

const reviewWith = (decide) => createReviewer({decide})({mandate, proposal, listings});

test('a confident approve lets the hire go ahead', async () => {
  const review = await reviewWith(async () => jevAnswer());
  assert.equal(review.decision, 'allow');
});

test('a confident veto stops the hire and says which facts it saw', async () => {
  const review = await reviewWith(async () => jevAnswer({verdict: 'veto'}));
  assert.equal(review.decision, 'veto');
  assert.match(review.reason, /veto/i);
  assert.equal(review.detail.answers.has_refund, 0.99);
  assert.equal(review.detail.confidence, 0.94);
});

test('below the threshold it asks the owner instead of deciding, in both directions', async () => {
  assert.equal((await reviewWith(async () => jevAnswer({verdict: 'veto', confidence: 0.79}))).decision, 'escalate');
  assert.equal((await reviewWith(async () => jevAnswer({verdict: 'approve', confidence: 0.79}))).decision, 'escalate');
});

test('the threshold itself counts as confident', async () => {
  assert.equal((await reviewWith(async () => jevAnswer({verdict: 'veto', confidence: 0.8}))).decision, 'veto');
});

test('an approve that contradicts its own mandate answer is not trusted', async () => {
  assert.equal((await reviewWith(async () => jevAnswer({withinMandate: 0.2}))).decision, 'escalate');
});

test('when Jev is unreachable it fails closed and asks the owner', async () => {
  const review = await reviewWith(async () => {
    throw new Error('network down');
  });
  assert.equal(review.decision, 'escalate');
  assert.match(review.reason, /network down/);
});

test('a malformed answer is never read as an approval', async () => {
  assert.equal((await reviewWith(async () => ({answers: {}}))).decision, 'escalate');
});

test('it sends the mandate, proposal and quotes with readable prices and every question', async () => {
  let request;
  await reviewWith(async (input) => {
    request = input;
    return jevAnswer();
  });
  assert.equal(request.state.proposal.agent, cheap.name);
  assert.equal(request.state.proposal.price, '0.2 tUSDM');
  assert.deepEqual(request.state.quotes.find((quote) => quote.agent === standard.name), {
    agent: standard.name,
    price: '0.3 tUSDM',
    track_record: {completed: 0, refunded: 1},
  });
  assert.equal(request.state.mandate.budget, '0.8 tUSDM');
  assert.deepEqual(Object.keys(request.questions).sort(), ['has_refund', 'lowest_price', 'verdict', 'within_mandate']);
});

test('the state it sends holds no seller reply and no key material', async () => {
  let request;
  await reviewWith(async (input) => {
    request = input;
    return jevAnswer();
  });
  const text = JSON.stringify(request.state);
  assert.ok(!text.includes(cheap.sellerVkey));
  assert.ok(!/key|token|secret/i.test(Object.keys(request.state).join()));
});
