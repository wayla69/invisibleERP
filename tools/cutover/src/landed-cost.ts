/**
 * INV-1 — Landed-cost allocation (COST-01) over PGlite. A landed-cost voucher attaches freight/duty/
 * insurance/broker charges to posted goods receipts and apportions them into inventory unit cost
 * (basis value/qty/weight). Posting capitalises the on-hand share into the perpetual sub-ledger
 * (Dr 1200 / raises moving-avg + FIFO layers), expenses the already-issued residual to costing variance
 * (Dr 5500, mirroring PPV), and credits the landed-cost accrual liability (2010). Post is maker-checker
 * (poster ≠ preparer). Future issues carry the loaded cost; the sub-ledger stays reconciled to GL 1200.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover landed-cost
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'lc-secret';
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
    { username: 'prep1', passwordHash: await pw.hash('pw'), role: 'Planner', tenantId: t1 },   // receives stock + prepares vouchers (+ gl_post, to prove self-post is blocked)
    { username: 'appr1', passwordHash: await pw.hash('pw'), role: 'Planner', tenantId: t1 },   // GL approver — posts vouchers
    { username: 'shop2', passwordHash: await pw.hash('pw'), role: 'Customer', tenantId: t2, customerName: 'T2' }, // RLS
  ]).onConflictDoNothing();
  const grantPerms = async (username: string, perms: string[]) => {
    const uid = Number((await db.select().from(s.users).where(eq(s.users.username, username)))[0].id);
    await db.insert(s.userPermissions).values(perms.map((perm) => ({ userId: uid, perm }))).onConflictDoNothing();
  };
  // prep1 bundles receiving + prep + gl_post ON PURPOSE so we can prove the in-app maker-checker (not the
  // permission) blocks a self-post. appr1 is a distinct GL approver.
  await grantPerms('prep1', ['wh_receive', 'wh_custody', 'wh_count', 'procurement', 'gl_post']);
  await grantPerms('appr1', ['gl_post', 'exec', 'wh_count']);
  for (const it of ['FRT-A', 'FRT-B', 'FRT-C', 'FRT-D'])
    await db.insert(s.items).values({ itemId: it, itemDescription: it, uom: 'EA', unitPrice: '30' }).onConflictDoNothing();

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
  const shop2 = await login('shop2', 'pw');

  const glOf = async (src: string, ref: string) => (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='${src}' AND je.source_ref='${ref}'`)).rows as any[];
  const leg = (gl: any[], c: string, side: string) => Number(gl.filter((l) => l.account_code === c).reduce((a, l) => a + Number(l[side] || 0), 0));
  const receive = (item: string, qty: number, cost: number, method?: string) => inj('POST', '/api/inventory/receipts', prep1, { item_id: item, qty, unit_cost: cost, costing_method: method });
  const issue = (item: string, qty: number) => inj('POST', '/api/inventory/issues', prep1, { item_id: item, qty });

  // ── A. Seed perpetual stock (moving-avg): FRT-A 100@10, FRT-B 100@20 ──
  await receive('FRT-A', 100, 10);
  await receive('FRT-B', 100, 20);

  // ── B. Create a value-basis voucher: freight 300 across FRT-A (base 1000) + FRT-B (base 2000) ──
  const created = await inj('POST', '/api/costing/landed-cost', prep1, {
    basis: 'value', charges: { freight: 300 },
    lines: [{ item_id: 'FRT-A', qty: 100 }, { item_id: 'FRT-B', qty: 100 }],
  });
  const lcv = created.json?.voucher?.voucher_no as string;
  ok('Create: voucher persisted Draft with total_charges 300 + 2 allocation lines', created.status === 201 && created.json?.voucher?.status === 'Draft' && near(created.json?.voucher?.total_charges, 300) && (created.json?.allocations ?? []).length === 2, `st=${created.status} no=${lcv}`);

  // ── C. Allocate preview sums to 100% (value basis: 100 / 200) ──
  const prev = await inj('POST', `/api/costing/landed-cost/${lcv}/allocate`, prep1);
  const aA = (prev.json?.lines ?? []).find((l: any) => l.item_id === 'FRT-A')?.alloc_amount;
  const aB = (prev.json?.lines ?? []).find((l: any) => l.item_id === 'FRT-B')?.alloc_amount;
  ok('Allocate preview: FRT-A 100 + FRT-B 200 = 300, ties to total (100%)', near(aA, 100) && near(aB, 200) && near(prev.json?.allocated, 300) && prev.json?.ties === true, `A=${aA} B=${aB} sum=${prev.json?.allocated}`);

  // ── D. Self-post blocked (maker-checker), then a distinct approver posts ──
  const selfPost = await inj('POST', `/api/costing/landed-cost/${lcv}/post`, prep1);
  ok('Maker-checker: preparer self-post rejected → 403 SOD_SELF_APPROVAL', selfPost.status === 403 && selfPost.json?.error?.code === 'SOD_SELF_APPROVAL', `st=${selfPost.status} code=${selfPost.json?.error?.code}`);
  const posted = await inj('POST', `/api/costing/landed-cost/${lcv}/post`, appr1);
  const glLcv = await glOf('INV-LC', lcv);
  ok('Post books balanced Dr1200=300 / Cr2010=300 (all on hand → no variance)', posted.status === 200 && near(leg(glLcv, '1200', 'debit'), 300) && near(leg(glLcv, '2010', 'credit'), 300) && near(leg(glLcv, '5500', 'debit'), 0), JSON.stringify({ st: posted.status, cap: posted.json?.capitalized_total, var: posted.json?.variance_total }));

  // ── E. Future issue carries the loaded cost (FRT-A avg 10 → 11 after +100 landed) ──
  const balA = (await pg.query(`SELECT avg_cost, total_value FROM inv_balances WHERE tenant_id=${t1} AND item_id='FRT-A'`)).rows as any[];
  const issA = await issue('FRT-A', 10);
  ok('Future issue carries loaded cost: FRT-A avg 11 → issue 10 COGS 110', near(balA[0]?.avg_cost, 11) && near(issA.json?.value, 110) && near(issA.json?.unit_cost, 11), `avg=${balA[0]?.avg_cost} cogs=${issA.json?.value}`);

  // ── F. Variance path: already-issued residual is expensed to 5500, not retroactively re-costed ──
  await receive('FRT-C', 100, 10);       // value 1000, avg 10
  await issue('FRT-C', 60);              // on hand 40 (avg unchanged 10)
  const cCreate = await inj('POST', '/api/costing/landed-cost', prep1, { basis: 'qty', charges: { duty: 100 }, lines: [{ item_id: 'FRT-C', qty: 100 }] });
  const lcvC = cCreate.json?.voucher?.voucher_no as string;
  const cPost = await inj('POST', `/api/costing/landed-cost/${lcvC}/post`, appr1);
  const glC = await glOf('INV-LC', lcvC);
  const balC = (await pg.query(`SELECT avg_cost FROM inv_balances WHERE tenant_id=${t1} AND item_id='FRT-C'`)).rows as any[];
  ok('Variance: 40% on-hand → Dr1200=40 / Dr5500=60 / Cr2010=100; avg 40 on-hand → 11', cPost.status === 200 && near(leg(glC, '1200', 'debit'), 40) && near(leg(glC, '5500', 'debit'), 60) && near(leg(glC, '2010', 'credit'), 100) && near(balC[0]?.avg_cost, 11), JSON.stringify({ cap: cPost.json?.capitalized_total, var: cPost.json?.variance_total, avg: balC[0]?.avg_cost }));

  // ── G. FIFO layer path: landed cost bumps the open layer unit cost ──
  await receive('FRT-D', 50, 10, 'fifo');
  const dCreate = await inj('POST', '/api/costing/landed-cost', prep1, { basis: 'value', charges: { broker: 50 }, lines: [{ item_id: 'FRT-D', qty: 50 }] });
  const lcvD = dCreate.json?.voucher?.voucher_no as string;
  await inj('POST', `/api/costing/landed-cost/${lcvD}/post`, appr1);
  const layD = (await pg.query(`SELECT unit_cost FROM inv_cost_layers WHERE tenant_id=${t1} AND item_id='FRT-D' ORDER BY id`)).rows as any[];
  const issD = await issue('FRT-D', 10);
  ok('FIFO: landed cost raises open layer unit cost 10 → 11; issue carries it (COGS 110)', near(layD[0]?.unit_cost, 11) && near(issD.json?.value, 110), `layer=${layD[0]?.unit_cost} cogs=${issD.json?.value}`);

  // ── H. Sub-ledger still reconciles to GL 1200 after landed cost (INV-LC in the reconcile scope) ──
  const recon = await inj('GET', '/api/inventory/reconciliation', prep1);
  ok('Reconcile: sub-ledger ties to GL 1200 after landed-cost postings', recon.json?.reconciled === true, JSON.stringify({ sub: recon.json?.sub_ledger_value, gl: recon.json?.gl_inventory, diff: recon.json?.difference }));

  // ── I. RLS: T2 cannot see T1 vouchers ──
  const t2list = await inj('GET', '/api/costing/landed-cost', shop2);
  ok('RLS: T2 sees none of T1 landed-cost vouchers', (t2list.json?.vouchers ?? []).length === 0, `n=${(t2list.json?.vouchers ?? []).length}`);

  // ── J. Re-posting a posted voucher is rejected ──
  const rePost = await inj('POST', `/api/costing/landed-cost/${lcv}/post`, appr1);
  ok('Idempotency: re-posting a Posted voucher rejected (ALREADY_POSTED)', rePost.status === 400 && rePost.json?.error?.code === 'ALREADY_POSTED', `st=${rePost.status} code=${rePost.json?.error?.code}`);

  // ── K. Trial balance stays balanced ──
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('Trial balance balanced after all landed-cost activity', tb.totals?.balanced === true, JSON.stringify(tb.totals ?? {}));

  console.log('\n── INV-1 — Landed-cost allocation (COST-01) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} landed-cost checks failed` : `\n✅ All ${checks.length} landed-cost checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
