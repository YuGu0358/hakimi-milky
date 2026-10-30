import test from 'node:test';
import assert from 'node:assert/strict';
import {describeAgent, isPublicAddress, readCatalog} from './catalog.mjs';
import {USDM_UNIT} from '../shared/constants.mjs';
import {REGISTRIES} from './sources.mjs';

const [current, older] = REGISTRIES;
const idIn = ({policy}, index) => `${policy}${String(index).padStart(8, '0')}`;

const currentMetadata = ({url = 'https://agent.masumi.network', type = 'Fixed'} = {}) => ({
  name: ['Table agent'],
  api_base_url: [url],
  tags: ['table'],
  supported_payment_sources: [
    {
      chain: 'Cardano',
      network: 'Preprod',
      settlement: {paymentSourceType: 'Web3CardanoV2'},
      pricing: {pricingType: type, ...(type === 'Fixed' ? {fixed: [{asset: USDM_UNIT, amount: 200000}]} : {})},
    },
  ],
});
const olderMetadata = ({url = 'https://old.masumi.network'} = {}) => ({
  name: ['Old agent'],
  api_base_url: [url],
  tags: ['old'],
  agentPricing: {pricingType: 'Fixed', fixedPricing: [{unit: [], amount: '1000000'}]},
  metadata_version: '1',
});

// A fake Blockfrost: pages per policy, metadata per asset.
function chain({pages = {}, metadataOf = () => currentMetadata()} = {}) {
  const seen = [];
  const get = async (path) => {
    seen.push(path);
    const url = new URL(path, 'http://x');
    const policy = url.pathname.match(/\/assets\/policy\/([0-9a-f]+)/)?.[1];
    if (policy) return pages[policy]?.[Number(url.searchParams.get('page')) - 1] ?? [];
    const id = url.pathname.split('/').at(-1);
    return {asset: id, quantity: '1', onchain_metadata: metadataOf(id)};
  };
  return {get, seen};
}

const livePage = (registry, start, length, quantity = '1') =>
  Array.from({length}, (_, index) => ({asset: idIn(registry, start + index), quantity}));

test('every page is read, not only the newest ones, so an old agent is counted', async () => {
  const pages = {[current.policy]: [0, 1, 2, 3, 4].map((page) => livePage(current, page * 100, 100)).concat([livePage(current, 500, 7)])};
  const {get} = chain({pages});

  const {summary, entries} = await readCatalog({get});

  assert.equal(summary.find(({name}) => name === current.name).live, 507);
  assert.ok(entries.some(({agentIdentifier}) => agentIdentifier === idIn(current, 0)));
});

test('the older registry is read too, and its agents are counted but marked as not payable here', async () => {
  const pages = {[current.policy]: [livePage(current, 0, 1)], [older.policy]: [livePage(older, 0, 2)]};
  const {get} = chain({pages, metadataOf: (id) => (id.startsWith(older.policy) ? olderMetadata() : currentMetadata())});

  const {summary, entries} = await readCatalog({get});

  const row = summary.find(({name}) => name === older.name);
  assert.equal(row.live, 2);
  assert.equal(row.hireableHere, 0);
  assert.equal(summary.find(({name}) => name === current.name).hireableHere, 1);
  const old = entries.find(({registry}) => registry === older.name);
  assert.equal(old.hireableHere, false);
  assert.match(old.why, /contract/);
  assert.equal(old.pricingType, 'Fixed');
  assert.deepEqual(old.price, {unit: '', amount: '1000000'});
});

test('a burned agent is not counted as live and its metadata is not read', async () => {
  const pages = {[current.policy]: [[...livePage(current, 0, 1), ...livePage(current, 1, 1, '0')]]};
  const {get, seen} = chain({pages});

  const {summary} = await readCatalog({get});

  const row = summary.find(({name}) => name === current.name);
  assert.equal(row.minted, 2);
  assert.equal(row.live, 1);
  assert.equal(seen.some((path) => path.endsWith(idIn(current, 1))), false);
});

test('only Blockfrost is asked: nothing a stranger registered is ever called', async () => {
  const pages = {[current.policy]: [livePage(current, 0, 1)]};
  const {get, seen} = chain({pages, metadataOf: () => currentMetadata({url: 'http://169.254.169.254/latest'})});

  await readCatalog({get});

  assert.ok(seen.every((path) => path.startsWith('/assets/')));
});

test('metadata already saved is not read again', async () => {
  const pages = {[current.policy]: [livePage(current, 0, 2)]};
  const {get, seen} = chain({pages});
  const cache = new Map([[idIn(current, 0), currentMetadata()]]);

  const {summary} = await readCatalog({get, cache});

  assert.equal(summary.find(({name}) => name === current.name).live, 2);
  assert.equal(seen.filter((path) => path.endsWith(idIn(current, 0))).length, 0);
  assert.equal(seen.filter((path) => path.endsWith(idIn(current, 1))).length, 1);
});

test('a read that fails halfway keeps the metadata it already has', async () => {
  const pages = {[current.policy]: [livePage(current, 0, 20)]};
  const {get: base} = chain({pages});
  const get = async (path) => {
    if (path.endsWith(idIn(current, 15))) throw new Error('HTTP 429');
    return base(path);
  };
  const cache = new Map();

  await assert.rejects(readCatalog({get, cache}), /429/);

  assert.ok(cache.size >= 8);
});

test('a registry that never ends is an error, not a silent cut', async () => {
  const get = async (path) => (path.includes('/assets/policy/') ? livePage(current, 0, 100, '0') : {});

  await assert.rejects(readCatalog({get}), /pages/);
});

test('an agent reads as hireable only with our contract, a fixed price and a public address', () => {
  const id = idIn(current, 1);

  assert.equal(describeAgent(id, currentMetadata()).hireableHere, true);
  assert.match(describeAgent(id, currentMetadata({type: 'Dynamic'})).why, /fixed price/);
  assert.match(describeAgent(id, currentMetadata({url: 'http://localhost:3000'})).why, /public address/);
  assert.match(describeAgent(id, {name: ['x']}).why, /format/);
  assert.match(describeAgent(id, null).why, /metadata/);
});

test('private and placeholder addresses are not public, by the text alone', () => {
  for (const url of ['http://localhost:1', 'http://127.0.0.1:9', 'http://10.0.0.1', 'http://192.168.1.1', 'http://172.16.0.1', 'http://169.254.169.254', 'https://api.example.com', 'http://[::1]/', 'not a url', 'ftp://agent.test', 'https://localhost.', 'https://x.local.', 'https://metadata.google.internal.', 'https://foo.localhost', 'https://100.64.0.1', 'https://198.18.0.1', 'https://224.0.0.1', 'https://0.1.2.3']) {
    assert.equal(isPublicAddress(url), false, url);
  }
  assert.equal(isPublicAddress('https://agent.masumi.network/x'), true);
});
