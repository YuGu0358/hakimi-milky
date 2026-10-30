import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {MINUTE_MS, USDM_UNIT} from '../shared/constants.mjs';
import {sha256} from '../shared/hash.mjs';
import {Mandate} from '../shared/schemas.mjs';

export const DEMO_LIMITS = Object.freeze({budget: '800000', perHire: '400000', maxHires: 3});

const STANDALONE_DELIVERY_MINUTES = 40;
const LOCK_MINUTES = 60;
const FRONT_DESK_MARGIN_MINUTES = 3;

// The terms the shop owner agrees to when work starts. Everything the guard enforces comes
// from here, never from the task text or from a model, so neither can widen them.
export function createMandate({
  taskId,
  allowlist,
  acceptance,
  startedAt,
  frontDeskDeadline = null,
  limits = DEMO_LIMITS,
  unit = USDM_UNIT,
}) {
  const deliverBy = frontDeskDeadline
    ? frontDeskDeadline - FRONT_DESK_MARGIN_MINUTES * MINUTE_MS
    : startedAt + STANDALONE_DELIVERY_MINUTES * MINUTE_MS;
  return Mandate.parse({
    id: `mandate-${taskId}`,
    taskId,
    budget: {[unit]: limits.budget},
    perHire: {[unit]: limits.perHire},
    maxHires: limits.maxHires,
    allowlist,
    deliverBy,
    lockUntil: startedAt + LOCK_MINUTES * MINUTE_MS,
    acceptance,
    createdAt: startedAt,
  });
}

export const mandateHash = (mandate) => sha256(JSON.stringify(mandate));

function readMandate(path) {
  try {
    return Mandate.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    throw new Error(`Cannot read the mandate at ${path}: ${error.message}`, {cause: error});
  }
}

// The saved file wins over anything passed in, so a restart cannot change what the owner agreed to.
export function loadOrCreateMandate({path, ...terms}) {
  if (existsSync(path)) {
    const saved = readMandate(path);
    if (saved.taskId !== terms.taskId) throw new Error(`The mandate at ${path} belongs to task ${saved.taskId}, not ${terms.taskId}`);
    return saved;
  }
  const mandate = createMandate(terms);
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  writeFileSync(path, JSON.stringify(mandate, null, 2), {mode: 0o600, flag: 'wx'});
  return mandate;
}
