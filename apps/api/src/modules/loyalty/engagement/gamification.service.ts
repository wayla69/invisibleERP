import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { loyaltyMissions, loyaltyMissionProgress, posMembers, posMemberLedger, memberCoupons } from '../../../database/schema';
import { n } from '../../../database/queries';
import { DocNumberService } from '../../../common/doc-number.service';
import type { JwtUser } from '../../../common/decorators';

// CRM Phase 3 — gamification (missions / stamp cards). A member accrues progress toward a mission goal; on
// completion they claim a reward (bonus points → pos_member_ledger 'Adjust', which the liability accrual then
// books; or a coupon). EVERY query is explicitly tenant-scoped (RLS is bypassed for Admin). Single-claim is
// enforced by claimedAt under a FOR UPDATE lock on the member + the progress row.
@Injectable()
export class GamificationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    return user.tenantId;
  }

  async listMissions(user: JwtUser, q: { active?: boolean } = {}) {
    const db = this.db as any; const tenantId = this.tid(user);
    const conds: any[] = [eq(loyaltyMissions.tenantId, tenantId)];
    if (q.active !== undefined) conds.push(eq(loyaltyMissions.active, q.active));
    const rows = await db.select().from(loyaltyMissions).where(and(...conds)).orderBy(loyaltyMissions.id);
    return { missions: rows.map(shapeMission), count: rows.length };
  }

  async upsertMission(user: JwtUser, dto: any) {
    const db = this.db as any; const tenantId = this.tid(user);
    const vals: any = {
      name: dto.name, type: dto.type ?? 'stamp', goal: dto.goal ?? 1,
      rewardKind: dto.reward_kind ?? 'points', rewardPoints: dto.reward_points ?? 0,
      rewardCouponKind: dto.reward_coupon_kind ?? null, rewardCouponValue: String(dto.reward_coupon_value ?? 0),
      period: dto.period ?? null, active: dto.active ?? true,
    };
    if (dto.id) {
      const [r] = await db.update(loyaltyMissions).set(vals).where(and(eq(loyaltyMissions.id, dto.id), eq(loyaltyMissions.tenantId, tenantId))).returning();
      if (!r) throw new NotFoundException({ code: 'MISSION_NOT_FOUND', message: 'Mission not found', messageTh: 'ไม่พบภารกิจ' });
      return shapeMission(r);
    }
    const missionCode = await this.docNo.nextDaily('MSN');
    const [r] = await db.insert(loyaltyMissions).values({ ...vals, tenantId, missionCode, createdBy: user.username }).returning();
    return shapeMission(r);
  }

  async setMissionActive(user: JwtUser, id: number, active: boolean) {
    const db = this.db as any; const tenantId = this.tid(user);
    const [r] = await db.update(loyaltyMissions).set({ active }).where(and(eq(loyaltyMissions.id, id), eq(loyaltyMissions.tenantId, tenantId))).returning();
    if (!r) throw new NotFoundException({ code: 'MISSION_NOT_FOUND', message: 'Mission not found', messageTh: 'ไม่พบภารกิจ' });
    return shapeMission(r);
  }

  // Record progress (e.g. a stamp). Serialized per member via FOR UPDATE so the get-or-create is race-free.
  async addProgress(user: JwtUser, missionId: number, dto: { member_id: number; amount?: number }) {
    const db = this.db as any; const tenantId = this.tid(user);
    const amount = Math.max(1, Math.floor(dto.amount ?? 1));
    const [mission] = await db.select().from(loyaltyMissions).where(and(eq(loyaltyMissions.id, missionId), eq(loyaltyMissions.tenantId, tenantId))).limit(1);
    if (!mission || mission.active === false) throw new NotFoundException({ code: 'MISSION_NOT_FOUND', message: 'Mission not found/inactive', messageTh: 'ไม่พบภารกิจ' });
    return await db.transaction(async (tx: any) => {
      const [m] = await tx.select({ id: posMembers.id }).from(posMembers).where(and(eq(posMembers.id, dto.member_id), eq(posMembers.tenantId, tenantId))).for('update').limit(1);
      if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
      let [p] = await tx.select().from(loyaltyMissionProgress).where(and(eq(loyaltyMissionProgress.tenantId, tenantId), eq(loyaltyMissionProgress.memberId, dto.member_id), eq(loyaltyMissionProgress.missionId, missionId))).limit(1);
      if (!p) [p] = await tx.insert(loyaltyMissionProgress).values({ tenantId, memberId: dto.member_id, missionId, progress: 0 }).returning();
      const goal = Number(mission.goal);
      const newProgress = Math.min(goal, Number(p.progress) + amount);
      const completedAt = newProgress >= goal ? (p.completedAt ?? new Date()) : null;
      await tx.update(loyaltyMissionProgress).set({ progress: newProgress, completedAt, updatedAt: new Date() }).where(eq(loyaltyMissionProgress.id, p.id));
      return { member_id: dto.member_id, mission: mission.name, progress: newProgress, goal, completed: newProgress >= goal, claimed: !!p.claimedAt };
    });
  }

  // Claim a completed mission's reward — exactly once (claimedAt under FOR UPDATE).
  async claimMission(user: JwtUser, missionId: number, dto: { member_id: number }) {
    const db = this.db as any; const tenantId = this.tid(user);
    const [mission] = await db.select().from(loyaltyMissions).where(and(eq(loyaltyMissions.id, missionId), eq(loyaltyMissions.tenantId, tenantId))).limit(1);
    if (!mission) throw new NotFoundException({ code: 'MISSION_NOT_FOUND', message: 'Mission not found', messageTh: 'ไม่พบภารกิจ' });
    return await db.transaction(async (tx: any) => {
      const [m] = await tx.select().from(posMembers).where(and(eq(posMembers.id, dto.member_id), eq(posMembers.tenantId, tenantId))).for('update').limit(1);
      if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
      const [p] = await tx.select().from(loyaltyMissionProgress).where(and(eq(loyaltyMissionProgress.tenantId, tenantId), eq(loyaltyMissionProgress.memberId, dto.member_id), eq(loyaltyMissionProgress.missionId, missionId))).for('update').limit(1);
      if (!p || Number(p.progress) < Number(mission.goal)) throw new ConflictException({ code: 'MISSION_INCOMPLETE', message: 'Mission not yet completed', messageTh: 'ยังทำภารกิจไม่ครบ' });
      if (p.claimedAt) throw new ConflictException({ code: 'ALREADY_CLAIMED', message: 'Mission reward already claimed', messageTh: 'รับรางวัลไปแล้ว' });
      let reward: any;
      if (mission.rewardKind === 'coupon') {
        const code = await this.docNo.nextDaily('CPN');
        await tx.insert(memberCoupons).values({ tenantId, memberId: dto.member_id, code, kind: mission.rewardCouponKind ?? 'amount', value: String(n(mission.rewardCouponValue)), source: 'mission', status: 'active', createdBy: user.username });
        reward = { kind: 'coupon', code, value: n(mission.rewardCouponValue) };
      } else {
        const pts = Number(mission.rewardPoints ?? 0);
        const bal = n(m.balance) + pts; const life = n(m.lifetime) + pts;
        await tx.update(posMembers).set({ balance: String(bal), lifetime: String(life), lastUpdated: new Date() }).where(eq(posMembers.id, dto.member_id));
        await tx.insert(posMemberLedger).values({ tenantId, memberId: dto.member_id, txnType: 'Adjust', points: String(pts), balanceAfter: String(bal), refDoc: mission.missionCode, notes: `Mission reward: ${mission.name}`, createdBy: user.username });
        reward = { kind: 'points', points: pts, balance: bal };
      }
      await tx.update(loyaltyMissionProgress).set({ claimedAt: new Date(), updatedAt: new Date() }).where(eq(loyaltyMissionProgress.id, p.id));
      return { member_id: dto.member_id, mission: mission.name, claimed: true, reward };
    });
  }

  async memberMissions(user: JwtUser, memberId: number) {
    const db = this.db as any; const tenantId = this.tid(user);
    const missions = await db.select().from(loyaltyMissions).where(and(eq(loyaltyMissions.tenantId, tenantId), eq(loyaltyMissions.active, true))).orderBy(loyaltyMissions.id);
    const prog = await db.select().from(loyaltyMissionProgress).where(and(eq(loyaltyMissionProgress.memberId, memberId), eq(loyaltyMissionProgress.tenantId, tenantId)));
    const pmap: Record<number, any> = {};
    for (const p of prog) pmap[Number(p.missionId)] = p;
    return {
      member_id: memberId,
      missions: missions.map((mi: any) => {
        const p = pmap[Number(mi.id)];
        const progress = p ? Number(p.progress) : 0;
        return { ...shapeMission(mi), progress, completed: progress >= Number(mi.goal), claimed: !!p?.claimedAt };
      }),
    };
  }
}

function shapeMission(m: any) {
  return {
    id: Number(m.id), mission_code: m.missionCode, name: m.name, type: m.type, goal: Number(m.goal),
    reward_kind: m.rewardKind, reward_points: Number(m.rewardPoints ?? 0), reward_coupon_kind: m.rewardCouponKind,
    reward_coupon_value: n(m.rewardCouponValue), period: m.period, active: m.active,
  };
}
