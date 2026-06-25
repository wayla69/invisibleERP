/**
 * Sync the app's daily document-number counters (`doc_counters`) past the demo's
 * hand-seeded numbers. The demo seeders insert session/order/PO/GR/stocktake
 * numbers (`TS-`/`DIN-`/`PO-`/`GR-`/`ST-YYYYMMDD-NNN`) directly, but the live app
 * issues the NEXT number atomically from `doc_counters` (DocNumberService.nextDaily).
 * Without this sync the app re-issues `…-001`, which already exists → 409
 * "Resource already exists" when a diner opens a table / staff create an order.
 *
 * Idempotent (sets each counter to GREATEST(current, max-seeded-seq)). Run AFTER
 * the operations + procurement seeders. `db:seed:demo:all` runs it last.
 *
 * Run: `pnpm --filter @ierp/api db:seed:demo:docsync`
 */
import { resolve } from 'node:path';
import postgres from 'postgres';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try { (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p); } catch { /* ignore */ }
}

// prefix → (table, doc-number column) it was seeded into
const SPECS: [string, string, string][] = [
  ['TS', 'table_sessions', 'session_no'],
  ['DIN', 'dine_in_orders', 'order_no'],
  ['PO', 'purchase_orders', 'po_no'],
  ['GR', 'goods_receipts', 'gr_no'],
  ['ST', 'stocktakes', 'st_no'],
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const client = postgres(url, { max: 1 });
  try {
    let total = 0;
    for (const [pfx, tbl, col] of SPECS) {
      // doc numbers are `PFX-YYYYMMDD-NNN` → split_part(_,'-',2)=day, part 3 = seq.
      const rows = await client.unsafe(
        `insert into doc_counters (doc_type, day, n)
         select '${pfx}', split_part(${col}, '-', 2), max(split_part(${col}, '-', 3)::int)
         from ${tbl} where ${col} ~ '^${pfx}-[0-9]{8}-[0-9]+$'
         group by split_part(${col}, '-', 2)
         on conflict (doc_type, day) do update set n = greatest(doc_counters.n, excluded.n)
         returning day, n`,
      );
      const ns = (rows as unknown as Array<{ n: number }>).map((r) => Number(r.n));
      total += rows.length;
      if (ns.length) console.log(`   ${pfx.padEnd(4)} synced ${ns.length} day(s) (latest n=${Math.max(...ns)})`);
    }
    console.log(`✅ doc_counters synced past demo numbers (${total} counters) — the app now issues the next free TS/DIN/PO/GR/ST number.`);
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error('docsync failed:', e); process.exit(1); });
