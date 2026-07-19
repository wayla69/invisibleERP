import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// docs/52 Phase 1 — the business-type POS feature profile (the "universal POS" linchpin).
// `tenants.industry` already exists but today it ONLY selects a chart-of-accounts template + onboarding
// pack — NO POS runtime path reads it. This resolver turns it into the switch that drives the register /
// checkout, mapping each of the 17 business types (INDUSTRY_KEYS, modules/ledger/coa-templates.ts) to one
// of three register shapes:
//   • RESTAURANT (tables/KDS/courses/buffet + recipe explosion, SALE.FOOD) — restaurant, hospitality (hotel F&B).
//   • GOODS      (clean generic register, no tables/kitchen, SALE.GOODS) — retail, distribution, general,
//                 manufacturing, ecommerce, agriculture, automotive, nonprofit (anyone selling physical goods).
//   • SERVICES   (clean generic register, SALE.SERVICE) — services, construction, healthcare, professional,
//                 logistics, education, realestate (bills for work/time, no stock-led counter).
//
// A tenant whose industry is unset OR an unrecognised value DEFAULTS to the restaurant profile — the
// original behaviour — so every existing tenant is unchanged (fail-safe, non-breaking). Phase 1b adds
// per-tenant feature-flag overrides on top of these industry defaults and the generic-sale-path cutover.

// Mirrors INDUSTRY_KEYS (modules/ledger/coa-templates.ts) — kept as a local union so the POS bounded
// context does not import the ledger module for a type. Keep the two lists in sync when adding an industry.
export type BusinessType =
  | 'restaurant' | 'retail' | 'distribution' | 'services' | 'general'
  | 'manufacturing' | 'construction' | 'ecommerce' | 'hospitality' | 'healthcare'
  | 'professional' | 'agriculture' | 'automotive' | 'logistics' | 'education'
  | 'nonprofit' | 'realestate';

export interface PosProfile {
  business_type: BusinessType;
  sale_path: 'restaurant' | 'generic'; // which checkout the register should ring against
  tables: boolean;         // show table / floor management + attach-to-table
  kds: boolean;            // kitchen display + fire-to-kitchen
  courses: boolean;        // course / seat-level firing
  buffet: boolean;         // buffet packages / timed dining
  recipe_deduction: boolean; // explode recipe/BOM at sale (vs a plain stock move)
  revenue_event: 'SALE.FOOD' | 'SALE.GOODS' | 'SALE.SERVICE'; // posting-events key the sale revenue posts under
}

const RESTAURANT: Omit<PosProfile, 'business_type'> = { sale_path: 'restaurant', tables: true, kds: true, courses: true, buffet: true, recipe_deduction: true, revenue_event: 'SALE.FOOD' };
const GOODS: Omit<PosProfile, 'business_type'> = { sale_path: 'generic', tables: false, kds: false, courses: false, buffet: false, recipe_deduction: false, revenue_event: 'SALE.GOODS' };
const SERVICES: Omit<PosProfile, 'business_type'> = { sale_path: 'generic', tables: false, kds: false, courses: false, buffet: false, recipe_deduction: false, revenue_event: 'SALE.SERVICE' };

@Injectable()
export class PosProfileService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // GET /api/pos/profile — the caller's tenant's POS feature profile (derived from tenants.industry).
  async resolve(user: JwtUser): Promise<PosProfile> {
    let industry: string | null = null;
    if (user.tenantId != null) {
      const [t] = await this.db.select({ industry: tenants.industry }).from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);
      industry = (t?.industry ?? null) as string | null;
    }
    return this.forIndustry(industry);
  }

  // Pure mapping (industry → profile) — separated so it is unit-testable without a DB.
  forIndustry(industry: string | null | undefined): PosProfile {
    switch (industry) {
      // Goods register (generic checkout, SALE.GOODS) — sells physical products across a counter.
      case 'retail':
      case 'distribution':
      case 'general':
      case 'manufacturing':
      case 'ecommerce':
      case 'agriculture':
      case 'automotive':
      case 'nonprofit':
        return { business_type: industry, ...GOODS };
      // Service register (generic checkout, SALE.SERVICE) — bills for work/time, no stock-led counter.
      case 'services':
      case 'construction':
      case 'healthcare':
      case 'professional':
      case 'logistics':
      case 'education':
      case 'realestate':
        return { business_type: industry, ...SERVICES };
      // Restaurant register (tables/KDS/courses, SALE.FOOD) — food service, incl. hotel F&B outlets.
      case 'restaurant':
      case 'hospitality':
        return { business_type: industry, ...RESTAURANT };
      default:
        // null / unknown → restaurant profile (original behaviour; non-breaking).
        return { business_type: 'restaurant', ...RESTAURANT };
    }
  }
}
