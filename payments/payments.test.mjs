import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createMockPayments} from './mock.mjs';
import {createPayments} from './payments.mjs';
import {listingFromAsset} from '../registry/listing.mjs';
import {USDM_UNIT} from '../shared/constants.mjs';
import {PaymentsError} from '../shared/errors.mjs';
import {inputHash} from '../shared/hash.mjs';
import {jobPrompt} from '../shared/schemas.mjs';
import acceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import agents from '../shared/fixtures/agents.json' with {type: 'json'};
import table from '../shared/fixtures/table.json' with {type: 'json'};

const NONCE = 'ab'.repeat(10);
const JOB = Object.freeze({kind: 'normalize', table, acceptance, key: acceptance.key});
const POLICY_PATH = '/assets/policy/';
const CONTRACT = 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g';

const chunk = (text, size = 60) => (text.match(new RegExp(`.{1,${size}}`, 'g')) ?? []);

// Metadata as the registry really stores it: long strings split into chunks of at most 60.
const metadataOf = ({name = 'Budget Normalizer', url = 'http://127.0.0.1:4102', amount = '200000', sources} = {}) => ({
  name: chunk(name),
  tags: ['table-normalization'],
  api_base_url: chunk(url),
  metadata_version: '2',
  supported_payment_sources: sources ?? [
    {
      chain: ['Cardano'],
      network: ['Preprod'],
      pricing: {fixed: [{asset: chunk(USDM_UNIT), amount}], pricingType: 'Fixed'},
      settlement: {address: chunk(CONTRACT), paymentSourceType: ['Web3CardanoV2']},
    },
  ],
});

async function serve(t, handler) {
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const text = Buffer.concat(parts).toString('utf8');
    const {status = 200, body} = await handler({method: req.method, url: req.url, headers: req.headers, body: text ? JSON.parse(text) : undefined});
    res.writeHead(status, {'content-type': 'application/json'});
    res.end(typeof body === 'string' ? body : JSON.stringify(body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

const closedPort = async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const success = (data) => ({body: {status: 'success', data}});
const failure = (status, message) => ({status, body: {status: 'error', error: {message}}});

const RAW_PURCHASE = Object.freeze({
  id: 'purchase-1',
  blockchainIdentifier: 'bid-1',
  onChainState: 'FundsLocked',
  resultHash: '',
  NextAction: {requestedAction: 'WaitingForExternalAction', errorType: null, errorNote: null},
  CurrentTransaction: {txHash: 'tx-1', status: 'Confirmed', newOnChainState: 'FundsLocked', confirmations: 3},
  TransactionHistory: [],
  WithdrawnForBuyer: [],
  WithdrawnForSeller: [],
});

async function setup(t, {mps = () => success(RAW_PURCHASE), agent = () => ({body: {}}), blockfrost = () => ({body: []})} = {}) {
  const seen = {mps: [], agent: [], blockfrost: []};
  const record = (name, handler) => (request) => {
    seen[name].push(request);
    return handler(request);
  };
  const mpsUrl = await serve(t, record('mps', mps));
  const agentUrl = await serve(t, record('agent', agent));
  const blockfrostUrl = await serve(t, record('blockfrost', blockfrost));
  const payments = createPayments({mpsUrl, token: 'buyer-token', blockfrostUrl, blockfrostKey: 'bf-key'});
  return {payments, seen, listing: {apiBaseUrl: agentUrl}};
}

const QUOTE = Object.freeze({
  jobId: 'job-1',
  blockchainIdentifier: 'bid-1',
  agentIdentifier: agents[1].agentIdentifier,
  sellerVkey: agents[1].sellerVkey,
  inputHash: 'cd'.repeat(32),
  identifierFromPurchaser: NONCE,
  paymentSourceType: 'Web3CardanoV2',
  supportedPaymentSourceIndex: 0,
  payByTime: 1_793_340_480_000,
  submitResultTime: 1_793_341_020_000,
  unlockTime: 1_793_341_920_000,
  externalDisputeUnlockTime: 1_793_342_820_000,
});
const AMOUNTS = Object.freeze([{unit: USDM_UNIT, amount: '200000'}]);
const METADATA = Object.freeze({taskId: 'task-1', proposalId: 'p-1', subtask: 'normalize'});

const rejectsWith = (promise, {status, kind, message}) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof PaymentsError);
    assert.equal(error.status, status);
    assert.equal(error.kind, kind);
    if (message) assert.match(error.message, message);
    return true;
  });

