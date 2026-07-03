/**
 * Seed ขั้นต่ำสำหรับ dev (Phase 0): permissions, role_permissions, tenant HQ, admin user.
 * รัน: pnpm --filter @ierp/api db:seed   (อ่าน DATABASE_URL จาก root .env)
 * NOTE: ข้อมูลจริงมาจาก ETL (Phase 1) — seed นี้ไว้ทดสอบ login เท่านั้น.
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from './schema';
import { syncCatalog } from './catalog';
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

  // 1+2. permissions + role_permissions — shared with the guardless release-time db:sync-catalog
  await syncCatalog(db);

  // 3. tenant HQ
  await db.insert(schema.tenants).values({ code: 'HQ', name: 'Head Office' }).onConflictDoNothing();
  const hq = (await db.select().from(schema.tenants).where(eq(schema.tenants.code, 'HQ')))[0];

  // 4. admin user (docs/27 R0-3 / AUD-SEC-03) — NO well-known default credential, and NO credential ever
  // written to a log (CodeQL js/clear-text-logging): the initial password MUST be supplied via
  // SEED_ADMIN_PASSWORD by the operator. The account stays must_change_password (a hard API gate,
  // guards.ts PASSWORD_CHANGE_REQUIRED) until rotated on first login.
  const [existingAdmin] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'admin')).limit(1);
  if (existingAdmin) {
    console.log('✅ Seed complete: permissions, role_permissions, tenant HQ (admin row already exists — untouched).');
  } else {
    const initialPassword = process.env.SEED_ADMIN_PASSWORD;
    if (!initialPassword || initialPassword.length < 8) {
      throw new Error('SEED_ADMIN_PASSWORD (≥8 chars) is required to create the initial admin — the seed never generates or logs a credential (docs/27 R0-3). Set it, seed, then rotate on first login (must_change_password is enforced).');
    }
    const hash = await pw.hash(initialPassword);
    await db
      .insert(schema.users)
      .values({ username: 'admin', passwordHash: hash, role: 'Admin', tenantId: hq?.id, mustChangePassword: true })
      .onConflictDoNothing();
    console.log('✅ Seed complete: permissions, role_permissions, tenant HQ, admin user (credential from SEED_ADMIN_PASSWORD — rotate on first login).');
  }
  await client.end();
}

main().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
