// Exact scale-4 minor-unit money arithmetic (docs/27 R1-4 / AUD-ARC-04).
// Postgres `numeric` columns arrive in JS as STRINGS; summing/comparing them through floats and then
// testing `roundedA === roundedB` is not a ledger-grade invariant — two independently accumulated float
// sums can round to different 4-dp values (order-dependent ulp drift, half-way boundaries, large
// magnitudes beyond 2^53 minor units). These helpers parse to bigint minor units (1 unit = 0.0001):
// numeric strings parse EXACTLY (no float hop, round-half-up at scale 4 — matching pg numeric rounding);
// JS-computed numbers are already floats, so they are clamped once via Math.round(v·10⁴) and then all
// accumulation/comparison is exact integer math.
export function toMinor4(v: unknown): bigint {
  if (v == null) return 0n;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 0n;
    return BigInt(Math.round(v * 10000));
  }
  const s = String(v).trim();
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) {
    const f = Number(s); // scientific notation etc. — fall back through the float clamp
    return Number.isFinite(f) ? BigInt(Math.round(f * 10000)) : 0n;
  }
  const sign = m[1], int = m[2], fracRaw = m[3] ?? '';
  const frac = (fracRaw + '0000').slice(0, 4);
  // round half-up (away from zero) at scale 4 — same as pg numeric's round()
  const roundUp = fracRaw.length > 4 && fracRaw.charCodeAt(4) >= 53 /* '5' */ ? 1n : 0n;
  const minor = BigInt(int!) * 10000n + BigInt(frac) + roundUp;
  return sign === '-' ? -minor : minor;
}

// Back to a display number (4-dp value). Only for OUTPUT — never feed the result back into arithmetic.
export const minorToNumber4 = (m: bigint): number => Number(m) / 10000;

// Exact money equality at scale 4 across any mix of numeric strings and JS numbers.
export const eqMoney4 = (a: unknown, b: unknown): boolean => toMinor4(a) === toMinor4(b);
