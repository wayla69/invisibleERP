import { Inject, Injectable, ConflictException, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { eq, sql, and, desc, gt, isNull } from 'drizzle-orm';
import { randomBytes, createHash } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { plans, subscriptions, tenants, users, aiTokenUsage, aiOverageBillingRuns, signupInvites, signupRequests } from '../../database/schema';
import { PasswordService } from '../auth/password.service';
import { LedgerService } from '../ledger/ledger.service';
import { isIndustryKey } from '../ledger/coa-templates';
import { ymd } from '../../database/queries';
import { normalizeUsername } from '../../common/username';
import { isUniqueViolation } from '../../common/db-error';
import type { JwtUser } from '../../common/decorators';

// Public self-serve signup gate (ITGC-AC-18). Always allowed outside production (dev + harnesses run
// NODE_ENV=test); in production it is FAIL-CLOSED — enabled only when an operator sets PUBLIC_SIGNUP_ENABLED
// truthy. Pure + env-injectable so it can be unit-tested without booting the app.
export function isSignupAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== 'production') return true;
  return ['1', 'true', 'yes', 'on'].includes(String(env.PUBLIC_SIGNUP_ENABLED ?? '').trim().toLowerCase());
}

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
  // Invite-link onboarding (#2): a valid single-use token lets a company sign up even when public signup
  // is disabled. Consumed on success. Absent ⇒ normal PUBLIC_SIGNUP_ENABLED gate applies.
  invite_token?: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

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
    const db = this.db;
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
    const db = this.db;
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
    // ITGC-AC-18. Two ways in: (a) a valid single-use INVITE token (onboarding #2) lets this company through
    // even when public signup is disabled; else (b) the PUBLIC_SIGNUP_ENABLED gate applies — fail-closed in
    // prod (dev + harnesses NODE_ENV=test always allowed). See docs/ops/tenancy-model.md.
    const invite = dto.invite_token ? await this.validateInvite(dto.invite_token) : null;
    if (!invite && !isSignupAllowed()) {
      throw new ForbiddenException({
        code: 'SIGNUP_DISABLED',
        message: 'Public self-service signup is disabled — contact the administrator to be onboarded.',
        messageTh: 'ปิดรับสมัครบัญชีใหม่แบบสาธารณะ — โปรดติดต่อผู้ดูแลระบบเพื่อเปิดบัญชี',
      });
    }
    const result = await this.provisionTenant({ ...dto, plan_code: dto.plan_code ?? invite?.planCode ?? undefined });
    if (invite) await this.consumeInvite(invite.id, result.tenant_id);
    return result;
  }

  // ── Invite-link onboarding (#2) — platform-owner-issued, single-use, expiring tokens ──
  // Create an invite (returns the RAW token once — only its hash is stored). ttl_hours default 72.
  async createSignupInvite(opts: { createdBy: string; company_name?: string; plan_code?: string; email?: string; ttl_hours?: number }) {
    const rawToken = randomBytes(24).toString('hex'); // 48 hex chars
    const ttl = Math.min(Math.max(Number(opts.ttl_hours ?? 72), 1), 24 * 30); // 1h..30d
    const expiresAt = new Date(Date.now() + ttl * 60 * 60 * 1000);
    const [row] = await this.db.insert(signupInvites).values({
      tokenHash: sha256(rawToken), createdBy: opts.createdBy,
      companyName: opts.company_name ?? null, planCode: opts.plan_code ?? null, email: opts.email ?? null,
      expiresAt,
    }).returning({ id: signupInvites.id });
    return { id: Number(row!.id), invite_token: rawToken, expires_at: expiresAt.toISOString(),
      company_name: opts.company_name ?? null, email: opts.email ?? null };
  }

  // List invites with a computed status (pending | used | expired) for the console.
  async listSignupInvites() {
    const rows = await this.db.select().from(signupInvites).orderBy(desc(signupInvites.id)).limit(200);
    const now = Date.now();
    return {
      invites: rows.map((r: any) => ({
        id: Number(r.id), created_by: r.createdBy, company_name: r.companyName, email: r.email,
        expires_at: r.expiresAt, used_at: r.usedAt, used_tenant_id: r.usedTenantId != null ? Number(r.usedTenantId) : null,
        status: r.usedAt ? 'used' : (new Date(r.expiresAt).getTime() < now ? 'expired' : 'pending'),
      })),
    };
  }

  // Validate an invite token: must exist (by hash), be unused, and unexpired. Throws 400 INVALID_INVITE.
  private async validateInvite(rawToken: string) {
    const [inv] = await this.db.select({ id: signupInvites.id, planCode: signupInvites.planCode })
      .from(signupInvites)
      .where(and(eq(signupInvites.tokenHash, sha256(rawToken.trim())), isNull(signupInvites.usedAt), gt(signupInvites.expiresAt, new Date())))
      .limit(1);
    if (!inv) throw new BadRequestException({ code: 'INVALID_INVITE', message: 'Invite is invalid, already used, or expired', messageTh: 'ลิงก์เชิญไม่ถูกต้อง ถูกใช้ไปแล้ว หรือหมดอายุ' });
    return { id: Number(inv.id), planCode: inv.planCode as string | null };
  }

  // Mark an invite consumed (single-use guard: only if still unused).
  private async consumeInvite(id: number, tenantId: number) {
    await this.db.update(signupInvites).set({ usedAt: new Date(), usedTenantId: tenantId })
      .where(and(eq(signupInvites.id, id), isNull(signupInvites.usedAt)));
  }

  // ── Approval-queue onboarding (#3) — a PUBLIC request creates a PENDING row (no tenant); a platform
  // owner approves (→ provisions) or rejects. The requester's password is stored HASHED here. ──
  async createSignupRequest(dto: SignupDto) {
    const code = dto.tenant_code.trim();
    const username = normalizeUsername(dto.admin_username);
    // fail fast on collisions with an existing LIVE tenant/user (the partial unique indexes block dup PENDING)
    const [t] = await this.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, code)).limit(1);
    if (t) throw new ConflictException({ code: 'CONFLICT', message: 'Tenant code already taken', messageTh: 'รหัสร้านนี้ถูกใช้แล้ว' });
    const [u] = await this.db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (u) throw new ConflictException({ code: 'CONFLICT', message: 'Username already taken', messageTh: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว' });
    const industry = isIndustryKey(dto.industry) ? dto.industry : 'general';
    try {
      const [row] = await this.db.insert(signupRequests).values({
        companyName: dto.company_name, tenantCode: code, adminUsername: username,
        passwordHash: await this.password.hash(dto.admin_password), email: dto.email, industry, status: 'pending',
      }).returning({ id: signupRequests.id });
      return { request_id: Number(row!.id), status: 'pending' };
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'REQUEST_PENDING', message: 'A pending request already exists for this company/username', messageTh: 'มีคำขอเปิดบัญชีนี้รออนุมัติอยู่แล้ว' });
      throw e;
    }
  }

  async listSignupRequests(status?: string) {
    const rows = await this.db.select().from(signupRequests)
      .where(status ? eq(signupRequests.status, status) : undefined)
      .orderBy(desc(signupRequests.id)).limit(200);
    return {
      requests: rows.map((r: any) => ({
        id: Number(r.id), company_name: r.companyName, tenant_code: r.tenantCode, admin_username: r.adminUsername,
        email: r.email, industry: r.industry, status: r.status, reject_reason: r.rejectReason,
        reviewed_by: r.reviewedBy, reviewed_at: r.reviewedAt, requested_at: r.requestedAt,
        created_tenant_id: r.createdTenantId != null ? Number(r.createdTenantId) : null,
      })),
    };
  }

  // Approve a pending request → provision the company with the stored (already-hashed) password. Marks the
  // row approved atomically (only if still pending) to avoid a double-provision race.
  async approveSignupRequest(id: number, reviewedBy: string) {
    const [req] = await this.db.select().from(signupRequests).where(eq(signupRequests.id, id)).limit(1);
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Request not found', messageTh: 'ไม่พบคำขอ' });
    if (req.status !== 'pending') throw new ConflictException({ code: 'REQUEST_NOT_PENDING', message: `Request already ${req.status}`, messageTh: 'คำขอนี้ถูกดำเนินการไปแล้ว' });
    // claim the row first (pending → approved); if 0 rows updated, someone else took it.
    const claimed = await this.db.update(signupRequests).set({ status: 'approved', reviewedBy, reviewedAt: new Date() })
      .where(and(eq(signupRequests.id, id), eq(signupRequests.status, 'pending'))).returning({ id: signupRequests.id });
    if (!claimed.length) throw new ConflictException({ code: 'REQUEST_NOT_PENDING', message: 'Request already handled', messageTh: 'คำขอนี้ถูกดำเนินการไปแล้ว' });
    const result = await this.provisionTenant(
      { company_name: req.companyName, tenant_code: req.tenantCode, admin_username: req.adminUsername, admin_password: '', email: req.email, industry: req.industry ?? undefined },
      { passwordHash: req.passwordHash },
    );
    await this.db.update(signupRequests).set({ createdTenantId: result.tenant_id }).where(eq(signupRequests.id, id));
    return { ...result, request_id: id, status: 'approved' };
  }

  async rejectSignupRequest(id: number, reviewedBy: string, reason?: string) {
    const claimed = await this.db.update(signupRequests).set({ status: 'rejected', reviewedBy, reviewedAt: new Date(), rejectReason: reason ?? null })
      .where(and(eq(signupRequests.id, id), eq(signupRequests.status, 'pending'))).returning({ id: signupRequests.id });
    if (!claimed.length) throw new ConflictException({ code: 'REQUEST_NOT_PENDING', message: 'Request not pending', messageTh: 'คำขอนี้ไม่อยู่ในสถานะรออนุมัติ' });
    return { request_id: id, status: 'rejected' };
  }

  // Core provisioning — tenant + its OWN org + an Admin + a trialing subscription + fiscal year + industry
  // CoA — shared by the PUBLIC signup path (gated above) and the AUTHENTICATED platform-admin create-company
  // endpoint (POST /api/admin/tenants). No public-signup gate here; each caller gates as appropriate. Runs
  // under whatever RLS scope the request carries: public signup is pre-auth (bypass); the admin endpoint
  // runs with the platform-admin bypass granted by PlatformAdminGuard (both can write a brand-new tenant_id).
  async provisionTenant(dto: SignupDto, opts?: { passwordHash?: string }) {
    const db = this.db;
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

    const passwordHash = opts?.passwordHash ?? await this.password.hash(dto.admin_password);
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

      // Multi-company tenancy (ITGC-AC-18): give each new company its OWN org — org_id = its own tenant id.
      // Under TENANCY_MODE=multi-company this keeps the new Admin org-scoped to just this company (isolated
      // from every other tenant), and lets future sibling accounts join by sharing this org_id. It also
      // means new signups never need the org_id backfill the multi-company boot warning asks about.
      const orgId = Number(t.id);
      await tx.update(tenants).set({ orgId }).where(eq(tenants.id, orgId));

      await tx.insert(users).values({
        username, passwordHash, role: 'Admin', tenantId: Number(t.id), orgId,
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
    const db = this.db;
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
      const charge = await new StripeBilling().createOverageInvoiceItem(s.cust ?? null, inv.amount, inv.line_description, `ai-overage:${tenantId}:${billingMonth}`);
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

  async changePlan(tenantId: number, planCode: string) {
    const db = this.db;
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

    const features: Record<string, unknown> = (row.features as any) ?? {};
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

  // ───────────────────── Stripe checkout ─────────────────────
  // Creates a Stripe Checkout session for the selected plan. Without STRIPE_SECRET_KEY it returns a mock
  // URL so the SaaS flow is fully testable offline (CI/dev). With a key, it creates (or reuses) the tenant's
  // Stripe customer and a real subscription Checkout session; activation happens via the webhook (see
  // BillingWebhookService) when Stripe confirms payment.
  async createCheckoutSession(tenantId: number, planCode: string) {
    const db = this.db;
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

  // Append a one-off invoice ITEM for metered AI overage to the customer's next subscription invoice. Stripe
  // attaches a pending invoice item to the customer's upcoming invoice automatically. Without a key (or with
  // no customer) it's a no-op mock so the monthly job is fully testable offline. The idempotencyKey is a
  // second guard (alongside the DB UNIQUE(tenant, month)) so a retried run never double-charges.
  async createOverageInvoiceItem(
    customerId: string | null,
    amountTHB: number,
    description: string,
    idempotencyKey: string,
  ): Promise<{ id: string | null; mock: boolean }> {
    if (!this.secret || !customerId || amountTHB <= 0) return { id: null, mock: true };
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(this.secret);
    const item = await stripe.invoiceItems.create(
      { customer: customerId, amount: Math.round(amountTHB * 100), currency: 'thb', description },
      { idempotencyKey },
    );
    return { id: item.id, mock: false };
  }
}
