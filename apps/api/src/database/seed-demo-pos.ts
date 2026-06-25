/**
 * Demo POS polish for the Oshinei tenant: priced menu modifiers (spice level,
 * extra sauces, toppings, rice) attached to the relevant categories, plus a set
 * of promotion/price rules (happy hour, member %, category discount, BOGO,
 * delivery discount, set price). Idempotent (delete-by-tenant then insert).
 *
 * Requires the demo tenant: `pnpm --filter @ierp/api db:seed:demo`
 * Run: `pnpm --filter @ierp/api db:seed:demo:pos`
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray, sql } from 'drizzle-orm';
import * as schema from './schema';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try { (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p); } catch { /* ignore */ }
}

// modifier groups + options + which category codes they attach to
const GROUPS = [
  { code: 'SPICE', name: 'ระดับความเผ็ด', min: 0, max: 1, required: false, cats: ['YUM', 'SLD', 'SHB', 'SOB', 'DON'],
    options: [['ไม่เผ็ด', 0, true], ['เผ็ดน้อย', 0, false], ['เผ็ดกลาง', 0, false], ['เผ็ดมาก', 0, false]] as [string, number, boolean][] },
  { code: 'SAUCE', name: 'ซอสเพิ่ม', min: 0, max: 3, required: false, cats: ['SUS', 'SAS', 'ROL', 'DON', 'APP'],
    options: [['โชยุ', 0, false], ['ซอสเทอริยากิ', 10, false], ['ซอสปลาไหล', 15, false], ['วาซาบิพิเศษ', 10, false], ['สไปซี่มาโย', 15, false]] as [string, number, boolean][] },
  { code: 'ADDON', name: 'เพิ่มท็อปปิ้ง', min: 0, max: 5, required: false, cats: ['DON', 'ROL', 'SUS', 'SOB'],
    options: [['ไข่ออนเซ็น', 25, false], ['สาหร่ายวากาเมะ', 20, false], ['ไข่กุ้ง (Ebiko)', 40, false], ['แซลมอนเพิ่ม', 59, false], ['ชีสเพิ่ม', 30, false]] as [string, number, boolean][] },
  { code: 'RICE', name: 'ปริมาณข้าว', min: 0, max: 1, required: false, cats: ['DON', 'ROL'],
    options: [['ปกติ', 0, true], ['พิเศษ', 15, false], ['น้อย', 0, false]] as [string, number, boolean][] },
];

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

    const cats = await tx.select().from(schema.menuCategories).where(eq(schema.menuCategories.tenantId, T));
    const catIdByCode = new Map(cats.map((c) => [c.code, c.id]));
    const items = await tx.select().from(schema.menuItems).where(eq(schema.menuItems.tenantId, T));
    const catCodeById = new Map(cats.map((c) => [c.id, c.code]));

    // ── wipe (FK-safe) ──
    const grpIds = (await tx.select({ id: schema.modifierGroups.id }).from(schema.modifierGroups).where(eq(schema.modifierGroups.tenantId, T))).map((g) => g.id);
    if (grpIds.length) for (let i = 0; i < grpIds.length; i += 500) await tx.delete(schema.modifierOptions).where(inArray(schema.modifierOptions.groupId, grpIds.slice(i, i + 500)));
    await tx.delete(schema.menuItemModifierGroups).where(eq(schema.menuItemModifierGroups.tenantId, T));
    await tx.delete(schema.modifierGroups).where(eq(schema.modifierGroups.tenantId, T));
    await tx.delete(schema.priceRules).where(eq(schema.priceRules.tenantId, T));

    // ── modifier groups + options ──
    let optCount = 0, linkCount = 0;
    const groupIdByCode = new Map<string, number>();
    for (let g = 0; g < GROUPS.length; g++) {
      const grp = GROUPS[g];
      const [row] = await tx.insert(schema.modifierGroups).values({
        tenantId: T, code: grp.code, name: grp.name, minSelect: grp.min, maxSelect: grp.max, required: grp.required, sort: g + 1, active: true,
      }).returning({ id: schema.modifierGroups.id });
      groupIdByCode.set(grp.code, row.id);
      await tx.insert(schema.modifierOptions).values(grp.options.map((o, i) => ({
        tenantId: T, groupId: row.id, name: o[0], priceDelta: String(o[1]), isDefault: o[2], sort: i + 1, active: true,
      })));
      optCount += grp.options.length;
    }

    // ── attach groups to items by category ──
    const links: (typeof schema.menuItemModifierGroups.$inferInsert)[] = [];
    for (const it of items) {
      const catCode = it.categoryId != null ? catCodeById.get(it.categoryId) : undefined;
      if (!catCode) continue;
      let sort = 0;
      for (const grp of GROUPS) {
        if (grp.cats.includes(catCode)) links.push({ tenantId: T, menuItemId: it.id, groupId: groupIdByCode.get(grp.code)!, sort: sort++ });
      }
    }
    for (let i = 0; i < links.length; i += 800) await tx.insert(schema.menuItemModifierGroups).values(links.slice(i, i + 800));
    linkCount = links.length;

    // ── promotions / price rules ──
    const susId = catIdByCode.get('SUS'); const rolId = catIdByCode.get('ROL');
    const sobaItem = items.find((i) => catCodeById.get(i.categoryId ?? -1) === 'SOB');
    const rules: (typeof schema.priceRules.$inferInsert)[] = [
      { tenantId: T, name: 'Happy Hour ลด 15% (จ-ศ บ่าย)', scope: 'all', channel: 'dine_in', dow: '1,2,3,4,5', timeStart: '14:00', timeEnd: '17:00', type: 'percent', value: '15', priority: 10, stackable: false, active: true, createdBy: 'pos-demo' },
      { tenantId: T, name: 'ส่วนลดสมาชิก Gold 10%', scope: 'all', channel: 'any', type: 'percent', value: '10', priority: 50, stackable: true, active: true, createdBy: 'pos-demo' },
      { tenantId: T, name: 'ซูชิลด 20% ก่อนปิดร้าน', scope: 'category', targetId: susId != null ? String(susId) : null, channel: 'any', timeStart: '21:00', timeEnd: '22:00', type: 'percent', value: '20', priority: 30, stackable: false, active: true, createdBy: 'pos-demo' },
      { tenantId: T, name: 'มากิ ซื้อ 2 แถม 1', scope: 'category', targetId: rolId != null ? String(rolId) : null, channel: 'any', type: 'bogo', value: '0', minQty: 2, priority: 40, stackable: false, active: true, createdBy: 'pos-demo' },
      { tenantId: T, name: 'เดลิเวอรีลด 50 บาท', scope: 'all', channel: 'delivery', type: 'amount', value: '50', priority: 60, stackable: false, active: true, createdBy: 'pos-demo' },
      ...(sobaItem ? [{ tenantId: T, name: `เซ็ตโซบะราคาพิเศษ (${sobaItem.nameEn ?? sobaItem.name})`, scope: 'item', targetId: sobaItem.sku, channel: 'any' as const, type: 'fixed', value: '199', priority: 70, stackable: false, active: true, createdBy: 'pos-demo' }] : []),
    ];
    await tx.insert(schema.priceRules).values(rules);

    console.log(`✅ POS polish seeded into tenant ${T}:`);
    console.log(`   ${GROUPS.length} modifier groups · ${optCount} options · ${linkCount} item links`);
    console.log(`   ${rules.length} promotion / price rules`);
  });
  await client.end();
}

main().catch((e) => { console.error('POS polish seed failed:', e); process.exit(1); });
