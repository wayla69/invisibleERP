/**
 * RLS-coverage guard (pentest 2026-07-16 P8). Companion to the tenant-index guard (tenant-idx.ts): a table
 * whose column is literally `tenant_id` reads as tenant-scoped, so it MUST have Row-Level Security ENABLED
 * plus a `tenant_isolation` policy — otherwise the only thing standing between two tenants' rows is a
 * hand-written `eq(tenant_id, …)` predicate at every call site, with no database backstop (the prod H-3
 * non-superuser base role can't help a table that never enabled RLS). A future read that forgets the
 * predicate would leak across tenants silently.
 *
 * This boots the full migration set over PGlite (PGlite executes ENABLE ROW LEVEL SECURITY + CREATE POLICY,
 * incl. the canonical DO-loop) and fails on ANY `tenant_id`-column table that lacks rowsecurity=true AND a
 * `tenant_isolation` policy — except the documented ALLOW_LIST below.
 *
 * ALLOW_LIST is for genuine PLATFORM tables that legitimately have NO RLS — but it is currently EMPTY,
 * because every `tenant_id` table (all 539, incl. the metering tables ai_token_usage / usage_events /
 * *_overage_billing_runs that the 2026-07-16 pentest P8 flagged) is in fact covered: the canonical generic
 * RLS loop (`FOR r IN SELECT table_name … WHERE column_name='tenant_id' LOOP … CREATE POLICY tenant_isolation`)
 * that runs in later migrations sweeps in EVERY tenant_id table created before it. P8's premise — that those
 * tables "never ENABLE ROW LEVEL SECURITY" — was drawn from each table's own CREATE-TABLE migration and
 * missed the loop; verified here: all four report relrowsecurity=true + a tenant_isolation policy. A true
 * platform table that must skip RLS should NOT be named `tenant_id` (use `about_tenant_id`/`created_tenant_id`
 * per platform_notifications / signup_requests) — that drops it from this set entirely, which is preferred
 * over an allow-list entry.
 *
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover rls-coverage
 */
import { PGlite } from '@electric-sql/pglite';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');

// Genuine platform/operator tables that intentionally have NO RLS. Each entry MUST carry a justification.
// Currently empty — every tenant_id table is RLS-covered (see the header). Prefer renaming a would-be
// exemption's column to about_tenant_id over adding it here.
const ALLOW_LIST: Record<string, string> = {};

const TENANT_TABLES_SQL = `
  select distinct c.table_name
  from information_schema.columns c
  where c.table_schema = 'public' and c.column_name = 'tenant_id'
  order by c.table_name;
`;

// A table is "covered" iff RLS is enabled (pg_class.relrowsecurity) AND a tenant_isolation policy exists.
const COVERED_SQL = `
  select t.relname as table_name
  from pg_class t
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public' and t.relrowsecurity = true
    and exists (
      select 1 from pg_policy p where p.polrelid = t.oid and p.polname = 'tenant_isolation'
    );
`;

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));

  const tenantTables = (await pg.query(TENANT_TABLES_SQL)).rows.map((r: any) => r.table_name as string);
  const covered = new Set((await pg.query(COVERED_SQL)).rows.map((r: any) => r.table_name as string));

  const uncovered = tenantTables.filter((t) => !covered.has(t));
  const unexpected = uncovered.filter((t) => !(t in ALLOW_LIST));
  const staleAllow = Object.keys(ALLOW_LIST).filter((t) => !tenantTables.includes(t) || covered.has(t));

  const coveredCount = tenantTables.filter((t) => covered.has(t)).length;
  console.log('\n── RLS-coverage guard (pentest P8) ──');
  console.log(`  tenant_id tables: ${tenantTables.length}; RLS+tenant_isolation covered: ${coveredCount}`);
  console.log(`  intentionally exempt (allow-list): ${uncovered.filter((t) => t in ALLOW_LIST).length}`);

  let failed = false;
  if (unexpected.length) {
    failed = true;
    console.log('  ❌ tenant_id tables WITHOUT RLS+tenant_isolation and NOT on the allow-list:');
    for (const t of unexpected) console.log(`     - ${t}  (enable RLS + tenant_isolation in its migration, or rename the column to about_tenant_id if it is a platform table)`);
  }
  if (staleAllow.length) {
    failed = true;
    console.log('  ❌ stale allow-list entries (now covered, renamed, or dropped — remove them):');
    for (const t of staleAllow) console.log(`     - ${t}`);
  }
  if (failed) { console.log('\n❌ RLS-coverage guard failed'); process.exit(1); }
  console.log('\n✅ every tenant_id table is RLS-covered or a documented platform exemption');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
