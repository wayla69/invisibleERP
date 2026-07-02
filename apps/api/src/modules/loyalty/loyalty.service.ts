import { Inject, Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { eq, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { loyaltyConfig, loyaltyPoints, loyaltyTxn, tenants } from '../../database/schema';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

export interface LoyaltyConfigDto {
  enabled?: boolean; points_per_baht?: number; baht_per_point?: number;
  min_redeem?: number; expiry_days?: number; transfer_day_cap?: number;
}
export interface RedeemDto { points: number }

@Injectable()
export class LoyaltyService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── CONFIG (singleton id=1) ──
  async getConfig() {
    const db = this.db as any;
    let [cfg] = await db.select().from(loyaltyConfig).where(eq(loyaltyConfig.id, 1)).limit(1);
    if (!cfg) {
      // ใส่ค่า default ตาม schema (singleton)
      [cfg] = await db.insert(loyaltyConfig).values({ id: 1 }).onConflictDoNothing().returning();
      if (!cfg) [cfg] = await db.select().from(loyaltyConfig).where(eq(loyaltyConfig.id, 1)).limit(1);
    }
    return {
      id: 1,
      enabled: !!cfg?.enabled,
      points_per_baht: n(cfg?.pointsPerBaht),
      baht_per_point: n(cfg?.bahtPerPoint),
      min_redeem: n(cfg?.minRedeem),
      expiry_days: n(cfg?.expiryDays),
      transfer_day_cap: cfg?.transferDayCap != null ? Number(cfg.transferDayCap) : 1000,
      updated_at: cfg?.updatedAt ?? null,
    };
  }

  async updateConfig(dto: LoyaltyConfigDto) {
    const db = this.db as any;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.enabled != null) set.enabled = dto.enabled;
    if (dto.points_per_baht != null) set.pointsPerBaht = String(dto.points_per_baht);
    if (dto.baht_per_point != null) set.bahtPerPoint = String(dto.baht_per_point);
    if (dto.min_redeem != null) set.minRedeem = String(dto.min_redeem);
    if (dto.expiry_days != null) set.expiryDays = dto.expiry_days;
    if (dto.transfer_day_cap != null) set.transferDayCap = dto.transfer_day_cap;
    await db.insert(loyaltyConfig).values({
      id: 1,
      enabled: dto.enabled ?? false,
      pointsPerBaht: dto.points_per_baht != null ? String(dto.points_per_baht) : undefined,
      bahtPerPoint: dto.baht_per_point != null ? String(dto.baht_per_point) : undefined,
      minRedeem: dto.min_redeem != null ? String(dto.min_redeem) : undefined,
      expiryDays: dto.expiry_days ?? undefined,
      transferDayCap: dto.transfer_day_cap ?? undefined,
      updatedAt: new Date(),
    }).onConflictDoUpdate({ target: loyaltyConfig.id, set });
    return this.getConfig();
  }

  // ── ME (this tenant balance/lifetime + recent txn) ──
  async me(user: JwtUser) {
    const db = this.db as any;
    const tenant = await this.resolveTenant(user);
    const [lp] = await db.select().from(loyaltyPoints).where(eq(loyaltyPoints.tenantId, tenant.id)).limit(1);
    const txns = await db.select().from(loyaltyTxn)
      .where(eq(loyaltyTxn.tenantId, tenant.id))
      .orderBy(desc(loyaltyTxn.id)).limit(20);
    return {
      tenant_id: tenant.id,
      customer_name: tenant.code,
      balance: n(lp?.balance),
      lifetime: n(lp?.lifetime),
      recent_txn: txns.map((t: any) => ({
        txn_date: t.txnDate, txn_type: t.txnType, points: n(t.points),
        balance_after: n(t.balanceAfter), ref_doc: t.refDoc, notes: t.notes,
      })),
    };
  }

  // ── REDEEM ──
  // require balance>=min_redeem ; redeem_val=points*baht_per_point ; decrement balance ; insert Redeem (negative points)
  async redeem(dto: RedeemDto, user: JwtUser) {
    const db = this.db as any;
    const points = n(dto.points);
    if (points <= 0) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Points must be positive', messageTh: 'จำนวนแต้มต้องมากกว่าศูนย์' });

    const tenant = await this.resolveTenant(user);
    const [cfg] = await db.select().from(loyaltyConfig).where(eq(loyaltyConfig.id, 1)).limit(1);
    if (!cfg?.enabled) throw new ConflictException({ code: 'LOYALTY_DISABLED', message: 'Loyalty program is disabled', messageTh: 'โปรแกรมสะสมแต้มถูกปิดใช้งาน' });

    const minRedeem = n(cfg.minRedeem);
    const bahtPerPoint = n(cfg.bahtPerPoint);
    const redeemVal = round2(points * bahtPerPoint);
    const refDoc = `RDM-${stamp()}`;

    // Lock the balance row FOR UPDATE, then read+validate+decrement UNDER the lock so two concurrent
    // redemptions can never both pass the balance check and double-spend the same points (H3).
    const newBalance = await db.transaction(async (tx: any) => {
      const [lp] = await tx.select().from(loyaltyPoints).where(eq(loyaltyPoints.tenantId, tenant.id)).for('update').limit(1);
      const balance = n(lp?.balance);
      if (balance < minRedeem) throw new ConflictException({ code: 'MIN_REDEEM', message: `Balance below minimum redeem (${minRedeem})`, messageTh: 'แต้มไม่ถึงขั้นต่ำที่แลกได้' });
      if (points > balance) throw new ConflictException({ code: 'INSUFFICIENT_POINTS', message: 'Insufficient points', messageTh: 'แต้มไม่เพียงพอ' });
      const nb = balance - points;
      await tx.update(loyaltyPoints).set({ balance: String(nb), lastUpdated: new Date() }).where(eq(loyaltyPoints.tenantId, tenant.id));
      await tx.insert(loyaltyTxn).values({
        tenantId: tenant.id, txnDate: new Date(), txnType: 'Redeem',
        points: String(-points), balanceAfter: String(nb), refDoc, notes: `Redeemed ${points} pts → ${redeemVal} THB`,
      });
      return nb;
    });

    return { tenant_id: tenant.id, points_redeemed: points, redeem_val: redeemVal, balance: newBalance, ref_doc: refDoc };
  }

  // ── helper ──
  private async resolveTenant(user: JwtUser) {
    const db = this.db as any;
    const code = user.customerName;
    if (!code) throw new BadRequestException({ code: 'NO_TENANT', message: 'No customer linked to this user', messageTh: 'ผู้ใช้นี้ไม่ผูกกับลูกค้า' });
    const [tenant] = await db.select().from(tenants).where(eq(tenants.code, code)).limit(1);
    if (!tenant) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Customer not found', messageTh: 'ไม่พบลูกค้า' });
    return tenant;
  }
}

function round2(x: number) { return Math.round(x * 100) / 100; }
const pad = (v: number) => String(v).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
