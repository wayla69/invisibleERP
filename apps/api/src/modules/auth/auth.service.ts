import { Inject, Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { resolvePermissions, type Role, type LoginResponse, type AuthUser } from '@ierp/shared';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { users, userPermissions, tenants } from '../../database/schema';
import { PasswordService } from './password.service';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordService,
  ) {}

  async login(username: string, password: string): Promise<LoginResponse> {
    const row = (await this.db.select().from(users).where(eq(users.username, username)).limit(1))[0];
    const fail = () =>
      new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Invalid username or password', messageTh: 'Username หรือ Password ไม่ถูกต้อง' });
    if (!row) throw fail();

    const { ok, needsRehash } = await this.passwords.verify(password, row.passwordHash);
    if (!ok) throw fail();
    if (needsRehash) {
      const fresh = await this.passwords.hash(password);
      await this.db.update(users).set({ passwordHash: fresh }).where(eq(users.id, row.id));
    }

    // tenant code (legacy Customer_Name) สำหรับ scoping
    let customerName: string | null = null;
    if (row.tenantId != null) {
      const t = (await this.db.select({ code: tenants.code }).from(tenants).where(eq(tenants.id, row.tenantId)).limit(1))[0];
      customerName = t?.code ?? null;
    }

    const role = row.role as Role;
    const overrides = (await this.db.select({ perm: userPermissions.perm }).from(userPermissions).where(eq(userPermissions.userId, row.id))).map((r) => r.perm as never);
    const perms = resolvePermissions(role, overrides.length ? overrides : null);

    const token = await this.jwt.signAsync({ sub: username, role, customerName, tenantId: row.tenantId ?? null, permissions: perms });
    return { token, username, role, customer_name: customerName, must_change_password: !!row.mustChangePassword };
  }

  async me(user: AuthUser): Promise<AuthUser> {
    const [row] = await this.db.select({ m: users.mustChangePassword }).from(users).where(eq(users.username, user.username)).limit(1);
    return { ...user, must_change_password: !!row?.m };
  }

  // A5 — rotate password (verify current, set new, clear the force-change flag). Min 8 chars.
  async changePassword(username: string, currentPassword: string, newPassword: string): Promise<{ ok: true }> {
    if (!newPassword || newPassword.length < 8)
      throw new BadRequestException({ code: 'WEAK_PASSWORD', message: 'New password must be at least 8 characters', messageTh: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร' });
    const [row] = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!row) throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'User not found' });
    const { ok } = await this.passwords.verify(currentPassword, row.passwordHash);
    if (!ok) throw new BadRequestException({ code: 'BAD_CURRENT_PASSWORD', message: 'Current password is incorrect', messageTh: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
    if (currentPassword === newPassword)
      throw new BadRequestException({ code: 'SAME_PASSWORD', message: 'New password must differ from current', messageTh: 'รหัสผ่านใหม่ต้องต่างจากเดิม' });
    const hash = await this.passwords.hash(newPassword);
    await this.db.update(users).set({ passwordHash: hash, mustChangePassword: false }).where(eq(users.id, row.id));
    return { ok: true };
  }
}
