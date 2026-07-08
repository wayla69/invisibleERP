import { Inject, Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { eq, and, desc, sql } from 'drizzle-orm';
import { resolvePermissions, type Role } from '@ierp/shared';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { apiKeys, users } from '../../database/schema';
import { safeEqualHex } from '../../common/crypto';
import type { JwtUser } from '../../common/decorators';

export interface IssueKeyDto { name: string; scopes?: string[]; ttl_days?: number }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// Mirror of common/guards.ts SCOPE_ALIASES — kept local to avoid an import cycle (guards.ts imports this
// service). MUST stay in sync with that map so the cap below matches the auth-time expansion exactly.
const SCOPE_ALIASES: Record<string, string[]> = {
  read: ['dashboard', 'exec', 'cust_dash', 'cust_inventory'],
  write: ['pos', 'order_mgt', 'warehouse', 'procurement'],
};
// The effective permissions a single granted scope expands to for a machine (Sales-role) principal —
// mirrors JwtAuthGuard's expansion so capping here reflects the real grant a key would carry.
function permsForScope(scope: string): string[] {
  if (scope === '*' || scope === 'admin') return resolvePermissions('Sales' as Role);
  return SCOPE_ALIASES[scope] ?? [scope];
}

@Injectable()
export class ApiKeyService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // resolve tenant_id จาก username (JwtUser ไม่พก tenantId)
  private async tenantOf(user: JwtUser): Promise<number | null> {
    const db = this.db;
    const [u] = await db.select({ tenantId: users.tenantId }).from(users).where(eq(users.username, user.username)).limit(1);
    return u?.tenantId ?? null;
  }

  // ออกคีย์ใหม่ — คืน "คีย์เต็ม" เพียงครั้งเดียว (เก็บแค่ sha256)
  async issue(dto: IssueKeyDto, user: JwtUser) {
    // SoD (security review H-2): a key is a bearer principal that inherits the requested scopes'
    // permissions at auth time. Cap the requested scopes to what the MINTER actually holds so a narrow
    // role (e.g. AccessAdmin, whose only power is `users`) cannot mint a broadly-scoped transacting key
    // and escalate — nor split maker-checker across two independent key principals it could not wield
    // interactively. Reject loudly rather than silently trimming, so the caller sees why.
    const minterPerms = new Set(user.permissions ?? []);
    const disallowed = (dto.scopes ?? []).filter((s) => !permsForScope(s).every((p) => minterPerms.has(p)));
    if (disallowed.length) {
      throw new ForbiddenException({
        code: 'SCOPE_EXCEEDS_GRANT',
        message: `Cannot issue an API key with scope(s) you do not hold: ${disallowed.join(', ')}`,
        messageTh: `ออก API key ด้วยสิทธิ์ที่คุณไม่มีไม่ได้: ${disallowed.join(', ')}`,
      });
    }
    const db = this.db;
    const tenantId = await this.tenantOf(user);
    const rawKey = 'ierp_' + randomBytes(16).toString('hex'); // 'ierp_' + 32 hex chars
    const prefix = rawKey.slice(0, 12);
    const hashedKey = sha256(rawKey);
    const scopes = (dto.scopes ?? []).join(',');
    // Optional TTL (0196) — bound a leaked key's lifetime. Omitted/≤0 → non-expiring (back-compat).
    const expiresAt = dto.ttl_days && dto.ttl_days > 0 ? new Date(Date.now() + dto.ttl_days * 86_400_000) : null;
    const [row] = await db.insert(apiKeys).values({
      tenantId, name: dto.name, prefix, hashedKey, scopes, revoked: false, expiresAt,
    }).returning({ id: apiKeys.id, prefix: apiKeys.prefix, name: apiKeys.name });
    return { id: Number(row!.id), name: row!.name, prefix: row!.prefix, scopes: dto.scopes ?? [], expires_at: expiresAt, key: rawKey };
  }

  // ตรวจคีย์ดิบ → คืน row หรือ null. Lookup by indexed prefix, then constant-time hash compare.
  // Runs in a BYPASS tx: api_keys is FORCE-RLS (it has tenant_id) but key lookup is inherently
  // cross-tenant (we don't know the tenant until the key is identified), and a FORCE policy is not
  // exempted for the table owner — so under a non-superuser prod connection a plain SELECT would
  // return zero rows and silently 401 every API-key request. The bypass GUC admits the lookup.
  async verify(rawKey: string) {
    if (!rawKey || !rawKey.startsWith('ierp_')) return null;
    const prefix = rawKey.slice(0, 12); // matches issue() slice(0,12)
    const hashed = sha256(rawKey);
    const db = this.db;
    return db.transaction(async (tx: any) => {
      try { await tx.execute(sql`SET LOCAL ROLE app_user`); } catch { /* dev base role; ignore */ }
      await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
      // Match ALL rows sharing the prefix (prefix is not unique), then constant-time hash compare —
      // avoids a prefix collision rejecting a valid key.
      const rows = await tx.select().from(apiKeys).where(and(eq(apiKeys.prefix, prefix), eq(apiKeys.revoked, false)));
      const row = rows.find((r: any) => safeEqualHex(hashed, String(r.hashedKey)));
      if (!row) return null;
      // Expiry (0196): an expired key is rejected exactly like a revoked one.
      if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return null;
      // lastUsedAt bump is best-effort — must never fail authentication.
      try { await tx.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)); } catch { /* ignore */ }
      return row;
    });
  }

  async list(tenantId: number | null) {
    const db = this.db;
    const rows = await db.select({
      id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt, revoked: apiKeys.revoked, createdAt: apiKeys.createdAt,
    }).from(apiKeys)
      .where(tenantId == null ? undefined : eq(apiKeys.tenantId, tenantId))
      .orderBy(desc(apiKeys.createdAt));
    return rows.map((r: any) => ({ ...r, id: Number(r.id), scopes: r.scopes ? String(r.scopes).split(',').filter(Boolean) : [] }));
  }

  async listForUser(user: JwtUser) {
    return this.list(await this.tenantOf(user));
  }

  async revoke(id: number, user: JwtUser) {
    const db = this.db;
    const tenantId = await this.tenantOf(user);
    const cond = tenantId == null ? eq(apiKeys.id, id) : and(eq(apiKeys.id, id), eq(apiKeys.tenantId, tenantId));
    const [row] = await db.select({ id: apiKeys.id }).from(apiKeys).where(cond).limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'API key not found', messageTh: 'ไม่พบ API key' });
    await db.update(apiKeys).set({ revoked: true }).where(eq(apiKeys.id, id));
    return { id, revoked: true };
  }
}
