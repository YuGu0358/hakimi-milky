import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// npm run refund -- <taskId> approve|keep
// A person's answer to an owner's refund request that Jev did not agree to on its own. The worker reads it.
// keep does not take the money: it stays in escrow until the dispute time.

const [taskId, answer] = process.argv.slice(2);
if (!/^[\w-]+$/.test(taskId ?? '') || !['approve', 'keep'].includes(answer)) {
  console.error('Usage: npm run refund -- <taskId> approve|keep');
  process.exit(1);
}
const path = fileURLToPath(new URL(`./.local/${taskId}-refund-answer.json`, import.meta.url));
writeFileSync(path, JSON.stringify({answer}), {mode: 0o600});
console.log(`Saved: ${answer}. The worker acts on it at its next look at the task.`);
