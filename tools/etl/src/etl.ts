import { sql as dsql } from 'drizzle-orm';
import { PERMISSIONS, PERM_GROUPS, DEFAULT_ROLE_PERMISSIONS, type Role } from '@ierp/shared';
import * as s from '../../../apps/api/src/database/schema/index';
import * as c from './coerce';

// drizzle db (pglite หรือ postgres-js — API เดียวกัน)
export type Db = any;

export interface Sqlite {
  all(sql: string): any[];
  get(sql: string): any;
  iterate(sql: string): IterableIterator<any>;
  count(table: string): number;
  hasTable(table: string): boolean;
}

type Log = (m: string) => void;

const PERM_SET = new Set<string>(PERMISSIONS as readonly string[]);
const grpOf = (key: string) =>
  Object.entries(PERM_GROUPS).find(([, ks]) => (ks as string[]).includes(key))?.[0] ?? null;

async function targetCount(db: Db, table: any): Promise<number> {
  const r = await db.select({ n: dsql<number>`count(*)` }).from(table);
  return Number(r[0]?.n ?? 0);
}
async function targetSum(db: Db, table: any, col: string): Promise<number> {
  const r = await db.select({ n: dsql<string>`coalesce(sum(${dsql.raw(col)}),0)` }).from(table);
  return Number(r[0]?.n ?? 0);
}
async function insertChunked(db: Db, table: any, rows: any[], size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    await db.insert(table).values(rows.slice(i, i + size));
  }
}

export interface EtlSummary {
  tenants: number;
  users: number;
  items: number;
  stockSnapshots: number;
  orders: number;
  orderLines: number;
  custPosSales: number;
  locations: number;
  vendors: number;
}

