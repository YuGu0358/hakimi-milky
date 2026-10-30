import {checkCopy, checkTable} from './acceptance.mjs';
import {assembleRun} from './assemble.mjs';
import {failureText as codesAndOwnerSkus} from './failure-text.mjs';
import defaultAcceptance from '../shared/fixtures/acceptance.json' with {type: 'json'};
import {formatPrice} from '../shared/money.mjs';
import {jobPrompt, SUBTASKS} from '../shared/schemas.mjs';
import {normalizeTable, parseCsvTable, plainCopy} from '../shared/table.mjs';

// What the front desk does with a paid task. A table it can hand over goes to specialists through
// the orchestrator, under the owner's mandate. Anything else gets the plain answer the starter gives.

const MAX_ROWS = 50;
const CORE_COLUMNS = Object.freeze(['sku', 'name', 'category', 'unit', 'price']);
const RETRY_DELAY_MS = 60_000;
const MAX_TRIES = 5;
const MAX_REASON_CHARS = 1_000;
const TX_URL = 'https://preprod.cardanoscan.io/transaction/';

const JOB_LABELS = Object.freeze({normalize: 'Table', copy: 'Product texts'});
const TX_LABELS = Object.freeze({
  'purchase.funds_locked': 'locked',
  'result.submitted': 'result',
  'refund.requested': 'refund requested',
  'refund.authorized': 'refund authorized',
  'refund.withdrawn': 'refund withdrawn',
});

// Comes back from the desk when no retry can help. The owner is told, and no result goes on chain.
class JobFailed extends Error {
  isFinal = true;
}

// A header may follow prose on its own line, and the prose may name a column too.
// So it runs back from the end of the line, over known columns, until one is unknown or repeats.
function headerIn(segment, columns) {
  const cells = segment
    .toLowerCase()
    .replaceAll('"', '')
    .split(',')
    .map((cell) => cell.trim().split(/\s+/).at(-1));
  const lastOutside = cells.findLastIndex((cell, index) => !columns.includes(cell) || cells.slice(index + 1).includes(cell));
  const header = cells.slice(lastOutside + 1);
  return CORE_COLUMNS.every((column) => header.includes(column)) ? header : null;
}

function rowsAfter(segments) {
  const end = segments.findIndex((segment) => !segment.includes(','));
  return end < 0 ? segments : segments.slice(0, end);
}

function parseRows(header, rows) {
  try {
    return parseCsvTable([header.join(','), ...rows].join('\n'));
  } catch {
    return null; // Not a table we can read, which only means the plain answer takes this task.
  }
}

// Only a table honest specialists could pass goes out, so nobody is paid for a job that cannot succeed.
const couldPass = (table, acceptance) =>
  checkTable({spec: acceptance, inputTable: table, resultText: JSON.stringify(normalizeTable(table))}).length === 0 &&
  checkCopy({spec: acceptance, inputTable: table, resultText: plainCopy({table, key: acceptance.key, acceptance})}).length === 0;

function fitsOneJob(table, acceptance) {
  try {
    SUBTASKS.forEach((kind) => jobPrompt({kind, table, acceptance, key: acceptance.key}));
    return true;
  } catch {
    return false; // Too long to send, or not valid as a job. Either way, the plain answer takes this task.
  }
}

// Rows end at a line break, or at a bar when a form has put the whole table on one line.
export function tableFromText(text, acceptance = defaultAcceptance) {
  const segments = text.split(/\r?\n|\s\|\s/).map((segment) => segment.trim());
  const headerAt = segments.findIndex((segment) => headerIn(segment, acceptance.required_columns));
  if (headerAt < 0) return null;
  const rows = rowsAfter(segments.slice(headerAt + 1));
  if (rows.length === 0 || rows.length > MAX_ROWS) return null;
  const table = parseRows(headerIn(segments[headerAt], acceptance.required_columns), rows);
  return table && couldPass(table, acceptance) && fitsOneJob(table, acceptance) ? table : null;
}

// The owner may paste this into a shop, so nothing in it can act as a link or a tag.
const cell = (value) => String(value ?? '').replace(/\s+/g, ' ').replace(/[\\|<>[\]]/g, '\\$&').trim();
const tableRow = (cells) => `| ${cells.map(cell).join(' | ')} |`;

const TABLE_FIELDS = Object.freeze(['sku', 'name', 'category', 'unit', 'price', 'stock', 'note', 'copy']);
const TABLE_HEADER = Object.freeze(['SKU', 'Name', 'Category', 'Unit', 'Price', 'Stock', 'Note', 'Product text']);

// Only our own codes and the SKUs in the owner's table. A seller chooses the keys it invents, and it has just been refused.
const failureText = ({reason, detail}, ownerSkus) => (detail?.failures ? codesAndOwnerSkus(detail.failures, ownerSkus) : reason);

