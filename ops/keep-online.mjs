import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireWorkerLock} from '../frontdesk/worker-lock.mjs';
import {desktopNotify, isHealthy, keepAwake, projectServices, spawnLogged} from './services.mjs';
import {createSupervisor} from './supervisor.mjs';

// npm run online          start the supervisor in the background
// npm run online:status   what is up, and what it restarted
// npm run online:stop     stop it and the services it started; services started by hand keep running
// Start it from a shell where Node 24 is on the PATH. On the Mac: source env.sh first.

const SELF = fileURLToPath(import.meta.url);
const DIRECTORY = process.env.ONLINE_DIR ?? fileURLToPath(new URL('../.local/online/', import.meta.url));
const LOCK_PATH = join(DIRECTORY, 'supervisor.lock');
const STATUS_PATH = join(DIRECTORY, 'status.json');
const STOP_PATH = join(DIRECTORY, 'stop');
const LOG_PATH = join(DIRECTORY, 'supervisor.log');
const DEFAULT_CHECK_MS = 15_000;
const STALE_AFTER_MS = 60_000;
const USAGE = 'Usage: keep-online.mjs start | run | status | stop';

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
  mkdirSync(DIRECTORY, {recursive: true});
  const logFile = openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [SELF, 'run'], {detached: true, windowsHide: true, stdio: ['ignore', logFile, logFile], env: process.env});
  child.unref();
  console.log(`Supervisor started, pid ${child.pid}. Log: ${LOG_PATH}`);
}

function printStatus() {
  if (!existsSync(STATUS_PATH) || !existsSync(LOCK_PATH)) {
    console.log('The supervisor is not running.');
    return;
  }
  const {updatedAt, services} = JSON.parse(readFileSync(STATUS_PATH, 'utf8'));
  if (Date.now() - Date.parse(updatedAt) > STALE_AFTER_MS) console.log(`The supervisor looks stuck: last update ${updatedAt}.`);
  for (const {name, mode, healthy, restarts, pid} of services) {
    console.log(`${name.padEnd(18)} ${healthy ? 'healthy' : 'NOT HEALTHY'}  ${mode.padEnd(9)} restarts: ${restarts}${pid ? `  pid: ${pid}` : ''}`);
  }
}

// A file instead of a signal: on Windows a signal kills at once, with no chance to stop the services.
function requestStop() {
  if (!existsSync(LOCK_PATH)) {
    console.log('The supervisor is not running.');
    return;
  }
  writeFileSync(STOP_PATH, '');
  console.log('Stop requested.');
}

const COMMANDS = Object.freeze({run, start: startInBackground, status: printStatus, stop: requestStop});

try {
  const command = COMMANDS[process.argv[2] ?? 'start'];
  if (!command) throw new Error(USAGE);
  command();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