export async function runEtl(db: Db, lite: Sqlite, opts: { limit?: number; latestSnapshot?: boolean; log: Log }): Promise<EtlSummary> {
  const { log } = opts;

  // ── 1. tenants (รวม Customer_Name + Owner_Customer ทุกแหล่ง) ──────────────
  const names = new Map<string, any>(); // code → detail row (จาก tbl_customers ถ้ามี)
  if (lite.hasTable('tbl_customers')) {
    for (const r of lite.all('SELECT * FROM tbl_customers')) {
      const code = c.str(r.Customer_Name);
      if (code) names.set(code, r);
    }
  }
  const addNames = (table: string, col: string) => {
    if (!lite.hasTable(table)) return;
    for (const r of lite.all(`SELECT DISTINCT "${col}" AS v FROM ${table}`)) {
      const code = c.str(r.v);
      if (code && !names.has(code)) names.set(code, null);
    }
  };
  addNames('tbl_users', 'Customer_Name');
  addNames('tbl_sales_orders', 'Customer_Name');
  addNames('tbl_cust_pos_sales', 'Customer_Name');
  addNames('tbl_customer_inventory', 'Customer_Name');
  addNames('tbl_cust_my_customers', 'Owner_Customer');
  addNames('tbl_cust_my_suppliers', 'Owner_Customer');
  addNames('tbl_cust_my_pos', 'Owner_Customer');

  const tenantRows = [...names.entries()].map(([code, r]) => ({
    code,
    name: r ? c.str(r.Customer_Name) ?? code : code,
    contactName: r ? c.str(r.Contact_Name) : null,
    phone: r ? c.str(r.Phone) : null,
    email: r ? c.str(r.Email) : null,
    taxId: r ? c.str(r.Tax_ID) : null,
    address: r ? c.str(r.Address) : null,
    creditTerm: r ? c.str(r.Credit_Term) : null,
    creditLimit: r ? c.num(r.Credit_Limit) ?? '0' : '0',
    creditHold: r ? c.bool(r.Credit_Hold) : false,
    outstandingAr: r ? c.num(r.Outstanding_AR) ?? '0' : '0',
  }));
  if (tenantRows.length) await insertChunked(db, s.tenants, tenantRows);
  const tenantMap = new Map<string, number>();
  for (const t of await db.select({ id: s.tenants.id, code: s.tenants.code }).from(s.tenants)) {
    tenantMap.set(t.code, Number(t.id));
  }
  log(`tenants: ${tenantRows.length}`);

  // ── 2. permissions / role_permissions / users / user_permissions ──────────
  await db.insert(s.permissions).values(PERMISSIONS.map((key) => ({ key, grp: grpOf(key) }))).onConflictDoNothing();

  const rolePerms: { role: Role; perm: string }[] = [];
  if (lite.hasTable('tbl_role_permissions')) {
    for (const r of lite.all('SELECT * FROM tbl_role_permissions')) {
      const role = c.str(r.Role) as Role | null;
      if (!role) continue;
      for (const perm of c.csv(r.Permissions)) if (PERM_SET.has(perm)) rolePerms.push({ role, perm });
    }
  }
  if (!rolePerms.length) {
    for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
      for (const perm of perms as string[]) rolePerms.push({ role: role as Role, perm });
  }
  if (rolePerms.length) await db.insert(s.rolePermissions).values(rolePerms).onConflictDoNothing();

  let userCount = 0;
  const userPerms: { userId: number; perm: string }[] = [];
  if (lite.hasTable('tbl_users')) {
    for (const r of lite.all('SELECT * FROM tbl_users')) {
      const username = c.str(r.Username);
      if (!username) continue;
      const tenantId = tenantMap.get(c.str(r.Customer_Name) ?? '') ?? null;
      const role = (c.str(r.Role) as Role) || 'Sales';
      const inserted = await db
        .insert(s.users)
        .values({ username, passwordHash: c.str(r.Password_Hash) ?? '', role, tenantId })
        .onConflictDoNothing()
        .returning({ id: s.users.id });
      const uid = Number(inserted[0]?.id);
      userCount++;
      if (uid) for (const perm of c.csv(r.Permissions)) if (PERM_SET.has(perm)) userPerms.push({ userId: uid, perm });
    }
  }
  if (userPerms.length) await db.insert(s.userPermissions).values(userPerms).onConflictDoNothing();
  log(`users: ${userCount} (role_perms ${rolePerms.length}, user_perms ${userPerms.length})`);

  // ── 3. items (distinct จาก raw_inventory + master CSV ถ้ามี) ──────────────
  const itemRows: any[] = [];
  const seenItems = new Set<string>();
  for (const r of lite.all(
    `SELECT Item_ID, Item_Description, UOM, Temperature_Type, BU_ID FROM tbl_raw_inventory GROUP BY Item_ID`,
  )) {
    const itemId = c.str(r.Item_ID);
    if (!itemId || seenItems.has(itemId)) continue;
    seenItems.add(itemId);
    itemRows.push({
      itemId,
      itemDescription: c.str(r.Item_Description),
      uom: c.str(r.UOM),
      temperatureType: c.str(r.Temperature_Type),
      buId: c.str(r.BU_ID),
    });
  }
  if (itemRows.length) await insertChunked(db, s.items, itemRows);
  log(`items: ${itemRows.length}`);

  // ── 4. stock_snapshots (1.48M; stream batch; --limit หรือ latest-snapshot-only) ──
  const snapWhere = opts.latestSnapshot
    ? ' WHERE Generate_Date = (SELECT MAX(Generate_Date) FROM tbl_raw_inventory)'
    : '';
  const limitClause = opts.limit ? ` LIMIT ${opts.limit}` : '';
  let snapBatch: any[] = [];
  let snapTotal = 0;
  const flush = async () => {
    if (snapBatch.length) {
      await db.insert(s.stockSnapshots).values(snapBatch);
      snapTotal += snapBatch.length;
      snapBatch = [];
    }
  };
  for (const r of lite.iterate(
    `SELECT BU_ID, Item_ID, Item_Description, UOM, Generate_Date, Temperature_Type, "Expired Date" AS expiry, AV_QTY, Delivery_QTY, Total_Stock FROM tbl_raw_inventory${snapWhere}${limitClause}`,
  )) {
    const gd = c.ts(r.Generate_Date);
    if (!gd) continue; // generate_date NOT NULL
    snapBatch.push({
      generateDate: gd,
      itemId: c.str(r.Item_ID) ?? '',
      itemDescription: c.str(r.Item_Description),
      uom: c.str(r.UOM),
      temperatureType: c.str(r.Temperature_Type),
      buId: c.str(r.BU_ID),
      expiryDate: c.dstr(r.expiry),
      avQty: c.num(r.AV_QTY),
      deliveryQty: c.int(r.Delivery_QTY),
      totalStock: c.num(r.Total_Stock),
    });
    if (snapBatch.length >= 1000) {
      await flush();
      if (snapTotal % 100000 === 0) log(`  stock_snapshots: ${snapTotal}…`);
    }
  }
  await flush();
  log(`stock_snapshots: ${snapTotal}`);

  // ── 5. locations ──────────────────────────────────────────────────────────
  let locCount = 0;
  if (lite.hasTable('tbl_locations')) {
    const rows = lite.all('SELECT * FROM tbl_locations').map((r) => ({
      locationId: c.str(r.Location_ID) ?? '',
      locationName: c.str(r.Location_Name),
      zone: c.str(r.Zone) ?? 'Main',
      type: c.str(r.Type) ?? 'Storage',
      capacity: c.num(r.Capacity),
      temperature: c.str(r.Temperature) ?? 'Ambient',
      active: r.Active === undefined ? true : c.bool(r.Active),
      notes: c.str(r.Notes),
    })).filter((r) => r.locationId);
    if (rows.length) await db.insert(s.locations).values(rows).onConflictDoNothing();
    locCount = rows.length;
  }
  log(`locations: ${locCount}`);

  // ── 6. loyalty_config (singleton) ─────────────────────────────────────────
  if (lite.hasTable('tbl_loyalty_config')) {
    const r = lite.get('SELECT * FROM tbl_loyalty_config WHERE id=1') ?? lite.get('SELECT * FROM tbl_loyalty_config LIMIT 1');
    if (r) {
      await db.insert(s.loyaltyConfig).values({
        id: 1,
        enabled: c.bool(r.Enabled),
        pointsPerBaht: c.num(r.Points_Per_Baht) ?? '1.0',
        bahtPerPoint: c.num(r.Baht_Per_Point) ?? '0.1',
        minRedeem: c.num(r.Min_Redeem) ?? '100',
        expiryDays: c.int(r.Expiry_Days) ?? 365,
      }).onConflictDoNothing();
    }
  }

  // ── 7. orders (tbl_sales_orders denorm → header + lines + claims) ──────────
  let orderCount = 0;
  let lineCount = 0;
  if (lite.hasTable('tbl_sales_orders')) {
    const all = lite.all('SELECT rowid AS _rid, * FROM tbl_sales_orders ORDER BY Order_No');
    const byOrder = new Map<string, any[]>();
    for (const r of all) {
      const no = c.str(r.Order_No);
      if (!no) continue;
      (byOrder.get(no) ?? byOrder.set(no, []).get(no)!).push(r);
    }
    for (const [orderNo, lines] of byOrder) {
      const h = lines[0];
      const oi = await db.insert(s.orders).values({
        orderNo,
        orderDate: c.dstr(h.Order_Date),
        tenantId: tenantMap.get(c.str(h.Customer_Name) ?? '') ?? null,
        status: pickOrderStatus(lines),
        estimatedDelivery: c.dstr(h.Estimated_Delivery),
        createdBy: null,
      }).onConflictDoNothing().returning({ id: s.orders.id });
      const orderId = Number(oi[0]?.id);
      orderCount++;
      for (const ln of lines) {
        const li = await db.insert(s.orderLines).values({
          orderId,
          itemId: c.str(ln.Item_ID),
          itemDescription: c.str(ln.Item_Description),
          orderQty: c.num(ln.Order_Qty),
          stockUom: c.str(ln.Stock_UOM),
          unitPrice: c.num(ln.Unit_Price),
          totalPrice: c.num(ln.Total_Price),
          status: (c.str(ln.Status) as any) ?? 'Pending',
          receivedQty: c.num(ln.Received_Qty) ?? '0',
        }).returning({ id: s.orderLines.id });
        lineCount++;
        if (c.num(ln.Claimed_Qty) && Number(ln.Claimed_Qty) > 0) {
          await db.insert(s.orderClaims).values({
            orderLineId: Number(li[0]?.id),
            claimedQty: c.num(ln.Claimed_Qty),
            claimReason: c.str(ln.Claim_Reason),
            claimImageKey: c.str(ln.Claim_Image_Path),
            adminStatus: (c.str(ln.Admin_Claim_Status) as any) ?? 'Waiting',
            rejectReason: c.str(ln.Reject_Reason),
          });
        }
      }
    }
  }
  log(`orders: ${orderCount} (lines ${lineCount})`);

  // ── 8. cust_pos_sales + items ─────────────────────────────────────────────
  let posCount = 0;
  if (lite.hasTable('tbl_cust_pos_sales')) {
    for (const r of lite.all('SELECT * FROM tbl_cust_pos_sales')) {
      const saleNo = c.str(r.Sale_No);
      if (!saleNo) continue;
      const si = await db.insert(s.custPosSales).values({
        saleNo,
        saleDate: c.dstr(r.Sale_Date),
        tenantId: tenantMap.get(c.str(r.Customer_Name) ?? '') ?? null,
        subtotal: c.num(r.Subtotal),
        discount: c.num(r.Discount),
        taxAmount: c.num(r.Tax_Amount),
        total: c.num(r.Total),
        paymentMethod: c.str(r.Payment_Method) ?? 'Cash',
        pointsUsed: c.num(r.Points_Used) ?? '0',
        pointsEarned: c.num(r.Points_Earned) ?? '0',
        status: (c.str(r.Status) as any) ?? 'Completed',
        notes: c.str(r.Notes),
        createdBy: c.str(r.Created_By),
      }).onConflictDoNothing().returning({ id: s.custPosSales.id });
      const saleId = Number(si[0]?.id);
      posCount++;
      if (lite.hasTable('tbl_cust_pos_items')) {
        const items = lite.all(`SELECT * FROM tbl_cust_pos_items WHERE Sale_No='${saleNo.replace(/'/g, "''")}'`).map((it) => ({
          saleId,
          itemId: c.str(it.Item_ID),
          itemDescription: c.str(it.Item_Description),
          qty: c.num(it.Qty),
          uom: c.str(it.UOM),
          unitPrice: c.num(it.Unit_Price),
          discountPct: c.num(it.Discount_Pct) ?? '0',
          amount: c.num(it.Amount),
          isCustom: c.bool(it.Is_Custom),
        }));
        if (items.length) await db.insert(s.custPosItems).values(items);
      }
    }
  }
  log(`cust_pos_sales: ${posCount}`);

  // ── 9. vendors (รวม suppliers + creditors) ────────────────────────────────
  let vendorCount = 0;
  const vendorRows: any[] = [];
  if (lite.hasTable('tbl_suppliers')) {
    for (const r of lite.all('SELECT * FROM tbl_suppliers')) {
      const name = c.str(r.Supplier_Name);
      if (!name) continue;
      vendorRows.push({
        vendorCode: c.str(r.Supplier_ID), name, isSupplier: true, isCreditor: false,
        contact: c.str(r.Contact), phone: c.str(r.Phone), email: c.str(r.Email), address: c.str(r.Address),
        paymentTerms: c.str(r.Payment_Terms) ?? 'Cash', leadTimeDays: c.int(r.Lead_Time_Days) ?? 3,
        rating: c.num(r.Rating) ?? '3.0', active: r.Active === undefined ? true : c.bool(r.Active),
      });
    }
  }
  if (lite.hasTable('tbl_creditors')) {
    for (const r of lite.all('SELECT * FROM tbl_creditors')) {
      const name = c.str(r.Creditor_Name);
      if (!name) continue;
      vendorRows.push({
        vendorCode: c.str(r.Creditor_ID), name, isSupplier: false, isCreditor: true,
        contact: c.str(r.Contact_Name), phone: c.str(r.Phone), email: c.str(r.Email), address: c.str(r.Address),
        taxId: c.str(r.Tax_ID), paymentTerms: c.str(r.Payment_Terms) ?? 'Net 30',
        bankName: c.str(r.Bank_Name), bankAccount: c.str(r.Bank_Account),
        creditLimit: c.num(r.Credit_Limit), currency: c.str(r.Currency) ?? 'THB',
        category: c.str(r.Category) ?? 'Supplier', active: r.Active === undefined ? true : c.bool(r.Active),
      });
    }
  }
  if (vendorRows.length) { await insertChunked(db, s.vendors, vendorRows); vendorCount = vendorRows.length; }
  log(`vendors: ${vendorCount}`);

  return {
    tenants: tenantRows.length, users: userCount, items: itemRows.length, stockSnapshots: snapTotal,
    orders: orderCount, orderLines: lineCount, custPosSales: posCount, locations: locCount, vendors: vendorCount,
  };
}

