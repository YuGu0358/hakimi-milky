import {exec, spawn} from 'node:child_process';
import {closeSync, existsSync, openSync, readFileSync} from 'node:fs';
import {delimiter, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';

// What "online" means for this project, and how to start, stop and check it on macOS and Windows.

const IS_WINDOWS = process.platform === 'win32';
const REQUEST_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 40_000;
const KILL_WAIT_MS = 5_000;
const WATCH_LOGIN_EVERY_MS = 60_000;
const SLOW_BOOT_MS = 180_000;

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORKSPACE = dirname(ROOT.replace(/[\\/]$/, ''));

function readCoworkerId(envPath) {
  if (!existsSync(envPath)) return null;
  return parseEnv(readFileSync(envPath, 'utf8')).COWORKER_ID?.trim() || null;
}

// The default layout is the one on the demo machine: the two checkouts sit beside this repo.
export function projectServices(env = process.env) {
  const coworkerDir = env.COWORKER_DIR ?? join(WORKSPACE, 'tum-hackathon-quickstart');
  const mpsDir = env.MPS_DIR ?? join(WORKSPACE, 'masumi-payment-service');
  const coworkerEnv = join(coworkerDir, '.env');
  const coworkerId = readCoworkerId(coworkerEnv);
  return [
    {
      name: 'payment-service',
      cwd: mpsDir,
      command: 'corepack pnpm run dev',
      env: {COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'},
      urls: ['http://127.0.0.1:38127/api/v1/health'],
      graceMs: SLOW_BOOT_MS,
    },
    {name: 'coworker-agent', cwd: coworkerDir, command: 'npm start', urls: ['http://127.0.0.1:21949/'], graceMs: SLOW_BOOT_MS},
    {name: 'coworker-worker', cwd: coworkerDir, command: 'npm run worker', lockFile: join(coworkerDir, '.local', 'worker.lock')},
    {
      name: 'specialists',
      cwd: ROOT,
      command: `"${process.execPath}" --env-file="${coworkerEnv}" specialists/start.mjs`,
      urls: [4101, 4102, 4103].map((port) => `http://127.0.0.1:${port}/availability`),
    },
    // The same read the worker polls with. It fails when the login has expired, which only a person can fix.
    ...(coworkerId
      ? [{name: 'sokosumi-login', cwd: coworkerDir, probe: `sokosumi --preprod tasks list --coworker-id ${coworkerId} --json`, checkEveryMs: WATCH_LOGIN_EVERY_MS}]
      : []),
  ];
}

async function answersOk(url) {
  try {
    return (await fetch(url, {signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)})).ok;
  } catch {
    return false;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function lockOwnerAlive(lockFile) {
  if (!existsSync(lockFile)) return false;
  const pid = Number(readFileSync(lockFile, 'utf8'));
  return Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid);
}

// Children find the Node that runs this supervisor first, whatever the login shell's PATH says.
function childEnv(extra = {}) {
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  return {...process.env, [pathKey]: `${dirname(process.execPath)}${delimiter}${process.env[pathKey] ?? ''}`, ...extra};
}

const probeSucceeds = ({probe, cwd}) =>
  new Promise((resolve) => {
    exec(probe, {cwd, env: childEnv(), timeout: PROBE_TIMEOUT_MS, windowsHide: true}, (error) => resolve(!error));
  });

export async function isHealthy(service) {
  if (service.probe) return probeSucceeds(service);
  if (service.lockFile) return lockOwnerAlive(service.lockFile);
  const results = await Promise.all(service.urls.map(answersOk));
  return results.every(Boolean);
}

function stopTree(pid) {
  if (IS_WINDOWS) {
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {stdio: 'ignore', windowsHide: true});
    return;
  }
  const signal = (name) => {
    try {
      process.kill(-pid, name);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), KILL_WAIT_MS).unref();
}

// Each service gets its own process group, so killing it also ends what npm or pnpm started.
export function spawnLogged(service, logDir) {
  const logFile = openSync(join(logDir, `${service.name}.log`), 'a');
  const child = spawn(service.command, {
    cwd: service.cwd,
    env: childEnv(service.env),
    shell: true,
    detached: !IS_WINDOWS,
    windowsHide: true,
    stdio: ['ignore', logFile, logFile],
  });
  closeSync(logFile);
  return {
    pid: child.pid,
    kill: () => {
      if (child.pid) stopTree(child.pid);
    },
    onExit(handler) {
      let isDone = false;
      const once = (value) => {
        if (isDone) return;
        isDone = true;
        handler(value);
      };
      child.once('exit', once);
      child.once('error', (error) => once(error.message));
    },
  };
}

// Stops idle sleep while the supervisor lives. A closed lid still sleeps the machine.
export function keepAwake(log) {
  if (process.platform === 'darwin') {
    spawn('caffeinate', ['-dimsu', '-w', String(process.pid)], {stdio: 'ignore', detached: true}).unref();
    log('Keeping this Mac awake while the supervisor runs');
    return;
  }
  log('Not on macOS: set the power plan so this machine does not sleep');
}

export function desktopNotify(message) {
  if (process.platform !== 'darwin') return;
  const text = message.replace(/["\\]/g, '');
  spawn('osascript', ['-e', `display notification "${text}" with title "Hakimi Milky"`], {stdio: 'ignore', detached: true}).unref();
}
