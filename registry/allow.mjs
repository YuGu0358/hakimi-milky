import {decodeBech32} from '../shared/bech32.mjs';
import {AllowlistEntry} from '../shared/schemas.mjs';
import {isPublicAddress} from './catalog.mjs';
import {listingFromAsset} from './listing.mjs';
import {registryOf} from './sources.mjs';

// An owner puts an agent on the list by name, however long ago it registered. Nothing is added on its
// own: the planner still sees only the list, and the guard and the key's limits still apply.

const ALIAS = /^[A-Za-z0-9 ._-]{1,40}$/;
const SCRIPT_ADDRESS_BIT = 0x10;
const KEY_HASH_BYTES = 28;

// The payment key in a Cardano address, the same way the Payment Service reads it. A script has no key.
export function paymentKeyOf(address) {
  const {bytes} = decodeBech32(address);
  if (bytes.length <= KEY_HASH_BYTES || bytes[0] & SCRIPT_ADDRESS_BIT) return null;
  return bytes.subarray(1, 1 + KEY_HASH_BYTES).toString('hex');
}

const refuse = (code, reason) => ({refused: code, reason});

const isHttps = (url) => URL.canParse(url) && new URL(url).protocol === 'https:';

function refusalOf({agentIdentifier, quantity, metadata, alias, shareTable, limits}) {
  if (!shareTable) return refuse('table_not_shared', 'The owner\'s table goes to this agent before any payment, so this needs --share-table');
  if (!ALIAS.test(alias)) return refuse('bad_name', 'A name is 1 to 40 letters, digits, spaces, dots, dashes or underscores');
  const registry = registryOf(agentIdentifier);
  if (!registry) return refuse('unknown_registry', 'This identifier is in neither registry');
  if (!registry.isConnected) return refuse('in_older_registry', `It pays through contract ${registry.contract}, which our Payment Service does not run`);
  if (quantity === '0' || !metadata) return refuse('not_live', 'This agent was burned or has no metadata');
  const listing = listingFromAsset(agentIdentifier, metadata);
  if (!listing) return refuse('cannot_read', 'An old format, another network or no usable address');
  if (!listing.price) return refuse('not_fixed_price', 'Only a fixed price can be checked before any data leaves');
  const {unit} = listing.price;
  const cap = Object.hasOwn(limits.perHire, unit) ? limits.perHire[unit] : null;
  if (!cap) return refuse('wrong_currency', 'Its price is in a unit the budget does not hold');
  if (BigInt(listing.price.amount) > BigInt(cap)) return refuse('over_price', 'Its price is above the limit for one hire');
  if (!isHttps(listing.apiBaseUrl) || !isPublicAddress(listing.apiBaseUrl)) return refuse('not_public', 'Its address is not a public https address');
  return null;
}

// Decides from what the chain says. It calls nothing a stranger registered.
export function checkAdmission(request) {
  const refusal = refusalOf(request);
  if (refusal) return refusal;
  const {agentIdentifier, metadata, holderAddress, role, alias} = request;
  let sellerVkey;
  try {
    sellerVkey = paymentKeyOf(holderAddress);
  } catch {
    return refuse('bad_holder', 'The address holding this agent cannot be read');
  }
  if (!sellerVkey) return refuse('script_holder', 'A script holds this agent, so it has no seller key to pin');
  const {apiBaseUrl} = listingFromAsset(agentIdentifier, metadata);
  const entry = AllowlistEntry.safeParse({agentIdentifier, sellerVkey, name: alias, apiBaseUrl, role});
  return entry.success ? {entry: entry.data} : refuse('bad_entry', 'This does not make a valid list entry');
}

// The list a run uses. Our own registered agents win over a pin of the same id.
export function mergedAllowlist(own, pins) {
  const known = new Set(own.map(({agentIdentifier}) => agentIdentifier));
  return [...own, ...AllowlistEntry.array().parse(pins).filter(({agentIdentifier}) => !known.has(agentIdentifier))];
}
