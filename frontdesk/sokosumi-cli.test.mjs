import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {runCommand} from './sokosumi-cli.mjs';
import {sokosumiRoot} from './sokosumi-runtime.mjs';

// npm installs a sokosumi.cmd shim on Windows and an executable script elsewhere. This fake does the same.
function fakeCliEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-cli-'));
  const script = join(dir, 'fake.mjs');
  writeFileSync(script, `if (process.argv[2] === 'fail') { console.error('boom'); process.exit(3); }
console.log(JSON.stringify(process.argv.slice(2)));
`);
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'sokosumi.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const shim = join(dir, 'sokosumi');
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path');
  return {...process.env, [pathKey]: `${dir}${delimiter}${process.env[pathKey]}`};
}

test('runCommand runs the CLI through its shim and keeps arguments with spaces intact', () => {
  const output = runCommand('sokosumi', ['a b', '--flag'], {env: fakeCliEnv()});
  assert.deepEqual(JSON.parse(output), ['a b', '--flag']);
});

test('runCommand throws with the exit code and stderr when the CLI fails', () => {
  assert.throws(() => runCommand('sokosumi', ['fail'], {env: fakeCliEnv()}), /exited with code 3: boom/);
});

test('runCommand throws when the command does not exist', () => {
  assert.throws(() => runCommand('no-such-command-hakimi', ['x']));
});

test('sokosumiRoot accepts a skills path in the native format of this system', () => {
  const root = join(tmpdir(), 'pkg');
  assert.equal(sokosumiRoot(() => join(root, 'skills')), join(root, 'dist', 'src'));
});
