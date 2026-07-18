// B1 (docs/51 Track B) — SME industry-aware nav folding profiles.
// Guards the internal consistency of the shared industry → nav-profile mapping that provisioning stamps
// into tenants.sme_prefs: every referenced key must exist in the census, hidden/open must not conflict,
// and each industry's first-load visible-item budget must stay in the "~15" band (8–25) so the launch UX
// win can't silently regress to either "everything folded" or "everything open".
import { describe, it, expect } from 'vitest';
import {
  SME_NAV_INDUSTRIES,
  SME_NAV_PROFILES,
  SME_NAV_CENSUS,
  smeNavProfile,
  smeNavVisibleItemCount,
  smeNavCensusTotal,
} from '@ierp/shared';

describe('SME nav profiles (B1 industry-aware folding)', () => {
  it('covers every industry key, including the general fallback', () => {
    expect([...SME_NAV_INDUSTRIES].sort()).toEqual([
      'agriculture', 'automotive', 'construction', 'distribution', 'ecommerce', 'education', 'general',
      'healthcare', 'hospitality', 'logistics', 'manufacturing', 'nonprofit', 'professional', 'realestate',
      'restaurant', 'retail', 'services',
    ]);
    for (const ind of SME_NAV_INDUSTRIES) expect(SME_NAV_PROFILES[ind]).toBeTruthy();
  });

  it('references only census keys (no typos/renamed nav groups)', () => {
    for (const ind of SME_NAV_INDUSTRIES) {
      const p = SME_NAV_PROFILES[ind];
      for (const k of [...p.hidden, ...p.open]) {
        expect(SME_NAV_CENSUS[k], `${ind}: unknown nav key ${k}`).toBeTruthy();
      }
    }
  });

  it('hides only TOP-LEVEL groups, and never a group it also opens', () => {
    for (const ind of SME_NAV_INDUSTRIES) {
      const p = SME_NAV_PROFILES[ind];
      for (const k of p.hidden) {
        expect(SME_NAV_CENSUS[k]?.parent, `${ind}: hidden key ${k} is a subgroup`).toBeUndefined();
        expect(p.open).not.toContain(k);
      }
      // an open subgroup must have its parent open too, or it can never show
      for (const k of p.open) {
        const parent = SME_NAV_CENSUS[k]?.parent;
        if (parent) expect(p.open, `${ind}: open subgroup ${k} needs its parent ${parent} open`).toContain(parent);
      }
    }
  });

  it('keeps each industry first-load view in the ~15-item band (8–25); general stays minimal', () => {
    for (const ind of SME_NAV_INDUSTRIES) {
      const visible = smeNavVisibleItemCount(SME_NAV_PROFILES[ind]);
      if (ind === 'general') {
        expect(visible).toBeLessThanOrEqual(8); // fallback ≈ today's only-active-open behaviour
      } else {
        expect(visible, `${ind}: visible=${visible}`).toBeGreaterThanOrEqual(8);
        expect(visible, `${ind}: visible=${visible}`).toBeLessThanOrEqual(25);
      }
    }
  });

  it('general fallback hides nothing (an unknown industry must never lose nav)', () => {
    expect(SME_NAV_PROFILES.general.hidden).toEqual([]);
    expect(smeNavProfile(undefined)).toEqual(SME_NAV_PROFILES.general);
    expect(smeNavProfile('crypto-mining')).toEqual(SME_NAV_PROFILES.general);
    expect(smeNavProfile('restaurant')).toEqual(SME_NAV_PROFILES.restaurant);
  });

  it('census total stays near the real nav size (drift floor vs apps/web/src/lib/nav.ts)', () => {
    expect(smeNavCensusTotal()).toBeGreaterThanOrEqual(180); // "~210" internal items as of 2026-07-16 (206)
  });
});
