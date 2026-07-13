import { NotFoundException } from '@nestjs/common';
import { eq, sql, desc } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { subscriptions, tenants, users, branches, auditLog, aiTokenUsage } from '../../database/schema';
import { logger } from '../../observability/logger';
import { PlatformNotificationsService } from '../platform-notifications/platform-notifications.module';

// docs/46 Phase 4c cut 3 — the PLATFORM CONSOLE side of billing (cross-company directory, tags, AI-spend
// oversight, company drawer detail, trial extension, suspend/reactivate — all @PlatformAdmin-bypass reads/
// writes), moved VERBATIM out of billing.service.ts. A plain class constructed in the BillingService
// constructor BODY; the facade keeps thin delegators, so the console endpoints are byte-identical.
export class PlatformAdminService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly platformNotifs?: PlatformNotificationsService,
  ) {}

  // ── #5 tenant lifecycle — a platform owner suspends/reactivates a company. Suspending sets suspended_at,
  // which the auth guard reads to block the tenant's users (403 TENANT_SUSPENDED); platform owners are exempt.
  // The mutation is audit-logged (AuditInterceptor). Runs under the platform-admin bypass (writes another
  // tenant's row). ──
  // Company directory for the platform owner ("god") — backs the web company-switcher AND the Platform
  // Console table. Runs under the @PlatformAdmin RLS bypass, so it lists EVERY tenant. Enriched with the
  // subscription (plan/status/trial) and a live user count so the console can show each company's posture
  // at a glance. Ordered by code for a stable list.
  // includeDeleted — the Platform Console fleet list/switcher hides soft-deleted companies (migration
  // 0386) by default; pass true to show them (e.g. a "show deleted" toggle) for restoreTenant.
  async listTenants(includeDeleted = false) {
    const rows = await this.db
      .select({
        id: tenants.id, code: tenants.code, name: tenants.name,
        suspendedAt: tenants.suspendedAt, createdAt: tenants.createdAt,
        deletedAt: tenants.deletedAt, deletedBy: tenants.deletedBy, purgedAt: tenants.purgedAt,
        legalName: tenants.legalName, taxId: tenants.taxId, addressLine1: tenants.addressLine1, province: tenants.province,
        tags: tenants.tags,
        planCode: subscriptions.planCode, status: subscriptions.status, trialEndsAt: subscriptions.trialEndsAt,
      })
      .from(tenants)
      .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
      .orderBy(tenants.code);
    // One grouped query for all user counts (avoids an N+1 over the tenant list).
    const counts = await this.db
      .select({ tenantId: users.tenantId, n: sql<number>`count(*)` })
      .from(users)
      .groupBy(users.tenantId);
    const countByTenant = new Map(counts.map((c) => [Number(c.tenantId), Number(c.n)]));
    // A tenant with two subscription rows would duplicate in the left join — keep the first (ordered) per id.
    const seen = new Set<number>();
    const out = [];
    for (const t of rows) {
      const id = Number(t.id);
      if (seen.has(id)) continue;
      seen.add(id);
      if (t.deletedAt && !includeDeleted) continue;
      out.push({
        id, code: t.code, name: t.name,
        suspended: !!t.suspendedAt,
        deleted: !!t.deletedAt,
        deleted_by: t.deletedBy ?? null,
        purged: !!t.purgedAt,
        // Deleted wins over suspended as the headline status; otherwise show the subscription status.
        status: t.deletedAt ? 'Deleted' : t.suspendedAt ? 'Suspended' : (t.status ?? null),
        plan_code: t.planCode ?? null,
        trial_ends_at: t.trialEndsAt ?? null,
        users: countByTenant.get(id) ?? 0,
        created_at: t.createdAt ?? null,
        // Setup essentials for issuing tax invoices — mirrors TenantController.fmt's setup_complete.
        setup_complete: !!(t.legalName && t.taxId && t.addressLine1 && t.province),
        tags: Array.isArray(t.tags) ? (t.tags as string[]) : [],
      });
    }
    return out;
  }

  // Set a company's tags/segments (Platform Console). Normalises to a de-duplicated, trimmed, capped list.
  async setTenantTags(id: number, tags: string[]) {
    const [t] = await this.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Company not found', messageTh: 'ไม่พบบริษัท' });
    const clean = Array.from(new Set((tags ?? []).map((s) => String(s).trim()).filter(Boolean))).slice(0, 20);
    await this.db.update(tenants).set({ tags: clean }).where(eq(tenants.id, id));
    return { tenant_id: id, tags: clean };
  }

  // Cross-company AI-token usage aggregate (Platform Console) — total in/out/overage per company, ordered by
  // spend. Cross-tenant read under the @PlatformAdmin bypass. Powers the AI-spend oversight panel.
  async aiUsageByTenant() {
    const rows = await this.db
      .select({
        tenantId: aiTokenUsage.tenantId,
        input: sql<number>`coalesce(sum(${aiTokenUsage.inputTokens}),0)`,
        output: sql<number>`coalesce(sum(${aiTokenUsage.outputTokens}),0)`,
        overage: sql<number>`coalesce(sum(${aiTokenUsage.overageTokens}),0)`,
      })
      .from(aiTokenUsage)
      .groupBy(aiTokenUsage.tenantId);
    const names = await this.db.select({ id: tenants.id, code: tenants.code, name: tenants.name }).from(tenants);
    const nameById = new Map(names.map((t) => [Number(t.id), { code: t.code, name: t.name }]));
    return rows
      .map((r) => {
        const id = Number(r.tenantId);
        const meta = nameById.get(id);
        return {
          tenant_id: id, code: meta?.code ?? null, name: meta?.name ?? `#${id}`,
          input_tokens: Number(r.input), output_tokens: Number(r.output), overage_tokens: Number(r.overage),
          total_tokens: Number(r.input) + Number(r.output),
        };
      })
      .sort((a, b) => b.total_tokens - a.total_tokens);
  }

  // Full detail for one company — backs the Platform Console company drawer. Cross-tenant read under the
  // @PlatformAdmin bypass: profile + latest subscription + user/branch counts + recent activity + AI usage.
  async getTenantDetail(id: number) {
    const [t] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Company not found', messageTh: 'ไม่พบบริษัท' });
    const [sub] = await this.db.select().from(subscriptions).where(eq(subscriptions.tenantId, id)).orderBy(sql`${subscriptions.createdAt} desc`).limit(1);
    const [uc] = await this.db.select({ n: sql<number>`count(*)` }).from(users).where(eq(users.tenantId, id));
    const [bc] = await this.db.select({ n: sql<number>`count(*)` }).from(branches).where(eq(branches.tenantId, id));
    const recent = await this.db
      .select({ ts: auditLog.ts, actor: auditLog.actor, action: auditLog.action, status: auditLog.status })
      .from(auditLog).where(eq(auditLog.tenantId, id)).orderBy(desc(auditLog.ts)).limit(12);
    const [ai] = await this.db
      .select({
        input: sql<number>`coalesce(sum(${aiTokenUsage.inputTokens}),0)`,
        output: sql<number>`coalesce(sum(${aiTokenUsage.outputTokens}),0)`,
        overage: sql<number>`coalesce(sum(${aiTokenUsage.overageTokens}),0)`,
      })
      .from(aiTokenUsage).where(eq(aiTokenUsage.tenantId, id));
    return {
      id: Number(t.id), code: t.code, name: t.name, legal_name: t.legalName ?? null, tax_id: t.taxId ?? null,
      created_at: t.createdAt ?? null,
      suspended: !!t.suspendedAt, suspended_at: t.suspendedAt ?? null, suspend_reason: t.suspendReason ?? null, suspended_by: t.suspendedBy ?? null,
      deleted: !!t.deletedAt, deleted_at: t.deletedAt ?? null, deleted_by: t.deletedBy ?? null,
      purged: !!t.purgedAt, purged_at: t.purgedAt ?? null, purged_by: t.purgedBy ?? null,
      tags: Array.isArray(t.tags) ? (t.tags as string[]) : [],
      subscription: sub ? { plan_code: sub.planCode, status: sub.status, trial_ends_at: sub.trialEndsAt ?? null } : null,
      counts: { users: Number(uc?.n ?? 0), branches: Number(bc?.n ?? 0) },
      ai_usage: { input_tokens: Number(ai?.input ?? 0), output_tokens: Number(ai?.output ?? 0), overage_tokens: Number(ai?.overage ?? 0) },
      recent_activity: recent.map((r) => ({ ts: r.ts, actor: r.actor, action: r.action, status: r.status })),
    };
  }

  // Platform-level trial extension — pushes trial_ends_at out by `days` (from the later of now / current end)
  // and (re)sets the subscription to Trialing. Cross-tenant @PlatformAdmin action; audit-logged by the filter.
  async extendTrial(id: number, days: number) {
    const d = Math.min(Math.max(Math.floor(Number(days) || 0), 1), 365);
    const [sub] = await this.db.select().from(subscriptions).where(eq(subscriptions.tenantId, id)).orderBy(sql`${subscriptions.createdAt} desc`).limit(1);
    if (!sub) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No subscription for tenant', messageTh: 'ไม่พบการสมัครสมาชิกของบริษัท' });
    const cur = sub.trialEndsAt ? new Date(sub.trialEndsAt).getTime() : 0;
    const base = cur > Date.now() ? cur : Date.now();
    const next = new Date(base + d * 24 * 60 * 60 * 1000);
    await this.db.update(subscriptions).set({ trialEndsAt: next, status: 'Trialing' }).where(eq(subscriptions.id, sub.id));
    return { tenant_id: id, trial_ends_at: next.toISOString(), status: 'Trialing', extended_days: d };
  }

  async suspendTenant(id: number, by: string, reason?: string) {
    const [t] = await this.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Company not found', messageTh: 'ไม่พบบริษัท' });
    await this.db.update(tenants).set({ suspendedAt: new Date(), suspendedBy: by, suspendReason: reason ?? null }).where(eq(tenants.id, id));
    logger.warn({ event: 'tenant_suspended', tenant_id: id, by, reason: reason ?? null }, 'company suspended');
    await this.platformNotifs?.emit({ type: 'tenant_suspended', title: `ระงับบริษัท #${id}`, body: `โดย ${by}${reason ? ` — ${reason}` : ''}`, tenantId: id, refType: 'tenant', refId: String(id) });
    return { tenant_id: id, status: 'suspended' };
  }

  async reactivateTenant(id: number, by: string) {
    const [t] = await this.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Company not found', messageTh: 'ไม่พบบริษัท' });
    await this.db.update(tenants).set({ suspendedAt: null, suspendedBy: null, suspendReason: null }).where(eq(tenants.id, id));
    logger.info({ event: 'tenant_reactivated', tenant_id: id, by }, 'company reactivated');
    await this.platformNotifs?.emit({ type: 'tenant_reactivated', title: `คืนสถานะบริษัท #${id}`, body: `โดย ${by}`, tenantId: id, refType: 'tenant', refId: String(id) });
    return { tenant_id: id, status: 'active' };
  }
}
