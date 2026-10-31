import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {EVIDENCE_DIR} from './live-parts.mjs';
import {createLedger} from './ledger.mjs';
import {answerOwner, openQuestions} from './owner-decisions.mjs';

// npm run owner -- <taskId>                  show what the reviewer is asking
// npm run owner -- <taskId> approve|reject   answer it; then start the same task again to continue

function main([taskId, answer]) {
  if (!taskId) throw new Error('Usage: npm run owner -- <taskId> [approve|reject]');
  const path = join(EVIDENCE_DIR, `${taskId}-evidence.jsonl`);
  if (!existsSync(path)) throw new Error(`No evidence for task ${taskId}`);
  const ledger = createLedger({path, taskId});
  if (!answer) {
    const questions = openQuestions(ledger.lines());
    if (questions.length === 0) console.log('Nothing is waiting for the owner.');
    questions.forEach(({subtask, reason, detail}) => console.log(`${subtask}: hire ${detail.agentIdentifier}? ${reason}`));
    return;
  }
  const line = answerOwner({ledger, answer});
  console.log(`${line.reason} for ${line.subtask}. Continue with: npm run live -- <scenario> ${taskId}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
