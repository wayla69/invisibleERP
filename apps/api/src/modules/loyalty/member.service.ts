import { Inject, Injectable, Optional, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, desc, or, sql, ilike, isNotNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { posMembers, posMemberLedger, loyaltyConfig, memberConsents, customerProfiles, loyaltyPostingRuns, loyaltyTiers, loyaltyTierHistory } from '../../database/schema';
import { n } from '../../database/queries';
import { LedgerService } from '../ledger/ledger.service';
import { BiLiveService } from '../bi/bi-live.service';
import type { JwtUser } from '../../common/decorators';
import { isUniqueViolation } from '../../common/db-error';
import { verifyLineIdToken } from './line-auth';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

@Injectable()
export class MemberService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
    // Optional so partial harnesses that don't wire BiLiveModule still construct. Real-time ticks are a
    // best-effort advisory signal (in-memory bus) — never a control; a rollback after publish is tolerable.
    @Optional() private readonly live?: BiLiveService,
  ) {}

  // Emit a live points-movement tick to the BiLive SSE bus (best-effort; the bus is optional + in-memory).
  private tick(tenantId: number, kind: 'earn' | 'redeem', memberId: number, points: number, balanceAfter: number, refDoc: string) {
    try { this.live?.publish({ type: 'loyalty_points', tenant_id: tenantId, kind, member_id: memberId, points, balance_after: balanceAfter, ref_doc: refDoc }); } catch { /* bus optional */ }
  }

  async config() {
    const db = this.db as any;
    const [c] = await db.select().from(loyaltyConfig).where(eq(loyaltyConfig.id, 1)).limit(1);
    return { enabled: !!c?.enabled, pointsPerBaht: n(c?.pointsPerBaht), bahtPerPoint: n(c?.bahtPerPoint), minRedeem: n(c?.minRedeem) };
  }
  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    return user.tenantId;
  }

  async enroll(dto: { name?: string; phone?: string; card_no?: string; email?: string; birthday?: string; marketing_opt_in?: boolean }, user: JwtUser) {
    const db = this.db as any; const tenantId = this.tid(user);
    let row;
    try {
      [row] = await db.insert(posMembers).values({ tenantId, memberCode: `M-TMP`, name: dto.name ?? null, phone: dto.phone ?? null, cardNo: dto.card_no ?? null, email: dto.email ?? null, birthday: dto.birthday ?? null, marketingOptIn: dto.marketing_opt_in ?? true, balance: '0', lifetime: '0', createdBy: user.username }).returning();
    } catch (e: any) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'MEMBER_EXISTS', message: 'Member with this phone/card already exists', messageTh: 'มีสมาชิกที่ใช้เบอร์/บัตรนี้แล้ว' });
      throw e;
    }
    const memberCode = `M-${String(row.id).padStart(6, '0')}`;
    await db.update(posMembers).set({ memberCode }).where(eq(posMembers.id, row.id));
    return { id: Number(row.id), member_code: memberCode, name: row.name, phone: row.phone, balance: 0 };
  }

  async lookup(q: { phone?: string; card?: string; code?: string; line_user_id?: string }, user: JwtUser) {
    const db = this.db as any; this.tid(user);
    const conds: any[] = [];
    if (q.phone) conds.push(eq(posMembers.phone, q.phone));
    if (q.card) conds.push(eq(posMembers.cardNo, q.card));
    if (q.code) conds.push(eq(posMembers.memberCode, q.code));
    if (q.line_user_id) conds.push(eq(posMembers.lineUserId, q.line_user_id));
    if (!conds.length) throw new BadRequestException({ code: 'BAD_QUERY', message: 'phone, card, code or line_user_id required', messageTh: 'ต้องระบุเบอร์/บัตร/รหัส/LINE' });
    const [m] = await db.select().from(posMembers).where(or(...conds)).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    return shape(m);
  }

  // Enrol-or-return a member from a verified LINE identity (LIFF/LINE-Login id token). Idempotent: a
  // second sign-in with the same LINE account returns the existing member, never a duplicate.
  async enrollViaLine(dto: { id_token: string; name?: string; phone?: string; marketing_opt_in?: boolean }, user: JwtUser) {
    const db = this.db as any; const tenantId = this.tid(user);
    const prof = await verifyLineIdToken(dto.id_token);
    const [existing] = await db.select().from(posMembers).where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.lineUserId, prof.lineUserId))).limit(1);
    if (existing) return { ...shape(existing), created: false };
    let row;
    try {
      [row] = await db.insert(posMembers).values({
        tenantId, memberCode: 'M-TMP', name: dto.name ?? prof.displayName ?? null, phone: dto.phone ?? null,
        lineUserId: prof.lineUserId, lineDisplayName: prof.displayName ?? null,
        marketingOptIn: dto.marketing_opt_in ?? true, balance: '0', lifetime: '0', createdBy: user.username,
      }).returning();
    } catch (e: any) {
      // lost a race to another concurrent sign-in → return the now-existing member
      if (isUniqueViolation(e)) {
        const [m] = await db.select().from(posMembers).where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.lineUserId, prof.lineUserId))).limit(1);
        if (m) return { ...shape(m), created: false };
      }
      throw e;
    }
    const memberCode = `M-${String(row.id).padStart(6, '0')}`;
    await db.update(posMembers).set({ memberCode }).where(eq(posMembers.id, row.id));
    return { ...shape({ ...row, memberCode }), created: true };
  }

  // Link a verified LINE identity to an EXISTING member (e.g. a phone member who later signs in with LINE).
  async linkLine(memberId: number, idToken: string, user: JwtUser) {
    const db = this.db as any; const tenantId = this.tid(user);
    const prof = await verifyLineIdToken(idToken);
    const [m] = await db.select().from(posMembers).where(eq(posMembers.id, memberId)).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    const [other] = await db.select().from(posMembers).where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.lineUserId, prof.lineUserId))).limit(1);
    if (other && Number(other.id) !== memberId) throw new ConflictException({ code: 'LINE_ALREADY_LINKED', message: 'That LINE account is already linked to another member', messageTh: 'บัญชี LINE นี้ถูกผูกกับสมาชิกอื่นแล้ว' });
    await db.update(posMembers).set({ lineUserId: prof.lineUserId, lineDisplayName: prof.displayName ?? m.lineDisplayName ?? null, lastUpdated: new Date() }).where(eq(posMembers.id, memberId));
    return this.balance(memberId, user);
  }
  async balance(id: number, _user: JwtUser) {
    const db = this.db as any;
    const [m] = await db.select().from(posMembers).where(eq(posMembers.id, id)).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    return shape(m);
  }

  // update member profile (contact + birthday + marketing consent)
  async update(id: number, dto: { name?: string; phone?: string; email?: string; birthday?: string | null; marketing_opt_in?: boolean; tier?: string; active?: boolean }, _user: JwtUser) {
    const db = this.db as any;
    const [m] = await db.select().from(posMembers).where(eq(posMembers.id, id)).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    const set: any = { lastUpdated: new Date() };
    if (dto.name !== undefined) set.name = dto.name;
    if (dto.phone !== undefined) set.phone = dto.phone;
    if (dto.email !== undefined) set.email = dto.email;
    if (dto.birthday !== undefined) set.birthday = dto.birthday;
    if (dto.marketing_opt_in !== undefined) set.marketingOptIn = dto.marketing_opt_in;
    if (dto.tier !== undefined) set.tier = dto.tier;
    if (dto.active !== undefined) set.active = dto.active;
    await db.update(posMembers).set(set).where(eq(posMembers.id, id));
    return this.balance(id, _user);
  }

  // members with a birthday today / this month (Asia/Bangkok), active & opted-in — for birthday campaigns
  async birthdays(window: 'today' | 'month', _user: JwtUser) {
    const db = this.db as any;
    const bkk = new Date(Date.now() + 7 * 3600 * 1000);
    const mo = bkk.getUTCMonth() + 1, day = bkk.getUTCDate();
    const rows = await db.select().from(posMembers).where(eq(posMembers.active, true));
    const out = rows.filter((m: any) => {
      if (!m.birthday || m.marketingOptIn === false) return false;
      const d = new Date(m.birthday + 'T00:00:00Z');
      return window === 'month' ? d.getUTCMonth() + 1 === mo : (d.getUTCMonth() + 1 === mo && d.getUTCDate() === day);
    });
    return { window, count: out.length, members: out.map(shape) };
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
    this.tick(tenantId, 'earn', memberId, pts, bal, saleNo);
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
    this.tick(tenantId, 'redeem', memberId, points, bal, saleNo);
    return points;
  }

  // ── CRM Phase 1 ────────────────────────────────────────────────────────────
  // Searchable member directory (left-joined to RFM segment). Read-only, tenant-scoped via RLS.
  async list(q: { q?: string; segment?: string; tier?: string; active?: boolean; limit?: number; offset?: number }, _user: JwtUser) {
    const db = this.db as any;
    const conds: any[] = [];
    if (q.q) { const s = `%${q.q}%`; conds.push(or(ilike(posMembers.name, s), ilike(posMembers.phone, s), ilike(posMembers.cardNo, s), ilike(posMembers.memberCode, s))); }
    if (q.tier) conds.push(eq(posMembers.tier, q.tier));
    if (q.active !== undefined) conds.push(eq(posMembers.active, q.active));
    if (q.segment) conds.push(eq(customerProfiles.rfmSegment, q.segment));
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const offset = Math.max(q.offset ?? 0, 0);
    const rows = await db.select({
      id: posMembers.id, memberCode: posMembers.memberCode, name: posMembers.name, phone: posMembers.phone,
      cardNo: posMembers.cardNo, tier: posMembers.tier, balance: posMembers.balance, lifetime: posMembers.lifetime,
      active: posMembers.active, marketingOptIn: posMembers.marketingOptIn, segment: customerProfiles.rfmSegment,
    }).from(posMembers).leftJoin(customerProfiles, eq(customerProfiles.memberId, posMembers.id))
      .where(conds.length ? and(...conds) : undefined).orderBy(desc(posMembers.id)).limit(limit).offset(offset);
    return {
      limit, offset, count: rows.length,
      members: rows.map((r: any) => ({ id: Number(r.id), member_code: r.memberCode, name: r.name, phone: r.phone, card_no: r.cardNo, tier: r.tier, balance: n(r.balance), lifetime: n(r.lifetime), active: r.active, marketing_opt_in: r.marketingOptIn !== false, segment: r.segment ?? null })),
    };
  }

  // Points-liability tie-out (TFRS 15 sub-ledger → GL control account 2250). Outstanding points × fair
  // value, reconciled against what has actually been posted to the GL (posted_liability via posting runs).
  // Basis = ALL members (you owe the points regardless of an `active` flag; forfeiture must be a ledger
  // Adjust). Explicitly tenant-scoped — RLS is bypassed for Admin, so an explicit tenant_id is required for
  // an HQ/Admin caller with no tenant context (mirrors postLiability + the ledger close routines).
  async liability(user: JwtUser, explicitTenantId?: number | null) {
    const db = this.db as any;
    const tenantId = user.tenantId ?? (explicitTenantId != null ? Number(explicitTenantId) : null);
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify tenant_id to read loyalty liability', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant_id เพื่อดูหนี้สินแต้ม' });
    const cfg = await this.config();
    const fairValue = cfg.bahtPerPoint;
    const [agg] = await db.select({
      pts: sql`coalesce(sum(${posMembers.balance}), 0)`,
      active: sql`coalesce(sum(case when ${posMembers.active} then 1 else 0 end), 0)`,
    }).from(posMembers).where(eq(posMembers.tenantId, tenantId));
    const moves = await db.select({ txnType: posMemberLedger.txnType, pts: sql`coalesce(sum(${posMemberLedger.points}), 0)`, val: sql`coalesce(sum(${posMemberLedger.redeemValue}), 0)` }).from(posMemberLedger).where(eq(posMemberLedger.tenantId, tenantId)).groupBy(posMemberLedger.txnType);
    const mv: Record<string, { points: number; value: number }> = {};
    for (const r of moves) mv[String(r.txnType)] = { points: n(r.pts), value: n(r.val) };
    const outstanding = n(agg?.pts);
    const liabilityValue = round2(outstanding * fairValue);
    const [pr] = await db.select({ posted: sql`coalesce(sum(${loyaltyPostingRuns.liabilityDelta}), 0)` }).from(loyaltyPostingRuns).where(eq(loyaltyPostingRuns.tenantId, tenantId));
    const postedLiability = round2(n(pr?.posted));
    return {
      control_account: '2250',
      fair_value_per_point: fairValue,
      outstanding_points: outstanding,
      active_members: Number(agg?.active ?? 0),
      liability_value: liabilityValue,
      posted_liability: postedLiability,           // amount already accrued to GL acct 2250 (via posting runs)
      unposted_value: round2(liabilityValue - postedLiability), // book-to-subledger gap awaiting the next run
      movements: {
        earned_points: mv['Earn']?.points ?? 0,
        redeemed_points: Math.abs(mv['Redeem']?.points ?? 0),
        redeemed_value: round2(mv['Redeem']?.value ?? 0),
        adjusted_points: mv['Adjust']?.points ?? 0,
        expired_points: Math.abs(mv['Expire']?.points ?? 0),
      },
    };
  }

  // Post the loyalty points-liability accrual to the GL (TFRS 15) — delegates to LedgerService.accrueLiability
  // (the accrual lives with the GL so the period-close can call it without a module cycle). Tenant-scoped:
  // an HQ/Admin caller with no tenant context MUST pass tenant_id (mirrors payroll's TENANT_REQUIRED guard).
  async postLiability(user: JwtUser, explicitTenantId?: number | null) {
    const tenantId = user.tenantId ?? (explicitTenantId != null ? Number(explicitTenantId) : null);
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify tenant_id to post loyalty liability', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant_id เพื่อบันทึกหนี้สินแต้ม' });
    return this.ledger.accrueLiability({ tenantId, createdBy: user.username });
  }

  // Expire aged points (breakage). Per the redeemable() model: points earned more than `expiry_days` ago,
  // net of redemptions, expire — written as an append-only 'Expire' ledger row that decrements the balance
  // (under a per-member FOR UPDATE lock). The next liability accrual then releases the matching 2250/5700.
  // Idempotent: a second run finds the balance already at the redeemable floor → expires nothing more.
  // Tenant-scoped (TENANT_REQUIRED for an HQ/Admin caller with no tenant).
  async expirePoints(user: JwtUser, explicitTenantId?: number | null) {
    const tenantId = user.tenantId ?? (explicitTenantId != null ? Number(explicitTenantId) : null);
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify tenant_id to expire points', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant_id เพื่อหมดอายุแต้ม' });
    return this.expireForTenant(tenantId, user.username);
  }

  private async expireForTenant(tenantId: number, createdBy: string) {
    const db = this.db as any;
    const [c] = await db.select().from(loyaltyConfig).limit(1);
    const expiryDays = Number(c?.expiryDays ?? 365); // matches redeemable(); explicit 0 = disabled
    if (!expiryDays || expiryDays <= 0) return { tenant_id: tenantId, expiry_days: expiryDays, expired_members: 0, expired_points: 0, note: 'expiry disabled (expiry_days = 0)' };
    const cutoffMs = Date.now() - expiryDays * 86400000;
    const ids = await db.select({ id: posMembers.id }).from(posMembers).where(and(eq(posMembers.tenantId, tenantId), sql`${posMembers.balance} > 0`));
    let expiredMembers = 0, expiredPoints = 0;
    for (const row of ids) {
      const expired = await db.transaction(async (tx: any) => {
        const [m] = await tx.select().from(posMembers).where(eq(posMembers.id, row.id)).for('update').limit(1);
        const bal = n(m?.balance);
        if (bal <= 0) return 0;
        const ledger = await tx.select().from(posMemberLedger).where(eq(posMemberLedger.memberId, row.id));
        let earnedRecent = 0, redeemed = 0, adjusted = 0;
        for (const e of ledger) {
          const pts = n(e.points);
          if (e.txnType === 'Earn') { if (new Date(e.txnDate).getTime() >= cutoffMs) earnedRecent += pts; }
          else if (e.txnType === 'Redeem') redeemed += Math.abs(pts);
          else if (e.txnType === 'Adjust') adjusted += pts; // manual adjustments don't age — never auto-expired
        }
        const redeemableBal = Math.max(0, earnedRecent + adjusted - redeemed);
        const toExpire = Math.max(0, Math.round(bal - redeemableBal));
        if (toExpire <= 0) return 0;
        const after = bal - toExpire;
        await tx.update(posMembers).set({ balance: String(after), lastUpdated: new Date() }).where(eq(posMembers.id, row.id));
        await tx.insert(posMemberLedger).values({ tenantId, memberId: row.id, txnType: 'Expire', points: String(-toExpire), balanceAfter: String(after), refDoc: 'EXPIRY', notes: `Expired after ${expiryDays} days`, createdBy });
        return toExpire;
      });
      if (expired > 0) { expiredMembers++; expiredPoints += expired; }
    }
    return { tenant_id: tenantId, expiry_days: expiryDays, expired_members: expiredMembers, expired_points: expiredPoints };
  }

  // Scheduled maintenance sweep (cron-callable) — for each tenant: expire aged points, then re-accrue the
  // liability so the GL stays current. Called by an external scheduler authenticated as an Admin (RLS bypass
  // ⇒ every tenant) or a tenant user (RLS ⇒ own tenant only); pass tenant_id to limit to one. Best-effort per
  // tenant — one tenant's failure (e.g. a closed period) is recorded and never aborts the others.
  async sweepMaintenance(user: JwtUser, explicitTenantId?: number | null) {
    const db = this.db as any;
    let tenantIds: number[];
    if (explicitTenantId != null) tenantIds = [Number(explicitTenantId)];
    else {
      const rows = await db.selectDistinct({ tid: posMembers.tenantId }).from(posMembers).where(isNotNull(posMembers.tenantId));
      tenantIds = rows.map((r: any) => Number(r.tid)).filter((x: number) => x > 0);
    }
    const results: any[] = [];
    let totalExpired = 0, accrualsPosted = 0, totalTierChanges = 0;
    for (const tenantId of tenantIds) {
      try {
        const expired: any = await this.expireForTenant(tenantId, 'system:sweep');
        const accrual: any = await this.ledger.accrueLiability({ tenantId, createdBy: 'system:sweep' });
        const tiers: any = await this.recomputeTiersForTenant(tenantId, 'system:sweep');
        totalExpired += Number(expired.expired_points ?? 0);
        if (accrual.posted) accrualsPosted++;
        totalTierChanges += Number(tiers.changed ?? 0);
        results.push({ tenant_id: tenantId, expired_points: expired.expired_points ?? 0, expired_members: expired.expired_members ?? 0, accrual: { posted: accrual.posted, liability_delta: accrual.liability_delta, posted_liability: accrual.posted_liability }, tier_changes: tiers.changed ?? 0 });
      } catch (e: any) {
        results.push({ tenant_id: tenantId, error: String(e?.message ?? e) });
      }
    }
    return { tenants_processed: tenantIds.length, total_expired_points: totalExpired, accruals_posted: accrualsPosted, tier_changes: totalTierChanges, results };
  }

  // ── Tier auto-recompute (CRM Phase 3) ───────────────────────────────────────
  // Recompute each member's tier from lifetime points against the tenant's loyalty_tiers ladder; on a change
  // update pos_members.tier and append a loyalty_tier_history audit row (under a per-member FOR UPDATE lock).
  // Tenant-scoped explicitly (RLS is bypassed for Admin). Driven by the maintenance sweep + a manual endpoint.
  async recomputeTiers(user: JwtUser, explicitTenantId?: number | null) {
    const tenantId = user.tenantId ?? (explicitTenantId != null ? Number(explicitTenantId) : null);
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify tenant_id to recompute tiers', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant_id เพื่อคำนวณระดับสมาชิก' });
    return this.recomputeTiersForTenant(tenantId, user.username);
  }

  private async recomputeTiersForTenant(tenantId: number, createdBy: string) {
    const db = this.db as any;
    const tiers = await db.select().from(loyaltyTiers).where(and(eq(loyaltyTiers.tenantId, tenantId), eq(loyaltyTiers.active, true))).orderBy(desc(loyaltyTiers.minLifetime));
    if (!tiers.length) return { tenant_id: tenantId, changed: 0, note: 'no tiers configured' };
    const members = await db.select({ id: posMembers.id, lifetime: posMembers.lifetime, tier: posMembers.tier }).from(posMembers).where(eq(posMembers.tenantId, tenantId));
    let changed = 0;
    const tierFor = (lifetime: number, fallback: string | null) => (tiers.find((t: any) => lifetime >= n(t.minLifetime))?.tier ?? fallback);
    for (const m of members) {
      const snapTier = tierFor(n(m.lifetime), m.tier ?? null); // cheap snapshot pre-filter
      if (!snapTier || snapTier === m.tier) continue;
      await db.transaction(async (tx: any) => {
        const [cur] = await tx.select().from(posMembers).where(eq(posMembers.id, m.id)).for('update').limit(1);
        if (!cur) return;
        // Recompute from the LOCKED lifetime so the audit row is exact even if a concurrent earn/recompute ran.
        const freshTier = tierFor(n(cur.lifetime), cur.tier ?? null);
        if (!freshTier || freshTier === cur.tier) return;
        await tx.update(posMembers).set({ tier: freshTier, lastUpdated: new Date() }).where(eq(posMembers.id, m.id));
        await tx.insert(loyaltyTierHistory).values({ tenantId, memberId: m.id, fromTier: cur.tier ?? null, toTier: freshTier, reason: 'recompute', lifetime: String(n(cur.lifetime)), createdBy });
        changed++;
      });
    }
    return { tenant_id: tenantId, changed };
  }

  // Tier journey for a member — current tier, the next tier up, and progress toward it. Tenant-scoped.
  async tierJourney(user: JwtUser, memberId: number) {
    const db = this.db as any; const tenantId = this.tid(user);
    const [m] = await db.select().from(posMembers).where(and(eq(posMembers.id, memberId), eq(posMembers.tenantId, tenantId))).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    const tiers = await db.select().from(loyaltyTiers).where(and(eq(loyaltyTiers.tenantId, tenantId), eq(loyaltyTiers.active, true))).orderBy(loyaltyTiers.minLifetime);
    const life = n(m.lifetime);
    const current = [...tiers].reverse().find((t: any) => life >= n(t.minLifetime)) ?? null;
    const next = tiers.find((t: any) => n(t.minLifetime) > life) ?? null;
    const currentMin = current ? n(current.minLifetime) : 0;
    const toNext = next ? Math.max(0, n(next.minLifetime) - life) : 0;
    const span = next ? n(next.minLifetime) - currentMin : 0;
    const progressPct = next ? (span > 0 ? Math.min(100, Math.round(((life - currentMin) / span) * 100)) : 0) : 100;
    const history = await db.select().from(loyaltyTierHistory).where(eq(loyaltyTierHistory.memberId, memberId)).orderBy(desc(loyaltyTierHistory.id)).limit(10);
    return {
      member_id: memberId, tier: m.tier, lifetime: life,
      current_tier: current?.tier ?? m.tier ?? null, next_tier: next?.tier ?? null, to_next: toNext, progress_pct: progressPct,
      tiers: tiers.map((t: any) => ({ tier: t.tier, min_lifetime: n(t.minLifetime), earn_mult: n(t.earnMult), redeem_mult: n(t.redeemMult) })),
      history: history.map((h: any) => ({ from_tier: h.fromTier, to_tier: h.toTier, reason: h.reason, lifetime: n(h.lifetime), effective_at: h.effectiveAt })),
    };
  }

  // PDPA consents for a member — per-purpose rows + the synced marketing flag.
  async getConsents(id: number, _user: JwtUser) {
    const db = this.db as any;
    const [m] = await db.select().from(posMembers).where(eq(posMembers.id, id)).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    const rows = await db.select().from(memberConsents).where(eq(memberConsents.memberId, id)).orderBy(memberConsents.purpose);
    return { member_id: id, marketing_opt_in: m.marketingOptIn !== false, consents: rows.map((r: any) => ({ purpose: r.purpose, channel: r.channel, granted: r.granted, source: r.source, granted_at: r.grantedAt, withdrawn_at: r.withdrawnAt, updated_at: r.updatedAt })) };
  }

  // Set/withdraw a consent purpose (upsert). 'marketing' syncs pos_members.marketing_opt_in (back-compat),
  // so the existing messaging blast automatically honours opt-out.
  async setConsent(id: number, dto: { purpose: string; granted: boolean; channel?: string; source?: string }, user: JwtUser) {
    const db = this.db as any; const tenantId = this.tid(user);
    const [m] = await db.select().from(posMembers).where(eq(posMembers.id, id)).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    const now = new Date();
    await db.insert(memberConsents).values({
      tenantId, memberId: id, purpose: dto.purpose, channel: dto.channel ?? null, granted: dto.granted,
      source: dto.source ?? 'admin', grantedAt: dto.granted ? now : null, withdrawnAt: dto.granted ? null : now,
      createdBy: user.username, updatedAt: now,
    }).onConflictDoUpdate({
      target: [memberConsents.memberId, memberConsents.purpose],
      set: { granted: dto.granted, channel: dto.channel ?? null, source: dto.source ?? 'admin', grantedAt: dto.granted ? now : null, withdrawnAt: dto.granted ? null : now, updatedAt: now },
    });
    if (dto.purpose === 'marketing') await db.update(posMembers).set({ marketingOptIn: dto.granted, lastUpdated: now }).where(eq(posMembers.id, id));
    return this.getConsents(id, user);
  }
}

function shape(m: any) {
  return { id: Number(m.id), member_code: m.memberCode, name: m.name, phone: m.phone, card_no: m.cardNo, email: m.email, line_user_id: m.lineUserId ?? null, line_display_name: m.lineDisplayName ?? null, birthday: m.birthday ?? null, marketing_opt_in: m.marketingOptIn !== false, balance: n(m.balance), lifetime: n(m.lifetime), tier: m.tier, active: m.active };
}
