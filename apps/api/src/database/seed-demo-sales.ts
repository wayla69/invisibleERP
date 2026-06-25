/**
 * Demo operations history for the Oshinei Japanese Buffet tenant.
 *
 *  • ~45 business days of POS sales (cust_pos_sales + cust_pos_items) so Finance,
 *    daily-sales reports and dashboards show realistic numbers.
 *  • Dine-in orders + table sessions + KDS tickets for the recent window
 *    (dine_in_orders / table_sessions / dine_in_order_items), linked to each sale
 *    by sale_no, with served KDS lines — i.e. order & kitchen history.
 *  • A handful of LIVE tickets for "now": open sessions, occupied tables and
 *    active KDS items (queued/preparing/ready) so the floor plan and KDS board
 *    show current activity.
 *
 * Buffet-heavy mix. Deterministic (seeded PRNG), idempotent (delete-by-tenant
 * then insert). Requires the demo tenant first: `pnpm --filter @ierp/api db:seed:demo`.
 * Run: `pnpm --filter @ierp/api db:seed:demo:sales`
 */
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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

const DAYS = 45;          // POS revenue history
const DINEIN_DAYS = 14;   // recent days that also get dine-in orders + KDS history
const LIVE_TICKETS = 8;   // open tickets "now" for the floor plan / KDS board
const VAT = 0.07;         // prices are VAT-inclusive (TH)
const STAFF = ['สมชาย', 'นภา', 'ก้อง', 'มินต์', 'ต้าร์', 'ฝน'];
const PAYMENTS: [string, number][] = [['Cash', 0.45], ['Card', 0.25], ['PromptPay', 0.25], ['Wallet', 0.05]];
const LIVE_KDS = ['queued', 'preparing', 'ready', 'new'] as const;

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

function recentDays(n: number): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
  const base = new Date(fmt.format(new Date()) + 'T00:00:00Z');
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(base.getTime() - i * 86400000).toISOString().slice(0, 10));
  return out;
}
const dow = (ymd: string) => new Date(ymd + 'T00:00:00Z').getUTCDay();
const at = (ymd: string, h: number, m: number) => new Date(`${ymd}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+07:00`);
const plusMin = (d: Date, m: number) => new Date(d.getTime() + m * 60000);

