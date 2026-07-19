/**
 * docs/52 Phase 2b — product variants / matrix items. A parent item's size×color matrix is generated into
 * real child `items` rows (own SKU / barcode / price / stock) linked by parent_item_id, with attribute rows;
 * a variant barcode resolves via the catalog scan-to-add. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover item-variants
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'iv-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'SHOP', name: 'ร้านเสื้อผ้า', industry: 'retail' }]).onConflictDoNothing();
  const t = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'SHOP')))[0].id);
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: t },
    { username: 'cashier', passwordHash: await pw.hash('pw1'), role: 'Cashier', tenantId: t },
  ]).onConflictDoNothing();
  // parent matrix item (a T-shirt) in the shared items master.
  await db.insert(s.items).values({ itemId: 'TSHIRT', itemDescription: 'เสื้อยืด', supplyType: 'goods', uom: 'ตัว', unitPrice: '300' }).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'pw1' })).json.token as string;
  const admin = await login('admin');

  // ── 1. generate the Size×Color matrix (2×2 = 4 variants), with a barcode on one cell ──
  const gen = await inj('POST', '/api/item-setup/items/TSHIRT/variants', admin, {
    axes: [{ axis: 'Size', values: ['S', 'M'] }, { axis: 'Color', values: ['Red', 'Blue'] }],
    barcodes: { 'TSHIRT-S-RED': '8850001234567' },
  });
  const skus = (gen.json.variants ?? []).map((v: any) => v.item_id).sort();
  ok('generate: 4 variant SKUs created (TSHIRT-{S,M}-{RED,BLUE}), parent flagged matrix',
    (gen.status === 200 || gen.status === 201) && gen.json.generated === 4 && gen.json.count === 4 && gen.json.is_matrix_parent === true &&
    JSON.stringify(skus) === JSON.stringify(['TSHIRT-M-BLUE', 'TSHIRT-M-RED', 'TSHIRT-S-BLUE', 'TSHIRT-S-RED']),
    JSON.stringify({ s: gen.status, gen: gen.json.generated, skus }));

  // ── 2. each variant is a real items row linked to the parent, with its attributes + inherited price ──
  const parentId = Number((await db.select().from(s.items).where(eq(s.items.itemId, 'TSHIRT')))[0].id);
  const children = await db.select().from(s.items).where(eq(s.items.parentItemId, parentId));
  const attrs = (await pg.query(`SELECT item_id, axis, value FROM item_variant_attributes WHERE item_id='TSHIRT-S-RED' ORDER BY axis`)).rows as any[];
  ok('variants are real items rows: 4 children link parent_item_id, price inherits 300, attributes Size=S/Color=Red',
    children.length === 4 && children.every((c: any) => Number(c.unitPrice) === 300 && c.supplyType === 'goods') &&
    attrs.length === 2 && attrs.some((a) => a.axis === 'Size' && a.value === 'S') && attrs.some((a) => a.axis === 'Color' && a.value === 'Red'),
    JSON.stringify({ children: children.length, attrs }));

  // ── 3. GET variants lists them with attributes ──
  const list = await inj('GET', '/api/item-setup/items/TSHIRT/variants', admin);
  ok('GET variants: lists 4 with attributes', list.json.count === 4 && (list.json.variants ?? []).every((v: any) => (v.attributes ?? []).length === 2), JSON.stringify({ count: list.json.count }));

  // ── 4. idempotent re-generate: adding a colour only creates the NEW cells ──
  const gen2 = await inj('POST', '/api/item-setup/items/TSHIRT/variants', admin, { axes: [{ axis: 'Size', values: ['S', 'M'] }, { axis: 'Color', values: ['Red', 'Blue', 'Green'] }] });
  ok('idempotent: re-generate with +Green adds only 2 new SKUs (now 6 total)', gen2.json.generated === 2 && gen2.json.count === 6, JSON.stringify({ gen: gen2.json.generated, count: gen2.json.count }));

  // ── 5. a variant barcode resolves via the catalog scan-to-add ──
  const scan = await inj('GET', '/api/procurement/catalog?barcode=8850001234567', admin);
  ok('scan a variant barcode → catalog resolves the exact variant SKU (TSHIRT-S-RED)',
    scan.status === 200 && JSON.stringify(scan.json).includes('TSHIRT-S-RED'),
    JSON.stringify(scan.json).slice(0, 120));

  // ── 6. permission: a non-setup role cannot generate variants ──
  const noPerm = await inj('POST', '/api/item-setup/items/TSHIRT/variants', await login('cashier'), { axes: [{ axis: 'Size', values: ['XL'] }] });
  ok('non-setup role (Cashier) → 403', noPerm.status === 403, `${noPerm.status}`);

  // ── 7. no axes → 400 NO_AXES ──
  const bad = await inj('POST', '/api/item-setup/items/TSHIRT/variants', admin, { axes: [] });
  ok('empty axes → 400', bad.status === 400, `${bad.status}`);

  await app.close();
  await pg.close();
  console.log('\n── docs/52 Phase 2b — product variants / matrix items (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} item-variants checks failed` : `\n✅ All ${checks.length} item-variants checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
