/**
 * Deploy-time migration runner — `db:migrate` (Railway preDeployCommand + CI pg-smoke). Replaces the
 * bare `drizzle-kit migrate` CLI (kept as `db:migrate:kit` for fallback).
 *
 * WHY THIS EXISTS (the 0387 outage, 2026-07-13 — docs/ops/tenancy-model.md rev 1.26): prod migrations
 * run as the hardened `ierp_app` role (non-superuser, NOBYPASSRLS — security-review H-3), and every
 * tenant-scoped table carries FORCE ROW LEVEL SECURITY with a purely GUC-based policy
 * (`app.bypass_rls` / `app.tenant_id`). A migration that READS or UPDATES rows in any of those 500+
 * tables therefore sees ZERO rows unless the bypass GUC is set — and `drizzle-kit migrate` sets no
 * GUCs. Migration 0387's backfill (`FROM users u WHERE ...`) silently matched nothing and failed its
 * own attribution check, twice, while every local test passed (local connections used the superuser,
 * which bypasses RLS unconditionally and masked the bug).
 *
 * THE PERMANENT FIX: set `app.bypass_rls='on'` at SESSION level on a dedicated single connection
 * (max: 1 → every migration transaction runs on that same connection and inherits the GUC), then apply
 * the pending migrations. Every migration, current and future, now runs with the same effective
 * visibility a superuser-run migration historically had, with zero effect on the API's runtime
 * connections (this process exits after migrating; the per-request interceptor still scopes every
 * real request).
 *
 * NB drizzle-orm's built-in `migrate()` is NOT used — it wraps ALL pending migrations in a single
 * transaction, which on a fresh database (370+ migrations) overflows the lock table
 * (53200 "out of shared memory"; hit by the pg-smoke from-scratch run, rev 1.27). This runner keeps
 * drizzle-kit's one-transaction-per-migration behaviour and its exact bookkeeping: same
 * `drizzle.__drizzle_migrations` table, and the same journal rule — apply entries whose `when`
 * (folderMillis) is strictly greater than the LAST APPLIED created_at, so a non-monotonic `when` is
 * skipped exactly like prod (the migrations-journaled gate enforces monotonicity for new entries).
 *
 * รัน: pnpm --filter @ierp/api db:migrate
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try {
    // loadEnvFile never overrides already-set env vars, so an explicit DATABASE_URL always wins.
    (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p);
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set (copy .env.example → .env)');
  const migrations = readMigrationFiles({ migrationsFolder: resolve(process.cwd(), 'drizzle') });
  // max: 1 is load-bearing — the session GUC below and the migration transactions must share the
  // same physical connection, or the bypass never reaches the migration statements.
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // Session-level (third arg false): survives across every migration transaction on this connection.
    // Scoped to this dedicated deploy-time process only — the API's own pool is untouched.
    await sql`SELECT set_config('app.bypass_rls', 'on', false)`;
    await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`;
    const [last] = await sql`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`;
    const lastMillis = last ? Number(last.created_at) : 0;
    let applied = 0;
    for (const m of migrations) {
      if (m.folderMillis <= lastMillis) continue;
      await sql.begin(async (tx) => {
        for (const stmt of m.sql) await tx.unsafe(stmt);
        await tx`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${m.hash}, ${m.folderMillis})`;
      });
      applied++;
    }
    console.log(`✅ db:migrate: ${applied} migration(s) applied, ${migrations.length - applied} already up to date (app.bypass_rls session GUC set — see file header).`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
