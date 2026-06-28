// money.ts — currency / minor-unit awareness + rounding helpers.
//
// ISO-4217 minor units: each currency settles to a fixed number of decimal
// places ("minor units"). THB/USD/EUR/GBP/SGD use 2 decimals; JPY uses 0
// (no sub-yen). When persisting money to the numeric(precision, scale) columns
// (stored as STRINGS in Drizzle) always round to the currency's minor unit,
// not a blanket 2dp, or zero-decimal currencies (JPY) drift.

export interface Currency {
  code: string; // ISO-4217 alpha
  decimals: number; // minor-unit exponent (number of decimal places)
  symbol: string;
  label: string;
}

// Supported settlement currencies. Extend as the registry grows.
export const CURRENCIES: Currency[] = [
  { code: 'THB', decimals: 2, symbol: '฿', label: 'Thai Baht' },
  { code: 'USD', decimals: 2, symbol: '$', label: 'US Dollar' },
  { code: 'EUR', decimals: 2, symbol: '€', label: 'Euro' },
  { code: 'JPY', decimals: 0, symbol: '¥', label: 'Japanese Yen' },
  { code: 'GBP', decimals: 2, symbol: '£', label: 'Pound Sterling' },
  { code: 'SGD', decimals: 2, symbol: 'S$', label: 'Singapore Dollar' },
  { code: 'MYR', decimals: 2, symbol: 'RM', label: 'Malaysian Ringgit' },
];

const CURRENCY_BY_CODE = new Map<string, Currency>(CURRENCIES.map((c) => [c.code, c]));

export function getCurrency(code = 'THB'): Currency {
  return CURRENCY_BY_CODE.get((code || 'THB').toUpperCase()) ?? CURRENCIES[0];
}

export function isSupportedCurrency(code: string): boolean {
  return CURRENCY_BY_CODE.has((code || '').toUpperCase());
}

// Round to the currency's minor unit (e.g. JPY → 0dp, THB → 2dp). Epsilon-corrected so
// half-cent inputs round consistently. THE single canonical money-rounding policy.
export function roundCurrency(amount: number, currency = 'THB'): number {
  const { decimals } = getCurrency(currency);
  const f = Math.pow(10, decimals);
  return Math.round(((Number(amount) || 0) + Number.EPSILON) * f) / f;
}

// THB-default 2dp settlement round — thin alias of roundCurrency so every money path
// (POS/finance/payments) shares ONE rounding policy. round2(1.239) === 1.24.
export const round2 = (amount: number): number => roundCurrency(amount, 'THB');

// money(amount, currency) — value snapshot for an amount in a given currency.
// `text` is a display string; `minor` is the integer amount in minor units
// (smallest indivisible unit) for safe transport/comparison.
export function money(amount: number, currency = 'THB') {
  const cur = getCurrency(currency);
  const value = roundCurrency(amount, cur.code);
  const minor = Math.round(value * Math.pow(10, cur.decimals));
  return {
    amount: value,
    currency: cur.code,
    decimals: cur.decimals,
    symbol: cur.symbol,
    minor,
    text: `${cur.symbol}${value.toFixed(cur.decimals)}`,
  };
}
