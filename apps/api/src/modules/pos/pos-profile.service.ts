import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// docs/52 Phase 1 — the business-type POS feature profile (the "universal POS" linchpin).
// `tenants.industry` already exists but today it ONLY selects a chart-of-accounts template + onboarding
// pack — NO POS runtime path reads it. This resolver turns it into the switch that drives the register /
// checkout: a restaurant gets tables/KDS/courses + the SALE.FOOD revenue event; retail / distribution /
// general get a clean generic register (no tables, no kitchen) + SALE.GOODS; services get SALE.SERVICE.
//
// A tenant whose industry is unset OR an unrecognised value DEFAULTS to the restaurant profile — the
// current behaviour — so every existing tenant is unchanged (fail-safe, non-breaking). Phase 1b will add
// per-tenant feature-flag overrides on top of these industry defaults and the generic-sale-path cutover.

export type BusinessType = 'restaurant' | 'retail' | 'distribution' | 'services' | 'general';

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
      case 'retail':
      case 'distribution':
      case 'general':
        return { business_type: industry, ...GOODS };
      case 'services':
        return { business_type: 'services', ...SERVICES };
      case 'restaurant':
      default:
        // null / unknown → restaurant profile (current behaviour; non-breaking).
        return { business_type: 'restaurant', ...RESTAURANT };
    }
  }
}
