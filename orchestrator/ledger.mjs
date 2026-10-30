import {closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeSync} from 'node:fs';
import {dirname} from 'node:path';
import {EvidenceLine} from '../shared/schemas.mjs';

// The evidence log is the only source of truth for money and hires. Budget state is
// rebuilt from it on demand, so a restart cannot forget a reservation.

const EMPTY_STATE = Object.freeze({units: {}, hires: 0, subtasks: {}, purchases: {}});

// Later statuses win. A retry that logs purchase.created again must not move a purchase backwards.
const STATUS_ORDER = Object.freeze([
  'reserved',
  'uncertain',
  'created',
  'funds_locked',
  'result_submitted',
  'accepted',
  'acceptance_failed',
  'refund_pending',
  'refund_requested',
  'refund_authorized',
  'rejected',
  'withdrawn',
  'refund_withdrawn',
]);
const rankOf = (status) => STATUS_ORDER.indexOf(status);
const FINISHED = new Set(['rejected', 'withdrawn', 'refund_withdrawn']);
const MAY_BE_REJECTED = new Set(['reserved', 'uncertain']);

const STATUS_BY_STEP = Object.freeze({
  'purchase.uncertain': 'uncertain',
  'purchase.created': 'created',
  'purchase.funds_locked': 'funds_locked',
  'result.submitted': 'result_submitted',
  'acceptance.passed': 'accepted',
  'acceptance.failed': 'acceptance_failed',
  'refund.pending': 'refund_pending',
  'refund.requested': 'refund_requested',
  'refund.authorized': 'refund_authorized',
  'purchase.rejected': 'rejected',
  'seller.withdrawn': 'withdrawn',
  'refund.withdrawn': 'refund_withdrawn',
});

function adjustUnits(units, unit, {locked = 0n, spent = 0n}) {
  const current = units[unit] ?? {spent: 0n, locked: 0n};
  return {...units, [unit]: {spent: current.spent + spent, locked: current.locked + locked}};
}

function applyReservation(state, line) {
  const id = line.refs.blockchainIdentifier;
  const value = BigInt(line.amount.value);
  return {
    units: adjustUnits(state.units, line.amount.unit, {locked: value}),
    hires: state.hires + 1,
    subtasks: {...state.subtasks, [line.subtask]: {status: 'open', blockchainIdentifier: id}},
    purchases: {
      ...state.purchases,
      [id]: {
        blockchainIdentifier: id,
        nonce: line.refs.nonce,
        subtask: line.subtask,
        proposalId: line.proposalId,
        amount: line.amount,
        terms: line.terms,
        status: 'reserved',
        settled: false,
      },
    },
  };
}

// The money a purchase holds moves once: back to the budget or into spent.
function settleMoney(state, purchase, step) {
  const value = BigInt(purchase.amount.value);
  if (purchase.settled) {
    // The chain has the last word: money that reached a seller is spent, whatever we thought before.
    return step === 'seller.withdrawn' && purchase.status === 'rejected'
      ? {...state, units: adjustUnits(state.units, purchase.amount.unit, {spent: value})}
      : state;
  }
  if (step === 'seller.withdrawn') {
    return {...state, units: adjustUnits(state.units, purchase.amount.unit, {locked: -value, spent: value})};
  }
  if (step === 'refund.withdrawn') {
    return {...state, units: adjustUnits(state.units, purchase.amount.unit, {locked: -value})};
  }
  if (step === 'purchase.rejected') {
    return {...state, hires: state.hires - 1, units: adjustUnits(state.units, purchase.amount.unit, {locked: -value})};
  }
  return state;
}

function subtaskStatusAfter(step, current) {
  if (step === 'acceptance.passed') return 'accepted';
  if (step === 'acceptance.failed' || step === 'purchase.rejected') return 'failed';
  if ((step === 'refund.withdrawn' || step === 'seller.withdrawn') && current === 'open') return 'failed';
  return current;
}

function applyStep(state, line) {
  const status = STATUS_BY_STEP[line.step];
  const id = line.refs?.blockchainIdentifier;
  const purchase = id ? state.purchases[id] : undefined;
  if (!status || !purchase) return state;
  // A rejection only means something while the order may not exist yet.
  if (line.step === 'purchase.rejected' && !MAY_BE_REJECTED.has(purchase.status)) return state;
  const moved = settleMoney(state, purchase, line.step);
  const subtask = moved.subtasks[purchase.subtask];
  // A newer hire may own the subtask by now. Then this line no longer speaks for it.
  const subtasks =
    subtask?.blockchainIdentifier === id
      ? {...moved.subtasks, [purchase.subtask]: {...subtask, status: subtaskStatusAfter(line.step, subtask.status)}}
      : moved.subtasks;
  const settled = purchase.settled || FINISHED.has(status);
  const nextStatus = rankOf(status) > rankOf(purchase.status) ? status : purchase.status;
  return {...moved, subtasks, purchases: {...moved.purchases, [id]: {...purchase, status: nextStatus, settled}}};
}

const applyLine = (state, line) => (line.step === 'purchase.reserved' ? applyReservation(state, line) : applyStep(state, line));

export const deriveState = (lines) => lines.reduce(applyLine, EMPTY_STATE);

// Purchases that still need attention after a restart, the nearest unlock first:
// a failed acceptance has to reach the chain before unlock or the seller collects.
export const unfinished = (state) =>
  Object.values(state.purchases)
    .filter((purchase) => !FINISHED.has(purchase.status))
    .sort((a, b) => a.terms.unlockTime - b.terms.unlockTime);

function durableAppend(path, text) {
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((text) => text !== '')
    .map((text, index) => {
      try {
        return EvidenceLine.parse(JSON.parse(text));
      } catch (error) {
        throw new Error(`Cannot read evidence line ${index + 1} of ${path}: ${error.message}`, {cause: error});
      }
    });
}

// A crash can leave a partial last line. Returns true when one was removed.
function dropTornTail(path) {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  if (text === '' || text.endsWith('\n')) return false;
  const keep = text.slice(0, text.lastIndexOf('\n') + 1);
  truncateSync(path, Buffer.byteLength(keep, 'utf8'));
  return true;
}

export function createLedger({path, taskId, clock = Date.now}) {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const append = (entry) => {
    const line = EvidenceLine.parse({ts: clock(), taskId, ...entry});
    durableAppend(path, `${JSON.stringify(line)}\n`);
    return line;
  };
  if (dropTornTail(path)) {
    append({step: 'ledger.torn_line_dropped', reason: 'A crash left a partial last line; it was removed on restart'});
  }
  const lines = () => readLines(path);
  return {append, lines, state: () => deriveState(lines())};
}
