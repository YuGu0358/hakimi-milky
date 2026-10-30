import {requireSavedRuntimeToken} from '../frontdesk/registration-config.mjs';
import {acquireWorkerLock} from '../frontdesk/worker-lock.mjs';
import {createGenerate} from '../orchestrator/llm.mjs';
import {REGISTRATION_PATH, TOKEN_PATH, jobsDir, lockPath} from './paths.mjs';
import {createMps} from './mps.mjs';
import {PROFILES} from './profiles.mjs';
import {confirmedRegistration} from './registration.mjs';
import {createSellerLoop} from './loop.mjs';
import {createSpecialistServer} from './server.mjs';
import {createJobStore} from './store.mjs';
import {createWork, parseFault} from './work.mjs';

// npm run specialists [-- standard cheap copy]
// Needs MPS_URL, a registered agent and the key from specialists:register. The copy agent also
// needs ZAI_*. FAULT=drop_rows:2 or FAULT=no_show makes the cheap agent misbehave for the demo.

const POLL_MS = Number(process.env.SPECIALIST_POLL_MS ?? 5_000);
const COPY_MAX_OUTPUT_TOKENS = 3_000;

function startAgent(profile, {mps, fault}) {
  const release = acquireWorkerLock(lockPath(profile.id));
  const log = (line) => console.error(`[${profile.id}] ${line}`);
  const store = createJobStore(jobsDir(profile.id));
  const agentFault = profile.acceptsFault ? fault : {};
  const generate = profile.role === 'copy' ? createGenerate({maxOutputTokens: COPY_MAX_OUTPUT_TOKENS}) : undefined;
  const work = createWork({profile, fault: agentFault, generate, log});
  const server = createSpecialistServer({
    profile,
    store,
    mps,
    registration: () => confirmedRegistration(REGISTRATION_PATH, profile.id),
    log,
  });
  server.listen(Number(process.env.SPECIALIST_TEST_PORT ?? profile.port), '127.0.0.1', () => {
    console.log(`${profile.name} on http://127.0.0.1:${server.address().port}`);
  });
  const loop = createSellerLoop({store, mps, work, fault: agentFault, log});
  setInterval(loop.tick, POLL_MS);
  return release;
}

function start(names) {
  const chosen = names.length > 0 ? names : Object.keys(PROFILES);
  const profiles = chosen.map((name) => {
    if (!PROFILES[name]) throw new Error(`Unknown agent ${name}`);
    return PROFILES[name];
  });
  const mps = createMps({baseUrl: process.env.MPS_URL, token: requireSavedRuntimeToken(TOKEN_PATH)});
  const fault = parseFault(process.env.FAULT);
  const releases = profiles.map((profile) => startAgent(profile, {mps, fault}));
  process.on('exit', () => releases.forEach((release) => release()));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

try {
  start(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
