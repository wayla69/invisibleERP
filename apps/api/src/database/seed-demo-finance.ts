/**
 * Demo finance depth for the Oshinei tenant. Posts monthly GL journals so the
 * P&L, trial balance and cash-flow statement show a real margin (not just
 * top-line POS revenue):
 *   • Revenue recognition  Dr Bank / Cr Sales (net) / Cr VAT output  (from actual sales)
 *   • COGS                 Dr COGS / Cr Accounts Payable            (~33% food cost)
 *   • Operating expenses   Dr Rent/Salaries/Utilities/Marketing / Cr Bank
 *
 * Entries post directly as status='Posted' (counts in reports) under
 * source='DEMO' so the maker-checker (GL-05) approval is bypassed for the seed.
 * Idempotent: source='DEMO' rows for the tenant are wiped before re-insert.
 *
 * Requires the sales history: `pnpm --filter @ierp/api db:seed:demo:sales`
 * Run: `pnpm --filter @ierp/api db:seed:demo:finance`
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as schema from './schema';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try { (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p); } catch { /* ignore */ }
}

const VAT = 0.07;
const COGS_PCT = 0.33;
const MONTHLY = { rent: 120000, salaries: 280000, utilities: 45000, marketing: 25000 }; // full-month fixed opex
const r2 = (x: number) => Math.round(x * 100) / 100;

const ACCOUNTS: { code: string; name: string; type: 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense' }[] = [
  { code: '1000', name: 'เงินสด (Cash)', type: 'Asset' },
  { code: '1010', name: 'ธนาคาร — กระแสรายวัน (Bank — Current)', type: 'Asset' },
  { code: '2000', name: 'เจ้าหนี้การค้า (Accounts Payable)', type: 'Liability' },
  { code: '2100', name: 'ภาษีขาย (VAT Output Payable)', type: 'Liability' },
  { code: '4000', name: 'รายได้จากการขาย (Sales Revenue)', type: 'Revenue' },
  { code: '5000', name: 'ต้นทุนขาย (COGS)', type: 'Expense' },
  { code: '5210', name: 'ค่าเช่า (Rent)', type: 'Expense' },
  { code: '5220', name: 'ค่าสาธารณูปโภค (Utilities)', type: 'Expense' },
  { code: '5230', name: 'ค่าการตลาด (Marketing & Promotion)', type: 'Expense' },
  { code: '5600', name: 'เงินเดือนและค่าจ้าง (Salaries & Wages)', type: 'Expense' },
];

