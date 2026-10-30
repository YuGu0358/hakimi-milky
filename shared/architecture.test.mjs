// It only reads text, so it needs no service, no network, and neither node_modules folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {posix} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'runs']);
const FOLDERS = ['shared', 'orchestrator', 'payments', 'registry', 'specialists', 'track-record', 'evidence', 'ops', 'frontdesk'];

// A folder may import itself and these.
const MAY_IMPORT = Object.freeze({
  shared: [],
  orchestrator: ['shared'],
  payments: ['shared'],
  registry: ['shared'],
  specialists: ['shared'],
  'track-record': ['shared'],
  evidence: ['shared'],
  ops: ['shared'],
  frontdesk: [],
});
// The starter's small files with no imports of their own. Reused on purpose, so anything may use them.
const STARTER_LEAVES = new Set(['frontdesk/standard-hash.mjs', 'frontdesk/worker-lock.mjs', 'frontdesk/registration-config.mjs']);
// Entry points that wire parts together. They may import anything.
const WIRING = new Set([
  'orchestrator/live-parts.mjs',
  'orchestrator/run-live.mjs',
  'orchestrator/run-offline.mjs',
  'orchestrator/run-batch.mjs',
  'orchestrator/run-redteam.mjs',
  'orchestrator/run-reconcile.mjs',
  'orchestrator/crash-test.mjs',
  'registry/run-allow.mjs',
  'orchestrator/batch.mjs',
  'payments/probe-c2.mjs',
  'payments/rejections.mjs',
  'frontdesk/worker.mjs',
]);
const TEST_HELPERS = new Set(['specialists/test-kit.mjs', 'specialists/fake-mps.mjs', 'specialists/mps-http.mjs']);
// A ratchet, so the test can land before any file moves. Delete a line when its import is fixed; a stale line fails too.
const KNOWN_WRONG = new Set([
  'payments/buyer-key.mjs -> specialists/mps.mjs',
  'payments/payments.mjs -> specialists/mps.mjs',
  'specialists/start.mjs -> orchestrator/llm.mjs',
  'specialists/work.mjs -> orchestrator/acceptance.mjs',
  'track-record/track-record.mjs -> specialists/paths.mjs',
]);

const isTest = (file) => file.endsWith('.test.mjs');
const folderOf = (file) => file.split('/')[0];
const read = (file) => readFileSync(`${ROOT}/${file}`, 'utf8');

function walk(directory) {
  return readdirSync(`${ROOT}/${directory}`, {withFileTypes: true}).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name) ? [] : walk(path);
    return entry.name.endsWith('.mjs') ? [path] : [];
  });
}

const STATEMENT = /^\s*(?:import|export)\b([^'"`;]*?)\bfrom\s*['"](\.[^'"]+)['"]|^\s*import\s*['"](\.[^'"]+)['"]/gm;

function importsOf(file) {
  return [...read(file).matchAll(STATEMENT)].map(({1: names = '', 2: spec, 3: bare}) => ({
    from: file,
    to: posix.normalize(posix.join(posix.dirname(file), spec ?? bare)),
    names: /\{([^}]*)\}/.exec(names)?.[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0]).filter(Boolean) ?? [],
  }));
}

const FILES = FOLDERS.flatMap(walk);
const EDGES = FILES.flatMap(importsOf);
const PRODUCTION = EDGES.filter(({from}) => !isTest(from));
const describeEdge = ({from, to}) => `${from} -> ${to}`;

const breaksDirection = ({from, to}) => {
  const [a, b] = [folderOf(from), folderOf(to)];
  return a !== b && !WIRING.has(from) && !STARTER_LEAVES.has(to) && !MAY_IMPORT[a].includes(b);
};

test('imports follow the folder direction, and the ratchet is up to date', () => {
  const wrong = new Set(PRODUCTION.filter(breaksDirection).map(describeEdge));
  assert.deepEqual([...wrong].filter((edge) => !KNOWN_WRONG.has(edge)), [], 'new imports against the direction');
  assert.deepEqual([...KNOWN_WRONG].filter((edge) => !wrong.has(edge)), [], 'fixed imports to delete from KNOWN_WRONG');
});

test('production code never imports a test helper', () => {
  assert.deepEqual(PRODUCTION.filter(({from, to}) => TEST_HELPERS.has(to) && !TEST_HELPERS.has(from)).map(describeEdge), []);
});

test('the starter leaves stay leaves', () => {
  assert.deepEqual(EDGES.filter(({from}) => STARTER_LEAVES.has(from)).map(describeEdge), []);
});

// frontdesk/worker.mjs starts a worker when imported and no CI job can load it, so this is the only check it gets.
test('every relative import names a file that exists and exports what is asked for', () => {
  const missing = EDGES.filter(({to}) => !existsSync(`${ROOT}/${to}`)).map(describeEdge);
  const absent = EDGES.filter(({to}) => to.endsWith('.mjs') && existsSync(`${ROOT}/${to}`)).flatMap(({from, to, names}) => {
    const text = read(to);
    return names
      .filter((name) => !new RegExp(`^export\\s+(?:async\\s+)?(?:function|const|class)\\s+${name}\\b|^export\\s*\\{[^}]*\\b${name}\\b`, 'm').test(text))
      .map((name) => `${from} wants ${name} from ${to}`);
  });
  assert.deepEqual([...missing, ...absent], []);
});

test('every file named in a script or in the supervisor exists', () => {
  // Names like *.test.mjs in a glob, and bare comments, are not paths. Only a name starting with a word counts.
  const mentioned = (file, base = '') => [...read(file).matchAll(/(?<![\w./*-])(\w[\w./-]*\.mjs)/g)].map(([, path]) => `${base}${path}`);
  const missingFrom = (file, base) => mentioned(file, base).filter((path) => !existsSync(`${ROOT}/${path}`));
  assert.deepEqual([...missingFrom('package.json', ''), ...missingFrom('frontdesk/package.json', 'frontdesk/'), ...missingFrom('ops/services.mjs', '')], []);
});

test('no file imports itself through a cycle', () => {
  const next = Map.groupBy(PRODUCTION, ({from}) => from);
  const finished = new Set();
  const cycles = [];
  const visit = (file, path) => {
    if (path.includes(file)) cycles.push([...path.slice(path.indexOf(file)), file].join(' -> '));
    else if (!finished.has(file)) {
      (next.get(file) ?? []).forEach(({to}) => visit(to, [...path, file]));
      finished.add(file);
    }
  };
  FILES.forEach((file) => visit(file, []));
  assert.deepEqual(cycles, []);
});
