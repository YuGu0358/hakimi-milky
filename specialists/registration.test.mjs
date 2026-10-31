import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {USDM_UNIT} from '../shared/constants.mjs';
import {PaymentsError} from '../shared/errors.mjs';
import {AllowlistEntry} from '../shared/schemas.mjs';
import {PROFILES} from './profiles.mjs';
import {buildRegistrationBody, confirmedRegistration, createRegistrar} from './registration.mjs';

const CONTRACT = 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g';
const SOURCE = {id: 'source-1', network: 'Preprod', paymentSourceType: 'Web3CardanoV2', smartContractAddress: CONTRACT};
const V1_SOURCE = {...SOURCE, id: 'source-0', paymentSourceType: 'Web3CardanoV1'};
const WALLET = {id: 'wallet-1', walletVkey: 'c1'.repeat(28), walletAddress: 'addr_test1seller', type: 'Selling', paymentSourceId: 'source-1'};
const OTHER_WALLET = {...WALLET, id: 'wallet-2', walletVkey: 'c2'.repeat(28)};
const AGENT_ID = (name) => `${'67'.repeat(28)}${Buffer.from(name).toString('hex')}`;

function fakeAdmin({wallets = [WALLET]} = {}) {
  const calls = [];
  const assets = [];
  const failures = [];
  const request = async (path, body) => {
    calls.push({path, body});
    const failure = failures.shift();
    if (failure) throw failure;
    if (path === '/payment-source?take=100') return {PaymentSources: [V1_SOURCE, SOURCE]};
    if (path.startsWith('/wallet/list?')) return {Wallets: wallets};
    if (path === '/api-key') return {id: 'key-1', token: 'secret-runtime-token', canRead: true, canPay: true, canAdmin: false, NetworkLimit: ['Preprod']};
    if (path === '/registry') {
      const entry = {id: `reg-${assets.length + 1}`, state: 'RegistrationRequested', name: body.name, apiBaseUrl: body.apiBaseUrl, agentIdentifier: null, SmartContractWallet: {walletVkey: body.sellingWalletVkey}};
      assets.push(entry);
      return entry;
    }
    if (path.startsWith('/registry?')) return {Assets: assets};
    throw new Error(`Unexpected call ${path}`);
  };
  const confirmAll = () => {
    assets.forEach((entry, index) => {
      assets[index] = {...entry, state: 'RegistrationConfirmed', agentIdentifier: AGENT_ID(entry.name)};
    });
  };
  return {request, calls, assets, failures, confirmAll};
}

function setup(admin = fakeAdmin(), options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'registration-'));
  const paths = {
    statePath: join(directory, 'nested', 'registration.json'),
    tokenPath: join(directory, 'nested', 'mps-runtime.env'),
    allowlistPath: join(directory, 'nested', 'allowlist.json'),
  };
  const registrar = createRegistrar({request: admin.request, author: 'Mission: Payable', ...paths, ...options});
  return {admin, registrar, ...paths};
}

const callsTo = (admin, path) => admin.calls.filter((call) => call.path === path);

test('the registration body has a fixed price with no decimals, inside the V2 payment source', () => {
  const body = buildRegistrationBody({profile: PROFILES.standard, walletVkey: WALLET.walletVkey, contractAddress: CONTRACT, author: 'Mission: Payable'});

  const [source] = body.supportedPaymentSources;
  assert.deepEqual(source.pricing, {pricingType: 'Fixed', fixed: [{asset: USDM_UNIT, amount: '300000'}]});
  assert.equal(source.paymentSourceType, 'Web3CardanoV2');
  assert.equal(source.address, CONTRACT);
  assert.equal('AgentPricing' in body, false);
  assert.equal(body.apiBaseUrl, 'http://127.0.0.1:4101');
  assert.equal(body.sellingWalletVkey, WALLET.walletVkey);
  assert.equal(body.Author.name, 'Mission: Payable');
});