const daysInMonth = (period: string) => { const [y, m] = period.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    const tenant = (await tx.select().from(schema.tenants).where(eq(schema.tenants.code, 'OSHINEI')))[0];
    if (!tenant) throw new Error('OSHINEI tenant not found — run db:seed:demo first');
    const T = tenant.id;

    // ── chart of accounts (idempotent — never clobbers existing) ──
    await tx.insert(schema.accounts).values(ACCOUNTS.map((a) => ({ code: a.code, name: a.name, type: a.type, currency: 'THB', active: 'true' }))).onConflictDoNothing();

    // ── monthly revenue from actual POS sales ──
    const sales = await tx.select({ d: schema.custPosSales.saleDate, total: schema.custPosSales.total }).from(schema.custPosSales).where(eq(schema.custPosSales.tenantId, T));
    if (!sales.length) throw new Error('no POS sales — run db:seed:demo:sales first');
    const byPeriod = new Map<string, { gross: number; days: Set<string>; lastDate: string }>();
    for (const s of sales) {
      const day = String(s.d);
      const period = day.slice(0, 7);
      const e = byPeriod.get(period) ?? { gross: 0, days: new Set<string>(), lastDate: day };
      e.gross += Number(s.total); e.days.add(day); if (day > e.lastDate) e.lastDate = day;
      byPeriod.set(period, e);
    }

    // ── wipe prior DEMO journals (lines first) ──
    const old = (await tx.select({ id: schema.journalEntries.id }).from(schema.journalEntries).where(and(eq(schema.journalEntries.tenantId, T), eq(schema.journalEntries.source, 'DEMO')))).map((r) => r.id);
    if (old.length) for (let i = 0; i < old.length; i += 500) { const c = old.slice(i, i + 500); await tx.delete(schema.journalLines).where(inArray(schema.journalLines.entryId, c)); }
    await tx.delete(schema.journalEntries).where(and(eq(schema.journalEntries.tenantId, T), eq(schema.journalEntries.source, 'DEMO')));

    // ── post monthly journals ──
    let seq = 0;
    const post = async (date: string, period: string, memo: string, ref: string, lines: { acct: string; dr?: number; cr?: number; memo?: string }[]) => {
      seq++;
      // demo-tagged entry_no so it never collides with real JE-YYYYMMDD-NNN already in the tenant's GL
      const entryNo = `JE-D${T}-${date.replace(/-/g, '')}-${String(seq).padStart(3, '0')}`;
      const [je] = await tx.insert(schema.journalEntries).values({
        entryNo, entryDate: date, period, memo, source: 'DEMO', sourceRef: ref, ledgerCode: null,
        tenantId: T, currency: 'THB', status: 'Posted', createdBy: 'finance-demo',
      }).returning({ id: schema.journalEntries.id });
      await tx.insert(schema.journalLines).values(lines.map((l) => ({
        entryId: je.id, accountCode: l.acct, debit: String(r2(l.dr ?? 0)), credit: String(r2(l.cr ?? 0)),
        currency: 'THB', memo: l.memo ?? memo, tenantId: T,
      })));
    };

    let revTot = 0, cogsTot = 0, opexTot = 0;
    const periods = [...byPeriod.keys()].sort();
    for (const period of periods) {
      const e = byPeriod.get(period)!;
      const date = e.lastDate;
      const gross = r2(e.gross);
      const net = r2(gross / (1 + VAT));
      const vat = r2(gross - net);
      const cogs = r2(net * COGS_PCT);
      const scale = Math.min(1, e.days.size / daysInMonth(period)); // prorate fixed opex to days traded
      const rent = r2(MONTHLY.rent * scale), sal = r2(MONTHLY.salaries * scale), util = r2(MONTHLY.utilities * scale), mkt = r2(MONTHLY.marketing * scale);
      revTot += net; cogsTot += cogs; opexTot += rent + sal + util + mkt;

      await post(date, period, `รับรู้รายได้ขาย ${period}`, `DEMO-REV-${period}`, [
        { acct: '1010', dr: gross, memo: 'เงินเข้าธนาคาร' },
        { acct: '4000', cr: net, memo: 'รายได้สุทธิ' },
        { acct: '2100', cr: vat, memo: 'ภาษีขาย 7%' },
      ]);
      await post(date, period, `ต้นทุนขาย ${period}`, `DEMO-COGS-${period}`, [
        { acct: '5000', dr: cogs }, { acct: '2000', cr: cogs, memo: 'ตั้งเจ้าหนี้วัตถุดิบ' },
      ]);
      await post(date, period, `ค่าเช่า ${period}`, `DEMO-RENT-${period}`, [{ acct: '5210', dr: rent }, { acct: '1010', cr: rent }]);
      await post(date, period, `เงินเดือนพนักงาน ${period}`, `DEMO-SAL-${period}`, [{ acct: '5600', dr: sal }, { acct: '1010', cr: sal }]);
      await post(date, period, `ค่าสาธารณูปโภค ${period}`, `DEMO-UTIL-${period}`, [{ acct: '5220', dr: util }, { acct: '1010', cr: util }]);
      await post(date, period, `ค่าการตลาด ${period}`, `DEMO-MKT-${period}`, [{ acct: '5230', dr: mkt }, { acct: '1010', cr: mkt }]);
    }

    const netProfit = r2(revTot - cogsTot - opexTot);
    console.log(`✅ Finance seeded into tenant ${T} (${periods.length} periods: ${periods.join(', ')}):`);
    console.log(`   ${seq} posted journals · revenue ฿${r2(revTot).toLocaleString()} · COGS ฿${r2(cogsTot).toLocaleString()} · opex ฿${r2(opexTot).toLocaleString()}`);
    console.log(`   → net profit ฿${netProfit.toLocaleString()} (${r2((netProfit / revTot) * 100)}% margin)`);
  });
  // Direct journal inserts bypass LedgerService → rebuild the gl_period_balances snapshot (docs/24 R1-2)
  // so the trial balance (snapshot-backed) reflects the demo books. Same recompute as the 0212 backfill.
  await client.unsafe(`DELETE FROM gl_period_balances`);
  await client.unsafe(`INSERT INTO gl_period_balances (tenant_id, ledger_code, period, cost_center_code, account_code, debit, credit)
    SELECT je.tenant_id, coalesce(je.ledger_code,''), coalesce(je.period,''), coalesce(jl.cost_center_code,''), jl.account_code, coalesce(sum(jl.debit),0), coalesce(sum(jl.credit),0)
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE je.status = 'Posted'
    GROUP BY 1,2,3,4,5`);
  await client.end();
}

main().catch((e) => { console.error('Finance seed failed:', e); process.exit(1); });
