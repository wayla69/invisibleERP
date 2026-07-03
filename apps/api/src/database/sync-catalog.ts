/**
 * Release-time catalog sync — runs on EVERY deploy (Railway preDeployCommand, after db:migrate).
 * Only upserts the permission catalog + default role grants (idempotent, never touches credentials,
 * users, or tenants), so it needs no production guard. First-boot seeding (admin user, HQ tenant)
 * remains in seed.ts behind the docs/27 R0-3 gate (ALLOW_PROD_SEED=1 + SEED_ADMIN_PASSWORD).
 * รัน: pnpm --filter @ierp/api db:sync-catalog
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';
import { syncCatalog } from './catalog';

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
  await syncCatalog(db);
  console.log('✅ Catalog sync complete: permissions, role_permissions.');
  await client.end();
}

main().catch((e) => {
  console.error('Catalog sync failed:', e);
  process.exit(1);
});
