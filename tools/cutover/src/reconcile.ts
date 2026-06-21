/**
 * Cutover reconcile gate — เทียบ SQLite ต้นทาง กับ Postgres ปลายทาง (live) ก่อนสลับ traffic.
 * exit 0 = ผ่านทุก check, exit 1 = ไม่ผ่าน (บล็อก cutover). ใช้ postgres-js ต่อ DATABASE_URL จริง.
 *   NODE_OPTIONS=--experimental-sqlite DATABASE_URL=postgres://... LEGACY_SQLITE_PATH=... \
 *     pnpm --filter @ierp/cutover reconcile
 */
import 'reflect-metadata';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../../apps/api/dist/database/schema/index';
import { reconcile, type Sqlite } from '../../etl/src/etl';

const SQLITE_PATH = process.env.LEGACY_SQLITE_PATH ?? resolve(process.cwd(), '../../../Invisible ERP/Inventory_Master_DB.sqlite');

class Lite implements Sqlite {
  private db: any;
  constructor(path: string) { const { DatabaseSync } = require('node:sqlite'); this.db = new DatabaseSync(path); }
  all(sql: string) { return this.db.prepare(sql).all(); }
  get(sql: string) { return this.db.prepare(sql).get(); }
  *iterate(sql: string): IterableIterator<any> { const st = this.db.prepare(sql); if (typeof st.iterate === 'function') yield* st.iterate(); else yield* st.all(); }
  count(t: string) { return Number(this.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n); }
  hasTable(t: string) { return !!this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t); }
  close() { this.db.close(); }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required (target Postgres)');
  if (!existsSync(SQLITE_PATH)) throw new Error(`SQLite not found: ${SQLITE_PATH}`);
  const lite = new Lite(SQLITE_PATH);
  const client = postgres(url, { max: 2 });
  const db = drizzle(client, { schema });

  const checks = await reconcile(db, lite, {}); // full (ไม่ใส่ limit/latest = เทียบทั้งหมด)
  console.log('── Cutover reconcile (SQLite source vs Postgres target) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name.padEnd(34)} source=${c.source}  target=${c.target}`);
  lite.close();
  await client.end();
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ GATE FAILED: ${failed.length}/${checks.length} — อย่า cutover`); process.exit(1); }
  console.log(`\n✅ GATE PASSED: ${checks.length}/${checks.length} — พร้อม cutover`);
}
main().catch((e) => { console.error(e); process.exit(1); });