test('a listing is rebuilt from the chunked metadata', () => {
  const listing = listingFromAsset(agents[1].agentIdentifier, metadataOf());

  assert.deepEqual(listing, {
    agentIdentifier: agents[1].agentIdentifier,
    name: 'Budget Normalizer',
    apiBaseUrl: 'http://127.0.0.1:4102',
    pricingType: 'Fixed',
    price: {unit: USDM_UNIT, amount: '200000'},
    supportedPaymentSourceIndex: 0,
    tags: ['table-normalization'],
  });
});

test('the source index is the position of the Preprod V2 source', () => {
  const other = {chain: ['Cardano'], network: ['Mainnet'], pricing: {pricingType: 'Dynamic'}, settlement: {address: chunk(CONTRACT), paymentSourceType: ['Web3CardanoV2']}};
  const [real] = metadataOf().supported_payment_sources;

  const listing = listingFromAsset(agents[1].agentIdentifier, metadataOf({sources: [other, real]}));

  assert.equal(listing.supportedPaymentSourceIndex, 1);
});

test('a dynamic price has no listed amount', () => {
  const [real] = metadataOf().supported_payment_sources;
  const dynamic = {...real, pricing: {pricingType: 'Dynamic'}};

  const listing = listingFromAsset(agents[1].agentIdentifier, metadataOf({sources: [dynamic]}));

  assert.equal(listing.pricingType, 'Dynamic');
  assert.equal(listing.price, null);
});

for (const [label, metadata] of [
  ['no metadata', null],
  ['no payment sources', {name: ['x'], api_base_url: ['http://x'], metadata_version: '1'}],
  ['a source on another network only', metadataOf({sources: [{chain: ['Cardano'], network: ['Mainnet'], pricing: {pricingType: 'Dynamic'}, settlement: {paymentSourceType: ['Web3CardanoV2']}}]})],
  ['no address to call', {...metadataOf(), api_base_url: undefined}],
]) {
  test(`an asset with ${label} is not a usable listing`, () => {
    assert.equal(listingFromAsset(agents[1].agentIdentifier, metadata), null);
  });
}

const assetId = (index) => `${'67'.repeat(28)}${String(index).padStart(4, '0')}`;

const registry = (pages, metadataFor = () => metadataOf()) => ({url}) => {
  const parsed = new URL(url, 'http://x');
  if (parsed.pathname.startsWith(POLICY_PATH)) return {body: pages[Number(parsed.searchParams.get('page')) - 1] ?? []};
  const id = parsed.pathname.split('/').at(-1);
  const metadata = metadataFor(id);
  return metadata === undefined ? {status: 404, body: {message: 'not found'}} : {body: {asset: id, onchain_metadata: metadata}};
};

test('listAgents reads the agents it is asked for with the project key, and no others', async (t) => {
  const {payments, seen} = await setup(t, {blockfrost: registry([[{asset: assetId(1), quantity: '1'}]])});

  const listings = await payments.listAgents([assetId(9)]);

  assert.deepEqual(listings.map((item) => item.agentIdentifier), [assetId(9)]);
  assert.equal(seen.blockfrost[0].headers.project_id, 'bf-key');
  assert.equal(seen.blockfrost.some(({url}) => url.startsWith(POLICY_PATH)), false);
});

test('an agent however old is read like a new one, because no page limit stands in the way', async (t) => {
  const {payments} = await setup(t, {blockfrost: registry([[]])});

  const listings = await payments.listAgents([assetId(1), assetId(1), assetId(2)]);

  assert.deepEqual(listings.map((item) => item.agentIdentifier).sort(), [assetId(1), assetId(2)].sort());
});

test('an agent that does not exist or that it cannot use is left out, not an error', async (t) => {
  const {payments} = await setup(t, {blockfrost: registry([[]], (id) => (id === assetId(3) ? null : undefined))});

  assert.deepEqual(await payments.listAgents([assetId(3), assetId(9)]), []);
});

test('a burned agent is left out', async (t) => {
  const {payments} = await setup(t, {blockfrost: () => ({body: {asset: assetId(1), quantity: '0', onchain_metadata: metadataOf()}})});

  assert.deepEqual(await payments.listAgents([assetId(1)]), []);
});

test('a Blockfrost failure carries its status', async (t) => {
  const {payments} = await setup(t, {blockfrost: () => ({status: 403, body: {message: 'bad key'}})});

  await rejectsWith(payments.listAgents([assetId(1)]), {status: 403, kind: 'rejected', message: /403/});
});

