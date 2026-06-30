import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException, UnprocessableEntityException, ForbiddenException, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { users, userPermissions, tenants, accessReviews } from '../../database/schema';
import { desc } from 'drizzle-orm';
import { PasswordService } from '../auth/password.service';
import { BillingService } from '../billing/billing.service';
import { resolvePermissions, detectSodConflicts, type Role, type Permission } from '@ierp/shared';
import type { JwtUser } from '../../common/decorators';
import { normalizeUsername } from '../../common/username';

export interface CreateUserDto { username: string; password: string; role: string; customer_name?: string; permissions?: string[]; allow_sod_override?: boolean; sod_reason?: string }
export interface UpdateUserDto { role?: string; customer_name?: string; permissions?: string[]; allow_sod_override?: boolean; sod_reason?: string }

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger('AdminUsers');
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly passwords: PasswordService,
    private readonly billing: BillingService,
  ) {}

  // Preventive SoD guard (ITGC-AC-09): block assigning a per-user permission OVERRIDE that holds duties on
  // both sides of a conflict rule, unless the admin explicitly overrides WITH a reason (which is logged).
  // A per-user override REPLACES the role default (see resolvePermissions precedence), so the override set
  // IS the user's effective permission set — checking it here is checking the effective grant.
  // Role-default conflicts (legacy coarse roles in transition) are GRANDFATHERED: not blocked here, but a
  // detective warning is emitted so the quarterly UAR (getAccessReview) still surfaces them.
  private assertNoSodConflict(username: string, role: string | undefined, perms: string[] | undefined, allowOverride?: boolean, reason?: string) {
    if (!perms?.length) {
      // No override → the bare role decides. Surface (don't block) any grandfathered role-default conflict.
      if (role) {
        const roleConflicts = detectSodConflicts(resolvePermissions(role as Role));
        if (roleConflicts.length) this.logger.warn(`Grandfathered SoD conflict on role "${role}" for "${username}" — rules ${roleConflicts.map((c) => c.ruleId).join(',')}; tracked by quarterly UAR.`);
      }
      return;
    }
    const conflicts = detectSodConflicts(perms as Permission[]);
    if (!conflicts.length) return;
    if (!allowOverride || !reason?.trim()) {
      throw new UnprocessableEntityException({
        code: 'SOD_CONFLICT',
        message: `Permission set creates SoD conflict(s): ${conflicts.map((c) => `${c.ruleId} (${c.dutyA} ✗ ${c.dutyB})`).join('; ')}. To proceed, set allow_sod_override=true with a sod_reason.`,
        messageTh: 'ชุดสิทธิ์ขัดกับการแบ่งแยกหน้าที่ (SoD) — หากจำเป็นต้องระบุเหตุผลและยืนยันการข้าม',
        conflicts,
      });
    }
    this.logger.warn(`SoD override for "${username}" by reason="${reason}" — conflicts: ${conflicts.map((c) => c.ruleId).join(',')}`);
  }

  // Preventive privilege-escalation guard (ITGC-AC-02 authorization / ITGC-AC-09 SoD-on-provisioning):
  // only an Admin may grant the Admin role. The RLS
  // bypass (HQ "sees all") is keyed on role==='Admin', so without this a tenant-scoped AccessAdmin (which
  // holds the `users` permission) could mint an Admin inside its own tenant — passing the RLS WITH CHECK —
  // and then log in with full cross-tenant bypass. Applies equally to the SCIM provisioning principal.
  private assertCanGrantRole(role: string | undefined, actor: JwtUser | undefined) {
    if (role === 'Admin' && actor?.role !== 'Admin') {
      throw new ForbiddenException({
        code: 'ADMIN_GRANT_DENIED',
        message: 'Only an Admin may grant the Admin role',
        messageTh: 'เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นที่สามารถให้สิทธิ์ Admin ได้',
      });
    }
  }

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

  async create(dto: CreateUserDto, actor: JwtUser) {
    const db = this.db as any;
    if (!dto.password || dto.password.length < 6) throw new BadRequestException({ code: 'WEAK_PASSWORD', message: 'Password must be ≥6 chars', messageTh: 'รหัสผ่านอย่างน้อย 6 ตัว' });
    const username = normalizeUsername(dto.username);
    if (!username) throw new BadRequestException({ code: 'BAD_USERNAME', message: 'Username is required', messageTh: 'ต้องระบุชื่อผู้ใช้' });
    this.assertCanGrantRole(dto.role, actor);
    const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (exists) throw new ConflictException({ code: 'USER_EXISTS', message: `User ${username} already exists`, messageTh: 'มีผู้ใช้นี้แล้ว' });
    this.assertNoSodConflict(username, dto.role, dto.permissions, dto.allow_sod_override, dto.sod_reason);
    const tenantId = await this.tenantIdFor(dto.customer_name);
    // Enforce the plan's maxUsers ceiling before inserting (PLAN_USER_LIMIT).
    // Admin principal (tenantId=null) is cross-tenant HQ — no limit applies.
    if (tenantId != null) await this.billing.checkUserLimit(tenantId);
    const hash = await this.passwords.hash(dto.password);
    const [u] = await db.insert(users).values({ username, passwordHash: hash, role: dto.role as any, tenantId, mustChangePassword: true }).returning({ id: users.id });
    if (dto.permissions?.length) {
      await db.insert(userPermissions).values(dto.permissions.map((p) => ({ userId: Number(u.id), perm: p }))).onConflictDoNothing();
    }
    return { username, role: dto.role, created: true };
  }

  async update(username: string, dto: UpdateUserDto, actor: JwtUser) {
    username = normalizeUsername(username);
    const db = this.db as any;
    const [u] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found', messageTh: 'ไม่พบผู้ใช้' });
    this.assertCanGrantRole(dto.role, actor);
    this.assertNoSodConflict(username, dto.role ?? (u.role as string), dto.permissions, dto.allow_sod_override, dto.sod_reason);
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
    username = normalizeUsername(username);
    const db = this.db as any;
    const [u] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found', messageTh: 'ไม่พบผู้ใช้' });
    const hash = await this.passwords.hash(newPassword);
    await db.update(users).set({ passwordHash: hash, mustChangePassword: true }).where(eq(users.id, u.id));
    return { username, reset: true };
  }

  // ── ITGC-AC-08: User Access Review ──────────────────────────────────────────
  // Build the recertification dataset: every user with role, effective (resolved+expanded) permissions,
  // and any SoD conflicts — the population a reviewer signs off each quarter.
  private async buildReview() {
    const db = this.db as any;
    const us = await db.select({ id: users.id, username: users.username, role: users.role, code: tenants.code })
      .from(users).leftJoin(tenants, eq(users.tenantId, tenants.id)).orderBy(users.username);
    const ups = await db.select({ userId: userPermissions.userId, perm: userPermissions.perm }).from(userPermissions);
    const byUser = new Map<number, string[]>();
    for (const r of ups) { const k = Number(r.userId); const arr = byUser.get(k) ?? []; arr.push(r.perm); byUser.set(k, arr); }
    return us.map((u: any) => {
      const overrides = byUser.get(Number(u.id)) ?? [];
      const effective = resolvePermissions(u.role as Role, overrides.length ? (overrides as Permission[]) : null);
      const conflicts = detectSodConflicts(effective);
      return {
        username: u.username, role: u.role, customer_name: u.code ?? null,
        has_override: overrides.length > 0,
        permission_count: effective.length,
        permissions: [...effective].sort(),
        sod_conflict_count: conflicts.length,
        sod_conflicts: conflicts.map((c) => c.ruleId),
      };
    });
  }

  async accessReview() {
    const rows = await this.buildReview();
    return {
      report: 'User Access Review (effective permissions + SoD conflicts)',
      generated: true,
      summary: { total_users: rows.length, users_with_conflicts: rows.filter((r: any) => r.sod_conflict_count > 0).length, users_with_override: rows.filter((r: any) => r.has_override).length },
      users: rows,
    };
  }

  // CSV export for the reviewer to annotate keep/revoke and retain as audit evidence.
  async exportReviewCsv(): Promise<string> {
    const rows = await this.buildReview();
    const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const header = ['username', 'role', 'customer_name', 'has_override', 'permission_count', 'sod_conflict_count', 'sod_conflicts', 'permissions', 'decision_keep_revoke', 'reviewer_note'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([r.username, r.role, r.customer_name, r.has_override, r.permission_count, r.sod_conflict_count, r.sod_conflicts.join('|'), r.permissions.join('|'), '', ''].map(esc).join(','));
    }
    return lines.join('\n');
  }

  // Record the periodic recertification sign-off (attestation evidence).
  async certifyReview(dto: { period: string; notes?: string }, user: JwtUser) {
    const db = this.db as any;
    const rows = await this.buildReview();
    const [r] = await db.insert(accessReviews).values({
      period: dto.period, reviewedBy: user.username, tenantId: user.tenantId ?? null, notes: dto.notes ?? null,
      userCount: rows.length, conflictUserCount: rows.filter((x: any) => x.sod_conflict_count > 0).length,
    }).returning({ id: accessReviews.id });
    return { id: Number(r.id), period: dto.period, reviewed_by: user.username, user_count: rows.length, certified: true };
  }

  async listReviews() {
    const db = this.db as any;
    const rows = await db.select().from(accessReviews).orderBy(desc(accessReviews.id)).limit(50);
    return { reviews: rows.map((r: any) => ({ id: Number(r.id), period: r.period, reviewed_by: r.reviewedBy, reviewed_at: r.reviewedAt, user_count: r.userCount, conflict_user_count: r.conflictUserCount, notes: r.notes })), count: rows.length };
  }

  async remove(username: string, actor: JwtUser) {
    username = normalizeUsername(username);
    if (username === actor.username) throw new BadRequestException({ code: 'SELF_DELETE', message: 'Cannot delete yourself', messageTh: 'ลบบัญชีตัวเองไม่ได้' });
    const db = this.db as any;
    const [u] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found', messageTh: 'ไม่พบผู้ใช้' });
    await db.delete(userPermissions).where(eq(userPermissions.userId, Number(u.id)));
    await db.delete(users).where(eq(users.id, u.id));
    return { username, deleted: true };
  }
}
