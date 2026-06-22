import { Inject, Injectable, ConflictException, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { plans, subscriptions, tenants, users } from '../../database/schema';
import { PasswordService } from '../auth/password.service';
import { LedgerService } from '../ledger/ledger.service';
import { ymd } from '../../database/queries';

export interface SignupDto {
  company_name: string;
  tenant_code: string;
  admin_username: string;
  admin_password: string;
  email: string;
  plan_code?: string;
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

const PLAN_SEED: PlanSeed[] = [
  { code: 'free', name: 'Free', priceMonthly: '0', currency: 'THB', features: { users: 2, locations: 1, ai_chat: false, reports: 'basic' } },
  { code: 'starter', name: 'Starter', priceMonthly: '990', currency: 'THB', features: { users: 5, locations: 1, ai_chat: false, reports: 'standard' } },
  { code: 'pro', name: 'Pro', priceMonthly: '2900', currency: 'THB', features: { users: 25, locations: 5, ai_chat: true, reports: 'advanced' } },
  { code: 'enterprise', name: 'Enterprise', priceMonthly: '0', currency: 'THB', features: { users: -1, locations: -1, ai_chat: true, reports: 'advanced', custom: true } },
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
    const username = dto.admin_username.trim();
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

    const tenant = await db.transaction(async (tx: any) => {
      const [t] = await tx.insert(tenants).values({
        code, name: dto.company_name, contactName: username, email: dto.email,
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

    // provision the current fiscal year's periods so the new tenant can post immediately (A4)
    if (this.ledger) await this.ledger.provisionFiscalYear(Number(ymd().slice(0, 4)), Number(tenant.id));

    return {
      tenant_id: Number(tenant.id),
      tenant_code: tenant.code,
      tenant_name: tenant.name,
      admin_username: username,
      plan: planCode,
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

  // ───────────────────── Stripe checkout (stub) ─────────────────────
  // Mock unless STRIPE_SECRET_KEY is set; real SDK wired here later (not hard-required).
  async createCheckoutSession(tenantId: number, planCode: string) {
    const db = this.db as any;
    const target = planCode.trim();
    const [plan] = await db.select().from(plans).where(eq(plans.code, target)).limit(1);
    if (!plan) throw new BadRequestException({ code: 'BAD_REQUEST', message: `Unknown plan: ${target}`, messageTh: 'ไม่พบแพ็กเกจที่เลือก' });
    const [tenant] = await db.select({ id: tenants.id, code: tenants.code }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Tenant not found', messageTh: 'ไม่พบร้าน' });
    return new StripeBilling().createCheckoutSession(target, { id: Number(tenant.id), code: tenant.code });
  }
}

/**
 * Stripe billing adapter. Without STRIPE_SECRET_KEY it returns a mock checkout URL
 * so the SaaS flow is fully testable offline. With a key set, wire the real Stripe
 * SDK here (dynamic import — do not hard-require 'stripe' at module load).
 */
export class StripeBilling {
  private readonly secret = process.env.STRIPE_SECRET_KEY;

  async createCheckoutSession(planCode: string, tenant: { id: number; code: string }): Promise<{ url: string; mock: boolean }> {
    if (!this.secret) {
      return { url: `https://billing.example/checkout/${planCode}`, mock: true };
    }
    // Real Stripe (interface for future wiring):
    //   const Stripe = (await import('stripe')).default;
    //   const stripe = new Stripe(this.secret);
    //   const session = await stripe.checkout.sessions.create({ ... });
    //   return { url: session.url!, mock: false };
    return { url: `https://billing.example/checkout/${planCode}`, mock: true };
  }
}
