/**
 * Create (or reset) a platform-owner "god" user — the cross-org super-user of the multi-tenancy model
 * (ITGC-AC-18, docs/ops/tenancy-model.md §2bis).
 *
 * This ONLY provisions the account row. It does NOT grant the god bypass — that comes from listing the
 * SAME username in the `PLATFORM_ADMIN_USERNAMES` env var on every API service (the two-step model keeps
 * "who is god" an ops-controlled deploy setting, not an in-app assignable role).
 *
 * The account is created as role=Admin (so it holds every permission) with `must_change_password=true`, so
 * the temporary GOD_PASSWORD you pass here is rotated on first login (a hard API gate, docs/27 R0-3) and is
 * never the standing credential. Since Admin is a privileged role it will also be prompted to enrol MFA.
 *
 * Env:
 *   DATABASE_URL          (required)  target database
 *   GOD_USERNAME          (optional)  default 'godmimi'; normalized to trimmed-lowercase
 *   GOD_PASSWORD          (required)  temporary password, >=8 chars — hashed with the app's scrypt (never logged)
 *   GOD_TENANT_CODE       (optional)  home tenant code; default 'HQ', else the lowest-id tenant
 *   GOD_RESET_PASSWORD    (optional)  '1' → if the user already exists, reset its password (+ re-arm
 *                                     must_change_password) instead of leaving it untouched
 *   ALLOW_PROD_GOD        (required in production) '1' — a deliberate opt-in, mirroring the seed's prod gate
 *
 * Run:  GOD_PASSWORD='<temp>' pnpm --filter @ierp/api db:create-god
 *   prod: ALLOW_PROD_GOD=1 GOD_PASSWORD='<temp>' pnpm --filter @ierp/api db:create-god
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { asc, eq } from 'drizzle-orm';
import * as schema from './schema';
import { PasswordService } from '../modules/auth/password.service';
import { normalizeUsername } from '../common/username';

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
  // docs/27 R0-3 — mutating a production database with a new privileged account is opt-in only.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_GOD !== '1') {
    throw new Error('Refusing to create a god user with NODE_ENV=production (set ALLOW_PROD_GOD=1 for a deliberate provisioning run).');
  }

  const username = normalizeUsername(process.env.GOD_USERNAME || 'godmimi');
  const password = process.env.GOD_PASSWORD;
  if (!password || password.length < 8) {
    throw new Error('GOD_PASSWORD (>=8 chars) is required — the script never generates or logs a credential. Set it, run, then rotate on first login (must_change_password is enforced).');
  }

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });
  const pw = new PasswordService();
  try {
    // Resolve the home tenant. God bypasses RLS globally, so the tenant only anchors resolveTenantId — prefer
    // HQ, else the lowest-id tenant. org_id stays NULL (a god's visibility comes from the env bypass, not org).
    const wantCode = (process.env.GOD_TENANT_CODE || 'HQ').trim();
    const [byCode] = await db.select({ id: schema.tenants.id, code: schema.tenants.code })
      .from(schema.tenants).where(eq(schema.tenants.code, wantCode)).limit(1);
    const [firstTenant] = byCode
      ? [byCode]
      : await db.select({ id: schema.tenants.id, code: schema.tenants.code })
          .from(schema.tenants).orderBy(asc(schema.tenants.id)).limit(1);
    if (!firstTenant) throw new Error(`No tenant found (looked for '${wantCode}', then any). Run db:seed (or provision a tenant) first.`);
    const tenantId = Number(firstTenant.id);

    const hash = await pw.hash(password);
    const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, username)).limit(1);

    if (existing) {
      if (process.env.GOD_RESET_PASSWORD === '1') {
        await db.update(schema.users)
          .set({ passwordHash: hash, role: 'Admin', isActive: true, mustChangePassword: true })
          .where(eq(schema.users.id, existing.id));
        console.log(`✅ Reset existing user '${username}' → role Admin, temp password set (rotate on first login).`);
      } else {
        console.log(`ℹ️  User '${username}' already exists — untouched (set GOD_RESET_PASSWORD=1 to reset its password/role).`);
      }
    } else {
      await db.insert(schema.users).values({
        username, passwordHash: hash, role: 'Admin', tenantId, mustChangePassword: true,
      });
      console.log(`✅ Created god candidate '${username}' (role Admin, home tenant ${firstTenant.code}, must_change_password).`);
    }

    console.log(`\nNext: add '${username}' to PLATFORM_ADMIN_USERNAMES on every API service sharing this DB, then redeploy.`);
    console.log('Only then does this account get the cross-org god bypass. Rotate the temp password + enrol MFA on first login.');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('create-god-user failed:', e);
  process.exit(1);
});
