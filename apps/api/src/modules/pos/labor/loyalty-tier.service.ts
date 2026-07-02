import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, and, gte, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { loyaltyTiers, posMembers, posMemberLedger, loyaltyConfig } from '../../../database/schema';
import { n } from '../../../database/queries';
import type { JwtUser } from '../../../common/decorators';

const round0 = (x: number) => Math.round(Number(x) || 0);

// P2c — tiered loyalty: earn/redeem multipliers gated by lifetime points, plus points-expiry enforcement.
@Injectable()
export class LoyaltyTierService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async listTiers() {
    const db = this.db as any;
    const rows = await db.select().from(loyaltyTiers).where(eq(loyaltyTiers.active, true)).orderBy(loyaltyTiers.minLifetime);
    return { tiers: rows.map((r: any) => ({ id: r.id, tier: r.tier, min_lifetime: n(r.minLifetime), earn_mult: n(r.earnMult), redeem_mult: n(r.redeemMult) })), count: rows.length };
  }
  async upsertTier(dto: { id?: number; tier: string; min_lifetime?: number; earn_mult?: number; redeem_mult?: number }, user: JwtUser) {
    const db = this.db as any;
    const vals = { tenantId: user.tenantId ?? null, tier: dto.tier, minLifetime: String(dto.min_lifetime ?? 0), earnMult: String(dto.earn_mult ?? 1), redeemMult: String(dto.redeem_mult ?? 1) };
    if (dto.id) { await db.update(loyaltyTiers).set(vals).where(eq(loyaltyTiers.id, dto.id)); return { id: dto.id, updated: true }; }
    const [r] = await db.insert(loyaltyTiers).values(vals).returning({ id: loyaltyTiers.id });
    return { id: r.id, created: true };
  }

  // Highest tier whose min_lifetime the member has reached.
  private async tierFor(lifetime: number) {
    const db = this.db as any;
    const tiers = await db.select().from(loyaltyTiers).where(and(eq(loyaltyTiers.active, true), gte(loyaltyTiers.minLifetime, '0'))).orderBy(desc(loyaltyTiers.minLifetime));
    return tiers.find((t: any) => lifetime >= n(t.minLifetime)) ?? null;
  }

  async quoteEarn(memberId: number, spend: number) {
    const db = this.db as any;
    const [m] = await db.select().from(posMembers).where(eq(posMembers.id, memberId)).limit(1);
    if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    const [cfg] = await db.select().from(loyaltyConfig).limit(1);
    const pointsPerBaht = cfg ? n(cfg.pointsPerBaht) : 1;
    const tier = await this.tierFor(n(m.lifetime));
    const mult = tier ? n(tier.earnMult) : 1;
    const base = spend * pointsPerBaht;
    return { member_id: memberId, tier: tier?.tier ?? m.tier ?? 'Standard', base_points: round0(base), multiplier: mult, points: round0(base * mult) };
  }

  // Redeemable balance = recent Earn (within expiry window) net of redemptions; older Earn is expired.
  async redeemable(memberId: number) {
    const db = this.db as any;
    const [cfg] = await db.select().from(loyaltyConfig).limit(1);
    const expiryDays = cfg?.expiryDays ?? 365;
    const cutoff = new Date(Date.now() - expiryDays * 86400000);
    const [m] = await db.select().from(posMembers).where(eq(posMembers.id, memberId)).limit(1);
    if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    const balance = n(m.balance);
    // Expiry disabled (expiry_days <= 0) → nothing ages; everything is redeemable (matches expirePoints()).
    if (expiryDays <= 0) return { member_id: memberId, balance: round0(balance), redeemable: round0(balance), expired: 0, expiry_days: expiryDays };
    const ledger = await db.select().from(posMemberLedger).where(eq(posMemberLedger.memberId, memberId));
    let earnedRecent = 0, redeemed = 0, adjusted = 0;
    for (const e of ledger) {
      const pts = n(e.points);
      if (e.txnType === 'Earn') { if (new Date(e.txnDate) >= cutoff) earnedRecent += pts; }
      else if (e.txnType === 'Redeem') redeemed += Math.abs(pts);
      else if (e.txnType === 'Adjust') adjusted += pts; // manual adjustments don't age — never shown as expired
      // W1 P2P transfers: inbound ages from its own date (like an earn); outbound consumes like a redeem.
      else if (e.txnType === 'Transfer') { if (pts > 0) { if (new Date(e.txnDate) >= cutoff) earnedRecent += pts; } else redeemed += Math.abs(pts); }
    }
    const redeemableBal = Math.max(0, round0(earnedRecent + adjusted - redeemed));
    return { member_id: memberId, balance: round0(balance), redeemable: redeemableBal, expired: Math.max(0, round0(balance - redeemableBal)), expiry_days: expiryDays };
  }
}
