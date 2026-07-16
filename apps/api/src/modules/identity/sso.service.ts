import { Inject, Injectable, BadRequestException, UnauthorizedException, ServiceUnavailableException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, sql, gt, isNull } from 'drizzle-orm';
import { resolvePermissions, type Role } from '@ierp/shared';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants, tenantIdentity, users, ssoLoginState } from '../../database/schema';
import { decrypt } from '../../common/crypto';
import { assertPublicUrl } from '../../common/net-guard';
import { normalizeUsername } from '../../common/username';
import { PasswordService } from '../auth/password.service';
import { verifyHs256, type IdTokenClaims } from './jwt-hs256';
import { isJitForbiddenRole } from './identity-config.service';

// OIDC SSO: build the IdP authorization URL, then on callback verify the id_token, JIT-provision the
// user (by sso_subject within the tenant), and mint the SAME session JWT as a password login.
@Injectable()
export class SsoService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordService,
  ) {}

  // Look up a tenant's identity config by tenant CODE, cross-tenant (pre-auth) → bypass RLS for the read.
  private async configForCode(code: string): Promise<{ tenantId: number; cfg: any } | null> {
    const db = this.db;
    return db.transaction(async (tx: any) => {
      try { await tx.execute(sql`SET LOCAL ROLE app_user`); } catch { /* dev base role */ }
      await tx.execute(sql`select set_config('app.bypass_rls','on',true)`);
      const [t] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, code)).limit(1);
      if (!t) return null;
      const [cfg] = await tx.select().from(tenantIdentity).where(eq(tenantIdentity.tenantId, Number(t.id))).limit(1);
      return cfg ? { tenantId: Number(t.id), cfg } : null;
    });
  }

  // GET /api/auth/sso/authorize?tenant=CODE — returns the IdP redirect URL.
  async authorize(code: string): Promise<{ authorization_url: string; state: string }> {
    const found = await this.configForCode(code);
    if (!found || !found.cfg.ssoEnabled || !found.cfg.oidcIssuer || !found.cfg.oidcClientId) {
      throw new ServiceUnavailableException({ code: 'SSO_NOT_CONFIGURED', message: 'SSO is not configured for this tenant', messageTh: 'ผู้เช่านี้ยังไม่ได้ตั้งค่า SSO' });
    }
    // Single-use, server-persisted login state. `state` carries the tenant code (so the callback can resolve
    // config) plus a random nonce; `nonce` is bound into the id_token; PKCE `code_verifier`/`code_challenge`
    // protect the auth-code exchange. The callback must present a state that matches a stored, unconsumed,
    // unexpired row — without this, the callback was a login-CSRF / account-fixation vector (ITGC-AC-02).
    const state = `${code}.${randomBytes(16).toString('hex')}`;
    const nonce = randomBytes(16).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    await this.db.insert(ssoLoginState).values({
      state, tenantCode: code, nonce, codeVerifier, expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: found.cfg.oidcClientId,
      redirect_uri: found.cfg.oidcRedirectUri ?? '',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return { authorization_url: `${String(found.cfg.oidcIssuer).replace(/\/$/, '')}/authorize?${params.toString()}`, state };
  }

  // GET /api/auth/sso/callback — verify the assertion and mint a session. The tenant is recovered from
  // `state` (set by authorize). An id_token may arrive directly (implicit/hybrid) or be obtained by
  // exchanging `code` at the token endpoint (auth-code; network, production path).
  async callback(params: { state?: string; code?: string; id_token?: string }): Promise<{ token: string; username: string; role: string }> {
    const stateStr = params.state ?? '';
    const tenantCode = stateStr.split('.')[0];
    if (!tenantCode) throw new BadRequestException({ code: 'BAD_STATE', message: 'Missing/invalid state', messageTh: 'state ไม่ถูกต้อง' });
    // Single-use consume of the server-stored state: atomically mark it consumed only if it exists, is
    // unconsumed, and is unexpired. A replayed/forged/expired state returns no row → reject (CSRF/replay).
    const [st] = await this.db
      .update(ssoLoginState)
      .set({ consumedAt: new Date() })
      .where(and(eq(ssoLoginState.state, stateStr), isNull(ssoLoginState.consumedAt), gt(ssoLoginState.expiresAt, new Date())))
      .returning({ nonce: ssoLoginState.nonce, codeVerifier: ssoLoginState.codeVerifier, tenantCode: ssoLoginState.tenantCode });
    if (!st || st.tenantCode !== tenantCode) throw new BadRequestException({ code: 'BAD_STATE', message: 'Unknown, expired, or already-used login state', messageTh: 'state ไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว' });

    const found = await this.configForCode(tenantCode);
    if (!found || !found.cfg.ssoEnabled) throw new ServiceUnavailableException({ code: 'SSO_NOT_CONFIGURED', message: 'SSO is not configured', messageTh: 'ยังไม่ได้ตั้งค่า SSO' });
    const secret = found.cfg.oidcClientSecretEnc ? decrypt(found.cfg.oidcClientSecretEnc) : '';
    // Fail closed on an empty secret: verifyHs256 would otherwise HMAC with an empty key, which any
    // attacker can also compute — i.e. self-signed id_token forgery. Require a configured client secret.
    if (!secret) throw new ServiceUnavailableException({ code: 'SSO_SECRET_MISSING', message: 'SSO client secret not configured — refusing to verify an id_token with an empty key', messageTh: 'ยังไม่ได้ตั้งค่า client secret ของ SSO' });

    let idToken = params.id_token;
    if (!idToken && params.code) idToken = await this.exchangeCode(found.cfg, params.code, st.codeVerifier ?? undefined); // network (prod), PKCE
    if (!idToken) throw new BadRequestException({ code: 'NO_ASSERTION', message: 'No id_token or code supplied', messageTh: 'ไม่พบ id_token หรือ code' });

    let claims: IdTokenClaims;
    try {
      claims = verifyHs256(idToken, secret); // HS256 (client_secret); RS256/JWKS is a documented follow-on
    } catch (e: any) {
      throw new UnauthorizedException({ code: 'BAD_ID_TOKEN', message: `id_token verification failed: ${e?.message ?? 'invalid'}`, messageTh: 'ตรวจสอบ id_token ไม่ผ่าน' });
    }
    // Bind the id_token to THIS login: its nonce MUST equal the one we issued at authorize() (replay defence).
    // We always mint a nonce and send it in the authorize request (§ authorize), and a spec-compliant IdP MUST
    // echo it into the id_token — so require an exact match and FAIL CLOSED when the claim is absent (security
    // review L-10: the old `!== undefined` guard let an id_token that simply omitted the nonce skip the binding).
    if (st.nonce && claims.nonce !== st.nonce)
      throw new UnauthorizedException({ code: 'BAD_NONCE', message: 'id_token nonce mismatch', messageTh: 'nonce ของ id_token ไม่ตรง' });
    // Claim checks: issuer, audience, expiry.
    if (found.cfg.oidcIssuer && claims.iss && String(claims.iss).replace(/\/$/, '') !== String(found.cfg.oidcIssuer).replace(/\/$/, ''))
      throw new UnauthorizedException({ code: 'BAD_ISSUER', message: 'id_token issuer mismatch', messageTh: 'ผู้ออก token ไม่ตรง' });
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (found.cfg.oidcClientId && !aud.includes(found.cfg.oidcClientId))
      throw new UnauthorizedException({ code: 'BAD_AUDIENCE', message: 'id_token audience mismatch', messageTh: 'ผู้รับ token ไม่ตรง' });
    if (claims.exp && Date.now() / 1000 > Number(claims.exp))
      throw new UnauthorizedException({ code: 'TOKEN_EXPIRED', message: 'id_token expired', messageTh: 'id_token หมดอายุ' });
    if (!claims.sub) throw new UnauthorizedException({ code: 'NO_SUBJECT', message: 'id_token has no subject', messageTh: 'id_token ไม่มี subject' });

    return this.provisionAndMint(found.tenantId, tenantCode, found.cfg.defaultRole, String(claims.sub), claims.email ? String(claims.email) : undefined);
  }

  // Find-or-create the SSO user (by sso_subject within the tenant) and mint the session JWT. Runs in a
  // tenant-scoped tx so the user row is created/read under the tenant's RLS policy (no cross-tenant write).
  private async provisionAndMint(tenantId: number, tenantCode: string, defaultRole: string, subject: string, email?: string) {
    // Defense-in-depth (pentest P2): even if a tenant stored a privileged `default_role` BEFORE the allow-list
    // was tightened, JIT provisioning must never mint a role that can escalate further (Admin/AccessAdmin). Fail
    // closed rather than silently downgrade, so a misconfigured tenant is fixed explicitly.
    if (isJitForbiddenRole(defaultRole)) {
      throw new ForbiddenException({ code: 'SSO_ROLE_NOT_ALLOWED', message: 'SSO cannot auto-provision a privileged role — reconfigure the SSO default role', messageTh: 'SSO ไม่สามารถสร้างผู้ใช้ที่มีบทบาทระดับสูงโดยอัตโนมัติได้ — โปรดตั้งค่าบทบาทเริ่มต้นใหม่' });
    }
    const db = this.db;
    const { username, role } = await db.transaction(async (tx: any) => {
      try { await tx.execute(sql`SET LOCAL ROLE app_user`); } catch { /* dev base role */ }
      await tx.execute(sql`select set_config('app.tenant_id', ${String(tenantId)}, true)`);
      await tx.execute(sql`select set_config('app.bypass_rls','off',true)`);
      const [existing] = await tx.select().from(users).where(and(eq(users.ssoSubject, subject), eq(users.tenantId, tenantId))).limit(1);
      if (existing) {
        if (!existing.isActive) throw new UnauthorizedException({ code: 'USER_DEACTIVATED', message: 'This account has been deactivated', messageTh: 'บัญชีนี้ถูกปิดใช้งาน' });
        return { username: existing.username as string, role: existing.role as string };
      }
      // JIT-provision: a stable username from email (or the subject), tenant-scoped, with a random
      // unusable password (SSO users never password-login).
      const base = normalizeUsername(email?.split('@')[0] || subject) || `sso_${subject.slice(0, 8)}`;
      let uname = base;
      for (let i = 1; ; i++) {
        const [clash] = await tx.select({ id: users.id }).from(users).where(eq(users.username, uname)).limit(1);
        if (!clash) break;
        uname = `${base}${i}`;
      }
      const hash = await this.passwords.hash('sso_' + randomBytes(16).toString('hex'));
      await tx.insert(users).values({ username: uname, passwordHash: hash, role: defaultRole as (typeof users.$inferInsert)['role'], tenantId, ssoSubject: subject, isActive: true, mustChangePassword: false });
      return { username: uname, role: defaultRole };
    });

    const perms = resolvePermissions(role as Role);
    const token = await this.jwt.signAsync({ sub: username, role, customerName: tenantCode, tenantId, permissions: perms });
    return { token, username, role };
  }

  // Authorization-code → token-endpoint exchange (production path; requires outbound network to the IdP).
  private async exchangeCode(cfg: any, code: string, codeVerifier?: string): Promise<string> {
    const secret = cfg.oidcClientSecretEnc ? decrypt(cfg.oidcClientSecretEnc) : '';
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: cfg.oidcRedirectUri ?? '',
      client_id: cfg.oidcClientId ?? '', client_secret: secret,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}), // PKCE
    });
    // SSRF guard (security review M-2): the issuer is tenant-admin-configured, so re-resolve its host and
    // refuse any internal/metadata/RFC1918/loopback destination immediately BEFORE the outbound POST. Runs
    // here (not inside the try) so a blocked target surfaces as SSRF_BLOCKED (400), not IDP_UNREACHABLE.
    const tokenUrl = `${String(cfg.oidcIssuer ?? '').replace(/\/$/, '')}/token`;
    await assertPublicUrl(tokenUrl, { allowHttp: false });
    let res: Response;
    try {
      res = await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    } catch {
      throw new ServiceUnavailableException({ code: 'IDP_UNREACHABLE', message: 'Could not reach the IdP token endpoint', messageTh: 'ติดต่อ IdP ไม่ได้' });
    }
    if (!res.ok) throw new UnauthorizedException({ code: 'TOKEN_EXCHANGE_FAILED', message: `Token exchange failed (${res.status})`, messageTh: 'แลก token ไม่สำเร็จ' });
    const json: any = await res.json().catch(() => ({}));
    if (!json.id_token) throw new UnauthorizedException({ code: 'NO_ID_TOKEN', message: 'Token response had no id_token', messageTh: 'ไม่พบ id_token' });
    return json.id_token as string;
  }
}