for (const profile of Object.values(PROFILES)) {
  test(`${profile.id}: name, description and tags fit the registry limits`, () => {
    const body = buildRegistrationBody({profile, walletVkey: WALLET.walletVkey, contractAddress: CONTRACT, author: 'Mission: Payable'});

    assert.ok(body.name.length <= 250);
    assert.ok(body.description.length <= 250);
    assert.ok(body.Tags.length >= 1 && body.Tags.every((tag) => tag.length <= 63));
  });
}

test('the three prices and ports are the ones the plan names', () => {
  const {standard, cheap, copy} = PROFILES;

  assert.deepEqual([standard.priceAmount, cheap.priceAmount, copy.priceAmount], ['300000', '200000', '200000']);
  assert.deepEqual([standard.port, cheap.port, copy.port], [4101, 4102, 4103]);
  assert.deepEqual([standard.role, cheap.role, copy.role], ['normalize', 'normalize', 'copy']);
});

test('an author is required', () => {
  assert.throws(() => createRegistrar({request: async () => ({}), author: ' ', statePath: 'a', tokenPath: 'b', allowlistPath: 'c'}), /AGENT_AUTHOR/);
});

test('the runtime key is limited to Preprod and the selling wallet, and is created once', async () => {
  const {admin, registrar, tokenPath} = setup();

  const first = await registrar.ensureKey();
  const second = await registrar.ensureKey();

  const [{body}] = callsTo(admin, '/api-key');
  assert.equal(callsTo(admin, '/api-key').length, 1);
  assert.deepEqual(body.NetworkLimit, ['Preprod']);
  assert.deepEqual(body.WalletScopeHotWalletIds, [WALLET.id]);
  assert.equal(body.canAdmin, false);
  assert.equal(body.canPay, true);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.match(readFileSync(tokenPath, 'utf8'), /^MPS_RUNTIME_TOKEN=secret-runtime-token/);
});

test('the runtime token never appears in the saved state', async () => {
  const {registrar, statePath} = setup();

  await registrar.ensureKey();

  assert.doesNotMatch(readFileSync(statePath, 'utf8'), /secret-runtime-token/);
});

test('a key write with an unknown outcome is not sent again', async () => {
  const flaky = fakeAdmin();
  const flakyRegistrar = setup({
    ...flaky,
    request: async (path, body) => {
      if (path === '/api-key') {
        flaky.calls.push({path, body});
        throw new PaymentsError('Request timed out');
      }
      return flaky.request(path, body);
    },
  }).registrar;

  await assert.rejects(flakyRegistrar.ensureKey(), /timed out/);
  await assert.rejects(flakyRegistrar.ensureKey(), /unknown outcome/);

  assert.equal(callsTo(flaky, '/api-key').length, 1);
});

test('a key write that was refused can be tried again', async () => {
  let isRefused = true;
  const admin = fakeAdmin();
  const {registrar} = setup({
    ...admin,
    request: async (path, body) => {
      if (path === '/api-key' && isRefused) throw new PaymentsError('Forbidden', {status: 403});
      return admin.request(path, body);
    },
  });

  await assert.rejects(registrar.ensureKey(), /Forbidden/);
  isRefused = false;

  assert.equal((await registrar.ensureKey()).created, true);
});

test('a masked token is refused', async () => {
  const admin = fakeAdmin();
  const {registrar} = setup({
    ...admin,
    request: async (path, body) => (path === '/api-key' ? {id: 'key-1', token: '*****'} : admin.request(path, body)),
  });

  await assert.rejects(registrar.ensureKey(), /not revealed/);
});

test('registering twice writes once', async () => {
  const {admin, registrar} = setup();

  const first = await registrar.register(PROFILES.standard);
  const second = await registrar.register(PROFILES.standard);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(callsTo(admin, '/registry').length, 1);
});

test('registration picks the V2 source on Preprod', async () => {
  const {admin, registrar} = setup();

  await registrar.register(PROFILES.cheap);

  const [{body}] = callsTo(admin, '/registry');
  assert.equal(body.supportedPaymentSources[0].address, CONTRACT);
  assert.equal(body.supportedPaymentSources[0].pricing.fixed[0].amount, '200000');
  assert.match(admin.calls.find((call) => call.path.startsWith('/wallet/list')).path, /paymentSourceId=source-1/);
});

