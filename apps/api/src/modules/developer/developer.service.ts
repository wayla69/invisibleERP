import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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

  async portal(_user: JwtUser) {
    const rows = await this.db.select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, scopes: apiKeys.scopes, tier: apiKeys.tier, revoked: apiKeys.revoked, lastUsedAt: apiKeys.lastUsedAt }).from(apiKeys);
    const keys = rows.map((k: any) => ({ id: Number(k.id), name: k.name, prefix: k.prefix, scopes: String(k.scopes || '').split(',').filter(Boolean), tier: k.tier || 'free', revoked: !!k.revoked, last_used_at: k.lastUsedAt }));
    return { ...this.catalog(), keys };
  }

  async setTier(_user: JwtUser, id: number, tier: string) {
    if (!TIER_KEYS.includes(tier)) throw new BadRequestException({ code: 'BAD_TIER', message: `tier must be one of ${TIER_KEYS.join(', ')}`, messageTh: 'ระดับการใช้งานไม่ถูกต้อง' });
    const upd = await this.db.update(apiKeys).set({ tier }).where(eq(apiKeys.id, id)).returning({ id: apiKeys.id });
    if (!upd.length) throw new NotFoundException({ code: 'KEY_NOT_FOUND', message: 'API key not found', messageTh: 'ไม่พบ API key' });
    return { id, tier };
  }
}
