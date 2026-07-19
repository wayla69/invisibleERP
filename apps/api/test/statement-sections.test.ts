import { describe, expect, it } from 'vitest';

import {
  resolveBsGroup, resolveIsGroup, BS_GROUPS, IS_GROUPS, isBsGroup, isIsGroup, coaSortOrder,
} from '../src/modules/ledger/ledger-statement-sections';
import { COA } from '../src/modules/ledger/ledger-constants';

// 0438 — statement-section binding. Each account resolves to a งบดุล / งบกำไรขาดทุน section by:
// its OWN column (bs_group / is_group) → a canonical default map → a type-based fallback. This locks that
// precedence so a re-bind from the Chart-of-Accounts dialog always wins, and unmapped accounts still land
// in a sensible section.
describe('statement-section resolution (0438)', () => {
  it('falls back by type + is_current when no column and no default', () => {
    expect(resolveBsGroup({ code: '9000', type: 'Asset' })).toBe('current_asset');
    expect(resolveBsGroup({ code: '9000', type: 'Asset', isCurrent: false })).toBe('noncurrent_asset');
    expect(resolveBsGroup({ code: '9000', type: 'Liability' })).toBe('current_liability');
    expect(resolveBsGroup({ code: '9000', type: 'Liability', isCurrent: false })).toBe('noncurrent_liability');
    expect(resolveBsGroup({ code: '9000', type: 'Equity' })).toBe('equity');
    expect(resolveBsGroup({ code: '9000', type: 'Revenue' })).toBeNull();
  });

  it('uses the canonical default map for known codes', () => {
    expect(resolveBsGroup({ code: '1500', type: 'Asset' })).toBe('noncurrent_asset'); // PP&E
    expect(resolveBsGroup({ code: '2550', type: 'Liability' })).toBe('noncurrent_liability'); // long-term borrowings
    expect(resolveIsGroup({ code: '5000', type: 'Expense' })).toBe('cogs');
    expect(resolveIsGroup({ code: '5900', type: 'Expense' })).toBe('finance_cost');
    expect(resolveIsGroup({ code: '5960', type: 'Expense' })).toBe('tax');
    expect(resolveIsGroup({ code: '4800', type: 'Revenue' })).toBe('other_income');
  });

  it('falls back to revenue / selling_admin for unmapped P&L accounts', () => {
    expect(resolveIsGroup({ code: '9500', type: 'Revenue' })).toBe('revenue');
    expect(resolveIsGroup({ code: '9500', type: 'Expense' })).toBe('selling_admin');
    expect(resolveIsGroup({ code: '9500', type: 'Asset' })).toBeNull();
  });

  it("the account's OWN column overrides both the default map and the fallback (a re-bind wins)", () => {
    // 5000 defaults to cogs; an explicit is_group of selling_admin must win.
    expect(resolveIsGroup({ code: '5000', type: 'Expense', isGroup: 'selling_admin' })).toBe('selling_admin');
    // 1000 defaults to current_asset; an explicit noncurrent_asset must win.
    expect(resolveBsGroup({ code: '1000', type: 'Asset', bsGroup: 'noncurrent_asset' })).toBe('noncurrent_asset');
    // A garbage column value is ignored (falls through to default/fallback).
    expect(resolveIsGroup({ code: '5000', type: 'Expense', isGroup: 'nonsense' })).toBe('cogs');
  });

  it('exposes the section vocabularies + type guards', () => {
    expect(BS_GROUPS).toContain('current_asset');
    expect(IS_GROUPS).toContain('finance_cost');
    expect(isBsGroup('equity')).toBe(true);
    expect(isBsGroup('revenue')).toBe(false);
    expect(isIsGroup('tax')).toBe(true);
    expect(isIsGroup('equity')).toBe(false);
  });
});

// P2 — whole-chart classification audit + metadata-driven ordering. Locks that EVERY canonical account
// lands on exactly one statement (balance sheet XOR income statement, by type) with a resolved section, and
// that the display order groups by class regardless of the organically-grown natural codes.
describe('canonical CoA classification + ordering audit (P2)', () => {
  it('has no duplicate account codes', () => {
    const codes = COA.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every account resolves to exactly one statement section for its type', () => {
    const unplaced: string[] = [];
    const doublePlaced: string[] = [];
    for (const a of COA) {
      const bs = resolveBsGroup(a);
      const is = resolveIsGroup(a);
      const onBs = bs != null;
      const onIs = is != null;
      // Balance-sheet accounts (Asset/Liability/Equity) → a bs_group and never an is_group; P&L accounts
      // (Revenue/Expense) → an is_group and never a bs_group. Anything on both or neither is a mis-tag.
      if (onBs === onIs) (onBs ? doublePlaced : unplaced).push(`${a.code} ${a.name} [${a.type}]`);
    }
    expect(unplaced, `unplaced accounts: ${unplaced.join(', ')}`).toEqual([]);
    expect(doublePlaced, `double-placed accounts: ${doublePlaced.join(', ')}`).toEqual([]);
  });

  it('places the known tricky accounts in the right section', () => {
    const g = (code: string) => { const a = COA.find((x) => x.code === code)!; return resolveBsGroup(a) ?? resolveIsGroup(a); };
    expect(g('1510')).toBe('other_income');   // gain/loss on disposal — 1xxx code but a P&L (type Revenue)
    expect(g('4620')).toBe('other_income');   // finance-lease interest income (post-4600-split)
    expect(g('5000')).toBe('cogs');
    expect(g('5900')).toBe('finance_cost');
    expect(g('5960')).toBe('tax');
    expect(g('1500')).toBe('noncurrent_asset');
    expect(g('2600')).toBe('noncurrent_liability');
    expect(g('3000')).toBe('equity');
    expect(g('4000')).toBe('revenue');
  });

  it('orders the chart by class → section → code, not by raw code', () => {
    const sorted = [...COA].sort((a, b) => coaSortOrder(a) - coaSortOrder(b));
    const rank: Record<string, number> = { Asset: 1, Liability: 2, Equity: 3, Revenue: 4, Expense: 5 };
    // classes never interleave once sorted
    let prev = 0;
    for (const a of sorted) { expect(rank[a.type]).toBeGreaterThanOrEqual(prev); prev = rank[a.type]; }
    // the 1xxx-coded P&L account sorts among Revenue, AFTER 4000 — i.e. its ugly code no longer misplaces it
    const idx = (code: string) => sorted.findIndex((a) => a.code === code);
    expect(idx('1510')).toBeGreaterThan(idx('4000'));
    // a fixed asset (non-current) sorts after a current asset despite both being 1xxx
    expect(idx('1500')).toBeGreaterThan(idx('1000'));
  });
});
