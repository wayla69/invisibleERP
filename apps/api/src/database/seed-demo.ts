/**
 * Demo seed — "Oshinei Japanese Buffet" restaurant tenant.
 *
 * Builds a full, self-contained demo tenant from the OSHINEI BoM workbook
 * (apps/api/src/database/demo/oshinei-buffet.json — generated from
 * OSHINEI_BOM_Workbook.xlsx): menu catalogue, buffet tiers + eligibility,
 * recipes/BoM, ingredient master + opening stock, kitchen stations and a
 * floor plan. Idempotent (delete-by-tenant then insert) so it can be re-run.
 *
 * Run:  pnpm --filter @ierp/api db:seed:demo
 *       (reads DATABASE_URL from apps/api/.env or the repo-root .env)
 *
 * The demo login is a NON-Admin, tenant-scoped user (Admin bypasses RLS and
 * would see every tenant) with a broad per-user permission override, so it
 * sees only the Oshinei data across all the restaurant modules.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { PERMISSIONS } from '@ierp/shared';
import * as schema from './schema';
import { PasswordService } from '../modules/auth/password.service';
import { menuImageDataUri } from './demo/menu-image';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try {
    (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p);
  } catch {
    /* ignore */
  }
}

// ── dataset (committed, reviewable) ──────────────────────────────────────────
type Ingredient = { code: string; name: string; uom: string; unitCost: number | null };
type MenuItem = {
  code: string; sku: string; nameEn: string; nameTh: string; catCode: string;
  sale: 'buffet' | 'alacarte'; tiers: number[]; cost: number; price: number;
  station: string; sort: number;
};
type Category = { code: string; nameEn: string; nameTh: string; sort: number };
type RecipeLine = { code: string; name: string; uom: string; qtyPer: number | null; unitCost: number | null };
type Dataset = {
  tenant: { code: string; name: string; nameTh: string };
  buffetTiers: number[];
  categories: Category[];
  ingredients: Ingredient[];
  menuItems: MenuItem[];
  recipes: Record<string, RecipeLine[]>;
};

function loadDataset(): Dataset {
  const candidates = [
    resolve(process.cwd(), 'src/database/demo/oshinei-buffet.json'),
    resolve(__dirname, 'demo/oshinei-buffet.json'),
    resolve(process.cwd(), 'apps/api/src/database/demo/oshinei-buffet.json'),
  ];
  for (const c of candidates) {
    try {
      return JSON.parse(readFileSync(c, 'utf8')) as Dataset;
    } catch {
      /* try next */
    }
  }
  throw new Error('demo dataset not found (oshinei-buffet.json)');
}

// numeric → string (preserve precision for drizzle numeric columns)
const n = (x: number | null | undefined, dflt = '0') => (x == null ? dflt : String(x));

const CAT_COLORS: Record<string, string> = {
  APP: '#f59e0b', DON: '#ef4444', PCK: '#a855f7', ROL: '#10b981', SLD: '#84cc16',
  SAS: '#06b6d4', SHB: '#f97316', SOB: '#8b5cf6', STK: '#dc2626', SUS: '#0ea5e9', YUM: '#ec4899',
};

const STATIONS = [
  { code: 'hot', name: 'ครัวร้อน (Hot Kitchen)', sort: 1, prep: 12 },
  { code: 'cold', name: 'ครัวเย็น (Cold Kitchen)', sort: 2, prep: 8 },
  { code: 'sushi', name: 'ซูชิบาร์ (Sushi Bar)', sort: 3, prep: 10 },
  { code: 'drink', name: 'เครื่องดื่ม (Drinks)', sort: 4, prep: 5 },
];

// item-master category from the ingredient code prefix
function ingCategory(code: string): string {
  const p = code.split('-')[0].toUpperCase();
  if (p === '01') return 'ข้าว (Rice)';
  if (p === '02' || p === '03') return 'เนื้อ/อาหารทะเล (Meat & Seafood)';
  if (p === '11') return 'ซอส/เครื่องปรุง (Sauce & Seasoning)';
  if (p === '13') return 'ของแปรรูป (Prepared)';
  if (p === '15') return 'แช่แข็ง/อื่นๆ (Frozen & Other)';
  if (p === 'CK') return 'ของเตรียมครัว (Kitchen Prep)';
  if (p === 'V' || p === 'VY') return 'ผัก (Vegetable)';
  if (p === 'S') return 'เครื่องปรุง (Seasoning)';
  if (p === 'F') return 'ของสด (Fresh)';
  return 'วัตถุดิบ (Ingredient)';
}

