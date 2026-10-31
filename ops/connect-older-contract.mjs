import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {OLDER_TOKEN_PATH} from '../payments/buyer-key.mjs';
import {NETWORK, USDM_UNIT} from '../shared/constants.mjs';

// npm run registry:connect-older
// Connects the older escrow contract to our local Payment Service, using the values the service seeds for
// it, with the same two wallets. It also makes a separate key that can spend very little from it.
// Nothing leaves this machine except the service's own reads of the chain. It never prints a mnemonic.

const OLDER = Object.freeze({
  contract: 'addr_test1wz7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsqukgwfm',
  adminWallets: [
    'addr_test1qr7pdg0u7vy6a5p7cx9my9m0t63f4n48pwmez30t4laguawge7xugp6m5qgr6nnp6wazurtagjva8l9fc3a5a4scx0rq2ymhl3',
    'addr_test1qplhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhmsuycl5a',
    'addr_test1qzy7a702snswullyjg06j04jsulldc6yw0m4r4w49jm44f30pgqg0ez34lrdj7dy7ndp2lgv8e35e6jzazun8gekdlsq99mm6w',
  ],
  feeWallet: 'addr_test1qqfuahzn3rpnlah2ctcdjxdfl4230ygdar00qxc32guetexyg7nun6hggw9g2gpnayzf22sksr0aqdgkdcvqpc2stwtqt4u496',
  feeRatePermille: 50,
  cooldownTime: 7 * 60_000,
});
const KEY_CREDIT = '100000'; // 0.1 tUSDM

const need = (name) => {
  if (!process.env[name]) throw new Error(`Set ${name}`);
  return process.env[name];
};

async function main() {
  const base = `${need('MPS_URL').replace(/\/$/, '')}/api/v1`;
  const headers = {'content-type': 'application/json', token: need('ADMIN_KEY')};
  const call = async (path, init = {}) => {
    const response = await fetch(`${base}${path}`, {headers, redirect: 'error', signal: AbortSignal.timeout(120_000), ...init});
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Payment Service ${path} answered HTTP ${response.status}: ${body?.error?.message ?? 'no message'}`);
    return body.data;
  };
  const post = (path, body) => call(path, {method: 'POST', body: JSON.stringify(body)});

  const {PaymentSources: sources} = await call('/payment-source?take=100');
  const onNetwork = sources.filter(({network}) => network === NETWORK);
  const current = onNetwork.find(({paymentSourceType}) => paymentSourceType === 'Web3CardanoV2');
  if (!current) throw new Error('The current contract is not connected');

  const mnemonicOf = async (walletType) => {
    const {Wallets: wallets} = await call(`/wallet/list?walletType=${walletType}&paymentSourceId=${encodeURIComponent(current.id)}`);
    if (wallets.length !== 1) throw new Error(`Expected one ${walletType} wallet, found ${wallets.length}`);
    const {Secret: secret} = await call(`/wallet?walletType=${walletType}&id=${encodeURIComponent(wallets[0].id)}&includeSecret=true`);
    return secret.mnemonic;
  };

  let older = onNetwork.find(({smartContractAddress}) => smartContractAddress === OLDER.contract);
  if (!older) {
    older = await post('/payment-source-extended', {
      network: NETWORK,
      paymentSourceType: 'Web3CardanoV1',
      PaymentSourceConfig: {rpcProviderApiKey: need('BLOCKFROST_API_KEY_PREPROD'), rpcProvider: 'Blockfrost'},
      feeRatePermille: OLDER.feeRatePermille,
      cooldownTime: OLDER.cooldownTime,
      AdminWallets: OLDER.adminWallets.map((walletAddress) => ({walletAddress})),
      FeeReceiverNetworkWallet: {walletAddress: OLDER.feeWallet},
      PurchasingWallets: [{walletMnemonic: await mnemonicOf('Purchasing'), collectionAddress: null, note: 'older contract, same buyer wallet'}],
      SellingWallets: [{walletMnemonic: await mnemonicOf('Selling'), collectionAddress: null, note: 'older contract, same seller wallet'}],
    });
    if (older.smartContractAddress !== OLDER.contract) {
      throw new Error(`The service derived ${older.smartContractAddress}, not the older contract. Remove that source.`);
    }
  }
  console.log(`Older contract connected: ${older.smartContractAddress}`);

  const {Wallets: buyers} = await call(`/wallet/list?walletType=Purchasing&paymentSourceId=${encodeURIComponent(older.id)}`);
  const key = await post('/api-key', {
    usageLimited: 'true',
    UsageCredits: [{unit: USDM_UNIT, amount: KEY_CREDIT}],
    NetworkLimit: [NETWORK],
    ChainIdLimit: [],
    canRead: true,
    canPay: true,
    canAdmin: false,
    walletScopeEnabled: true,
    WalletScopeHotWalletIds: [buyers[0].id],
    x402WalletScopeEnabled: true,
    X402WalletScopeEvmWalletIds: [],
  });
  mkdirSync(dirname(OLDER_TOKEN_PATH), {recursive: true, mode: 0o700});
  writeFileSync(OLDER_TOKEN_PATH, `MPS_RUNTIME_TOKEN=${key.token}\n`, {mode: 0o600});
  console.log(`A key with ${KEY_CREDIT} units of credit is saved in ${OLDER_TOKEN_PATH}`);
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
