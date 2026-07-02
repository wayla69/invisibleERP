import { Inject, Injectable, Optional, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { coalitions, coalitionMembers, posMembers, tenants, loyaltyConfig } from '../../database/schema';
import { n } from '../../database/queries';
import { runInTenantContext } from '../../common/tenant-run';
import { MemberService } from '../loyalty/member.service';
import { IntercompanyService } from '../intercompany/intercompany.service';
import type { JwtUser } from '../../common/decorators';
import { isUniqueViolation } from '../../common/db-error';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// W2 (docs/27) — coalition network: earn anywhere, burn anywhere, settle in the GL (control LYL-19).
// A member of home shop A earns/burns at partner shop B on the HOME (A) ledger via the same locked
// earnInTx/redeemInTx path, and every cross-shop movement posts an intercompany clearing entry at fair
// value ('loyalty-clearing': the debtor shop bears the loyalty cost it caused, due-from/due-to 1150/2150),
// so each shop's 2250 liability keeps tying out to ITS OWN members' ledger — by construction.
//
// RLS note: the caller is shop-B staff, whose per-request tenant tx cannot see shop A's rows. Cross-shop
// work therefore runs in a DELIBERATE bypass context (runInTenantContext, the background-worker primitive)
// — every such block is entered only AFTER validating that both shops share an ACTIVE coalition, and every
// query inside is explicitly tenant/member-scoped. The controller marks these routes @NoTx so the bypass
// tx is the only tx (a nested set_config would leak bypass into the caller's request tx otherwise).
// PDPA: cross-shop resolution returns code/name/tier/points ONLY — never contact, birthday, or consents.
@Injectable()
export class CoalitionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly members: MemberService,
    // Optional so partial harnesses without the intercompany module still construct; the coalition
    // earn/burn endpoints REQUIRE it (fail loudly rather than move points without the clearing entry).
    @Optional() private readonly ic?: IntercompanyService,
  ) {}

  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    return user.tenantId;
  }
  private hqOnly(user: JwtUser) {
    if (user.role !== 'Admin') throw new ForbiddenException({ code: 'COALITION_HQ_ONLY', message: 'Coalition configuration is HQ-only', messageTh: 'ตั้งค่าเครือข่ายพันธมิตรได้เฉพาะสำนักงานใหญ่' });
  }

  // ── HQ configuration (users/exec + Admin role) ────────────────────────────
  async createCoalition(dto: { code: string; name: string }, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    try {
      const rows = await db.insert(coalitions).values({ code: dto.code.trim(), name: dto.name.trim(), createdBy: user.username }).returning();
      const row = rows[0]!;
      return { id: Number(row.id), code: row.code, name: row.name, active: row.active };
    } catch (e: any) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'COALITION_EXISTS', message: `Coalition '${dto.code}' already exists`, messageTh: 'มีเครือข่ายรหัสนี้แล้ว' });
      throw e;
    }
  }

  async addMember(coalitionId: number, dto: { tenant_id: number }, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    const [c] = await db.select().from(coalitions).where(eq(coalitions.id, coalitionId)).limit(1);
    if (!c) throw new NotFoundException({ code: 'COALITION_NOT_FOUND', message: 'Coalition not found', messageTh: 'ไม่พบเครือข่าย' });
    const [t] = await db.select().from(tenants).where(eq(tenants.id, dto.tenant_id)).limit(1);
    if (!t) throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Tenant not found', messageTh: 'ไม่พบร้านค้า' });
    try {
      await db.insert(coalitionMembers).values({ coalitionId, tenantId: dto.tenant_id, createdBy: user.username });
    } catch (e: any) {
      if (isUniqueViolation(e)) {
        await db.update(coalitionMembers).set({ active: true }).where(and(eq(coalitionMembers.coalitionId, coalitionId), eq(coalitionMembers.tenantId, dto.tenant_id)));
        return { coalition_id: coalitionId, tenant_id: dto.tenant_id, active: true, rejoined: true };
      }
      throw e;
    }
    return { coalition_id: coalitionId, tenant_id: dto.tenant_id, active: true };
  }

  async removeMember(coalitionId: number, tenantId: number, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    const upd = await db.update(coalitionMembers).set({ active: false }).where(and(eq(coalitionMembers.coalitionId, coalitionId), eq(coalitionMembers.tenantId, tenantId))).returning({ id: coalitionMembers.id });
    if (!upd.length) throw new NotFoundException({ code: 'MEMBERSHIP_NOT_FOUND', message: 'Coalition membership not found', messageTh: 'ไม่พบร้านในเครือข่าย' });
    return { coalition_id: coalitionId, tenant_id: tenantId, active: false };
  }

  async list(user: JwtUser) {
    const db = this.db;
    const cs = await db.select().from(coalitions).orderBy(desc(coalitions.id));
    // Membership rows are RLS-scoped: a shop sees its own memberships; HQ/Admin (bypass) sees all.
    const ms = await db.select().from(coalitionMembers);
    return {
      coalitions: cs.map((c: any) => ({
        id: Number(c.id), code: c.code, name: c.name, active: c.active,
        members: ms.filter((m: any) => Number(m.coalitionId) === Number(c.id)).map((m: any) => ({ tenant_id: Number(m.tenantId), active: m.active })),
      })),
    };
  }

  // The caller-shop's ACTIVE coalition (one shop can practically belong to one active network at a time;
  // if several, the first by id wins deterministically). Returns null when the shop is in none.
  private async coalitionOf(tenantId: number): Promise<{ coalitionId: number; code: string } | null> {
    const db = this.db;
    const rows = await db.select({ cid: coalitionMembers.coalitionId, code: coalitions.code, cActive: coalitions.active })
      .from(coalitionMembers).innerJoin(coalitions, eq(coalitionMembers.coalitionId, coalitions.id))
      .where(and(eq(coalitionMembers.tenantId, tenantId), eq(coalitionMembers.active, true), eq(coalitions.active, true)))
      .orderBy(coalitionMembers.coalitionId);
    const first = rows[0];
    return first ? { coalitionId: Number(first.cid), code: first.code } : null;
  }
  private async shopsIn(coalitionId: number): Promise<number[]> {
    const db = this.db;
    const rows = await db.select({ tid: coalitionMembers.tenantId }).from(coalitionMembers).where(and(eq(coalitionMembers.coalitionId, coalitionId), eq(coalitionMembers.active, true)));
    return rows.map((r: any) => Number(r.tid));
  }

  // ── Cross-shop member resolution (staff at the partner till; PDPA-minimal) ──
  // Runs in a validated bypass block: membership tables + the roster row live in OTHER tenants.
  async resolve(user: JwtUser, phone: string) {
    const callerTid = this.tid(user);
    if (!phone) throw new BadRequestException({ code: 'BAD_QUERY', message: 'phone required', messageTh: 'ต้องระบุเบอร์โทร' });
    const base = this.db;
    return runInTenantContext(base, { tenantId: callerTid, bypass: true, actor: user.username }, async () => {
      const net = await this.coalitionOf(callerTid);
      if (!net) throw new NotFoundException({ code: 'NOT_IN_COALITION', message: 'This shop is not in a coalition', messageTh: 'ร้านนี้ไม่ได้อยู่ในเครือข่ายพันธมิตรแต้ม' });
      const shopIds = await this.shopsIn(net.coalitionId);
      const candidates: any[] = await base.select().from(posMembers).where(and(eq(posMembers.phone, phone), eq(posMembers.active, true)));
      const m = candidates.find((r: any) => shopIds.includes(Number(r.tenantId)));
      if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'No coalition member with that phone', messageTh: 'ไม่พบสมาชิกเครือข่ายจากเบอร์นี้' });
      const [home] = await base.select({ code: tenants.code, name: tenants.name }).from(tenants).where(eq(tenants.id, m.tenantId)).limit(1);
      // PDPA-minimal: identity + points standing only — no phone echo, email, birthday, or consents.
      return {
        coalition: net.code,
        member_id: Number(m.id), member_code: m.memberCode, name: m.name, tier: m.tier,
        balance: n(m.balance),
        home_tenant_id: Number(m.tenantId), home_tenant_code: home?.code ?? null, home_tenant_name: home?.name ?? null,
        is_home: Number(m.tenantId) === callerTid,
      };
    });
  }

  // ── Earn at a partner shop → HOME ledger + IC clearing (LYL-19) ────────────
  async earn(user: JwtUser, dto: { member_id: number; net_spend: number; ref_doc?: string }) {
    const callerTid = this.tid(user);
    if (!(dto.net_spend > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'net_spend must be > 0', messageTh: 'ยอดต้องมากกว่าศูนย์' });
    if (!this.ic) throw new ConflictException({ code: 'IC_UNAVAILABLE', message: 'Intercompany service unavailable — coalition movements cannot post without the clearing entry', messageTh: 'ระบบระหว่างกิจการไม่พร้อม' });
    const base = this.db;
    return runInTenantContext(base, { tenantId: callerTid, bypass: true, actor: user.username }, async () => {
      const { member, homeTid, net } = await this.validateCross(callerTid, dto.member_id);
      const refDoc = dto.ref_doc ?? `COAL-${net.code}-${callerTid}-${dto.member_id}`;
      const pts = await base.transaction((tx: any) => this.members.earnInTx(tx, homeTid, dto.member_id, dto.net_spend, refDoc, user.username));
      let icNo: string | null = null;
      if (pts > 0 && homeTid !== callerTid) {
        const [c] = await base.select().from(loyaltyConfig).where(eq(loyaltyConfig.id, 1)).limit(1);
        const fair = round2(pts * n(c?.bahtPerPoint));
        if (fair > 0) {
          // The partner (caller) shop CAUSED the home shop's liability to grow → partner owes home:
          // home = creditor (Dr 1150 due-from), partner = debtor (Cr 2150 due-to), both legs on 5700.
          const icRes: any = await this.ic!.createIcInternal({ from_tenant_id: homeTid, to_tenant_id: callerTid, amount: fair, currency: 'THB', category: 'loyalty-clearing', description: `Coalition ${net.code} earn ${pts} pts @ ${refDoc}` }, user.username);
          icNo = icRes.ic_no;
        }
      }
      const [after] = await base.select({ balance: posMembers.balance }).from(posMembers).where(eq(posMembers.id, dto.member_id)).limit(1);
      return { coalition: net.code, member_id: dto.member_id, home_tenant_id: homeTid, partner_tenant_id: callerTid, points_earned: pts, balance: n(after?.balance), ic_no: icNo, ref_doc: refDoc, member_code: member.memberCode };
    });
  }

  // ── Burn at a partner shop → HOME ledger + reverse IC clearing ─────────────
  async redeem(user: JwtUser, dto: { member_id: number; points: number; ref_doc?: string }) {
    const callerTid = this.tid(user);
    const points = Number(dto.points);
    if (!Number.isInteger(points) || points <= 0) throw new BadRequestException({ code: 'BAD_POINTS', message: 'points must be a positive integer', messageTh: 'แต้มต้องเป็นจำนวนเต็มบวก' });
    if (!this.ic) throw new ConflictException({ code: 'IC_UNAVAILABLE', message: 'Intercompany service unavailable — coalition movements cannot post without the clearing entry', messageTh: 'ระบบระหว่างกิจการไม่พร้อม' });
    const base = this.db;
    return runInTenantContext(base, { tenantId: callerTid, bypass: true, actor: user.username }, async () => {
      const { homeTid, net } = await this.validateCross(callerTid, dto.member_id);
      const [c] = await base.select().from(loyaltyConfig).where(eq(loyaltyConfig.id, 1)).limit(1);
      if (!c?.enabled) throw new ConflictException({ code: 'LOYALTY_DISABLED', message: 'Loyalty program disabled', messageTh: 'ระบบสะสมแต้มปิดอยู่' });
      const redeemValue = round2(points * n(c?.bahtPerPoint));
      const refDoc = dto.ref_doc ?? `COAL-${net.code}-${callerTid}-${dto.member_id}-RDM`;
      const consumed = await base.transaction((tx: any) => this.members.redeemInTx(tx, homeTid, dto.member_id, points, redeemValue, refDoc, user.username));
      let icNo: string | null = null;
      if (consumed > 0 && homeTid !== callerTid && redeemValue > 0) {
        // The partner shop honoured value the HOME shop owed the member → home owes partner:
        // partner = creditor (Dr 1150 due-from), home = debtor (Cr 2150 due-to).
        const icRes: any = await this.ic!.createIcInternal({ from_tenant_id: callerTid, to_tenant_id: homeTid, amount: redeemValue, currency: 'THB', category: 'loyalty-clearing', description: `Coalition ${net.code} burn ${points} pts @ ${refDoc}` }, user.username);
        icNo = icRes.ic_no;
      }
      const [after] = await base.select({ balance: posMembers.balance }).from(posMembers).where(eq(posMembers.id, dto.member_id)).limit(1);
      return { coalition: net.code, member_id: dto.member_id, home_tenant_id: homeTid, partner_tenant_id: callerTid, points_redeemed: consumed, redeem_value: redeemValue, balance: n(after?.balance), ic_no: icNo, ref_doc: refDoc };
    });
  }

  // Shared cross-shop validation (inside the bypass block): the member exists + is active, and their HOME
  // shop shares an ACTIVE coalition with the calling shop. Throws 404 for outsiders — existence of a
  // member in a non-coalition shop is never revealed.
  private async validateCross(callerTid: number, memberId: number) {
    const base = this.db;
    const net = await this.coalitionOf(callerTid);
    if (!net) throw new NotFoundException({ code: 'NOT_IN_COALITION', message: 'This shop is not in a coalition', messageTh: 'ร้านนี้ไม่ได้อยู่ในเครือข่ายพันธมิตรแต้ม' });
    const [member] = await base.select().from(posMembers).where(eq(posMembers.id, memberId)).limit(1);
    if (!member || member.active === false) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    const homeTid = Number(member.tenantId);
    const shopIds = await this.shopsIn(net.coalitionId);
    if (!shopIds.includes(homeTid)) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    return { member, homeTid, net };
  }
}
