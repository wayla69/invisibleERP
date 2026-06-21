/**
 * Read-parity check (Phase 2): รัน service จริงของ V2 บน PGlite (โหลด latest snapshot จาก SQLite จริง)
 * แล้วเทียบผลกับค่าที่คำนวณตรงจาก SQLite (= สัญญาของ V1).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/parity start
 */
import 'reflect-metadata';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { runEtl, type Sqlite } from '../../etl/src/etl';
// services import จาก dist (compiled — decorators เป็น JS แล้ว เลี่ยงปัญหา esbuild ข้าม package)
import * as schema from '../../../apps/api/dist/database/schema/index';
import { DashboardService } from '../../../apps/api/dist/modules/dashboard/dashboard.service';
import { PosService } from '../../../apps/api/dist/modules/pos/pos.service';
import { FinanceService } from '../../../apps/api/dist/modules/finance/finance.service';
import { InventoryService } from '../../../apps/api/dist/modules/inventory/inventory.service';
import { InventoryRepository } from '../../../apps/api/dist/modules/inventory/inventory.repository';
import { ReportsService } from '../../../apps/api/dist/modules/reports/reports.module';
import { NotificationsService } from '../../../apps/api/dist/modules/notifications/notifications.module';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try { (process as any).loadEnvFile?.(p); } catch { /* ignore */ }
}

const SQLITE_PATH =
  process.env.LEGACY_SQLITE_PATH ?? resolve(process.cwd(), '../../../Invisible ERP/Inventory_Master_DB.sqlite');
const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');

class Lite implements Sqlite {
  private db: any;
  constructor(path: string) { const { DatabaseSync } = require('node:sqlite'); this.db = new DatabaseSync(path); }
  all(sql: string) { return this.db.prepare(sql).all(); }
  get(sql: string) { return this.db.prepare(sql).get(); }
  *iterate(sql: string): IterableIterator<any> {
    const st = this.db.prepare(sql);
    if (typeof st.iterate === 'function') yield* st.iterate(); else yield* st.all();
  }
  count(t: string) { return Number(this.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n); }
  hasTable(t: string) { return !!this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t); }
  close() { this.db.close(); }
}

const checks: { name: string; expected: any; actual: any; ok: boolean }[] = [];
const eq = (name: string, expected: any, actual: any) =>
  checks.push({ name, expected, actual, ok: approxEq(expected, actual) });
function approxEq(a: any, b: any) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.01;
  return a === b;
}

async function main() {
  if (!existsSync(SQLITE_PATH)) throw new Error(`SQLite not found: ${SQLITE_PATH}`);
  const lite = new Lite(SQLITE_PATH);

  const { PGlite } = require('@electric-sql/pglite');
  const { drizzle } = require('drizzle-orm/pglite');
  const pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  }
  const db = drizzle(pg, { schema });

  // โหลด latest snapshot (current stock ตรงกับ V1) + ตารางเล็กทั้งหมด
  await runEtl(db, lite, { latestSnapshot: true, log: () => {} });

  // ── expected จาก SQLite (= สัญญา V1) ──
  const snapCount = Number(lite.get('SELECT COUNT(*) n FROM tbl_raw_inventory WHERE Generate_Date=(SELECT MAX(Generate_Date) FROM tbl_raw_inventory)')?.n ?? 0);
  const lowCount = Number(lite.get('SELECT COUNT(*) n FROM tbl_raw_inventory WHERE Generate_Date=(SELECT MAX(Generate_Date) FROM tbl_raw_inventory) AND AV_QTY <= 0')?.n ?? 0);
  const pos = lite.get(`SELECT COUNT(*) c, COALESCE(SUM(Total),0) s FROM tbl_cust_pos_sales WHERE Status != 'Voided'`) ?? { c: 0, s: 0 };

  // ── actual จาก service จริงของ V2 ──
  const inv = new InventoryService(new InventoryRepository(db as any));
  const stock = await inv.getStock({ low_only: false, limit: 100000 } as any);
  eq('inventory/stock items == latest snapshot rows', snapCount, stock.total);
  eq('inventory/stock low_stock_count', lowCount, stock.low_stock_count);

  const dash = await new DashboardService(db as any).getDashboard();
  eq('dashboard low_stock_count', lowCount, dash.low_stock_count);
  eq('dashboard outstanding_ap (empty AP → 0)', 0, dash.outstanding_ap);

  const reports = await new ReportsService(db as any).stockSummary();
  eq('reports/stock-summary count', snapCount, reports.count);

  const sum = await new PosService(db as any).summary('2000-01-01', '2100-01-01');
  eq('pos/summary total_orders (non-Voided)', Number(pos.c), sum.total_orders);
  eq('pos/summary total_sales (non-Voided)', Number(pos.s), sum.total_sales);

  const kpi = await new FinanceService(db as any).kpi();
  eq('finance/kpi ap_outstanding (empty → 0)', 0, kpi.ap_outstanding);
  eq('finance/kpi ar_outstanding (empty → 0)', 0, kpi.ar_outstanding);

  const notif = await new NotificationsService(db as any).list();
  eq('notifications counts.low_stock', lowCount, notif.counts.low_stock);

  lite.close();
  await pg.close();

  console.log('\n── Read-parity (V2 service vs V1/SQLite contract) ──');
  for (const ck of checks) console.log(`  ${ck.ok ? '✅' : '❌'} ${ck.name.padEnd(46)} expected=${ck.expected}  actual=${ck.actual}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} parity checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} read-parity checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
