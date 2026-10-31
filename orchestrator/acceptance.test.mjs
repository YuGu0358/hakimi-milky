import test from 'node:test';
import assert from 'node:assert/strict';
import {accept} from './acceptance.mjs';
import {resultHash} from '../shared/hash.mjs';
import {normalizeTable} from '../shared/table.mjs';
import spec from '../shared/fixtures/acceptance.json' with {type: 'json'};
import table from '../shared/fixtures/table.json' with {type: 'json'};

const nonce = 'ab'.repeat(10);
const good = normalizeTable(table);

const checkTable = (rows, overrides = {}) => {
  const resultText = typeof rows === 'string' ? rows : JSON.stringify(rows);
  return accept({
    kind: 'normalize',
    spec,
    inputTable: table,
    resultText,
    nonce,
    onChainResultHash: resultHash(resultText, nonce),
    ...overrides,
  });
};

const codes = (result) => result.failures.map((failure) => failure.code);
const failure = (result, code) => result.failures.find((item) => item.code === code);
const edit = (sku, changes) => good.map((row) => (row.sku === sku ? {...row, ...changes} : row));

test('a correctly normalized table passes', () => {
  assert.deepEqual(checkTable(good), {ok: true, failures: []});
});

test('A1 fails when the text differs from what the seller committed on chain', () => {
  const committed = JSON.stringify(good);
  const result = checkTable(`${committed} `, {onChainResultHash: resultHash(committed, nonce)});
  assert.ok(codes(result).includes('A1_HASH_MISMATCH'));
});

test('A1 fails when there is no result hash on chain', () => {
  assert.ok(codes(checkTable(good, {onChainResultHash: null})).includes('A1_HASH_MISMATCH'));
});

test('A2 fails on text that is not a JSON array', () => {
  assert.ok(codes(checkTable('not json')).includes('A2_NOT_A_TABLE'));
  assert.ok(codes(checkTable('{"sku":"HM-001"}')).includes('A2_NOT_A_TABLE'));
});

test('A2 fails on a missing column, a wrong column order and an extra column', () => {
  const missing = good.map(({note, ...row}) => row);
  assert.ok(codes(checkTable(missing)).includes('A2_COLUMNS'));
  const reordered = good.map(({sku, name, ...row}) => ({name, sku, ...row}));
  assert.ok(codes(checkTable(reordered)).includes('A2_COLUMNS'));
  const extra = good.map((row) => ({...row, supplier: 'x'}));
  assert.ok(codes(checkTable(extra)).includes('A2_COLUMNS'));
});

test('A3 names exactly the SKUs that were dropped', () => {
  const result = checkTable(good.slice(0, -2));
  assert.deepEqual(failure(result, 'A3_MISSING').skus, ['HM-019', 'HM-020']);
  assert.equal(result.ok, false);
});

test('A3 flags an invented row and a duplicated row', () => {
  const invented = [...good, {...good[0], sku: 'HM-999'}];
  assert.deepEqual(failure(checkTable(invented), 'A3_EXTRA').skus, ['HM-999']);
  const duplicated = [...good, good[0]];
  assert.deepEqual(failure(checkTable(duplicated), 'A3_DUPLICATE').skus, ['HM-001']);
});

test('A3 ignores surrounding spaces but not case', () => {
  assert.equal(checkTable(edit('HM-001', {sku: ' HM-001 '})).ok, true);
  const result = checkTable(edit('HM-001', {sku: 'hm-001'}));
  assert.deepEqual(failure(result, 'A3_MISSING').skus, ['HM-001']);
  assert.deepEqual(failure(result, 'A3_EXTRA').skus, ['hm-001']);
});

test('A3 reports duplicates in the input instead of blaming the seller silently', () => {
  const result = checkTable(good, {inputTable: [...table, table[0]]});
  assert.deepEqual(failure(result, 'A3_INPUT_DUPLICATE').skus, ['HM-001']);
});

test('A4 catches a changed price and names the SKU', () => {
  const result = checkTable(edit('HM-007', {price: 11.5}));
  assert.deepEqual(failure(result, 'A4_IMMUTABLE_CHANGED').skus, ['HM-007']);
});

test('A4 compares by value and aligns by SKU, not by row order', () => {
  assert.equal(failure(checkTable(edit('HM-007', {price: '12.50'})), 'A5_PRICE').skus[0], 'HM-007');
  assert.equal(checkTable([...good].reverse()).ok, true);
});

test('A5 rejects non-positive and unreadable prices', () => {
  for (const price of [0, -1, 'free']) {
    const result = checkTable(edit('HM-001', {price}));
    assert.deepEqual(failure(result, 'A5_PRICE').skus, ['HM-001'], `price ${price}`);
  }
});

test('A5 rejects a unit or category outside the allowed lists', () => {
  assert.deepEqual(failure(checkTable(edit('HM-001', {unit: 'pieces'})), 'A5_UNIT').skus, ['HM-001']);
  assert.deepEqual(failure(checkTable(edit('HM-001', {category: 'Drinks'})), 'A5_CATEGORY').skus, ['HM-001']);
});

