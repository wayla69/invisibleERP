import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq, and, desc, gt, isNull, sql } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants, posMembers, memberOtps, messageLog } from '../../database/schema';
import { n } from '../../database/queries';
import { PasswordService } from '../auth/password.service';
import { resolveMessageGateway } from '../messaging/gateways';

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
        // Deliver via SMS — TRANSACTIONAL, so NOT subject to marketing opt-out — and audit-log it.
        try {
          const gw = resolveMessageGateway('sms');
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
    // Mint a MEMBER JWT — role 'Member', permissions [] (no staff access), tenant-scoped, 30-day life.
    const token = await this.jwt.signAsync({ sub: `member:${member.id}`, kind: 'member', role: 'Member', tenantId, memberId: Number(member.id), permissions: [], customerName: null }, { expiresIn: '30d' });
    return { token, member: { id: Number(member.id), member_code: member.memberCode, name: member.name, tier: member.tier, balance: n(member.balance) } };
  }
}
