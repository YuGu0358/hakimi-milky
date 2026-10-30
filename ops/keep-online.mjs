import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {acquireWorkerLock} from '../frontdesk/worker-lock.mjs';
import {STALE_AFTER_MS, renderView} from './coworker-view.mjs';
import {coworkerInfo, desktopNotify, isHealthy, keepAwake, lockOwnerAlive, projectServices, readCoworkerTasks, spawnLogged} from './services.mjs';
import {createSupervisor} from './supervisor.mjs';

// npm run online          start the supervisor in the background
// npm run online:status   what is up, and what it restarted
// npm run online:watch    a live panel of the Coworker, its services and its tasks
// npm run online:stop     stop it and the services it started; services started by hand keep running
// Start it from a shell where Node 24 is on the PATH. On the Mac: source env.sh first.

const SELF = fileURLToPath(import.meta.url);
const DIRECTORY = process.env.ONLINE_DIR ?? fileURLToPath(new URL('../.local/online/', import.meta.url));
const LOCK_PATH = join(DIRECTORY, 'supervisor.lock');
const STATUS_PATH = join(DIRECTORY, 'status.json');
const STOP_PATH = join(DIRECTORY, 'stop');
const LOG_PATH = join(DIRECTORY, 'supervisor.log');
const DEFAULT_CHECK_MS = 15_000;
const WATCH_DRAW_MS = 5_000;
const WATCH_TASKS_MS = 30_000;
const STOP_WAIT_MS = 45_000;
const STOP_POLL_MS = 200;
const USAGE = 'Usage: keep-online.mjs start | run | status | watch | stop';

function loadConfig() {
  const path = process.env.ONLINE_CONFIG;
  return path ? JSON.parse(readFileSync(path, 'utf8')) : {services: projectServices(), checkMs: DEFAULT_CHECK_MS};
}

const stamped = (line) => console.log(`${new Date().toISOString()} ${line}`);

function run() {
  mkdirSync(DIRECTORY, {recursive: true});
  const release = acquireWorkerLock(LOCK_PATH);
  rmSync(STOP_PATH, {force: true});
  const {services, checkMs = DEFAULT_CHECK_MS, options} = loadConfig();
  const supervisor = createSupervisor({
    services,
    isHealthy,
    spawnService: (service) => spawnLogged(service, DIRECTORY),
    log: stamped,
    notify: (message) => {
      stamped(message);
      desktopNotify(message);
    },
    options,
  });
  const writeStatus = () => {
    const temporary = `${STATUS_PATH}.tmp`;
    writeFileSync(temporary, JSON.stringify({updatedAt: new Date().toISOString(), services: supervisor.status()}, null, 2));
    renameSync(temporary, STATUS_PATH);
  };
  const shutDown = (code) => {
    supervisor.stop();
    release();
    process.exit(code);
  };
  process.once('SIGINT', () => shutDown(130));
  process.once('SIGTERM', () => shutDown(143));
  keepAwake(stamped);

  const beat = async () => {
    if (existsSync(STOP_PATH)) {
      rmSync(STOP_PATH, {force: true});
      stamped('Stopping');
      shutDown(0);
    }
    try {
      await supervisor.tick();
      writeStatus();
    } catch (error) {
      stamped(`Check round failed: ${error.message}`);
    }
  };
  beat();
  setInterval(beat, checkMs);
}

function startInBackground() {
  if (lockOwnerAlive(LOCK_PATH)) {
    console.error('The supervisor is already running. Use online:stop first if you want to restart it.');
    process.exitCode = 1;
    return;
  }
  mkdirSync(DIRECTORY, {recursive: true});
  const logFile = openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [SELF, 'run'], {detached: true, windowsHide: true, stdio: ['ignore', logFile, logFile], env: process.env});
  child.unref();
  console.log(`Supervisor started, pid ${child.pid}. Log: ${LOG_PATH}`);
}

function readStatus() {
  if (!existsSync(STATUS_PATH) || !existsSync(LOCK_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATUS_PATH, 'utf8'));
  } catch (error) {
    stamped(`Could not read the status: ${error.message}`);
    return null;
  }
}

function printStatus() {
  const status = readStatus();
  if (!status) {
    console.log('The supervisor is not running.');
    return;
  }
  const {updatedAt, services} = status;
  if (Date.now() - Date.parse(updatedAt) > STALE_AFTER_MS) console.log(`The supervisor looks stuck: last update ${updatedAt}.`);
  for (const {name, mode, healthy, restarts, pid} of services) {
    console.log(`${name.padEnd(18)} ${healthy ? 'healthy' : 'NOT HEALTHY'}  ${mode.padEnd(9)} restarts: ${restarts}${pid ? `  pid: ${pid}` : ''}`);
  }
}

// A file instead of a signal: on Windows a signal kills at once, with no chance to stop the services.
async function requestStop() {
  if (!lockOwnerAlive(LOCK_PATH)) {
    console.log('The supervisor is not running.');
    return;
  }
  writeFileSync(STOP_PATH, '');
  console.log('Stop requested.');
  // Waits, or a start right after this would find the old supervisor still there and give up.
  const deadline = Date.now() + STOP_WAIT_MS;
  while (lockOwnerAlive(LOCK_PATH) && Date.now() < deadline) await sleep(STOP_POLL_MS);
  console.log(lockOwnerAlive(LOCK_PATH) ? 'It has not stopped yet. Check it with online:status.' : 'Stopped.');
}

// A panel to leave open in a terminal. Tasks come from Sokosumi, so they refresh less often.
function watch() {
  const coworker = coworkerInfo();
  let tasks = {items: []};
  const draw = () => {
    console.clear();
    console.log(renderView({now: Date.now(), coworker, status: readStatus(), tasks}));
  };
  const refreshTasks = async () => {
    try {
      tasks = {items: await readCoworkerTasks(coworker)};
    } catch (error) {
      tasks = {...tasks, error: error.message};
    }
    draw();
  };
  draw();
  refreshTasks();
  setInterval(draw, WATCH_DRAW_MS);
  setInterval(refreshTasks, WATCH_TASKS_MS);
}

const COMMANDS = Object.freeze({run, start: startInBackground, status: printStatus, stop: requestStop, watch});

try {
  const command = COMMANDS[process.argv[2] ?? 'start'];
  if (!command) throw new Error(USAGE);
  await command();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
