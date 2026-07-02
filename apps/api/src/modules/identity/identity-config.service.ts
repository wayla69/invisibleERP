import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenantIdentity } from '../../database/schema';
import { encrypt } from '../../common/crypto';
import type { JwtUser } from '../../common/decorators';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface IdentityConfigDto {
  sso_enabled?: boolean;
  oidc_issuer?: string;
  oidc_client_id?: string;
  oidc_client_secret?: string; // write-only; encrypted at rest, never returned
  oidc_redirect_uri?: string;
  default_role?: string;
  scim_enabled?: boolean;
}

// Per-tenant identity (IdP/SSO + SCIM) configuration. Secrets are write-only: the OIDC client secret is
// AES-256-GCM encrypted at rest and the SCIM bearer token is stored only as a sha256 hash (+ prefix).
@Injectable()
export class IdentityConfigService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async row(tenantId: number) {
    const db = this.db;
    const [r] = await db.select().from(tenantIdentity).where(eq(tenantIdentity.tenantId, tenantId)).limit(1);
    return r;
  }

  // Sanitized config for the admin UI — NEVER leaks the client secret or SCIM token.
  async get(user: JwtUser) {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบผู้เช่า' });
    const r = await this.row(user.tenantId);
    if (!r) return { configured: false, sso_enabled: false, scim_enabled: false };
    return {
      configured: true,
      sso_enabled: !!r.ssoEnabled,
      oidc_issuer: r.oidcIssuer ?? null,
      oidc_client_id: r.oidcClientId ?? null,
      oidc_redirect_uri: r.oidcRedirectUri ?? null,
      default_role: r.defaultRole,
      has_client_secret: !!r.oidcClientSecretEnc,
      scim_enabled: !!r.scimEnabled,
      scim_token_prefix: r.scimTokenPrefix ?? null,
      has_scim_token: !!r.scimTokenHash,
      updated_by: r.updatedBy ?? null,
      updated_at: r.updatedAt,
    };
  }

  async upsert(dto: IdentityConfigDto, user: JwtUser) {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบผู้เช่า' });
    if (dto.default_role && !ROLES.includes(dto.default_role)) {
      throw new BadRequestException({ code: 'BAD_ROLE', message: `Unknown role: ${dto.default_role}`, messageTh: 'บทบาทไม่ถูกต้อง' });
    }
    if (dto.oidc_redirect_uri && !/^https?:\/\//.test(dto.oidc_redirect_uri)) {
      throw new BadRequestException({ code: 'BAD_REDIRECT_URI', message: 'redirect_uri must be http(s)', messageTh: 'redirect_uri ต้องเป็น http(s)' });
    }
    const db = this.db;
    const existing = await this.row(user.tenantId);
    const set: any = { updatedBy: user.username, updatedAt: new Date() };
    if (dto.sso_enabled !== undefined) set.ssoEnabled = dto.sso_enabled;
    if (dto.oidc_issuer !== undefined) set.oidcIssuer = dto.oidc_issuer || null;
    if (dto.oidc_client_id !== undefined) set.oidcClientId = dto.oidc_client_id || null;
    if (dto.oidc_client_secret) set.oidcClientSecretEnc = encrypt(dto.oidc_client_secret); // write-only
    if (dto.oidc_redirect_uri !== undefined) set.oidcRedirectUri = dto.oidc_redirect_uri || null;
    if (dto.default_role !== undefined) set.defaultRole = dto.default_role;
    if (dto.scim_enabled !== undefined) set.scimEnabled = dto.scim_enabled;
    if (existing) await db.update(tenantIdentity).set(set).where(eq(tenantIdentity.tenantId, user.tenantId));
    else await db.insert(tenantIdentity).values({ tenantId: user.tenantId, ...set });
    return this.get(user);
  }

  // (Re)generate a SCIM bearer token — returned in plaintext ONCE; only its hash is stored.
  async rotateScimToken(user: JwtUser) {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบผู้เช่า' });
    const db = this.db;
    const raw = 'scim_' + randomBytes(24).toString('hex');
    const prefix = raw.slice(0, 12);
    const set = { scimTokenHash: sha256(raw), scimTokenPrefix: prefix, scimEnabled: true, updatedBy: user.username, updatedAt: new Date() };
    const existing = await this.row(user.tenantId);
    if (existing) await db.update(tenantIdentity).set(set).where(eq(tenantIdentity.tenantId, user.tenantId));
    else await db.insert(tenantIdentity).values({ tenantId: user.tenantId, ...set });
    return { token: raw, prefix, scim_endpoint: '/scim/v2', note: 'Store this token now — it is shown only once.' };
  }
}

// Friendly allow-list of assignable default roles for JIT-provisioned SSO users.
const ROLES: string[] = ['Admin', 'Sales', 'Customer', 'Warehouse', 'Procurement', 'Planner', 'Cashier', 'AccessAdmin', 'ExecutiveViewer'];
