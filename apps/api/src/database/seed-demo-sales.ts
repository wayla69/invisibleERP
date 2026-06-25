/**
 * Demo sales history for the Oshinei Japanese Buffet tenant.
 *
 * Generates ~45 business days of POS sales (cust_pos_sales + cust_pos_items)
 * so Finance, daily-sales reports and dashboards show realistic numbers.
 * Buffet-heavy mix (it's a buffet restaurant): per-pax package charges plus
 * à-la-carte tickets. Deterministic (seeded PRNG) and idempotent
 * (delete-by-tenant then insert) — safe to re-run.
 *
 * Requires the demo tenant to exist first:
 *   pnpm --filter @ierp/api db:seed:demo
 *   pnpm --filter @ierp/api db:seed:demo:sales
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray, sql } from 'drizzle-orm';
import * as schema from './schema';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try {
    (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p);
  } catch {
    /* ignore */
  }
}

const DAYS = 45;
const VAT = 0.07; // prices are VAT-inclusive (TH)
const STAFF = ['สมชาย', 'นภา', 'ก้อง', 'มินต์', 'ต้าร์', 'ฝน'];
const PAYMENTS: [string, number][] = [['Cash', 0.45], ['Card', 0.25], ['PromptPay', 0.25], ['Wallet', 0.05]];

// deterministic PRNG (mulberry32) so re-runs reproduce the same history
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260625);
const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const weighted = <T,>(opts: [T, number][]) => {
  let r = rnd();
  for (const [v, w] of opts) { if ((r -= w) <= 0) return v; }
  return opts[opts.length - 1][0];
};
const r2 = (x: number) => Math.round(x * 100) / 100;

// last DAYS calendar days ending today (Asia/Bangkok business day)
function recentDays(n: number): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = fmt.format(new Date()); // YYYY-MM-DD
  const out: string[] = [];
  const base = new Date(today + 'T00:00:00Z');
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
const dow = (ymd: string) => new Date(ymd + 'T00:00:00Z').getUTCDay(); // 0=Sun

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

    // menu + buffet pricing (from what the demo seed loaded)
    const items = await tx.select().from(schema.menuItems).where(eq(schema.menuItems.tenantId, T));
    const pkgs = await tx.select().from(schema.buffetPackages).where(eq(schema.buffetPackages.tenantId, T));
    if (!items.length || !pkgs.length) throw new Error('menu/buffet not seeded — run db:seed:demo first');
    const alacarte = items.filter((i) => Number(i.price) > 0);

    // ── wipe prior demo sales (items first — FK) ──
    const prior = await tx.select({ id: schema.custPosSales.id }).from(schema.custPosSales).where(eq(schema.custPosSales.tenantId, T));
    if (prior.length) {
      const ids = prior.map((p) => p.id);
      for (let i = 0; i < ids.length; i += 500)
        await tx.delete(schema.custPosItems).where(inArray(schema.custPosItems.saleId, ids.slice(i, i + 500)));
      await tx.delete(schema.custPosSales).where(eq(schema.custPosSales.tenantId, T));
    }

    // ── generate ──
    type Sale = typeof schema.custPosSales.$inferInsert;
    type Line = Omit<typeof schema.custPosItems.$inferInsert, 'saleId'>;
    const sales: Sale[] = [];
    const linesBySaleNo = new Map<string, Line[]>();

    for (const day of recentDays(DAYS)) {
      const wknd = [5, 6, 0].includes(dow(day));         // Fri/Sat/Sun busier
      const count = wknd ? between(34, 52) : between(18, 30);
      const ymd = day.replace(/-/g, '');
      for (let s = 1; s <= count; s++) {
        const saleNo = `SALE-OSHI-${ymd}-${String(s).padStart(3, '0')}`;
        const lines: Line[] = [];
        if (rnd() < 0.7) {
          // buffet ticket: per-pax package + occasional drink
          const pkg = weighted(pkgs.map((p) => [p, 1 / pkgs.length] as [typeof p, number]));
          const pax = between(1, 6);
          const price = Number(pkg.pricePerPax);
          lines.push({ itemId: pkg.code, itemDescription: pkg.nameEn ?? pkg.name, qty: String(pax), uom: 'ท่าน', unitPrice: String(price), amount: String(r2(pax * price)), discountPct: '0' });
        } else {
          // à-la-carte ticket: 2–5 dishes
          const k = between(2, 5);
          for (let j = 0; j < k; j++) {
            const it = pick(alacarte);
            const qty = between(1, 2);
            const price = Number(it.price);
            lines.push({ itemId: it.sku, itemDescription: it.nameEn ?? it.name, qty: String(qty), uom: 'จาน', unitPrice: String(price), amount: String(r2(qty * price)), discountPct: '0' });
          }
        }
        const subtotal = r2(lines.reduce((a, l) => a + Number(l.amount), 0));
        const tax = r2(subtotal - subtotal / (1 + VAT)); // VAT-inclusive
        sales.push({
          saleNo, saleDate: day, tenantId: T, subtotal: String(subtotal), discount: '0',
          taxAmount: String(tax), total: String(subtotal), currency: 'THB',
          paymentMethod: weighted(PAYMENTS), status: 'Completed', createdBy: pick(STAFF),
        });
        linesBySaleNo.set(saleNo, lines);
      }
    }

    // ── insert (chunked) ──
    const idByNo = new Map<string, number>();
    for (let i = 0; i < sales.length; i += 500) {
      const rows = await tx.insert(schema.custPosSales).values(sales.slice(i, i + 500)).returning({ id: schema.custPosSales.id, saleNo: schema.custPosSales.saleNo });
      for (const r of rows) idByNo.set(r.saleNo, r.id);
    }
    const allLines: (typeof schema.custPosItems.$inferInsert)[] = [];
    for (const [saleNo, ls] of linesBySaleNo) {
      const saleId = idByNo.get(saleNo)!;
      for (const l of ls) allLines.push({ ...l, saleId });
    }
    for (let i = 0; i < allLines.length; i += 800)
      await tx.insert(schema.custPosItems).values(allLines.slice(i, i + 800));

    const revenue = r2(sales.reduce((a, s) => a + Number(s.total), 0));
    console.log(`✅ Demo sales seeded into tenant ${T} (${DAYS} days):`);
    console.log(`   ${sales.length} sales · ${allLines.length} line items · ฿${revenue.toLocaleString()} gross`);
    console.log(`   date range: ${recentDays(DAYS)[0]} → ${recentDays(DAYS)[DAYS - 1]}`);
  });

  await client.end();
}

main().catch((e) => {
  console.error('Demo sales seed failed:', e);
  process.exit(1);
});
