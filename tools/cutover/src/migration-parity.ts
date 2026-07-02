/**
 * Migration-order parity guard (docs/24 R5-1 / AUD-ARC-08).
 * Two consumers apply the migrations in DIFFERENT orders: the PGlite harnesses read the .sql files sorted
 * by FILENAME, while prod `drizzle-kit migrate` applies meta/_journal.json JOURNAL order. Historical
 * duplicate numbers + append-journaled orphans mean those orders genuinely differ — this harness builds a
 * fresh database BOTH ways and fails on any schema divergence (tables, columns/types/nullability/defaults,
 * index names), so "fresh-DB rebuild may diverge from prod" is now a guarded invariant, not a risk note.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover migration-parity
 */
import { PGlite } from '@electric-sql/pglite';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');

async function build(order: string[]): Promise<PGlite> {
  const pg = await PGlite.create();
  for (const f of order) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  return pg;
}

async function schemaFingerprint(pg: PGlite): Promise<{ columns: Set<string>; indexes: Set<string> }> {
  const cols = await pg.query(`
    select table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') as sig
    from information_schema.columns where table_schema = 'public' order by 1`);
  const idx = await pg.query(`select indexname as sig from pg_indexes where schemaname = 'public' order by 1`);
  return {
    columns: new Set(cols.rows.map((r: any) => String(r.sig))),
    indexes: new Set(idx.rows.map((r: any) => String(r.sig))),
  };
}

function diff(a: Set<string>, b: Set<string>): { onlyA: string[]; onlyB: string[] } {
  return { onlyA: [...a].filter((x) => !b.has(x)), onlyB: [...b].filter((x) => !a.has(x)) };
}

async function main() {
  const byFilename = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')).entries as { tag: string }[];
  const byJournal = journal.map((e) => `${e.tag}.sql`);

  // Every journaled tag must exist as a file and vice versa (the migrations-journaled gate also checks
  // this; re-assert here so a parity "pass" can't be a pass-by-omission).
  const fileSet = new Set(byFilename);
  const missing = byJournal.filter((f) => !fileSet.has(f));
  const unjournaled = byFilename.filter((f) => !byJournal.includes(f));
  if (missing.length || unjournaled.length) {
    console.error('❌ journal/file mismatch', { missing, unjournaled });
    process.exit(1);
  }

  console.log(`building fresh DB twice: filename order (harness path) vs journal order (prod path) — ${byFilename.length} migrations`);
  const [pgA, pgB] = [await build(byFilename), await build(byJournal)];
  const [fpA, fpB] = [await schemaFingerprint(pgA), await schemaFingerprint(pgB)];

  const colDiff = diff(fpA.columns, fpB.columns);
  const idxDiff = diff(fpA.indexes, fpB.indexes);
  const clean = !colDiff.onlyA.length && !colDiff.onlyB.length && !idxDiff.onlyA.length && !idxDiff.onlyB.length;

  console.log(`\n── Migration-order parity (R5-1 / AUD-ARC-08) ──`);
  console.log(`  columns: ${fpA.columns.size} (filename) vs ${fpB.columns.size} (journal); indexes: ${fpA.indexes.size} vs ${fpB.indexes.size}`);
  if (!clean) {
    if (colDiff.onlyA.length) console.log('  ❌ columns only in filename-order build:', colDiff.onlyA.slice(0, 10));
    if (colDiff.onlyB.length) console.log('  ❌ columns only in journal-order build:', colDiff.onlyB.slice(0, 10));
    if (idxDiff.onlyA.length) console.log('  ❌ indexes only in filename-order build:', idxDiff.onlyA.slice(0, 10));
    if (idxDiff.onlyB.length) console.log('  ❌ indexes only in journal-order build:', idxDiff.onlyB.slice(0, 10));
    console.log('\n❌ migration-order parity failed — the harness schema and the prod schema diverge');
    process.exit(1);
  }
  console.log('\n✅ filename-order and journal-order builds produce the identical schema');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
