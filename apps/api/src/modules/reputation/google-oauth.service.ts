import { Inject, Injectable, BadRequestException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, isNull, gt } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { reputationOauthState, reputationConnections } from '../../database/schema';
import { encrypt, decrypt } from '../../common/crypto';
import type { JwtUser } from '../../common/decorators';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

// Fixed Google scope per platform: business.manage (Business Profile reviews) or analytics.readonly (GA4
// Data API), plus openid/email so we can show the admin WHICH Google account is connected.
const SCOPES: Record<string, string> = {
  google_maps: 'openid email https://www.googleapis.com/auth/business.manage',
  google_analytics: 'openid email https://www.googleapis.com/auth/analytics.readonly',
};

export type ReputationPlatform = 'google_maps' | 'google_analytics';

// docs/47 — the Google OAuth2 handshake shared by both platforms. Mirrors modules/identity/sso.service.ts:
// a single-use, server-persisted, expiring `state` row + PKCE protects the auth-code exchange. Unlike SSO
// login, this flow starts from an ALREADY-authenticated staff session (connecting an integration, not
// logging in), so state only needs to carry which tenant/user/platform initiated it — no pre-auth tenant
// resolution required. Google's endpoints are fixed constants (never tenant-configurable), so there is no
// SSRF surface here (unlike the tenant-configured OIDC issuer in sso.service.ts).
@Injectable()
export class GoogleOAuthService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private clientId(): string {
    const v = process.env.GOOGLE_OAUTH_CLIENT_ID;
    if (!v) throw new ServiceUnavailableException({ code: 'OAUTH_NOT_CONFIGURED', message: 'GOOGLE_OAUTH_CLIENT_ID is not configured', messageTh: 'ยังไม่ได้ตั้งค่า Google OAuth client' });
    return v;
  }
  private clientSecret(): string {
    const v = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!v) throw new ServiceUnavailableException({ code: 'OAUTH_NOT_CONFIGURED', message: 'GOOGLE_OAUTH_CLIENT_SECRET is not configured', messageTh: 'ยังไม่ได้ตั้งค่า Google OAuth client' });
    return v;
  }
  private redirectUri(): string {
    if (process.env.GOOGLE_OAUTH_REDIRECT_URI) return process.env.GOOGLE_OAUTH_REDIRECT_URI;
    const base = (process.env.WEB_PUBLIC_URL ?? '').replace(/\/$/, '');
    return `${base}/reputation/callback`;
  }

  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    return user.tenantId;
  }

  // GET /api/reputation/oauth/start?platform= — returns Google's consent URL.
  async start(user: JwtUser, platform: ReputationPlatform): Promise<{ authorization_url: string }> {
    const scope = SCOPES[platform];
    if (!scope) throw new BadRequestException({ code: 'BAD_PLATFORM', message: 'Unknown platform', messageTh: 'ไม่รู้จักแพลตฟอร์ม' });
    const tenantId = this.tid(user);
    const state = randomBytes(16).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    await this.db.insert(reputationOauthState).values({
      state, tenantId, createdBy: user.username, platform, codeVerifier,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId(),
      redirect_uri: this.redirectUri(),
      scope,
      state,
      access_type: 'offline',   // request a refresh_token
      prompt: 'consent',        // ensure a refresh_token even on a repeat consent
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return { authorization_url: `${AUTH_URL}?${params.toString()}` };
  }

  // POST /api/reputation/oauth/callback — the web callback page forwards the redirect query VERBATIM in
  // the body (never reads `code`/`state` by name client-side — same CWE-598 avoidance as the SSO callback).
  async callback(params: { query?: string; state?: string; code?: string }): Promise<{ platform: string }> {
    let { state, code } = params;
    if (params.query && !state && !code) {
      const q = new URLSearchParams(params.query);
      state = q.get('state') ?? undefined;
      code = q.get('code') ?? undefined;
    }
    if (!state || !code) throw new BadRequestException({ code: 'BAD_CALLBACK', message: 'Missing state or code', messageTh: 'ไม่พบ state หรือ code' });

    // Single-use consume: atomically mark consumed only if it exists, is unconsumed, and unexpired.
    const [st] = await this.db
      .update(reputationOauthState)
      .set({ consumedAt: new Date() })
      .where(and(eq(reputationOauthState.state, state), isNull(reputationOauthState.consumedAt), gt(reputationOauthState.expiresAt, new Date())))
      .returning({ tenantId: reputationOauthState.tenantId, createdBy: reputationOauthState.createdBy, platform: reputationOauthState.platform, codeVerifier: reputationOauthState.codeVerifier });
    if (!st) throw new BadRequestException({ code: 'BAD_STATE', message: 'Unknown, expired, or already-used OAuth state', messageTh: 'state ไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว' });

    const tokens = await this.exchangeCode(code, st.codeVerifier);
    const email = await this.fetchEmail(tokens.access_token).catch(() => undefined);

    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
    const existing = await this.db.select().from(reputationConnections)
      .where(and(eq(reputationConnections.tenantId, st.tenantId), eq(reputationConnections.platform, st.platform)))
      .limit(1);
    const values = {
      tenantId: st.tenantId, platform: st.platform, status: 'active' as const,
      googleAccountEmail: email, accessTokenEnc: encrypt(tokens.access_token),
      // Google omits refresh_token on a repeat grant if one is already outstanding for this client+user;
      // keep the previously-stored refresh_token in that case rather than clobbering it with nothing.
      refreshTokenEnc: tokens.refresh_token ? encrypt(tokens.refresh_token) : existing[0]?.refreshTokenEnc,
      tokenExpiresAt: expiresAt, scope: tokens.scope ?? SCOPES[st.platform as ReputationPlatform],
      lastError: null, createdBy: st.createdBy, updatedAt: new Date(),
    };
    if (existing[0]) {
      await this.db.update(reputationConnections).set(values).where(eq(reputationConnections.id, existing[0].id));
    } else {
      await this.db.insert(reputationConnections).values(values);
    }
    return { platform: st.platform };
  }

  // Ensure a fresh access token for a connection, refreshing if within 2 minutes of expiry. Returns the
  // plaintext access token (never persisted in plaintext — decrypt/encrypt happen only in this method).
  async freshAccessToken(conn: { id: number; accessTokenEnc: string | null; refreshTokenEnc: string | null; tokenExpiresAt: Date | null }): Promise<string> {
    const stillValid = conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() - Date.now() > 120_000;
    if (stillValid && conn.accessTokenEnc) return decrypt(conn.accessTokenEnc);
    if (!conn.refreshTokenEnc) throw new UnauthorizedException({ code: 'NO_REFRESH_TOKEN', message: 'Connection has no refresh token — reconnect required', messageTh: 'ไม่มี refresh token กรุณาเชื่อมต่อใหม่' });
    const refreshToken = decrypt(conn.refreshTokenEnc);
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.clientId(), client_secret: this.clientSecret() });
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!res.ok) throw new UnauthorizedException({ code: 'TOKEN_REFRESH_FAILED', message: `Google token refresh failed (${res.status})`, messageTh: 'ต่ออายุ token ไม่สำเร็จ' });
    const json: any = await res.json();
    const accessToken = json.access_token as string;
    const expiresAt = json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null;
    await this.db.update(reputationConnections)
      .set({ accessTokenEnc: encrypt(accessToken), tokenExpiresAt: expiresAt, updatedAt: new Date() })
      .where(eq(reputationConnections.id, conn.id));
    return accessToken;
  }

  async revokeToken(accessOrRefreshToken: string): Promise<void> {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(accessOrRefreshToken)}`, { method: 'POST' }).catch(() => undefined);
  }

  private async exchangeCode(code: string, codeVerifier: string): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: this.redirectUri(),
      client_id: this.clientId(), client_secret: this.clientSecret(), code_verifier: codeVerifier,
    });
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    } catch {
      throw new ServiceUnavailableException({ code: 'GOOGLE_UNREACHABLE', message: 'Could not reach Google\'s token endpoint', messageTh: 'ติดต่อ Google ไม่ได้' });
    }
    if (!res.ok) throw new UnauthorizedException({ code: 'TOKEN_EXCHANGE_FAILED', message: `Token exchange failed (${res.status})`, messageTh: 'แลก token ไม่สำเร็จ' });
    const json: any = await res.json();
    if (!json.access_token) throw new UnauthorizedException({ code: 'NO_ACCESS_TOKEN', message: 'Token response had no access_token', messageTh: 'ไม่พบ access_token' });
    return json;
  }

  private async fetchEmail(accessToken: string): Promise<string | undefined> {
    const res = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return undefined;
    const json: any = await res.json().catch(() => ({}));
    return json.email as string | undefined;
  }
}
