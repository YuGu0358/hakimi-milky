import {mapLimited} from '../shared/map-limited.mjs';
import {listingFromAsset} from './listing.mjs';

const CONCURRENCY = 4;

async function listingOf(get, agentIdentifier) {
  try {
    const {onchain_metadata: metadata, quantity} = await get(`/assets/${agentIdentifier}`);
    return quantity === '0' ? null : listingFromAsset(agentIdentifier, metadata);
  } catch (error) {
    if (error.kind === 'not-found') return null;
    throw error;
  }
}

// What a run needs: exactly the agents on its mandate, however long ago they registered. Nobody else is read.
export async function readPins({get, agentIdentifiers}) {
  const listings = await mapLimited([...new Set(agentIdentifiers)], CONCURRENCY, (id) => listingOf(get, id));
  return listings.filter(Boolean);
}
