import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPage, renderRun, summarize} from './evidence-page.mjs';
import {USDM_UNIT} from '../shared/constants.mjs';

const T0 = 1_793_340_000_000;
const TX = 'a'.repeat(64);
const line = (minutes, step, extra = {}) => ({ts: T0 + minutes * 60_000, taskId: 'task-1', step, ...extra});
const RUN = {taskId: 'task-1', title: 'A paid job', story: 'What this run shows.', transactions: [{label: 'Owner pays', txHash: TX}]};
const MANDATE = {
  budget: {[USDM_UNIT]: '800000'},
  perHire: {[USDM_UNIT]: '400000'},
  maxHires: 3,
  allowlist: [{agentIdentifier: 'agent-1', name: 'Hakimi Copywriter'}],
};

test('a step shows when it happened, who it was for and its transaction', () => {
  const html = renderRun({run: RUN, mandate: MANDATE, lines: [line(0, 'mandate.confirmed'), line(1.5, 'purchase.funds_locked', {subtask: 'copy', refs: {txHash: TX}, reason: 'FundsLocked'})]});

  assert.match(html, /\+1\.5 min/);
  assert.match(html, /Funds locked in escrow/);
  assert.ok(html.includes(`https://preprod.cardanoscan.io/transaction/${TX}`));
  assert.match(html, /Product texts/);
});

test('a refused proposal shows the rule that refused it', () => {
  const html = renderRun({
    run: RUN,
    mandate: MANDATE,
    lines: [line(0, 'proposal.checked', {subtask: 'copy', decision: 'deny', rule: 'G1', code: 'G1_NOT_ALLOWLISTED', reason: 'Agent x is not on the list'})],
  });

  assert.match(html, /G1_NOT_ALLOWLISTED/);
  assert.match(html, /class="deny"/);
});

test('text from a model, a seller or a supplier cannot become markup', () => {
  const attack = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const html = renderRun({run: {...RUN, title: attack}, mandate: MANDATE, lines: [line(0, 'plan.proposed', {subtask: attack, reason: attack, code: attack})]});

  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;script&gt;/);
});

test('only a real transaction hash becomes a link', () => {
  const evil = 'javascript:alert(1)';
  const html = renderRun({run: {...RUN, transactions: [{label: 'x', txHash: evil}]}, mandate: MANDATE, lines: [line(0, 'result.submitted', {refs: {txHash: evil}})]});

  assert.ok(!html.includes('href="javascript'));
  assert.ok(!html.includes('transaction/javascript'));
});

test('polling noise is folded into a count', () => {
  const lookups = Array.from({length: 7}, (_, index) => line(index / 10, 'purchase.lookup_failed', {reason: 'fetch failed'}));

  const html = renderRun({run: RUN, mandate: MANDATE, lines: [...lookups, line(1, 'run.delivered')]});

  assert.ok(!html.includes('fetch failed'));
  assert.match(html, /7 routine steps are left out/);
});

test('an unknown step is shown as it is, so nothing disappears silently', () => {
  assert.match(renderRun({run: RUN, mandate: MANDATE, lines: [line(0, 'something.new')]}), /something\.new/);
});

test('the summary counts what happened', () => {
  const summary = summarize([
    line(0, 'mandate.confirmed'),
    line(0, 'proposal.checked', {decision: 'deny'}),
    line(0, 'proposal.checked', {decision: 'deny'}),
    line(0, 'proposal.checked', {decision: 'allow'}),
    line(0.1, 'purchase.reserved', {amount: {unit: USDM_UNIT, value: '200000'}, refs: {blockchainIdentifier: 'one'}}),
    line(0.1, 'purchase.reserved', {amount: {unit: USDM_UNIT, value: '300000'}, refs: {blockchainIdentifier: 'two'}}),
    line(1, 'refund.withdrawn', {refs: {blockchainIdentifier: 'one'}}),
    line(2.5, 'run.delivered'),
  ]);

  assert.deepEqual(summary, {deliveredMinutes: 2.5, refused: 2, hires: 2, ordered: '0.5 tUSDM', refunds: 1});
});

test('a run that was not delivered says so', () => {
  assert.equal(summarize([line(0, 'mandate.confirmed'), line(1, 'run.failed')]).deliveredMinutes, null);
});

test('the mandate shows its limits in plain amounts and the agents by name', () => {
  const html = renderRun({run: RUN, mandate: MANDATE, lines: [line(0, 'mandate.confirmed')]});

  assert.match(html, /0\.8 tUSDM/);
  assert.match(html, /0\.4 tUSDM/);
  assert.match(html, /Hakimi Copywriter/);
});

test('the page holds every run and the reports it was given', () => {
  const html = renderPage({
    runs: [{run: RUN, mandate: MANDATE, lines: [line(0, 'mandate.confirmed')]}],
    rejections: {attempts: [{name: 'An order on Mainnet', ok: true, actual: {status: 401, message: 'HTTP 401: <no>'}}]},
    batch: {violations: {total: 1000, blocked: 1000, byRule: {G1: 1000}}, legal: {total: 100, allowed: 100}, replay: {attempts: 10, orders: 1}, parallel: {attempts: 2, passed: 1}},
    redteam: {proposals: {generated: 100, schemaRejected: 63, guardBlocked: {G1: 20}, reviewer: {veto: 6, escalate: 2, allow: 9}, outsideMandate: []}, injections: {texts: 20, hooked: 0}},
  });

  assert.match(html, /<title>/);
  assert.match(html, /A paid job/);
  assert.match(html, /An order on Mainnet/);
  assert.match(html, /1000 of 1000/);
  assert.match(html, /100 model-written attacks/);
  assert.ok(html.includes('&lt;no&gt;'));
  assert.match(html, /prefers-color-scheme: dark/);
});

test('a page without the optional reports still renders', () => {
  const html = renderPage({runs: [{run: RUN, mandate: null, lines: [line(0, 'mandate.confirmed')]}]});

  assert.match(html, /A paid job/);
  assert.ok(!html.includes('undefined'));
});
