import {NETWORK} from '../shared/constants.mjs';
import {Listing} from '../shared/schemas.mjs';
import {registryOf} from './sources.mjs';

const PAYMENT_SOURCE_TYPE_V2 = 'Web3CardanoV2';
const PAYMENT_SOURCE_TYPE_V1 = 'Web3CardanoV1';

// Cardano metadata strings hold at most 64 bytes, so long ones arrive as lists of chunks.
export const joined = (value) => (Array.isArray(value) ? value.join('') : value ?? '');

const isOurSource = (source) =>
  joined(source?.chain) === 'Cardano' && joined(source?.network) === NETWORK && joined(source?.settlement?.paymentSourceType) === PAYMENT_SOURCE_TYPE_V2;

function priceOf({pricingType, fixed}) {
  if (pricingType !== 'Fixed' || !fixed?.[0]) return null;
  const asset = joined(fixed[0].asset);
  return {unit: asset === 'lovelace' ? '' : asset, amount: String(fixed[0].amount)};
}

// The older registry's format: one price and no list of payment sources.
function olderListing(agentIdentifier, metadata) {
  const {pricingType, fixedPricing} = metadata.agentPricing ?? {};
  const [first] = fixedPricing ?? [];
  const parsed = Listing.safeParse({
    agentIdentifier,
    name: joined(metadata.name),
    apiBaseUrl: joined(metadata.api_base_url),
    pricingType: joined(pricingType),
    price: joined(pricingType) === 'Fixed' && first ? {unit: joined(first.unit), amount: String(first.amount)} : null,
    paymentSourceType: PAYMENT_SOURCE_TYPE_V1,
    tags: (metadata.tags ?? []).map(joined),
  });
  return parsed.success ? parsed.data : null;
}

// Null for anything we cannot hire: an old format, another network, no address to call.
export function listingFromAsset(agentIdentifier, metadata) {
  if (metadata && registryOf(agentIdentifier)?.paymentSourceType === PAYMENT_SOURCE_TYPE_V1) return olderListing(agentIdentifier, metadata);
  const sources = metadata?.supported_payment_sources;
  if (!Array.isArray(sources)) return null;
  const index = sources.findIndex(isOurSource);
  if (index < 0) return null;
  const {pricing = {}} = sources[index];
  const parsed = Listing.safeParse({
    agentIdentifier,
    name: joined(metadata.name),
    apiBaseUrl: joined(metadata.api_base_url),
    pricingType: pricing.pricingType,
    price: priceOf(pricing),
    supportedPaymentSourceIndex: index,
    tags: (metadata.tags ?? []).map(joined),
  });
  return parsed.success ? parsed.data : null;
}
