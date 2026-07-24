import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, gte } from 'drizzle-orm';
import { DRIZZLE, runGlobalDb, type DrizzleDb } from '../../database/database.module';
import { entitlementObservations, tenants } from '../../database/schema';

// B1 — god-only read surface over the entitlement_observations ledger the PlanGuard writes (see
// plan.guard.ts `record`). Answers "who would break, on what, if we enforced entitlements" so the
// platform owner can clear (or upsell) a tenant BEFORE moving it into the ENTITLEMENTS_ENFORCE_TENANTS
// cohort. Read-only; recording stays in the guard so this service adds zero hot-path cost.

export interface ObservationSummaryRow {
  tenant_id: number;
  tenant: string | null;
  total: number;
  codes: string[];
  modes: string[];
  last_at: string | null;
}

@Injectable()
export class EntitlementObservationsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Recent observations (newest first, capped) + a per-tenant rollup for the console's triage table.
  async list(days = 30): Promise<{ observations: unknown[]; summary: ObservationSummaryRow[] }> {
    const boundedDays = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 30;
    const cutoff = new Date(Date.now() - boundedDays * 86_400_000);
    const rows = await runGlobalDb('entitlement-observations:list', () => this.db
      .select({
        day: entitlementObservations.day,
        tenant_id: entitlementObservations.aboutTenantId,
        tenant: tenants.name,
        code: entitlementObservations.code,
        mode: entitlementObservations.mode,
        route_perms: entitlementObservations.routePerms,
        created_at: entitlementObservations.createdAt,
      })
      .from(entitlementObservations)
      .leftJoin(tenants, eq(entitlementObservations.aboutTenantId, tenants.id))
      .where(gte(entitlementObservations.createdAt, cutoff))
      .orderBy(desc(entitlementObservations.createdAt))
      .limit(500));

    const byTenant = new Map<number, ObservationSummaryRow>();
    for (const r of rows) {
      let s = byTenant.get(r.tenant_id);
      if (!s) {
        s = { tenant_id: r.tenant_id, tenant: r.tenant, total: 0, codes: [], modes: [], last_at: null };
        byTenant.set(r.tenant_id, s);
      }
      s.total += 1;
      if (!s.codes.includes(r.code)) s.codes.push(r.code);
      if (!s.modes.includes(r.mode)) s.modes.push(r.mode);
      const at = r.created_at ? new Date(r.created_at).toISOString() : null;
      if (at && (!s.last_at || at > s.last_at)) s.last_at = at;
    }
    const summary = [...byTenant.values()].sort((a, b) => b.total - a.total);
    return { observations: rows, summary };
  }
}
