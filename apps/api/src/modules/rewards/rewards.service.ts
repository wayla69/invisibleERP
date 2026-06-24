import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, ne, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { loyaltyRewards, loyaltyRedemptions, memberCoupons, posMembers, posMemberLedger } from '../../database/schema';
import { n, ymd } from '../../database/queries';
import { DocNumberService } from '../../common/doc-number.service';
import type { JwtUser } from '../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// CRM Phase 2 — rewards catalog, point-burn redemptions (single-use codes), member coupon wallet.
// A reward redemption burns points (a pos_member_ledger 'Redeem' row); the Phase-1.5 liability accrual then
// releases the matching 2250/5700. Codes are single-use (one-way status under a FOR UPDATE lock).
// EVERY query is EXPLICITLY tenant-scoped via this.tid(user) — RLS is bypassed for Admin, so the codes
// (globally unique) and the by-id reward/member lookups must be scoped or an Admin could cross tenants.
@Injectable()
export class RewardsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    return user.tenantId;
  }

  // ── Catalog ────────────────────────────────────────────────────────────────
  async listRewards(user: JwtUser, q: { active?: boolean } = {}) {
    const db = this.db as any; const tenantId = this.tid(user);
    const conds: any[] = [eq(loyaltyRewards.tenantId, tenantId)];
    if (q.active !== undefined) conds.push(eq(loyaltyRewards.active, q.active));
    const rows = await db.select().from(loyaltyRewards).where(and(...conds)).orderBy(loyaltyRewards.pointCost);
    return { rewards: rows.map(shapeReward), count: rows.length };
  }

  async upsertReward(user: JwtUser, dto: any) {
    const db = this.db as any; const tenantId = this.tid(user);
    const vals: any = {
      name: dto.name, type: dto.type ?? 'evoucher', pointCost: String(dto.point_cost),
      cashValue: String(dto.cash_value ?? 0), couponKind: dto.coupon_kind ?? null, couponValue: String(dto.coupon_value ?? 0),
      stock: dto.stock ?? null, perMemberLimit: dto.per_member_limit ?? null, tierMin: dto.tier_min != null ? String(dto.tier_min) : null,
      validFrom: dto.valid_from ?? null, validTo: dto.valid_to ?? null, imageKey: dto.image_key ?? null,
      active: dto.active ?? true, updatedAt: new Date(),
    };
    if (dto.id) {
      const [r] = await db.update(loyaltyRewards).set(vals).where(and(eq(loyaltyRewards.id, dto.id), eq(loyaltyRewards.tenantId, tenantId))).returning();
      if (!r) throw new NotFoundException({ code: 'REWARD_NOT_FOUND', message: 'Reward not found', messageTh: 'ไม่พบของรางวัล' });
      return shapeReward(r);
    }
    const rewardCode = await this.docNo.nextDaily('RWD');
    const [r] = await db.insert(loyaltyRewards).values({ ...vals, tenantId, rewardCode, createdBy: user.username }).returning();
    return shapeReward(r);
  }

  async setRewardActive(user: JwtUser, id: number, active: boolean) {
    const db = this.db as any; const tenantId = this.tid(user);
    const [r] = await db.update(loyaltyRewards).set({ active, updatedAt: new Date() }).where(and(eq(loyaltyRewards.id, id), eq(loyaltyRewards.tenantId, tenantId))).returning();
    if (!r) throw new NotFoundException({ code: 'REWARD_NOT_FOUND', message: 'Reward not found', messageTh: 'ไม่พบของรางวัล' });
    return shapeReward(r);
  }

  // ── Redeem a reward (burn points → single-use code) ─────────────────────────
  async redeemReward(user: JwtUser, rewardId: number, dto: { member_id: number }) {
    const db = this.db as any; const tenantId = this.tid(user);
    const [reward] = await db.select().from(loyaltyRewards).where(and(eq(loyaltyRewards.id, rewardId), eq(loyaltyRewards.tenantId, tenantId))).limit(1);
    if (!reward || reward.active === false) throw new NotFoundException({ code: 'REWARD_NOT_FOUND', message: 'Reward not found/inactive', messageTh: 'ไม่พบของรางวัล' });
    const today = ymd();
    if (reward.validFrom && today < reward.validFrom) throw new ConflictException({ code: 'REWARD_NOT_STARTED', message: 'Reward not yet active', messageTh: 'ของรางวัลยังไม่เริ่ม' });
    if (reward.validTo && today > reward.validTo) throw new ConflictException({ code: 'REWARD_EXPIRED', message: 'Reward expired', messageTh: 'ของรางวัลหมดอายุ' });
    const pointCost = n(reward.pointCost);
    return await db.transaction(async (tx: any) => {
      const [m] = await tx.select().from(posMembers).where(and(eq(posMembers.id, dto.member_id), eq(posMembers.tenantId, tenantId))).for('update').limit(1);
      if (!m || m.active === false) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found/inactive', messageTh: 'ไม่พบสมาชิก' });
      if (reward.tierMin != null && n(m.lifetime) < n(reward.tierMin)) throw new ConflictException({ code: 'TIER_TOO_LOW', message: 'Member tier too low for this reward', messageTh: 'ระดับสมาชิกไม่ถึงเกณฑ์' });
      const bal = n(m.balance);
      if (bal < pointCost) throw new ConflictException({ code: 'INSUFFICIENT_POINTS', message: `Balance ${bal} < ${pointCost}`, messageTh: `แต้มไม่พอ (มี ${bal})` });
      if (reward.perMemberLimit != null) {
        const [cnt] = await tx.select({ c: sql`count(*)` }).from(loyaltyRedemptions).where(and(eq(loyaltyRedemptions.tenantId, tenantId), eq(loyaltyRedemptions.memberId, dto.member_id), eq(loyaltyRedemptions.rewardId, rewardId), ne(loyaltyRedemptions.status, 'void')));
        if (Number(cnt?.c ?? 0) >= Number(reward.perMemberLimit)) throw new ConflictException({ code: 'LIMIT_REACHED', message: 'Per-member redemption limit reached', messageTh: 'ครบจำนวนสิทธิ์ต่อคนแล้ว' });
      }
      if (reward.stock != null) {
        const upd = await tx.update(loyaltyRewards).set({ stock: sql`${loyaltyRewards.stock} - 1`, updatedAt: new Date() }).where(and(eq(loyaltyRewards.id, rewardId), eq(loyaltyRewards.tenantId, tenantId), sql`${loyaltyRewards.stock} > 0`)).returning({ stock: loyaltyRewards.stock });
        if (!upd.length) throw new ConflictException({ code: 'OUT_OF_STOCK', message: 'Reward out of stock', messageTh: 'ของรางวัลหมด' });
      }
      const after = bal - pointCost;
      const code = await this.docNo.nextDaily('RDM');
      await tx.update(posMembers).set({ balance: String(after), lastUpdated: new Date() }).where(eq(posMembers.id, dto.member_id));
      // redeemValue left 0: the points fair value is what the accrual uses; the reward's face value is on the
      // loyalty_redemptions row (avoids mixing bases in liability().movements.redeemed_value).
      await tx.insert(posMemberLedger).values({ tenantId, memberId: dto.member_id, txnType: 'Redeem', points: String(-pointCost), redeemValue: '0', balanceAfter: String(after), refDoc: code, notes: `Reward: ${reward.name}`, createdBy: user.username });
      const expiresAt = reward.validTo ? new Date(`${reward.validTo}T23:59:59Z`) : new Date(Date.now() + 90 * 86400000);
      const value = round2(n(reward.couponValue) || n(reward.cashValue));
      await tx.insert(loyaltyRedemptions).values({ tenantId, memberId: dto.member_id, rewardId, redemptionCode: code, pointCost: String(pointCost), rewardName: reward.name, rewardType: reward.type, value: String(value), status: 'issued', expiresAt, createdBy: user.username });
      return { redemption_code: code, reward: reward.name, reward_type: reward.type, point_cost: pointCost, value, balance: after, status: 'issued', expires_at: expiresAt };
    });
  }

  // ── Use a redemption code at POS (single-use) ───────────────────────────────
  async useRedemption(user: JwtUser, code: string, dto: { sale_no?: string }) {
    const db = this.db as any; const tenantId = this.tid(user);
    return await db.transaction(async (tx: any) => {
      const [r] = await tx.select().from(loyaltyRedemptions).where(and(eq(loyaltyRedemptions.redemptionCode, code), eq(loyaltyRedemptions.tenantId, tenantId))).for('update').limit(1);
      if (!r) throw new NotFoundException({ code: 'REDEMPTION_NOT_FOUND', message: 'Redemption code not found', messageTh: 'ไม่พบรหัสแลก' });
      if (r.status === 'used') throw new ConflictException({ code: 'ALREADY_USED', message: 'Redemption already used', messageTh: 'รหัสนี้ถูกใช้แล้ว' });
      if (r.status === 'void') throw new ConflictException({ code: 'REDEMPTION_VOID', message: 'Redemption voided', messageTh: 'รหัสถูกยกเลิก' });
      if (r.status === 'expired' || (r.expiresAt && new Date(r.expiresAt) < new Date())) {
        if (r.status !== 'expired') await tx.update(loyaltyRedemptions).set({ status: 'expired' }).where(eq(loyaltyRedemptions.id, r.id));
        throw new ConflictException({ code: 'REDEMPTION_EXPIRED', message: 'Redemption expired', messageTh: 'รหัสหมดอายุ' });
      }
      await tx.update(loyaltyRedemptions).set({ status: 'used', usedAt: new Date(), usedRef: dto.sale_no ?? null }).where(eq(loyaltyRedemptions.id, r.id));
      return { redemption_code: code, status: 'used', reward: r.rewardName, reward_type: r.rewardType, value: n(r.value), used_ref: dto.sale_no ?? null };
    });
  }

  // ── Member wallet (redemptions + coupons) ───────────────────────────────────
  async wallet(user: JwtUser, memberId: number) {
    const db = this.db as any; const tenantId = this.tid(user);
    const reds = await db.select().from(loyaltyRedemptions).where(and(eq(loyaltyRedemptions.memberId, memberId), eq(loyaltyRedemptions.tenantId, tenantId))).orderBy(desc(loyaltyRedemptions.id)).limit(50);
    const cps = await db.select().from(memberCoupons).where(and(eq(memberCoupons.memberId, memberId), eq(memberCoupons.tenantId, tenantId))).orderBy(desc(memberCoupons.id)).limit(50);
    return {
      member_id: memberId,
      redemptions: reds.map((r: any) => ({ redemption_code: r.redemptionCode, reward: r.rewardName, reward_type: r.rewardType, point_cost: n(r.pointCost), value: n(r.value), status: r.status, issued_at: r.issuedAt, expires_at: r.expiresAt, used_at: r.usedAt, used_ref: r.usedRef })),
      coupons: cps.map((c: any) => ({ code: c.code, kind: c.kind, value: n(c.value), source: c.source, status: c.status, issued_at: c.issuedAt, expires_at: c.expiresAt, used_at: c.usedAt, used_ref: c.usedRef })),
    };
  }

  // ── Coupons (issued without burning points) ─────────────────────────────────
  async issueCoupon(user: JwtUser, dto: { member_id: number; kind: string; value: number; source?: string; expires_at?: string }) {
    const db = this.db as any; const tenantId = this.tid(user);
    const [m] = await db.select({ id: posMembers.id }).from(posMembers).where(and(eq(posMembers.id, dto.member_id), eq(posMembers.tenantId, tenantId))).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    const code = await this.docNo.nextDaily('CPN');
    const [c] = await db.insert(memberCoupons).values({ tenantId, memberId: dto.member_id, code, kind: dto.kind, value: String(dto.value), source: dto.source ?? 'manual', status: 'active', expiresAt: dto.expires_at ? new Date(dto.expires_at) : null, createdBy: user.username }).returning();
    return { code: c.code, kind: c.kind, value: n(c.value), source: c.source, status: c.status, expires_at: c.expiresAt };
  }

  async redeemCoupon(user: JwtUser, code: string, dto: { sale_no?: string }) {
    const db = this.db as any; const tenantId = this.tid(user);
    return await db.transaction(async (tx: any) => {
      const [c] = await tx.select().from(memberCoupons).where(and(eq(memberCoupons.code, code), eq(memberCoupons.tenantId, tenantId))).for('update').limit(1);
      if (!c) throw new NotFoundException({ code: 'COUPON_NOT_FOUND', message: 'Coupon not found', messageTh: 'ไม่พบคูปอง' });
      if (c.status === 'used') throw new ConflictException({ code: 'ALREADY_USED', message: 'Coupon already used', messageTh: 'คูปองถูกใช้แล้ว' });
      if (c.status === 'expired' || (c.expiresAt && new Date(c.expiresAt) < new Date())) {
        if (c.status !== 'expired') await tx.update(memberCoupons).set({ status: 'expired' }).where(eq(memberCoupons.id, c.id));
        throw new ConflictException({ code: 'COUPON_EXPIRED', message: 'Coupon expired', messageTh: 'คูปองหมดอายุ' });
      }
      await tx.update(memberCoupons).set({ status: 'used', usedAt: new Date(), usedRef: dto.sale_no ?? null }).where(eq(memberCoupons.id, c.id));
      return { code, status: 'used', kind: c.kind, value: n(c.value), used_ref: dto.sale_no ?? null };
    });
  }
}

function shapeReward(r: any) {
  return {
    id: Number(r.id), reward_code: r.rewardCode, name: r.name, type: r.type,
    point_cost: n(r.pointCost), cash_value: n(r.cashValue), coupon_kind: r.couponKind, coupon_value: n(r.couponValue),
    stock: r.stock, per_member_limit: r.perMemberLimit, tier_min: r.tierMin != null ? n(r.tierMin) : null,
    valid_from: r.validFrom, valid_to: r.validTo, image_key: r.imageKey, active: r.active,
  };
}