type KDish = { itemId: string; name: string; station: string; isBuffet: boolean; pkgId: number | null; price: number };
type Ticket = {
  saleNo: string; day: string; openedAt: Date; tableIdx: number; server: string; pax: number;
  isBuffet: boolean; pkgId: number | null;
  revLines: { itemId: string; desc: string; qty: number; unitPrice: number; amount: number }[];
  dishes: KDish[]; subtotal: number; tax: number; payment: string;
};

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

    const items = await tx.select().from(schema.menuItems).where(eq(schema.menuItems.tenantId, T));
    const pkgs = await tx.select().from(schema.buffetPackages).where(eq(schema.buffetPackages.tenantId, T));
    const tables = await tx.select().from(schema.diningTables).where(eq(schema.diningTables.tenantId, T));
    const stations = await tx.select().from(schema.kitchenStations).where(eq(schema.kitchenStations.tenantId, T));
    const pkgLinks = await tx.select().from(schema.buffetPackageItems).where(eq(schema.buffetPackageItems.tenantId, T));
    if (!items.length || !pkgs.length || !tables.length) throw new Error('menu/buffet/tables not seeded — run db:seed:demo first');

    const stationId = new Map(stations.map((s) => [s.code, s.id]));
    const dishStation = (it: typeof items[number]) => stationId.get(it.stationCode ?? 'hot') ?? stations[0].id;
    const itemById = new Map(items.map((i) => [i.id, i]));
    const alacarte = items.filter((i) => Number(i.price) > 0);
    // buffet dishes eligible per package
    const pkgDishes = new Map<number, typeof items>();
    for (const p of pkgs) pkgDishes.set(p.id, []);
    for (const l of pkgLinks) { const it = itemById.get(l.menuItemId); if (it) pkgDishes.get(l.packageId)?.push(it); }

    // ── wipe prior demo operations (FK-safe order) ──
    await tx.delete(schema.dineInOrderItems).where(eq(schema.dineInOrderItems.tenantId, T));
    await tx.delete(schema.dineInOrders).where(eq(schema.dineInOrders.tenantId, T));
    await tx.delete(schema.tableSessions).where(eq(schema.tableSessions.tenantId, T));
    const prior = await tx.select({ id: schema.custPosSales.id }).from(schema.custPosSales).where(eq(schema.custPosSales.tenantId, T));
    if (prior.length) {
      const ids = prior.map((p) => p.id);
      for (let i = 0; i < ids.length; i += 500)
        await tx.delete(schema.custPosItems).where(inArray(schema.custPosItems.saleId, ids.slice(i, i + 500)));
      await tx.delete(schema.custPosSales).where(eq(schema.custPosSales.tenantId, T));
    }
    await tx.update(schema.diningTables).set({ status: 'available' }).where(eq(schema.diningTables.tenantId, T));

    // ── build tickets ──
    const days = recentDays(DAYS);
    const dineinCutoff = days[days.length - DINEIN_DAYS];
    const tickets: Ticket[] = [];
    const hour = (): [number, number] => {
      const h = weighted([[12, 0.12], [13, 0.12], [18, 0.22], [19, 0.24], [20, 0.18], [21, 0.12]]);
      return [h, between(0, 59)];
    };
    for (const day of days) {
      const wknd = [5, 6, 0].includes(dow(day));
      const count = wknd ? between(34, 52) : between(18, 30);
      const ymd = day.replace(/-/g, '');
      for (let s = 1; s <= count; s++) {
        const [h, m] = hour();
        const isBuffet = rnd() < 0.7;
        const revLines: Ticket['revLines'] = [];
        const dishes: KDish[] = [];
        let pkgId: number | null = null;
        let pax = 1;
        if (isBuffet) {
          const pkg = pick(pkgs); pkgId = pkg.id; pax = between(1, 6);
          const price = Number(pkg.pricePerPax);
          revLines.push({ itemId: pkg.code, desc: pkg.nameEn ?? pkg.name, qty: pax, unitPrice: price, amount: r2(pax * price) });
          const pool = pkgDishes.get(pkg.id)?.length ? pkgDishes.get(pkg.id)! : alacarte;
          const k = between(3, 7);
          for (let j = 0; j < k; j++) { const it = pick(pool); dishes.push({ itemId: it.sku, name: it.nameEn ?? it.name, station: it.stationCode ?? 'hot', isBuffet: true, pkgId: pkg.id, price: 0 }); }
        } else {
          pax = between(1, 4);
          const k = between(2, 5);
          for (let j = 0; j < k; j++) {
            const it = pick(alacarte); const qty = between(1, 2); const price = Number(it.price);
            revLines.push({ itemId: it.sku, desc: it.nameEn ?? it.name, qty, unitPrice: price, amount: r2(qty * price) });
            dishes.push({ itemId: it.sku, name: it.nameEn ?? it.name, station: it.stationCode ?? 'hot', isBuffet: false, pkgId: null, price });
          }
        }
        const subtotal = r2(revLines.reduce((a, l) => a + l.amount, 0));
        tickets.push({
          saleNo: `SALE-OSHI-${ymd}-${String(s).padStart(3, '0')}`, day, openedAt: at(day, h, m),
          tableIdx: between(0, tables.length - 1), server: pick(STAFF), pax, isBuffet, pkgId,
          revLines, dishes, subtotal, tax: r2(subtotal - subtotal / (1 + VAT)), payment: weighted(PAYMENTS),
        });
      }
    }

    // ── insert POS sales (all tickets) ──
    const saleRows = tickets.map((t) => ({
      saleNo: t.saleNo, saleDate: t.day, tenantId: T, subtotal: String(t.subtotal), discount: '0',
      taxAmount: String(t.tax), total: String(t.subtotal), currency: 'THB', paymentMethod: t.payment,
      status: 'Completed' as const, createdBy: t.server,
    }));
    const saleIdByNo = new Map<string, number>();
    for (let i = 0; i < saleRows.length; i += 500) {
      const rows = await tx.insert(schema.custPosSales).values(saleRows.slice(i, i + 500)).returning({ id: schema.custPosSales.id, saleNo: schema.custPosSales.saleNo });
      for (const r of rows) saleIdByNo.set(r.saleNo, r.id);
    }
    const posItems = tickets.flatMap((t) => t.revLines.map((l) => ({
      saleId: saleIdByNo.get(t.saleNo)!, itemId: l.itemId, itemDescription: l.desc, qty: String(l.qty),
      uom: t.isBuffet ? 'ท่าน' : 'จาน', unitPrice: String(l.unitPrice), amount: String(l.amount), discountPct: '0',
    })));
    for (let i = 0; i < posItems.length; i += 800) await tx.insert(schema.custPosItems).values(posItems.slice(i, i + 800));

    // ── dine-in orders + sessions + KDS for the recent window (served history) ──
    const recent = tickets.filter((t) => t.day >= dineinCutoff);
    const dayCounter = new Map<string, number>();
    type OrderIns = typeof schema.dineInOrders.$inferInsert;
    const sessByOrderNo = new Map<string, number>();
    const orderRows: (OrderIns & { _saleNo: string })[] = [];
    const kdsByOrderNo = new Map<string, KDish[]>();
    const orderMeta = new Map<string, { openedAt: Date }>();
    for (const t of recent) {
      const ymd = t.day.replace(/-/g, '');
      const seq = (dayCounter.get(t.day) ?? 0) + 1; dayCounter.set(t.day, seq);
      const orderNo = `DIN-${ymd}-${String(seq).padStart(3, '0')}`;
      const sessionNo = `TS-${ymd}-${String(seq).padStart(3, '0')}`;
      const tbl = tables[t.tableIdx];
      const opened = t.openedAt, fired = plusMin(opened, 2), paid = plusMin(opened, between(45, 75)), closed = plusMin(paid, 3);
      const [sess] = await tx.insert(schema.tableSessions).values({
        tenantId: T, tableId: tbl.id, sessionNo, publicToken: randomUUID(), status: 'closed',
        partySize: t.pax, openedAt: opened, closedAt: closed, openedBy: t.server, saleNo: t.saleNo,
        orderMode: t.isBuffet ? 'buffet' : 'a_la_carte', buffetPackageId: t.pkgId, pax: t.isBuffet ? t.pax : null,
        buffetStartedAt: t.isBuffet ? opened : null, buffetExpiresAt: t.isBuffet ? plusMin(opened, 90) : null,
      }).returning({ id: schema.tableSessions.id });
      sessByOrderNo.set(orderNo, sess.id);
      orderRows.push({
        _saleNo: t.saleNo, orderNo, tenantId: T, tableId: tbl.id, zoneId: tbl.zoneId, sessionId: sess.id,
        status: 'paid', channel: 'dine_in', fulfillmentType: 'dine_in', guestCount: t.pax, server: t.server,
        subtotal: String(t.subtotal), vat: String(t.tax), total: String(t.subtotal), saleNo: t.saleNo,
        openedAt: opened, firedAt: fired, paidAt: paid, closedAt: closed, createdBy: t.server,
      });
      kdsByOrderNo.set(orderNo, t.dishes);
      orderMeta.set(orderNo, { openedAt: opened });
    }
    const orderIdByNo = new Map<string, number>();
    for (let i = 0; i < orderRows.length; i += 400) {
      const rows = await tx.insert(schema.dineInOrders).values(orderRows.slice(i, i + 400).map(({ _saleNo, ...r }) => r)).returning({ id: schema.dineInOrders.id, orderNo: schema.dineInOrders.orderNo });
      for (const r of rows) orderIdByNo.set(r.orderNo, r.id);
    }
    const kdsRows: (typeof schema.dineInOrderItems.$inferInsert)[] = [];
    for (const [orderNo, dishes] of kdsByOrderNo) {
      const oid = orderIdByNo.get(orderNo)!; const opened = orderMeta.get(orderNo)!.openedAt;
      dishes.forEach((d, idx) => {
        const fired = plusMin(opened, 2 + Math.floor(idx / 3) * 6);
        kdsRows.push({
          tenantId: T, orderId: oid, stationId: stationId.get(d.station) ?? stations[0].id, itemId: d.itemId, name: d.name,
          qty: '1', unitPrice: String(d.price), amount: String(d.price), isBuffet: d.isBuffet, buffetPackageId: d.pkgId,
          course: 1 + Math.floor(idx / 3), kdsStatus: 'served', estPrepMinutes: 10,
          firedAt: fired, startedAt: plusMin(fired, 1), readyAt: plusMin(fired, 8), servedAt: plusMin(fired, 11), createdBy: 'pos-demo',
        });
      });
    }
    for (let i = 0; i < kdsRows.length; i += 800) await tx.insert(schema.dineInOrderItems).values(kdsRows.slice(i, i + 800));

    // ── LIVE tickets "now": open sessions, occupied tables, active KDS ──
    const now = new Date();
    const today = recentDays(1)[0];
    const liveTables = [...tables].sort(() => rnd() - 0.5).slice(0, Math.min(LIVE_TICKETS, tables.length));
    let liveSeq = (dayCounter.get(today) ?? 0);
    let liveItems = 0;
    for (const tbl of liveTables) {
      liveSeq++;
      const ymd = today.replace(/-/g, '');
      const orderNo = `DIN-${ymd}-${String(liveSeq).padStart(3, '0')}`;
      const sessionNo = `TS-${ymd}-${String(liveSeq).padStart(3, '0')}`;
      const isBuffet = rnd() < 0.7;
      const pkg = isBuffet ? pick(pkgs) : null;
      const pax = isBuffet ? between(2, 6) : between(1, 4);
      const opened = plusMin(now, -between(5, 40));
      const [sess] = await tx.insert(schema.tableSessions).values({
        tenantId: T, tableId: tbl.id, sessionNo, publicToken: randomUUID(), status: 'open',
        partySize: pax, openedAt: opened, openedBy: pick(STAFF),
        orderMode: isBuffet ? 'buffet' : 'a_la_carte', buffetPackageId: pkg?.id ?? null, pax: isBuffet ? pax : null,
        buffetStartedAt: isBuffet ? opened : null, buffetExpiresAt: isBuffet ? plusMin(opened, 90) : null,
      }).returning({ id: schema.tableSessions.id });
      const pool = isBuffet ? (pkgDishes.get(pkg!.id)?.length ? pkgDishes.get(pkg!.id)! : alacarte) : alacarte;
      const k = between(2, 5);
      const [ord] = await tx.insert(schema.dineInOrders).values({
        tenantId: T, tableId: tbl.id, zoneId: tbl.zoneId, sessionId: sess.id, orderNo,
        status: 'sent_to_kitchen', channel: 'dine_in', fulfillmentType: 'dine_in', guestCount: pax, server: pick(STAFF),
        openedAt: opened, firedAt: plusMin(opened, 1), createdBy: 'pos-demo',
      }).returning({ id: schema.dineInOrders.id });
      const live: (typeof schema.dineInOrderItems.$inferInsert)[] = [];
      for (let j = 0; j < k; j++) {
        const it = pick(pool); const status = LIVE_KDS[j % LIVE_KDS.length];
        const fired = status === 'new' ? null : plusMin(opened, 1);
        live.push({
          tenantId: T, orderId: ord.id, stationId: dishStation(it), itemId: it.sku, name: it.nameEn ?? it.name,
          qty: '1', unitPrice: isBuffet ? '0' : String(it.price), amount: isBuffet ? '0' : String(it.price),
          isBuffet, buffetPackageId: pkg?.id ?? null, course: 1, kdsStatus: status, estPrepMinutes: 10,
          firedAt: fired, startedAt: status === 'preparing' || status === 'ready' ? plusMin(opened, 2) : null,
          readyAt: status === 'ready' ? plusMin(opened, 4) : null, createdBy: 'pos-demo',
        });
      }
      await tx.insert(schema.dineInOrderItems).values(live);
      liveItems += live.length;
      await tx.update(schema.diningTables).set({ status: 'occupied' }).where(eq(schema.diningTables.id, tbl.id));
    }

    const revenue = r2(tickets.reduce((a, t) => a + t.subtotal, 0));
    console.log(`✅ Demo operations seeded into tenant ${T}:`);
    console.log(`   POS: ${tickets.length} sales · ${posItems.length} lines · ฿${revenue.toLocaleString()} gross (${DAYS} days)`);
    console.log(`   Dine-in history: ${orderRows.length} orders · ${kdsRows.length} served KDS lines (last ${DINEIN_DAYS} days)`);
    console.log(`   LIVE now: ${liveTables.length} open tickets · ${liveItems} active KDS items · ${liveTables.length} tables occupied`);
  });

  await client.end();
}

main().catch((e) => {
  console.error('Demo sales seed failed:', e);
  process.exit(1);
});