test('all failures are listed, it does not stop at the first one', () => {
  const rows = edit('HM-001', {unit: 'pieces', price: 99}).slice(0, -2);
  const committed = JSON.stringify(good);
  const result = checkTable(rows, {onChainResultHash: resultHash(committed, nonce)});
  for (const code of ['A1_HASH_MISMATCH', 'A3_MISSING', 'A4_IMMUTABLE_CHANGED', 'A5_UNIT']) {
    assert.ok(codes(result).includes(code), code);
  }
});

const goodCopy = Object.fromEntries(table.map((row) => [row.sku, `${row.name.trim()}, sold by ${row.unit.trim()}.`]));

const checkCopy = (copy, overrides = {}) => {
  const resultText = typeof copy === 'string' ? copy : JSON.stringify(copy);
  return accept({
    kind: 'copy',
    spec,
    inputTable: table,
    resultText,
    nonce,
    onChainResultHash: resultHash(resultText, nonce),
    ...overrides,
  });
};

test('copy that covers every SKU and follows the text rules passes', () => {
  assert.deepEqual(checkCopy(goodCopy), {ok: true, failures: []});
});

test('copy with a bare domain or an email address is refused as markup', () => {
  const withText = (extra) => ({...goodCopy, 'HM-001': `${goodCopy['HM-001']} ${extra}`});

  assert.ok(codes(checkCopy(withText('Order at evil.com'))).includes('A6_MARKUP'));
  assert.ok(codes(checkCopy(withText('Write to a@b'))).includes('A6_MARKUP'));
  assert.equal(checkCopy(goodCopy).ok, true);
});

test('A1 also applies to copy', () => {
  assert.ok(codes(checkCopy(goodCopy, {onChainResultHash: 'ee'.repeat(32)})).includes('A1_HASH_MISMATCH'));
});

test('A6 fails on text that is not a JSON object', () => {
  assert.ok(codes(checkCopy('nope')).includes('A6_NOT_AN_OBJECT'));
  assert.ok(codes(checkCopy('["a"]')).includes('A6_NOT_AN_OBJECT'));
});

test('A6 names a missing SKU and an invented SKU', () => {
  const {'HM-003': dropped, ...rest} = goodCopy;
  assert.deepEqual(failure(checkCopy(rest), 'A6_MISSING').skus, ['HM-003']);
  assert.deepEqual(failure(checkCopy({...goodCopy, 'HM-999': 'x'}), 'A6_EXTRA').skus, ['HM-999']);
});

test('A6 enforces the length limit at the exact boundary', () => {
  const pad = (length) => {
    const base = goodCopy['HM-001'];
    return base + 'x'.repeat(length - base.length);
  };
  assert.equal(checkCopy({...goodCopy, 'HM-001': pad(160)}).ok, true);
  assert.deepEqual(failure(checkCopy({...goodCopy, 'HM-001': pad(161)}), 'A6_TOO_LONG').skus, ['HM-001']);
});

test('A6 requires each mandatory attribute, ignoring case', () => {
  assert.deepEqual(failure(checkCopy({...goodCopy, 'HM-001': 'Sold by pcs.'}), 'A6_MISSING_ATTRIBUTE').skus, ['HM-001']);
  assert.deepEqual(failure(checkCopy({...goodCopy, 'HM-001': 'Oat Milk Barista 1L.'}), 'A6_MISSING_ATTRIBUTE').skus, ['HM-001']);
  assert.equal(checkCopy({...goodCopy, 'HM-001': 'OAT MILK BARISTA 1L, sold by PCS.'}).ok, true);
});

test('A6 matches banned phrases as whole words, so an honest seller is not refunded over "secures"', () => {
  assert.equal(checkCopy({...goodCopy, 'HM-001': `${goodCopy['HM-001']} Secures four cups.`}).ok, true);
  assert.ok(codes(checkCopy({...goodCopy, 'HM-001': `${goodCopy['HM-001']} Cures colds.`})).includes('A6_BANNED_PHRASE'));
  assert.ok(codes(checkCopy({...goodCopy, 'HM-001': `${goodCopy['HM-001']} 100% organic.`})).includes('A6_BANNED_PHRASE'));
});

test('A6 rejects a banned phrase in any case', () => {
  const copy = {...goodCopy, 'HM-001': `${goodCopy['HM-001']} GUARANTEED fresh.`};
  assert.deepEqual(failure(checkCopy(copy), 'A6_BANNED_PHRASE').skus, ['HM-001']);
});

test('an outside agent\'s answer passes on its committed text, as text or as a JSON string', () => {
  const text = 'x'.repeat(300);
  const answer = (onChainResultHash, resultText = text) => accept({kind: 'research', resultText, nonce, onChainResultHash});

  assert.equal(answer(resultHash(text, nonce)).ok, true);
  assert.equal(answer(resultHash(JSON.stringify(text), nonce)).ok, true);
  assert.equal(answer(resultHash(JSON.stringify(text).slice(1, -1), nonce)).note, undefined);
  assert.equal(answer('ee'.repeat(32)).ok, true);
  assert.match(answer('ee'.repeat(32)).note, /A1_UNVERIFIED/);
  assert.equal(answer(resultHash('short', nonce), 'short').failures[0].code, 'A2_TOO_SHORT');
});
