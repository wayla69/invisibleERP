import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, desc, gte, gt, count, sql } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { loyaltyWheels, loyaltyWheelSegments, loyaltySpins, posMembers, posMemberLedger, memberCoupons } from '../../../database/schema';
import { n } from '../../../database/queries';
import { DocNumberService } from '../../../common/doc-number.service';
import type { JwtUser } from '../../../common/decorators';

// CRM Phase 4 — spin-the-wheel / lucky draw. A member spends points (or a daily free spin) to spin; a
// server-side crypto-weighted RNG picks ONE segment by weight/sum(weight) over in-stock segments. The cost is
// a 'Redeem' ledger row (releases liability) and a points prize an 'Adjust' row (accrues) — same plumbing as
// rewards/missions. Each spin is an audit row (provably fair). EVERY query is explicitly tenant-scoped.
@Injectable()
export class WheelsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    return user.tenantId;
  }

  async listWheels(user: JwtUser, q: { active?: boolean } = {}) {
    const db = this.db as any; const tenantId = this.tid(user);
    const conds: any[] = [eq(loyaltyWheels.tenantId, tenantId)];
    if (q.active !== undefined) conds.push(eq(loyaltyWheels.active, q.active));
    const wheels = await db.select().from(loyaltyWheels).where(and(...conds)).orderBy(loyaltyWheels.id);
    const segs = await db.select().from(loyaltyWheelSegments).where(eq(loyaltyWheelSegments.tenantId, tenantId)).orderBy(loyaltyWheelSegments.sort);
    return { wheels: wheels.map((w: any) => ({ ...shapeWheel(w), segments: segs.filter((s: any) => Number(s.wheelId) === Number(w.id)).map(shapeSegment) })), count: wheels.length };
  }

  // Create/replace a wheel and its prize segments (config; segments fully replaced on update).
  async upsertWheel(user: JwtUser, dto: any) {
    const db = this.db as any; const tenantId = this.tid(user);
    const segments: any[] = Array.isArray(dto.segments) ? dto.segments : [];
    if (!segments.length) throw new BadRequestException({ code: 'NO_SEGMENTS', message: 'A wheel needs at least one segment', messageTh: 'ต้องมีช่องรางวัลอย่างน้อยหนึ่งช่อง' });
    if (!segments.some((sg) => Number(sg.weight ?? 0) > 0)) throw new BadRequestException({ code: 'NO_WEIGHT', message: 'At least one segment must have a positive weight', messageTh: 'ต้องมีช่องที่มีน้ำหนักมากกว่า 0' });
    const vals = { name: dto.name, costPoints: Math.max(0, Math.floor(dto.cost_points ?? 0)), dailyFreeSpins: Math.max(0, Math.floor(dto.daily_free_spins ?? 0)), active: dto.active ?? true };
    return await db.transaction(async (tx: any) => {
      let wheelId: number;
      if (dto.id) {
        const [w] = await tx.update(loyaltyWheels).set(vals).where(and(eq(loyaltyWheels.id, dto.id), eq(loyaltyWheels.tenantId, tenantId))).returning();
        if (!w) throw new NotFoundException({ code: 'WHEEL_NOT_FOUND', message: 'Wheel not found', messageTh: 'ไม่พบวงล้อ' });
        wheelId = Number(w.id);
        await tx.delete(loyaltyWheelSegments).where(and(eq(loyaltyWheelSegments.wheelId, wheelId), eq(loyaltyWheelSegments.tenantId, tenantId)));
      } else {
        const wheelCode = await this.docNo.nextDaily('WHL');
        const [w] = await tx.insert(loyaltyWheels).values({ ...vals, tenantId, wheelCode, createdBy: user.username }).returning();
        wheelId = Number(w.id);
      }
      let sort = 0;
      for (const sg of segments) {
        await tx.insert(loyaltyWheelSegments).values({
          tenantId, wheelId, label: sg.label, prizeKind: sg.prize_kind ?? 'none', prizePoints: Math.max(0, Math.floor(sg.prize_points ?? 0)),
          couponKind: sg.coupon_kind ?? null, couponValue: String(sg.coupon_value ?? 0), weight: Math.max(0, Math.floor(sg.weight ?? 1)),
          stock: sg.stock == null || sg.stock === '' ? null : Math.max(0, Math.floor(sg.stock)), sort: sort++,
        });
      }
      return this.getWheel(tx, tenantId, wheelId);
    });
  }

  async setWheelActive(user: JwtUser, id: number, active: boolean) {
    const db = this.db as any; const tenantId = this.tid(user);
    const [w] = await db.update(loyaltyWheels).set({ active }).where(and(eq(loyaltyWheels.id, id), eq(loyaltyWheels.tenantId, tenantId))).returning();
    if (!w) throw new NotFoundException({ code: 'WHEEL_NOT_FOUND', message: 'Wheel not found', messageTh: 'ไม่พบวงล้อ' });
    return this.getWheel(db, tenantId, Number(w.id));
  }

  // Spin: pay (points or a daily free spin), pick a weighted in-stock segment, grant the prize, audit it.
  async spin(user: JwtUser, wheelId: number, dto: { member_id: number }) {
    const db = this.db as any; const tenantId = this.tid(user);
    const [wheel] = await db.select().from(loyaltyWheels).where(and(eq(loyaltyWheels.id, wheelId), eq(loyaltyWheels.tenantId, tenantId), eq(loyaltyWheels.active, true))).limit(1);
    if (!wheel) throw new NotFoundException({ code: 'WHEEL_NOT_FOUND', message: 'Wheel not found/inactive', messageTh: 'ไม่พบวงล้อ' });
    // Start of the current business day (Asia/Bangkok, UTC+7) for the daily-free-spin window.
    const now = new Date();
    const bkk = new Date(now.getTime() + 7 * 3600_000);
    const bkkMidnight = new Date(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()) - 7 * 3600_000);
    return await db.transaction(async (tx: any) => {
      const [m] = await tx.select().from(posMembers).where(and(eq(posMembers.id, dto.member_id), eq(posMembers.tenantId, tenantId))).for('update').limit(1);
      if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
      const [{ c: usedToday }] = await tx.select({ c: count() }).from(loyaltySpins).where(and(eq(loyaltySpins.tenantId, tenantId), eq(loyaltySpins.memberId, dto.member_id), eq(loyaltySpins.wheelId, wheelId), gte(loyaltySpins.createdAt, bkkMidnight)));
      const free = Number(usedToday) < Number(wheel.dailyFreeSpins);
      const cost = free ? 0 : Number(wheel.costPoints);
      if (cost > 0 && n(m.balance) < cost) throw new ConflictException({ code: 'INSUFFICIENT_POINTS', message: 'Not enough points to spin', messageTh: 'แต้มไม่พอสำหรับหมุน' });
      // Weighted pick over in-stock, positive-weight segments.
      const segs = await tx.select().from(loyaltyWheelSegments).where(and(eq(loyaltyWheelSegments.wheelId, wheelId), eq(loyaltyWheelSegments.tenantId, tenantId))).orderBy(loyaltyWheelSegments.sort);
      const eligible = segs.filter((sg: any) => Number(sg.weight) > 0 && (sg.stock == null || Number(sg.stock) > 0));
      if (!eligible.length) throw new ConflictException({ code: 'NO_PRIZES', message: 'No prizes available', messageTh: 'ไม่มีรางวัลเหลือ' });
      const total = eligible.reduce((a: number, sg: any) => a + Number(sg.weight), 0);
      let r = randomInt(0, total);
      let chosen = eligible[eligible.length - 1];
      for (const sg of eligible) { if (r < Number(sg.weight)) { chosen = sg; break; } r -= Number(sg.weight); }
      // Decrement limited stock under an atomic guard FIRST — if a concurrent spin took the last one, retry.
      if (chosen.stock != null) {
        const dec = await tx.update(loyaltyWheelSegments).set({ stock: sql`${loyaltyWheelSegments.stock} - 1`, wonCount: sql`${loyaltyWheelSegments.wonCount} + 1` }).where(and(eq(loyaltyWheelSegments.id, chosen.id), gt(loyaltyWheelSegments.stock, 0))).returning({ id: loyaltyWheelSegments.id });
        if (!dec.length) throw new ConflictException({ code: 'PRIZE_OUT_OF_STOCK', message: 'Prize just ran out — spin again', messageTh: 'รางวัลเพิ่งหมด ลองหมุนใหม่' });
      } else {
        await tx.update(loyaltyWheelSegments).set({ wonCount: sql`${loyaltyWheelSegments.wonCount} + 1` }).where(eq(loyaltyWheelSegments.id, chosen.id));
      }
      let bal = n(m.balance);
      if (cost > 0) {
        bal -= cost;
        await tx.update(posMembers).set({ balance: String(bal), lastUpdated: new Date() }).where(eq(posMembers.id, dto.member_id));
        await tx.insert(posMemberLedger).values({ tenantId, memberId: dto.member_id, txnType: 'Redeem', points: String(-cost), balanceAfter: String(bal), refDoc: wheel.wheelCode, notes: `Spin: ${wheel.name}`, createdBy: user.username });
      }
      const prize: any = { kind: chosen.prizeKind, label: chosen.label };
      if (chosen.prizeKind === 'points' && Number(chosen.prizePoints) > 0) {
        const pts = Number(chosen.prizePoints); bal += pts; const life = n(m.lifetime) + pts;
        await tx.update(posMembers).set({ balance: String(bal), lifetime: String(life), lastUpdated: new Date() }).where(eq(posMembers.id, dto.member_id));
        await tx.insert(posMemberLedger).values({ tenantId, memberId: dto.member_id, txnType: 'Adjust', points: String(pts), balanceAfter: String(bal), refDoc: wheel.wheelCode, notes: `Spin prize: ${chosen.label}`, createdBy: user.username });
        prize.points = pts;
      } else if (chosen.prizeKind === 'coupon') {
        const code = await this.docNo.nextDaily('CPN');
        await tx.insert(memberCoupons).values({ tenantId, memberId: dto.member_id, code, kind: chosen.couponKind ?? 'amount', value: String(n(chosen.couponValue)), source: 'wheel', status: 'active', createdBy: user.username });
        prize.code = code; prize.value = n(chosen.couponValue);
      }
      const spinCode = await this.docNo.nextDaily('SPN');
      await tx.insert(loyaltySpins).values({ tenantId, wheelId, memberId: dto.member_id, segmentId: chosen.id, spinCode, prizeKind: chosen.prizeKind, prizePoints: Number(chosen.prizePoints ?? 0), costPoints: cost, free, createdBy: user.username });
      return { spin_code: spinCode, member_id: dto.member_id, free, cost_points: cost, balance: bal, prize };
    });
  }

  async memberSpins(user: JwtUser, memberId: number) {
    const db = this.db as any; const tenantId = this.tid(user);
    const rows = await db.select().from(loyaltySpins).where(and(eq(loyaltySpins.memberId, memberId), eq(loyaltySpins.tenantId, tenantId))).orderBy(desc(loyaltySpins.id)).limit(50);
    return { member_id: memberId, spins: rows.map((s: any) => ({ id: Number(s.id), spin_code: s.spinCode, prize_kind: s.prizeKind, prize_points: Number(s.prizePoints ?? 0), cost_points: Number(s.costPoints ?? 0), free: !!s.free, created_at: s.createdAt })) };
  }

  private async getWheel(db: any, tenantId: number, wheelId: number) {
    const [w] = await db.select().from(loyaltyWheels).where(and(eq(loyaltyWheels.id, wheelId), eq(loyaltyWheels.tenantId, tenantId))).limit(1);
    const segs = await db.select().from(loyaltyWheelSegments).where(and(eq(loyaltyWheelSegments.wheelId, wheelId), eq(loyaltyWheelSegments.tenantId, tenantId))).orderBy(loyaltyWheelSegments.sort);
    return { ...shapeWheel(w), segments: segs.map(shapeSegment) };
  }
}

function shapeWheel(w: any) {
  return { id: Number(w.id), wheel_code: w.wheelCode, name: w.name, cost_points: Number(w.costPoints), daily_free_spins: Number(w.dailyFreeSpins), active: w.active };
}
function shapeSegment(s: any) {
  return { id: Number(s.id), label: s.label, prize_kind: s.prizeKind, prize_points: Number(s.prizePoints ?? 0), coupon_kind: s.couponKind, coupon_value: n(s.couponValue), weight: Number(s.weight), stock: s.stock == null ? null : Number(s.stock), won_count: Number(s.wonCount ?? 0) };
}
