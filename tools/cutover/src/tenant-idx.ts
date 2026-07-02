/**
 * Tenant-index guard (docs/27 R1-1, AUD-ARC-01). RLS puts a tenant_id predicate on EVERY query against a
 * tenant-scoped table, so each such table MUST have an index whose LEADING column is tenant_id — otherwise
 * per-tenant reads seq-scan and degrade non-linearly under concurrency. This harness boots the full
 * migration set over PGlite and fails on ANY uncovered table (no grandfathering — 0218 backfilled the lot),
 * so a new tenant-scoped table cannot ship without a tenant-leading index in its migration or schema.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover tenant-idx
 */
import { PGlite } from '@electric-sql/pglite';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');

const MISSING_SQL = `
  with tenant_tables as (
    select c.table_name from information_schema.columns c
    where c.table_schema = 'public' and c.column_name = 'tenant_id'
  ),
  lead_idx as (
    select t.relname as table_name
    from pg_index i
    join pg_class t on t.oid = i.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    join pg_attribute a on a.attrelid = t.oid and a.attnum = i.indkey[0]
    where n.nspname = 'public' and a.attname = 'tenant_id'
    group by t.relname
  )
  select tt.table_name from tenant_tables tt
  where tt.table_name not in (select table_name from lead_idx)
  order by tt.table_name;
`;

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));

  const tenantCount = Number(
    (await pg.query(`select count(distinct table_name) as c from information_schema.columns where table_schema='public' and column_name='tenant_id'`)).rows
      .map((r: any) => r.c)[0],
  );
  const missing = (await pg.query(MISSING_SQL)).rows.map((r: any) => r.table_name as string);

  console.log('\n── Tenant-index guard (R1-1 / AUD-ARC-01) ──');
  console.log(`  tenant-scoped tables: ${tenantCount}; without a leading tenant_id index: ${missing.length}`);
  if (missing.length) {
    console.log('  ❌ uncovered tables (add a (tenant_id, …) index in your migration or schema):');
    for (const t of missing) console.log(`     - ${t}`);
    console.log('\n❌ tenant-index guard failed');
    process.exit(1);
  }
  console.log('\n✅ every tenant-scoped table has a tenant-leading index');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
