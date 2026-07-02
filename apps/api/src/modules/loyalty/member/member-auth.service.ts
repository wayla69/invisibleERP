import { Inject, Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq, and, desc, gt, isNull, sql } from 'drizzle-orm';
import { randomInt, randomUUID } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { tenants, posMembers, memberOtps, messageLog, revokedTokens } from '../../../database/schema';
import { n } from '../../../database/queries';
import { PasswordService } from '../../auth/password.service';
import { resolveMessageGateway } from '../../messaging/gateways';
import { TenantMessagingService } from '../../messaging/tenant-messaging.service';
import { verifyLineIdToken } from '../line-auth';
import type { JwtUser } from '../../../common/decorators';
import { isUniqueViolation } from '../../../common/db-error';

// CRM Phase 4 — phone-OTP login for the loyalty member self-service app.
// The request/verify routes are @Public (RLS bypassed), so we resolve the tenant by code and filter every
// query EXPLICITLY by tenant_id + phone (no cross-tenant leak). The OTP is stored HASHED (scrypt), expires in
// 5 min, is single-use, and is attempt-bounded. request-otp never leaks whether a phone exists (always 200).
@Injectable()
export class MemberAuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordService,
    private readonly tenantMsg: TenantMessagingService,
  ) {}

  private async resolveMember(tenantCode: string, phone: string) {
    const db = this.db as any;
    const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, tenantCode)).limit(1);
    if (!t) return null;
    const tenantId = Number(t.id);
    const [m] = await db.select().from(posMembers).where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.phone, phone), eq(posMembers.active, true))).limit(1);
    return m ? { tenantId, member: m } : null;
  }

  async requestOtp(dto: { phone: string; tenant_code: string }) {
    const db = this.db as any;
    const resolved = await this.resolveMember(dto.tenant_code, dto.phone);
    // Always 200 (don't leak existence). Only generate/send when a member matches.
    if (resolved) {
      const { tenantId, member } = resolved;
      // Rate-limit: at most one live OTP per 60s.
      const recent = await db.select({ id: memberOtps.id }).from(memberOtps)
        .where(and(eq(memberOtps.tenantId, tenantId), eq(memberOtps.memberId, Number(member.id)), isNull(memberOtps.consumedAt), gt(memberOtps.createdAt, new Date(Date.now() - 60_000)))).limit(1);
      if (!recent.length) {
        const code = String(randomInt(100_000, 1_000_000)); // cryptographically-random 6-digit
        const codeHash = await this.passwords.hash(code);
        await db.update(memberOtps).set({ consumedAt: new Date() }).where(and(eq(memberOtps.tenantId, tenantId), eq(memberOtps.memberId, Number(member.id)), isNull(memberOtps.consumedAt))); // invalidate prior
        await db.insert(memberOtps).values({ tenantId, memberId: Number(member.id), codeHash, expiresAt: new Date(Date.now() + 5 * 60_000), attempts: 0 });
        // Deliver via SMS — TRANSACTIONAL, so NOT subject to marketing opt-out — and audit-log it. Use the
        // tenant's own SMS provider when configured (resolveCreds), else the platform env default, else mock.
        try {
          const creds = await this.tenantMsg.resolveCreds(tenantId, 'sms');
          const gw = resolveMessageGateway('sms', creds ?? undefined);
          const res = await gw.send(member.phone, `รหัสเข้าสู่ระบบสมาชิก: ${code} (หมดอายุใน 5 นาที)`);
          await db.insert(messageLog).values({ tenantId, memberId: Number(member.id), channel: 'sms', recipient: member.phone, body: 'OTP (login code)', campaign: 'otp', status: res.status, provider: res.provider, createdBy: 'system:otp' });
        } catch { /* delivery best-effort; the OTP row is already persisted */ }
        // dev_otp is returned ONLY outside production (local/test convenience) — never in prod.
        return { sent: true, ...(process.env.NODE_ENV !== 'production' ? { dev_otp: code } : {}) };
      }
      return { sent: true };
    }
    // No member: do a throwaway scrypt hash so the no-member path costs ~the same as the generate path —
    // closes the phone-enumeration timing oracle (latency no longer distinguishes enrolled from unenrolled).
    await this.passwords.hash(String(randomInt(100_000, 1_000_000))).catch(() => undefined);
    return { sent: true };
  }

  async verifyOtp(dto: { phone: string; tenant_code: string; code: string }) {
    const db = this.db as any;
    const fail = () => new UnauthorizedException({ code: 'OTP_INVALID', message: 'Invalid or expired code', messageTh: 'รหัสไม่ถูกต้องหรือหมดอายุ' });
    const resolved = await this.resolveMember(dto.tenant_code, dto.phone);
    if (!resolved) throw fail();
    const { tenantId, member } = resolved;
    // The route is @NoTx (auto-commit base pool), so each statement below COMMITS on its own — a failed-attempt
    // increment survives the 401 throw (a per-request tx would roll it back, so the cap could never accumulate).
    const [otp] = await db.select().from(memberOtps).where(and(eq(memberOtps.tenantId, tenantId), eq(memberOtps.memberId, Number(member.id)), isNull(memberOtps.consumedAt))).orderBy(desc(memberOtps.id)).limit(1);
    if (!otp || new Date(otp.expiresAt) < new Date() || Number(otp.attempts) >= 5) throw fail();
    const { ok } = await this.passwords.verify(dto.code, otp.codeHash);
    if (!ok) {
      // Atomic, auto-committing increment (DB evaluates attempts+1 — no JS read-modify-write, so concurrent
      // wrong guesses can't lose updates and bypass the cap). Guarded on still-unconsumed.
      await db.update(memberOtps).set({ attempts: sql`${memberOtps.attempts} + 1` }).where(and(eq(memberOtps.id, otp.id), isNull(memberOtps.consumedAt)));
      throw fail();
    }
    // Single-winner consume: only ONE concurrent success flips consumed_at and mints a token (RETURNING is
    // empty for any racing loser, which then fails).
    const consumed = await db.update(memberOtps).set({ consumedAt: new Date() }).where(and(eq(memberOtps.id, otp.id), isNull(memberOtps.consumedAt))).returning({ id: memberOtps.id });
    if (!consumed.length) throw fail();
    // Mint a MEMBER JWT — role 'Member', permissions [] (no staff access), tenant-scoped. A jti makes it
    // revocable (logout/incident denylist) and the guard re-checks pos_members.active each request; 7-day life.
    const token = await this.jwt.signAsync({ sub: `member:${member.id}`, kind: 'member', role: 'Member', tenantId, memberId: Number(member.id), permissions: [], customerName: null, jti: randomUUID() }, { expiresIn: '7d' });
    return { token, member: { id: Number(member.id), member_code: member.memberCode, name: member.name, tier: member.tier, balance: n(member.balance) } };
  }

  // ── ITGC-AC-15: member session revocation ────────────────────────────────────
  // Revoke a single member session: add the presented token's jti to the denylist so the global
  // JwtAuthGuard rejects it thereafter (mirrors AuthService.revokeToken for the staff flow). Used by
  // member logout so a token cleared from the browser cookie can't be replayed before its 7-day expiry.
  async revokeToken(token: string | undefined) {
    if (!token) return { revoked: false };
    let payload: any;
    try { payload = await this.jwt.verifyAsync(token); } catch { return { revoked: false }; }
    if (!payload?.jti) return { revoked: false };
    const expiresAt = payload.exp ? new Date(payload.exp * 1000) : new Date(Date.now() + 7 * 24 * 3600_000);
    await (this.db as any).insert(revokedTokens).values({ jti: payload.jti, username: payload.sub ?? null, expiresAt }).onConflictDoNothing();
    return { revoked: true };
  }

  // ── LINE LIFF (member self-service) ──────────────────────────────────────────
  // A signed-in member links their LINE account from a verified LIFF/LINE-Login idToken (reusing the shared
  // verifier — same LINE_LOGIN_CHANNEL_ID / mock-token path as the staff enrol/link flow). One LINE ↔ one
  // member per tenant via the partial unique.
  async linkLine(user: JwtUser, idToken: string) {
    const db = this.db as any;
    const { lineUserId, displayName } = await verifyLineIdToken(idToken);
    try {
      await db.update(posMembers).set({ lineUserId, lineDisplayName: displayName ?? null }).where(and(eq(posMembers.id, user.memberId!), eq(posMembers.tenantId, user.tenantId!)));
    } catch (e: any) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'LINE_ALREADY_LINKED', message: 'This LINE account is already linked to another member', messageTh: 'บัญชี LINE นี้ผูกกับสมาชิกอื่นแล้ว' });
      throw e;
    }
    return { linked: true, line_user_id: lineUserId };
  }

  // LINE login for the member app: verify the idToken (prod → LINE; dev → mock token), then mint a member
  // token for the member whose line_user_id matches WITHIN the tenant. @Public + @NoTx → RLS bypassed, so we
  // filter by tenant + lineUserId explicitly.
  async loginWithLine(dto: { tenant_code: string; id_token: string }) {
    const db = this.db as any;
    const notLinked = () => new UnauthorizedException({ code: 'LINE_NOT_LINKED', message: 'No member linked to this LINE account', messageTh: 'ยังไม่ได้ผูกบัญชี LINE กับสมาชิก' });
    const { lineUserId } = await verifyLineIdToken(dto.id_token); // throws LINE_VERIFY_FAILED / LINE_NOT_CONFIGURED
    const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, dto.tenant_code)).limit(1);
    if (!t) throw notLinked();
    const tenantId = Number(t.id);
    const [m] = await db.select().from(posMembers).where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.lineUserId, lineUserId), eq(posMembers.active, true))).limit(1);
    if (!m) throw notLinked();
    const token = await this.jwt.signAsync({ sub: `member:${m.id}`, kind: 'member', role: 'Member', tenantId, memberId: Number(m.id), permissions: [], customerName: null, jti: randomUUID() }, { expiresIn: '7d' });
    return { token, member: { id: Number(m.id), member_code: m.memberCode, name: m.name, tier: m.tier, balance: n(m.balance) } };
  }
}
