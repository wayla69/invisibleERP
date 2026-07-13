/**
 * Deploy-time migration runner (Railway preDeployCommand) — replaces the bare `drizzle-kit migrate` CLI.
 *
 * WHY THIS EXISTS (the 0387 outage, 2026-07-13): prod migrations run as the hardened `ierp_app` role
 * (non-superuser, NOBYPASSRLS — security-review H-3), and every tenant-scoped table carries FORCE ROW
 * LEVEL SECURITY with a purely GUC-based policy (`app.bypass_rls` / `app.tenant_id`). A migration that
 * READS or UPDATES rows in any of those 500+ tables therefore sees ZERO rows unless the bypass GUC is
 * set — and `drizzle-kit migrate` sets no GUCs. Migration 0387's backfill (`FROM users u WHERE ...`)
 * silently matched nothing and failed its own attribution check, twice, while every local test passed
 * (local connections used the superuser, which bypasses RLS unconditionally and masked the bug).
 *
 * THE PERMANENT FIX: set `app.bypass_rls='on'` at SESSION level on a dedicated single connection
 * (max: 1 → drizzle's migration transaction runs on that same connection and inherits the GUC), then
 * run drizzle-orm's programmatic migrate() — byte-compatible with drizzle-kit's bookkeeping (same
 * `drizzle.__drizzle_migrations` table, same journal-`when` comparison). Every migration, current and
 * future, now runs with the same effective visibility a superuser-run migration historically had, with
 * zero effect on the API's runtime connections (this process exits after migrating; the per-request
 * interceptor still scopes every real request).
 *
 * รัน: pnpm --filter @ierp/api db:migrate
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try {
    (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p);
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set (copy .env.example → .env)');
  // max: 1 is load-bearing — the session GUC below and drizzle's migration transaction must share the
  // same physical connection, or the bypass never reaches the migration statements.
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  // Session-level (third arg false): survives across drizzle's migration transaction on this connection.
  // Scoped to this dedicated deploy-time process only — the API's own pool is untouched.
  await client`SELECT set_config('app.bypass_rls', 'on', false)`;
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('✅ Migrations applied (with app.bypass_rls session GUC — see file header).');
  await client.end();
}

main().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
