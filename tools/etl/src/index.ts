/**
 * ETL: SQLite (Inventory_Master_DB.sqlite) → PostgreSQL (V2 schema).
 *   prod   : pnpm --filter @ierp/etl start         (ใช้ DATABASE_URL; ต้อง drizzle-kit migrate ก่อน)
 *   validate: pnpm --filter @ierp/etl validate     (PGlite in-memory + --limit; ไม่ต้องมี Postgres)
 * flags: --pglite  --limit <N>
 */
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { runEtl, reconcile, type Sqlite } from './etl';
import * as schema from '../../../apps/api/src/database/schema/index';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try { (process as any).loadEnvFile?.(p); } catch { /* ignore */ }
}

const argv = process.argv.slice(2);
const usePglite = argv.includes('--pglite') || !process.env.DATABASE_URL;
const limitIdx = argv.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : undefined;
const latestSnapshot = argv.includes('--latest');

const SQLITE_PATH =
  process.env.LEGACY_SQLITE_PATH ?? resolve(process.cwd(), '../../../Invisible ERP/Inventory_Master_DB.sqlite');
const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');

const log = (m: string) => console.log(m);

// ── node:sqlite reader ────────────────────────────────────────────────────────
class Lite implements Sqlite {
  private db: any;
  constructor(path: string) {
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(path);
  }
  all(sql: string) { return this.db.prepare(sql).all(); }
  get(sql: string) { return this.db.prepare(sql).get(); }
  *iterate(sql: string): IterableIterator<any> {
    const st = this.db.prepare(sql);
    if (typeof st.iterate === 'function') { yield* st.iterate(); } else { yield* st.all(); }
  }
  count(table: string) { return Number(this.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n); }
  hasTable(table: string) {
    return !!this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  }
  close() { this.db.close(); }
}

async function makeDb(): Promise<{ db: any; close: () => Promise<void> }> {
  if (usePglite) {
    log('Driver: PGlite (in-memory) — applying migration…');
    const { PGlite } = require('@electric-sql/pglite');
    const { drizzle } = require('drizzle-orm/pglite');
    const pg = new PGlite();
    // apply generated migration(s)
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const ddl = readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, '');
      await pg.exec(ddl);
    }
    log(`  applied ${files.length} migration file(s)`);
    return { db: drizzle(pg, { schema }), close: async () => { await pg.close(); } };
  }
  log('Driver: postgres-js (DATABASE_URL) — assumes drizzle-kit migrate already ran');
  const postgres = require('postgres');
  const { drizzle } = require('drizzle-orm/postgres-js');
  const client = postgres(process.env.DATABASE_URL, { max: 5 });
  return { db: drizzle(client, { schema }), close: async () => { await client.end(); } };
}

async function main() {
  if (!existsSync(SQLITE_PATH)) throw new Error(`SQLite not found: ${SQLITE_PATH} (set LEGACY_SQLITE_PATH)`);
  log(`Source SQLite: ${SQLITE_PATH}`);
  log(`Limit: ${limit ?? '(full)'}`);
  const lite = new Lite(SQLITE_PATH);
  const { db, close } = await makeDb();

  const t0 = Date.now();
  const summary = await runEtl(db, lite, { limit, latestSnapshot, log });
  log(`\n── ETL summary (${((Date.now() - t0) / 1000).toFixed(1)}s) ──`);
  console.table(summary);

  log('\n── Reconciliation (source vs target) ──');
  const checks = await reconcile(db, lite, { limit, latestSnapshot });
  for (const ck of checks) {
    log(`  ${ck.ok ? '✅' : '❌'} ${ck.name.padEnd(34)} source=${ck.source}  target=${ck.target}`);
  }
  const failed = checks.filter((c) => !c.ok);
  lite.close();
  await close();

  if (failed.length) {
    log(`\n❌ ${failed.length} reconciliation check(s) failed`);
    process.exit(1);
  }
  log(`\n✅ All ${checks.length} reconciliation checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
