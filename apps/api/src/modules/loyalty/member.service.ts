import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, desc, or } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { posMembers, posMemberLedger, loyaltyConfig } from '../../database/schema';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

@Injectable()
export class MemberService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async config() {
    const db = this.db as any;
    const [c] = await db.select().from(loyaltyConfig).where(eq(loyaltyConfig.id, 1)).limit(1);
    return { enabled: !!c?.enabled, pointsPerBaht: n(c?.pointsPerBaht), bahtPerPoint: n(c?.bahtPerPoint), minRedeem: n(c?.minRedeem) };
  }
  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    return user.tenantId;
  }

  async enroll(dto: { name?: string; phone?: string; card_no?: string; email?: string }, user: JwtUser) {
    const db = this.db as any; const tenantId = this.tid(user);
    let row;
    try {
      [row] = await db.insert(posMembers).values({ tenantId, memberCode: `M-TMP`, name: dto.name ?? null, phone: dto.phone ?? null, cardNo: dto.card_no ?? null, email: dto.email ?? null, balance: '0', lifetime: '0', createdBy: user.username }).returning();
    } catch (e: any) {
      if (String(e?.code) === '23505' || /duplicate|unique/i.test(String(e?.message))) throw new ConflictException({ code: 'MEMBER_EXISTS', message: 'Member with this phone/card already exists', messageTh: 'มีสมาชิกที่ใช้เบอร์/บัตรนี้แล้ว' });
      throw e;
    }
    const memberCode = `M-${String(row.id).padStart(6, '0')}`;
    await db.update(posMembers).set({ memberCode }).where(eq(posMembers.id, row.id));
    return { id: Number(row.id), member_code: memberCode, name: row.name, phone: row.phone, balance: 0 };
  }

  async lookup(q: { phone?: string; card?: string; code?: string }, user: JwtUser) {
    const db = this.db as any; this.tid(user);
    const conds: any[] = [];
    if (q.phone) conds.push(eq(posMembers.phone, q.phone));
    if (q.card) conds.push(eq(posMembers.cardNo, q.card));
    if (q.code) conds.push(eq(posMembers.memberCode, q.code));
    if (!conds.length) throw new BadRequestException({ code: 'BAD_QUERY', message: 'phone, card or code required', messageTh: 'ต้องระบุเบอร์/บัตร/รหัส' });
    const [m] = await db.select().from(posMembers).where(or(...conds)).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    return shape(m);
  }
  async balance(id: number, _user: JwtUser) {
    const db = this.db as any;
    const [m] = await db.select().from(posMembers).where(eq(posMembers.id, id)).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    return shape(m);
  }
  async history(id: number, _user: JwtUser, limit = 20) {
    const db = this.db as any;
    const [m] = await db.select().from(posMembers).where(eq(posMembers.id, id)).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    const rows = await db.select().from(posMemberLedger).where(eq(posMemberLedger.memberId, id)).orderBy(desc(posMemberLedger.id)).limit(limit);
    return { member_id: id, balance: n(m.balance), history: rows.map((r: any) => ({ txn_date: r.txnDate, txn_type: r.txnType, points: n(r.points), redeem_value: n(r.redeemValue), balance_after: n(r.balanceAfter), ref_doc: r.refDoc })) };
  }

  // EARN — inside the checkout tx. points = floor(netSpend × pointsPerBaht). Returns pointsEarned.
  async earnInTx(tx: any, tenantId: number, memberId: number, netSpend: number, saleNo: string, createdBy: string): Promise<number> {
    const cfg = await this.config();
    if (!cfg.enabled || !memberId) return 0;
    const pts = Math.floor(netSpend * cfg.pointsPerBaht);
    if (pts <= 0) return 0;
    // FOR UPDATE: this is a read-modify-write of an absolute balance. Without the lock, two concurrent
    // sales for the same member both read the same starting balance and the last writer wins → one earn is
    // lost (silent points/value loss). Mirrors redeemInTx's lock so earn+redeem serialize on the member row.
    const [m] = await tx.select().from(posMembers).where(eq(posMembers.id, memberId)).for('update').limit(1);
    const bal = n(m?.balance) + pts; const life = n(m?.lifetime) + pts;
    await tx.update(posMembers).set({ balance: String(bal), lifetime: String(life), lastUpdated: new Date() }).where(eq(posMembers.id, memberId));
    await tx.insert(posMemberLedger).values({ tenantId, memberId, txnType: 'Earn', points: String(pts), balanceAfter: String(bal), refDoc: saleNo, createdBy });
    return pts;
  }

  // REDEEM quote (validation) — returns the baht value buildSale uses as an order discount.
  async quoteRedeem(memberId: number, points: number, user: JwtUser) {
    const db = this.db as any; const cfg = await this.config();
    if (!cfg.enabled) throw new ConflictException({ code: 'LOYALTY_DISABLED', message: 'Loyalty program disabled', messageTh: 'ระบบสะสมแต้มปิดอยู่' });
    const [m] = await db.select().from(posMembers).where(eq(posMembers.id, memberId)).limit(1);
    if (!m || m.active === false) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found/inactive', messageTh: 'ไม่พบสมาชิก' });
    if (points <= 0) throw new BadRequestException({ code: 'BAD_POINTS', message: 'points must be > 0', messageTh: 'แต้มต้องมากกว่าศูนย์' });
    if (points > n(m.balance)) throw new ConflictException({ code: 'INSUFFICIENT_POINTS', message: `Balance ${n(m.balance)} < ${points}`, messageTh: `แต้มไม่พอ (มี ${n(m.balance)})` });
    return { member: m, redeemValue: round2(points * cfg.bahtPerPoint), bahtPerPoint: cfg.bahtPerPoint };
  }

  // REDEEM apply — inside the checkout tx, with the ACTUAL consumed points (after the bill clamp).
  async redeemInTx(tx: any, tenantId: number, memberId: number, points: number, redeemValue: number, saleNo: string, createdBy: string): Promise<number> {
    if (points <= 0) return 0;
    const [m] = await tx.select().from(posMembers).where(eq(posMembers.id, memberId)).for('update').limit(1);
    if (!m || n(m.balance) < points) throw new ConflictException({ code: 'INSUFFICIENT_POINTS', message: 'Insufficient points at redeem', messageTh: 'แต้มไม่พอ' });
    const bal = n(m.balance) - points;
    await tx.update(posMembers).set({ balance: String(bal), lastUpdated: new Date() }).where(eq(posMembers.id, memberId));
    await tx.insert(posMemberLedger).values({ tenantId, memberId, txnType: 'Redeem', points: String(-points), redeemValue: String(round2(redeemValue)), balanceAfter: String(bal), refDoc: saleNo, createdBy });
    return points;
  }
}

function shape(m: any) {
  return { id: Number(m.id), member_code: m.memberCode, name: m.name, phone: m.phone, card_no: m.cardNo, balance: n(m.balance), lifetime: n(m.lifetime), tier: m.tier, active: m.active };
}
