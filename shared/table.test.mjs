import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTable, parseCsvTable, parsePrice} from './table.mjs';
import acceptance from './fixtures/acceptance.json' with {type: 'json'};
import table from './fixtures/table.json' with {type: 'json'};

test('parsePrice reads the formats suppliers use and refuses the rest', () => {
  assert.equal(parsePrice(12.5), 12.5);
  assert.equal(parsePrice('12.50'), 12.5);
  assert.equal(parsePrice('€12.50'), 12.5);
  assert.equal(parsePrice(' 12.50 EUR '), 12.5);
  assert.equal(parsePrice('-3'), -3);
  assert.ok(Number.isNaN(parsePrice('twelve')));
  assert.ok(Number.isNaN(parsePrice('12,50')));
  assert.ok(Number.isNaN(parsePrice(null)));
});

test('the demo table has 20 unique SKUs and contains the errors the normalizer must fix', () => {
  assert.equal(new Set(table.map((row) => row.sku)).size, 20);
  assert.ok(table.some((row) => row.unit !== row.unit.trim().toLowerCase()));
  assert.ok(table.some((row) => /[€A-Z]/.test(row.price)));
  assert.ok(table.some((row) => row.name !== row.name.trim()));
});

test('normalizeTable output satisfies the acceptance spec on every row', () => {
  const rows = normalizeTable(table);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), acceptance.required_columns);
    assert.ok(acceptance.allowed_units.includes(row.unit), `${row.sku} unit ${row.unit}`);
    assert.ok(acceptance.allowed_categories.includes(row.category), `${row.sku} category ${row.category}`);
    assert.ok(row.price > 0, `${row.sku} price ${row.price}`);
    assert.equal(row.name, row.name.trim());
  }
});

test('normalizeTable does not mutate its input', () => {
  const before = JSON.stringify(table);
  normalizeTable(table);
  assert.equal(JSON.stringify(table), before);
});

test('parseCsvTable gives the same rows for LF and CRLF files', () => {
  const lf = 'sku,name,price\nHM-001,Oat Milk,€3.20\nHM-002,"Whole Milk, UHT",2.10\n';
  const crlf = lf.replaceAll('\n', '\r\n');
  assert.deepEqual(parseCsvTable(crlf), parseCsvTable(lf));
  assert.equal(parseCsvTable(lf)[1].name, 'Whole Milk, UHT');
});

test('parseCsvTable ignores the byte order mark Excel on Windows writes', () => {
  const csv = 'sku,name\nHM-001,Oat Milk\n';
  assert.deepEqual(parseCsvTable(`﻿${csv}`), parseCsvTable(csv));
  assert.equal(parseCsvTable(`﻿${csv}`)[0].sku, 'HM-001');
});

test('parseCsvTable throws on a row with the wrong column count', () => {
  assert.throws(() => parseCsvTable('sku,name\nHM-001\n'));
});