test('two selling wallets need a choice', async () => {
  const admin = fakeAdmin({wallets: [WALLET, OTHER_WALLET]});

  await assert.rejects(setup(admin).registrar.register(PROFILES.standard), /SELLING_WALLET_VKEY/);

  const chosen = setup(admin, {sellingWalletVkey: OTHER_WALLET.walletVkey});
  await chosen.registrar.register(PROFILES.standard);
  assert.equal(callsTo(admin, '/registry')[0].body.sellingWalletVkey, OTHER_WALLET.walletVkey);
});

test('no selling wallet is a clear error', async () => {
  await assert.rejects(setup(fakeAdmin({wallets: []})).registrar.register(PROFILES.standard), /No selling wallet/);
});

test('a registration with an unknown outcome is not sent again, and status finds it', async () => {
  const admin = fakeAdmin();
  let shouldLose = true;
  const {registrar, statePath} = setup({
    ...admin,
    request: async (path, body) => {
      const answer = await admin.request(path, body);
      if (path === '/registry' && shouldLose) {
        shouldLose = false;
        throw new PaymentsError('Response lost');
      }
      return answer;
    },
  });

  await assert.rejects(registrar.register(PROFILES.standard), /lost/);
  await assert.rejects(registrar.register(PROFILES.standard), /unknown outcome/);
  admin.confirmAll();
  await registrar.refresh();

  assert.equal(callsTo(admin, '/registry').length, 1);
  assert.equal(confirmedRegistration(statePath, 'standard').registrationId, 'reg-1');
});

test('a registration that was refused can be tried again', async () => {
  const admin = fakeAdmin();
  const {registrar} = setup(admin);
  admin.failures.push(null, null, new PaymentsError('Invalid assets in pricing', {status: 400}));

  await assert.rejects(registrar.register(PROFILES.standard), /Invalid assets/);

  assert.equal((await registrar.register(PROFILES.standard)).created, true);
});

test('an agent counts as registered only once confirmed', async () => {
  const {admin, registrar, statePath} = setup();
  await registrar.register(PROFILES.standard);

  const before = confirmedRegistration(statePath, 'standard');
  await registrar.refresh();
  const requested = confirmedRegistration(statePath, 'standard');
  admin.confirmAll();
  await registrar.refresh();
  const confirmed = confirmedRegistration(statePath, 'standard');

  assert.equal(before, null);
  assert.equal(requested, null);
  assert.equal(confirmed.agentIdentifier, AGENT_ID(PROFILES.standard.name));
  assert.equal(confirmed.sellerVkey, WALLET.walletVkey);
  assert.equal(confirmed.supportedPaymentSourceIndex, 0);
});

test('an agent that is unknown or has no state file is not registered', () => {
  const {statePath} = setup();

  assert.equal(confirmedRegistration(statePath, 'standard'), null);
});

test('status writes an allowlist the mandate can read, with confirmed agents only', async () => {
  const {admin, registrar, allowlistPath} = setup();
  await registrar.register(PROFILES.standard);
  await registrar.register(PROFILES.copy);
  admin.confirmAll();
  await registrar.register(PROFILES.cheap);

  const {allowlist} = await registrar.refresh();
  const onDisk = JSON.parse(readFileSync(allowlistPath, 'utf8'));

  assert.deepEqual(onDisk, allowlist);
  assert.deepEqual(onDisk.map((entry) => entry.role), ['normalize', 'copy']);
  onDisk.forEach((entry) => AllowlistEntry.parse(entry));
});

test('status before any registration writes an empty allowlist', async () => {
  const {registrar, allowlistPath} = setup();

  await registrar.refresh();

  assert.equal(existsSync(allowlistPath), true);
  assert.deepEqual(JSON.parse(readFileSync(allowlistPath, 'utf8')), []);
});
