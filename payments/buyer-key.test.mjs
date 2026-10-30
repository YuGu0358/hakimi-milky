import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RUN_LIMIT, createBuyerKeys} from './buyer-key.mjs';
import {USDM_UNIT} from '../shared/constants.mjs';
import {PaymentsError} from '../shared/errors.mjs';

const SOURCE = {id: 'source-1', network: 'Preprod', paymentSourceType: 'Web3CardanoV2'};
const WALLET = {id: 'wallet-buyer', walletAddress: 'addr_test1buyer', type: 'Purchasing'};

function fakeAdmin({remaining = RUN_LIMIT, failNextKey} = {}) {
  const calls = [];
  const state = {remaining, failNextKey};
  const request = async (path, body, options = {}) => {
    calls.push({path, body, method: options.method ?? (body ? 'POST' : 'GET')});
    if (path === '/payment-source?take=100') return {PaymentSources: [SOURCE]};
    if (path.startsWith('/wallet/list?')) return {Wallets: [WALLET]};
    if (path === '/api-key' && options.method === 'PATCH') {
      const [{amount}] = body.UsageCreditsToAddOrRemove;
      state.remaining = String(BigInt(state.remaining) + BigInt(amount));
      return {id: body.id};
    }
    if (path === '/api-key') {
      if (state.failNextKey) throw state.failNextKey;
      return {id: 'key-1', token: 'secret-buyer-token', canPay: true, canAdmin: false};
    }
    if (path.startsWith('/api-key?')) return {ApiKeys: [{id: 'other', RemainingUsageCredits: []}, {id: 'key-1', RemainingUsageCredits: [{unit: USDM_UNIT, amount: state.remaining}]}]};
    throw new Error(`Unexpected call ${path}`);
  };
  return {request, calls, state};
}

function setup(admin = fakeAdmin()) {
  const directory = mkdtempSync(join(tmpdir(), 'buyer-key-'));
  const statePath = join(directory, 'nested', 'key.json');
  const tokenPath = join(directory, 'nested', 'mps-runtime.env');
  return {admin, statePath, tokenPath, keys: createBuyerKeys({request: admin.request, statePath, tokenPath})};
}

const keyCalls = (admin) => admin.calls.filter((call) => call.path === '/api-key' && call.method === 'POST');

test('the key can only spend the run limit, on Preprod, from the purchasing wallet', async () => {
  const {admin, keys} = setup();

  await keys.ensure();

  const [{body}] = keyCalls(admin);
  assert.equal(body.usageLimited, 'true');
  assert.deepEqual(body.UsageCredits, [{unit: USDM_UNIT, amount: RUN_LIMIT}]);
  assert.deepEqual(body.NetworkLimit, ['Preprod']);
  assert.deepEqual(body.WalletScopeHotWalletIds, [WALLET.id]);
  assert.equal(body.canAdmin, false);
  assert.equal(body.canPay, true);
});

test('the run limit is the 0.8 tUSDM of the demo mandate', () => {
  assert.equal(RUN_LIMIT, '800000');
});

test('the key is created once and its token is saved outside the state', async () => {
  const {admin, keys, statePath, tokenPath} = setup();

  const first = await keys.ensure();
  const second = await keys.ensure();

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(keyCalls(admin).length, 1);
  assert.match(readFileSync(tokenPath, 'utf8'), /^MPS_RUNTIME_TOKEN=secret-buyer-token/);
  assert.doesNotMatch(readFileSync(statePath, 'utf8'), /secret-buyer-token/);
});

test('a key write with an unknown outcome is not sent again', async () => {
  const admin = fakeAdmin({failNextKey: new PaymentsError('Request timed out')});
  const {keys} = setup(admin);

  await assert.rejects(keys.ensure(), /timed out/);
  admin.state.failNextKey = undefined;
  await assert.rejects(keys.ensure(), /unknown outcome/);

  assert.equal(keyCalls(admin).length, 1);
});

test('a key write that was refused can be tried again', async () => {
  const admin = fakeAdmin({failNextKey: new PaymentsError('Forbidden', {status: 403})});
  const {keys} = setup(admin);

  await assert.rejects(keys.ensure(), /Forbidden/);
  admin.state.failNextKey = undefined;

  assert.equal((await keys.ensure()).created, true);
});

test('a masked token is refused and nothing is written', async () => {
  const admin = fakeAdmin();
  const {keys, tokenPath} = setup({
    ...admin,
    request: async (path, body, options) => (path === '/api-key' && !options?.method ? {id: 'key-1', token: '*****'} : admin.request(path, body, options)),
  });

  await assert.rejects(keys.ensure(), /not revealed/);

  assert.equal(existsSync(tokenPath), false);
});

test('a top-up brings the credit back to the run limit', async () => {
  const admin = fakeAdmin({remaining: '300000'});
  const {keys} = setup(admin);
  await keys.ensure();

  const result = await keys.topUp();

  const patch = admin.calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(patch.body, {id: 'key-1', UsageCreditsToAddOrRemove: [{unit: USDM_UNIT, amount: '500000'}]});
  assert.equal(admin.state.remaining, RUN_LIMIT);
  assert.deepEqual(result, {before: '300000', after: RUN_LIMIT});
});

test('a key that is already full is left alone', async () => {
  const admin = fakeAdmin();
  const {keys} = setup(admin);
  await keys.ensure();

  await keys.topUp();

  assert.equal(admin.calls.some((call) => call.method === 'PATCH'), false);
});

test('a key with credit above the limit is brought down to it', async () => {
  const admin = fakeAdmin({remaining: '900000'});
  const {keys} = setup(admin);
  await keys.ensure();

  await keys.topUp();

  assert.equal(admin.state.remaining, RUN_LIMIT);
});

test('a top-up without a key says so', async () => {
  const {keys} = setup();

  await assert.rejects(keys.topUp(), /no buyer key/i);
});
