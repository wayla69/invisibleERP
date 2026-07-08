import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { loyaltyReferrals, posMembers, posMemberLedger } from '../../../database/schema';
import { blindIndex } from '../../../database/encrypted-column';
import { n } from '../../../database/queries';
import { DocNumberService } from '../../../common/doc-number.service';
import { pgError, isUniqueViolation } from '../../../common/db-error';
import type { JwtUser } from '../../../common/decorators';

const DEFAULT_POINTS = 50;

// CRM Phase 4 — member-get-member referrals. A member refers another; on reward both sides receive bonus
// points (a pos_member_ledger 'Adjust' row → the liability accrual books it). Single-reward enforced by the
// referral status under FOR UPDATE. Every query is explicitly tenant-scoped (RLS is bypassed for Admin).
@Injectable()
export class ReferralsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    return user.tenantId;
  }

  async createReferral(user: JwtUser, dto: { referrer_member_id: number; referred_member_id?: number; referred_phone?: string; referrer_points?: number; referred_points?: number }) {
    const db = this.db; const tenantId = this.tid(user);
    const [referrer] = await db.select({ id: posMembers.id }).from(posMembers).where(and(eq(posMembers.id, dto.referrer_member_id), eq(posMembers.tenantId, tenantId))).limit(1);
    if (!referrer) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Referrer not found', messageTh: 'ไม่พบสมาชิกผู้แนะนำ' });
    // Resolve the referred member: by explicit id, or by phone if that phone ALREADY belongs to a member (an
    // enrolled friend links immediately → rewardable). An unknown phone stays pending (linked on future
    // enrollment). Self-referral is blocked either way — including referring one's OWN phone.
    let referredMemberId = dto.referred_member_id ?? null;
    if (referredMemberId == null && dto.referred_phone) {
      const [byPhone] = await db.select({ id: posMembers.id }).from(posMembers).where(and(eq(posMembers.phoneBidx, blindIndex(dto.referred_phone) ?? ''), eq(posMembers.tenantId, tenantId), eq(posMembers.active, true))).limit(1);
      if (byPhone) referredMemberId = Number(byPhone.id);
    }
    if (referredMemberId != null) {
      if (referredMemberId === dto.referrer_member_id) throw new BadRequestException({ code: 'SELF_REFERRAL', message: 'A member cannot refer themselves', messageTh: 'แนะนำตัวเองไม่ได้' });
      const [referred] = await db.select({ id: posMembers.id }).from(posMembers).where(and(eq(posMembers.id, referredMemberId), eq(posMembers.tenantId, tenantId))).limit(1);
      if (!referred) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Referred member not found', messageTh: 'ไม่พบสมาชิกที่ถูกแนะนำ' });
    }
    const code = await this.docNo.nextDaily('RFL');
    const referrerPoints = dto.referrer_points ?? DEFAULT_POINTS;
    const referredPoints = dto.referred_points ?? DEFAULT_POINTS;
    try {
      const [r] = await db.insert(loyaltyReferrals).values({ tenantId, referrerMemberId: dto.referrer_member_id, referredMemberId, referredPhone: dto.referred_phone ?? null, code, status: 'pending', referrerPoints, referredPoints, createdBy: user.username }).returning();
      return shapeReferral(r);
    } catch (e: any) {
      // Map ONLY the referred-member partial-unique to ALREADY_REFERRED (don't mask a code-unique collision).
      // Real Postgres exposes constraint_name; PGlite may not, so fall back to the generic unique check then.
      const pe = pgError(e); // drizzle 0.45 nests the driver error (constraint/code) under .cause
      const con = String(pe?.constraint_name ?? pe?.constraint ?? '');
      const isUnique = isUniqueViolation(e);
      const msg = String(pe?.message ?? (e as any)?.message ?? '');
      if (con === 'loyalty_referrals_referred_uq' || (!con && isUnique && !/code/i.test(msg))) {
        throw new ConflictException({ code: 'ALREADY_REFERRED', message: 'This member has already been referred', messageTh: 'สมาชิกนี้ถูกแนะนำไปแล้ว' });
      }
      throw e;
    }
  }

  // Reward a referral — grant both sides their bonus points, exactly once (status under FOR UPDATE).
  async rewardReferral(user: JwtUser, id: number) {
    const db = this.db; const tenantId = this.tid(user);
    return await db.transaction(async (tx: any) => {
      const [ref] = await tx.select().from(loyaltyReferrals).where(and(eq(loyaltyReferrals.id, id), eq(loyaltyReferrals.tenantId, tenantId))).for('update').limit(1);
      if (!ref) throw new NotFoundException({ code: 'REFERRAL_NOT_FOUND', message: 'Referral not found', messageTh: 'ไม่พบรายการแนะนำ' });
      if (ref.status === 'rewarded') throw new ConflictException({ code: 'ALREADY_REWARDED', message: 'Referral already rewarded', messageTh: 'ให้รางวัลไปแล้ว' });
      if (ref.status === 'void') throw new ConflictException({ code: 'REFERRAL_VOID', message: 'Referral voided', messageTh: 'รายการถูกยกเลิก' });
      if (ref.referredMemberId == null) throw new ConflictException({ code: 'REFERRED_NOT_LINKED', message: 'Referred member is not enrolled yet', messageTh: 'ผู้ถูกแนะนำยังไม่เป็นสมาชิก' });
      // Lock both members in a DETERMINISTIC order (ascending id) before granting, so two mirror referrals
      // ("A refers B" and "B refers A", which sit on different rows) cannot deadlock (ABBA) on the member
      // rows. grantPoints re-locks the same rows below — a no-op since this tx already holds them.
      for (const mid of [Number(ref.referrerMemberId), Number(ref.referredMemberId)].sort((a, b) => a - b)) {
        await tx.select({ id: posMembers.id }).from(posMembers).where(and(eq(posMembers.id, mid), eq(posMembers.tenantId, tenantId))).for('update').limit(1);
      }
      const refrId = await this.grantPoints(tx, tenantId, Number(ref.referrerMemberId), Number(ref.referrerPoints), ref.code, `Referral reward (referrer)`, user.username);
      const refdId = await this.grantPoints(tx, tenantId, Number(ref.referredMemberId), Number(ref.referredPoints), ref.code, `Referral reward (referred)`, user.username);
      await tx.update(loyaltyReferrals).set({ status: 'rewarded', rewardedAt: new Date() }).where(eq(loyaltyReferrals.id, id));
      return { id: Number(ref.id), code: ref.code, status: 'rewarded', referrer: { member_id: Number(ref.referrerMemberId), points: Number(ref.referrerPoints), balance: refrId }, referred: { member_id: Number(ref.referredMemberId), points: Number(ref.referredPoints), balance: refdId } };
    });
  }

  // Grant bonus points to a member (Adjust row + balance & lifetime increment) under a FOR UPDATE lock.
  private async grantPoints(tx: any, tenantId: number, memberId: number, pts: number, ref: string, note: string, createdBy: string): Promise<number> {
    const [m] = await tx.select().from(posMembers).where(and(eq(posMembers.id, memberId), eq(posMembers.tenantId, tenantId))).for('update').limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    if (pts <= 0) return n(m.balance);
    const bal = n(m.balance) + pts; const life = n(m.lifetime) + pts;
    await tx.update(posMembers).set({ balance: String(bal), lifetime: String(life), lastUpdated: new Date() }).where(eq(posMembers.id, memberId));
    await tx.insert(posMemberLedger).values({ tenantId, memberId, txnType: 'Adjust', points: String(pts), balanceAfter: String(bal), refDoc: ref, notes: note, createdBy });
    return bal;
  }

  async memberReferrals(user: JwtUser, memberId: number) {
    const db = this.db; const tenantId = this.tid(user);
    const rows = await db.select().from(loyaltyReferrals).where(and(eq(loyaltyReferrals.referrerMemberId, memberId), eq(loyaltyReferrals.tenantId, tenantId))).orderBy(desc(loyaltyReferrals.id)).limit(50);
    return { member_id: memberId, referrals: rows.map(shapeReferral) };
  }
}

function shapeReferral(r: any) {
  return {
    id: Number(r.id), code: r.code, status: r.status,
    referrer_member_id: r.referrerMemberId != null ? Number(r.referrerMemberId) : null,
    referred_member_id: r.referredMemberId != null ? Number(r.referredMemberId) : null,
    referred_phone: r.referredPhone, referrer_points: Number(r.referrerPoints), referred_points: Number(r.referredPoints),
    created_at: r.createdAt, rewarded_at: r.rewardedAt,
  };
}