// opening-stock heuristic keyed on the unit of measure
function openingStock(uom: string): { stock: number; rop: number; roq: number } {
  if (uom === 'กรัม' || uom === 'มิลลิลิตร') return { stock: 20000, rop: 5000, roq: 20000 };
  if (['ชิ้น', 'ตัว', 'ใบ', 'ฟอง'].includes(uom)) return { stock: 200, rop: 50, roq: 200 };
  return { stock: 1000, rop: 200, roq: 1000 };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set (copy .env.example → .env)');

  const data = loadDataset();
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });
  const pw = new PasswordService();

  const passwordHash = await pw.hash('oshinei123');

  await db.transaction(async (tx) => {
    // run as a bypass-RLS session so we can write any tenant's rows even when the
    // connection is a non-superuser owner subject to FORCE ROW LEVEL SECURITY.
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);

    // ── permissions master (FK target for user_permissions) ──
    await tx
      .insert(schema.permissions)
      .values(PERMISSIONS.map((key) => ({ key })))
      .onConflictDoNothing();

    // ── 1. tenant (upsert by code) ──
    await tx
      .insert(schema.tenants)
      .values({
        code: data.tenant.code,
        name: data.tenant.name,
        legalName: data.tenant.name,
        province: 'กรุงเทพมหานคร',
        vatRegistered: true,
        vatRate: '0.0700',
        defaultLanguage: 'th',
        tagline: 'Japanese Buffet & Sushi',
      })
      .onConflictDoUpdate({ target: schema.tenants.code, set: { name: data.tenant.name } });
    const tenant = (await tx.select().from(schema.tenants).where(eq(schema.tenants.code, data.tenant.code)))[0];
    const T = tenant.id;
    console.log(`tenant ${data.tenant.code} → id ${T}`);

    // ── 2. demo user (non-Admin, tenant-scoped) + broad permission override ──
    await tx
      .insert(schema.users)
      .values({ username: 'oshinei', passwordHash, role: 'Sales', tenantId: T, mustChangePassword: false })
      .onConflictDoUpdate({
        target: schema.users.username,
        set: { passwordHash, role: 'Sales', tenantId: T, mustChangePassword: false, isActive: true },
      });
    const demoUser = (await tx.select().from(schema.users).where(eq(schema.users.username, 'oshinei')))[0];
    const DEMO_PERMS = [
      'pos', 'dashboard', 'exec', 'order_mgt', 'claim_mgt', 'crm', 'ar', 'creditors', 'delivery',
      'returns', 'pricelist', 'promos', 'warehouse', 'lots', 'locations', 'mobile', 'images',
      'masterdata', 'bom_master', 'procurement', 'planner', 'marketing', 'approvals', 'branch', 'ai_chat', 'users',
    ];
    await tx.delete(schema.userPermissions).where(eq(schema.userPermissions.userId, demoUser.id));
    await tx
      .insert(schema.userPermissions)
      .values(DEMO_PERMS.map((perm) => ({ userId: demoUser.id, perm })))
      .onConflictDoNothing();

    // ── 3. wipe existing demo rows (FK-safe order) so the seed is re-runnable ──
    await tx.delete(schema.menuRecipeLines).where(eq(schema.menuRecipeLines.tenantId, T));
    await tx.delete(schema.menuRecipes).where(eq(schema.menuRecipes.tenantId, T));
    await tx.delete(schema.buffetPackageItems).where(eq(schema.buffetPackageItems.tenantId, T));
    await tx.delete(schema.buffetPackages).where(eq(schema.buffetPackages.tenantId, T));
    await tx.delete(schema.menuItemModifierGroups).where(eq(schema.menuItemModifierGroups.tenantId, T));
    await tx.delete(schema.menuItems).where(eq(schema.menuItems.tenantId, T));
    await tx.delete(schema.menuCategories).where(eq(schema.menuCategories.tenantId, T));
    await tx.delete(schema.customerInventory).where(eq(schema.customerInventory.tenantId, T));
    await tx.delete(schema.customerItems).where(eq(schema.customerItems.tenantId, T));
    await tx.delete(schema.diningTables).where(eq(schema.diningTables.tenantId, T));
    await tx.delete(schema.floorZones).where(eq(schema.floorZones.tenantId, T));
    await tx.delete(schema.kitchenStations).where(eq(schema.kitchenStations.tenantId, T));

    // ── 4. menu categories ──
    await tx.insert(schema.menuCategories).values(
      data.categories.map((c) => ({
        tenantId: T, code: c.code, name: c.nameTh, nameEn: c.nameEn,
        color: CAT_COLORS[c.code] ?? '#64748b', sort: c.sort, active: true,
      })),
    );
    const cats = await tx.select().from(schema.menuCategories).where(eq(schema.menuCategories.tenantId, T));
    const catId = new Map(cats.map((c) => [c.code, c.id]));

    // ── 5. menu items ──
    await tx.insert(schema.menuItems).values(
      data.menuItems.map((m) => ({
        tenantId: T, sku: m.sku, name: m.nameTh, nameEn: m.nameEn,
        categoryId: catId.get(m.catCode) ?? null, type: 'food' as const,
        price: n(m.price), cost: n(m.cost), stationCode: m.station,
        prepMinutes: STATIONS.find((s) => s.code === m.station)?.prep ?? 10,
        trackStock: false, isAvailable: true, sort: m.sort, active: true,
        imageUrl: menuImageDataUri(m.catCode, m.nameEn || m.nameTh),
      })),
    );
    const items = await tx.select().from(schema.menuItems).where(eq(schema.menuItems.tenantId, T));
    const itemId = new Map(items.map((i) => [i.sku, i.id]));

    // ── 6. buffet packages (tiers) + per-item eligibility ──
    await tx.insert(schema.buffetPackages).values(
      data.buffetTiers.map((t) => ({
        tenantId: T, code: `B${t}`, name: `บุฟเฟ่ต์ ${t}.-`, nameEn: `Buffet ${t}`,
        pricePerPax: n(t), timeLimitMin: 90, overtimeFeePerPax: '0', active: true,
      })),
    );
    const pkgs = await tx.select().from(schema.buffetPackages).where(eq(schema.buffetPackages.tenantId, T));
    const pkgId = new Map(pkgs.map((p) => [p.code, p.id]));
    const pkgItems: { tenantId: number; packageId: number; menuItemId: number }[] = [];
    for (const m of data.menuItems) {
      if (m.sale !== 'buffet') continue;
      const mid = itemId.get(m.sku);
      if (!mid) continue;
      for (const t of m.tiers) {
        const pid = pkgId.get(`B${t}`);
        if (pid) pkgItems.push({ tenantId: T, packageId: pid, menuItemId: mid });
      }
    }
    if (pkgItems.length) await tx.insert(schema.buffetPackageItems).values(pkgItems);

    // ── 7. recipes (BoM) ──
    let lineCount = 0;
    for (const m of data.menuItems) {
      const lines = data.recipes[m.code];
      const mid = itemId.get(m.sku);
      if (!mid || !lines?.length) continue;
      const [rec] = await tx
        .insert(schema.menuRecipes)
        .values({
          tenantId: T, menuItemId: mid, sku: m.sku, yieldQty: '1', postCogs: false,
          active: true, notes: 'Imported from OSHINEI BoM workbook', createdBy: 'demo-seed',
        })
        .returning({ id: schema.menuRecipes.id });
      await tx.insert(schema.menuRecipeLines).values(
        lines.map((l) => ({
          tenantId: T, recipeId: rec.id, ingredientItemId: l.code, ingredientDescription: l.name,
          qtyPer: n(l.qtyPer, '0'), uom: l.uom, unitCost: n(l.unitCost, '0'),
        })),
      );
      lineCount += lines.length;
    }

    // ── 8. ingredient master (global items) + tenant catalogue + opening stock ──
    await tx
      .insert(schema.items)
      .values(
        data.ingredients.map((g) => ({
          itemId: g.code, itemDescription: g.name, uom: g.uom, baseUom: g.uom,
          conversionFactor: '1', unitPrice: n(g.unitCost), category: ingCategory(g.code),
        })),
      )
      .onConflictDoNothing();
    await tx.insert(schema.customerItems).values(
      data.ingredients.map((g) => ({
        tenantId: T, itemId: g.code, itemName: g.name, category: ingCategory(g.code),
        unitPrice: n(g.unitCost), uom: g.uom, description: g.name, createdAt: new Date(),
      })),
    );
    await tx.insert(schema.customerInventory).values(
      data.ingredients.map((g) => {
        const s = openingStock(g.uom);
        return {
          tenantId: T, itemId: g.code, itemDescription: g.name, uom: g.uom,
          currentStock: n(s.stock), reorderPoint: n(s.rop), reorderQty: n(s.roq),
          lastUpdated: new Date(), notes: 'opening stock (demo)',
        };
      }),
    );

    // ── 9. kitchen stations ──
    await tx.insert(schema.kitchenStations).values(
      STATIONS.map((s) => ({ tenantId: T, code: s.code, name: s.name, sort: s.sort, defaultPrepMinutes: s.prep, active: true })),
    );

    // ── 10. floor plan: zones + tables ──
    const zoneDefs = [
      { name: 'โซนหลัก (Main Hall)', sortOrder: 1, posX: '16', posY: '16', width: '380', height: '260', color: null as string | null },
      { name: 'ห้องวีไอพี (VIP Room)', sortOrder: 2, posX: '412', posY: '16', width: '240', height: '200', color: '#d4af37' },
      { name: 'ระเบียง (Terrace)', sortOrder: 3, posX: '16', posY: '292', width: '380', height: '170', color: '#10b981' },
    ];
    await tx.insert(schema.floorZones).values(zoneDefs.map((z) => ({ tenantId: T, ...z, active: true })));
    const zones = await tx.select().from(schema.floorZones).where(eq(schema.floorZones.tenantId, T));
    const zoneByName = new Map(zones.map((z) => [z.name, z.id]));

    type TblDef = { zone: string; no: string; seats: number; x: number; y: number; shape?: string };
    const tableDefs: TblDef[] = [];
    // Main hall: 8 tables in a 4×2 grid
    let k = 0;
    for (let row = 0; row < 2; row++)
      for (let col = 0; col < 4; col++) {
        k++;
        tableDefs.push({ zone: 'โซนหลัก (Main Hall)', no: `A${k}`, seats: 4, x: 40 + col * 86, y: 60 + row * 110 });
      }
    // VIP: 2 large round tables
    tableDefs.push({ zone: 'ห้องวีไอพี (VIP Room)', no: 'V1', seats: 8, x: 450, y: 60, shape: 'circle' });
    tableDefs.push({ zone: 'ห้องวีไอพี (VIP Room)', no: 'V2', seats: 10, x: 540, y: 150, shape: 'circle' });
    // Terrace: 4 small tables
    for (let col = 0; col < 4; col++)
      tableDefs.push({ zone: 'ระเบียง (Terrace)', no: `P${col + 1}`, seats: 2, x: 40 + col * 86, y: 350 });

    await tx.insert(schema.diningTables).values(
      tableDefs.map((d) => ({
        tenantId: T, zoneId: zoneByName.get(d.zone) ?? null, tableNo: d.no, seats: d.seats,
        shape: d.shape ?? 'rect', posX: String(d.x), posY: String(d.y),
        width: d.shape === 'circle' ? '90' : '70', height: d.shape === 'circle' ? '90' : '70',
        status: 'available' as const, qrToken: randomUUID(), active: true,
      })),
    );

    console.log(`✅ Oshinei demo seeded into tenant ${T}:`);
    console.log(`   ${data.categories.length} categories · ${data.menuItems.length} menu items · ${pkgItems.length} buffet-tier links`);
    console.log(`   ${Object.keys(data.recipes).length} recipes (${lineCount} BoM lines) · ${data.ingredients.length} ingredients`);
    console.log(`   ${STATIONS.length} kitchen stations · ${zoneDefs.length} zones · ${tableDefs.length} tables`);
    console.log(`   login: oshinei / oshinei123  (tenant ${data.tenant.code})`);
  });

  await client.end();
}

main().catch((e) => {
  console.error('Demo seed failed:', e);
  process.exit(1);
});
