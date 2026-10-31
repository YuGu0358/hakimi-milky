import {choice, noul} from '@typesafe-ai/sdk';
import {CONFIDENCE_THRESHOLD, jevDecide} from './reviewer.mjs';

// An owner asks for the front desk's own fee back. Jev reads what our records say about the job, and only
// that: an owner's or a seller's words stay out, so nobody can argue with it. If it is sure the job went
// wrong, the front desk agrees. Anything else goes to a person. A refund is never refused by a model.

const QUESTIONS = Object.freeze({
  delivered_to_owner: noul('Our records show the finished work reached the owner.'),
  work_passed_checks: noul('Every piece of work in the delivery passed its checks.'),
  verdict: choice(
    'The owner asked for the fee back. Decide only from these records, which are all that is known. The owner gave no reason here.',
    {
      refund: 'The records show the job went wrong: the work did not reach the owner, or what reached the owner failed its checks.',
      keep: 'The records show the work reached the owner and passed its checks. This is the default.',
    },
  ),
});

// Numbers and yes or no only, from our own evidence.
export function refundFacts(lines, paid) {
  const has = (step) => lines.some((line) => line.step === step);
  const count = (step) => lines.filter((line) => line.step === step).length;
  return {
    job: {fee: '1 tUSDM', result_on_chain: Boolean(paid.resultHash), task_completed: paid.stage === 'awaiting-withdrawal'},
    work: {
      delivered: has('run.delivered'),
      run_failed: has('run.failed'),
      pieces_passed: count('acceptance.passed'),
      pieces_failed: count('acceptance.failed'),
      refunds_from_specialists: count('refund.withdrawn'),
    },
  };
}

export function createRefundReviewer({readLines, decide = jevDecide()}) {
  return async ({taskId, paid}) => {
    try {
      const {answers = {}} = (await decide({state: refundFacts(readLines(taskId), paid), questions: QUESTIONS})) ?? {};
      const {choice: pick, confidence} = answers.verdict ?? {};
      if (pick === 'refund' && confidence >= CONFIDENCE_THRESHOLD) return {decision: 'refund', reason: `Jev agreed to the refund (confidence ${confidence})`};
      return {decision: 'person', reason: `Jev did not agree on its own (${pick ?? 'no answer'}, confidence ${confidence ?? 'none'})`};
    } catch (error) {
      return {decision: 'person', reason: `Jev is unavailable: ${error.message}`};
    }
  };
}
