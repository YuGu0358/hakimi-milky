import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLedger} from './ledger.mjs';
import {answerOwner, openQuestions, withOwnerDecisions} from './owner-decisions.mjs';

const newLedger = () => createLedger({path: join(mkdtempSync(join(tmpdir(), 'owner-')), 'e.jsonl'), taskId: 't'});
const request = {proposal: {subtask: 'normalize', agentIdentifier: 'agent-1'}};
const unsure = async () => ({decision: 'escalate', reason: 'The reviewer is unsure', detail: {confidence: 0.3}});

test('an unsure reviewer asks the owner once, however many times the run tries', async () => {
  const ledger = newLedger();
  const review = withOwnerDecisions(unsure, ledger);

  assert.equal((await review(request)).decision, 'escalate');
  await review(request);

  assert.equal(ledger.lines().filter(({step}) => step === 'owner.asked').length, 1);
  assert.equal(openQuestions(ledger.lines()).length, 1);
});

test('after the owner approves, the same hire goes ahead', async () => {
  const ledger = newLedger();
  const review = withOwnerDecisions(unsure, ledger);
  await review(request);

  answerOwner({ledger, answer: 'approve'});

  const reviewed = await review(request);
  assert.equal(reviewed.decision, 'allow');
  assert.equal(reviewed.detail.reviewerSaid, 'The reviewer is unsure');
  assert.equal(openQuestions(ledger.lines()).length, 0);
});

test('after the owner says no, the hire is vetoed', async () => {
  const ledger = newLedger();
  const review = withOwnerDecisions(unsure, ledger);
  await review(request);

  answerOwner({ledger, answer: 'reject'});

  assert.equal((await review(request)).decision, 'veto');
});

test('an approval covers only the agent and the job it was given for', async () => {
  const ledger = newLedger();
  const review = withOwnerDecisions(unsure, ledger);
  await review(request);
  answerOwner({ledger, answer: 'approve'});

  const other = await review({proposal: {subtask: 'normalize', agentIdentifier: 'agent-2'}});
  const otherJob = await review({proposal: {subtask: 'copy', agentIdentifier: 'agent-1'}});

  assert.equal(other.decision, 'escalate');
  assert.equal(otherJob.decision, 'escalate');
});

test('an approval cannot overrule a veto', async () => {
  const ledger = newLedger();
  await withOwnerDecisions(unsure, ledger)(request);
  answerOwner({ledger, answer: 'approve'});

  const reviewed = await withOwnerDecisions(async () => ({decision: 'veto', reason: 'Wasteful'}), ledger)(request);

  assert.equal(reviewed.decision, 'veto');
});

test('a reviewer that could not answer is not a question for the owner', async () => {
  const ledger = newLedger();

  const reviewed = await withOwnerDecisions(async () => ({decision: 'escalate', reason: 'down', unavailable: true}), ledger)(request);

  assert.equal(reviewed.unavailable, true);
  assert.equal(ledger.lines().length, 0);
});

test('answering with nothing waiting, or with an unknown word, is refused', () => {
  const ledger = newLedger();

  assert.throws(() => answerOwner({ledger, answer: 'approve'}), /no question/);
  assert.throws(() => answerOwner({ledger, answer: 'maybe'}), /approve or reject/);
});
