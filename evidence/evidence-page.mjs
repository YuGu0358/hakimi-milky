import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {USDM_UNIT} from '../shared/constants.mjs';
import {formatPrice} from '../shared/money.mjs';

// One static page that shows what each run did, step by step, with its transactions on Preprod.
//   npm run evidence
// evidence/runs.json lists the runs to publish. Their files are copied from .local/ to evidence/runs/,
// so the page can be checked against the raw records and rebuilt without this machine's state.

const HERE = fileURLToPath(new URL('./', import.meta.url));
const LOCAL = fileURLToPath(new URL('../.local/', import.meta.url));
const FRONT_DESK_LOCAL = fileURLToPath(new URL('../frontdesk/.local/', import.meta.url));
const RUNS_DIR = join(HERE, 'runs');
const TX_URL = 'https://preprod.cardanoscan.io/transaction/';
const IS_TX_HASH = /^[0-9a-f]{64}$/;
const CHAIN_STATE = /^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/; // FundsLocked, ResultSubmitted

const JOB_LABELS = Object.freeze({normalize: 'Table', copy: 'Product texts'});
const STEP_LABELS = Object.freeze({
  'mandate.confirmed': 'Mandate fixed',
  'plan.proposed': 'Planner proposes a hire',
  'plan.rejected': 'Planner reply refused by the schema',
  'agent.unavailable': 'An agent on the list cannot be hired',
  'acceptance.reviewed': 'A person corrected the check',
  'owner.asked': 'The reviewer asks the owner',
  'owner.approved': 'The owner approves',
  'owner.rejected': 'The owner says no',
  'proposal.checked': 'Guard checks the proposal',
  'review.checked': 'Jev reviews the proposal',
  'guard.checked': "Guard checks the seller's signed quote",
  'purchase.reserved': 'Budget reserved',
  'purchase.created': 'Order sent',
  'purchase.uncertain': 'Order outcome unknown',
  'purchase.rejected': 'Order refused',
  'purchase.funds_locked': 'Funds locked in escrow',
  'result.submitted': 'Seller submits the result hash',
  'acceptance.passed': 'Acceptance passed',
  'acceptance.failed': 'Acceptance failed',
  'refund.pending': 'Refund decided',
  'refund.requested': 'Refund requested on chain',
  'refund.authorized': 'Seller authorizes the refund',
  'refund.withdrawn': 'Money back to the buyer',
  'refund.too_late': 'Refund window closed',
  'refund.stuck': 'Refund not back yet',
  'seller.withdrawn': 'Seller collects',
  'settlement.pending': 'Seller has not collected yet',
  'run.delivered': 'Delivered',
  'run.failed': 'Not delivered',
});
const ROUTINE_STEPS = new Set(['job.pending', 'job.started', 'purchase.not_visible_yet', 'purchase.lookup_failed', 'result.fetch_failed', 'refund.request_failed']);

const STYLE = `
:root { --bg: #fbfaf8; --panel: #ffffff; --ink: #1f1e1c; --muted: #6b6862; --line: #e5e2db; --allow: #1f6f43; --deny: #a8321f; --accent: #2b5fa8; }
@media (prefers-color-scheme: dark) { :root { --bg: #1b1a18; --panel: #24231f; --ink: #ecebe6; --muted: #a5a29a; --line: #3a3833; --allow: #7fd0a3; --deny: #f0937f; --accent: #8db7ee; } }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 1040px; padding: 32px 16px 64px; background: var(--bg); color: var(--ink); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { font-size: 28px; margin: 0 0 8px; } h2 { font-size: 20px; margin: 40px 0 8px; } p { margin: 8px 0; }
a { color: var(--accent); } .muted { color: var(--muted); } .deny { color: var(--deny); font-weight: 600; } .allow { color: var(--allow); font-weight: 600; }
.facts { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 12px 0; padding: 12px 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.scroll { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
pre { overflow-x: auto; padding: 12px 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; font-size: 13px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; } th, td { padding: 8px 12px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); }
td { overflow-wrap: anywhere; } tr:last-child td { border-bottom: 0; } th { color: var(--muted); font-weight: 500; white-space: nowrap; } td.when, td.tx { white-space: nowrap; font-variant-numeric: tabular-nums; }
`;

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (character) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character]);

