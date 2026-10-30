import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

// Runs the real entry point as its own process around a tiny real server, so CI shows that
// starting, killing and restarting work on each operating system.

const SCRIPT = fileURLToPath(new URL('./keep-online.mjs', import.meta.url));
const WAIT_MS = 30_000;
const POLL_MS = 50;

async function waitFor(check, label) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function answers(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/`, {signal: AbortSignal.timeout(1_000)})).status === 200;
  } catch {
    return false;
  }
}

// Dies when asked, because the pid the supervisor knows on Windows is the shell's, not the server's.
const SERVER_SOURCE = `import {createServer} from 'node:http';
createServer((req, res) => {
  if (req.url === '/die') process.exit(1);
  res.end('ok');
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

async function crash(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/die`, {signal: AbortSignal.timeout(1_000)});
  } catch {
    // The connection drops when the server exits, which is the point.
  }
}

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'online-'));
  const port = await freePort();
  writeFileSync(join(directory, 'server.mjs'), SERVER_SOURCE);
  const configPath = join(directory, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      checkMs: POLL_MS,
      options: {graceMs: 10_000, maxFailures: 2, minBackoffMs: 50, maxBackoffMs: 200, stableMs: 60_000},
      services: [
        {
          name: 'tiny',
          cwd: directory,
          command: `"${process.execPath}" server.mjs`,
          env: {PORT: String(port)},
          urls: [`http://127.0.0.1:${port}/`],
        },
      ],
    }),
  );
  const env = {...process.env, ONLINE_CONFIG: configPath, ONLINE_DIR: directory};
  const statusPath = join(directory, 'status.json');
  const readStatus = () => {
    try {
      return JSON.parse(readFileSync(statusPath, 'utf8')).services[0];
    } catch {
      return null;
    }
  };
  const command = (name) => spawnSync(process.execPath, [SCRIPT, name], {env, encoding: 'utf8'});
  const run = () => {
    const child = spawn(process.execPath, [SCRIPT, 'run'], {env, stdio: ['ignore', 'pipe', 'pipe']});
    const output = {text: ''};
    child.stdout.on('data', (chunk) => {
      output.text += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output.text += chunk;
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    return {child, output, exited};
  };
  // Whatever a test leaves running is stopped here, so it cannot keep the test runner open.
  t.after(async () => {
    command('stop');
    await sleep(300);
    await crash(port);
  });
  return {directory, port, readStatus, command, run};
}

test('it starts a service that is down, and starts it again after it dies', async (t) => {
  const {port, readStatus, run} = await setup(t);
  const supervisor = run();
  t.after(async () => {
    supervisor.child.kill();
    await supervisor.exited;
  });

  const first = await waitFor(() => {
    const status = readStatus();
    return status?.healthy && status.pid ? status : null;
  }, 'the service to answer');
  await crash(port);
  const second = await waitFor(() => {
    const status = readStatus();
    return status?.healthy && status.pid && status.pid !== first.pid ? status : null;
  }, 'the service to come back');

  assert.equal(second.restarts, 1);
  assert.equal(await answers(port), true);
});

test('a service that already answers is left running and stays up after a stop', async (t) => {
  const {directory, port, readStatus, command, run} = await setup(t);
  const handStarted = spawn(process.execPath, ['server.mjs'], {cwd: directory, env: {...process.env, PORT: String(port)}, stdio: 'ignore'});
  t.after(() => handStarted.kill());
  await waitFor(() => answers(port), 'the hand-started server');
  const supervisor = run();

  const status = await waitFor(() => (readStatus()?.mode === 'adopted' ? readStatus() : null), 'the supervisor to adopt it');
  command('stop');
  await supervisor.exited;

  assert.equal(status.pid, null);
  assert.equal(await answers(port), true);
});

test('stop ends the supervisor and the services it started', async (t) => {
  const {port, readStatus, command, run} = await setup(t);
  const supervisor = run();
  await waitFor(() => readStatus()?.healthy, 'the service to answer');

  const stopped = command('stop');
  await supervisor.exited;

  assert.equal(stopped.status, 0);
  await waitFor(async () => !(await answers(port)), 'the service to stop');
});

test('stop returns only once the supervisor has gone, so a start right after it works', async (t) => {
  const {readStatus, command, directory} = await setup(t);
  command('start');
  await waitFor(() => readStatus()?.healthy, 'the service to answer');

  const stopped = command('stop');

  assert.match(stopped.stdout, /Stopped/);
  assert.equal(existsSync(join(directory, 'supervisor.lock')), false);
  const started = command('start');
  assert.equal(started.status, 0);
  assert.match(started.stdout, /started/);
  await waitFor(() => readStatus()?.healthy, 'the service to answer again');
});

test('start says so when a supervisor is already running, instead of pretending', async (t) => {
  const {readStatus, command} = await setup(t);
  command('start');
  await waitFor(() => readStatus()?.healthy, 'the service to answer');

  const again = command('start');

  assert.equal(again.status, 1);
  assert.match(again.stderr, /already running/);
  assert.doesNotMatch(again.stdout, /started/);
});

test('a second supervisor refuses to start', async (t) => {
  const {readStatus, run} = await setup(t);
  const first = run();
  t.after(async () => {
    first.child.kill();
    await first.exited;
  });
  await waitFor(() => readStatus()?.healthy, 'the service to answer');

  const second = run();
  const code = await second.exited;

  assert.equal(code, 1);
  assert.match(second.output.text, /already running/);
});

test('status prints each service, and says so when nothing has run', async (t) => {
  const {readStatus, command, run} = await setup(t);
  const before = command('status');
  const supervisor = run();
  t.after(async () => {
    supervisor.child.kill();
    await supervisor.exited;
  });
  await waitFor(() => readStatus()?.healthy, 'the service to answer');

  const after = command('status');

  assert.match(before.stdout, /not running/);
  assert.match(after.stdout, /tiny/);
  assert.match(after.stdout, /healthy/);
});

test('start returns at once and leaves the supervisor running on its own', async (t) => {
  const {directory, readStatus, command} = await setup(t);

  const started = command('start');
  await waitFor(() => readStatus()?.healthy, 'the service to answer');

  assert.equal(started.status, 0);
  assert.equal(existsSync(join(directory, 'supervisor.log')), true);
  command('stop');
});

test('an unknown command says how to use it', () => {
  const result = spawnSync(process.execPath, [SCRIPT, 'dance'], {encoding: 'utf8'});

  assert.equal(result.status, 1);
  assert.match(result.stderr, /start/);
});
