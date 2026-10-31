// When the reviewer sends a hire to the owner, the owner's answer goes into the evidence and the run
// picks it up on its next start. The answer only settles the reviewer's question: the guard still
// checks the proposal and the quote, and an owner cannot overrule a veto from here.

const ANSWERS = Object.freeze({approve: 'owner.approved', reject: 'owner.rejected'});

const about = (subtask, agentIdentifier) => (line) => line.subtask === subtask && line.detail?.agentIdentifier === agentIdentifier;

// Questions the owner has not answered yet, oldest first.
export function openQuestions(lines) {
  const answered = lines.filter(({step}) => step === ANSWERS.approve || step === ANSWERS.reject);
  const asked = lines.filter(({step}) => step === 'owner.asked');
  return asked.filter((line) => !answered.some(about(line.subtask, line.detail?.agentIdentifier)));
}

export function answerOwner({ledger, answer}) {
  const step = ANSWERS[answer];
  if (!step) throw new Error('The answer is approve or reject');
  const [question] = openQuestions(ledger.lines());
  if (!question) throw new Error('This task has no question waiting for the owner');
  return ledger.append({step, subtask: question.subtask, reason: `The owner answered: ${answer}`, detail: {agentIdentifier: question.detail.agentIdentifier}});
}

export function withOwnerDecisions(review, ledger) {
  return async (request) => {
    const reviewed = await review(request);
    if (reviewed.decision === 'allow' || reviewed.decision === 'veto' || reviewed.unavailable) return reviewed;
    const {subtask, agentIdentifier} = request.proposal;
    const lines = ledger.lines().filter(about(subtask, agentIdentifier));
    const detail = {...reviewed.detail, reviewerSaid: reviewed.reason};
    if (lines.some(({step}) => step === ANSWERS.reject)) return {decision: 'veto', reason: 'The owner said no to this hire', detail};
    if (lines.some(({step}) => step === ANSWERS.approve)) return {decision: 'allow', reason: 'The reviewer was unsure, and the owner approved this hire', detail};
    if (!lines.some(({step}) => step === 'owner.asked')) {
      ledger.append({step: 'owner.asked', subtask, reason: reviewed.reason, detail: {agentIdentifier}});
    }
    return reviewed;
  };
}
