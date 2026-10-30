import {ALLOWLIST_PATH, REGISTRATION_PATH, TOKEN_PATH} from './paths.mjs';
import {createMps} from './mps.mjs';
import {PROFILES} from './profiles.mjs';
import {createRegistrar} from './registration.mjs';

// npm run specialists:register -- key | register [standard cheap copy] | status
// Needs MPS_URL, ADMIN_KEY and AGENT_AUTHOR. Registering spends ADA from the selling wallet.

const USAGE = 'Usage: key | register [standard cheap copy] | status';

function chosenProfiles(names) {
  const chosen = names.length > 0 ? names : Object.keys(PROFILES);
  return chosen.map((name) => PROFILES[name] ?? fail(`Unknown agent ${name}`));
}

function fail(message) {
  throw new Error(message);
}

function createFromEnv() {
  if (!process.env.ADMIN_KEY) fail('Set ADMIN_KEY');
  return createRegistrar({
    request: createMps({baseUrl: process.env.MPS_URL, token: process.env.ADMIN_KEY}),
    author: process.env.AGENT_AUTHOR,
    statePath: REGISTRATION_PATH,
    tokenPath: TOKEN_PATH,
    allowlistPath: ALLOWLIST_PATH,
    sellingWalletVkey: process.env.SELLING_WALLET_VKEY,
  });
}

async function run([command, ...names]) {
  if (!['key', 'register', 'status'].includes(command)) fail(USAGE);
  const registrar = createFromEnv();
  if (command === 'key') {
    const {created, id} = await registrar.ensureKey();
    console.log(created ? `Runtime key created: ${id}` : `Runtime key already saved: ${id}`);
    return;
  }
  if (command === 'register') {
    for (const profile of chosenProfiles(names)) {
      const {created, id} = await registrar.register(profile);
      console.log(`${profile.id}: ${created ? 'registration requested' : 'already requested'}, ${id}`);
    }
    return;
  }
  const {agents, allowlist} = await registrar.refresh();
  for (const {id} of Object.values(PROFILES)) {
    const agent = agents[id];
    console.log(`${id}: ${agent?.state ?? 'not registered'}${agent?.error ? `, ${agent.error}` : ''}`);
  }
  console.log(`${allowlist.length} confirmed, allowlist in ${ALLOWLIST_PATH}`);
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
