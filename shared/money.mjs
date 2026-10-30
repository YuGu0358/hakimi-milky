import {ADA_UNIT, USDM_UNIT} from './constants.mjs';

const SYMBOLS = Object.freeze({[USDM_UNIT]: 'tUSDM', [ADA_UNIT]: 'ADA'});
const ATOMIC_PER_WHOLE = 1_000_000; // tUSDM and ADA both have six decimals

// Readable prices for models and logs. Budgets and payments always use the atomic strings.
export function formatPrice({unit, amount}) {
  const symbol = SYMBOLS[unit];
  return symbol === undefined ? `${amount} of ${unit}` : `${Number(amount) / ATOMIC_PER_WHOLE} ${symbol}`;
}
