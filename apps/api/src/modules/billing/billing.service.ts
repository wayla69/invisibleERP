import { Inject, Injectable, ConflictException, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { eq, sql, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { plans, subscriptions, tenants, users, aiTokenUsage } from '../../database/schema';
import { PasswordService } from '../auth/password.service';
import { LedgerService } from '../ledger/ledger.service';
import { isIndustryKey } from '../ledger/coa-templates';
import { ymd } from '../../database/queries';
import { normalizeUsername } from '../../common/username';

export interface SignupDto {
  company_name: string;
  tenant_code: string;
  admin_username: string;
  admin_password: string;
  email: string;
  plan_code?: string;
  // industry CoA template the company picks at signup (GL-10): restaurant|retail|distribution|services|
  // general. Falls back to 'general' (full canonical chart) when omitted/unknown.
  industry?: string;
  // optional tax identity (the setup wizard can fill these later via PATCH /api/tenant/profile)
  legal_name?: string;
  tax_id?: string;
  vat_registered?: boolean;
  vat_rate?: number;
}

interface PlanSeed {
  code: string;
  name: string;
  priceMonthly: string;
  currency: string;
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
const PLAN_SEED: PlanSeed[] = [
  { code: 'free', name: 'Free', priceMonthly: '0', currency: 'THB', features: { users: 2, locations: 1, ai_chat: false, reports: 'basic', ai_tokens_daily: 0, ai_tokens_daily_max: 0, ai_overage_rate_thb_per_1k: 0 } },
  { code: 'starter', name: 'Starter', priceMonthly: '990', currency: 'THB', features: { users: 5, locations: 1, ai_chat: false, reports: 'standard', ai_tokens_daily: 0, ai_tokens_daily_max: 0, ai_overage_rate_thb_per_1k: 0 } },
  { code: 'pro', name: 'Pro', priceMonthly: '2900', currency: 'THB', features: { users: 25, locations: 5, ai_chat: true, reports: 'advanced', ai_tokens_daily: 200_000, ai_tokens_daily_max: 500_000, ai_overage_rate_thb_per_1k: 12 } },
  { code: 'enterprise', name: 'Enterprise', priceMonthly: '0', currency: 'THB', features: { users: -1, locations: -1, ai_chat: true, reports: 'advanced', custom: true, ai_tokens_daily: 2_000_000, ai_tokens_daily_max: 5_000_000, ai_overage_rate_thb_per_1k: 8 } },
];

const TRIAL_DAYS = 14;

@Injectable()
export class BillingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly password: PasswordService,
    @Optional() private readonly ledger?: LedgerService, // optional so hand-constructed test instances still work
  ) {}

  // ───────────────────── Seed (idempotent — run at startup) ─────────────────────
  async seedPlans(): Promise<{ seeded: number }> {
    const db = this.db as any;
    let seeded = 0;
    for (const p of PLAN_SEED) {
      await db.insert(plans).values({
        code: p.code, name: p.name, priceMonthly: p.priceMonthly, currency: p.currency, features: p.features, active: 'true',
      }).onConflictDoUpdate({
        target: plans.code,
        set: { name: p.name, priceMonthly: p.priceMonthly, currency: p.currency, features: p.features, active: 'true' },
      });
      seeded++;
    }
    return { seeded };
  }

  // ───────────────────── PUBLIC plan catalogue ─────────────────────
  async listPlans() {
    const db = this.db as any;
    const rows = await db
      .select({ code: plans.code, name: plans.name, price_monthly: plans.priceMonthly, currency: plans.currency, features: plans.features, active: plans.active })
      .from(plans)
      .where(sql`${plans.active}::text = 'true'`)
      .orderBy(sql`${plans.priceMonthly} asc`);
    return { plans: rows.map((r: any) => ({ ...r, price_monthly: Number(r.price_monthly ?? 0) })) };
  }

  // ───────────────────── PUBLIC self-serve signup ─────────────────────
  // Atomic provisioning: tenant + admin user + trialing subscription.
  async signup(dto: SignupDto) {
    const db = this.db as any;
    const code = dto.tenant_code.trim();
    const username = normalizeUsername(dto.admin_username);
    const planCode = dto.plan_code?.trim() || 'free';

    // tenant code must be unique
    const [existsTenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, code)).limit(1);
    if (existsTenant) throw new ConflictException({ code: 'CONFLICT', message: 'Tenant code already taken', messageTh: 'รหัสร้านนี้ถูกใช้แล้ว' });

    // username must be unique (users.username is globally unique)
    const [existsUser] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (existsUser) throw new ConflictException({ code: 'CONFLICT', message: 'Username already taken', messageTh: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว' });

    // plan must exist
    const [plan] = await db.select().from(plans).where(eq(plans.code, planCode)).limit(1);
    if (!plan) throw new BadRequestException({ code: 'BAD_REQUEST', message: `Unknown plan: ${planCode}`, messageTh: 'ไม่พบแพ็กเกจที่เลือก' });

    const passwordHash = await this.password.hash(dto.admin_password);
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const industry = isIndustryKey(dto.industry) ? dto.industry : 'general';

    const tenant = await db.transaction(async (tx: any) => {
      const [t] = await tx.insert(tenants).values({
        code, name: dto.company_name, contactName: username, email: dto.email, industry,
        // tax identity — legalName defaults to the company name; the rest the setup wizard completes
        legalName: dto.legal_name ?? dto.company_name,
        taxId: dto.tax_id ?? null,
        vatRegistered: dto.vat_registered ?? false,
        vatRate: dto.vat_rate != null ? String(dto.vat_rate) : '0.0700',
      }).returning({ id: tenants.id, code: tenants.code, name: tenants.name });

      await tx.insert(users).values({
        username, passwordHash, role: 'Admin', tenantId: Number(t.id),
      });

      await tx.insert(subscriptions).values({
        tenantId: Number(t.id), planCode, status: 'Trialing', trialEndsAt,
      });

      return t;
    });

    // provision the current fiscal year's periods so the new tenant can post immediately (A4),
    // then materialise the chosen industry Chart-of-Accounts template into the tenant's overlay (GL-10).
    if (this.ledger) {
      await this.ledger.provisionFiscalYear(Number(ymd().slice(0, 4)), Number(tenant.id));
      await this.ledger.provisionTenantCoA(Number(tenant.id), industry);
    }

    return {
      tenant_id: Number(tenant.id),
      tenant_code: tenant.code,
      tenant_name: tenant.name,
      admin_username: username,
      plan: planCode,
      industry,
      trial_ends_at: trialEndsAt.toISOString(),
      fiscal_year_provisioned: Number(ymd().slice(0, 4)),
    };
  }

  // Resolve the tenantId for an authenticated user. Admins created via signup carry
  // tenantId on their users row; customer users carry it via customerName (tenant code).
  async resolveTenantId(user: { username: string; customerName: string | null }): Promise<number> {
    const db = this.db as any;
    if (user.customerName) {
      const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, user.customerName)).limit(1);
      if (t) return Number(t.id);
    }
    const [u] = await db.select({ tenantId: users.tenantId }).from(users).where(eq(users.username, user.username)).limit(1);
    if (!u || u.tenantId == null) throw new NotFoundException({ code: 'NO_TENANT', message: 'No tenant resolved for user', messageTh: 'ไม่พบร้านของผู้ใช้' });
    return Number(u.tenantId);
  }

  // ───────────────────── Subscription read / change ─────────────────────
  async getSubscription(tenantId: number) {
    const db = this.db as any;
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
    const db = this.db as any;
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
    const db = this.db as any;
    const ym = (month && /^\d{4}-\d{2}$/.test(month)) ? month : null;
    const [planRow] = await db.select({ features: plans.features, plan_code: subscriptions.planCode })
      .from(subscriptions).leftJoin(plans, eq(subscriptions.planCode, plans.code))
      .where(and(eq(subscriptions.tenantId, tenantId), sql`${subscriptions.status} in ('Active','Trialing')`))
      .orderBy(desc(subscriptions.createdAt)).limit(1);
    const features: any = planRow?.features ?? {};
    const overageRate = Number(features.ai_overage_rate_thb_per_1k ?? 0); // THB / 1,000 overage tokens
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

  async changePlan(tenantId: number, planCode: string) {
    const db = this.db as any;
    const target = planCode.trim();
    const [plan] = await db.select().from(plans).where(eq(plans.code, target)).limit(1);
    if (!plan) throw new BadRequestException({ code: 'BAD_REQUEST', message: `Unknown plan: ${target}`, messageTh: 'ไม่พบแพ็กเกจที่เลือก' });

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId)).orderBy(sql`${subscriptions.createdAt} desc`).limit(1);
    if (!sub) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No subscription for tenant', messageTh: 'ไม่พบการสมัครสมาชิกของร้าน' });

    await db.update(subscriptions).set({ planCode: target, status: 'Active' }).where(eq(subscriptions.id, sub.id));
    return { tenant_id: tenantId, plan: target, status: 'Active' };
  }

  // ───────────────────── Plan limit enforcement ─────────────────────
  // Called by AdminUsersService.create() before inserting a new user.
  // Reads the tenant's active subscription + plan features and throws PLAN_USER_LIMIT when
  // the tenant has reached the maxUsers ceiling for their plan (-1 = unlimited).
  async checkUserLimit(tenantId: number): Promise<void> {
    const db = this.db as any;
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

    const features: Record<string, unknown> = (row.features as any) ?? {};
    const maxUsers = typeof features.users === 'number' ? features.users : -1;
    if (maxUsers < 0) return; // -1 = unlimited (enterprise)

    const [{ count }] = await db
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

  // ───────────────────── Stripe checkout ─────────────────────
  // Creates a Stripe Checkout session for the selected plan. Without STRIPE_SECRET_KEY it returns a mock
  // URL so the SaaS flow is fully testable offline (CI/dev). With a key, it creates (or reuses) the tenant's
  // Stripe customer and a real subscription Checkout session; activation happens via the webhook (see
  // BillingWebhookService) when Stripe confirms payment.
  async createCheckoutSession(tenantId: number, planCode: string) {
    const db = this.db as any;
    const target = planCode.trim();
    const [plan] = await db.select().from(plans).where(eq(plans.code, target)).limit(1);
    if (!plan) throw new BadRequestException({ code: 'BAD_REQUEST', message: `Unknown plan: ${target}`, messageTh: 'ไม่พบแพ็กเกจที่เลือก' });
    if (Number(plan.priceMonthly ?? 0) <= 0) throw new BadRequestException({ code: 'PLAN_NOT_PURCHASABLE', message: `Plan '${target}' has no monthly price to charge`, messageTh: 'แพ็กเกจนี้ไม่มีค่าบริการรายเดือนให้ชำระ' });
    const [tenant] = await db.select({ id: tenants.id, code: tenants.code }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Tenant not found', messageTh: 'ไม่พบร้าน' });
    // Reuse the tenant's existing Stripe customer (from a prior checkout) if we have one.
    const [sub] = await db.select({ cust: subscriptions.stripeCustomerId }).from(subscriptions).where(eq(subscriptions.tenantId, tenantId)).orderBy(desc(subscriptions.createdAt)).limit(1);
    const result = await new StripeBilling().createCheckoutSession(
      { code: plan.code, name: plan.name, priceMonthly: String(plan.priceMonthly ?? '0'), currency: plan.currency ?? 'THB' },
      { id: Number(tenant.id), code: tenant.code, existingCustomerId: sub?.cust ?? null },
    );
    // Persist a freshly-created Stripe customer id so subsequent checkouts reuse it (best-effort; the
    // webhook is the source of truth for subscription state).
    if (result.customerId && sub && !sub.cust) {
      await db.update(subscriptions).set({ stripeCustomerId: result.customerId }).where(eq(subscriptions.tenantId, tenantId));
    }
    return { url: result.url, mock: result.mock };
  }

  // ───────────────────── Stripe webhook → subscription state machine ─────────────────────
  // Maps a verified Stripe event to our subscription lifecycle. This is the source of truth for
  // Active/PastDue/Canceled (checkout creates the intent; Stripe confirms payment + renewals here).
  // Idempotent: re-delivering the same event converges to the same end state. All updates are scoped to a
  // single tenant by tenant_id / stripe_customer_id.
  async applyStripeEvent(event: { type?: string; data?: { object?: any } }): Promise<{ handled: boolean; tenant_id?: number; status?: string }> {
    const db = this.db as any;
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

/**
 * Stripe billing adapter. Without STRIPE_SECRET_KEY it returns a mock checkout URL so the SaaS flow is
 * fully testable offline. With a key set, it calls the real Stripe SDK (dynamic import — never hard-require
 * 'stripe' at module load, so a deploy without billing configured still boots).
 */
export class StripeBilling {
  private readonly secret = process.env.STRIPE_SECRET_KEY;
  get enabled(): boolean { return !!this.secret; }

  async createCheckoutSession(
    plan: { code: string; name: string; priceMonthly: string; currency: string },
    tenant: { id: number; code: string; existingCustomerId?: string | null },
  ): Promise<{ url: string; mock: boolean; customerId?: string; sessionId?: string }> {
    if (!this.secret) {
      return { url: `https://billing.example/checkout/${plan.code}`, mock: true };
    }
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(this.secret);
    const customerId =
      tenant.existingCustomerId ??
      (await stripe.customers.create({ name: tenant.code, metadata: { tenant_id: String(tenant.id), tenant_code: tenant.code } })).id;
    const appBase = process.env.APP_BASE_URL ?? 'http://localhost:3000';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: String(tenant.id),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: (plan.currency ?? 'THB').toLowerCase(),
            recurring: { interval: 'month' },
            unit_amount: Math.round(Number(plan.priceMonthly) * 100), // smallest currency unit
            product_data: { name: `Oshinei ERP — ${plan.name}` },
          },
        },
      ],
      metadata: { tenant_id: String(tenant.id), plan_code: plan.code },
      success_url: process.env.STRIPE_SUCCESS_URL ?? `${appBase}/settings/billing?status=success`,
      cancel_url: process.env.STRIPE_CANCEL_URL ?? `${appBase}/settings/billing?status=cancel`,
    });
    return { url: session.url ?? `${appBase}/settings/billing`, mock: false, customerId, sessionId: session.id };
  }
}
