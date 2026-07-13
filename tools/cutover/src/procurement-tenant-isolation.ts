/**
 * 0387 regression — cross-tenant boundary test for the legacy P2P pipeline (purchase_requests, pr_items,
 * purchase_orders, po_items, goods_receipts, gr_items). These tables predated multi-tenancy and had no
 * tenant_id at all until migration 0387; every company on the platform could see every other company's
 * requisitions/POs/goods-receipts. Proves: T1's PR/PO/GR are invisible to a scoped T2 session, and T1
 * still sees exactly its own docs (per this repo's mandatory Cross-Tenant Boundary Test protocol).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover procurement-tenant-isolation
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pti-secret';
process.env.NODE_ENV = 'test';
// Prod runs TENANCY_MODE=multi-company (see [[multi-company-tenancy-enabled-prod]]) — without this, Admin
// gets the legacy single-company GLOBAL bypass ("HQ sees all"), which would make this boundary test
// meaningless (it'd pass even with a real leak, since bypass skips RLS scoping entirely for both users).
process.env.TENANCY_MODE = 'multi-company';

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
  await db.insert(s.tenants).values([{ code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [t1, t2] = [await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'buyer1', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t1 },
    { username: 'buyer2', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t2 },
  ]).onConflictDoNothing();

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
  const buyer1 = (await inj('POST', '/api/login', undefined, { username: 'buyer1', password: 'admin123' })).json.token as string;
  const buyer2 = (await inj('POST', '/api/login', undefined, { username: 'buyer2', password: 'admin123' })).json.token as string;

  // ── T1 raises a PR, opens a PO, approves it, and receives against it ──
  const prRes = await inj('POST', '/api/procurement/prs', buyer1, {
    remarks: 'T1 test PR', items: [{ item_id: 'ITM-T1', request_qty: 5, uom: 'EA' }],
  });
  ok('T1 creates a PR', /^PR-/.test(prRes.json.pr_no ?? ''), JSON.stringify(prRes.json));

  const poRes = await inj('POST', '/api/procurement/pos', buyer1, {
    vendor_name: 'T1 Test Vendor',
    items: [{ item_id: 'ITM-T1', order_qty: 5, unit_price: 10, uom: 'EA' }],
  });
  ok('T1 creates a PO', /^PO-/.test(poRes.json.po_no ?? ''), JSON.stringify(poRes.json));
  const poNo = poRes.json.po_no as string;

  const approveRes = await inj('PATCH', `/api/procurement/pos/${poNo}/approve`, buyer1, { approve: true });
  ok('T1 approves its own PO', approveRes.json.status === 'Approved', JSON.stringify(approveRes.json));

  const grRes = await inj('POST', '/api/procurement/grs', buyer1, {
    po_no: poNo, items: [{ item_id: 'ITM-T1', received_qty: 5, uom: 'EA' }],
  });
  ok('T1 receives against its own PO', /^GR-/.test(grRes.json.gr_no ?? ''), JSON.stringify(grRes.json));

  // ── T2, scoped to its own tenant via RLS, must see NONE of T1's docs (these list endpoints run no
  // explicit tenant WHERE clause at all — the guarantee is purely the RLS policy from migration 0387) ──
  const t2Prs = await inj('GET', '/api/procurement/prs?limit=200', buyer2);
  ok('T2 sees ZERO of T1\'s PRs', (t2Prs.json.prs ?? []).every((p: any) => p.pr_no !== prRes.json.pr_no), JSON.stringify(t2Prs.json.prs?.map((p: any) => p.pr_no)));

  const t2Pos = await inj('GET', '/api/inventory/purchase-orders?limit=200', buyer2);
  ok('T2 sees ZERO of T1\'s POs', (t2Pos.json.purchase_orders ?? []).every((p: any) => p.PO_No !== poNo), JSON.stringify(t2Pos.json.purchase_orders?.map((p: any) => p.PO_No)));

  const t2Grs = await inj('GET', '/api/procurement/grs?limit=200', buyer2);
  ok('T2 sees ZERO of T1\'s GRs', (t2Grs.json.grs ?? []).every((g: any) => g.gr_no !== grRes.json.gr_no), JSON.stringify(t2Grs.json.grs?.map((g: any) => g.gr_no)));

  // ── T1 still sees exactly its own docs (the fix must not have over-isolated the OWNER's own view) ──
  const t1Prs = await inj('GET', '/api/procurement/prs?limit=200', buyer1);
  ok('T1 still sees its OWN PR', (t1Prs.json.prs ?? []).some((p: any) => p.pr_no === prRes.json.pr_no), JSON.stringify(t1Prs.json.prs?.map((p: any) => p.pr_no)));

  const t1Pos = await inj('GET', '/api/inventory/purchase-orders?limit=200', buyer1);
  ok('T1 still sees its OWN PO', (t1Pos.json.purchase_orders ?? []).some((p: any) => p.PO_No === poNo), JSON.stringify(t1Pos.json.purchase_orders?.map((p: any) => p.PO_No)));

  const t1Grs = await inj('GET', '/api/procurement/grs?limit=200', buyer1);
  ok('T1 still sees its OWN GR', (t1Grs.json.grs ?? []).some((g: any) => g.gr_no === grRes.json.gr_no), JSON.stringify(t1Grs.json.grs?.map((g: any) => g.gr_no)));

  console.log('\n── 0387 — Procurement (PR/PO/GR) cross-tenant isolation ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} checks failed` : `\n✅ All ${checks.length} checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
