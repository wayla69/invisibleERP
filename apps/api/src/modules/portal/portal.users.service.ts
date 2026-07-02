import { Inject, Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { eq, and, ne } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { users, userPermissions } from '../../database/schema';
import { PasswordService } from '../auth/password.service';
import type { JwtUser } from '../../common/decorators';
import { normalizeUsername } from '../../common/username';

export interface SubUserDto { username: string; password: string; permissions?: string[] }

// Mini-ERP sub-accounts: a customer (tenant) creates staff users scoped to its OWN tenant_id.
@Injectable()
export class PortalUsersService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly passwords: PasswordService) {}

  private requireTenant(u: JwtUser): number {
    if (u.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'Account is not tied to a company', messageTh: 'บัญชีไม่ได้ผูกกับบริษัท' });
    return u.tenantId;
  }

  async list(u: JwtUser) {
    const tenantId = this.requireTenant(u);
    const db = this.db;
    const rows = await db.select({ username: users.username, role: users.role }).from(users).where(eq(users.tenantId, tenantId)).orderBy(users.username);
    return { users: rows.map((r: any) => ({ username: r.username, role: r.role })), count: rows.length };
  }

  async create(dto: SubUserDto, u: JwtUser) {
    const tenantId = this.requireTenant(u);
    if (!dto.password || dto.password.length < 6) throw new BadRequestException({ code: 'WEAK_PASSWORD', message: 'Password must be ≥6 chars', messageTh: 'รหัสผ่านอย่างน้อย 6 ตัว' });
    const username = normalizeUsername(dto.username);
    if (!username) throw new BadRequestException({ code: 'BAD_USERNAME', message: 'Username is required', messageTh: 'ต้องระบุชื่อผู้ใช้' });
    const db = this.db;
    const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (exists) throw new ConflictException({ code: 'USER_EXISTS', message: `User ${username} already exists`, messageTh: 'มีผู้ใช้นี้แล้ว' });
    const hash = await this.passwords.hash(dto.password);
    const [created] = await db.insert(users).values({ username, passwordHash: hash, role: 'Customer' as any, tenantId, mustChangePassword: true }).returning({ id: users.id });
    // Limit sub-account permissions to customer-portal scopes only.
    const allowed = new Set(['order_cust', 'cust_pos', 'cust_dash', 'cust_inventory', 'cust_bom', 'cust_variance', 'loyalty', 'survey', 'track']);
    const perms = (dto.permissions ?? []).filter((p) => allowed.has(p));
    if (perms.length) await db.insert(userPermissions).values(perms.map((p) => ({ userId: Number(created!.id), perm: p }))).onConflictDoNothing();
    return { username, role: 'Customer', created: true };
  }

  async remove(username: string, u: JwtUser) {
    username = normalizeUsername(username);
    const tenantId = this.requireTenant(u);
    if (username === u.username) throw new BadRequestException({ code: 'SELF_DELETE', message: 'Cannot delete yourself', messageTh: 'ลบบัญชีตัวเองไม่ได้' });
    const db = this.db;
    const [target] = await db.select().from(users).where(and(eq(users.username, username), eq(users.tenantId, tenantId), ne(users.username, u.username))).limit(1);
    if (!target) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sub-user not found in your company', messageTh: 'ไม่พบผู้ใช้ในบริษัทของคุณ' });
    await db.delete(userPermissions).where(eq(userPermissions.userId, Number(target.id)));
    await db.delete(users).where(eq(users.id, target.id));
    return { username, deleted: true };
  }
}
