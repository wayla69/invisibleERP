import { Inject, Injectable, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { eq, sql, and, desc } from 'drizzle-orm';
import { DRIZZLE, runGlobalDb, type DrizzleDb } from '../../database/database.module';
import { plans, subscriptions, tenants, users } from '../../database/schema';
import { PasswordService } from '../auth/password.service';
import { LedgerService } from '../ledger/ledger.service';
import type { JwtUser } from '../../common/decorators';
import { PLAN_SUITES, isAddonKey } from '@ierp/shared';
import { computeProration } from './proration';
import { PlatformNotificationsService } from '../platform-notifications/platform-notifications.module';
import { MailerService } from '../mailer/mailer.service';
import { StripeBilling } from './stripe-gateway';
import { TenantProvisioningService, type SignupDto } from './tenant-provisioning.service';
import { PlatformAdminService } from './platform-admin.service';
import { BillingMeteringService } from './billing-metering.service';
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
  // SME single-operator edition (docs/49 / docs/36 §SME): the default plan a control_profile='sme' company
  // provisions onto. Full day-to-day operational ERP (PLAN_SUITES.sme) at a solo price, capped to ONE seat +
  // ONE location — the seat cap is the commercial fence vs Enterprise (per-seat). Volume caps are generous
  // for a solo operator; AI is metered as overage. The self-approval relaxation is control_profile, not a
  // plan feature, so it stays orthogonal (a company could in principle run 'sme' profile on any plan).
  { code: 'sme', name: 'SME (เจ้าของคนเดียว)', priceMonthly: '690', priceYearly: '6900', currency: 'THB', prices: { USD: { monthly: 20, yearly: 200 } }, features: { suites: PLAN_SUITES.sme, users: 1, locations: 1, ai_chat: true, reports: 'standard', ai_tokens_daily: 100_000, ai_tokens_daily_max: 200_000, ai_overage_rate_thb_per_1k: 12, etax_docs_monthly: 200, pos_txns_monthly: 5000, etax_overage_rate_thb_per_doc: 3, pos_overage_rate_thb_per_txn: 0.5 } },
  { code: 'starter', name: 'Standard', priceMonthly: '2900', priceYearly: '29000', currency: 'THB', prices: { USD: { monthly: 85, yearly: 850 } }, features: { suites: PLAN_SUITES.starter, users: 10, locations: 2, ai_chat: false, reports: 'standard', ai_tokens_daily: 0, ai_tokens_daily_max: 0, ai_overage_rate_thb_per_1k: 0, etax_docs_monthly: 100, pos_txns_monthly: 3000, etax_overage_rate_thb_per_doc: 3, pos_overage_rate_thb_per_txn: 0.5 } },
  // 1.9 — Business mid-tier: closes the Standard→Professional price cliff (2,900 → 9,900 was a 3.4× jump
  // with no rung). Standard + procurement + multi-branch; planning/loyalty/AI stay Professional-only.
  { code: 'business', name: 'Business', priceMonthly: '4900', priceYearly: '49000', currency: 'THB', prices: { USD: { monthly: 140, yearly: 1400 } }, features: { suites: PLAN_SUITES.business, users: 25, locations: 5, ai_chat: false, reports: 'standard', ai_tokens_daily: 0, ai_tokens_daily_max: 0, ai_overage_rate_thb_per_1k: 0, etax_docs_monthly: 300, pos_txns_monthly: 10_000, etax_overage_rate_thb_per_doc: 2.5, pos_overage_rate_thb_per_txn: 0.4 } },
  { code: 'pro', name: 'Professional', priceMonthly: '9900', priceYearly: '99000', currency: 'THB', prices: { USD: { monthly: 285, yearly: 2850 } }, features: { suites: PLAN_SUITES.pro, users: 50, locations: 10, ai_chat: true, reports: 'advanced', ai_tokens_daily: 200_000, ai_tokens_daily_max: 500_000, ai_overage_rate_thb_per_1k: 12, etax_docs_monthly: 1000, pos_txns_monthly: 30_000, etax_overage_rate_thb_per_doc: 2, pos_overage_rate_thb_per_txn: 0.3 } },
  // 0451 — Franchise (multi-brand): the /plans configurator's 4th pack, between Professional and
  // Enterprise. Professional + central-kitchen verticals (manufacturing, projects) + every add-on suite.
  { code: 'franchise', name: 'Franchise', priceMonthly: '14900', priceYearly: '149000', currency: 'THB', prices: { USD: { monthly: 425, yearly: 4250 } }, features: { suites: PLAN_SUITES.franchise, users: 100, locations: 25, ai_chat: true, reports: 'advanced', ai_tokens_daily: 500_000, ai_tokens_daily_max: 1_000_000, ai_overage_rate_thb_per_1k: 10, etax_docs_monthly: 3000, pos_txns_monthly: 100_000, etax_overage_rate_thb_per_doc: 1.5, pos_overage_rate_thb_per_txn: 0.25 } },
  { code: 'enterprise', name: 'Enterprise', priceMonthly: '0', currency: 'THB', features: { suites: PLAN_SUITES.enterprise, users: -1, locations: -1, ai_chat: true, reports: 'advanced', custom: true, ai_tokens_daily: 2_000_000, ai_tokens_daily_max: 5_000_000, ai_overage_rate_thb_per_1k: 8, etax_docs_monthly: -1, pos_txns_monthly: -1, etax_overage_rate_thb_per_doc: 0, pos_overage_rate_thb_per_txn: 0 } },
];


