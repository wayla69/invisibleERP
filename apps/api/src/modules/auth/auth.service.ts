import { Inject, Injectable, UnauthorizedException, BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import { resolvePermissions, requiresMfa, type Role, type Permission, type LoginResponse, type AuthUser } from '@ierp/shared';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { users, userPermissions, tenants, revokedTokens } from '../../database/schema';
import { PasswordService } from './password.service';
import { LoginAttemptStore } from './login-attempt.store';
import { encrypt, decrypt } from '../../common/crypto';
import { normalizeUsername } from '../../common/username';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordService,
    private readonly attempts: LoginAttemptStore,
  ) {}

  async login(username: string, password: string, totp?: string): Promise<LoginResponse> {
    // Match case-insensitively against the STORED username. New accounts are written canonicalized
    // (trimmed-lowercase), but legacy/seeded rows may still be mixed-case (pre-migration) — comparing on
    // lower() lets either authenticate without depending on the back-fill migration having run.
    const norm = normalizeUsername(username);
    // ITGC-AC-07 — per-account lockout: refuse before doing any (expensive scrypt) work once the failed-attempt
    // threshold is hit. The counter is written on the autocommit path so failures actually accumulate.
    const retry = await this.attempts.retryAfterSeconds(norm);
    if (retry > 0) {
      throw new HttpException({ code: 'LOGIN_LOCKED', message: `Too many failed attempts. Try again in ${retry}s.`, messageTh: `พยายามเข้าสู่ระบบผิดหลายครั้ง กรุณาลองใหม่ใน ${retry} วินาที`, retry_after_s: retry }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const row = (await this.db.select().from(users).where(sql`lower(${users.username}) = ${norm}`).limit(1))[0];
    const fail = () => {
      void this.attempts.recordFailure(norm); // fire-and-forget autocommit; do not delay the 401
      return new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Invalid username or password', messageTh: 'Username หรือ Password ไม่ถูกต้อง' });
    };
    if (!row) throw fail();

    const { ok, needsRehash } = await this.passwords.verify(password, row.passwordHash);
    if (!ok) throw fail();
    // A deactivated account (e.g. SCIM-deprovisioned) cannot authenticate, even with valid credentials.
    if (row.isActive === false)
      throw new UnauthorizedException({ code: 'USER_DEACTIVATED', message: 'This account has been deactivated', messageTh: 'บัญชีนี้ถูกปิดใช้งาน' });
    if (needsRehash) {
      const fresh = await this.passwords.hash(password);
      await this.db.update(users).set({ passwordHash: fresh }).where(eq(users.id, row.id));
    }

    // ITGC-AC-06 — second factor. An account with MFA enabled cannot authenticate on password alone:
    // a valid TOTP code is required every login (verified against the AES-256-GCM-encrypted seed).
    if (row.mfaEnabled) {
      if (!totp) throw new UnauthorizedException({ code: 'MFA_REQUIRED', message: 'TOTP code required', messageTh: 'ต้องใส่รหัสยืนยันสองชั้น (OTP)' });
      if (!row.totpSecret || !authenticator.verify({ token: totp, secret: decrypt(row.totpSecret) })) {
        void this.attempts.recordFailure(norm); // a wrong second factor counts toward lockout (TOTP brute force)
        throw new UnauthorizedException({ code: 'MFA_INVALID', message: 'Invalid TOTP code', messageTh: 'รหัส OTP ไม่ถูกต้อง' });
      }
    }
    // Full success (password + any required second factor) — clear the failed-attempt counter.
    await this.attempts.clear(norm);

    // tenant code (legacy Customer_Name) สำหรับ scoping
    let customerName: string | null = null;
    if (row.tenantId != null) {
      const t = (await this.db.select({ code: tenants.code }).from(tenants).where(eq(tenants.id, row.tenantId)).limit(1))[0];
      customerName = t?.code ?? null;
    }

    const role = row.role as Role;
    const overrides = (await this.db.select({ perm: userPermissions.perm }).from(userPermissions).where(eq(userPermissions.userId, row.id))).map((r) => r.perm as never);
    const perms = resolvePermissions(role, overrides.length ? overrides : null);
    // Policy nudge: a privileged/finance user who has not yet enrolled MFA is flagged so the client forces
    // setup (mirrors must_change_password). Enrolment must remain reachable, so this is a flag, not a block.
    const mustSetupMfa = !row.mfaEnabled && requiresMfa(role, overrides.length ? (overrides as Permission[]) : null);

    // Carry the STORED username (not the typed input) so later exact-match lookups by JWT sub resolve the
    // same row — important for legacy mixed-case accounts authenticated via the case-insensitive match above.
    // jti gives each token an identity so it can be revoked (logout) before its expiry (ITGC-AC-15).
    const token = await this.jwt.signAsync({ sub: row.username, role, customerName, tenantId: row.tenantId ?? null, permissions: perms, jti: randomUUID() });
    return { token, username: row.username, role, customer_name: customerName, must_change_password: !!row.mustChangePassword, must_setup_mfa: mustSetupMfa };
  }

  // ── ITGC-AC-15: session revocation ───────────────────────────────────────────
  // Revoke a single session: add the presented token's jti to the denylist (the guard rejects it thereafter).
  async revokeToken(token: string | undefined) {
    if (!token) return { revoked: false };
    let payload: any;
    try { payload = await this.jwt.verifyAsync(token); } catch { return { revoked: false }; }
    if (!payload?.jti) return { revoked: false };
    const expiresAt = payload.exp ? new Date(payload.exp * 1000) : new Date(Date.now() + 24 * 3600_000);
    await (this.db as any).insert(revokedTokens).values({ jti: payload.jti, username: payload.sub ?? null, expiresAt }).onConflictDoNothing();
    return { revoked: true };
  }

  // Revoke ALL of a user's sessions (incident response / forced logout): any JWT issued before now is rejected.
  async revokeAllSessions(username: string) {
    const norm = normalizeUsername(username);
    await this.db.update(users).set({ tokensValidFrom: new Date() }).where(sql`lower(${users.username}) = ${norm}`);
    return { username: norm, revoked_all: true };
  }

  // ── ITGC-AC-06: TOTP enrolment lifecycle ────────────────────────────────────
  // Generate a pending secret (stored ENCRYPTED; not yet active). Returns the otpauth URI for a QR code.
  async mfaSetup(username: string): Promise<{ secret: string; otpauth_url: string }> {
    const [row] = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!row) throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'User not found' });
    if (row.mfaEnabled) throw new BadRequestException({ code: 'MFA_ALREADY_ENABLED', message: 'MFA already enabled — disable it first to re-enrol', messageTh: 'เปิดใช้ MFA อยู่แล้ว' });
    const secret = authenticator.generateSecret();
    await this.db.update(users).set({ totpSecret: encrypt(secret) }).where(eq(users.id, row.id));
    return { secret, otpauth_url: authenticator.keyuri(username, 'Invisible ERP', secret) };
  }

  // Confirm enrolment: verify a code against the pending secret, then activate the second factor.
  async mfaEnable(username: string, code: string): Promise<{ enabled: true }> {
    const [row] = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!row) throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'User not found' });
    if (!row.totpSecret) throw new BadRequestException({ code: 'MFA_NOT_SETUP', message: 'Run MFA setup first', messageTh: 'ยังไม่ได้ตั้งค่า MFA' });
    if (!authenticator.verify({ token: code, secret: decrypt(row.totpSecret) }))
      throw new BadRequestException({ code: 'MFA_INVALID', message: 'Invalid TOTP code', messageTh: 'รหัส OTP ไม่ถูกต้อง' });
    await this.db.update(users).set({ mfaEnabled: true }).where(eq(users.id, row.id));
    return { enabled: true };
  }

  // Disable the second factor — requires BOTH the current password and a valid TOTP code (step-up).
  async mfaDisable(username: string, password: string, code: string): Promise<{ disabled: true }> {
    const [row] = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!row) throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'User not found' });
    const { ok } = await this.passwords.verify(password, row.passwordHash);
    if (!ok) throw new BadRequestException({ code: 'BAD_CURRENT_PASSWORD', message: 'Current password is incorrect', messageTh: 'รหัสผ่านไม่ถูกต้อง' });
    if (row.mfaEnabled && (!row.totpSecret || !authenticator.verify({ token: code, secret: decrypt(row.totpSecret) })))
      throw new BadRequestException({ code: 'MFA_INVALID', message: 'Invalid TOTP code', messageTh: 'รหัส OTP ไม่ถูกต้อง' });
    await this.db.update(users).set({ mfaEnabled: false, totpSecret: null }).where(eq(users.id, row.id));
    return { disabled: true };
  }

  async mfaStatus(user: { username: string; role: string }): Promise<{ enabled: boolean; required: boolean }> {
    const [row] = await this.db.select({ enabled: users.mfaEnabled, id: users.id }).from(users).where(eq(users.username, user.username)).limit(1);
    const overrides = row ? (await this.db.select({ perm: userPermissions.perm }).from(userPermissions).where(eq(userPermissions.userId, row.id))).map((r) => r.perm as Permission) : [];
    return { enabled: !!row?.enabled, required: requiresMfa(user.role as Role, overrides.length ? overrides : null) };
  }

  async me(user: AuthUser): Promise<AuthUser> {
    const [row] = await this.db.select({ m: users.mustChangePassword }).from(users).where(eq(users.username, user.username)).limit(1);
    return { ...user, must_change_password: !!row?.m };
  }

  // A5 — rotate password (verify current, set new, clear the force-change flag). Min 8 chars.
  async changePassword(username: string, currentPassword: string, newPassword: string): Promise<{ ok: true }> {
    if (!newPassword || newPassword.length < 8)
      throw new BadRequestException({ code: 'WEAK_PASSWORD', message: 'New password must be at least 8 characters', messageTh: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร' });
    const [row] = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!row) throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'User not found' });
    const { ok } = await this.passwords.verify(currentPassword, row.passwordHash);
    if (!ok) throw new BadRequestException({ code: 'BAD_CURRENT_PASSWORD', message: 'Current password is incorrect', messageTh: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
    if (currentPassword === newPassword)
      throw new BadRequestException({ code: 'SAME_PASSWORD', message: 'New password must differ from current', messageTh: 'รหัสผ่านใหม่ต้องต่างจากเดิม' });
    const hash = await this.passwords.hash(newPassword);
    await this.db.update(users).set({ passwordHash: hash, mustChangePassword: false }).where(eq(users.id, row.id));
    return { ok: true };
  }
}
