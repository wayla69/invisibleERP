import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { users, userPermissions, tenants } from '../../database/schema';
import { PasswordService } from '../auth/password.service';
import type { JwtUser } from '../../common/decorators';

export interface CreateUserDto { username: string; password: string; role: string; customer_name?: string; permissions?: string[] }
export interface UpdateUserDto { role?: string; customer_name?: string; permissions?: string[] }

@Injectable()
export class AdminUsersService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly passwords: PasswordService) {}

  private async tenantIdFor(code?: string): Promise<number | null> {
    if (!code) return null;
    const db = this.db as any;
    const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, code)).limit(1);
    if (!t) throw new BadRequestException({ code: 'BAD_TENANT', message: `Unknown company/tenant: ${code}`, messageTh: 'ไม่พบบริษัท/ผู้เช่า' });
    return Number(t.id);
  }

  async list() {
    const db = this.db as any;
    const rows = await db
      .select({ username: users.username, role: users.role, tenantId: users.tenantId, code: tenants.code, mustChange: users.mustChangePassword })
      .from(users).leftJoin(tenants, eq(users.tenantId, tenants.id)).orderBy(users.username);
    return { users: rows.map((r: any) => ({ username: r.username, role: r.role, customer_name: r.code ?? null, must_change_password: !!r.mustChange })), count: rows.length };
  }

  async create(dto: CreateUserDto) {
    const db = this.db as any;
    if (!dto.password || dto.password.length < 6) throw new BadRequestException({ code: 'WEAK_PASSWORD', message: 'Password must be ≥6 chars', messageTh: 'รหัสผ่านอย่างน้อย 6 ตัว' });
    const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.username, dto.username)).limit(1);
    if (exists) throw new ConflictException({ code: 'USER_EXISTS', message: `User ${dto.username} already exists`, messageTh: 'มีผู้ใช้นี้แล้ว' });
    const tenantId = await this.tenantIdFor(dto.customer_name);
    const hash = await this.passwords.hash(dto.password);
    const [u] = await db.insert(users).values({ username: dto.username, passwordHash: hash, role: dto.role as any, tenantId, mustChangePassword: true }).returning({ id: users.id });
    if (dto.permissions?.length) {
      await db.insert(userPermissions).values(dto.permissions.map((p) => ({ userId: Number(u.id), perm: p }))).onConflictDoNothing();
    }
    return { username: dto.username, role: dto.role, created: true };
  }

  async update(username: string, dto: UpdateUserDto) {
    const db = this.db as any;
    const [u] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found', messageTh: 'ไม่พบผู้ใช้' });
    const set: any = {};
    if (dto.role) set.role = dto.role;
    if (dto.customer_name !== undefined) set.tenantId = await this.tenantIdFor(dto.customer_name || undefined);
    if (Object.keys(set).length) await db.update(users).set(set).where(eq(users.id, u.id));
    if (dto.permissions) {
      await db.delete(userPermissions).where(eq(userPermissions.userId, Number(u.id)));
      if (dto.permissions.length) await db.insert(userPermissions).values(dto.permissions.map((p) => ({ userId: Number(u.id), perm: p }))).onConflictDoNothing();
    }
    return { username, updated: true };
  }

  async resetPassword(username: string, newPassword: string) {
    if (!newPassword || newPassword.length < 6) throw new BadRequestException({ code: 'WEAK_PASSWORD', message: 'Password must be ≥6 chars', messageTh: 'รหัสผ่านอย่างน้อย 6 ตัว' });
    const db = this.db as any;
    const [u] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found', messageTh: 'ไม่พบผู้ใช้' });
    const hash = await this.passwords.hash(newPassword);
    await db.update(users).set({ passwordHash: hash, mustChangePassword: true }).where(eq(users.id, u.id));
    return { username, reset: true };
  }

  async remove(username: string, actor: JwtUser) {
    if (username === actor.username) throw new BadRequestException({ code: 'SELF_DELETE', message: 'Cannot delete yourself', messageTh: 'ลบบัญชีตัวเองไม่ได้' });
    const db = this.db as any;
    const [u] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found', messageTh: 'ไม่พบผู้ใช้' });
    await db.delete(userPermissions).where(eq(userPermissions.userId, Number(u.id)));
    await db.delete(users).where(eq(users.id, u.id));
    return { username, deleted: true };
  }
}
