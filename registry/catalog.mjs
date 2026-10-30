import {mapLimited} from '../shared/map-limited.mjs';
import {joined, listingFromAsset} from './listing.mjs';
import {REGISTRIES, registryOf} from './sources.mjs';

// A full read of both registries, for an owner choosing whom to put on a mandate. A run never uses
// it: a run reads only the agents on its mandate. Everything here comes from the chain, and no
// address a stranger registered is ever called.

const PAGE_SIZE = 100;
const MAX_PAGES = 200; // far above today's registries, to stop on a server that never ends
const METADATA_CONCURRENCY = 8;

const NOT_PUBLIC_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.test|.*\.invalid|(.*\.)?example\.(com|org|net)|0\..*|127\..*|10\..*|192\.168\..*|172\.(1[6-9]|2\d|3[01])\..*|169\.254\..*|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\..*|198\.(18|19)\..*|2[2-5]\d\.\d+\.\d+\.\d+|\[.*\])$/i;

// Judged by the text alone, so it says nothing about where a name resolves.
export function isPublicAddress(url) {
  if (!URL.canParse(url)) return false;
  const {protocol, hostname} = new URL(url);
  return (protocol === 'https:' || protocol === 'http:') && !NOT_PUBLIC_HOST.test(hostname.replace(/\.$/, ''));
}

function olderPrice(metadata) {
  const {pricingType, fixedPricing} = metadata?.agentPricing ?? {};
  const [first] = fixedPricing ?? [];
  const price = pricingType === 'Fixed' && first ? {unit: joined(first.unit), amount: String(first.amount)} : null;
  return {pricingType: joined(pricingType) || null, price};
}

const hasCurrentShape = (metadata) => Array.isArray(metadata?.supported_payment_sources);

function whyNotHireable(registry, listing, metadata, facts) {
  if (!metadata) return 'no metadata on chain';
  if (registry && !registry.isConnected) return `pays through contract ${registry.contract}, which our Payment Service does not run`;
  if (!listing) return 'an old format, another network or no usable address';
  if (facts.pricingType !== 'Fixed') return 'no fixed price';
  if (!isPublicAddress(facts.apiBaseUrl)) return 'no public address';
  return null;
}

export function describeAgent(agentIdentifier, metadata) {
  const registry = registryOf(agentIdentifier);
  const listing = listingFromAsset(agentIdentifier, metadata);
  const facts = {
    agentIdentifier,
    registry: registry?.name ?? 'unknown',
    name: joined(metadata?.name),
    apiBaseUrl: joined(metadata?.api_base_url),
    ...(hasCurrentShape(metadata) ? {pricingType: listing?.pricingType ?? null, price: listing?.price ?? null} : olderPrice(metadata)),
  };
  const why = whyNotHireable(registry, listing, metadata, facts);
  return {...facts, hireableHere: why === null, ...(why ? {why} : {})};
}

async function livingAssets(get, {policy}) {
  const assets = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const items = await get(`/assets/policy/${policy}?count=${PAGE_SIZE}&page=${page}`);
    assets.push(...items);
    if (items.length < PAGE_SIZE) return assets;
  }
  throw new Error(`Registry ${policy} still has more after ${MAX_PAGES} pages`);
}

const summaryOf = (registry, minted, entries) => ({
  name: registry.name,
  policy: registry.policy,
  contract: registry.contract,
  isConnected: registry.isConnected,
  minted,
  live: entries.length,
  fixedPrice: entries.filter(({pricingType}) => pricingType === 'Fixed').length,
  fixedPriceAndPublic: entries.filter(({pricingType, apiBaseUrl}) => pricingType === 'Fixed' && isPublicAddress(apiBaseUrl)).length,
  hireableHere: entries.filter(({hireableHere}) => hireableHere).length,
});

// `cache` holds metadata by agent and is filled as it goes, so a read cut off halfway is not lost.
// An agent's metadata is fixed when it is minted: a changed agent is a new asset.
export async function readCatalog({get, cache = new Map(), pause = async () => {}}) {
  const metadataOf = async (agentIdentifier) => {
    if (!cache.has(agentIdentifier)) {
      const {onchain_metadata: metadata} = await get(`/assets/${agentIdentifier}`);
      cache.set(agentIdentifier, metadata ?? null);
    }
    return cache.get(agentIdentifier);
  };
  const summary = [];
  const entries = [];
  for (const registry of REGISTRIES) {
    const assets = await livingAssets(get, registry);
    const live = assets.filter(({quantity}) => quantity !== '0').map(({asset}) => asset);
    const described = await mapLimited(live, METADATA_CONCURRENCY, async (id) => describeAgent(id, await metadataOf(id)), pause);
    summary.push(summaryOf(registry, assets.length, described));
    entries.push(...described);
  }
  return {summary, entries};
}
