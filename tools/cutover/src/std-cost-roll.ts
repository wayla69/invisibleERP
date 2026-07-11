/**
 * INV-4 (control COST-02) — Standard-cost roll / inventory revaluation over PGlite.
 * A preparer proposes a new standard per STD-costed item (snapshotting on-hand); a DISTINCT approver
 * (≠ preparer) approves → the on-hand is revalued at the new standard (Dr/Cr 1200 ↔ 5500), the stored
 * standard rolls forward, and subsequent issues cost at the new standard. Self-approval is blocked (SoD).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover std-cost-roll
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'stdcost-secret';
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
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'prep1', passwordHash: await pw.hash('pw'), role: 'Planner', tenantId: t1 },  // config/receive + PREPARER (masterdata)
    { username: 'appr1', passwordHash: await pw.hash('pw'), role: 'Planner', tenantId: t1 },  // distinct APPROVER (exec)
    { username: 'shop1', passwordHash: await pw.hash('pw'), role: 'Customer', tenantId: t1, customerName: 'T1' }, // portal sale
    { username: 'appr2', passwordHash: await pw.hash('pw'), role: 'Planner', tenantId: t2 },  // RLS — other tenant
  ]).onConflictDoNothing();
  // prep1: config (masterdata), receive (procurement+wh_receive/warehouse), PREPARE (masterdata) AND holds
  // exec so it can HIT the approve endpoint and be blocked by the SoD self-approval check (not the perm gate).
  const grant = async (username: string, perms: string[]) => {
    const uid = Number((await db.select().from(s.users).where(eq(s.users.username, username)))[0].id);
    await db.insert(s.userPermissions).values(perms.map((perm) => ({ userId: uid, perm }))).onConflictDoNothing();
  };
  await grant('prep1', ['dashboard', 'warehouse', 'procurement', 'planner', 'masterdata', 'exec', 'approvals']);
  await grant('appr1', ['dashboard', 'exec', 'planner']);       // approver-only (exec)
  await grant('appr2', ['dashboard', 'exec', 'planner', 'masterdata']);

  for (const it of ['STDROLL', 'STDDROP', 'AVGITEM']) await db.insert(s.items).values({ itemId: it, itemDescription: it, uom: 'EA', unitPrice: '30' }).onConflictDoNothing();
  const [v1] = await db.insert(s.vendors).values({ name: 'V1', isSupplier: true, approvalStatus: 'approved' }).returning({ id: s.vendors.id });
  const V1 = Number(v1.id);
  for (const it of ['STDROLL', 'STDDROP', 'AVGITEM']) await db.insert(s.customerInventory).values({ tenantId: t1, itemId: it, itemDescription: it, uom: 'EA', currentStock: '500', reorderPoint: '10' });

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const admin = await login('admin', 'admin123');
  const prep1 = await login('prep1', 'pw');
  const appr1 = await login('appr1', 'pw');
  const shop1 = await login('shop1', 'pw');
  const appr2 = await login('appr2', 'pw');
  const receive = async (item: string, qty: number, cost: number) => {
    const po = await inj('POST', '/api/procurement/pos', prep1, { vendor_id: V1, items: [{ item_id: item, order_qty: qty, unit_price: cost }] });
    await db.update(s.purchaseOrders).set({ status: 'Approved' }).where(eq(s.purchaseOrders.poNo, po.json.po_no));
    return inj('POST', '/api/procurement/grs', prep1, { po_no: po.json.po_no, items: [{ item_id: item, received_qty: qty, unit_cost: cost }] });
  };
  const sell = (item: string, qty: number) => inj('POST', '/api/portal/pos/sales', shop1, { items: [{ item_id: item, qty, unit_price: 30 }] });
  const glOf = async (src: string, ref: string) => (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='${src}' AND je.source_ref='${ref}'`)).rows as any[];
  const leg = (gl: any[], c: string, side: string) => Number(gl.filter((l) => l.account_code === c).reduce((a, l) => a + Number(l[side] || 0), 0));
  const stdOf = async (item: string) => Number(((await pg.query(`SELECT standard_cost FROM item_costing WHERE tenant_id=${t1} AND item_id='${item}'`)).rows as any[])[0]?.standard_cost);
  const saleNoOf = async (item: string) => ((await pg.query(`SELECT ref_doc FROM cost_movements WHERE item_id='${item}' AND kind='ISSUE' ORDER BY id DESC LIMIT 1`)).rows as any[])[0]?.ref_doc;

  // ── Setup: STD items configured + on-hand built via receipts ──
  await inj('PUT', '/api/costing/config', prep1, { item_id: 'STDROLL', method: 'STD', standard_cost: 10 });
  await inj('PUT', '/api/costing/config', prep1, { item_id: 'STDDROP', method: 'STD', standard_cost: 20 });
  await inj('PUT', '/api/costing/config', prep1, { item_id: 'AVGITEM', method: 'AVG' });
  await receive('STDROLL', 100, 10); // on_hand 100 @ std 10
  await receive('STDDROP', 50, 20);  // on_hand 50 @ std 20
  await receive('AVGITEM', 100, 8);

  // ── A. Revise (maker): propose new std + snapshot on-hand; posts NOTHING ──
  const rev1 = await inj('POST', '/api/costing/std-cost/revise', prep1, { reason: 'Annual roll', lines: [{ item_id: 'STDROLL', new_std: 12 }] });
  const rev1No = rev1.json.rev_no;
  const glPre = await glOf('STDREV', rev1No);
  ok('Revise: STDROLL 10→12 snapshots on-hand 100, impact 200, posts nothing (Draft)',
    rev1.status === 201 && rev1.json.status === 'Draft' && near(rev1.json.revaluation_total, 200) && glPre.length === 0 && (await stdOf('STDROLL')) === 10,
    JSON.stringify({ st: rev1.status, total: rev1.json.revaluation_total, gl: glPre.length, std: await stdOf('STDROLL') }));

  const det = await inj('GET', `/api/costing/std-cost/${rev1No}`, prep1);
  const l0 = (det.json.lines ?? [])[0];
  ok('Detail: proposed vs current — old_std 10, new_std 12, on_hand_snapshot 100, revaluation 200, current_std 10',
    near(l0?.old_std, 10) && near(l0?.new_std, 12) && near(l0?.on_hand_snapshot, 100) && near(l0?.revaluation_amount, 200) && near(l0?.current_std, 10),
    JSON.stringify(l0));

  // ── B. Self-approval blocked (SoD) — prep1 holds exec so it passes the perm gate but is the preparer ──
  const selfApp = await inj('POST', `/api/costing/std-cost/${rev1No}/approve`, prep1);
  ok('Self-approve blocked → 403 SOD_SELF_APPROVAL (preparer ≠ approver), still Draft, std unchanged',
    selfApp.status === 403 && selfApp.json?.error?.code === 'SOD_SELF_APPROVAL' && (await stdOf('STDROLL')) === 10,
    `st=${selfApp.status} code=${selfApp.json?.error?.code}`);

  // ── C. Distinct approver posts a balanced revaluation JE + rolls the standard ──
  const app1 = await inj('POST', `/api/costing/std-cost/${rev1No}/approve`, appr1);
  const gl1 = await glOf('STDREV', rev1No);
  ok('Approve (STDROLL up): Dr 1200 200 / Cr 5500 200, std rolled 10→12, status Approved',
    app1.status === 200 && app1.json.status === 'Approved' && near(leg(gl1, '1200', 'debit'), 200) && near(leg(gl1, '5500', 'credit'), 200) && (await stdOf('STDROLL')) === 12,
    JSON.stringify({ st: app1.status, dr1200: leg(gl1, '1200', 'debit'), cr5500: leg(gl1, '5500', 'credit'), std: await stdOf('STDROLL') }));

  // ── D. Subsequent issue costs at the NEW standard (12, not 10) ──
  const sellR = await sell('STDROLL', 10);
  const sSale = await saleNoOf('STDROLL');
  const glCogs = await glOf('POS-COGS-V', sSale);
  ok('Subsequent issue: sell 10 STDROLL → COGS at new std 12 = 120 (Dr 5000 / Cr 1200)',
    sellR.status < 300 && near(leg(glCogs, '5000', 'debit'), 120) && near(leg(glCogs, '1200', 'credit'), 120),
    JSON.stringify({ st: sellR.status, cogs: leg(glCogs, '5000', 'debit') }));

  // ── E. Negative revaluation (standard drops) — Cr 1200 / Dr 5500 ──
  const rev2 = await inj('POST', '/api/costing/std-cost/revise', prep1, { lines: [{ item_id: 'STDDROP', new_std: 15 }] });
  const rev2No = rev2.json.rev_no;
  ok('Revise STDDROP 20→15: impact = 50×(15−20) = −250 (Draft)', near(rev2.json.revaluation_total, -250), `total=${rev2.json.revaluation_total}`);
  const app2 = await inj('POST', `/api/costing/std-cost/${rev2No}/approve`, appr1);
  const gl2 = await glOf('STDREV', rev2No);
  ok('Approve (STDDROP down): Cr 1200 250 / Dr 5500 250, std rolled 20→15',
    app2.status === 200 && near(leg(gl2, '1200', 'credit'), 250) && near(leg(gl2, '5500', 'debit'), 250) && (await stdOf('STDDROP')) === 15,
    JSON.stringify({ cr1200: leg(gl2, '1200', 'credit'), dr5500: leg(gl2, '5500', 'debit'), std: await stdOf('STDDROP') }));

  // ── F. Guards: non-STD item rejected; re-approve blocked (NOT_DRAFT) ──
  const badItem = await inj('POST', '/api/costing/std-cost/revise', prep1, { lines: [{ item_id: 'AVGITEM', new_std: 9 }] });
  ok('Revise a non-STD (AVG) item → 400 STD_ITEM_REQUIRED', badItem.status === 400 && badItem.json?.error?.code === 'STD_ITEM_REQUIRED', `st=${badItem.status} code=${badItem.json?.error?.code}`);
  const reApp = await inj('POST', `/api/costing/std-cost/${rev1No}/approve`, appr1);
  ok('Re-approving an Approved revision → 409 NOT_DRAFT (idempotent, no double post)', reApp.status === 409 && reApp.json?.error?.code === 'NOT_DRAFT', `st=${reApp.status} code=${reApp.json?.error?.code}`);

  // ── G. RLS — another tenant sees none of T1's revisions ──
  const t2list = await inj('GET', '/api/costing/std-cost', appr2);
  ok('RLS: T2 approver sees 0 of T1 revisions', (t2list.json.revisions ?? []).length === 0, `n=${(t2list.json.revisions ?? []).length}`);
  const t1list = await inj('GET', '/api/costing/std-cost', appr1);
  ok('Register: T1 lists both revisions (STDROLL + STDDROP), both Approved', (t1list.json.revisions ?? []).length === 2 && (t1list.json.revisions ?? []).every((r: any) => r.status === 'Approved'), `n=${(t1list.json.revisions ?? []).length}`);

  // ── H. Trial balance stays balanced after all revaluation postings ──
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('Trial balance balanced after standard-cost revaluations', tb.totals?.balanced === true, JSON.stringify(tb.totals ?? {}));

  console.log('\n── INV-4 (COST-02) — Standard-cost roll / inventory revaluation ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} std-cost-roll checks failed` : `\n✅ All ${checks.length} std-cost-roll checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
