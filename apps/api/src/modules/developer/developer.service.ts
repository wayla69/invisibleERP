import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { apiKeys } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// D1 (Platform Phase 23) — API maturity / developer portal. Surfaces the public-API v1 surface (scopes,
// endpoints, the OpenAPI doc) and the caller-tenant's API keys with a settable rate TIER. Read-only over the
// existing api_keys (RLS-scoped); setting a tier is the only mutation. No GL.
const TIERS = [
  { key: 'free', label: 'Free', rate_per_min: 60 },
  { key: 'standard', label: 'Standard', rate_per_min: 600 },
  { key: 'partner', label: 'Partner', rate_per_min: 6000 },
];
const TIER_KEYS = TIERS.map((t) => t.key);
const SCOPES = [
  { key: 'catalog:read', desc: 'Read the product catalog' },
  { key: 'inventory:read', desc: 'Read stock levels' },
  { key: 'orders:read', desc: 'Read sales orders' },
  { key: 'invoices:read', desc: 'Read invoices' },
];
const ENDPOINTS = [
  { method: 'GET', path: '/api/v1/items', scope: 'catalog:read' },
  { method: 'GET', path: '/api/v1/inventory', scope: 'inventory:read' },
  { method: 'GET', path: '/api/v1/orders', scope: 'orders:read' },
  { method: 'GET', path: '/api/v1/invoices', scope: 'invoices:read' },
];

@Injectable()
export class DeveloperService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  catalog() { return { scopes: SCOPES, endpoints: ENDPOINTS, tiers: TIERS, openapi_url: '/api/v1/openapi.json' }; }

  async portal(user: JwtUser) {
    // Defense-in-depth (security review L-5): scope to the caller's tenant EXPLICITLY, not by RLS alone — so a
    // future @NoTx/raw path (no tenant GUC) can't list another tenant's keys. A god session (tenantId == null)
    // keeps the RLS-bypass view (no predicate). api_keys.tenant_id is the owning tenant.
    const base = this.db.select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, scopes: apiKeys.scopes, tier: apiKeys.tier, revoked: apiKeys.revoked, lastUsedAt: apiKeys.lastUsedAt }).from(apiKeys);
    const rows = await (user.tenantId != null ? base.where(eq(apiKeys.tenantId, user.tenantId)) : base);
    const keys = rows.map((k: any) => ({ id: Number(k.id), name: k.name, prefix: k.prefix, scopes: String(k.scopes || '').split(',').filter(Boolean), tier: k.tier || 'free', revoked: !!k.revoked, last_used_at: k.lastUsedAt }));
    return { ...this.catalog(), keys };
  }

  async setTier(user: JwtUser, id: number, tier: string) {
    if (!TIER_KEYS.includes(tier)) throw new BadRequestException({ code: 'BAD_TIER', message: `tier must be one of ${TIER_KEYS.join(', ')}`, messageTh: 'ระดับการใช้งานไม่ถูกต้อง' });
    // Same explicit tenant scope on the write (L-5) — a tenant can only retier its OWN key; a mismatched
    // id resolves to no row → KEY_NOT_FOUND rather than silently editing another tenant's key.
    const where = user.tenantId != null ? and(eq(apiKeys.id, id), eq(apiKeys.tenantId, user.tenantId)) : eq(apiKeys.id, id);
    const upd = await this.db.update(apiKeys).set({ tier }).where(where).returning({ id: apiKeys.id });
    if (!upd.length) throw new NotFoundException({ code: 'KEY_NOT_FOUND', message: 'API key not found', messageTh: 'ไม่พบ API key' });
    return { id, tier };
  }
}
