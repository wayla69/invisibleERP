import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { apiKeys, users } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

export interface IssueKeyDto { name: string; scopes?: string[] }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class ApiKeyService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // resolve tenant_id จาก username (JwtUser ไม่พก tenantId)
  private async tenantOf(user: JwtUser): Promise<number | null> {
    const db = this.db as any;
    const [u] = await db.select({ tenantId: users.tenantId }).from(users).where(eq(users.username, user.username)).limit(1);
    return u?.tenantId ?? null;
  }

  // ออกคีย์ใหม่ — คืน "คีย์เต็ม" เพียงครั้งเดียว (เก็บแค่ sha256)
  async issue(dto: IssueKeyDto, user: JwtUser) {
    const db = this.db as any;
    const tenantId = await this.tenantOf(user);
    const rawKey = 'ierp_' + randomBytes(16).toString('hex'); // 'ierp_' + 32 hex chars
    const prefix = rawKey.slice(0, 12);
    const hashedKey = sha256(rawKey);
    const scopes = (dto.scopes ?? []).join(',');
    const [row] = await db.insert(apiKeys).values({
      tenantId, name: dto.name, prefix, hashedKey, scopes, revoked: false,
    }).returning({ id: apiKeys.id, prefix: apiKeys.prefix, name: apiKeys.name });
    return { id: Number(row.id), name: row.name, prefix: row.prefix, scopes: dto.scopes ?? [], key: rawKey };
  }

  // ตรวจคีย์ดิบ → คืน row หรือ null (hash + lookup + เช็ค revoked)
  async verify(rawKey: string) {
    if (!rawKey) return null;
    const db = this.db as any;
    const hashedKey = sha256(rawKey);
    const [row] = await db.select().from(apiKeys)
      .where(and(eq(apiKeys.hashedKey, hashedKey), eq(apiKeys.revoked, false))).limit(1);
    if (!row) return null;
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
    return row;
  }

  async list(tenantId: number | null) {
    const db = this.db as any;
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
    const db = this.db as any;
    const tenantId = await this.tenantOf(user);
    const cond = tenantId == null ? eq(apiKeys.id, id) : and(eq(apiKeys.id, id), eq(apiKeys.tenantId, tenantId));
    const [row] = await db.select({ id: apiKeys.id }).from(apiKeys).where(cond).limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'API key not found', messageTh: 'ไม่พบ API key' });
    await db.update(apiKeys).set({ revoked: true }).where(eq(apiKeys.id, id));
    return { id, revoked: true };
  }
}
