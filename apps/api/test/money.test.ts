import { describe, it, expect } from 'vitest';
import { toMinor4, minorToNumber4, eqMoney4 } from '../src/common/money';

// Exact scale-4 money arithmetic (docs/27 R1-4 / AUD-ARC-04). The ledger's balanced checks compare
// bigint minor units, never independently-rounded float sums.
describe('money — toMinor4 string parsing (no float hop)', () => {
  it('parses pg numeric strings exactly', () => {
    expect(toMinor4('0.1')).toBe(1000n);
    expect(toMinor4('10')).toBe(100000n);
    expect(toMinor4('10.0000')).toBe(100000n);
    expect(toMinor4('-5.5')).toBe(-55000n);
    expect(toMinor4('0')).toBe(0n);
    expect(toMinor4(null)).toBe(0n);
  });
  it('is exact beyond float precision (2^53 minor units)', () => {
    // 123456789012.3456 has no exact float representation at scale 4 — the string path must not care.
    expect(toMinor4('123456789012.3456')).toBe(1234567890123456n);
    expect(toMinor4('9007199254740993.0001')).toBe(90071992547409930001n);
  });
  it('rounds half-up at scale 4 like pg numeric', () => {
    expect(toMinor4('0.00005')).toBe(1n);
    expect(toMinor4('0.00004')).toBe(0n);
    expect(toMinor4('1.23455')).toBe(12346n);
  });
});

describe('money — the float-equality failure the ledger had', () => {
  it('string accumulation is exact where float accumulation drifts', () => {
    // classic: 0.1 + 0.2 !== 0.3 in floats; in minor units it is exact.
    expect(0.1 + 0.2 === 0.3).toBe(false); // the latent bug's raw ingredient
    expect(toMinor4('0.1') + toMinor4('0.2')).toBe(toMinor4('0.3'));
  });
  it('bigint sums are order-independent (float sums are not, at scale)', () => {
    const values = ['0.0001', '99999999.9999', '0.0002', '-99999999.9999'];
    const fwd = values.reduce((a, v) => a + toMinor4(v), 0n);
    const rev = [...values].reverse().reduce((a, v) => a + toMinor4(v), 0n);
    expect(fwd).toBe(rev);
    expect(fwd).toBe(3n); // 0.0003
  });
  it('number inputs are clamped once, then compared exactly', () => {
    expect(eqMoney4(0.1 + 0.2, '0.3')).toBe(true);
    expect(eqMoney4(10, '10.0000')).toBe(true);
    expect(eqMoney4('10.0001', 10)).toBe(false);
  });
});

describe('money — minorToNumber4 output', () => {
  it('round-trips display values', () => {
    expect(minorToNumber4(12346n)).toBe(1.2346);
    expect(minorToNumber4(-55000n)).toBe(-5.5);
    expect(minorToNumber4(0n)).toBe(0);
  });
});
