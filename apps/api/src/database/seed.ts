/**
 * Seed ขั้นต่ำสำหรับ dev (Phase 0): permissions, role_permissions, tenant HQ, admin user.
 * รัน: pnpm --filter @ierp/api db:seed   (อ่าน DATABASE_URL จาก root .env)
 * NOTE: ข้อมูลจริงมาจาก ETL (Phase 1) — seed นี้ไว้ทดสอบ login เท่านั้น.
 */
import { resolve } from 'node:path';
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

  // 4. admin user (legacy default admin/admin123 — เตือนให้เปลี่ยน)
  const hash = await pw.hash('admin123');
  await db
    .insert(schema.users)
    .values({ username: 'admin', passwordHash: hash, role: 'Admin', tenantId: hq?.id, mustChangePassword: true })
    .onConflictDoNothing();

  console.log('✅ Seed complete: permissions, role_permissions, tenant HQ, admin user (admin/admin123 — change it!)');
  await client.end();
}

main().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
