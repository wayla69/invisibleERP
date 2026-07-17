import { BadRequestException } from '@nestjs/common';
import { eq, and, sql, isNotNull } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { posMembers, posMemberLedger, loyaltyConfig, loyaltyExpiryNotices } from '../../database/schema';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// Points lifecycle sub-service (expiry/breakage, the scheduled maintenance sweep, and the W1 expiry
// look-ahead) — a PLAIN class built in the MemberService ctor body (not a DI provider; the god-service
// ratchet pattern). GL accrual, VIP lapse, tier recompute and the webhook/automation fan-outs stay owned
// by their services and come in as ports (the optional ones absent exactly when the facade's @Optional
// deps are absent, preserving the partial-harness behaviour).
export class MemberLifecycleService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly ports: {
      accrueLiability: (args: { tenantId: number; createdBy: string }) => Promise<any>;
      recomputeTiersForTenant: (tenantId: number, createdBy: string) => Promise<any>;
      expireLapsedVip?: (tenantId: number, createdBy: string) => Promise<any>;
      deliverWebhook?: (event: string, payload: any, tenantId: number) => Promise<any>;
      runAutomation?: (event: string, payload: any, user: JwtUser) => Promise<any>;
    },
  ) {}

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

  async expireForTenant(tenantId: number, createdBy: string) {
    const db = this.db;
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
          // W1 P2P transfers: an inbound transfer ages from ITS OWN date (like an earn — otherwise a fresh
          // gift would expire instantly, redeemable=0); an outbound one consumes like a redeem.
          else if (e.txnType === 'Transfer') { if (pts > 0) { if (new Date(e.txnDate).getTime() >= cutoffMs) earnedRecent += pts; } else redeemed += Math.abs(pts); }
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
    const db = this.db;
    let tenantIds: number[];
    if (explicitTenantId != null) tenantIds = [Number(explicitTenantId)];
    else {
      const rows = await db.selectDistinct({ tid: posMembers.tenantId }).from(posMembers).where(isNotNull(posMembers.tenantId));
      tenantIds = rows.map((r: any) => Number(r.tid)).filter((x: number) => x > 0);
    }
    const results: any[] = [];
    let totalExpired = 0, accrualsPosted = 0, totalTierChanges = 0, totalExpiryNotices = 0;
    for (const tenantId of tenantIds) {
      try {
        const expired: any = await this.expireForTenant(tenantId, 'system:sweep');
        const accrual: any = await this.ports.accrueLiability({ tenantId, createdBy: 'system:sweep' });
        const vip: any = this.ports.expireLapsedVip ? await this.ports.expireLapsedVip(tenantId, 'system:sweep') : { expired: 0 }; // V4: lapse BEFORE recompute
        const tiers: any = await this.ports.recomputeTiersForTenant(tenantId, 'system:sweep');
        const notices: any = await this.notifyExpiring(tenantId, user);
        totalExpired += Number(expired.expired_points ?? 0);
        if (accrual.posted) accrualsPosted++;
        totalTierChanges += Number(tiers.changed ?? 0);
        totalExpiryNotices += Number(notices.fired ?? 0);
        results.push({ tenant_id: tenantId, expired_points: expired.expired_points ?? 0, expired_members: expired.expired_members ?? 0, accrual: { posted: accrual.posted, liability_delta: accrual.liability_delta, posted_liability: accrual.posted_liability }, tier_changes: tiers.changed ?? 0, expiry_notices: notices.fired ?? 0, vip_expired: vip.expired ?? 0 });
      } catch (e: any) {
        results.push({ tenant_id: tenantId, error: String(e?.message ?? e) });
      }
    }
    return { tenants_processed: tenantIds.length, total_expired_points: totalExpired, accruals_posted: accrualsPosted, tier_changes: totalTierChanges, expiry_notices: totalExpiryNotices, results };
  }

  // ── W1 (docs/27) — points-expiry look-ahead ────────────────────────────────
  // Members whose points will expire within `lookAheadDays` (default 30) fire ONE `loyalty.points_expiring`
  // event per member × expire-by date into the webhook fan-out + the automation catalog — a marketer wires
  // it to a journey/message ("แต้มจะหมดอายุใน 30 วัน") with the usual consent path. Idempotency rides the
  // loyalty_expiry_notices unique index (member_id, expire_by): a daily sweep re-fires only when a NEW batch
  // approaches its expiry date, never re-nagging about the same one. The math mirrors expireForTenant with
  // the cutoff shifted forward: what would expire if today were `lookAheadDays` from now, minus what is
  // already expirable today (that part belongs to expireForTenant, not a warning).
  // V1 (docs/29) — a member's own upcoming expiry, for the /m warning chip. Reads the W1 look-ahead
  // register (soonest future batch only); read-only, self-scoped by the caller (memberId from the token).
  async expiringForMember(memberId: number) {
    const db = this.db as DrizzleDb & Record<string, any>;
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10); // BKK business day
    const rows = await db.select().from(loyaltyExpiryNotices)
      .where(and(eq(loyaltyExpiryNotices.memberId, memberId), sql`${loyaltyExpiryNotices.expireBy} >= ${today}`))
      .orderBy(loyaltyExpiryNotices.expireBy).limit(1);
    const r: any = rows[0];
    if (!r) return { member_id: memberId, expiring_points: 0, expire_by: null, days_left: null };
    const expireByYmd = String(r.expireBy).slice(0, 10);
    const daysLeft = Math.max(0, Math.ceil((new Date(expireByYmd + 'T00:00:00Z').getTime() - 7 * 3600_000 + 86_400_000 - Date.now()) / 86_400_000));
    return { member_id: memberId, expiring_points: n(r.expiringPoints), expire_by: expireByYmd, days_left: daysLeft };
  }

  async notifyExpiring(tenantId: number, user: JwtUser, lookAheadDays = 30) {
    const db = this.db as DrizzleDb & Record<string, any>;
    const [c] = await db.select().from(loyaltyConfig).limit(1);
    const expiryDays = Number(c?.expiryDays ?? 365);
    if (!expiryDays || expiryDays <= 0) return { tenant_id: tenantId, fired: 0, note: 'expiry disabled' };
    const nowMs = Date.now();
    const cutoffNowMs = nowMs - expiryDays * 86400000;                       // earns older than this are already expired
    const cutoffFutureMs = cutoffNowMs + lookAheadDays * 86400000;           // ...and these will be, within the look-ahead
    const ids = await db.select({ id: posMembers.id, balance: posMembers.balance }).from(posMembers).where(and(eq(posMembers.tenantId, tenantId), sql`${posMembers.balance} > 0`));
    let fired = 0;
    for (const row of ids) {
      const bal = n(row.balance);
      const ledger = await db.select().from(posMemberLedger).where(eq(posMemberLedger.memberId, row.id));
      let aliveNow = 0, aliveFuture = 0, redeemed = 0, adjusted = 0; let oldestExpiringMs: number | null = null;
      for (const e of ledger) {
        const pts = n(e.points);
        const tms = e.txnDate ? new Date(e.txnDate).getTime() : 0;
        const agedEarn = e.txnType === 'Earn' || (e.txnType === 'Transfer' && pts > 0);
        if (agedEarn) {
          if (tms >= cutoffNowMs) aliveNow += pts;
          if (tms >= cutoffFutureMs) aliveFuture += pts;
          else if (tms >= cutoffNowMs && (oldestExpiringMs == null || tms < oldestExpiringMs)) oldestExpiringMs = tms;
        } else if (e.txnType === 'Redeem' || (e.txnType === 'Transfer' && pts < 0)) redeemed += Math.abs(pts);
        else if (e.txnType === 'Adjust') adjusted += pts;
      }
      const redeemableNow = Math.max(0, aliveNow + adjusted - redeemed);
      const redeemableFuture = Math.max(0, aliveFuture + adjusted - redeemed);
      const expiring = Math.round(Math.min(redeemableNow, bal) - Math.min(redeemableFuture, bal));
      if (expiring <= 0 || oldestExpiringMs == null) continue;
      // expire_by = the day the oldest at-risk earn crosses expiry_days (Bangkok business day)
      const expireBy = new Date(oldestExpiringMs + expiryDays * 86400000 + 7 * 3600_000).toISOString().slice(0, 10);
      const ins = await db.insert(loyaltyExpiryNotices).values({ tenantId, memberId: row.id, expireBy, expiringPoints: String(expiring) }).onConflictDoNothing().returning({ id: loyaltyExpiryNotices.id });
      if (!ins.length) continue; // already notified about this batch
      fired++;
      const daysLeft = Math.max(0, Math.ceil((oldestExpiringMs + expiryDays * 86400000 - nowMs) / 86400000));
      const payload = { member_id: Number(row.id), expiring_points: expiring, days_left: daysLeft, expire_by: expireBy };
      try { await this.ports.deliverWebhook?.('loyalty.points_expiring', payload, tenantId); } catch { /* best-effort */ }
      try { await this.ports.runAutomation?.('loyalty.points_expiring', payload, user); } catch { /* best-effort */ }
    }
    return { tenant_id: tenantId, look_ahead_days: lookAheadDays, fired };
  }
}
