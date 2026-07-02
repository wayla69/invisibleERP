import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, desc, lt, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { membershipPlans, memberMemberships, posMembers, loyaltyTierHistory } from '../../database/schema';
import { n } from '../../database/queries';
import { LedgerService } from '../ledger/ledger.service';
import type { JwtUser } from '../../common/decorators';
import { isUniqueViolation } from '../../common/db-error';

const DEFERRED = '2410'; // Contract Liability / Deferred Revenue (TFRS 15 — same account revrec releases)
const REVENUE = '4300';  // Subscription & Service Revenue
const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const bizYmd = (d = new Date()) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
const addMonths = (ymd: string, months: number) => {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
};

// V4 (docs/29, control LYL-21) — paid VIP membership. The club fee is REAL revenue accounting from day
// one: sell books Dr 1000 cash / Cr 2410 deferred (TFRS 15 — the service is delivered over the period),
// and the monthly recognition releases 2410 → 4300 straight-line (price / period_months; the final month
// takes the rounding remainder), idempotent per (membership, month) via the ledger's alreadyPosted guard.
// The plan's tier is granted with a loyalty_tier_history 'vip' row; the nightly maintenance sweep expires
// lapsed memberships and the existing tier recompute pulls the member back to the EARNED rung — a VIP that
// stops paying cannot keep the tier.
@Injectable()
export class MembershipService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
  ) {}

  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    return user.tenantId;
  }

  // ── Plans (marketing/exec) ──
  async listPlans(user: JwtUser) {
    const db = this.db;
    const tenantId = this.tid(user);
    const rows = await db.select().from(membershipPlans).where(eq(membershipPlans.tenantId, tenantId)).orderBy(membershipPlans.id);
    return { plans: rows.map((p: any) => ({ id: Number(p.id), code: p.code, name: p.name, tier: p.tier, price: n(p.price), period_months: Number(p.periodMonths), active: p.active })) };
  }

  async upsertPlan(dto: { id?: number; code: string; name: string; tier: string; price: number; period_months?: number; active?: boolean }, user: JwtUser) {
    const db = this.db;
    const tenantId = this.tid(user);
    if (!(dto.price > 0)) throw new BadRequestException({ code: 'BAD_PRICE', message: 'price must be > 0', messageTh: 'ราคาต้องมากกว่าศูนย์' });
    const months = Math.max(1, Math.floor(dto.period_months ?? 12));
    const vals = { tenantId, code: dto.code.trim(), name: dto.name.trim(), tier: dto.tier.trim(), price: String(r2(dto.price)), periodMonths: months, active: dto.active ?? true, createdBy: user.username };
    if (dto.id) {
      const upd = await db.update(membershipPlans).set(vals).where(and(eq(membershipPlans.id, dto.id), eq(membershipPlans.tenantId, tenantId))).returning({ id: membershipPlans.id });
      if (!upd.length) throw new NotFoundException({ code: 'PLAN_NOT_FOUND', message: 'Plan not found', messageTh: 'ไม่พบแผนสมาชิก' });
      return { id: dto.id, updated: true };
    }
    try {
      const [r] = await db.insert(membershipPlans).values(vals).returning({ id: membershipPlans.id });
      return { id: Number(r!.id), created: true };
    } catch (e: any) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'PLAN_EXISTS', message: `Plan '${dto.code}' already exists`, messageTh: 'มีแผนรหัสนี้แล้ว' });
      throw e;
    }
  }

  // ── Sell (pos/loyalty) — collect the fee, defer the revenue, grant the tier ──
  // Optional start_date supports backdated migrations of existing VIP books (and deterministic tests).
  async sell(user: JwtUser, dto: { member_id: number; plan_id: number; sale_ref?: string; start_date?: string }) {
    const db = this.db;
    const tenantId = this.tid(user);
    const [plan] = await db.select().from(membershipPlans).where(and(eq(membershipPlans.id, dto.plan_id), eq(membershipPlans.tenantId, tenantId), eq(membershipPlans.active, true))).limit(1);
    if (!plan) throw new NotFoundException({ code: 'PLAN_NOT_FOUND', message: 'Plan not found/inactive', messageTh: 'ไม่พบแผนสมาชิก' });
    const [m] = await db.select().from(posMembers).where(and(eq(posMembers.id, dto.member_id), eq(posMembers.tenantId, tenantId))).limit(1);
    if (!m || m.active === false) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found/inactive', messageTh: 'ไม่พบสมาชิก' });
    const start = dto.start_date ?? bizYmd();
    const end = addMonths(start, Number(plan.periodMonths));
    let row: any;
    try {
      const ins = await db.insert(memberMemberships).values({
        tenantId, memberId: dto.member_id, planId: dto.plan_id, status: 'Active',
        startDate: start, endDate: end, price: plan.price, periodMonths: Number(plan.periodMonths),
        saleRef: dto.sale_ref ?? null, createdBy: user.username,
      }).returning();
      row = ins[0]!;
    } catch (e: any) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'MEMBERSHIP_ACTIVE', message: 'Member already has an active membership', messageTh: 'สมาชิกมีแพ็กเกจที่ยังไม่หมดอายุอยู่แล้ว' });
      throw e;
    }
    // Fee → deferred revenue (idempotent per membership via the JE dedup on source_ref).
    const je: any = await this.ledger.postEntry({
      source: 'VIP', sourceRef: `VIP-${Number(row.id)}`, tenantId, memo: `VIP membership ${plan.code} member ${dto.member_id}`,
      createdBy: user.username, lines: [{ account_code: '1000', debit: n(plan.price) }, { account_code: DEFERRED, credit: n(plan.price) }],
    });
    // Tier grant — audited like every tier change; the recompute leaves it alone while the membership is
    // Active (see expireLapsed: the sweep expires first, THEN recompute pulls the tier back to earned).
    if (m.tier !== plan.tier) {
      await db.update(posMembers).set({ tier: plan.tier, lastUpdated: new Date() }).where(eq(posMembers.id, dto.member_id));
      await db.insert(loyaltyTierHistory).values({ tenantId, memberId: dto.member_id, fromTier: m.tier ?? null, toTier: plan.tier, reason: 'vip', lifetime: String(n(m.lifetime)), createdBy: user.username });
    }
    return { id: Number(row.id), member_id: dto.member_id, plan: plan.code, tier: plan.tier, price: n(plan.price), start_date: start, end_date: end, entry_no: je?.entry_no ?? null, status: 'Active' };
  }

  // ── Monthly recognition (gl_post/exec; also the BI job membership_revenue_recognize) ──
  // Straight-line months of 30 business-days each from start_date; month k posts Dr 2410 / Cr 4300 with
  // sourceRef `VIP-<id>:M<k>` — the ledger's idempotency guard makes a re-run post nothing.
  async recognizeDue(user: JwtUser, explicitTenantId?: number | null) {
    const tenantId = user.tenantId ?? (explicitTenantId != null ? Number(explicitTenantId) : null);
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify tenant_id', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant_id' });
    const db = this.db;
    const rows = await db.select().from(memberMemberships)
      .where(and(eq(memberMemberships.tenantId, tenantId), sql`${memberMemberships.recognizedMonths} < ${memberMemberships.periodMonths}`));
    let posted = 0, amount = 0;
    for (const ms of rows) {
      const startMs = new Date(String(ms.startDate) + 'T00:00:00Z').getTime() - 7 * 3600_000;
      const daysSince = Math.floor((Date.now() - startMs) / 86_400_000);
      const monthsElapsed = Math.min(Number(ms.periodMonths), Math.floor(daysSince / 30) + 1);
      const monthly = r2(n(ms.price) / Number(ms.periodMonths));
      for (let k = Number(ms.recognizedMonths) + 1; k <= monthsElapsed; k++) {
        const amt = k === Number(ms.periodMonths) ? r2(n(ms.price) - monthly * (Number(ms.periodMonths) - 1)) : monthly;
        if (await this.ledger.alreadyPosted('VIP-REC', `VIP-${Number(ms.id)}:M${k}`)) { continue; }
        await this.ledger.postEntry({
          source: 'VIP-REC', sourceRef: `VIP-${Number(ms.id)}:M${k}`, tenantId, memo: `VIP revenue recognition M${k}/${ms.periodMonths} membership ${Number(ms.id)}`,
          createdBy: user.username ?? 'system:vip', lines: [{ account_code: DEFERRED, debit: amt }, { account_code: REVENUE, credit: amt }],
        });
        posted++; amount = r2(amount + amt);
        await db.update(memberMemberships).set({ recognizedMonths: k }).where(eq(memberMemberships.id, Number(ms.id)));
      }
    }
    return { tenant_id: tenantId, scanned: rows.length, posted, amount };
  }

  // ── Lapse (called by the maintenance sweep BEFORE the tier recompute) ──
  // Expired membership → status Expired + a 'vip-expired' audit row; the recompute that follows pulls the
  // tier back to the member's EARNED rung (no special-case tier math here).
  async expireLapsed(tenantId: number, createdBy: string) {
    const db = this.db;
    const today = bizYmd();
    const lapsed = await db.update(memberMemberships)
      .set({ status: 'Expired' })
      .where(and(eq(memberMemberships.tenantId, tenantId), eq(memberMemberships.status, 'Active'), lt(memberMemberships.endDate, today)))
      .returning();
    for (const ms of lapsed) {
      const [m] = await db.select().from(posMembers).where(eq(posMembers.id, Number(ms.memberId))).limit(1);
      if (m) await db.insert(loyaltyTierHistory).values({ tenantId, memberId: Number(ms.memberId), fromTier: m.tier ?? null, toTier: m.tier ?? 'Standard', reason: 'vip-expired', lifetime: String(n(m.lifetime)), createdBy });
    }
    return { tenant_id: tenantId, expired: lapsed.length };
  }

  // Member's membership state (staff 360 + the /m tier payload).
  async forMember(tenantId: number, memberId: number) {
    const db = this.db;
    const [ms] = await db.select({ m: memberMemberships, planCode: membershipPlans.code, planName: membershipPlans.name })
      .from(memberMemberships).leftJoin(membershipPlans, eq(memberMemberships.planId, membershipPlans.id))
      .where(and(eq(memberMemberships.tenantId, tenantId), eq(memberMemberships.memberId, memberId)))
      .orderBy(desc(memberMemberships.id)).limit(1);
    if (!ms) return null;
    return { id: Number(ms.m.id), plan: ms.planCode, plan_name: ms.planName, status: ms.m.status, start_date: ms.m.startDate, end_date: ms.m.endDate, price: n(ms.m.price), recognized_months: Number(ms.m.recognizedMonths), period_months: Number(ms.m.periodMonths) };
  }
}
