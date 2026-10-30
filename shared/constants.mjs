// Cardano Preprod values. The USDM unit matches frontdesk/paid-task.mjs.
export const NETWORK = 'Preprod';
export const PAYMENT_SOURCE_TYPE = 'Web3CardanoV2';
export const USDM_UNIT = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
export const ADA_UNIT = '';
export const ESCROW_CONTRACT = 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g';
export const REGISTRY_POLICY = '67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b';

export const MINUTE_MS = 60_000;

// Offsets from start_job for specialist quotes. They satisfy the Payment Service floors:
// submit >= now + 15 min, payBy <= submit - 5 min, unlock >= submit + 15 min, dispute >= unlock + 15 min.
export const SPECIALIST_WINDOW_MINUTES = Object.freeze({payBy: 8, submit: 17, unlock: 32, dispute: 47});

// The starter's seller API rejects longer prompts.
export const MAX_PROMPT_CHARS = 16_000;
