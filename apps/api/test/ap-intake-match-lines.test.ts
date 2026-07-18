import { describe, expect, it } from 'vitest';

import { mapVisionLinesToPo } from '../src/modules/ap-intake/ap-intake.match-lines';

// EXP-10 line-level escalation mapper: all-or-nothing, identity by normalized-description equality or
// item_id-as-token — anything ambiguous falls the whole set back to the header-level match.

const PO = [
  { item_id: 'RICE5', item_description: 'ข้าวหอมมะลิ 5 กก.' },
  { item_id: 'OIL1', item_description: 'น้ำมันพืช 1 ลิตร' },
  { item_id: 'X', item_description: 'Widget X' },
];

describe('mapVisionLinesToPo', () => {
  it('maps by normalized description equality (Thai, punctuation-insensitive)', () => {
    const r = mapVisionLinesToPo([
      { description: 'ข้าวหอมมะลิ 5 กก', qty: 10, unit_price: 250, amount: 2500 },
      { description: 'น้ำมันพืช (1 ลิตร)', qty: 24, unit_price: 55, amount: 1320 },
    ], PO);
    expect(r).toEqual([
      { item_id: 'RICE5', qty: 10, unit_price: 250 },
      { item_id: 'OIL1', qty: 24, unit_price: 55 },
    ]);
  });

  it('maps by item_id appearing as a whole token in the description', () => {
    const r = mapVisionLinesToPo([{ description: 'Part RICE5 (restock)', qty: 2, unit_price: 250, amount: 500 }], PO);
    expect(r).toEqual([{ item_id: 'RICE5', qty: 2, unit_price: 250 }]);
  });

  it('ALL-or-nothing: one unidentified line rejects the whole set', () => {
    const r = mapVisionLinesToPo([
      { description: 'ข้าวหอมมะลิ 5 กก', qty: 10, unit_price: 250, amount: 2500 },
      { description: 'mystery delivery fee', qty: 1, unit_price: 100, amount: 100 },
    ], PO);
    expect(r).toBeUndefined();
  });

  it('rejects an ambiguous line (matches several PO lines) and double-claims of one PO line', () => {
    const ambiguous = mapVisionLinesToPo([{ description: 'RICE5 or OIL1 assortment', qty: 1, unit_price: 10, amount: 10 }], PO);
    expect(ambiguous).toBeUndefined();
    const doubleClaim = mapVisionLinesToPo([
      { description: 'Widget X', qty: 1, unit_price: 5, amount: 5 },
      { description: 'widget x', qty: 2, unit_price: 5, amount: 10 },
    ], PO);
    expect(doubleClaim).toBeUndefined();
  });

  it('rejects lines missing qty or unit_price, and empty inputs', () => {
    expect(mapVisionLinesToPo([{ description: 'Widget X', qty: null, unit_price: 5, amount: 5 }], PO)).toBeUndefined();
    expect(mapVisionLinesToPo([{ description: 'Widget X', qty: 1, unit_price: null, amount: 5 }], PO)).toBeUndefined();
    expect(mapVisionLinesToPo([], PO)).toBeUndefined();
    expect(mapVisionLinesToPo(null, PO)).toBeUndefined();
    expect(mapVisionLinesToPo([{ description: 'Widget X', qty: 1, unit_price: 5, amount: 5 }], [])).toBeUndefined();
  });

  it('a bare-substring is NOT identity: item_id must be a whole token', () => {
    // 'X' must not match inside 'EXTRA' — token boundaries only.
    const r = mapVisionLinesToPo([{ description: 'EXTRA charges', qty: 1, unit_price: 5, amount: 5 }], PO);
    expect(r).toBeUndefined();
  });
});
