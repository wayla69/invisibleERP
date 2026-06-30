/**
 * Swappable harness database (operational maturity — Step 3: close the "green on PGlite / broken on prod"
 * gap). Returns a Drizzle db backed by REAL Postgres when HARNESS_PG_URL is set (the CI pg-core job),
 * else PGlite (the default for local + the existing matrix). Same schema, same migrations — so a harness
 * written against this helper runs on BOTH, and real-Postgres-only behaviours (postgres-js Date handling,
 * FORCE ROW LEVEL SECURITY under app_user, append-only triggers) are actually exercised in CI.
 *
 * Seeding note: on real Postgres every tenant table is FORCE-RLS, so a direct owner INSERT is BLOCKED.
 * Seed through `runInTenantContext(db, { bypass: true }, …)` (as the app's job worker does) — that sets the
 * bypass GUC + app_user role exactly like a request, and works unchanged on PGlite.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import postgres from 'postgres';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as schema from '../../../apps/api/dist/database/schema/index';

const MIG = resolve(process.cwd(), '../../apps/api/drizzle');
function migrationSql(): string[] {
  return readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => readFileSync(join(MIG, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
}

export interface HarnessDb {
  db: any;            // a drizzle instance over the chosen driver (wrap with tenantAwareProxy before use)
  kind: 'pg' | 'pglite';
  cleanup: () => Promise<void>;
}

export async function harnessDb(): Promise<HarnessDb> {
  const url = process.env.HARNESS_PG_URL;
  if (url) {
    // Dedicated, ephemeral CI database: reset the schema so each run starts clean, then apply migrations
    // as the connecting (super)user — which both creates the app_user role and can SET ROLE to it.
    const sql = postgres(url, { max: 1, onnotice: () => {} }); // max:1 → deterministic role/GUC + seeding
    await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const m of migrationSql()) await sql.unsafe(m);
    return { db: drizzlePg(sql, { schema }), kind: 'pg', cleanup: async () => { await sql.end({ timeout: 5 }); } };
  }
  const pg = await PGlite.create();
  for (const m of migrationSql()) await pg.exec(m);
  return { db: drizzlePglite(pg, { schema }), kind: 'pglite', cleanup: async () => { /* in-memory */ } };
}