test('startJob sends the job as the single prompt and maps the answer to a quote', async (t) => {
  const prompt = jobPrompt(JOB);
  const answer = {
    id: 'job-1',
    input_hash: inputHash({prompt}, NONCE),
    identifierFromPurchaser: NONCE,
    blockchainIdentifier: 'bid-1',
    agentIdentifier: agents[1].agentIdentifier,
    sellerVKey: agents[1].sellerVkey,
    paymentSourceType: 'Web3CardanoV2',
    supportedPaymentSourceIndex: 0,
    payByTime: QUOTE.payByTime,
    submitResultTime: QUOTE.submitResultTime,
    unlockTime: QUOTE.unlockTime,
    externalDisputeUnlockTime: QUOTE.externalDisputeUnlockTime,
  };
  const {payments, seen, listing} = await setup(t, {agent: () => ({body: answer})});

  const quote = await payments.startJob(listing, JOB, NONCE);

  assert.deepEqual(seen.agent[0].body, {identifier_from_purchaser: NONCE, input_data: {prompt}});
  assert.equal(seen.agent[0].url, '/start_job');
  assert.equal(quote.jobId, 'job-1');
  assert.equal(quote.sellerVkey, agents[1].sellerVkey);
  assert.equal(quote.inputHash, inputHash({prompt}, NONCE));
});

test('a job the seller refuses throws with its status and message', async (t) => {
  const {payments, listing} = await setup(t, {agent: () => ({status: 400, body: {error: 'Wrong kind'}})});

  await rejectsWith(payments.startJob(listing, JOB, NONCE), {status: 400, kind: 'rejected', message: /Wrong kind/});
});

test('startJob is never sent twice when the seller cannot be reached', async (t) => {
  const port = await closedPort();
  const {payments} = await setup(t);

  await rejectsWith(payments.startJob({apiBaseUrl: `http://127.0.0.1:${port}`}, JOB, NONCE), {status: null, kind: 'uncertain'});
});

test('purchase sends the quote, the amounts and the metadata, with the key in the header', async (t) => {
  const {payments, seen} = await setup(t, {mps: () => success({...RAW_PURCHASE, NextAction: {requestedAction: 'FundsLockingRequested'}})});

  const order = await payments.purchase(QUOTE, METADATA, AMOUNTS);

  const [{url, method, headers, body}] = seen.mps;
  assert.equal(url, '/api/v1/purchase');
  assert.equal(method, 'POST');
  assert.equal(headers.token, 'buyer-token');
  assert.deepEqual(body, {
    blockchainIdentifier: 'bid-1',
    network: 'Preprod',
    paymentSourceType: 'Web3CardanoV2',
    supportedPaymentSourceIndex: 0,
    inputHash: QUOTE.inputHash,
    sellerVkey: QUOTE.sellerVkey,
    agentIdentifier: QUOTE.agentIdentifier,
    Amounts: AMOUNTS,
    payByTime: String(QUOTE.payByTime),
    submitResultTime: String(QUOTE.submitResultTime),
    unlockTime: String(QUOTE.unlockTime),
    externalDisputeUnlockTime: String(QUOTE.externalDisputeUnlockTime),
    identifierFromPurchaser: NONCE,
    metadata: JSON.stringify(METADATA),
  });
  assert.deepEqual(order, {id: 'purchase-1', blockchainIdentifier: 'bid-1', nextAction: 'FundsLockingRequested', existed: false});
});

test('a 409 means the order is already there, not a failure', async (t) => {
  const {payments} = await setup(t, {mps: () => failure(409, 'Purchase exists')});

  const order = await payments.purchase(QUOTE, METADATA, AMOUNTS);

  assert.equal(order.existed, true);
  assert.equal(order.blockchainIdentifier, 'bid-1');
});

for (const [status, kind, message] of [
  [400, 'rejected', 'Insufficient funds'],
  [401, 'rejected', 'Unauthorized, network not allowed'],
  [404, 'not-found', 'Not found'],
  [500, 'uncertain', 'Internal error'],
]) {
  test(`an order answered with ${status} throws as ${kind}, with the service's message`, async (t) => {
    const {payments} = await setup(t, {mps: () => failure(status, message)});

    await rejectsWith(payments.purchase(QUOTE, METADATA, AMOUNTS), {status, kind, message: new RegExp(message)});
  });
}

test('an order whose answer is lost has an uncertain outcome', async () => {
  const port = await closedPort();
  const payments = createPayments({mpsUrl: `http://127.0.0.1:${port}`, token: 'buyer-token', blockfrostUrl: 'http://127.0.0.1:1', blockfrostKey: 'bf-key'});

  await rejectsWith(payments.purchase(QUOTE, METADATA, AMOUNTS), {status: null, kind: 'uncertain'});
});

