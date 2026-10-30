import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {reviewBatch, runBatch} from './batch.mjs';
import {createReviewer} from './reviewer.mjs';

// npm run batch                 the guard only: no network, no cost
// npm run batch -- --with-jev   also the reviewer, about 40 Jev calls
// Writes .local/c7-report.json for the evidence page.

const LOG_DIR = fileURLToPath(new URL('../.local/', import.meta.url));

function printReport({violations, legal, boundaries, wasteful, replay, parallel}) {
  console.log(`Out-of-mandate cases: ${violations.blocked} of ${violations.total} blocked, ${violations.escaped.length} got through, ${violations.wrongCode.length} blocked by the wrong rule`);
  for (const [rule, count] of Object.entries(violations.byRule).sort()) console.log(`  ${rule}: ${count}`);
  console.log(`Legal cases: ${legal.allowed} of ${legal.total} allowed`);
  console.log(`Limits checked at the limit and one unit over: ${boundaries.filter(({atLimit, overLimit}) => atLimit === 'allow' && overLimit === 'deny').length} of ${boundaries.length} exact`);
  console.log(`Legal but wasteful: ${wasteful.allowed} of ${wasteful.total} allowed by the guard, which only judges the mandate`);
  console.log(`Same quote sent ${replay.attempts} times: ${replay.orders} order, ${replay.hires} hire counted`);
  console.log(`${parallel.attempts} hires racing for one budget: ${parallel.passed} passed, the other denied with ${parallel.deniedCode}`);
}

function printReviewer({wasteful, fine}) {
  console.log(`Reviewer, wasteful cases: ${wasteful.veto} vetoed, ${wasteful.escalate} sent to the owner, ${wasteful.allow} let through, of ${wasteful.total}`);
  console.log(`Reviewer, fine cases: ${fine.veto} vetoed by mistake, ${fine.escalate} sent to the owner, ${fine.allow} allowed, of ${fine.total}`);
}

const isClean = ({violations, legal, boundaries}) =>
  violations.escaped.length === 0 &&
  violations.wrongCode.length === 0 &&
  legal.blocked.length === 0 &&
  boundaries.every(({atLimit, overLimit}) => atLimit === 'allow' && overLimit === 'deny');

const report = await runBatch();
printReport(report);
const reviewer = process.argv.includes('--with-jev') ? await reviewBatch({review: createReviewer()}) : null;
if (reviewer) printReviewer(reviewer);
console.log('These samples being blocked is a test result, not a proof of safety.');

mkdirSync(LOG_DIR, {recursive: true});
writeFileSync(join(LOG_DIR, 'c7-report.json'), JSON.stringify({...report, reviewer}, null, 2));
process.exitCode = isClean(report) ? 0 : 1;
