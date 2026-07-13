import { Inject, Injectable, ConflictException, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { eq, sql, and, desc, gt, isNull } from 'drizzle-orm';
import { randomBytes, createHash } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { plans, subscriptions, tenants, users, branches, auditLog, aiTokenUsage, aiOverageBillingRuns, usageEvents, usageOverageBillingRuns, signupInvites, signupRequests } from '../../database/schema';
import { PasswordService } from '../auth/password.service';
import { LedgerService } from '../ledger/ledger.service';
import { isIndustryKey } from '../ledger/coa-templates';
import { ymd } from '../../database/queries';
import { normalizeUsername } from '../../common/username';
import { isPlatformAdmin } from '../../common/decorators';
import { isUniqueViolation } from '../../common/db-error';
import { logger } from '../../observability/logger';
import type { JwtUser } from '../../common/decorators';
import { PLAN_SUITES } from '@ierp/shared';
import { computeProration } from './proration';
import { PlatformNotificationsService } from '../platform-notifications/platform-notifications.module';
import { StripeBilling } from './stripe-gateway';
import { TenantProvisioningService, type SignupDto } from './tenant-provisioning.service';
// Re-exported so existing import sites (controllers, unit tests) keep working.
export { isSignupAllowed, type SignupDto } from './tenant-provisioning.service';
// Re-exported so existing import sites keep working (the adapter lives in stripe-gateway.ts now).
export { StripeBilling } from './stripe-gateway';





interface PlanSeed {
  code: string;
  name: string;
  priceMonthly: string;
  priceYearly?: string | null; // 1.7 — NULL = not offered annually
  currency: string;
  prices?: Record<string, { monthly?: number; yearly?: number }> | null; // 1.7 — per-currency price list (THB implied)
  features: Record<string, unknown>;
}

// PRICING — illustrative values (PwC Capital Markets follow-up). Subscription prices and the AI-token
// economics are finalized in docs/ops/pricing-and-ai-cogs.md + docs/ops/unit-economics-model.md; the
// figures here are the agreed illustrative defaults the founder can overwrite. AI is priced on a
// **ceiling + metered-overage** model (no unlimited tier — panel #3):
//   • ai_tokens_daily          — FINITE included daily tokens (free for the tenant within this band).
//   • ai_tokens_daily_max      — hard ceiling: the absolute daily cutoff; usage in (included, max] is
//                                metered as overage, and the next request past max is AI_BUDGET_EXCEEDED.
//   • ai_overage_rate_thb_per_1k — THB billed per 1,000 overage tokens (the band between included and max).
// This connects the COGS meter (ai_token_usage.overage_tokens) to a price so a heavy tenant is charged for
// the upstream Anthropic spend rather than served at negative gross margin.
// The `suites` array on each plan is the DB-explicit copy of the packaging map (docs/36, PLAN_SUITES in
// @ierp/shared). PlanGuard reads plans.features.suites; embedding it here means seedPlans() (idempotent,
// runs at startup) BACKFILLS every existing plan row — the grandfather step that must precede enabling
// ENTITLEMENTS_ENFORCE. resolveEntitledSuites() still falls back to the code default if it is ever absent.
const PLAN_SEED: PlanSeed[] = [
  { code: 'free', name: 'Free', priceMonthly: '0', currency: 'THB', features: { suites: PLAN_SUITES.free, users: 2, locations: 1, ai_chat: false, reports: 'basic', ai_tokens_daily: 0, ai_tokens_daily_max: 0, ai_overage_rate_thb_per_1k: 0, etax_docs_monthly: 0, pos_txns_monthly: 0, etax_overage_rate_thb_per_doc: 0, pos_overage_rate_thb_per_txn: 0 } },
  { code: 'starter', name: 'Standard', priceMonthly: '2900', priceYearly: '29000', currency: 'THB', prices: { USD: { monthly: 85, yearly: 850 } }, features: { suites: PLAN_SUITES.starter, users: 10, locations: 2, ai_chat: false, reports: 'standard', ai_tokens_daily: 0, ai_tokens_daily_max: 0, ai_overage_rate_thb_per_1k: 0, etax_docs_monthly: 100, pos_txns_monthly: 3000, etax_overage_rate_thb_per_doc: 3, pos_overage_rate_thb_per_txn: 0.5 } },
  // 1.9 — Business mid-tier: closes the Standard→Professional price cliff (2,900 → 9,900 was a 3.4× jump
  // with no rung). Standard + procurement + multi-branch; planning/loyalty/AI stay Professional-only.
  { code: 'business', name: 'Business', priceMonthly: '4900', priceYearly: '49000', currency: 'THB', prices: { USD: { monthly: 140, yearly: 1400 } }, features: { suites: PLAN_SUITES.business, users: 25, locations: 5, ai_chat: false, reports: 'standard', ai_tokens_daily: 0, ai_tokens_daily_max: 0, ai_overage_rate_thb_per_1k: 0, etax_docs_monthly: 300, pos_txns_monthly: 10_000, etax_overage_rate_thb_per_doc: 2.5, pos_overage_rate_thb_per_txn: 0.4 } },
  { code: 'pro', name: 'Professional', priceMonthly: '9900', priceYearly: '99000', currency: 'THB', prices: { USD: { monthly: 285, yearly: 2850 } }, features: { suites: PLAN_SUITES.pro, users: 50, locations: 10, ai_chat: true, reports: 'advanced', ai_tokens_daily: 200_000, ai_tokens_daily_max: 500_000, ai_overage_rate_thb_per_1k: 12, etax_docs_monthly: 1000, pos_txns_monthly: 30_000, etax_overage_rate_thb_per_doc: 2, pos_overage_rate_thb_per_txn: 0.3 } },
  { code: 'enterprise', name: 'Enterprise', priceMonthly: '0', currency: 'THB', features: { suites: PLAN_SUITES.enterprise, users: -1, locations: -1, ai_chat: true, reports: 'advanced', custom: true, ai_tokens_daily: 2_000_000, ai_tokens_daily_max: 5_000_000, ai_overage_rate_thb_per_1k: 8, etax_docs_monthly: -1, pos_txns_monthly: -1, etax_overage_rate_thb_per_doc: 0, pos_overage_rate_thb_per_txn: 0 } },
];


@Injectable()
export class BillingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly password: PasswordService,
    @Optional() private readonly ledger?: LedgerService, // optional so hand-constructed test instances still work
    @Optional() private readonly platformNotifs?: PlatformNotificationsService, // god event feed; optional for partial harnesses
  ) {
    this.provisioning = new TenantProvisioningService(db, password, ledger, platformNotifs);
  }

  // ONE Stripe adapter instance for every billing path (docs/46 Phase 4c cut 1 — was `new StripeBilling()`
  // at each call site). Env-driven (STRIPE_SECRET_KEY), so a single shared instance is safe.
  private readonly stripe = new StripeBilling();
  private readonly provisioning: TenantProvisioningService;

  // ───────────────────── Seed (idempotent — run at startup) ─────────────────────
  async seedPlans(): Promise<{ seeded: number }> {
    const db = this.db;
    let seeded = 0;
    for (const p of PLAN_SEED) {
      await db.insert(plans).values({
        code: p.code, name: p.name, priceMonthly: p.priceMonthly, priceYearly: p.priceYearly ?? null, currency: p.currency, prices: p.prices ?? null, features: p.features, active: 'true',
      }).onConflictDoUpdate({
        target: plans.code,
        set: { name: p.name, priceMonthly: p.priceMonthly, priceYearly: p.priceYearly ?? null, currency: p.currency, prices: p.prices ?? null, features: p.features, active: 'true' },
      });
      seeded++;
    }
    return { seeded };
  }

  // ───────────────────── PUBLIC plan catalogue ─────────────────────
  async listPlans() {
    const db = this.db;
    const rows = await db
      .select({ code: plans.code, name: plans.name, price_monthly: plans.priceMonthly, price_yearly: plans.priceYearly, currency: plans.currency, prices: plans.prices, features: plans.features, active: plans.active })
      .from(plans)
      .where(sql`${plans.active}::text = 'true'`)
      .orderBy(sql`${plans.priceMonthly} asc`);
    return { plans: rows.map((r: any) => ({ ...r, price_monthly: Number(r.price_monthly ?? 0), price_yearly: r.price_yearly != null ? Number(r.price_yearly) : null })) };
  }


  // ── #5 tenant lifecycle — a platform owner suspends/reactivates a company. Suspending sets suspended_at,
  // which the auth guard reads to block the tenant's users (403 TENANT_SUSPENDED); platform owners are exempt.
  // The mutation is audit-logged (AuditInterceptor). Runs under the platform-admin bypass (writes another
  // tenant's row). ──
  // Company directory for the platform owner ("god") — backs the web company-switcher AND the Platform
  // Console table. Runs under the @PlatformAdmin RLS bypass, so it lists EVERY tenant. Enriched with the
  // subscription (plan/status/trial) and a live user count so the console can show each company's posture
  // at a glance. Ordered by code for a stable list.
  async listTenants() {
    const rows = await this.db
      .select({
        id: tenants.id, code: tenants.code, name: tenants.name,
        suspendedAt: tenants.suspendedAt, createdAt: tenants.createdAt,
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
      out.push({
        id, code: t.code, name: t.name,
        suspended: !!t.suspendedAt,
        // Suspended wins as the headline status; otherwise show the subscription status (or null if none).
        status: t.suspendedAt ? 'Suspended' : (t.status ?? null),
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


  // ───────────────────── Tenant lifecycle — docs/46 Phase 4c cut 2 ─────────────────────
  // Signup gate + invites + approval queue + provisioning + factory reset live in
  // TenantProvisioningService (ctor-BODY construction). Thin delegators keep the public API byte-identical.
  signup(dto: SignupDto) { return this.provisioning.signup(dto); }
  createSignupInvite(opts: { createdBy: string; company_name?: string; plan_code?: string; email?: string; ttl_hours?: number }) { return this.provisioning.createSignupInvite(opts); }
  listSignupInvites() { return this.provisioning.listSignupInvites(); }
  createSignupRequest(dto: SignupDto) { return this.provisioning.createSignupRequest(dto); }
  listSignupRequests(status?: string) { return this.provisioning.listSignupRequests(status); }
  approveSignupRequest(id: number, reviewedBy: string) { return this.provisioning.approveSignupRequest(id, reviewedBy); }
  rejectSignupRequest(id: number, reviewedBy: string, reason?: string) { return this.provisioning.rejectSignupRequest(id, reviewedBy, reason); }
  factoryResetTenant(id: number, by: string, confirm: string) { return this.provisioning.factoryResetTenant(id, by, confirm); }
  provisionTenant(dto: SignupDto, opts?: { passwordHash?: string }) { return this.provisioning.provisionTenant(dto, opts); }
  resolveTenantId(user: { username: string; customerName: string | null }) { return this.provisioning.resolveTenantId(user); }

  // ───────────────────── Subscription read / change ─────────────────────
  async getSubscription(tenantId: number) {
    const db = this.db;
    const [row] = await db
      .select({
        id: subscriptions.id,
        tenant_id: subscriptions.tenantId,
        plan_code: subscriptions.planCode,
        status: subscriptions.status,
        trial_ends_at: subscriptions.trialEndsAt,
        current_period_end: subscriptions.currentPeriodEnd,
        plan_name: plans.name,
        price_monthly: plans.priceMonthly,
        currency: plans.currency,
        features: plans.features,
      })
      .from(subscriptions)
      .leftJoin(plans, eq(subscriptions.planCode, plans.code))
      .where(eq(subscriptions.tenantId, tenantId))
      .orderBy(sql`${subscriptions.createdAt} desc`)
      .limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No subscription for tenant', messageTh: 'ไม่พบการสมัครสมาชิกของร้าน' });
    return { ...row, price_monthly: Number(row.price_monthly ?? 0) };
  }

  // Per-tenant AI token consumption (cost attribution / COGS visibility). The enforcement side — the daily
  // budget gate (AI_BUDGET_EXCEEDED) and the autocommit usage writes — lives in AgentService; this is the
  // read-only view of the same `ai_token_usage` rows, plus the plan's daily limit so the UI can show
  // "X of Y tokens used today". Read through the normal (tenant-scoped) connection.
  async aiUsage(tenantId: number) {
    const db = this.db;
    const [planRow] = await db.select({ features: plans.features })
      .from(subscriptions).leftJoin(plans, eq(subscriptions.planCode, plans.code))
      .where(and(eq(subscriptions.tenantId, tenantId), sql`${subscriptions.status} in ('Active','Trialing')`))
      .orderBy(desc(subscriptions.createdAt)).limit(1);
    const features: any = planRow?.features ?? {};
    const dailyLimit = features.ai_tokens_daily != null ? Number(features.ai_tokens_daily) : 50000; // included daily cap (default Pro-tier)
    // Hard ceiling + overage economics (ceiling + metered-overage model). A plan that omits the max has no
    // overage band → the included cap IS the ceiling. The rate prices the (included, max] band.
    const dailyMax = features.ai_tokens_daily_max != null ? Number(features.ai_tokens_daily_max) : dailyLimit;
    const overageRate = Number(features.ai_overage_rate_thb_per_1k ?? 0); // THB per 1,000 overage tokens
    const [today] = await db.select({ input: aiTokenUsage.inputTokens, output: aiTokenUsage.outputTokens, overage: aiTokenUsage.overageTokens })
      .from(aiTokenUsage)
      .where(and(eq(aiTokenUsage.tenantId, tenantId), sql`${aiTokenUsage.usageDate} = (now() AT TIME ZONE 'Asia/Bangkok')::date`))
      .limit(1);
    const tIn = today ? Number(today.input) : 0;
    const tOut = today ? Number(today.output) : 0;
    const tTotal = tIn + tOut;
    const tOverage = today ? Number(today.overage) : 0;
    // 30-day usage + overage (the billable accumulation the overage invoice line draws from).
    const [m] = await db.select({
      input: sql<number>`coalesce(sum(${aiTokenUsage.inputTokens}),0)`,
      output: sql<number>`coalesce(sum(${aiTokenUsage.outputTokens}),0)`,
      overage: sql<number>`coalesce(sum(${aiTokenUsage.overageTokens}),0)`,
    }).from(aiTokenUsage)
      .where(and(eq(aiTokenUsage.tenantId, tenantId), sql`${aiTokenUsage.usageDate} >= (now() AT TIME ZONE 'Asia/Bangkok')::date - INTERVAL '30 days'`));
    const mIn = Number(m?.input ?? 0);
    const mOut = Number(m?.output ?? 0);
    const mOverage = Number(m?.overage ?? 0);
    const round2 = (x: number) => Math.round(x * 100) / 100;
    return {
      daily_limit: dailyLimit,          // included finite cap (free band)
      daily_max: dailyMax,              // hard ceiling (absolute cutoff)
      overage_rate_thb_per_1k: overageRate,
      today: {
        input_tokens: tIn, output_tokens: tOut, total_tokens: tTotal,
        remaining: Math.max(0, dailyMax - tTotal),     // tokens left before the hard ceiling
        over_budget: tTotal >= dailyMax,               // hit the hard ceiling (blocked)
        overage_tokens: tOverage,                      // metered beyond the included cap
        projected_overage_thb: round2((tOverage / 1000) * overageRate),
      },
      last_30_days: {
        input_tokens: mIn, output_tokens: mOut, total_tokens: mIn + mOut,
        overage_tokens: mOverage,
        overage_charge_thb: round2((mOverage / 1000) * overageRate),
      },
    };
  }

  // AI overage invoice line for a billing month (YYYY-MM, Asia/Bangkok). Sums the metered overage tokens —
  // the band consumed ABOVE each day's included cap — and prices them at the plan's overage rate. This is the
  // line a monthly invoice run appends so heavy AI usage is billed (panel #3: connect the COGS meter to a
  // price). Returns a zero line when the plan has no overage rate or the tenant stayed within its cap.
  async aiOverageInvoice(tenantId: number, month?: string) {
    const db = this.db;
    const ym = (month && /^\d{4}-\d{2}$/.test(month)) ? month : null;
    const [planRow] = await db.select({ features: plans.features, plan_code: subscriptions.planCode })
      .from(subscriptions).leftJoin(plans, eq(subscriptions.planCode, plans.code))
      .where(and(eq(subscriptions.tenantId, tenantId), sql`${subscriptions.status} in ('Active','Trialing')`))
      .orderBy(desc(subscriptions.createdAt)).limit(1);
    const features: any = planRow?.features ?? {};
    // Rate is data-driven: per-plan feature is the source of truth; an optional global env override
    // (AI_OVERAGE_RATE_THB_PER_1K) lets ops re-price overage without a deploy. Real numbers drop in here.
    const envRate = process.env.AI_OVERAGE_RATE_THB_PER_1K;
    const overageRate = envRate && envRate.trim() ? Number(envRate) : Number(features.ai_overage_rate_thb_per_1k ?? 0); // THB / 1,000 overage tokens
    // Scope to the requested month (default: current Bangkok month). usage_date is already a Bangkok business date.
    const monthFilter = ym
      ? sql`to_char(${aiTokenUsage.usageDate}, 'YYYY-MM') = ${ym}`
      : sql`to_char(${aiTokenUsage.usageDate}, 'YYYY-MM') = to_char((now() AT TIME ZONE 'Asia/Bangkok')::date, 'YYYY-MM')`;
    const [agg] = await db.select({ overage: sql<number>`coalesce(sum(${aiTokenUsage.overageTokens}),0)` })
      .from(aiTokenUsage)
      .where(and(eq(aiTokenUsage.tenantId, tenantId), monthFilter));
    const overageTokens = Number(agg?.overage ?? 0);
    const amount = Math.round((overageTokens / 1000) * overageRate * 100) / 100;
    return {
      tenant_id: tenantId,
      month: ym ?? new Date().toISOString().slice(0, 7),
      plan_code: planRow?.plan_code ?? null,
      overage_tokens: overageTokens,
      overage_rate_thb_per_1k: overageRate,
      currency: 'THB',
      amount, // billable overage charge for the month
      line_description: `AI usage overage — ${overageTokens.toLocaleString()} tokens @ ${overageRate} THB/1k`,
    };
  }

  // ───────────────────── Monthly AI overage billing (scheduled action job — Wave 1) ─────────────────────
  // Charges each tenant's metered AI overage for a billing month as a Stripe invoice item, IDEMPOTENT per
  // (tenant, month) via the ai_overage_billing_runs UNIQUE. Runs from the BI scheduler (report type
  // 'ai_overage_billing') or POST /api/billing/ai-overage/run. Default month = the just-closed Bangkok month.
  // Operator scope: iterates the active/trialing subscriptions VISIBLE to the caller (RLS — the HQ scheduler
  // bypasses RLS and bills every tenant; a tenant-scoped caller bills only itself, harmless).
  // Idempotency ordering: we INSERT the run row FIRST (ON CONFLICT DO NOTHING); only the winner calls Stripe,
  // so a concurrent/retried run can never double-charge. The Stripe idempotencyKey is a second guard.
  async runAiOverageBilling(user: JwtUser, month?: string): Promise<{ month: string; processed_count: number; total_amount: number; processed: any[] }> {
    const db = this.db;
    const round2 = (x: number) => Math.round(x * 100) / 100;
    let billingMonth = month && /^\d{4}-\d{2}$/.test(month) ? month : '';
    if (!billingMonth) {
      const res: any = await db.execute(sql`SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok')::date - INTERVAL '1 month', 'YYYY-MM') AS m`);
      const rows = (res.rows ?? res) as any[];
      billingMonth = String(rows[0]?.m ?? new Date().toISOString().slice(0, 7));
    }
    const subs = await db.select({ tenantId: subscriptions.tenantId, cust: subscriptions.stripeCustomerId, createdAt: subscriptions.createdAt })
      .from(subscriptions).where(sql`${subscriptions.status} in ('Active','Trialing')`).orderBy(desc(subscriptions.createdAt));
    const seen = new Set<number>();
    const processed: any[] = [];
    let total = 0;
    for (const s of subs) {
      const tenantId = Number(s.tenantId);
      if (seen.has(tenantId)) continue; // one (latest) subscription per tenant
      seen.add(tenantId);
      const inv = await this.aiOverageInvoice(tenantId, billingMonth);
      if (inv.amount <= 0) continue; // nothing metered above the included cap this month
      // Reserve the (tenant, month) slot before charging — the UNIQUE makes this the idempotency gate.
      const ins = await db.insert(aiOverageBillingRuns).values({
        tenantId, billingMonth, overageTokens: inv.overage_tokens, rateThbPer1k: String(inv.overage_rate_thb_per_1k),
        amount: String(inv.amount), currency: inv.currency, status: 'pending', processedBy: user?.username ?? 'system:scheduler',
      }).onConflictDoNothing({ target: [aiOverageBillingRuns.tenantId, aiOverageBillingRuns.billingMonth] }).returning({ id: aiOverageBillingRuns.id });
      if (!ins.length) continue; // already billed this (tenant, month) → idempotent skip
      const runId = Number(ins[0]!.id);
      const charge = await this.stripe.createOverageInvoiceItem(s.cust ?? null, inv.amount, inv.line_description, `ai-overage:${tenantId}:${billingMonth}`);
      const status = charge.mock ? 'recorded' : 'invoiced';
      await db.update(aiOverageBillingRuns).set({ stripeInvoiceItemId: charge.id, status }).where(eq(aiOverageBillingRuns.id, runId));
      total += inv.amount;
      processed.push({ tenant_id: tenantId, month: billingMonth, overage_tokens: inv.overage_tokens, amount: inv.amount, currency: inv.currency, stripe_invoice_item_id: charge.id, status });
    }
    return { month: billingMonth, processed_count: processed.length, total_amount: round2(total), processed };
  }

  // History of AI-overage charges for a tenant (most recent first) — the read view of ai_overage_billing_runs.
  async listOverageRuns(tenantId: number, month?: string) {
    const db = this.db;
    const conds: any[] = [eq(aiOverageBillingRuns.tenantId, tenantId)];
    if (month && /^\d{4}-\d{2}$/.test(month)) conds.push(eq(aiOverageBillingRuns.billingMonth, month));
    const rows = await db.select().from(aiOverageBillingRuns).where(and(...conds)).orderBy(desc(aiOverageBillingRuns.billingMonth)).limit(36);
    return {
      runs: rows.map((r: any) => ({
        month: r.billingMonth, overage_tokens: Number(r.overageTokens), rate_thb_per_1k: Number(r.rateThbPer1k),
        amount: Number(r.amount), currency: r.currency, status: r.status, stripe_invoice_item_id: r.stripeInvoiceItemId, processed_at: r.processedAt,
      })),
    };
  }

  // ───────────────────── Generic usage metering → overage billing (1.5) ─────────────────────
  // The e-Tax-document and POS-transaction meters mirror AI tokens: per-event rows in usage_events, a monthly
  // included quota + per-unit overage price on the plan, and an idempotent monthly Stripe charge.
  static readonly USAGE_METERS: Record<string, { includedKey: string; rateKey: string; unit: string; label: string }> = {
    etax_docs: { includedKey: 'etax_docs_monthly', rateKey: 'etax_overage_rate_thb_per_doc', unit: 'doc', label: 'e-Tax documents' },
    pos_txns: { includedKey: 'pos_txns_monthly', rateKey: 'pos_overage_rate_thb_per_txn', unit: 'txn', label: 'POS transactions' },
  };

  // Overage invoice line for one meter for a billing month: count the tenant's metered events in the period,
  // subtract the plan's included monthly quota (−1 = unlimited ⇒ no overage), price the excess at the per-unit
  // rate. Returns a zero line when within quota, unlimited, or the plan has no rate.
  async usageOverageInvoice(tenantId: number, meter: string, month?: string) {
    const cfg = BillingService.USAGE_METERS[meter];
    if (!cfg) throw new BadRequestException({ code: 'UNKNOWN_METER', message: `Unknown meter ${meter}`, messageTh: `ไม่รู้จักมิเตอร์ ${meter}` });
    const db = this.db;
    const ym = (month && /^\d{4}-\d{2}$/.test(month)) ? month : new Date().toISOString().slice(0, 7);
    const [planRow] = await db.select({ features: plans.features, plan_code: subscriptions.planCode })
      .from(subscriptions).leftJoin(plans, eq(subscriptions.planCode, plans.code))
      .where(and(eq(subscriptions.tenantId, tenantId), sql`${subscriptions.status} in ('Active','Trialing')`))
      .orderBy(desc(subscriptions.createdAt)).limit(1);
    const features: any = planRow?.features ?? {};
    const included = Number(features[cfg.includedKey] ?? 0); // −1 = unlimited
    const rate = Number(features[cfg.rateKey] ?? 0); // THB per unit
    const [agg] = await db.select({ n: sql<number>`count(*)` }).from(usageEvents)
      .where(and(eq(usageEvents.tenantId, tenantId), eq(usageEvents.meter, meter), eq(usageEvents.period, ym)));
    const used = Number(agg?.n ?? 0);
    const overageUnits = included < 0 ? 0 : Math.max(0, used - included);
    const amount = Math.round(overageUnits * rate * 100) / 100;
    return {
      tenant_id: tenantId, meter, month: ym, plan_code: planRow?.plan_code ?? null,
      used, included, overage_units: overageUnits, rate_thb_per_unit: rate, currency: 'THB', amount,
      line_description: `${cfg.label} overage — ${overageUnits.toLocaleString()} ${cfg.unit} @ ${rate} THB/${cfg.unit} (${ym})`,
    };
  }

  // Monthly usage-overage billing across every configured meter (scheduled action job). IDEMPOTENT per
  // (tenant, meter, month) via the usage_overage_billing_runs UNIQUE — the run row is INSERTed first
  // (ON CONFLICT DO NOTHING); only the winner calls Stripe. Mirrors runAiOverageBilling.
  async runUsageOverageBilling(user: JwtUser, month?: string): Promise<{ month: string; processed_count: number; total_amount: number; processed: any[] }> {
    const db = this.db;
    const round2 = (x: number) => Math.round(x * 100) / 100;
    let billingMonth = month && /^\d{4}-\d{2}$/.test(month) ? month : '';
    if (!billingMonth) {
      const res = await db.execute(sql`SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok')::date - INTERVAL '1 month', 'YYYY-MM') AS m`);
      const rows = ((res as { rows?: { m?: string }[] }).rows ?? (res as { m?: string }[]));
      billingMonth = String(rows[0]?.m ?? new Date().toISOString().slice(0, 7));
    }
    const subs = await db.select({ tenantId: subscriptions.tenantId, cust: subscriptions.stripeCustomerId, createdAt: subscriptions.createdAt })
      .from(subscriptions).where(sql`${subscriptions.status} in ('Active','Trialing')`).orderBy(desc(subscriptions.createdAt));
    const seen = new Set<number>();
    const processed: Array<Record<string, unknown>> = [];
    let total = 0;
    for (const s of subs) {
      const tenantId = Number(s.tenantId);
      if (seen.has(tenantId)) continue;
      seen.add(tenantId);
      for (const meter of Object.keys(BillingService.USAGE_METERS)) {
        const inv = await this.usageOverageInvoice(tenantId, meter, billingMonth);
        if (inv.amount <= 0) continue;
        const ins = await db.insert(usageOverageBillingRuns).values({
          tenantId, meter, billingMonth, overageUnits: inv.overage_units, rateThbPerUnit: String(inv.rate_thb_per_unit),
          amount: String(inv.amount), currency: inv.currency, status: 'pending', processedBy: user?.username ?? 'system:scheduler',
        }).onConflictDoNothing({ target: [usageOverageBillingRuns.tenantId, usageOverageBillingRuns.meter, usageOverageBillingRuns.billingMonth] }).returning({ id: usageOverageBillingRuns.id });
        if (!ins.length) continue; // already billed this (tenant, meter, month)
        const runId = Number(ins[0]!.id);
        const charge = await this.stripe.createOverageInvoiceItem(s.cust ?? null, inv.amount, inv.line_description, `usage-overage:${meter}:${tenantId}:${billingMonth}`);
        const status = charge.mock ? 'recorded' : 'invoiced';
        await db.update(usageOverageBillingRuns).set({ stripeInvoiceItemId: charge.id, status }).where(eq(usageOverageBillingRuns.id, runId));
        total += inv.amount;
        processed.push({ tenant_id: tenantId, meter, month: billingMonth, overage_units: inv.overage_units, amount: inv.amount, currency: inv.currency, stripe_invoice_item_id: charge.id, status });
      }
    }
    return { month: billingMonth, processed_count: processed.length, total_amount: round2(total), processed };
  }

  // Read view of usage_overage_billing_runs for a tenant (most recent first).
  async listUsageOverageRuns(tenantId: number, meter?: string, month?: string) {
    const db = this.db;
    const conds: any[] = [eq(usageOverageBillingRuns.tenantId, tenantId)];
    if (meter && BillingService.USAGE_METERS[meter]) conds.push(eq(usageOverageBillingRuns.meter, meter));
    if (month && /^\d{4}-\d{2}$/.test(month)) conds.push(eq(usageOverageBillingRuns.billingMonth, month));
    const rows = await db.select().from(usageOverageBillingRuns).where(and(...conds)).orderBy(desc(usageOverageBillingRuns.billingMonth)).limit(72);
    return {
      runs: rows.map((r: any) => ({
        meter: r.meter, month: r.billingMonth, overage_units: Number(r.overageUnits), rate_thb_per_unit: Number(r.rateThbPerUnit),
        amount: Number(r.amount), currency: r.currency, status: r.status, stripe_invoice_item_id: r.stripeInvoiceItemId, processed_at: r.processedAt,
      })),
    };
  }

  // Current-month usage snapshot per meter (used/included/overage) — the tenant's live usage view.
  async usageSummary(tenantId: number, month?: string) {
    const meters = await Promise.all(Object.keys(BillingService.USAGE_METERS).map((m) => this.usageOverageInvoice(tenantId, m, month)));
    return { tenant_id: tenantId, month: meters[0]?.month ?? new Date().toISOString().slice(0, 7), meters };
  }

  async changePlan(tenantId: number, planCode: string, interval?: 'monthly' | 'annual') {
    const db = this.db;
    const target = planCode.trim();
    const [plan] = await db.select().from(plans).where(eq(plans.code, target)).limit(1);
    if (!plan) throw new BadRequestException({ code: 'BAD_REQUEST', message: `Unknown plan: ${target}`, messageTh: 'ไม่พบแพ็กเกจที่เลือก' });

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId)).orderBy(sql`${subscriptions.createdAt} desc`).limit(1);
    if (!sub) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No subscription for tenant', messageTh: 'ไม่พบการสมัครสมาชิกของร้าน' });

    // 1.6/1.7 — mid-cycle proration: unused credit on the OLD plan vs the prorated charge on the NEW plan
    // for the days left in the period, computed on the SUBSCRIPTION'S CURRENT interval basis (30-day monthly
    // / 365-day annual periods). Informational (surfaced for confirmation); Stripe proration is a follow-up.
    // A change that ALSO switches the billing interval mixes two period bases — no honest single number
    // exists, so proration is null with an explanatory note rather than a misleading figure.
    const curInterval: 'monthly' | 'annual' = sub.billingInterval === 'annual' ? 'annual' : 'monthly';
    const targetInterval: 'monthly' | 'annual' = interval ?? curInterval;
    const [oldPlan] = await db.select({ price: plans.priceMonthly, priceYearly: plans.priceYearly, prices: plans.prices }).from(plans).where(eq(plans.code, sub.planCode)).limit(1);
    let proration: ReturnType<typeof computeProration> | null = null;
    let prorationNote: string | undefined;
    if (targetInterval === curInterval) {
      const periodDays = curInterval === 'annual' ? 365 : 30;
      const oldAmount = curInterval === 'annual' ? Number(oldPlan?.priceYearly ?? 0) : Number(oldPlan?.price ?? 0);
      const newAmount = curInterval === 'annual' ? Number(plan.priceYearly ?? 0) : Number(plan.priceMonthly ?? 0);
      proration = computeProration({ oldPriceMonthly: oldAmount, newPriceMonthly: newAmount, periodEnd: sub.currentPeriodEnd, now: Date.now(), periodDays });
    } else {
      prorationNote = 'interval_change'; // switching monthly↔annual — applied at the next renewal, no mid-cycle number
    }

    await db.update(subscriptions).set({ planCode: target, status: 'Active', billingInterval: targetInterval }).where(eq(subscriptions.id, sub.id));
    return { tenant_id: tenantId, plan: target, status: 'Active', billing_interval: targetInterval, proration, ...(prorationNote ? { proration_note: prorationNote } : {}) };
  }

  // ───────────────────── Plan limit enforcement ─────────────────────
  // Called by AdminUsersService.create() before inserting a new user.
  // Reads the tenant's active subscription + plan features and throws PLAN_USER_LIMIT when
  // the tenant has reached the maxUsers ceiling for their plan (-1 = unlimited).
  async checkUserLimit(tenantId: number): Promise<void> {
    const db = this.db;
    const [row] = await db
      .select({ features: plans.features, status: subscriptions.status, trialEndsAt: subscriptions.trialEndsAt })
      .from(subscriptions)
      .leftJoin(plans, eq(subscriptions.planCode, plans.code))
      .where(eq(subscriptions.tenantId, tenantId))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);

    if (!row) return; // no subscription yet (e.g. during provisioning) — fail-open

    // Active trials have full feature access until the trial window closes.
    if (row.status === 'Trialing') {
      if (row.trialEndsAt && Date.now() > new Date(row.trialEndsAt).getTime()) return; // expired trial blocks via PlanGuard, not here
      return;
    }

    const features: Record<string, unknown> = (row.features as Record<string, unknown> | null) ?? {};
    const maxUsers = typeof features.users === 'number' ? features.users : -1;
    if (maxUsers < 0) return; // -1 = unlimited (enterprise)

    const [{ count } = { count: '0' }] = await db
      .select({ count: sql<string>`count(*)` })
      .from(users)
      .where(and(eq(users.tenantId, tenantId)));

    const current = Number(count ?? 0);
    if (current >= maxUsers) {
      throw new ForbiddenException({
        code: 'PLAN_USER_LIMIT',
        message: `Your plan allows a maximum of ${maxUsers} user(s). You currently have ${current}. Please upgrade to add more users.`,
        messageTh: `แพ็กเกจของคุณรองรับผู้ใช้สูงสุด ${maxUsers} คน (ปัจจุบัน: ${current} คน) กรุณาอัปเกรดแพ็กเกจ`,
      });
    }
  }

  // 1.7 — resolve the amount to charge for (plan, interval, currency). THB prices come from
  // price_monthly / price_yearly; any other currency from the plan's `prices` map. Fails closed:
  // an interval/currency the plan does not offer is a 400, never a silent fallback to THB-monthly.
  private resolvePlanPrice(plan: { priceMonthly: unknown; priceYearly: unknown; prices: unknown }, interval: 'monthly' | 'annual', currency: string): { amount: number; currency: string; interval: 'monthly' | 'annual' } {
    const cur = (currency || 'THB').toUpperCase();
    if (cur === 'THB') {
      const amount = interval === 'annual' ? (plan.priceYearly != null ? Number(plan.priceYearly) : null) : Number(plan.priceMonthly ?? 0);
      if (interval === 'annual' && (amount == null || amount <= 0)) throw new BadRequestException({ code: 'ANNUAL_NOT_OFFERED', message: 'This plan is not offered on annual billing', messageTh: 'แพ็กเกจนี้ไม่มีแบบรายปี' });
      return { amount: Number(amount ?? 0), currency: 'THB', interval };
    }
    const priceMap = (plan.prices ?? {}) as Record<string, { monthly?: number; yearly?: number }>;
    const entry = priceMap[cur];
    const amount = interval === 'annual' ? entry?.yearly : entry?.monthly;
    if (amount == null || amount <= 0) throw new BadRequestException({ code: 'CURRENCY_NOT_OFFERED', message: `This plan is not offered in ${cur}${entry ? ` on ${interval} billing` : ''}`, messageTh: `แพ็กเกจนี้ไม่มีราคาสกุล ${cur}` });
    return { amount: Number(amount), currency: cur, interval };
  }

  // ───────────────────── Stripe checkout ─────────────────────
  // Creates a Stripe Checkout session for the selected plan. Without STRIPE_SECRET_KEY it returns a mock
  // URL so the SaaS flow is fully testable offline (CI/dev). With a key, it creates (or reuses) the tenant's
  // Stripe customer and a real subscription Checkout session; activation happens via the webhook (see
  // BillingWebhookService) when Stripe confirms payment. 1.7 — interval ('monthly' default | 'annual') and
  // currency ('THB' default) select the price via resolvePlanPrice (fail-closed) and are stamped on the
  // subscription row as the billing intent.
  async createCheckoutSession(tenantId: number, planCode: string, interval: 'monthly' | 'annual' = 'monthly', currency = 'THB') {
    const db = this.db;
    const target = planCode.trim();
    const [plan] = await db.select().from(plans).where(eq(plans.code, target)).limit(1);
    if (!plan) throw new BadRequestException({ code: 'BAD_REQUEST', message: `Unknown plan: ${target}`, messageTh: 'ไม่พบแพ็กเกจที่เลือก' });
    if (Number(plan.priceMonthly ?? 0) <= 0) throw new BadRequestException({ code: 'PLAN_NOT_PURCHASABLE', message: `Plan '${target}' has no monthly price to charge`, messageTh: 'แพ็กเกจนี้ไม่มีค่าบริการรายเดือนให้ชำระ' });
    const price = this.resolvePlanPrice(plan, interval, currency);
    const [tenant] = await db.select({ id: tenants.id, code: tenants.code }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Tenant not found', messageTh: 'ไม่พบร้าน' });
    // Reuse the tenant's existing Stripe customer (from a prior checkout) if we have one.
    const [sub] = await db.select({ id: subscriptions.id, cust: subscriptions.stripeCustomerId }).from(subscriptions).where(eq(subscriptions.tenantId, tenantId)).orderBy(desc(subscriptions.createdAt)).limit(1);
    const result = await this.stripe.createCheckoutSession(
      { code: plan.code, name: plan.name, amount: price.amount, currency: price.currency, interval: price.interval },
      { id: Number(tenant.id), code: tenant.code, existingCustomerId: sub?.cust ?? null },
    );
    // Persist the billing intent (interval/currency) + a freshly-created Stripe customer id so subsequent
    // checkouts reuse it (best-effort; the webhook is the source of truth for subscription state).
    if (sub) {
      const patch: Record<string, unknown> = { billingInterval: price.interval, currency: price.currency };
      if (result.customerId && !sub.cust) patch.stripeCustomerId = result.customerId;
      await db.update(subscriptions).set(patch).where(eq(subscriptions.id, sub.id));
    }
    return { url: result.url, mock: result.mock, interval: price.interval, currency: price.currency, amount: price.amount };
  }

  // ───────────────────── Stripe webhook → subscription state machine ─────────────────────
  // Maps a verified Stripe event to our subscription lifecycle. This is the source of truth for
  // Active/PastDue/Canceled (checkout creates the intent; Stripe confirms payment + renewals here).
  // Idempotent: re-delivering the same event converges to the same end state. All updates are scoped to a
  // single tenant by tenant_id / stripe_customer_id.
  async applyStripeEvent(event: { type?: string; data?: { object?: any } }): Promise<{ handled: boolean; tenant_id?: number; status?: string }> {
    const db = this.db;
    const obj = event?.data?.object ?? {};
    const setByTenant = (tenantId: number, patch: Record<string, unknown>) =>
      db.update(subscriptions).set(patch).where(eq(subscriptions.tenantId, tenantId));
    const tenantByCustomer = async (customerId: unknown): Promise<number | null> => {
      if (!customerId) return null;
      const [row] = await db.select({ t: subscriptions.tenantId }).from(subscriptions)
        .where(eq(subscriptions.stripeCustomerId, String(customerId))).orderBy(desc(subscriptions.createdAt)).limit(1);
      return row ? Number(row.t) : null;
    };
    const periodEnd = (unixSecs: unknown): Date | null => (unixSecs ? new Date(Number(unixSecs) * 1000) : null);

    switch (event?.type) {
      case 'checkout.session.completed': {
        const tenantId = Number(obj.metadata?.tenant_id ?? obj.client_reference_id);
        if (!Number.isFinite(tenantId)) return { handled: false };
        const patch: Record<string, unknown> = { status: 'Active' };
        if (obj.metadata?.plan_code) patch.planCode = String(obj.metadata.plan_code);
        if (obj.customer) patch.stripeCustomerId = String(obj.customer);
        if (obj.subscription) patch.stripeSubscriptionId = String(obj.subscription);
        await setByTenant(tenantId, patch);
        return { handled: true, tenant_id: tenantId, status: 'Active' };
      }
      case 'customer.subscription.updated': {
        const tenantId = (await tenantByCustomer(obj.customer)) ?? Number(obj.metadata?.tenant_id);
        if (!Number.isFinite(tenantId)) return { handled: false };
        const status = mapStripeStatus(String(obj.status ?? ''));
        const patch: Record<string, unknown> = { status, currentPeriodEnd: periodEnd(obj.current_period_end) };
        if (obj.id) patch.stripeSubscriptionId = String(obj.id);
        await setByTenant(tenantId as number, patch);
        return { handled: true, tenant_id: tenantId as number, status };
      }
      case 'customer.subscription.deleted': {
        const tenantId = await tenantByCustomer(obj.customer);
        if (tenantId == null) return { handled: false };
        await setByTenant(tenantId, { status: 'Canceled' });
        return { handled: true, tenant_id: tenantId, status: 'Canceled' };
      }
      case 'invoice.payment_failed': {
        const tenantId = await tenantByCustomer(obj.customer);
        if (tenantId == null) return { handled: false };
        await setByTenant(tenantId, { status: 'PastDue' });
        return { handled: true, tenant_id: tenantId, status: 'PastDue' };
      }
      default:
        return { handled: false };
    }
  }
}

// Map a Stripe subscription status to our 4-state lifecycle (fail-safe: anything not clearly active/trial
// restricts access rather than silently granting it).
export function mapStripeStatus(s: string): 'Trialing' | 'Active' | 'PastDue' | 'Canceled' {
  switch (s) {
    case 'trialing': return 'Trialing';
    case 'active': return 'Active';
    case 'canceled':
    case 'incomplete_expired': return 'Canceled';
    default: return 'PastDue'; // past_due / unpaid / incomplete / paused → restrict until resolved
  }
}