// สถานะ order ระดับ header: ถ้ามี line ใด Claimed → Claimed; ถ้าทุก line Completed → Completed; else line แรก
function pickOrderStatus(lines: any[]): any {
  const set = new Set(lines.map((l) => c.str(l.Status)));
  if (set.has('Claimed')) return 'Claimed';
  if ([...set].every((x) => x === 'Completed')) return 'Completed';
  return (c.str(lines[0].Status) as any) || 'Pending';
}

// ── Reconciliation ──────────────────────────────────────────────────────────
export interface Check { name: string; source: number; target: number; ok: boolean }

export async function reconcile(db: Db, lite: Sqlite, opts: { limit?: number; latestSnapshot?: boolean }): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, source: number, target: number) =>
    checks.push({ name, source, target, ok: Math.abs(source - target) < 0.01 });

  // counts
  const srcDistinct = (table: string, col: string) =>
    lite.hasTable(table) ? Number(lite.get(`SELECT COUNT(DISTINCT "${col}") n FROM ${table}`)?.n ?? 0) : 0;
  const srcCount = (table: string) => (lite.hasTable(table) ? lite.count(table) : 0);

  add('users (count)', srcCount('tbl_users'), await targetCount(db, s.users));
  add('items (distinct Item_ID)', srcDistinct('tbl_raw_inventory', 'Item_ID'), await targetCount(db, s.items));
  add('orders (distinct Order_No)', srcDistinct('tbl_sales_orders', 'Order_No'), await targetCount(db, s.orders));
  add('order_lines (rows)', srcCount('tbl_sales_orders'), await targetCount(db, s.orderLines));
  add('cust_pos_sales (count)', srcCount('tbl_cust_pos_sales'), await targetCount(db, s.custPosSales));
  add('locations (count)', srcCount('tbl_locations'), await targetCount(db, s.locations));

  // stock_snapshots (limit / latest-snapshot aware)
  let srcSnap = 0;
  if (lite.hasTable('tbl_raw_inventory')) {
    srcSnap = opts.latestSnapshot
      ? Number(lite.get('SELECT COUNT(*) n FROM tbl_raw_inventory WHERE Generate_Date=(SELECT MAX(Generate_Date) FROM tbl_raw_inventory)')?.n ?? 0)
      : (opts.limit ?? Number(lite.get('SELECT COUNT(*) n FROM tbl_raw_inventory')?.n ?? 0));
  }
  add('stock_snapshots (rows)', srcSnap, await targetCount(db, s.stockSnapshots));

  // financial sums
  const srcSum = (table: string, col: string) =>
    lite.hasTable(table) ? Number(lite.get(`SELECT COALESCE(SUM("${col}"),0) n FROM ${table}`)?.n ?? 0) : 0;
  add('Σ sales_orders.Total_Price', round2(srcSum('tbl_sales_orders', 'Total_Price')), round2(await targetSum(db, s.orderLines, 'total_price')));
  add('Σ cust_pos_sales.Total', round2(srcSum('tbl_cust_pos_sales', 'Total')), round2(await targetSum(db, s.custPosSales, 'total')));

  return checks;
}

function round2(n: number) { return Math.round(n * 100) / 100; }
