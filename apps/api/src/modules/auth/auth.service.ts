import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
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
    return { token, username, role, customer_name: customerName };
  }

  async me(user: AuthUser): Promise<AuthUser> {
    return user;
  }
}
