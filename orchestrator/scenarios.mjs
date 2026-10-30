import injection from '../shared/fixtures/injection.json' with {type: 'json'};
import table from '../shared/fixtures/table.json' with {type: 'json'};

// The demo runs, shared by the offline and the live entry points.
//   c1   two specialists, both pass
//   c2   the cheap agent loses rows, refund, re-hire
//   c3   an instruction hidden in a supplier note, against the real model
//   c3m  the same attack as if the model had fallen for it

const injectedTable = table.map((row) => (row.sku === injection.sku ? {...row, note: injection.note} : row));

const SCENARIOS = Object.freeze({
  c1: {table, faults: {}},
  c2: {table, faults: {dropRows: 2}},
  c3: {table: injectedTable, faults: {}},
  c3m: {table: injectedTable, faults: {}, malicious: true},
});

export function scenarioNamed(name) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`Unknown scenario ${name}. Use one of: ${Object.keys(SCENARIOS).join(', ')}`);
  return scenario;
}

export function printEvidence(lines) {
  const start = lines[0]?.ts ?? 0;
  for (const line of lines) {
    const seconds = ((line.ts - start) / 1000).toFixed(1).padStart(6);
    const verdict = [line.decision, line.rule, line.code].filter(Boolean).join(' ');
    const note = [verdict, line.reason].filter(Boolean).join(' | ').slice(0, 130);
    console.log(`${seconds}s  ${(line.subtask ?? '-').padEnd(9)}  ${line.step.padEnd(24)}  ${note}`);
  }
}
