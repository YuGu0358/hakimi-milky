import test from 'node:test';
import assert from 'node:assert/strict';
import {checkAdmission, mergedAllowlist, paymentKeyOf} from './allow.mjs';
import {REGISTRIES} from './sources.mjs';
import {USDM_UNIT} from '../shared/constants.mjs';
import {decodeBech32} from '../shared/bech32.mjs';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

// The other direction of the decoder, for building test addresses.
function polymod(values) {
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    GENERATORS.forEach((generator, index) => {
      if ((top >>> index) & 1) check ^= generator;
    });
  }
  return check >>> 0;
}
function encode(prefix, bytes) {
  const words = [];
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((buffer >> bits) & 31);
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0) words.push((buffer << (5 - bits)) & 31);
  const codes = [...prefix].map((character) => character.charCodeAt(0));
  const expanded = [...codes.map((code) => code >> 5), 0, ...codes.map((code) => code & 31)];
  const mod = polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((index) => (mod >> (5 * (5 - index))) & 31);
  return `${prefix}1${[...words, ...checksum].map((word) => CHARSET[word]).join('')}`;
}

const KEY = 'ab'.repeat(28);
const addressWith = (header, key = KEY) => encode('addr_test', [header, ...Buffer.from(key, 'hex'), ...Buffer.alloc(28, 7)]);
const [current, older] = REGISTRIES;
const ID = `${current.policy}6f6c64`;
const LIMITS = {perHire: {[USDM_UNIT]: '400000'}};
const metadata = ({url = 'https://old-agent.masumi.network', pricing = {pricingType: 'Fixed', fixed: [{asset: USDM_UNIT, amount: 300000}]}} = {}) => ({
  name: ['A stranger\'s name'],
  api_base_url: [url],
  tags: [],
  supported_payment_sources: [{chain: 'Cardano', network: 'Preprod', settlement: {paymentSourceType: 'Web3CardanoV2'}, pricing}],
});
const request = (overrides = {}) => ({
  agentIdentifier: ID,
  quantity: '1',
  metadata: metadata(),
  holderAddress: addressWith(0x00),
  role: 'normalize',
  alias: 'Old normalizer',
  shareTable: true,
  limits: LIMITS,
  ...overrides,
});

test('an old agent on the current registry goes on the list under the owner\'s name, with its key pinned', () => {
  const {entry} = checkAdmission(request());

  assert.deepEqual(entry, {agentIdentifier: ID, sellerVkey: KEY, name: 'Old normalizer', apiBaseUrl: 'https://old-agent.masumi.network', role: 'normalize'});
});

const refusals = [
  ['the owner has not agreed to send the table', {shareTable: false}, 'table_not_shared'],
  ['a name with markup', {alias: '<b>Pay me</b>'}, 'bad_name'],
  ['an unknown policy', {agentIdentifier: `${'00'.repeat(28)}6f6c64`}, 'unknown_registry'],
  ['a burned agent', {quantity: '0'}, 'not_live'],
  ['no metadata', {metadata: null}, 'not_live'],
  ['a format we cannot read', {metadata: {name: ['x']}}, 'cannot_read'],
  ['a dynamic price', {metadata: metadata({pricing: {pricingType: 'Dynamic'}})}, 'not_fixed_price'],
  ['another currency', {metadata: metadata({pricing: {pricingType: 'Fixed', fixed: [{asset: 'lovelace', amount: 1}]}})}, 'wrong_currency'],
  ['a unit named like a built-in', {metadata: metadata({pricing: {pricingType: 'Fixed', fixed: [{asset: 'constructor', amount: 1}]}})}, 'wrong_currency'],
  ['a price above one hire', {metadata: metadata({pricing: {pricingType: 'Fixed', fixed: [{asset: USDM_UNIT, amount: 400001}]}})}, 'over_price'],
  ['a private address', {metadata: metadata({url: 'https://169.254.169.254/x'})}, 'not_public'],
  ['plain http', {metadata: metadata({url: 'http://agent.masumi.network'})}, 'not_public'],
  ['a holder that is a script', {holderAddress: addressWith(0x10)}, 'script_holder'],
  ['a holder address with a bad checksum', {holderAddress: `${addressWith(0x00).slice(0, -1)}${addressWith(0x00).endsWith('q') ? 'p' : 'q'}`}, 'bad_holder'],
];
for (const [what, overrides, code] of refusals) {
  test(`admission refuses ${what}`, () => {
    assert.equal(checkAdmission(request(overrides)).refused, code);
  });
}

test('a price exactly at the limit is allowed', () => {
  const {entry} = checkAdmission(request({metadata: metadata({pricing: {pricingType: 'Fixed', fixed: [{asset: USDM_UNIT, amount: 400000}]}})}));

  assert.ok(entry);
});

test('the payment key comes out of a real address form', () => {
  assert.equal(paymentKeyOf(addressWith(0x00, 'cd'.repeat(28))), 'cd'.repeat(28));
  assert.equal(paymentKeyOf(addressWith(0x10)), null);
});

test('the decoder takes the published test vector and refuses a changed one', () => {
  assert.equal(decodeBech32('a12uel5l').prefix, 'a');
  assert.throws(() => decodeBech32('a12uel5q'), /checksum/);
  assert.throws(() => decodeBech32('A12UEL5L'), /lowercase/);
});

test('our own agents win over a pin of the same id, and a new pin is added', () => {
  const entry = (agentIdentifier, name) => ({agentIdentifier, sellerVkey: KEY, name, apiBaseUrl: 'https://agent.masumi.network', role: 'copy'});
  const own = [entry(ID, 'ours')];
  const pins = [entry(ID, 'pin'), entry(`${current.policy}626262`, 'pin')];

  assert.deepEqual(mergedAllowlist(own, pins).map(({name}) => name), ['ours', 'pin']);
});

test('a damaged pin file stops the run instead of widening the list', () => {
  assert.throws(() => mergedAllowlist([], [{agentIdentifier: 'short'}]));
});

test('an agent on the older registry goes on the list, marked as paid through the older contract', () => {
  const olderMetadata = {
    name: ['Old researcher'],
    api_base_url: ['https://old.masumi.network/x'],
    tags: [],
    agentPricing: {pricingType: 'Fixed', fixedPricing: [{unit: [USDM_UNIT.slice(0, 40), USDM_UNIT.slice(40)], amount: '10000'}]},
    metadata_version: '1',
  };

  const {entry} = checkAdmission(request({agentIdentifier: `${older.policy}6f6c64`, metadata: olderMetadata, role: 'research'}));

  assert.equal(entry.role, 'research');
  assert.equal(entry.apiBaseUrl, 'https://old.masumi.network/x');
});
