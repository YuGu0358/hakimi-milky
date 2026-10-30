// The three specialist agents we run. They share one codebase and differ only here.
// Prices are in atomic tUSDM units: 300000 is 0.3 tUSDM.
export const PROFILES = Object.freeze({
  standard: Object.freeze({
    id: 'standard',
    name: 'Hakimi Table Normalizer',
    description: 'Cleans a supplier table: units, categories, prices and spacing. Keeps every row. Deterministic, no model.',
    role: 'normalize',
    port: 4101,
    priceAmount: '300000',
    tags: Object.freeze(['table-normalization']),
    capability: Object.freeze({name: 'deterministic-normalizer', version: '1'}),
    acceptsFault: false,
  }),
  cheap: Object.freeze({
    id: 'cheap',
    name: 'Hakimi Budget Normalizer',
    description: 'Cleans a supplier table for less. Demo agent: it can be started with a fault to show a refund.',
    role: 'normalize',
    port: 4102,
    priceAmount: '200000',
    tags: Object.freeze(['table-normalization']),
    capability: Object.freeze({name: 'deterministic-normalizer', version: '1'}),
    acceptsFault: true,
  }),
  copy: Object.freeze({
    id: 'copy',
    name: 'Hakimi Copywriter',
    description: 'Writes one short product text per SKU and checks it against the written rules before delivering.',
    role: 'copy',
    port: 4103,
    priceAmount: '200000',
    tags: Object.freeze(['product-copy']),
    capability: Object.freeze({name: 'llm-copywriter', version: '1'}),
    acceptsFault: false,
  }),
});
