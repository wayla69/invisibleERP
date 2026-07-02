/**
 * Seed ขั้นต่ำสำหรับ dev (Phase 0): permissions, role_permissions, tenant HQ, admin user.
 * รัน: pnpm --filter @ierp/api db:seed   (อ่าน DATABASE_URL จาก root .env)
 * NOTE: ข้อมูลจริงมาจาก ETL (Phase 1) — seed นี้ไว้ทดสอบ login เท่านั้น.
 */
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { PERMISSIONS, PERM_GROUPS, DEFAULT_ROLE_PERMISSIONS, type Role } from '@ierp/shared';
import * as schema from './schema';
import { PasswordService } from '../modules/auth/password.service';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try {
    (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p);
  } catch {
    /* ignore */
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set (copy .env.example → .env)');
  // docs/27 R0-3: seeding a production database is opt-in only — never on a running system by accident.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== '1') {
    throw new Error('Refusing to seed with NODE_ENV=production (set ALLOW_PROD_SEED=1 for a deliberate first-boot seed).');
  }

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });
  const pw = new PasswordService();

  const grpOf = (key: string) =>
    Object.entries(PERM_GROUPS).find(([, ks]) => (ks as string[]).includes(key))?.[0] ?? null;

  // 1. permissions
  await db
    .insert(schema.permissions)
    .values(PERMISSIONS.map((key) => ({ key, grp: grpOf(key) })))
    .onConflictDoNothing();

  // 2. role_permissions
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    await db
      .insert(schema.rolePermissions)
      .values((perms as string[]).map((perm) => ({ role: role as Role, perm })))
      .onConflictDoNothing();
  }

  // 3. tenant HQ
  await db.insert(schema.tenants).values({ code: 'HQ', name: 'Head Office' }).onConflictDoNothing();
  const hq = (await db.select().from(schema.tenants).where(eq(schema.tenants.code, 'HQ')))[0];

  // 4. admin user (docs/27 R0-3 / AUD-SEC-03) — NO well-known default credential. The initial password
  // comes from SEED_ADMIN_PASSWORD or is generated randomly and printed ONCE; either way the account is
  // must_change_password (a hard API gate, guards.ts PASSWORD_CHANGE_REQUIRED) until rotated.
  const initialPassword = process.env.SEED_ADMIN_PASSWORD || randomBytes(12).toString('base64url');
  const hash = await pw.hash(initialPassword);
  const insertedAdmin = await db
    .insert(schema.users)
    .values({ username: 'admin', passwordHash: hash, role: 'Admin', tenantId: hq?.id, mustChangePassword: true })
    .onConflictDoNothing()
    .returning({ id: schema.users.id });
  if (insertedAdmin.length && !process.env.SEED_ADMIN_PASSWORD) {
    console.log(`✅ Seed complete. Initial admin credential (shown ONCE — rotate on first login): admin / ${initialPassword}`);
  } else {
    console.log('✅ Seed complete: permissions, role_permissions, tenant HQ, admin user (existing row untouched).');
  }
  await client.end();
}

main().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
