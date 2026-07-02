import { Inject, Injectable, UnauthorizedException, BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq, and, sql, isNull } from 'drizzle-orm';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { authenticator } from 'otplib';
import { resolvePermissions, requiresMfa, type Role, type Permission, type LoginResponse, type PinLoginResponse, type AuthUser } from '@ierp/shared';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { users, userPermissions, tenants, revokedTokens, refreshTokens } from '../../database/schema';
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
    return (await this.issueSession(row)).res;
  }

  // POS-PIN quick-login (ITGC-AC-17) — username + 4–6 digit PIN, for front-of-house staff. Mirrors the
  // password path's lockout (ITGC-AC-07, same per-account counter ⇒ a PIN brute-force trips it too) and the
  // deactivated-account guard, but: (a) authenticates against `pin_hash`, and (b) HARD-BLOCKS any role whose
  // effective permissions require MFA (Admin/finance/access-admin) — those must use password + TOTP. The PIN
  // is a convenience for low-privilege tills, never a back door around the second factor.
  async loginWithPin(username: string, pin: string): Promise<PinLoginResponse> {
    const norm = normalizeUsername(username);
    const retry = await this.attempts.retryAfterSeconds(norm);
    if (retry > 0) {
      throw new HttpException({ code: 'LOGIN_LOCKED', message: `Too many failed attempts. Try again in ${retry}s.`, messageTh: `พยายามเข้าสู่ระบบผิดหลายครั้ง กรุณาลองใหม่ใน ${retry} วินาที`, retry_after_s: retry }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const row = (await this.db.select().from(users).where(sql`lower(${users.username}) = ${norm}`).limit(1))[0];
    const fail = () => {
      void this.attempts.recordFailure(norm);
      // Generic message (don't reveal whether the username exists or merely lacks a PIN) — anti-enumeration.
      return new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Invalid username or PIN', messageTh: 'Username หรือ PIN ไม่ถูกต้อง' });
    };
    if (!row || !row.pinHash) throw fail();
    // verifyScrypt (no legacy SHA-256 branch) — a PIN is always scrypt, so it never flows into a weak hash.
    const { ok, needsRehash } = await this.passwords.verifyScrypt(pin, row.pinHash);
    if (!ok) throw fail();
    if (row.isActive === false)
      throw new UnauthorizedException({ code: 'USER_DEACTIVATED', message: 'This account has been deactivated', messageTh: 'บัญชีนี้ถูกปิดใช้งาน' });
    // Privileged roles may NOT authenticate with a PIN even if one was somehow set (e.g. role escalated after
    // the PIN was assigned). Fail closed: the second factor cannot be bypassed by a 4–6 digit code.
    const overrides = await this.userOverrides(row.id);
    if (requiresMfa(row.role as Role, overrides.length ? overrides : null))
      throw new UnauthorizedException({ code: 'PIN_NOT_ALLOWED', message: 'This account must sign in with a password', messageTh: 'บัญชีนี้ต้องเข้าสู่ระบบด้วยรหัสผ่าน (PIN ใช้ได้เฉพาะพนักงานหน้าร้านเท่านั้น)' });
    if (needsRehash) {
      const fresh = await this.passwords.hash(pin);
      await this.db.update(users).set({ pinHash: fresh }).where(eq(users.id, row.id));
    }
    await this.attempts.clear(norm);
    const { res, perms } = await this.issueSession(row);
    return { ...res, permissions: perms };
  }

  // Resolve a user's per-user permission overrides (empty array if none).
  private async userOverrides(userId: number): Promise<Permission[]> {
    return (await this.db.select({ perm: userPermissions.perm }).from(userPermissions).where(eq(userPermissions.userId, userId))).map((r) => r.perm as Permission);
  }

  // Shared session-issuance tail for password + PIN login: resolve tenant code, permissions, the
  // must-setup-MFA nudge, and sign the JWT. Returns the LoginResponse plus the resolved permissions.
  private async issueSession(row: typeof users.$inferSelect): Promise<{ res: LoginResponse; perms: Permission[] }> {
    // tenant code (legacy Customer_Name) สำหรับ scoping
    let customerName: string | null = null;
    if (row.tenantId != null) {
      const t = (await this.db.select({ code: tenants.code }).from(tenants).where(eq(tenants.id, row.tenantId)).limit(1))[0];
      customerName = t?.code ?? null;
    }
    const role = row.role as Role;
    const overrides = await this.userOverrides(row.id);
    const perms = resolvePermissions(role, overrides.length ? overrides : null);
    // Policy nudge: a privileged/finance user who has not yet enrolled MFA is flagged so the client forces
    // setup (mirrors must_change_password). Enrolment must remain reachable, so this is a flag, not a block.
    const mustSetupMfa = !row.mfaEnabled && requiresMfa(role, overrides.length ? overrides : null);
    // Carry the STORED username (not the typed input) so later exact-match lookups by JWT sub resolve the
    // same row — important for legacy mixed-case accounts authenticated via the case-insensitive match above.
    // jti gives each token an identity so it can be revoked (logout) before its expiry (ITGC-AC-15).
    const token = await this.jwt.signAsync({ sub: row.username, role, customerName, tenantId: row.tenantId ?? null, permissions: perms, jti: randomUUID() });
    return { res: { token, username: row.username, role, customer_name: customerName, must_change_password: !!row.mustChangePassword, must_setup_mfa: mustSetupMfa }, perms };
  }

  // ── ITGC-AC-07 — refresh-token rotation ──────────────────────────────────────────────────────────
  // Access JWTs are short-lived (default 1h). A long-lived opaque refresh token (default 7d) lets the client
  // mint a fresh access token silently. We store only the sha256 hash (never the token itself).
  private static readonly REFRESH_TTL_MS = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7) * 86400_000;
  private hashRefresh(raw: string): string { return createHash('sha256').update(raw).digest('hex'); }

  // Mint + persist a new refresh token for a username; returns the RAW token (only ever sent as a cookie).
  async issueRefreshToken(username: string): Promise<string> {
    const raw = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + AuthService.REFRESH_TTL_MS);
    await this.db.insert(refreshTokens).values({ tokenHash: this.hashRefresh(raw), username, expiresAt }).onConflictDoNothing();
    return raw;
  }

  // Rotate: validate the presented refresh token, one-time-consume it, and issue a fresh access + refresh
  // pair. Reuse of an already-rotated/revoked token is treated as theft → revoke every refresh token for
  // that user (so a stolen-then-rotated token can't keep minting). Returns the new access + refresh tokens.
  async refresh(rawRefresh: string | undefined): Promise<{ token: string; refresh: string }> {
    const invalid = new UnauthorizedException({ code: 'REFRESH_INVALID', message: 'Invalid or expired session', messageTh: 'เซสชันไม่ถูกต้องหรือหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    if (!rawRefresh) throw invalid;
    const db = this.db;
    const hash = this.hashRefresh(rawRefresh);
    const [tok] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash)).limit(1);
    if (!tok) throw invalid;
    // Reuse detection: a token already consumed (rotated) or revoked is presented again ⇒ likely theft.
    if (tok.rotatedAt || tok.revokedAt) {
      await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.username, tok.username), isNull(refreshTokens.revokedAt)));
      throw invalid;
    }
    if (new Date(tok.expiresAt).getTime() < Date.now()) throw invalid;
    // Consume this token (one-time use).
    await db.update(refreshTokens).set({ rotatedAt: new Date() }).where(eq(refreshTokens.id, tok.id));
    // Re-issue an access token from the user's CURRENT row (role/perms/active re-resolved, not trusted from
    // the old token) — a deactivated user can't refresh.
    const row = (await db.select().from(users).where(eq(users.username, tok.username)).limit(1))[0];
    if (!row || row.isActive === false) throw invalid;
    const { res } = await this.issueSession(row);
    const refresh = await this.issueRefreshToken(row.username);
    return { token: res.token, refresh };
  }

  // Revoke a presented refresh token on logout (best-effort — never block logout on it).
  async revokeRefreshToken(rawRefresh: string | undefined): Promise<void> {
    if (!rawRefresh) return;
    try {
      await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.tokenHash, this.hashRefresh(rawRefresh)), isNull(refreshTokens.revokedAt)));
    } catch { /* best-effort */ }
  }

  // PIN format: exactly 4–6 digits (defence-in-depth; the Zod DTO enforces this too).
  private assertPinFormat(pin: string) {
    if (!/^\d{4,6}$/.test(pin))
      throw new BadRequestException({ code: 'WEAK_PIN', message: 'PIN must be 4–6 digits', messageTh: 'PIN ต้องเป็นตัวเลข 4–6 หลัก' });
  }

  // A PIN may only be assigned to a non-privileged role (one that does NOT require MFA). Keeps the second
  // factor un-bypassable: we never even store a PIN for a privileged account.
  private async assertPinAllowed(row: typeof users.$inferSelect) {
    const overrides = await this.userOverrides(row.id);
    if (requiresMfa(row.role as Role, overrides.length ? overrides : null))
      throw new BadRequestException({ code: 'PIN_NOT_ALLOWED', message: 'PIN login is not permitted for this (privileged) role', messageTh: 'ตั้ง PIN ไม่ได้ — บัญชีสิทธิ์สูงต้องใช้รหัสผ่าน + OTP' });
  }

  // Self-service: set/rotate your own PIN. Step-up with the current password so a hijacked session can't
  // silently mint a quick-login PIN.
  async setOwnPin(username: string, currentPassword: string, pin: string): Promise<{ ok: true }> {
    this.assertPinFormat(pin);
    const [row] = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!row) throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'User not found' });
    // Step-up re-check for an authenticated caller — their password hash is already scrypt (login rehashes
    // any legacy hash on success), so verifyScrypt suffices and keeps this step-up out of the SHA-256 path.
    const { ok } = await this.passwords.verifyScrypt(currentPassword, row.passwordHash);
    if (!ok) throw new BadRequestException({ code: 'BAD_CURRENT_PASSWORD', message: 'Current password is incorrect', messageTh: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
    await this.assertPinAllowed(row);
    await this.db.update(users).set({ pinHash: await this.passwords.hash(pin), pinSetAt: new Date() }).where(eq(users.id, row.id));
    return { ok: true };
  }

  // Admin (access-admin / 'users' permission): set a staff member's PIN.
  async setPinFor(targetUsername: string, pin: string): Promise<{ ok: true; username: string }> {
    this.assertPinFormat(pin);
    const norm = normalizeUsername(targetUsername);
    const [row] = await this.db.select().from(users).where(sql`lower(${users.username}) = ${norm}`).limit(1);
    if (!row) throw new BadRequestException({ code: 'USER_NOT_FOUND', message: 'User not found', messageTh: 'ไม่พบผู้ใช้' });
    await this.assertPinAllowed(row);
    await this.db.update(users).set({ pinHash: await this.passwords.hash(pin), pinSetAt: new Date() }).where(eq(users.id, row.id));
    return { ok: true, username: row.username };
  }

  // Admin: clear a staff member's PIN (disables PIN quick-login until a new one is set).
  async clearPinFor(targetUsername: string): Promise<{ ok: true; username: string }> {
    const norm = normalizeUsername(targetUsername);
    const [row] = await this.db.select().from(users).where(sql`lower(${users.username}) = ${norm}`).limit(1);
    if (!row) throw new BadRequestException({ code: 'USER_NOT_FOUND', message: 'User not found', messageTh: 'ไม่พบผู้ใช้' });
    await this.db.update(users).set({ pinHash: null, pinSetAt: null }).where(eq(users.id, row.id));
    return { ok: true, username: row.username };
  }

  // ── ITGC-AC-15: session revocation ───────────────────────────────────────────
  // Revoke a single session: add the presented token's jti to the denylist (the guard rejects it thereafter).
  async revokeToken(token: string | undefined) {
    if (!token) return { revoked: false };
    let payload: any;
    try { payload = await this.jwt.verifyAsync(token); } catch { return { revoked: false }; }
    if (!payload?.jti) return { revoked: false };
    const expiresAt = payload.exp ? new Date(payload.exp * 1000) : new Date(Date.now() + 24 * 3600_000);
    await this.db.insert(revokedTokens).values({ jti: payload.jti, username: payload.sub ?? null, expiresAt }).onConflictDoNothing();
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
