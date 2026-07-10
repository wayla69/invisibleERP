/**
 * Cutover check — Stocktake + Goods Issue/Transfer (gap #3).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover stock-ops
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, and } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { PERMISSIONS, PERM_GROUPS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const grpOf = (k: string) => Object.entries(PERM_GROUPS).find(([, ks]) => (ks as string[]).includes(k))?.[0] ?? null;
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function seed(db: any) {
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k, grp: grpOf(k) }))).onConflictDoNothing();
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((perms as string[]).map((perm) => ({ role: role as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const hq = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0];
  const tOf = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [t1, t2] = [await tOf('T1'), await tOf('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq.id },
    { username: 'wh1', passwordHash: await pw.hash('pw1'), role: 'Warehouse', tenantId: t1 },
    { username: 'wh2', passwordHash: await pw.hash('pw2'), role: 'Warehouse', tenantId: t2 },
  ]).onConflictDoNothing();
  await db.insert(s.items).values([
    { itemId: 'A', itemDescription: 'Apple', uom: 'EA', unitPrice: '10' },
    { itemId: 'B', itemDescription: 'Banana', uom: 'EA', unitPrice: '10' },
  ]).onConflictDoNothing();
}

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  await seed(db);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const inj = async (method: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };

  const token = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token;
  ok('login', !!token);

  // ── Stocktake ── (INV-04 maker-checker: counted_by='floorstaff' so admin = the independent reviewer who posts)
  const st = await inj('POST', '/api/stocktake', token, { remarks: 'cycle', counted_by: 'floorstaff', lines: [{ item_id: 'A', item_description: 'Apple', uom: 'EA', system_qty: 100, physical_qty: 95 }] });
  ok('create stocktake → ST- + 1 variance line', (st.status === 200 || st.status === 201) && /^ST-\d{8}-\d{3}$/.test(st.json.st_no) && st.json.variance_lines === 1, `status=${st.status} no=${st.json.st_no}`);
  const stNo = st.json.st_no;

  const stList = await inj('GET', '/api/stocktake', token);
  ok('list stocktakes includes new doc', stList.status === 200 && stList.json.stocktakes.some((x: any) => x.st_no === stNo));

  const stDet = await inj('GET', `/api/stocktake/${stNo}`, token);
  ok('stocktake detail difference = -5', stDet.status === 200 && stDet.json.lines[0].difference === -5, `diff=${stDet.json.lines?.[0]?.difference}`);

  const post1 = await inj('POST', `/api/stocktake/${stNo}/post`, token);
  ok('post stocktake → Posted + 1 variance movement', (post1.status === 200 || post1.status === 201) && post1.json.status === 'Posted' && post1.json.variance_movements === 1, JSON.stringify(post1.json));
  const post2 = await inj('POST', `/api/stocktake/${stNo}/post`, token);
  ok('re-post is idempotent (already)', post2.json.already === true);

  // INV-04 — variance review maker-checker (SoD R11): the COUNTER may not post/approve their own count.
  const stSelf = await inj('POST', '/api/stocktake', token, { remarks: 'self', counted_by: 'admin', lines: [{ item_id: 'A', uom: 'EA', system_qty: 100, physical_qty: 90 }] });
  const stSelfPost = await inj('POST', `/api/stocktake/${stSelf.json.st_no}/post`, token);
  ok('INV-04: the counter cannot post their own stocktake → 403 SOD_SELF_APPROVAL', stSelfPost.status === 403 && stSelfPost.json.error?.code === 'SOD_SELF_APPROVAL', `${stSelfPost.status} ${stSelfPost.json.error?.code}`);

  const so = await db.select().from(s.stockMovements).where(and(eq(s.stockMovements.refDoc, stNo), eq(s.stockMovements.moveType, 'Stock Out')));
  ok('variance movement Stock Out qty=5', so.length === 1 && Number(so[0].qty) === 5, `n=${so.length} qty=${so[0]?.qty}`);

  // ── Goods issue ──
  const iss = await inj('POST', '/api/inventory/issue', token, { from_location: 'WH-MAIN', ref_doc: 'WO-1', lines: [{ item_id: 'A', uom: 'EA', qty: 3 }] });
  ok('goods issue → MI-', (iss.status === 200 || iss.status === 201) && /^MI-\d{8}-\d{3}$/.test(iss.json.doc_no), `no=${iss.json.doc_no}`);
  const issRow = await db.select().from(s.stockMovements).where(eq(s.stockMovements.docNo, iss.json.doc_no));
  ok('issue stored as negative qty (audit, snapshot untouched)', issRow.length === 1 && Number(issRow[0].qty) === -3, `qty=${issRow[0]?.qty}`);

  // ── Transfer ──
  const trf = await inj('POST', '/api/inventory/transfer', token, { from_location: 'WH-MAIN', to_location: 'WH-2', lines: [{ item_id: 'A', uom: 'EA', qty: 2 }] });
  ok('transfer → TRF-', (trf.status === 200 || trf.status === 201) && /^TRF-\d{14}$/.test(trf.json.doc_no), `no=${trf.json.doc_no}`);
  const sameLoc = await inj('POST', '/api/inventory/transfer', token, { from_location: 'WH-1', to_location: 'WH-1', lines: [{ item_id: 'A', qty: 1 }] });
  ok('transfer same location → 400 SAME_LOCATION', sameLoc.status === 400 && sameLoc.json?.error?.code === 'SAME_LOCATION', `status=${sameLoc.status}`);

  // ── Movement history + snapshot untouched ──
  const mv = await inj('GET', '/api/inventory/movements', token);
  ok('movements history lists Issue+Transfer+Stock Out', mv.status === 200 && ['Issue', 'Transfer', 'Stock Out'].every((t) => mv.json.movements.some((m: any) => m.move_type === t)));
  const snaps = await db.select().from(s.stockSnapshots);
  ok('stock_snapshots untouched by ops (audit model)', snaps.length === 0);

  // ── Perpetual-valued bridge: a TRACKED item (B) flows valued moves + GL through stock-ops ──
  // Item A above is legacy snapshot-only (no valued balance) → its stock-ops moves stayed audit-only
  // (asserted above). Item B is brought under perpetual valuation by a valued goods-receipt.
  await inj('POST', '/api/inventory/receipts', token, { item_id: 'B', item_description: 'Banana', uom: 'EA', qty: 100, unit_cost: 10, ref_type: 'GRN', ref_id: 'GRN-B1' });
  const valB0 = await inj('GET', '/api/inventory/valuation', token);
  ok('tracked item B established by valued receipt (100 @ 10 = 1000)', valB0.json.items?.some((i: any) => i.item_id === 'B' && Number(i.on_hand_qty) === 100 && Number(i.total_value) === 1000));

  // Stocktake B counted 95 → the stock-ops POST also books the valued variance (−5 @ 10 = −50) to GL.
  const stB = await inj('POST', '/api/stocktake', token, { remarks: 'cycle B', counted_by: 'floorstaff', lines: [{ item_id: 'B', uom: 'EA', system_qty: 100, physical_qty: 95 }] });
  const postB = await inj('POST', `/api/stocktake/${stB.json.st_no}/post`, token);
  ok('stocktake post values the variance for the tracked item (valued_lines=1)', postB.json.status === 'Posted' && postB.json.valued_lines === 1, JSON.stringify(postB.json));
  const bRow = (await inj('GET', '/api/inventory/valuation', token)).json.items?.find((i: any) => i.item_id === 'B');
  ok('valued on-hand for B corrected to the count (95 @ 10 = 950)', Number(bRow?.on_hand_qty) === 95 && Number(bRow?.total_value) === 950, `qty=${bRow?.on_hand_qty} val=${bRow?.total_value}`);

  // Goods issue B 3 from WH-MAIN → relieves valued stock + COGS at average (→ 92 @ 10 = 920).
  const issB = await inj('POST', '/api/inventory/issue', token, { from_location: 'WH-MAIN', ref_doc: 'WO-B', lines: [{ item_id: 'B', uom: 'EA', qty: 3 }] });
  ok('goods issue relieves valued stock for the tracked item (valued_lines=1)', issB.json.valued_lines === 1, JSON.stringify(issB.json));

  // Transfer B 2 WH-MAIN→WH-2 → value moves between locations (value-neutral): WH-MAIN 90, WH-2 2.
  const trfB = await inj('POST', '/api/inventory/transfer', token, { from_location: 'WH-MAIN', to_location: 'WH-2', lines: [{ item_id: 'B', uom: 'EA', qty: 2 }] });
  ok('transfer moves value between locations for the tracked item (valued_lines=1)', trfB.json.valued_lines === 1, JSON.stringify(trfB.json));
  const valB3 = (await inj('GET', '/api/inventory/valuation', token)).json;
  const whm = valB3.items?.find((i: any) => i.item_id === 'B' && i.location_id === 'WH-MAIN');
  const wh2 = valB3.items?.find((i: any) => i.item_id === 'B' && i.location_id === 'WH-2');
  ok('B split across locations after transfer (WH-MAIN 90, WH-2 2; total 920 value)', Number(whm?.on_hand_qty) === 90 && Number(wh2?.on_hand_qty) === 2);

  // INV-06 reconciliation: B's sub-ledger value (920) ties to the GL inventory account (valued sources).
  const recB = (await inj('GET', '/api/inventory/reconciliation', token)).json;
  ok('perpetual sub-ledger ties to GL inventory account after the stock-ops bridge (reconciled 920)', Math.abs(Number(recB.sub_ledger_value) - 920) < 0.01 && Math.abs(Number(recB.gl_inventory) - 920) < 0.01 && recB.reconciled === true, `sub=${recB.sub_ledger_value} gl=${recB.gl_inventory} rec=${recB.reconciled}`);

  // ── 0299: stocktakes / stock_movements were NOT tenant-scoped ──
  // Before this fix a tenant could LIST every other tenant's count sheets, READ one by document number,
  // and POST its variance movements. tenant_id + explicit scoping + the canonical RLS policy close it.
  {
    const login2 = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
    const w1 = await login2('wh1', 'pw1');
    const w2 = await login2('wh2', 'pw2');
    const stT1 = await inj('POST', '/api/stocktake', w1, { remarks: 'T1 count', lines: [{ item_id: 'SEC-1', uom: 'EA', system_qty: 10, physical_qty: 8 }] });
    ok('Isolation: T1 creates a stocktake', /^ST-/.test(stT1.json?.st_no ?? ''), JSON.stringify(stT1.json ?? stT1.status));
    const listT2 = await inj('GET', '/api/stocktake', w2);
    ok('Isolation: T2 does NOT see T1 count sheets in the list', !(listT2.json?.stocktakes ?? []).some((x: any) => x.st_no === stT1.json.st_no), JSON.stringify(listT2.json?.count));
    const detailT2 = await inj('GET', `/api/stocktake/${stT1.json.st_no}`, w2);
    ok("Isolation: T2 cannot read T1's stocktake by document number (404)", detailT2.status === 404, String(detailT2.status));
    const postT2 = await inj('POST', `/api/stocktake/${stT1.json.st_no}/post`, w2);
    ok("Isolation: T2 cannot POST T1's variance movements (404)", postT2.status === 404, String(postT2.status));
    const listT1 = await inj('GET', '/api/stocktake', w1);
    ok('Isolation: T1 still sees its own sheet', (listT1.json?.stocktakes ?? []).some((x: any) => x.st_no === stT1.json.st_no), JSON.stringify(listT1.json?.count));
    const movT2 = await inj('GET', '/api/inventory/movements', w2);
    ok('Isolation: movement history is tenant-scoped', (movT2.json?.movements ?? []).length === 0, JSON.stringify((movT2.json?.movements ?? []).length));
  }

  await app.close();
  await pg.close();

  console.log('\n── Stocktake + Goods Issue/Transfer (gap #3, PGlite) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
