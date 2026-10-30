import {REGISTRY_POLICY} from '../shared/constants.mjs';

// The two Preprod registries Masumi has had, each with its own escrow contract. An agent's identifier
// starts with its registry's policy, so the identifier says which contract would have to pay it.
// isConnected says our Payment Service runs that contract, so only those agents can be paid from here.
export const REGISTRIES = Object.freeze([
  Object.freeze({
    name: 'current',
    policy: REGISTRY_POLICY,
    contract: 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
    isConnected: true,
  }),
  Object.freeze({
    name: 'older',
    policy: '7e8bdaf2b2b919a3a4b94002cafb50086c0c845fe535d07a77ab7f77',
    contract: 'addr_test1wz7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsqukgwfm',
    isConnected: false,
  }),
]);

export const registryOf = (agentIdentifier) => REGISTRIES.find(({policy}) => agentIdentifier.startsWith(policy)) ?? null;