const txLink = (hash, label) => (IS_TX_HASH.test(hash ?? '') ? `<a href="${TX_URL}${hash}">${escapeHtml(label ?? `${hash.slice(0, 8)}…`)}</a>` : '');

const money = (amount) => formatPrice({unit: USDM_UNIT, amount: String(amount)});
const counted = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function verdictOf({decision, rule, code}) {
  if (decision === 'deny' || decision === 'veto') return `<span class="deny">${escapeHtml(code ?? decision)}</span>`;
  if (decision === 'allow') return '<span class="allow">allow</span>';
  if (decision) return `<span class="deny">${escapeHtml(decision)}</span>`;
  return code ? `<span class="deny">${escapeHtml(code)}</span>` : escapeHtml(rule);
}

const namesFrom = (mandate) => Object.fromEntries((mandate?.allowlist ?? []).map(({agentIdentifier, name}) => [agentIdentifier, name]));

function agentOf(line, names) {
  const id = line.terms?.agentIdentifier ?? line.detail?.agentIdentifier;
  if (!id) return '';
  return names[id] ?? `${id.slice(0, 12)}… (not on the list)`;
}

function stepRow(line, startedAt, names) {
  const minutes = ((line.ts - startedAt) / 60_000).toFixed(1);
  const job = JOB_LABELS[line.subtask] ?? line.subtask ?? '';
  const what = STEP_LABELS[line.step] ?? line.step;
  const amount = line.amount ? money(line.amount.value) : '';
  const reason = CHAIN_STATE.test(line.reason ?? '') ? '' : line.reason; // the step already says it
  const later = line.detail?.reconciled ? 'recorded later, when this run was caught up with the chain. The time on the left is when we wrote it down; the transaction shows when the money moved' : '';
  const details = [agentOf(line, names), reason, amount, later].filter(Boolean).map(escapeHtml).join(' · ');
  return `<tr><td class="when">+${minutes} min</td><td>${escapeHtml(job)}</td><td>${escapeHtml(what)}</td><td>${verdictOf(line)}</td><td>${details}</td><td class="tx">${txLink(line.refs?.txHash)}</td></tr>`;
}

export function summarize(lines) {
  const startedAt = lines[0]?.ts ?? 0;
  const delivered = lines.find(({step}) => step === 'run.delivered');
  const reservations = lines.filter(({step}) => step === 'purchase.reserved');
  const ordered = reservations.reduce((sum, {amount}) => sum + BigInt(amount.value), 0n);
  return {
    deliveredMinutes: delivered ? Math.round((delivered.ts - startedAt) / 6_000) / 10 : null,
    refused: lines.filter(({step, decision}) => step === 'proposal.checked' && decision === 'deny').length,
    hires: reservations.length,
    ordered: money(ordered),
    refunds: lines.filter(({step}) => step === 'refund.withdrawn').length,
  };
}

function factsHtml(lines, mandate) {
  const {deliveredMinutes, refused, hires, ordered, refunds} = summarize(lines);
  const limits = mandate
    ? [`Budget ${money(mandate.budget[USDM_UNIT])}`, `at most ${money(mandate.perHire[USDM_UNIT])} a hire`, `at most ${counted(mandate.maxHires, 'hire')}`, `allowed: ${mandate.allowlist.map(({name}) => name).join(', ')}`]
    : [];
  const facts = [
    deliveredMinutes === null ? 'Not delivered' : `Delivered in ${deliveredMinutes} min`,
    `${counted(hires, 'hire')}, ${ordered} ordered`,
    `${counted(refused, 'proposal')} refused`,
    `${counted(refunds, 'refund')} back`,
    ...limits,
  ];
  return `<div class="facts">${facts.map((fact) => `<span>${escapeHtml(fact)}</span>`).join('')}</div>`;
}

