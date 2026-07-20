/**
 * Demo procurement + inventory flow for the Invisible tenant: suppliers (vendors),
 * purchase orders + goods receipts (with stock movements), a posted stocktake,
 * and recipe-usage variance. Deterministic (seeded PRNG), idempotent (rows are
 * tagged created_by/received_by/counted_by = '*-demo' and wiped before re-insert).
 *
 * Requires the demo tenant: `pnpm --filter @ierp/api db:seed:demo`
 * Run: `pnpm --filter @ierp/api db:seed:demo:procurement`
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray, sql } from 'drizzle-orm';
import * as schema from './schema';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try { (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p); } catch { /* ignore */ }
}

const TAG = 'procurement-demo';
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = mulberry32(909090);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const r2 = (x: number) => Math.round(x * 100) / 100;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// vendor → which ingredient-code prefixes it supplies
const VENDORS = [
  { code: 'V-OSH-01', name: 'ตลาดปลาทะเลสด ทรัพย์เจริญ', cat: 'อาหารทะเล', terms: 'Net 7', lead: 1, rating: 4.6, prefixes: ['02', '03-01', '03-02'] },
  { code: 'V-OSH-02', name: 'เนื้อนำเข้าพรีเมียม Wagyu House', cat: 'เนื้อสัตว์', terms: 'Net 15', lead: 3, rating: 4.4, prefixes: ['03-03', '03-04', 'F'] },
  { code: 'V-OSH-03', name: 'ตลาดผักสดเช้า สี่มุมเมือง', cat: 'ผัก/ผลไม้', terms: 'Cash', lead: 1, rating: 4.1, prefixes: ['V', 'VY'] },
  { code: 'V-OSH-04', name: 'ของแห้ง & เครื่องปรุงญี่ปุ่น Yamato', cat: 'ของแห้ง/เครื่องปรุง', terms: 'Net 30', lead: 5, rating: 4.7, prefixes: ['11', 'S', '13', 'CK', '01', '15'] },
  { code: 'V-OSH-05', name: 'ผู้นำเข้าสาเก & เครื่องดื่ม Sakura', cat: 'เครื่องดื่ม', terms: 'Net 30', lead: 7, rating: 4.5, prefixes: ['11-01-017'] },
  { code: 'V-OSH-06', name: 'บรรจุภัณฑ์ & ภาชนะ EcoPack', cat: 'บรรจุภัณฑ์', terms: 'Net 15', lead: 4, rating: 4.0, prefixes: ['PKG'] },
];
const PKG_ITEMS = [
  { itemId: 'PKG-BOX-L', name: 'กล่องใส่อาหารกลับบ้าน L', uom: 'ใบ', price: 4.5 },
  { itemId: 'PKG-BOX-S', name: 'กล่องใส่อาหารกลับบ้าน S', uom: 'ใบ', price: 3.2 },
  { itemId: 'PKG-CHOP', name: 'ตะเกียบไม้หุ้มกระดาษ', uom: 'คู่', price: 0.8 },
  { itemId: 'PKG-BAG', name: 'ถุงหูหิ้วพิมพ์โลโก้', uom: 'ใบ', price: 1.6 },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    const tenant = (await tx.select().from(schema.tenants).where(eq(schema.tenants.code, 'INVISIBLE')))[0];
    if (!tenant) throw new Error('INVISIBLE tenant not found — run db:seed:demo first');
    const T = tenant.id;

    // ingredient catalogue (tenant) + on-hand
    const catalogue = await tx.select().from(schema.customerItems).where(eq(schema.customerItems.tenantId, T));
    const inv = await tx.select().from(schema.customerInventory).where(eq(schema.customerInventory.tenantId, T));
    const onHand = new Map(inv.map((r) => [r.itemId, Number(r.currentStock ?? 0)]));
    if (!catalogue.length) throw new Error('customer_items empty — run db:seed:demo first');

    // ── wipe prior demo rows (FK-safe) ──
    const poIds = (await tx.select({ id: schema.purchaseOrders.id }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.createdBy, TAG))).map((r) => r.id);
    if (poIds.length) for (let i = 0; i < poIds.length; i += 500) await tx.delete(schema.poItems).where(inArray(schema.poItems.poId, poIds.slice(i, i + 500)));
    const grIds = (await tx.select({ id: schema.goodsReceipts.id }).from(schema.goodsReceipts).where(eq(schema.goodsReceipts.receivedBy, TAG))).map((r) => r.id);
    if (grIds.length) for (let i = 0; i < grIds.length; i += 500) await tx.delete(schema.grItems).where(inArray(schema.grItems.grId, grIds.slice(i, i + 500)));
    await tx.delete(schema.goodsReceipts).where(eq(schema.goodsReceipts.receivedBy, TAG));
    await tx.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.createdBy, TAG));
    await tx.delete(schema.stockMovements).where(eq(schema.stockMovements.createdBy, TAG));
    await tx.delete(schema.stocktakes).where(eq(schema.stocktakes.countedBy, TAG));
    await tx.delete(schema.custVariance).where(eq(schema.custVariance.tenantId, T));
    await tx.delete(schema.itemSupplier).where(eq(schema.itemSupplier.tenantId, T)); // before vendors (FK)
    await tx.delete(schema.vendors).where(eq(schema.vendors.tenantId, T));

    // ── vendors ──
    await tx.insert(schema.vendors).values(VENDORS.map((v) => ({
      tenantId: T, vendorCode: v.code, name: v.name, isSupplier: true, category: v.cat,
      paymentTerms: v.terms, leadTimeDays: v.lead, rating: String(v.rating), currency: 'THB',
      active: true, approvalStatus: 'approved', contact: 'ฝ่ายขาย', phone: `02${between(1000000, 9999999)}`,
    })));
    const vendorRows = await tx.select().from(schema.vendors).where(eq(schema.vendors.tenantId, T));
    const vendorByCode = new Map(vendorRows.map((v) => [v.vendorCode, v]));

    // ── item → preferred-supplier link (item_supplier) — feeds the branch-aware replenishment "buy" leg ──
    // Each catalogue ingredient is linked to the vendor whose prefix list claims it (first match = preferred).
    const isRows = catalogue.map((c) => {
      const code = c.itemId ?? '';
      const v = VENDORS.find((vv) => vv.prefixes.some((p) => p !== 'PKG' && code.startsWith(p)));
      const vendor = v ? vendorByCode.get(v.code) : undefined;
      return vendor ? { tenantId: T, itemId: c.itemId, vendorId: vendor.id, unitPrice: c.unitPrice ?? '1', leadTimeDays: v!.lead, preferred: true } : null;
    }).filter((x): x is NonNullable<typeof x> => x != null);
    for (let i = 0; i < isRows.length; i += 500) await tx.insert(schema.itemSupplier).values(isRows.slice(i, i + 500));

    // pool of catalogue items per vendor (by code prefix)
    const poolFor = (prefixes: string[]) =>
      prefixes[0] === 'PKG' ? PKG_ITEMS.map((p) => ({ itemId: p.itemId, itemName: p.name, uom: p.uom, unitPrice: String(p.price) }))
        : catalogue.filter((c) => prefixes.some((p) => (c.itemId ?? '').startsWith(p))).map((c) => ({ itemId: c.itemId!, itemName: c.itemName ?? c.itemId!, uom: c.uom ?? 'กรัม', unitPrice: c.unitPrice ?? '1' }));

    // ── purchase orders + goods receipts + stock movements ──
    const now = Date.now();
    const dayCounter = new Map<string, number>();
    const seqFor = (day: string) => { const n = (dayCounter.get(day) ?? 0) + 1; dayCounter.set(day, n); return n; };
    let poCount = 0, grCount = 0, moveCount = 0, lineCount = 0;
    const statuses: ('Closed' | 'Received' | 'Approved' | 'Pending')[] = ['Closed', 'Closed', 'Closed', 'Received', 'Received', 'Approved', 'Approved', 'Pending'];

    for (let i = 0; i < 16; i++) {
      const v = pick(VENDORS);
      const vendor = vendorByCode.get(v!.code)!;
      const pool = poolFor(v!.prefixes);
      if (!pool.length) continue;
      const poDate = new Date(now - between(1, 30) * 86400000);
      const day = ymd(poDate);
      const poNo = `PO-${day.replace(/-/g, '')}-${String(seqFor(day)).padStart(3, '0')}`;
      const status = statuses[i % statuses.length];
      // lines
      const k = Math.min(between(3, 6), pool.length);
      const chosen = [...pool].sort(() => rnd() - 0.5).slice(0, k);
      const lines = chosen.map((c) => {
        const unit = Number(c.unitPrice) || 1;
        const isPiece = ['ใบ', 'ชิ้น', 'ตัว', 'คู่', 'ฟอง'].includes(c.uom);
        const qty = isPiece ? between(50, 400) : between(5, 40) * 1000; // pieces vs grams/ml
        return { itemId: c.itemId, itemDescription: c.itemName, uom: c.uom, orderQty: qty, unitPrice: r2(unit), amount: r2(qty * unit) };
      });
      const total = r2(lines.reduce((a, l) => a + l.amount, 0));
      const received = status === 'Closed' || status === 'Received';
      const approved = status !== 'Pending';
      const [po] = await tx.insert(schema.purchaseOrders).values({
        poNo, poDate: day, vendorId: vendor.id, vendorName: vendor.name, status,
        approvedBy: approved ? TAG : null, approvedAt: approved ? poDate : null,
        totalAmount: String(total), createdBy: TAG, expectedDate: ymd(new Date(poDate.getTime() + v!.lead * 86400000)),
        remarks: 'จัดซื้อวัตถุดิบประจำสัปดาห์', tenantId: T,
      }).returning({ id: schema.purchaseOrders.id });
      poCount++;
      await tx.insert(schema.poItems).values(lines.map((l) => ({
        poId: po!.id, itemId: l.itemId, itemDescription: l.itemDescription, orderQty: String(l.orderQty),
        unitPrice: String(l.unitPrice), uom: l.uom, amount: String(l.amount),
        receivedQty: String(received ? (status === 'Closed' ? l.orderQty : Math.round(l.orderQty * 0.6)) : 0),
        status: status === 'Closed' ? 'Closed' : received ? 'Partial' : 'Open', tenantId: T,
      })));
      lineCount += lines.length;

      if (received) {
        const grDate = new Date(poDate.getTime() + v!.lead * 86400000);
        const gday = ymd(grDate);
        const grNo = `GR-${gday.replace(/-/g, '')}-${String(seqFor(gday)).padStart(3, '0')}`;
        const [gr] = await tx.insert(schema.goodsReceipts).values({
          grNo, grDate: gday, poNo, vendorId: vendor.id, vendorName: vendor.name, receivedBy: TAG, remarks: 'รับเข้าคลัง WH-MAIN', tenantId: T,
        }).returning({ id: schema.goodsReceipts.id });
        grCount++;
        const recvLines = lines.map((l) => ({ ...l, recv: status === 'Closed' ? l.orderQty : Math.round(l.orderQty * 0.6) }));
        await tx.insert(schema.grItems).values(recvLines.map((l) => ({
          grId: gr!.id, poNo, itemId: l.itemId, itemDescription: l.itemDescription, poQty: String(l.orderQty),
          receivedQty: String(l.recv), uom: l.uom, lotNo: `LOT-${grNo.slice(3)}-${l.itemId}`.slice(0, 40),
          expiryDate: ymd(new Date(grDate.getTime() + between(7, 120) * 86400000)), unitCost: String(l.unitPrice), tenantId: T,
        })));
        await tx.insert(schema.stockMovements).values(recvLines.map((l) => ({
          tenantId: T,
          moveDate: grDate, docNo: grNo, moveType: 'GR' as const, itemId: l.itemId, itemDescription: l.itemDescription,
          uom: l.uom, qty: String(l.recv), fromLocation: 'Supplier', toLocation: 'WH-MAIN', refDoc: poNo,
          remarks: vendor.name, createdBy: TAG,
        })));
        moveCount += recvLines.length;
      }
    }

    // ── stocktake (posted) on ~24 ingredients ──
    const stDay = ymd(new Date(now - 2 * 86400000));
    const stNo = `ST-${stDay.replace(/-/g, '')}-001`;
    const stItems = [...catalogue].sort(() => rnd() - 0.5).slice(0, 24);
    await tx.insert(schema.stocktakes).values(stItems.map((c) => {
      const sysQty = onHand.get(c.itemId!) ?? between(500, 20000);
      const phys = Math.max(0, Math.round(sysQty * (0.93 + rnd() * 0.1))); // ±small shrinkage
      return { tenantId: T, stNo, stDate: stDay, itemId: c.itemId, itemDescription: c.itemName, uom: c.uom ?? 'กรัม',
        systemQty: String(sysQty), physicalQty: String(phys), difference: String(phys - sysQty),
        countedBy: TAG, status: 'Posted' as const, remarks: 'นับสต๊อกประจำเดือน' };
    }));

    // ── recipe-usage variance (tenant) on ~10 high-usage ingredients ──
    const varItems = [...catalogue].sort(() => rnd() - 0.5).slice(0, 10);
    await tx.insert(schema.custVariance).values(varItems.map((c) => {
      const theo = between(2000, 12000);
      const actual = Math.round(theo * (1 + (rnd() * 0.16 - 0.04))); // mostly slight over-use
      const v = actual - theo;
      return { varDate: stDay, tenantId: T, itemId: c.itemId, itemDescription: c.itemName, bomCode: null,
        theoreticalUse: String(theo), actualUse: String(actual), variance: String(v),
        variancePct: String(r2((v / theo) * 100)), uom: c.uom ?? 'กรัม',
        reason: v > 0 ? 'ของเสีย/หั่นทิ้ง' : 'ตวงประหยัด', shift: pick(['Day', 'Night']) };
    }));

    console.log(`✅ Procurement seeded into tenant ${T}:`);
    console.log(`   ${VENDORS.length} vendors · ${isRows.length} item→supplier links · ${poCount} POs (${lineCount} lines) · ${grCount} goods receipts · ${moveCount} stock movements`);
    console.log(`   1 stocktake (${stItems.length} items) · ${varItems.length} variance rows`);
  });
  await client.end();
}

main().catch((e) => { console.error('Procurement seed failed:', e); process.exit(1); });
