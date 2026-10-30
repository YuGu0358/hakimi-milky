import {resultHash} from '../shared/hash.mjs';
import {parsePrice} from '../shared/table.mjs';

// Acceptance is deterministic code with no model in it. It proves the format is right,
// no record was lost or invented, frozen fields were not changed and the copy follows
// its written rules. It cannot judge whether the copy is true, and we do not claim it can.

const failure = (rule, code, detail, skus = []) => ({rule, code, detail, skus});
const keyOf = (row, key) => String(row?.[key] ?? '').trim();
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const unique = (values) => [...new Set(values)];
const duplicatesOf = (values) => unique(values.filter((value, index) => values.indexOf(value) !== index));

// A failure only when something was found, so checks can be collected in one list.
const whenAny = (rule, code, detail, skus) => (skus.length > 0 ? [failure(rule, code, detail, skus)] : []);

function parseJson(text) {
  try {
    return {value: JSON.parse(text)};
  } catch (error) {
    return {error: error.message};
  }
}

const checkHash = ({resultText, nonce, onChainResultHash}) =>
  resultHash(resultText, nonce) === onChainResultHash
    ? []
    : [failure('A1', 'A1_HASH_MISMATCH', 'The delivered text does not match the hash the seller committed on chain')];

function checkColumns(rows, spec) {
  const expected = JSON.stringify(spec.required_columns);
  const bad = rows.filter((row) => JSON.stringify(Object.keys(row)) !== expected);
  return whenAny('A2', 'A2_COLUMNS', `Rows must have exactly these columns in order: ${spec.required_columns.join(', ')}`, bad.map((row) => keyOf(row, spec.key)));
}

function checkRowSet(rows, inputTable, key) {
  const inputKeys = inputTable.map((row) => keyOf(row, key));
  const outputKeys = rows.map((row) => keyOf(row, key));
  const inputSet = new Set(inputKeys);
  const outputSet = new Set(outputKeys);
  return [
    ...whenAny('A3', 'A3_INPUT_DUPLICATE', 'The input table itself repeats these keys', duplicatesOf(inputKeys)),
    ...whenAny('A3', 'A3_DUPLICATE', 'These keys appear more than once in the result', duplicatesOf(outputKeys)),
    ...whenAny('A3', 'A3_MISSING', 'These rows were lost', unique(inputKeys.filter((value) => !outputSet.has(value)))),
    ...whenAny('A3', 'A3_EXTRA', 'These rows were invented', unique(outputKeys.filter((value) => !inputSet.has(value)))),
  ];
}

function sameValue(a, b) {
  const [x, y] = [parsePrice(a), parsePrice(b)];
  if (Number.isFinite(x) && Number.isFinite(y)) return x === y;
  return String(a ?? '').trim() === String(b ?? '').trim();
}

function checkImmutable(rows, inputTable, spec) {
  const inputByKey = new Map(inputTable.map((row) => [keyOf(row, spec.key), row]));
  const fields = spec.immutable.filter((field) => field !== spec.key);
  const changed = rows.filter((row) => {
    const original = inputByKey.get(keyOf(row, spec.key));
    return original && fields.some((field) => field in row && !sameValue(original[field], row[field]));
  });
  return whenAny('A4', 'A4_IMMUTABLE_CHANGED', `These rows changed a frozen field (${fields.join(', ')})`, changed.map((row) => keyOf(row, spec.key)));
}

function checkValues(rows, spec) {
  const keysWhere = (field, isBad) => rows.filter((row) => field in row && isBad(row[field])).map((row) => keyOf(row, spec.key));
  return [
    ...(spec.price_positive
      ? whenAny('A5', 'A5_PRICE', 'Price must be a positive number', keysWhere('price', (price) => !(parsePrice(price) > 0)))
      : []),
    ...whenAny('A5', 'A5_UNIT', `Unit must be one of: ${spec.allowed_units.join(', ')}`, keysWhere('unit', (unit) => !spec.allowed_units.includes(unit))),
    ...whenAny('A5', 'A5_CATEGORY', `Category must be one of: ${spec.allowed_categories.join(', ')}`, keysWhere('category', (category) => !spec.allowed_categories.includes(category))),
  ];
}

function checkTable({spec, inputTable, resultText}) {
  const {value, error} = parseJson(resultText);
  if (error || !Array.isArray(value) || !value.every(isPlainObject)) {
    return [failure('A2', 'A2_NOT_A_TABLE', error ?? 'The result is not a JSON array of rows')];
  }
  return [
    ...checkColumns(value, spec),
    ...checkRowSet(value, inputTable, spec.key),
    ...checkImmutable(value, inputTable, spec),
    ...checkValues(value, spec),
  ];
}

function checkCopy({spec, inputTable, resultText}) {
  const {value, error} = parseJson(resultText);
  if (error || !isPlainObject(value)) {
    return [failure('A6', 'A6_NOT_AN_OBJECT', error ?? 'The result is not a JSON object of copy per key')];
  }
  const {max_chars: maxChars, must_mention: mustMention, banned_phrases: bannedPhrases} = spec.copy;
  const inputKeys = inputTable.map((row) => keyOf(row, spec.key));
  const inputSet = new Set(inputKeys);
  const hasText = (key) => typeof value[key] === 'string' && value[key].trim() !== '';
  const present = inputTable.filter((row) => hasText(keyOf(row, spec.key)));
  const textOf = (row) => value[keyOf(row, spec.key)];
  const lower = (text) => String(text ?? '').trim().toLowerCase();
  const keysWhere = (isBad) => present.filter(isBad).map((row) => keyOf(row, spec.key));
  return [
    ...whenAny('A6', 'A6_MISSING', 'These keys have no copy', unique(inputKeys.filter((key) => !hasText(key)))),
    ...whenAny('A6', 'A6_EXTRA', 'Copy was written for keys that are not in the table', Object.keys(value).filter((key) => !inputSet.has(key))),
    ...whenAny('A6', 'A6_TOO_LONG', `Copy must be at most ${maxChars} characters`, keysWhere((row) => textOf(row).length > maxChars)),
    ...whenAny('A6', 'A6_MISSING_ATTRIBUTE', `Copy must mention: ${mustMention.join(', ')}`, keysWhere((row) => mustMention.some((field) => !lower(textOf(row)).includes(lower(row[field]))))),
    ...whenAny('A6', 'A6_BANNED_PHRASE', `Copy must not say: ${bannedPhrases.join(', ')}`, keysWhere((row) => bannedPhrases.some((phrase) => lower(textOf(row)).includes(lower(phrase))))),
  ];
}

// Lists every failure instead of stopping at the first, so the evidence names all of them.
export function accept({kind, spec, inputTable, resultText, nonce, onChainResultHash}) {
  const checkContent = kind === 'copy' ? checkCopy : checkTable;
  const failures = [
    ...checkHash({resultText, nonce, onChainResultHash}),
    ...checkContent({spec, inputTable, resultText}),
  ];
  return {ok: failures.length === 0, failures};
}