function settlementHtml(settlement) {
  if (!settlement) return '';
  const outcome = settlement.verified ? 'verified' : 'not verified yet';
  const net = settlement.netAtomicUnits ? ` The seller's wallet nets ${money(settlement.netAtomicUnits)} in this transaction, which also collected other payments.` : '';
  return `<p>Seller's receipt: <span class="${settlement.verified ? 'allow' : 'deny'}">${outcome}</span>. ${txLink(settlement.txHash)}${escapeHtml(net)} ${escapeHtml(settlement.method)}.</p>`;
}

export function renderRun({run, lines, mandate, settlement, crashLog}) {
  const shown = lines.filter(({step}) => !ROUTINE_STEPS.has(step));
  const left = lines.length - shown.length;
  const startedAt = lines[0]?.ts ?? 0;
  const names = namesFrom(mandate);
  const transactions = (run.transactions ?? []).map(({label, txHash}) => txLink(txHash, label)).filter(Boolean);
  return `<section>
<h2>${escapeHtml(run.title)}</h2>
<p>${escapeHtml(run.story)}</p>
${run.sokosumiTask ? `<p class="muted">Sokosumi task ${escapeHtml(run.sokosumiTask)}</p>` : ''}
${transactions.length > 0 ? `<p>${transactions.join(' · ')}</p>` : ''}
${factsHtml(lines, mandate)}
${settlementHtml(settlement)}
${crashLog ? `<p>The test's own log:</p><pre>${escapeHtml(crashLog)}</pre>` : ''}
<div class="scroll"><table><thead><tr><th>When</th><th>Job</th><th>Step</th><th>Verdict</th><th>Details</th><th>Transaction</th></tr></thead>
<tbody>${shown.map((line) => stepRow(line, startedAt, names)).join('\n')}</tbody></table></div>
${left > 0 ? `<p class="muted">${left} routine steps are left out here. <a href="runs/${escapeHtml(run.taskId)}-evidence.jsonl">The raw record</a> keeps them.</p>` : ''}
</section>`;
}

function trackRecordHtml(trackRecords, names) {
  if (!trackRecords) return '';
  const known = Object.entries(names).filter(([id]) => trackRecords[id]);
  if (known.length === 0) return '';
  const rows = known.map(([id, name]) => {
    const {completed, refunded, disputed} = trackRecords[id];
    return `<tr><td>${escapeHtml(name)}</td><td>${completed}</td><td>${refunded}</td><td>${disputed}</td></tr>`;
  });
  return `<section><h2>Track record, read from the escrow contract</h2>
<p>Each job's final step on chain, counted per agent. The planner reads these numbers. Only the chain writes them, but an agent could pad its own by buying from itself, and nothing here checks for that.</p>
<div class="scroll"><table><thead><tr><th>Agent</th><th>Paid</th><th>Refunded</th><th>Disputed</th></tr></thead><tbody>${rows.join('')}</tbody></table></div></section>`;
}

function rejectionsHtml(rejections) {
  if (!rejections) return '';
  const rows = rejections.attempts.map(
    ({name, ok, actual}) => `<tr><td>${escapeHtml(name)}</td><td class="${ok ? 'allow' : 'deny'}">${ok ? 'refused' : 'not as expected'}</td><td>${escapeHtml(actual.message)}</td></tr>`,
  );
  return `<section><h2>C5: the limit underneath the guard</h2>
<p>The orchestrator's key can spend one run's budget, on Preprod, from the purchasing wallet. That holds against a bug in the guard or a hijacked model, not against someone who controls the worker, which can refill it. These calls went to the real Payment Service with that key.</p>
<div class="scroll"><table><thead><tr><th>Call</th><th>Result</th><th>What the service said</th></tr></thead><tbody>${rows.join('')}</tbody></table></div></section>`;
}

function batchHtml(batch) {
  if (!batch) return '';
  const byRule = Object.entries(batch.violations.byRule).map(([rule, count]) => `${escapeHtml(rule)}: ${count}`).join(', ');
  return `<section><h2>C7: the guard, on generated cases</h2><ul>
<li>${batch.violations.blocked} of ${batch.violations.total} out-of-mandate cases blocked (${byRule}).</li>
<li>${batch.legal.allowed} of ${batch.legal.total} legal cases allowed.</li>
<li>A replay of ${batch.replay.attempts} attempts made ${batch.replay.orders} order.</li>
<li>${batch.parallel.attempts} hires racing for one budget: ${batch.parallel.passed} passed.</li>
</ul></section>`;
}

function redteamHtml(redteam) {
  if (!redteam) return '';
  const {proposals, injections} = redteam;
  const guardBlocked = Object.values(proposals.guardBlocked).reduce((sum, count) => sum + count, 0);
  return `<section><h2>C7: attacks written by a model</h2><ul>
<li>${proposals.generated} model-written attacks: ${proposals.schemaRejected} stopped by the schema, ${guardBlocked} by the guard, ${proposals.reviewer.veto + proposals.reviewer.escalate} by the reviewer, ${proposals.outsideMandate.length} outside the mandate.</li>
<li>The other ${proposals.reviewer.allow} stayed inside the mandate. They only inflate a maximum price, and the listed price is what gets paid, or ask for a second hire, which the guard stops in a live run.</li>
<li>The real planner fell for ${injections.hooked} of ${injections.texts} hand-written notes hidden in a supplier table.</li>
</ul></section>`;
}

export function renderPage({runs, rejections, batch, redteam, trackRecords}) {
  const names = Object.assign({}, ...runs.map(({mandate}) => namesFrom(mandate)));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mission: Payable evidence</title><style>${STYLE}</style></head>
<body>
<h1>Mission: Payable evidence</h1>
<p>An agent hires other agents through Masumi escrow on Cardano Preprod, under a mandate with fixed limits. Everything here is test money, and each transaction links to the chain. The agents the shop's table goes to are our own. The one outside hire, a research job, is near the end.</p>
${runs.map(renderRun).join('\n')}
${trackRecordHtml(trackRecords, names)}
${rejectionsHtml(rejections)}
${batchHtml(batch)}
${redteamHtml(redteam)}
</body></html>
`;
}