@Injectable()
export class BillingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly password: PasswordService,
    @Optional() private readonly ledger?: LedgerService, // optional so hand-constructed test instances still work
    @Optional() private readonly platformNotifs?: PlatformNotificationsService, // god event feed; optional for partial harnesses
    @Optional() private readonly mailer?: MailerService, // A1 transactional email; optional for partial harnesses
  ) {
    this.provisioning = new TenantProvisioningService(db, password, ledger, platformNotifs, mailer);
    this.platformAdmin = new PlatformAdminService(db, platformNotifs);
    this.metering = new BillingMeteringService(db, this.stripe);
  }

  // ONE Stripe adapter instance for every billing path (docs/46 Phase 4c cut 1 — was `new StripeBilling()`
  // at each call site). Env-driven (STRIPE_SECRET_KEY), so a single shared instance is safe.
  private readonly stripe = new StripeBilling();
  private readonly provisioning: TenantProvisioningService;
  private readonly platformAdmin: PlatformAdminService;
  private readonly metering: BillingMeteringService;

  // ───────────────────── Seed (idempotent — run at startup) ─────────────────────
  async seedPlans(): Promise<{ seeded: number }> {
    // Boot seed of the GLOBAL plan catalogue (`plans` has no tenant_id — a platform-level table, like currency
    // codes). Runs at startup with no request/tenant context, so it's declared global for STRICT_TENANT_PROXY.
    return runGlobalDb('billing:seed-plans', async () => {
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
    });
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




  // ───────────────────── Platform console — docs/46 Phase 4c cut 3 ─────────────────────
  // Cross-company directory/tags/AI-spend/detail/trial/suspend live in PlatformAdminService
  // (ctor-BODY construction). Thin delegators keep the console endpoints byte-identical.
  listTenants(includeDeleted = false) { return this.platformAdmin.listTenants(includeDeleted); }
  setTenantTags(id: number, tags: string[]) { return this.platformAdmin.setTenantTags(id, tags); }
  aiUsageByTenant() { return this.platformAdmin.aiUsageByTenant(); }
  getTenantDetail(id: number) { return this.platformAdmin.getTenantDetail(id); }
  extendTrial(id: number, days: number) { return this.platformAdmin.extendTrial(id, days); }
  suspendTenant(id: number, by: string, reason?: string) { return this.platformAdmin.suspendTenant(id, by, reason); }
  reactivateTenant(id: number, by: string) { return this.platformAdmin.reactivateTenant(id, by); }
  // SME single-user edition (docs/49) — upgrade-only profile transition + platform SME defaults.
  upgradeControlProfile(id: number, target: 'enterprise', actor: string) { return this.platformAdmin.upgradeControlProfile(id, target, actor); }
  setTenantSmePrefs(id: number, b: { hidden_nav_groups?: string[]; accountant_email?: string | null }, actor: string) { return this.platformAdmin.setTenantSmePrefs(id, b, actor); }
  getSmeDefaults() { return this.platformAdmin.getSmeDefaults(); }
  setSmeDefaults(b: { hidden_nav_groups?: string[]; accountant_email?: string | null }, actor: string) { return this.platformAdmin.setSmeDefaults(b, actor); }

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
        addons: subscriptions.addons, // 0451 — purchased à-la-carte add-on suite keys
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



  // ───────────────────── Usage metering — docs/46 Phase 4c cut 4 ─────────────────────
  // AI-token + e-Tax/POS meters, overage invoice lines and the idempotent monthly billing runs live in
  // BillingMeteringService (ctor-BODY construction, shared Stripe gateway). Thin delegators.
  aiUsage(tenantId: number) { return this.metering.aiUsage(tenantId); }
  aiOverageInvoice(tenantId: number, month?: string) { return this.metering.aiOverageInvoice(tenantId, month); }
  runAiOverageBilling(user: JwtUser, month?: string) { return this.metering.runAiOverageBilling(user, month); }
  listOverageRuns(tenantId: number, month?: string) { return this.metering.listOverageRuns(tenantId, month); }
  usageOverageInvoice(tenantId: number, meter: string, month?: string) { return this.metering.usageOverageInvoice(tenantId, meter, month); }
  runUsageOverageBilling(user: JwtUser, month?: string) { return this.metering.runUsageOverageBilling(user, month); }
  listUsageOverageRuns(tenantId: number, meter?: string, month?: string) { return this.metering.listUsageOverageRuns(tenantId, meter, month); }
  usageSummary(tenantId: number, month?: string) { return this.metering.usageSummary(tenantId, month); }

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

  // 0451 — set a company's à-la-carte add-ons (the /plans configurator's advanced add-ons). Replaces the
  // whole set; add-on suite keys union into the tenant's entitled suites on top of the plan at request
  // time (resolveEntitledSuites), so this takes effect immediately without touching the plan row.
  async setTenantAddons(tenantId: number, addons: string[]) {
    const db = this.db;
    const invalid = addons.filter((a) => !isAddonKey(a));
    if (invalid.length) throw new BadRequestException({ code: 'UNKNOWN_ADDON', message: `Unknown add-on(s): ${invalid.join(', ')}`, messageTh: 'ไม่รู้จักโมดูลเสริมที่เลือก' });
    const [sub] = await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.tenantId, tenantId)).orderBy(sql`${subscriptions.createdAt} desc`).limit(1);
    if (!sub) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No subscription for tenant', messageTh: 'ไม่พบการสมัครสมาชิกของร้าน' });
    const set = [...new Set(addons.filter(isAddonKey))];
    await db.update(subscriptions).set({ addons: set.length ? set : null }).where(eq(subscriptions.id, sub.id));
    return { tenant_id: tenantId, addons: set };
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
    // @NoTx Stripe webhook (system caller, no tenant context): resolve the tenant from the Stripe customer/
    // metadata, then every write is scoped EXPLICITLY by tenant_id. Declared global so the fail-closed proxy
    // (STRICT_TENANT_PROXY) permits the base-pool access.
    return runGlobalDb('billing:stripe-event', async () => {
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
    });
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