test('getPurchase maps the answer to the view the hire flow reads', async (t) => {
  const {payments, seen} = await setup(t);

  const view = await payments.getPurchase('bid-1');

  assert.equal(seen.mps[0].url, '/api/v1/purchase/resolve-blockchain-identifier');
  assert.deepEqual(seen.mps[0].body, {network: 'Preprod', blockchainIdentifier: 'bid-1', includeHistory: 'true'});
  assert.equal(view.blockchainIdentifier, 'bid-1');
  assert.equal(view.onChainState, 'FundsLocked');
  assert.equal(view.resultHash, null);
  assert.deepEqual(view.current, {txHash: 'tx-1', status: 'Confirmed', newOnChainState: 'FundsLocked'});
});

test('a purchase that does not exist throws as not-found, which is what the restart logic relies on', async (t) => {
  const {payments} = await setup(t, {mps: () => failure(404, 'Purchase not found')});

  await rejectsWith(payments.getPurchase('bid-1'), {status: 404, kind: 'not-found'});
});

test('requestRefund asks for the refund and reports the state', async (t) => {
  const {payments, seen} = await setup(t, {mps: () => success({...RAW_PURCHASE, NextAction: {requestedAction: 'SetRefundRequestedRequested'}})});

  const answer = await payments.requestRefund('bid-1');

  assert.equal(seen.mps[0].url, '/api/v1/purchase/request-refund');
  assert.deepEqual(seen.mps[0].body, {network: 'Preprod', blockchainIdentifier: 'bid-1'});
  assert.deepEqual(answer, {nextAction: 'SetRefundRequestedRequested', onChainState: 'FundsLocked'});
});

test('a refund in the wrong state throws with the message', async (t) => {
  const {payments} = await setup(t, {mps: () => failure(404, 'Purchase not found or not in valid state')});

  await rejectsWith(payments.requestRefund('bid-1'), {status: 404, kind: 'not-found', message: /not in valid state/});
});

test('getJobResult reads the status route', async (t) => {
  const {payments, seen, listing} = await setup(t, {agent: () => ({body: {id: 'job-1', status: 'completed', result: 'done'}})});

  const answer = await payments.getJobResult(listing, 'job-1');

  assert.equal(seen.agent[0].url, '/status?job_id=job-1');
  assert.deepEqual(answer, {status: 'completed', result: 'done'});
});

test('a result that is not ready is not a failure', async (t) => {
  const {payments, listing} = await setup(t, {agent: () => ({body: {id: 'job-1', status: 'running'}})});

  const answer = await payments.getJobResult(listing, 'job-1');

  assert.equal(answer.status, 'running');
  assert.equal(answer.result, undefined);
});

test('an unknown job throws', async (t) => {
  const {payments, listing} = await setup(t, {agent: () => ({status: 404, body: {error: 'Job not found'}})});

  await rejectsWith(payments.getJobResult(listing, 'job-1'), {status: 404, kind: 'not-found'});
});

test('the real client has the mock\'s six functions and the same return shapes', async (t) => {
  const mock = createMockPayments();
  const {payments} = await setup(t);
  const sorted = (value) => Object.keys(value).sort();

  const names = ['listAgents', 'startJob', 'purchase', 'getPurchase', 'requestRefund', 'getJobResult'];
  for (const name of names) assert.equal(typeof payments[name], 'function', name);

  const mockQuote = await mock.startJob(agents[1], JOB, NONCE);
  const mockOrder = await mock.purchase(mockQuote, METADATA, [agents[1].price]);
  const mockView = await mock.getPurchase(mockQuote.blockchainIdentifier);
  const mockRefund = await mock.requestRefund(mockQuote.blockchainIdentifier);
  const mockResult = await mock.getJobResult(agents[1], mockQuote.jobId);

  assert.deepEqual(sorted(await payments.purchase(QUOTE, METADATA, AMOUNTS)), sorted(mockOrder));
  assert.deepEqual(sorted(await payments.getPurchase('bid-1')), sorted(mockView));
  assert.deepEqual(sorted(await payments.requestRefund('bid-1')), sorted(mockRefund));
  assert.deepEqual(sorted(listingFromAsset(agents[1].agentIdentifier, metadataOf())), sorted((await mock.listAgents())[0]));
  assert.deepEqual(sorted(mockResult), ['result', 'status']);
});

test('missing settings fail at once', () => {
  assert.throws(() => createPayments({mpsUrl: 'http://x', token: 't', blockfrostUrl: 'http://x'}), /BLOCKFROST/);
  assert.throws(() => createPayments({mpsUrl: 'http://x', token: '', blockfrostKey: 'k'}), /key is missing/);
});