function outcomeOf(lines, ownerSkus) {
  const failed = lines.find(({step}) => step === 'acceptance.failed');
  if (!failed) return lines.some(({step}) => step === 'acceptance.passed') ? 'Passed its check.' : 'Did not finish.';
  const refund = lines.some(({step}) => step === 'refund.pending') ? ' A refund was requested.' : '';
  return `Failed its check (${cell(failureText(failed, ownerSkus))}).${refund}`;
}

const linesOfHire = (reservation, lines) => lines.filter(({refs}) => refs?.blockchainIdentifier === reservation.refs.blockchainIdentifier);

function describeHire(reservation, lines, names, ownerSkus) {
  const own = linesOfHire(reservation, lines);
  const links = own.flatMap(({step, refs}) => (TX_LABELS[step] && refs.txHash ? [`[${TX_LABELS[step]}](${TX_URL}${refs.txHash})`] : []));
  const name = names[reservation.terms.agentIdentifier] ?? reservation.terms.agentIdentifier;
  const price = formatPrice({unit: reservation.amount.unit, amount: reservation.amount.value});
  return `- ${JOB_LABELS[reservation.subtask] ?? reservation.subtask}: ${name}, ${price}. ${outcomeOf(own, ownerSkus)} ${[...new Set(links)].join(', ')}`.trim();
}

function hiresSection(lines, names, ownerSkus) {
  const reservations = lines.filter(({step}) => step === 'purchase.reserved');
  if (reservations.length === 0) return [];
  const ordered = reservations
    .filter((reservation) => !linesOfHire(reservation, lines).some(({step}) => step === 'purchase.rejected'))
    .reduce((sum, {amount}) => sum + BigInt(amount.value), 0n);
  return [
    '',
    '## Who did the work',
    '',
    ...reservations.map((reservation) => describeHire(reservation, lines, names, ownerSkus)),
    '',
    `Hires ordered: ${formatPrice({unit: reservations[0].amount.unit, amount: String(ordered)})}. Each one was checked against the mandate before any money moved.`,
  ];
}

export function formatResult({deliverable, lines, names}) {
  const rows = JSON.parse(deliverable);
  const ownerSkus = new Set(rows.map(({sku}) => String(sku)));
  return [
    '# Cleaned supplier table',
    '',
    tableRow(TABLE_HEADER),
    tableRow(TABLE_HEADER.map(() => '---')),
    ...rows.map((row) => tableRow(TABLE_FIELDS.map((field) => row[field]))),
    '',
    'Prices keep their value. Currency signs are dropped, because the checks compare numbers. Product texts are written from the table alone and are not verified.',
    ...hiresSection(lines, names, ownerSkus),
  ].join('\n');
}

export function createFrontDesk({
  answerPlainly,
  createParts,
  topUp,
  acceptance = defaultAcceptance,
  assemble = assembleRun,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
}) {
  const triesUsed = new Map();

  async function hireFor({table, deadline, taskId}) {
    const parts = createParts();
    const {ledger, run} = assemble({...parts, taskId, table, acceptance, frontDeskDeadline: deadline});
    // Only before the first line of evidence, so a restart cannot widen what this task may spend.
    if (ledger.lines().length === 0) await topUp();
    log(`Front desk: ${taskId} has a table of ${table.length} rows, hiring`);
    const result = await run();
    // The money can take most of an hour to settle, and the owner should not wait for that.
    result.settled.then(
      (open) => log(open === 0 ? `Front desk: ${taskId} has settled` : `Front desk: ${taskId} stopped watching with ${open} purchases open`),
      (error) => log(`Front desk: ${taskId} stopped watching: ${error.message}`),
    );
    if (!result.ok) throw result.ownerMustDecide ? new JobFailed(result.reason.slice(0, MAX_REASON_CHARS)) : new Error(result.reason);
    const names = Object.fromEntries(parts.allowlist.map(({agentIdentifier, name}) => [agentIdentifier, name]));
    return formatResult({deliverable: result.deliverable, lines: ledger.lines(), names});
  }

  // A seller restarting or a model timing out passes, so a job gets a few tries. The mandate and the
  // evidence hold across them, so another try can only buy what the owner still allows.
  async function answer(input, journal, deadline, taskId) {
    try {
      const table = tableFromText(input, acceptance);
      return await (table ? hireFor({table, deadline, taskId}) : answerPlainly(input, journal, deadline));
    } catch (error) {
      if (error.isFinal) throw error;
      const tries = (triesUsed.get(taskId) ?? 0) + 1;
      triesUsed.set(taskId, tries);
      log(`Front desk: ${taskId} try ${tries} failed: ${error.message}`);
      if (tries >= MAX_TRIES) throw new JobFailed('the hiring step kept failing');
      log(`Front desk: ${taskId} will try again: ${error.message}`);
      await sleep(RETRY_DELAY_MS);
      throw error;
    }
  }

  // The evidence shows what was already bought, so this is safe to call again after a crash.
  return Object.assign(answer, {canResume: true});
}
