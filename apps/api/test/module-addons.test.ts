import { describe, expect, it } from 'vitest';
import {
  ADDONS, ADDON_GRANTS, ADDON_KEYS, AI_ADDON_FEATURES, PLAN_SUITES, SUITES,
  applyAiAddonFeatures, isAddonKey, resolveEntitledSuites, validateEntitlements,
} from '@ierp/shared';

// Per-module add-ons (2026-07-21): the planning/marketing suite split + the four new sellable modules
// (planning / marketing / crm_loyalty / ai) and the AI add-on's token-band overlay.

describe('planning/marketing suite split', () => {
  it('planner and marketing live in separate suites; the invariant still holds', () => {
    expect(SUITES.planning).toEqual(['planner']);
    expect(SUITES.marketing).toEqual(['marketing']);
    expect(() => validateEntitlements()).not.toThrow();
  });

  it('every plan that had the combined suite is grandfathered with BOTH', () => {
    for (const plan of ['sme', 'pro', 'franchise', 'enterprise', 'erp_growth']) {
      expect(PLAN_SUITES[plan], plan).toContain('planning');
      expect(PLAN_SUITES[plan], plan).toContain('marketing');
    }
    // Plans that never had planning gained nothing.
    expect(PLAN_SUITES.starter).not.toContain('marketing');
    expect(PLAN_SUITES.business).not.toContain('planning');
  });
});

describe('per-module add-on catalog', () => {
  it('the four module add-ons exist at the agreed prices and grant exactly their suite', () => {
    expect(ADDONS.planning.priceMonthly).toBe(1900);
    expect(ADDONS.marketing.priceMonthly).toBe(1290);
    expect(ADDONS.crm_loyalty.priceMonthly).toBe(1490);
    expect(ADDONS.ai.priceMonthly).toBe(1990);
    expect(ADDON_GRANTS.planning).toEqual(['planning']);
    expect(ADDON_GRANTS.marketing).toEqual(['marketing']);
    expect(ADDON_GRANTS.crm_loyalty).toEqual(['crm_loyalty']);
    expect(ADDON_GRANTS.ai).toEqual(['ai']);
    for (const k of ADDON_KEYS) expect(isAddonKey(k)).toBe(true);
  });

  it('module-add-on sum exceeds the Business→Professional step (bundle stays the better deal at 3+)', () => {
    const sum = ADDONS.planning.priceMonthly + ADDONS.marketing.priceMonthly + ADDONS.crm_loyalty.priceMonthly + ADDONS.ai.priceMonthly;
    expect(sum).toBe(6670);
    expect(sum).toBeGreaterThan(9900 - 4900);
  });

  it('a purchased module add-on unions its suite into the entitlement resolution', () => {
    const suites = resolveEntitledSuites('starter', undefined, ['planning', 'crm_loyalty']);
    expect(suites).toContain('planning');
    expect(suites).toContain('crm_loyalty');
    expect(suites).not.toContain('marketing');
  });
});

describe('applyAiAddonFeatures (AI add-on token band)', () => {
  const bare = { ai_chat: false, ai_tokens_daily: 0, ai_tokens_daily_max: 0, ai_overage_rate_thb_per_1k: 0 };

  it('no ai add-on → untouched copy', () => {
    expect(applyAiAddonFeatures(bare, ['planning'])).toEqual(bare);
    expect(applyAiAddonFeatures(bare, undefined)).toEqual(bare);
    expect(applyAiAddonFeatures(null, null)).toEqual({});
  });

  it('with the ai add-on → ai_chat true + the Solo-tier band', () => {
    const eff = applyAiAddonFeatures(bare, ['ai']);
    expect(eff.ai_chat).toBe(true);
    expect(eff.ai_tokens_daily).toBe(AI_ADDON_FEATURES.ai_tokens_daily);
    expect(eff.ai_tokens_daily_max).toBe(AI_ADDON_FEATURES.ai_tokens_daily_max);
    expect(eff.ai_overage_rate_thb_per_1k).toBe(12);
  });

  it('only WIDENS: a bigger plan band and a priced rate win; legacy -1 unlimited is preserved', () => {
    const pro = { ai_chat: true, ai_tokens_daily: 200_000, ai_tokens_daily_max: 500_000, ai_overage_rate_thb_per_1k: 10 };
    expect(applyAiAddonFeatures(pro, ['ai'])).toEqual(pro);
    const legacy = applyAiAddonFeatures({ ai_tokens_daily: -1, ai_tokens_daily_max: -1 }, ['ai']);
    expect(legacy.ai_tokens_daily).toBe(-1);
    expect(legacy.ai_tokens_daily_max).toBe(-1);
    const nulls = applyAiAddonFeatures({}, ['ai']);
    expect(nulls.ai_tokens_daily).toBe(100_000);
  });
});
