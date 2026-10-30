import {parse} from 'csv-parse/sync';

const UNIT_ALIASES = Object.freeze({
  pc: 'pcs',
  pcs: 'pcs',
  piece: 'pcs',
  pieces: 'pcs',
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  m: 'm',
  meter: 'm',
  metre: 'm',
  box: 'box',
  boxes: 'box',
});

// Accepts 12.5, "12.50", "€12.50" and "12.50 EUR". Anything else is NaN.
export function parsePrice(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  const match = value.trim().match(/^[^\d-]*(-?\d+(?:\.\d+)?)[^\d]*$/);
  return match ? Number(match[1]) : NaN;
}

const clean = (value) => String(value ?? '').trim();

export function normalizeRow(row) {
  const unit = clean(row.unit).toLowerCase();
  return {
    sku: clean(row.sku),
    name: clean(row.name),
    category: clean(row.category).toLowerCase(),
    unit: UNIT_ALIASES[unit] ?? unit,
    price: parsePrice(row.price),
    stock: Number(row.stock),
    note: clean(row.note),
  };
}

export const normalizeTable = (table) => table.map(normalizeRow);

// Handles both LF and CRLF line endings, so a table saved on Windows parses the same way.
export const parseCsvTable = (text) => parse(text, {columns: true, skip_empty_lines: true});
