/**
 * Programmatic migration runner — `db:migrate` (prod preDeploy + CI pg-smoke). Replaces `drizzle-kit
 * migrate`, which it is drop-in compatible with: drizzle-orm's migrator uses the same
 * `drizzle.__drizzle_migrations` table and the same `when`-monotonic apply rule
 * (`created_at < folderMillis`), so an already-migrated prod DB continues seamlessly.
 *
 * Why this exists (migration 0387 double deploy failure, 2026-07-13 — docs/ops/tenancy-model.md
 * rev 1.26): prod applies migrations as the hardened `ierp_app` role (NOSUPERUSER, NOBYPASSRLS —
 * security review H-3, §1bis). Every table with a `tenant_id` column carries FORCE ROW LEVEL SECURITY
 * with a purely GUC-based policy (`app.bypass_rls` / `app.tenant_id` / `app.org_id`), and a bare
 * migration session sets none of those GUCs — so a migration that READS such a table (0387's
 * users→tenant_id backfill) sees ZERO rows in prod, while passing under any superuser connection
 * (CI's service container, local psql), which bypasses RLS unconditionally. This runner sets the same
 * bypass GUC the app's HQ/god paths use (`common/tenant-tx.interceptor.ts`) at SESSION level on the
 * single migration connection, so DML inside ANY migration operates on the real rows regardless of the
 * connecting role's RLS posture — no per-migration set_config boilerplate needed.
 *
 * DDL (CREATE/ALTER/INDEX) is unaffected by the GUC; it still requires the §1bis ownership grants.
 */
import postgres from 'postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { resolve } from 'node:path';

// Same fallback as drizzle.config.ts; script runs with cwd = apps/api (pnpm --filter @ierp/api).
const url = process.env.DATABASE_URL ?? 'postgresql://user:pass@localhost:5432/invisible_erp_v2';
const migrationsFolder = resolve(process.cwd(), 'drizzle');

async function main(): Promise<void> {
  // NB: drizzle-orm's built-in migrate() is NOT used — it wraps ALL pending migrations in a single
  // transaction, which on a fresh database (370+ migrations) overflows the lock table
  // (53200 "out of shared memory"). drizzle-kit runs one transaction per migration; this runner
  // reproduces that, plus the journal semantics: apply entries whose `when` (folderMillis) is
  // strictly greater than the LAST APPLIED created_at — so a non-monotonic `when` is skipped,
  // exactly like prod (the migrations-journaled gate enforces monotonicity for new entries).
  const migrations = readMigrationFiles({ migrationsFolder });
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // Session-level (is_local = false): one connection runs everything, so the GUC covers every
    // migration — including reads/DML against FORCE-RLS tables (the 0387 class).
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
    console.log(`db:migrate: ${applied} migration(s) applied, ${migrations.length - applied} already up to date`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error('db:migrate failed:', e);
  process.exit(1);
});