const readJsonIfThere = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
const readLines = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((text) => JSON.parse(text));

// The seller's receipt is in the front desk's own task record. Only that part is published.
function publishSettlement(taskId) {
  const journal = readJsonIfThere(join(FRONT_DESK_LOCAL, `${taskId}.json`));
  if (journal?.paid?.settlement) writeFileSync(join(RUNS_DIR, `${taskId}-settlement.json`), JSON.stringify(journal.paid.settlement, null, 2));
  return readJsonIfThere(join(RUNS_DIR, `${taskId}-settlement.json`));
}

function publishRun(run) {
  const names = {evidence: `${run.taskId}-evidence.jsonl`, mandate: `${run.taskId}-mandate.json`, crashLog: `${run.taskId}-crash-test.log`};
  for (const name of Object.values(names)) {
    if (existsSync(join(LOCAL, name))) copyFileSync(join(LOCAL, name), join(RUNS_DIR, name));
  }
  const crashPath = join(RUNS_DIR, names.crashLog);
  return {
    run,
    lines: readLines(join(RUNS_DIR, names.evidence)),
    mandate: readJsonIfThere(join(RUNS_DIR, names.mandate)),
    settlement: publishSettlement(run.taskId),
    crashLog: existsSync(crashPath) ? readFileSync(crashPath, 'utf8').trim() : null,
  };
}

function publishReport(name) {
  if (existsSync(join(LOCAL, name))) copyFileSync(join(LOCAL, name), join(RUNS_DIR, name));
  return readJsonIfThere(join(RUNS_DIR, name));
}

function main() {
  mkdirSync(RUNS_DIR, {recursive: true});
  const page = renderPage({
    runs: JSON.parse(readFileSync(join(HERE, 'runs.json'), 'utf8')).map(publishRun),
    rejections: publishReport('rejections.json'),
    batch: publishReport('c7-report.json'),
    redteam: publishReport('redteam-report.json'),
    trackRecords: publishReport('track-records.json'),
  });
  writeFileSync(join(HERE, 'index.html'), page);
  console.log(`Wrote ${join(HERE, 'index.html')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
