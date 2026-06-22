import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { users, userPermissions, tenants } from '../../database/schema';
import { PasswordService } from '../auth/password.service';
import { resolvePermissions, detectSodConflicts, SOD_RULES, type Role, type Permission } from '@ierp/shared';
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

  // Detective SoD control (ITGC-AC-09): report every user holding duties on both sides of a conflict rule,
  // evaluated on their EFFECTIVE permissions (role defaults + per-user overrides, expanded). Admins are
  // reported separately as inherent superusers (expected, mitigated by compensating controls).
  async sodConflicts() {
    const db = this.db as any;
    const us = await db.select({ id: users.id, username: users.username, role: users.role }).from(users).orderBy(users.username);
    const ups = await db.select({ userId: userPermissions.userId, perm: userPermissions.perm }).from(userPermissions);
    const byUser = new Map<number, string[]>();
    for (const r of ups) {
      const k = Number(r.userId);
      const arr = byUser.get(k) ?? [];
      arr.push(r.perm);
      byUser.set(k, arr);
    }
    const evaluated = us.map((u: any) => {
      const overrides = byUser.get(Number(u.id)) ?? [];
      const effective = resolvePermissions(u.role as Role, overrides.length ? (overrides as Permission[]) : null);
      const conflicts = detectSodConflicts(effective);
      return { username: u.username, role: u.role, inherent: u.role === 'Admin', conflict_count: conflicts.length, conflicts };
    });
    const flagged = evaluated.filter((x: any) => x.conflict_count > 0 && !x.inherent);
    const byRule: Record<string, number> = {};
    for (const x of flagged) for (const c of x.conflicts) byRule[c.ruleId] = (byRule[c.ruleId] ?? 0) + 1;
    return {
      report: 'Segregation-of-Duties conflict report (per-user effective permissions)',
      rules: SOD_RULES.map((r) => ({ id: r.id, duty_a: r.dutyA, duty_b: r.dutyB, severity: r.severity })),
      summary: {
        total_users: evaluated.length,
        users_with_conflicts: flagged.length,
        admins_inherent: evaluated.filter((x: any) => x.inherent).length,
        by_rule: byRule,
      },
      users: evaluated,
    };
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
