import { describe, expect, it } from 'vitest';

import {
  resolveBsGroup, resolveIsGroup, BS_GROUPS, IS_GROUPS, isBsGroup, isIsGroup,
} from '../src/modules/ledger/ledger-statement-sections';

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
